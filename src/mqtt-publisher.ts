import { connectAsync, type IClientOptions } from "mqtt";

import type { MqttConfig, ReadingRule, UsageReading } from "./types.js";

export type AsyncMqttClient = {
  publishAsync(
    topic: string,
    message: string,
    options: { qos: 1; retain: boolean },
  ): Promise<unknown>;
  endAsync(): Promise<void>;
};

export type MqttConnector = (
  url: string,
  options: IClientOptions,
) => Promise<AsyncMqttClient>;

const defaultConnector: MqttConnector = async (url, options) =>
  connectAsync(url, options);

export class MqttPublisher {
  private client: AsyncMqttClient | undefined;

  public constructor(
    private readonly config: MqttConfig,
    private readonly rules: readonly ReadingRule[],
    private readonly connector: MqttConnector = defaultConnector,
  ) {}

  public async connect(): Promise<void> {
    this.client = await this.connector(this.config.url, {
      clientId: this.config.clientId,
      clean: true,
      reconnectPeriod: 5_000,
      rejectUnauthorized: this.config.rejectUnauthorized,
      ...(this.config.username === undefined
        ? {}
        : { username: this.config.username }),
      ...(this.config.password === undefined
        ? {}
        : { password: this.config.password }),
      will: {
        topic: this.availabilityTopic,
        payload: "offline",
        qos: 1,
        retain: true,
      },
    });
  }

  public async publishDiscovery(): Promise<void> {
    for (const rule of this.rules) {
      const topic = `${this.config.discoveryPrefix}/sensor/${this.config.clientId}/${rule.id}/config`;
      const payload = {
        name: rule.name,
        unique_id: `${this.config.clientId}_${rule.id}`,
        object_id: `${this.config.clientId}_${rule.id}`,
        state_topic: this.stateTopic,
        value_template: `{{ value_json.metrics.${rule.id} }}`,
        availability_topic: this.availabilityTopic,
        payload_available: "online",
        payload_not_available: "offline",
        unit_of_measurement: rule.unit,
        ...(rule.deviceClass === undefined
          ? {}
          : { device_class: rule.deviceClass }),
        ...(rule.stateClass === undefined
          ? {}
          : { state_class: rule.stateClass }),
        ...(rule.icon === undefined ? {} : { icon: rule.icon }),
        device: {
          identifiers: [this.config.clientId],
          name: "Loudoun Water LW Connect",
          manufacturer: "Loudoun Water",
          model: "LW Connect",
        },
        origin: {
          name: "lwconnect-mqtt",
          sw_version: "0.1.0",
        },
      };
      await this.publish(topic, JSON.stringify(payload), true);
    }
  }

  public async publishReading(reading: UsageReading): Promise<void> {
    await this.publish(this.stateTopic, JSON.stringify(reading), true);
    await this.publishAvailability("online");
  }

  public async publishAvailability(
    status: "online" | "offline",
  ): Promise<void> {
    await this.publish(this.availabilityTopic, status, true);
  }

  public async close(): Promise<void> {
    if (this.client !== undefined) {
      await this.client.endAsync();
      this.client = undefined;
    }
  }

  private get stateTopic(): string {
    return `${this.config.topicPrefix}/state`;
  }

  private get availabilityTopic(): string {
    return `${this.config.topicPrefix}/availability`;
  }

  private async publish(
    topic: string,
    message: string,
    retain: boolean,
  ): Promise<void> {
    if (this.client === undefined) {
      throw new Error("MQTT publisher is not connected");
    }
    await this.client.publishAsync(topic, message, { qos: 1, retain });
  }
}
