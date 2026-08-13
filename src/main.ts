import { setTimeout as delay } from "node:timers/promises";

import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { MqttPublisher } from "./mqtt-publisher.js";
import { PortalClient } from "./portal.js";

type Command = "run" | "once" | "calibrate";

const parseCommand = (): Command => {
  const command = process.argv[2] ?? "run";
  if (command === "run" || command === "once" || command === "calibrate") {
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
      extractedMetrics: result.metrics,
      missingRuleIds: result.missingRuleIds,
    });
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
    log("info", "Water usage published", {
      observedAt: reading.observedAt,
      metrics: reading.metrics,
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
    await publisher.publishAvailability("offline").catch(() => undefined);
    await publisher.close();
  }
};

await main().catch((error: unknown) => {
  log("error", "Fatal error", { error: errorMessage(error) });
  process.exitCode = 1;
});
