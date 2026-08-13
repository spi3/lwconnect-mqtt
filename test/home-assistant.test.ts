import { describe, expect, it } from "vitest";

import { buildStatisticsPlan, localDateStart } from "../src/home-assistant.js";

describe("localDateStart", () => {
  it("uses Loudoun local midnight on both sides of daylight saving time", () => {
    expect(localDateStart("2026-01-15", "America/New_York")).toBe(
      "2026-01-15T05:00:00.000Z",
    );
    expect(localDateStart("2026-07-15", "America/New_York")).toBe(
      "2026-07-15T04:00:00.000Z",
    );
  });
});

describe("buildStatisticsPlan", () => {
  it("preserves the prior sum and overwrites corrected overlapping days", () => {
    const plan = buildStatisticsPlan(
      [
        { date: "2026-08-11", gallons: 125 },
        { date: "2026-08-12", gallons: 80 },
      ],
      [
        {
          start: Date.parse("2026-08-10T04:00:00.000Z"),
          state: 100,
          sum: 1000,
        },
        {
          start: Date.parse("2026-08-11T04:00:00.000Z"),
          state: 120,
          sum: 1120,
        },
      ],
      "America/New_York",
    );

    expect(plan).toMatchObject({ previousSum: 1000, changedPoints: 2 });
    expect(plan.points).toEqual([
      {
        start: "2026-08-11T04:00:00.000Z",
        state: 125,
        sum: 1125,
      },
      {
        start: "2026-08-12T04:00:00.000Z",
        state: 80,
        sum: 1205,
      },
    ]);
  });

  it("is idempotent when all stored values already match", () => {
    const dailyUsage = [{ date: "2026-08-12", gallons: 80 }];
    const start = Date.parse("2026-08-12T04:00:00.000Z");
    expect(
      buildStatisticsPlan(
        dailyUsage,
        [{ start, state: 80, sum: 80 }],
        "America/New_York",
      ).changedPoints,
    ).toBe(0);
  });
});
