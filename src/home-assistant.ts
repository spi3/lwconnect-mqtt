import { writeFile } from "node:fs/promises";

import type { DailyUsage, HomeAssistantConfig } from "./types.js";

const comparisonTolerance = 1e-6;
const statisticsEpoch = "2000-01-01T00:00:00.000Z";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type HomeAssistantMessage = {
  id?: number;
  type?: string;
  success?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
};

type StatisticsMetadata = {
  statistic_id?: string;
  source?: string;
  unit_of_measurement?: string;
  statistics_unit_of_measurement?: string;
  unit_class?: string;
  has_sum?: boolean;
  mean_type?: number;
};

export type ExistingStatistic = {
  start: number;
  state: number;
  sum: number;
};

export type ImportedStatistic = {
  start: string;
  state: number;
  sum: number;
};

export type StatisticsPlan = {
  points: readonly ImportedStatistic[];
  changedPoints: number;
  existingPoints: number;
  previousSum: number;
};

export type StatisticsSummary = {
  mode: "dry-run" | "apply";
  statisticId: string;
  dataStarts: string;
  dataEnds: string;
  dailyPoints: number;
  gallons: number;
  previousSum: number;
  endingSum: number;
  changedPoints: number;
  existingMetadata: boolean;
  energyDashboardConfigured: boolean;
  auditPath?: string;
};

type EnergyWaterConsumption = {
  stat_consumption: string;
  name?: string;
};

type EnergyPreferences = {
  device_consumption_water: EnergyWaterConsumption[];
};

const dateParts = (date: Date, timeZone: string) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)]),
  );

export const localDateStart = (dateKey: string, timeZone: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  const [, rawYear, rawMonth, rawDay] = match ?? [];
  if (rawYear === undefined || rawMonth === undefined || rawDay === undefined) {
    throw new Error(`Invalid daily usage date: ${dateKey}`);
  }
  const desired = {
    year: Number(rawYear),
    month: Number(rawMonth),
    day: Number(rawDay),
    hour: 0,
    minute: 0,
    second: 0,
  };
  const desiredAsUtc = Date.UTC(desired.year, desired.month - 1, desired.day);
  let instant = new Date(desiredAsUtc);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = dateParts(instant, timeZone);
    const actualAsUtc = Date.UTC(
      actual.year ?? 0,
      (actual.month ?? 1) - 1,
      actual.day ?? 1,
      actual.hour ?? 0,
      actual.minute ?? 0,
      actual.second ?? 0,
    );
    instant = new Date(instant.getTime() + desiredAsUtc - actualAsUtc);
  }
  const resolved = dateParts(instant, timeZone);
  if (
    resolved.year !== desired.year ||
    resolved.month !== desired.month ||
    resolved.day !== desired.day ||
    resolved.hour !== 0 ||
    resolved.minute !== 0 ||
    resolved.second !== 0
  ) {
    throw new Error(`Could not resolve ${dateKey} midnight in ${timeZone}`);
  }
  return instant.toISOString();
};

const nearlyEqual = (left: number, right: number): boolean =>
  Math.abs(left - right) <= comparisonTolerance;

export const buildStatisticsPlan = (
  dailyUsage: readonly DailyUsage[],
  existing: readonly ExistingStatistic[],
  timeZone: string,
): StatisticsPlan => {
  if (dailyUsage.length === 0) {
    throw new Error("No daily usage is available to import");
  }
  const starts = dailyUsage.map(({ date }) => localDateStart(date, timeZone));
  const firstStart = Date.parse(starts[0] ?? "");
  const existingByStart = new Map(
    existing.map((point) => [point.start, point]),
  );
  const previous = existing
    .filter(({ start }) => start < firstStart)
    .sort((left, right) => left.start - right.start)
    .at(-1);
  const previousSum = previous?.sum ?? 0;
  let sum = previousSum;
  let changedPoints = 0;
  const points = dailyUsage.map(({ gallons }, index) => {
    const start = starts[index];
    if (start === undefined || !Number.isFinite(gallons) || gallons < 0) {
      throw new Error("Daily usage contains an invalid value");
    }
    sum = Number((sum + gallons).toFixed(6));
    const point = { start, state: gallons, sum };
    const current = existingByStart.get(Date.parse(start));
    if (
      current === undefined ||
      !nearlyEqual(current.state, point.state) ||
      !nearlyEqual(current.sum, point.sum)
    ) {
      changedPoints += 1;
    }
    return point;
  });
  return {
    points,
    changedPoints,
    existingPoints: existing.length,
    previousSum,
  };
};

