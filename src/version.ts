import { readFileSync } from "node:fs";

const packageMetadata: unknown = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

if (
  typeof packageMetadata !== "object" ||
  packageMetadata === null ||
  !("version" in packageMetadata) ||
  typeof packageMetadata.version !== "string"
) {
  throw new Error("package.json does not contain a valid version");
}

export const appVersion = packageMetadata.version;
