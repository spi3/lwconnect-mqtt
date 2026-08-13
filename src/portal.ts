import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import { extractFromText } from "./extract.js";
import type { CalibrationResult, PortalConfig, UsageReading } from "./types.js";

const visibleUsernameSelector =
  'input[placeholder="User ID or Email Address"]:visible';
const visiblePasswordSelector = 'input[placeholder="Password"]:visible';

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class PortalClient {
  public constructor(private readonly config: PortalConfig) {}

  public async scrapeUsage(): Promise<UsageReading> {
    return this.withUsagePage(async (page) => {
      const extracted = await this.extract(page);
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
        metrics: extracted.metrics,
      };
    });
  }

  public async calibrate(): Promise<CalibrationResult> {
    return this.withUsagePage(async (page) => {
      const extracted = await this.extract(page);
      await this.saveArtifacts(page);
      return {
        artifactDir: this.config.artifactDir,
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
  }

  private async openUsagePage(page: Page): Promise<void> {
    const configuredSelector = this.config.rules.usageNavigationSelector;
    if (configuredSelector !== undefined) {
      const navigation = page.locator(configuredSelector).first();
      await navigation.waitFor({ state: "visible" });
      await navigation.click();
      await page.waitForTimeout(1_000);
      return;
    }

    for (const label of this.config.rules.usageNavigationLabels) {
      const exactLabel = new RegExp(`^\\s*${escapeRegExp(label)}\\s*$`, "i");
      const navigation = page
        .locator("button:visible, a:visible")
        .filter({ hasText: exactLabel })
        .first();
      if ((await navigation.count()) > 0) {
        await navigation.click();
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
