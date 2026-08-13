import type { TariffTier, UsageCost } from "./types.js";

const tariffPattern =
  /Tier\s+(\d+)\s*-\s*\$\s*([\d,.]+)\s+per\s+([\d,.]+)\s+gallons?/gi;

const parseNumber = (value: string): number => {
  const parsed = Number(value.replaceAll(",", ""));
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid tariff number: ${value}`);
  }
  return parsed;
};

const round = (value: number, decimalPlaces: number): number => {
  const multiplier = 10 ** decimalPlaces;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};

export const extractUsageCost = (
  tariffText: string,
  thresholdLabels: readonly string[],
  currentUsageGallons: number,
): UsageCost => {
  const parsedRates = [...tariffText.matchAll(tariffPattern)]
    .map((match) => {
      const [, rawTier, rawPrice, rawQuantity] = match;
      if (
        rawTier === undefined ||
        rawPrice === undefined ||
        rawQuantity === undefined
      ) {
        throw new Error("LW Connect returned an incomplete tariff tier");
      }
      const quantity = parseNumber(rawQuantity);
      if (quantity <= 0) {
        throw new Error("LW Connect returned a non-positive tariff quantity");
      }
      return {
        tier: parseNumber(rawTier),
        pricePerThousandGallons: round(
          (parseNumber(rawPrice) / quantity) * 1_000,
          6,
        ),
        pricePerGallon: parseNumber(rawPrice) / quantity,
      };
    })
    .sort((left, right) => left.tier - right.tier);

  if (parsedRates.length === 0) {
    throw new Error("Could not find LW Connect water tariff tiers");
  }
  if (
    parsedRates.some(({ tier }, index) => tier !== index + 1) ||
    new Set(parsedRates.map(({ tier }) => tier)).size !== parsedRates.length
  ) {
    throw new Error("LW Connect returned non-sequential tariff tiers");
  }

  const thresholds = thresholdLabels.map(parseNumber);
  if (
    thresholds.length < parsedRates.length ||
    thresholds.some((threshold, index) => {
      const previousThreshold = thresholds[index - 1];
      return previousThreshold !== undefined && threshold <= previousThreshold;
    })
  ) {
    throw new Error("LW Connect returned invalid water tariff thresholds");
  }

  const tiers: TariffTier[] = parsedRates.map((rate, index) => {
    const startsAtGallons = thresholds[index];
    if (startsAtGallons === undefined) {
      throw new Error(
        `Could not find the threshold for tariff tier ${String(rate.tier)}`,
      );
    }
    const endsAtGallons =
      index === parsedRates.length - 1 ? undefined : thresholds[index + 1];
    return {
      ...rate,
      startsAtGallons,
      ...(endsAtGallons === undefined ? {} : { endsAtGallons }),
      pricePerGallon: round(rate.pricePerGallon, 9),
    };
  });

  if (!Number.isFinite(currentUsageGallons) || currentUsageGallons < 0) {
    throw new Error("LW Connect returned invalid current water usage");
  }

  const lastTier = tiers.at(-1);
  if (lastTier === undefined) {
    throw new Error("Could not construct LW Connect water tariff tiers");
  }
  const currentTier =
    tiers.find(
      ({ endsAtGallons }) =>
        endsAtGallons === undefined || currentUsageGallons <= endsAtGallons,
    ) ?? lastTier;
  const amount = tiers.reduce((total, tier) => {
    const gallonsInTier = Math.max(
      0,
      Math.min(currentUsageGallons, tier.endsAtGallons ?? currentUsageGallons) -
        tier.startsAtGallons,
    );
    return total + gallonsInTier * tier.pricePerGallon;
  }, 0);

  return {
    amount: round(amount, 2),
    currency: "USD",
    currentTier: currentTier.tier,
    currentPricePerGallon: currentTier.pricePerGallon,
    tiers,
  };
};