class HomeAssistantSocket {
  private socket: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  public constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  public async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.websocketUrl);
      this.socket = socket;
      const timeout = setTimeout(() => {
        reject(new Error("Home Assistant connection timed out"));
      }, 15_000);
      socket.onmessage = ({ data }) => {
        const message = JSON.parse(String(data)) as HomeAssistantMessage;
        if (message.type === "auth_required") {
          socket.send(
            JSON.stringify({ type: "auth", access_token: this.token }),
          );
          return;
        }
        if (message.type === "auth_ok") {
          clearTimeout(timeout);
          resolve();
          return;
        }
        if (message.type === "auth_invalid") {
          clearTimeout(timeout);
          reject(new Error("Home Assistant rejected the access token"));
          return;
        }
        if (message.type !== "result" || message.id === undefined) {
          return;
        }
        const request = this.pending.get(message.id);
        if (request === undefined) {
          return;
        }
        clearTimeout(request.timeout);
        this.pending.delete(message.id);
        if (message.success === true) {
          request.resolve(message.result);
        } else {
          request.reject(
            new Error(
              `${message.error?.code ?? "unknown_error"}: ${message.error?.message ?? "Home Assistant request failed"}`,
            ),
          );
        }
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("Home Assistant WebSocket connection failed"));
      };
    });
  }

  public request(command: Readonly<Record<string, unknown>>): Promise<unknown> {
    const socket = this.socket;
    if (socket === undefined) {
      return Promise.reject(new Error("Home Assistant is not connected"));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId;
      this.nextId += 1;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Home Assistant request timed out: ${String(command.type)}`,
          ),
        );
      }, 30_000);
      this.pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id, ...command }));
    });
  }

  public close(): void {
    this.socket?.close();
  }

  private get websocketUrl(): string {
    const url = new URL(this.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/websocket`;
    return url.toString();
  }
}

const requireCredentials = (
  config: HomeAssistantConfig,
): { url: string; token: string } => {
  if (config.url === undefined || config.token === undefined) {
    throw new Error(
      "HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN are required for statistics commands",
    );
  }
  return { url: config.url, token: config.token };
};

const isExistingStatistic = (value: unknown): value is ExistingStatistic => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const point = value as Record<string, unknown>;
  return (
    typeof point.start === "number" &&
    typeof point.state === "number" &&
    typeof point.sum === "number"
  );
};

const writeAuditArtifact = async (
  label: string,
  value: unknown,
): Promise<string> => {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const path = `/tmp/lwconnect-${label}-${timestamp}.json`;
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return path;
};

export class HomeAssistantStatistics {
  private readonly client: HomeAssistantSocket;

  public constructor(private readonly config: HomeAssistantConfig) {
    const { url, token } = requireCredentials(config);
    this.client = new HomeAssistantSocket(url, token);
  }

