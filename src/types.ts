export type ReadingRule = {
  id: string;
  name: string;
  selector: string;
  patterns: string[];
  valueGroup: number;
  unit: string;
  deviceClass?: string;
  stateClass?: "measurement" | "total" | "total_increasing";
  icon?: string;
};

export type RulesConfig = {
  usageNavigationLabels: string[];
  usageNavigationSelector?: string;
  readings: ReadingRule[];
};

export type PortalConfig = {
  username: string;
  password: string;
  loginUrl: string;
  headless: boolean;
  timeoutMs: number;
  rules: RulesConfig;
  artifactDir: string;
  saveDiagnostics: boolean;
};

export type MqttConfig = {
  url: string;
  username?: string;
  password?: string;
  clientId: string;
  topicPrefix: string;
  discoveryPrefix: string;
  rejectUnauthorized: boolean;
};

export type HomeAssistantConfig = {
  url?: string;
  token?: string;
  importStatistics: boolean;
  statisticId: string;
  timeZone: string;
};

export type AppConfig = {
  portal: PortalConfig;
  mqtt: MqttConfig;
  homeAssistant: HomeAssistantConfig;
  pollIntervalMs: number;
};

export type UsageReading = {
  observedAt: string;
  sourceUpdatedOn: string;
  metrics: Readonly<Record<string, number>>;
  dailyUsage: readonly DailyUsage[];
  usageCost: UsageCost;
};

export type DailyUsage = {
  date: string;
  gallons: number;
};

export type TariffTier = {
  tier: number;
  startsAtGallons: number;
  endsAtGallons?: number;
  pricePerThousandGallons: number;
  pricePerGallon: number;
};

export type UsageCost = {
  amount: number;
  currency: "USD";
  currentTier: number;
  currentPricePerGallon: number;
  tiers: readonly TariffTier[];
};

export type CalibrationResult = {
  artifactDir: string;
  sourceUpdatedOn: string;
  metrics: Readonly<Record<string, number>>;
  missingRuleIds: string[];
  dailyUsage: readonly DailyUsage[];
  usageCost: UsageCost;
};
