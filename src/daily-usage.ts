import type { DailyUsage } from "./types.js";

const monthByName = new Map(
  [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ].map((name, index) => [name, index + 1]),
);

const portalDateParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

const dateKey = (year: number, month: number, day: number): string =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const parseLabel = (
  label: string,
): { month: number; day: number; year?: number } => {
  const fullDateMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(label.trim());
  if (fullDateMatch !== null) {
    const [, rawMonth, rawDay, rawYear] = fullDateMatch;
    if (
      rawMonth !== undefined &&
      rawDay !== undefined &&
      rawYear !== undefined
    ) {
      return {
        month: Number(rawMonth),
        day: Number(rawDay),
        year: Number(rawYear),
      };
    }
  }
  const match = /^([A-Z][a-z]{2})\s+(\d{1,2})$/.exec(label.trim());
  const [, monthName, rawDay] = match ?? [];
  const month =
    monthName === undefined ? undefined : monthByName.get(monthName);
  if (month === undefined || rawDay === undefined) {
    throw new Error(`Invalid LW Connect daily usage date label: ${label}`);
  }
  return { month, day: Number(rawDay) };
};

const validateDate = (year: number, month: number, day: number): void => {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(
      `LW Connect returned an invalid daily usage date: ${dateKey(year, month, day)}`,
    );
  }
};

export const buildDailyUsage = (
  labels: readonly string[],
  values: readonly (number | null)[],
  observedAt: Date,
): DailyUsage[] => {
  if (labels.length === 0 || labels.length !== values.length) {
    throw new Error("LW Connect returned incomplete daily usage graph data");
  }

  const parsedLabels = labels.map(parseLabel);
  const observedParts = portalDateParts.formatToParts(observedAt);
  const observedYear = Number(
    observedParts.find(({ type }) => type === "year")?.value,
  );
  const observedMonth = Number(
    observedParts.find(({ type }) => type === "month")?.value,
  );
  const observedDay = Number(
    observedParts.find(({ type }) => type === "day")?.value,
  );
  if (
    !Number.isInteger(observedYear) ||
    !Number.isInteger(observedMonth) ||
    !Number.isInteger(observedDay)
  ) {
    throw new Error("Could not determine the LW Connect observation date");
  }

  const lastLabel = parsedLabels.at(-1);
  if (lastLabel === undefined) {
    throw new Error("LW Connect returned no daily usage date labels");
  }
  let year =
    lastLabel.year ??
    (lastLabel.month > observedMonth ||
    (lastLabel.month === observedMonth && lastLabel.day > observedDay)
      ? observedYear - 1
      : observedYear);
  const years = Array<number>(parsedLabels.length);
  let nextMonth: number | undefined;
  for (let index = parsedLabels.length - 1; index >= 0; index -= 1) {
    const label = parsedLabels[index];
    if (label === undefined) {
      throw new Error("LW Connect returned a sparse daily usage graph");
    }
    if (label.year !== undefined) {
      year = label.year;
    } else if (nextMonth !== undefined && label.month > nextMonth) {
      year -= 1;
    }
    years[index] = year;
    nextMonth = label.month;
  }

  const usage = parsedLabels.flatMap(({ month, day }, index) => {
    const value = values[index];
    const resolvedYear = years[index];
    if (value === undefined || resolvedYear === undefined) {
      throw new Error("LW Connect returned incomplete daily usage graph data");
    }
    validateDate(resolvedYear, month, day);
    if (index > 0) {
      const previous = parsedLabels[index - 1];
      const previousYear = years[index - 1];
      if (previous === undefined || previousYear === undefined) {
        throw new Error("LW Connect returned a sparse daily usage graph");
      }
      const previousDate = new Date(
        Date.UTC(previousYear, previous.month - 1, previous.day),
      );
      const currentDate = new Date(Date.UTC(resolvedYear, month - 1, day));
      if (currentDate.getTime() - previousDate.getTime() !== 86_400_000) {
        throw new Error("LW Connect daily usage dates are not continuous");
      }
    }
    if (value === null || !Number.isFinite(value) || value < 0) {
      return [];
    }
    return [{ date: dateKey(resolvedYear, month, day), gallons: value }];
  });
  if (usage.length === 0) {
    throw new Error("LW Connect returned no available daily usage values");
  }
  return usage;
};
