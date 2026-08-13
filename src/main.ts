import { setTimeout as delay } from "node:timers/promises";

import { loadConfig } from "./config.js";
import { HomeAssistantStatistics } from "./home-assistant.js";
import { log } from "./logger.js";
import { MqttPublisher } from "./mqtt-publisher.js";
import { PortalClient } from "./portal.js";

type Command =
  | "run"
  | "once"
  | "calibrate"
  | "statistics:dry-run"
  | "statistics:apply"
  | "statistics:rollback";

const parseCommand = (): Command => {
  const command = process.argv[2] ?? "run";
  if (
    command === "run" ||
    command === "once" ||
    command === "calibrate" ||
    command === "statistics:dry-run" ||
    command === "statistics:apply" ||
    command === "statistics:rollback"
  ) {
    return command;
  }
  throw new Error(`Unknown command: ${command}`);
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const main = async (): Promise<void> => {
  const command = parseCommand();
  const config = await loadConfig();
  const portal = new PortalClient(config.portal);

  if (command === "calibrate") {
    const result = await portal.calibrate();
    log("info", "Calibration artifacts saved", {
      artifactDir: result.artifactDir,
      sourceUpdatedOn: result.sourceUpdatedOn,
      extractedMetrics: result.metrics,
      missingRuleIds: result.missingRuleIds,
      dailyUsage: result.dailyUsage,
      usageCost: result.usageCost,
    });
    return;
  }

  if (command === "statistics:rollback") {
    const result = await new HomeAssistantStatistics(
      config.homeAssistant,
    ).rollback();
    log("info", "Home Assistant daily usage statistic removed", result);
    return;
  }

  if (command === "statistics:dry-run" || command === "statistics:apply") {
    const reading = await portal.scrapeUsage();
    const mode = command === "statistics:apply" ? "apply" : "dry-run";
    const result = await new HomeAssistantStatistics(config.homeAssistant).sync(
      reading.dailyUsage,
      mode,
    );
    log("info", "Home Assistant daily usage statistics inspected", result);
    return;
  }

  const publisher = new MqttPublisher(
    config.mqtt,
    config.portal.rules.readings,
  );
  const shutdown = new AbortController();

  const stop = (): void => {
    shutdown.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await publisher.connect();
  await publisher.publishDiscovery();

  const poll = async (): Promise<void> => {
    const reading = await portal.scrapeUsage();
    await publisher.publishReading(reading);
    if (config.homeAssistant.importStatistics) {
      const statistics = await new HomeAssistantStatistics(
        config.homeAssistant,
      ).sync(reading.dailyUsage, "apply");
      log("info", "Home Assistant daily usage statistics synchronized", {
        ...statistics,
        auditPath: statistics.auditPath,
      });
    }
    log("info", "Water usage published", {
      observedAt: reading.observedAt,
      sourceUpdatedOn: reading.sourceUpdatedOn,
      metrics: reading.metrics,
      dailyUsage: reading.dailyUsage,
      usageCost: reading.usageCost,
    });
  };

  try {
    if (command === "once") {
      try {
        await poll();
      } catch (error: unknown) {
        await publisher.publishAvailability("offline");
        throw error;
      }
      return;
    }

    while (!shutdown.signal.aborted) {
      try {
        await poll();
      } catch (error: unknown) {
        await publisher.publishAvailability("offline");
        log("error", "Polling attempt failed", {
          error: errorMessage(error),
        });
      }
      await delay(config.pollIntervalMs, undefined, {
        signal: shutdown.signal,
      }).catch((error: unknown) => {
        if (!shutdown.signal.aborted) {
          throw error;
        }
      });
    }
  } finally {
    if (command === "run") {
      await publisher.publishAvailability("offline").catch(() => undefined);
    }
    await publisher.close();
  }
};

await main().catch((error: unknown) => {
  log("error", "Fatal error", { error: errorMessage(error) });
  process.exitCode = 1;
});
