import { describe, expect, it } from "vitest";

import { buildDailyUsage } from "../src/daily-usage.js";

describe("buildDailyUsage", () => {
  it("associates chart values with their calendar dates", () => {
    expect(
      buildDailyUsage(
        ["Aug 10", "Aug 11", "Aug 12"],
        [100, 125.5, 80],
        new Date("2026-08-13T12:00:00Z"),
      ),
    ).toEqual([
      { date: "2026-08-10", gallons: 100 },
      { date: "2026-08-11", gallons: 125.5 },
      { date: "2026-08-12", gallons: 80 },
    ]);
  });

  it("infers the previous year across the December boundary", () => {
    expect(
      buildDailyUsage(
        ["Dec 30", "Dec 31", "Jan 1"],
        [10, 20, 30],
        new Date("2026-01-02T12:00:00Z"),
      ),
    ).toEqual([
      { date: "2025-12-30", gallons: 10 },
      { date: "2025-12-31", gallons: 20 },
      { date: "2026-01-01", gallons: 30 },
    ]);
  });

  it("accepts the portal's full-date label variant", () => {
    expect(
      buildDailyUsage(
        ["08/10/2026", "08/11/2026"],
        [100, 123],
        new Date("2026-08-13T12:00:00Z"),
      ),
    ).toEqual([
      { date: "2026-08-10", gallons: 100 },
      { date: "2026-08-11", gallons: 123 },
    ]);
  });

  it("rejects gaps in chart dates", () => {
    expect(() =>
      buildDailyUsage(
        ["Aug 10", "Aug 12"],
        [100, 80],
        new Date("2026-08-13T12:00:00Z"),
      ),
    ).toThrow("not continuous");
  });

  it("omits unavailable sentinels without dropping a real zero", () => {
    expect(
      buildDailyUsage(
        ["Aug 11", "Aug 12", "Aug 13"],
        [0, 126.6, -1],
        new Date("2026-08-14T12:00:00Z"),
      ),
    ).toEqual([
      { date: "2026-08-11", gallons: 0 },
      { date: "2026-08-12", gallons: 126.6 },
    ]);
  });

  it("omits an unavailable value in the middle of otherwise valid history", () => {
    expect(
      buildDailyUsage(
        ["Aug 10", "Aug 11", "Aug 12"],
        [100, null, 125],
        new Date("2026-08-14T12:00:00Z"),
      ),
    ).toEqual([
      { date: "2026-08-10", gallons: 100 },
      { date: "2026-08-12", gallons: 125 },
    ]);
  });
});
