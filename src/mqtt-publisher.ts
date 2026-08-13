import { connectAsync, type IClientOptions } from "mqtt";

import type { MqttConfig, ReadingRule, UsageReading } from "./types.js";
import { appVersion } from "./version.js";

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
        json_attributes_topic: this.stateTopic,
        json_attributes_template:
          "{{ {'source_updated_on': value_json.sourceUpdatedOn, 'observed_at': value_json.observedAt} | to_json }}",
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
          sw_version: appVersion,
        },
      };
      await this.publish(topic, JSON.stringify(payload), true);
    }

    await this.publish(
      `${this.config.discoveryPrefix}/sensor/${this.config.clientId}/source_updated_on/config`,
      JSON.stringify({
        name: "Source Data Updated On",
        unique_id: `${this.config.clientId}_source_updated_on`,
        object_id: `${this.config.clientId}_source_updated_on`,
        state_topic: this.stateTopic,
        value_template: "{{ value_json.sourceUpdatedOn }}",
        device_class: "date",
        entity_category: "diagnostic",
        availability_topic: this.availabilityTopic,
        payload_available: "online",
        payload_not_available: "offline",
        device: {
          identifiers: [this.config.clientId],
        },
        origin: {
          name: "lwconnect-mqtt",
          sw_version: appVersion,
        },
      }),
      true,
    );

    await this.publish(
      `${this.config.discoveryPrefix}/sensor/${this.config.clientId}/latest_daily_usage/config`,
      JSON.stringify({
        name: "Latest Daily Water Usage",
        unique_id: `${this.config.clientId}_latest_daily_usage`,
        object_id: `${this.config.clientId}_latest_daily_usage`,
        state_topic: this.dailyTopic,
        value_template: "{{ value_json.days[-1].gallons }}",
        json_attributes_topic: this.dailyTopic,
        json_attributes_template:
          "{{ {'usage_date': value_json.days[-1].date, 'observed_at': value_json.observedAt} | to_json }}",
        availability_topic: this.availabilityTopic,
        payload_available: "online",
        payload_not_available: "offline",
        unit_of_measurement: "gal",
        device_class: "water",
        icon: "mdi:water-outline",
        device: {
          identifiers: [this.config.clientId],
        },
        origin: {
          name: "lwconnect-mqtt",
          sw_version: appVersion,
        },
      }),
      true,
    );

    const costSensors: readonly {
      id: string;
      name: string;
      valueTemplate: string;
      unit?: string;
      deviceClass?: string;
      stateClass?: "measurement" | "total_increasing";
      icon: string;
    }[] = [
      {
        id: "current_water_cost",
        name: "Current Water Usage Cost",
        valueTemplate: "{{ value_json.usageCost.amount }}",
        unit: "USD",
        deviceClass: "monetary",
        stateClass: "total_increasing",
        icon: "mdi:cash",
      },
      {
        id: "current_water_rate",
        name: "Current Water Rate",
        valueTemplate: "{{ value_json.usageCost.currentPricePerGallon }}",
        unit: "USD/gal",
        stateClass: "measurement",
        icon: "mdi:cash-multiple",
      },
      {
        id: "current_water_tier",
        name: "Current Water Tier",
        valueTemplate: "{{ value_json.usageCost.currentTier }}",
        icon: "mdi:chart-waterfall",
      },
    ];

    for (const sensor of costSensors) {
      await this.publish(
        `${this.config.discoveryPrefix}/sensor/${this.config.clientId}/${sensor.id}/config`,
        JSON.stringify({
          name: sensor.name,
          unique_id: `${this.config.clientId}_${sensor.id}`,
          object_id: `${this.config.clientId}_${sensor.id}`,
          state_topic: this.stateTopic,
          value_template: sensor.valueTemplate,
          availability_topic: this.availabilityTopic,
          payload_available: "online",
          payload_not_available: "offline",
          ...(sensor.unit === undefined
            ? {}
            : { unit_of_measurement: sensor.unit }),
          ...(sensor.deviceClass === undefined
            ? {}
            : { device_class: sensor.deviceClass }),
          ...(sensor.stateClass === undefined
            ? {}
            : { state_class: sensor.stateClass }),
          icon: sensor.icon,
          device: {
            identifiers: [this.config.clientId],
          },
          origin: {
            name: "lwconnect-mqtt",
            sw_version: appVersion,
          },
        }),
        true,
      );
    }
  }

  public async publishReading(reading: UsageReading): Promise<void> {
    await this.publish(this.stateTopic, JSON.stringify(reading), true);
    await this.publish(
      this.dailyTopic,
      JSON.stringify({
        observedAt: reading.observedAt,
        days: reading.dailyUsage,
      }),
      true,
    );
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

  private get dailyTopic(): string {
    return `${this.config.topicPrefix}/daily`;
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
