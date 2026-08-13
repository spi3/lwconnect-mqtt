import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { config as loadDotenv } from "dotenv";
import { z } from "zod";

import type { AppConfig, RulesConfig } from "./types.js";

loadDotenv({ quiet: true });

const booleanValue = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const environmentSchema = z.object({
  LWCONNECT_USERNAME: z.string().min(1),
  LWCONNECT_PASSWORD: z.string().min(1),
  LWCONNECT_LOGIN_URL: z.url().default("https://www.lwconnect.org/login.html"),
  LWCONNECT_HEADLESS: booleanValue.default(true),
  LWCONNECT_TIMEOUT_MS: z.coerce.number().int().min(5_000).default(30_000),
  LWCONNECT_POLL_INTERVAL_MINUTES: z.coerce.number().min(5).default(60),
  LWCONNECT_RULES_PATH: z.string().default("./config/readings.json"),
  LWCONNECT_ARTIFACT_DIR: z.string().default("./artifacts"),
  LWCONNECT_SAVE_DIAGNOSTICS: booleanValue.default(false),
  MQTT_URL: z.url().default("mqtt://localhost:1883"),
  MQTT_USERNAME: z.string().optional(),
  MQTT_PASSWORD: z.string().optional(),
  MQTT_CLIENT_ID: z.string().min(1).default("lwconnect-mqtt"),
  MQTT_TOPIC_PREFIX: z.string().min(1).default("home/water/lwconnect"),
  MQTT_DISCOVERY_PREFIX: z.string().min(1).default("homeassistant"),
  MQTT_REJECT_UNAUTHORIZED: booleanValue.default(true),
});

const readingRuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().min(1),
  selector: z.string().min(1).default("body"),
  patterns: z.array(z.string().min(1)).min(1),
  valueGroup: z.number().int().min(1).default(1),
  unit: z.string().min(1),
  deviceClass: z.string().min(1).optional(),
  stateClass: z.enum(["measurement", "total", "total_increasing"]).optional(),
  icon: z.string().min(1).optional(),
});

const rulesSchema = z.object({
  usageNavigationLabels: z.array(z.string().min(1)).min(1),
  usageNavigationSelector: z.string().min(1).optional(),
  readings: z.array(readingRuleSchema).min(1),
});

const trimTrailingSlashes = (value: string): string =>
  value.replace(/\/+$/, "");

export const loadConfig = async (): Promise<AppConfig> => {
  const environment = environmentSchema.parse(process.env);
  const rulesPath = resolve(environment.LWCONNECT_RULES_PATH);
  const rules = rulesSchema.parse(
    JSON.parse(await readFile(rulesPath, "utf8")) as unknown,
  ) as RulesConfig;

  return {
    portal: {
      username: environment.LWCONNECT_USERNAME,
      password: environment.LWCONNECT_PASSWORD,
      loginUrl: environment.LWCONNECT_LOGIN_URL,
      headless: environment.LWCONNECT_HEADLESS,
      timeoutMs: environment.LWCONNECT_TIMEOUT_MS,
      rules,
      artifactDir: resolve(environment.LWCONNECT_ARTIFACT_DIR),
      saveDiagnostics: environment.LWCONNECT_SAVE_DIAGNOSTICS,
    },
    mqtt: {
      url: environment.MQTT_URL,
      ...(environment.MQTT_USERNAME === undefined
        ? {}
        : { username: environment.MQTT_USERNAME }),
      ...(environment.MQTT_PASSWORD === undefined
        ? {}
        : { password: environment.MQTT_PASSWORD }),
      clientId: environment.MQTT_CLIENT_ID,
      topicPrefix: trimTrailingSlashes(environment.MQTT_TOPIC_PREFIX),
      discoveryPrefix: trimTrailingSlashes(environment.MQTT_DISCOVERY_PREFIX),
      rejectUnauthorized: environment.MQTT_REJECT_UNAUTHORIZED,
    },
    pollIntervalMs: environment.LWCONNECT_POLL_INTERVAL_MINUTES * 60_000,
  };
};
