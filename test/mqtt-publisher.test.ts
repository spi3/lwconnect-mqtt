import { describe, expect, it } from "vitest";

import {
  MqttPublisher,
  type AsyncMqttClient,
  type MqttConnector,
} from "../src/mqtt-publisher.js";
import type { MqttConfig, ReadingRule } from "../src/types.js";

describe("MqttPublisher", () => {
  it("publishes Home Assistant discovery, state, and availability", async () => {
    const publications: { topic: string; message: string }[] = [];
    const client: AsyncMqttClient = {
      publishAsync: (topic, message) => {
        publications.push({ topic, message });
        return Promise.resolve();
      },
      endAsync: () => Promise.resolve(),
    };
    const connector: MqttConnector = () => Promise.resolve(client);
    const config: MqttConfig = {
      url: "mqtt://broker.test:1883",
      clientId: "lwconnect-mqtt",
      topicPrefix: "home/water/lwconnect",
      discoveryPrefix: "homeassistant",
      rejectUnauthorized: true,
    };
    const rules: ReadingRule[] = [
      {
        id: "current_billing_cycle",
        name: "Current Billing Cycle Water Usage",
        selector: "body",
        patterns: ["unused"],
        valueGroup: 1,
        unit: "gal",
        deviceClass: "water",
        stateClass: "total_increasing",
      },
    ];
    const publisher = new MqttPublisher(config, rules, connector);

    await publisher.connect();
    await publisher.publishDiscovery();
    await publisher.publishReading({
      observedAt: "2026-08-13T00:00:00.000Z",
      metrics: { current_billing_cycle: 123 },
    });
    await publisher.close();

    expect(publications.map(({ topic }) => topic)).toEqual([
      "homeassistant/sensor/lwconnect-mqtt/current_billing_cycle/config",
      "home/water/lwconnect/state",
      "home/water/lwconnect/availability",
    ]);
    expect(JSON.parse(publications[0]?.message ?? "{}")).toMatchObject({
      unique_id: "lwconnect-mqtt_current_billing_cycle",
      state_topic: "home/water/lwconnect/state",
      value_template: "{{ value_json.metrics.current_billing_cycle }}",
      device_class: "water",
      state_class: "total_increasing",
    });
  });
});