  public async sync(
    dailyUsage: readonly DailyUsage[],
    mode: "dry-run" | "apply",
  ): Promise<StatisticsSummary> {
    await this.client.connect();
    try {
      const metadata = await this.getMetadata();
      this.validateMetadata(metadata);
      const existing = await this.getStatistics(
        statisticsEpoch,
        this.queryEnd(dailyUsage),
      );
      const energyPreferences = await this.getEnergyPreferences();
      const energyDashboardConfigured =
        this.isEnergyDashboardConfigured(energyPreferences);
      const plan = buildStatisticsPlan(
        dailyUsage,
        existing,
        this.config.timeZone,
      );
      const summary = this.summarize(
        mode,
        plan,
        metadata !== undefined,
        energyDashboardConfigured,
      );
      if (mode === "dry-run") {
        return summary;
      }
      const auditPath = await writeAuditArtifact("pre-import", {
        summary,
        existingMetadata: metadata,
        existingStatistics: existing,
        energyPreferences,
        plannedStatistics: plan.points,
      });
      if (plan.changedPoints > 0) {
        await this.client.request({
          type: "recorder/import_statistics",
          metadata: this.importMetadata,
          stats: plan.points,
        });
      }
      if (!energyDashboardConfigured) {
        await this.client.request({
          type: "energy/save_prefs",
          device_consumption_water: [
            ...energyPreferences.device_consumption_water,
            {
              stat_consumption: this.config.statisticId,
              name: "Loudoun Water",
            },
          ],
        });
      }
      await this.verify(plan.points);
      if (
        !this.isEnergyDashboardConfigured(await this.getEnergyPreferences())
      ) {
        throw new Error(
          "Home Assistant did not add the statistic to the Energy Dashboard",
        );
      }
      return {
        ...summary,
        energyDashboardConfigured: true,
        auditPath,
      };
    } finally {
      this.client.close();
    }
  }

  public async rollback(): Promise<{ statisticId: string; auditPath: string }> {
    await this.client.connect();
    try {
      const metadata = await this.getMetadata();
      const existing = await this.getStatistics(
        statisticsEpoch,
        new Date(Date.now() + 86_400_000).toISOString(),
      );
      const energyPreferences = await this.getEnergyPreferences();
      const auditPath = await writeAuditArtifact("pre-rollback", {
        metadata,
        statistics: existing,
        energyPreferences,
      });
      const remainingWaterConsumption =
        energyPreferences.device_consumption_water.filter(
          ({ stat_consumption }) =>
            stat_consumption !== this.config.statisticId,
        );
      if (
        remainingWaterConsumption.length !==
        energyPreferences.device_consumption_water.length
      ) {
        await this.client.request({
          type: "energy/save_prefs",
          device_consumption_water: remainingWaterConsumption,
        });
      }
      await this.client.request({
        type: "recorder/clear_statistics",
        statistic_ids: [this.config.statisticId],
      });
      if ((await this.getMetadata()) !== undefined) {
        throw new Error("Home Assistant did not clear the statistic metadata");
      }
      if (this.isEnergyDashboardConfigured(await this.getEnergyPreferences())) {
        throw new Error(
          "Home Assistant did not remove the statistic from the Energy Dashboard",
        );
      }
      return { statisticId: this.config.statisticId, auditPath };
    } finally {
      this.client.close();
    }
  }

  private get importMetadata() {
    return {
      mean_type: 0,
      has_sum: true,
      name: "Loudoun Water Daily Usage",
      source: this.config.statisticId.split(":", 1)[0],
      statistic_id: this.config.statisticId,
      unit_class: "volume",
      unit_of_measurement: "gal",
    };
  }

  private async getMetadata(): Promise<StatisticsMetadata | undefined> {
    const result = await this.client.request({
      type: "recorder/get_statistics_metadata",
      statistic_ids: [this.config.statisticId],
    });
    if (!Array.isArray(result)) {
      throw new Error("Home Assistant returned invalid statistics metadata");
    }
    return result[0] as StatisticsMetadata | undefined;
  }

  private async getStatistics(
    startTime: string,
    endTime: string,
  ): Promise<ExistingStatistic[]> {
    const result = await this.client.request({
      type: "recorder/statistics_during_period",
      start_time: startTime,
      end_time: endTime,
      statistic_ids: [this.config.statisticId],
      period: "hour",
    });
    if (typeof result !== "object" || result === null) {
      throw new Error("Home Assistant returned invalid statistics data");
    }
    const points = (result as Record<string, unknown>)[this.config.statisticId];
    if (!Array.isArray(points)) {
      return [];
    }
    if (!points.every(isExistingStatistic)) {
      throw new Error("Home Assistant returned malformed statistics points");
    }
    return points.sort((left, right) => left.start - right.start);
  }

