import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { buildDailyUsage } from "./daily-usage.js";
import { extractFromText } from "./extract.js";
import { extractUsageCost } from "./tariff.js";
import type { CalibrationResult, PortalConfig, UsageReading } from "./types.js";

const usernameSelector = 'input[placeholder="User ID or Email Address"]';
const visibleUsernameSelector = `${usernameSelector}:visible`;
const visiblePasswordSelector = 'input[placeholder="Password"]:visible';

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const extractSourceUpdatedOn = (text: string): string => {
  const match = /Last Update:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(text);
  const [, rawMonth, rawDay, rawYear] = match ?? [];
  if (rawMonth === undefined || rawDay === undefined || rawYear === undefined) {
    throw new Error("Could not find the LW Connect Last Update date");
  }

  const month = Number(rawMonth);
  const day = Number(rawDay);
  const year = Number(rawYear);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(
      `LW Connect returned an invalid Last Update date: ${rawMonth}/${rawDay}/${rawYear}`,
    );
  }

  return `${rawYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

export class PortalClient {
  public constructor(private readonly config: PortalConfig) {}

  public async scrapeUsage(): Promise<UsageReading> {
    return this.withUsagePage(async (page) => {
      const extracted = await this.extract(page);
      const sourceUpdatedOn = await this.extractSourceUpdatedOn(page);
      const usageCost = await this.extractUsageCost(page);
      const dailyUsage = await this.extractDailyUsage(page);
      if (Object.keys(extracted.metrics).length === 0) {
        if (this.config.saveDiagnostics) {
          await this.saveArtifacts(page);
        }
        throw new Error(
          "No configured usage readings matched the LW Connect page. Run the calibrate command and update config/readings.json.",
        );
      }

      return {
        observedAt: new Date().toISOString(),
        sourceUpdatedOn,
        metrics: extracted.metrics,
        dailyUsage,
        usageCost,
      };
    });
  }

  public async calibrate(): Promise<CalibrationResult> {
    return this.withUsagePage(async (page) => {
      const extracted = await this.extract(page);
      const sourceUpdatedOn = await this.extractSourceUpdatedOn(page);
      const usageCost = await this.extractUsageCost(page);
      const dailyUsage = await this.extractDailyUsage(page);
      await this.saveArtifacts(page);
      return {
        artifactDir: this.config.artifactDir,
        sourceUpdatedOn,
        dailyUsage,
        usageCost,
        ...extracted,
      };
    });
  }

  private async withUsagePage<T>(
    operation: (page: Page) => Promise<T>,
  ): Promise<T> {
    const browser = await chromium.launch({ headless: this.config.headless });
    let page: Page | undefined;
    try {
      page = await this.createPage(browser);
      await this.login(page);
      await this.openUsagePage(page);
      return await operation(page);
    } catch (error: unknown) {
      if (this.config.saveDiagnostics && page !== undefined) {
        await this.saveArtifacts(page).catch(() => undefined);
      }
      throw this.contextualizeError(error);
    } finally {
      await browser.close();
    }
  }

  private async createPage(browser: Browser): Promise<Page> {
    const context = await browser.newContext({
      locale: "en-US",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(this.config.timeoutMs);
    return page;
  }

  private async login(page: Page): Promise<void> {
    await page.goto(this.config.loginUrl, { waitUntil: "domcontentloaded" });
    const username = page.locator(visibleUsernameSelector).first();
    const password = page.locator(visiblePasswordSelector).first();
    await username.waitFor({ state: "visible" });
    await username.fill(this.config.username);
    await password.fill(this.config.password);

    const loginButton = page
      .locator("button:visible")
      .filter({ hasText: /^\s*LOGIN\s*$/i })
      .first();
    await loginButton.click();

    await username.waitFor({ state: "hidden", timeout: this.config.timeoutMs });
    await page.waitForFunction((selector) => {
      const loginIsVisible = [...document.querySelectorAll(selector)].some(
        (element) =>
          element instanceof HTMLElement && element.getClientRects().length > 0,
      );
      return !loginIsVisible && document.body.innerText.trim().length > 0;
    }, usernameSelector);
  }

  private async openUsagePage(page: Page): Promise<void> {
    if (await this.isUsageDashboardVisible(page)) {
      return;
    }

    const configuredSelector = this.config.rules.usageNavigationSelector;
    if (configuredSelector !== undefined) {
      const navigation = page.locator(configuredSelector).first();
      await navigation.waitFor({ state: "visible" });
      await this.clickUsageNavigation(page, navigation);
      await page.waitForTimeout(1_000);
      return;
    }

    for (const [
      index,
      label,
    ] of this.config.rules.usageNavigationLabels.entries()) {
      const exactLabel = new RegExp(`^\\s*${escapeRegExp(label)}\\s*$`, "i");
      const navigation = page
        .locator("button:visible, a:visible")
        .filter({ hasText: exactLabel })
        .first();
      if (index === 0) {
        const preferredNavigationAppeared = await navigation
          .waitFor({
            state: "visible",
            timeout: Math.min(this.config.timeoutMs, 5_000),
          })
          .then(() => true)
          .catch(() => false);
        if (!preferredNavigationAppeared) {
          continue;
        }
      } else if ((await navigation.count()) === 0) {
        continue;
      }

      if (await navigation.isVisible()) {
        if (await this.isUsageDashboardVisible(page)) {
          return;
        }
        await this.clickUsageNavigation(page, navigation);
        await page.waitForTimeout(1_000);
        return;
      }
    }

    if (this.config.saveDiagnostics) {
      await this.saveArtifacts(page);
    }
    throw new Error(
      `Could not find LW Connect usage navigation. Tried: ${this.config.rules.usageNavigationLabels.join(", ")}`,
    );
  }

  private usageDashboard(page: Page) {
    return page
      .locator('[role="dialog"]:visible')
      .filter({ hasText: /Tier\s+1\s*-\s*\$/i })
      .first();
  }

  private async isUsageDashboardVisible(page: Page): Promise<boolean> {
    return this.usageDashboard(page)
      .isVisible()
      .catch(() => false);
  }

  private async clickUsageNavigation(
    page: Page,
    navigation: ReturnType<Page["locator"]>,
  ): Promise<void> {
    try {
      await navigation.click({
        timeout: Math.min(this.config.timeoutMs, 5_000),
      });
    } catch (error: unknown) {
      const dashboardAppeared = await this.usageDashboard(page)
        .waitFor({ state: "visible", timeout: 2_000 })
        .then(() => true)
        .catch(() => false);
      if (!dashboardAppeared) {
        throw error;
      }
    }
  }

  private async extract(page: Page) {
    const selectors = new Set(
      this.config.rules.readings.map((rule) => rule.selector),
    );
    const textBySelector = new Map<string, string>();

    for (const selector of selectors) {
      const scope = page.locator(selector).first();
      if ((await scope.count()) > 0) {
        textBySelector.set(selector, await scope.innerText());
      }
    }

    return extractFromText(textBySelector, this.config.rules.readings);
  }

  private async extractSourceUpdatedOn(page: Page): Promise<string> {
    return extractSourceUpdatedOn(await page.locator("body").innerText());
  }

  private async extractUsageCost(page: Page) {
    const dashboard = this.usageDashboard(page);
    await dashboard.waitFor({ state: "visible" });
    const currentUsageText =
      (await dashboard.locator(".gauge #Value").textContent()) ?? "";
    const currentUsage = Number(currentUsageText.replaceAll(",", "").trim());
    const thresholdLabels = await dashboard
      .locator(".gauge .label text")
      .allTextContents();
    return extractUsageCost(
      await dashboard.innerText(),
      thresholdLabels,
      currentUsage,
    );
  }

  private async extractDailyUsage(page: Page) {
    const dashboard = this.usageDashboard(page);
    await dashboard
      .locator("button:visible")
      .filter({ hasText: /^\s*Close\s*$/i })
      .click();

    const historyTab = page
      .locator('a[role="tab"]:visible')
      .filter({ hasText: /^\s*Consumption History\s*$/i })
      .first();
    await historyTab.waitFor({ state: "visible" });
    await historyTab.click();

    const viewSelect = page.locator("select:visible").filter({
      has: page.locator('option[value="Daily"]'),
    });
    await viewSelect.waitFor({ state: "visible" });
    await viewSelect.selectOption("Daily");
    await page.waitForFunction(() =>
      /Showing\s+Daily\s+breakdown/i.test(document.body.innerText),
    );
    await page.waitForTimeout(3_000);

    const chart = await page.evaluate(() => {
      type ChartDataset = { data?: unknown[] };
      type ChartInstance = {
        canvas?: HTMLCanvasElement;
        data?: { labels?: unknown[]; datasets?: ChartDataset[] };
      };
      const chartGlobal = (
        globalThis as typeof globalThis & {
          Chart?: { instances?: Record<string, ChartInstance> };
        }
      ).Chart;
      const instances = Object.values(chartGlobal?.instances ?? {});
      const instance = instances
        .filter(
          ({ canvas, data }) =>
            canvas instanceof HTMLCanvasElement &&
            canvas.getClientRects().length > 0 &&
            (data?.labels?.length ?? 0) > 0 &&
            (data?.datasets?.[0]?.data?.length ?? 0) > 0,
        )
        .sort(
          (left, right) =>
            (right.data?.labels?.length ?? 0) -
            (left.data?.labels?.length ?? 0),
        )[0];
      return {
        labels: (instance?.data?.labels ?? []).map(String),
        values: (instance?.data?.datasets?.[0]?.data ?? []).map((value) =>
          typeof value === "number"
            ? value
            : typeof value === "string" && value.trim() !== ""
              ? Number(value)
              : null,
        ),
      };
    });

    return buildDailyUsage(chart.labels, chart.values, new Date());
  }

  private async saveArtifacts(page: Page): Promise<void> {
    await mkdir(this.config.artifactDir, { recursive: true });
    const screenshotPath = join(this.config.artifactDir, "usage-page.png");
    await Promise.all([
      writeFile(
        join(this.config.artifactDir, "usage-page.txt"),
        await page.locator("body").innerText(),
        { mode: 0o600 },
      ),
      writeFile(
        join(this.config.artifactDir, "usage-page.html"),
        await page.content(),
        { mode: 0o600 },
      ),
      page.screenshot({
        path: screenshotPath,
        fullPage: true,
      }),
    ]);
    await chmod(screenshotPath, 0o600);
  }

  private contextualizeError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`LW Connect scrape failed: ${message}`, { cause: error });
  }
}
