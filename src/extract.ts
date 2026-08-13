import type { ReadingRule } from "./types.js";

export type ExtractedReadings = {
  metrics: Readonly<Record<string, number>>;
  missingRuleIds: string[];
};

const parseNumber = (value: string): number => {
  const parsed = Number(value.replaceAll(",", ""));
  if (!Number.isFinite(parsed)) {
    throw new Error(`Extracted value is not a finite number: ${value}`);
  }
  return parsed;
};

export const extractFromText = (
  textBySelector: ReadonlyMap<string, string>,
  rules: readonly ReadingRule[],
): ExtractedReadings => {
  const metrics: Record<string, number> = {};
  const missingRuleIds: string[] = [];

  for (const rule of rules) {
    const text = textBySelector.get(rule.selector);
    if (text === undefined) {
      missingRuleIds.push(rule.id);
      continue;
    }

    const match = rule.patterns
      .map((pattern) => new RegExp(pattern, "i").exec(text))
      .find((candidate) => candidate !== null);
    const rawValue = match?.[rule.valueGroup];
    if (rawValue === undefined) {
      missingRuleIds.push(rule.id);
      continue;
    }

    metrics[rule.id] = parseNumber(rawValue);
  }

  return { metrics, missingRuleIds };
};
