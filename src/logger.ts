export const log = (
  level: "info" | "error",
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): void => {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...details,
  });
  if (level === "error") {
    console.error(entry);
  } else {
    console.log(entry);
  }
};
