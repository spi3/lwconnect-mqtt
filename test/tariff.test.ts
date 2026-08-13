import { describe, expect, it } from "vitest";

import { extractUsageCost } from "../src/tariff.js";

const tariffText = `
  Tier 1 - $3.37 per 1,000 gallons
  Tier 2 - $9.34 per 1,000 gallons
  Tier 3 - $12.52 per 1,000 gallons
`;
const thresholds = ["0", "25,000", "50,000", "75,000"];

describe("extractUsageCost", () => {
  it("extracts portal rates and calculates a first-tier cost", () => {
    expect(extractUsageCost(tariffText, thresholds, 10_753)).toEqual({
      amount: 36.24,
      currency: "USD",
      currentTier: 1,
      currentPricePerGallon: 0.00337,
      tiers: [
        {
          tier: 1,
          startsAtGallons: 0,
          endsAtGallons: 25_000,
          pricePerThousandGallons: 3.37,
          pricePerGallon: 0.00337,
        },
        {
          tier: 2,
          startsAtGallons: 25_000,
          endsAtGallons: 50_000,
          pricePerThousandGallons: 9.34,
          pricePerGallon: 0.00934,
        },
        {
          tier: 3,
          startsAtGallons: 50_000,
          pricePerThousandGallons: 12.52,
          pricePerGallon: 0.01252,
        },
      ],
    });
  });

  it("calculates progressively across tariff tiers", () => {
    expect(extractUsageCost(tariffText, thresholds, 60_000)).toMatchObject({
      amount: 442.95,
      currentTier: 3,
      currentPricePerGallon: 0.01252,
    });
  });

  it("keeps the boundary gallon in the lower current tier", () => {
    expect(extractUsageCost(tariffText, thresholds, 25_000).currentTier).toBe(
      1,
    );
    expect(extractUsageCost(tariffText, thresholds, 25_001).currentTier).toBe(
      2,
    );
  });

  it("rejects missing tariff data", () => {
    expect(() => extractUsageCost("No rates", thresholds, 1_000)).toThrow(
      "Could not find",
    );
  });
});