  private async getEnergyPreferences(): Promise<EnergyPreferences> {
    const result = await this.client.request({ type: "energy/get_prefs" });
    if (typeof result !== "object" || result === null) {
      throw new Error("Home Assistant returned invalid Energy preferences");
    }
    const deviceConsumptionWater = (result as Record<string, unknown>)
      .device_consumption_water;
    if (!Array.isArray(deviceConsumptionWater)) {
      throw new Error(
        "Home Assistant Energy preferences do not support water consumption",
      );
    }
    const valid = deviceConsumptionWater.every(
      (value): value is EnergyWaterConsumption =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as Record<string, unknown>).stat_consumption === "string",
    );
    if (!valid) {
      throw new Error(
        "Home Assistant returned malformed water-consumption preferences",
      );
    }
    return { device_consumption_water: deviceConsumptionWater };
  }

  private isEnergyDashboardConfigured(preferences: EnergyPreferences): boolean {
    return preferences.device_consumption_water.some(
      ({ stat_consumption }) => stat_consumption === this.config.statisticId,
    );
  }

  private validateMetadata(metadata: StatisticsMetadata | undefined): void {
    if (metadata === undefined) {
      return;
    }
    const expected = this.importMetadata;
    if (
      metadata.statistic_id !== expected.statistic_id ||
      metadata.source !== expected.source ||
      (metadata.unit_of_measurement ??
        metadata.statistics_unit_of_measurement) !==
        expected.unit_of_measurement ||
      metadata.unit_class !== expected.unit_class ||
      metadata.has_sum !== true ||
      metadata.mean_type !== 0
    ) {
      throw new Error(
        `Existing Home Assistant statistic ${this.config.statisticId} has incompatible metadata`,
      );
    }
  }

  private queryEnd(dailyUsage: readonly DailyUsage[]): string {
    const lastDate = dailyUsage.at(-1)?.date;
    if (lastDate === undefined) {
      throw new Error("No daily usage is available to import");
    }
    return new Date(
      Date.parse(localDateStart(lastDate, this.config.timeZone)) + 86_400_000,
    ).toISOString();
  }

  private summarize(
    mode: "dry-run" | "apply",
    plan: StatisticsPlan,
    existingMetadata: boolean,
    energyDashboardConfigured: boolean,
  ): StatisticsSummary {
    const first = plan.points[0];
    const last = plan.points.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error("No daily usage is available to import");
    }
    return {
      mode,
      statisticId: this.config.statisticId,
      dataStarts: first.start,
      dataEnds: last.start,
      dailyPoints: plan.points.length,
      gallons: Number((last.sum - plan.previousSum).toFixed(6)),
      previousSum: plan.previousSum,
      endingSum: last.sum,
      changedPoints: plan.changedPoints,
      existingMetadata,
      energyDashboardConfigured,
    };
  }

  private async verify(expected: readonly ImportedStatistic[]): Promise<void> {
    const first = expected[0];
    const last = expected.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error("No imported statistics are available to verify");
    }
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const actual = await this.getStatistics(
        first.start,
        new Date(Date.parse(last.start) + 86_400_000).toISOString(),
      );
      const actualByStart = new Map(
        actual.map((point) => [point.start, point]),
      );
      const mismatch = expected.find((point) => {
        const current = actualByStart.get(Date.parse(point.start));
        return (
          current === undefined ||
          !nearlyEqual(current.state, point.state) ||
          !nearlyEqual(current.sum, point.sum)
        );
      });
      if (mismatch === undefined) {
        return;
      }
      lastError = new Error(
        `Home Assistant did not commit the statistic for ${mismatch.start}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw (
      lastError ?? new Error("Home Assistant statistics verification failed")
    );
  }
}
