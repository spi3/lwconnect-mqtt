import { describe, expect, it } from "vitest";

import { extractFromText } from "../src/extract.js";
import type { ReadingRule } from "../src/types.js";

const rules: ReadingRule[] = [
  {
    id: "current_billing_cycle",
    name: "Current billing cycle",
    selector: "body",
    patterns: ["Current Billing Cycle Usage\\s*([\\d,.]+) gallons"],
    valueGroup: 1,
    unit: "gal",
    deviceClass: "water",
    stateClass: "total_increasing",
  },
  {
    id: "average_daily_usage",
    name: "Average daily usage",
    selector: "body",
    patterns: ["Average Daily Usage\\s*([\\d,.]+) gal"],
    valueGroup: 1,
    unit: "gal",
  },
];

describe("extractFromText", () => {
  it("extracts numeric readings and removes thousands separators", () => {
    const result = extractFromText(
      new Map([
        [
          "body",
          "Current Billing Cycle Usage\n1,234 gallons\nAverage Daily Usage\n42.5 gal",
        ],
      ]),
      rules,
    );

    expect(result).toEqual({
      metrics: {
        current_billing_cycle: 1234,
        average_daily_usage: 42.5,
      },
      missingRuleIds: [],
    });
  });

  it("reports rules that did not match", () => {
    const result = extractFromText(new Map([["body", "No usage here"]]), rules);

    expect(result.metrics).toEqual({});
    expect(result.missingRuleIds).toEqual([
      "current_billing_cycle",
      "average_daily_usage",
    ]);
  });
});
