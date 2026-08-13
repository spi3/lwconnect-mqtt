import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractSourceUpdatedOn, PortalClient } from "../src/portal.js";
import type { PortalConfig } from "../src/types.js";

let server: Server;
let loginUrl: string;

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html>
      <html>
        <body>
          <main id="app">
            <input placeholder="User ID or Email Address" />
            <input type="password" placeholder="Password" />
            <button id="login">LOGIN</button>
          </main>
          <script>
            document.querySelector('#login').addEventListener('click', () => {
              document.querySelector('#app').innerHTML = '';
              setTimeout(() => {
                document.querySelector('#app').innerHTML = '<h1>Dashboard</h1><button id="usage">Water Usage</button>';
                document.querySelector('#usage').addEventListener('click', () => {
                  document.querySelector('#app').innerHTML = '<h1>Water Usage</h1><p>Current Billing Cycle Usage</p><strong>1,234 gallons</strong><p>Average Daily Usage</p><strong>42.5 gal</strong><p>Last Update: 08/11/2026</p>';
                });
              }, 50);
            });
          </script>
        </body>
      </html>`);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Mock portal did not bind to a TCP port");
  }
  loginUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
});

describe("PortalClient", () => {
  it("logs in, opens usage, and extracts configured readings", async () => {
    const config: PortalConfig = {
      username: "test-user",
      password: "test-password",
      loginUrl,
      headless: true,
      timeoutMs: 5_000,
      artifactDir: "./artifacts/test",
      saveDiagnostics: false,
      rules: {
        usageNavigationLabels: ["Water Usage", "Usage"],
        readings: [
          {
            id: "current_billing_cycle",
            name: "Current billing cycle",
            selector: "body",
            patterns: ["Current Billing Cycle Usage\\s*([\\d,.]+) gallons"],
            valueGroup: 1,
            unit: "gal",
          },
          {
            id: "average_daily_usage",
            name: "Average daily usage",
            selector: "body",
            patterns: ["Average Daily Usage\\s*([\\d,.]+) gal"],
            valueGroup: 1,
            unit: "gal",
          },
        ],
      },
    };

    const reading = await new PortalClient(config).scrapeUsage();

    expect(reading.metrics).toEqual({
      current_billing_cycle: 1234,
      average_daily_usage: 42.5,
    });
    expect(reading.sourceUpdatedOn).toBe("2026-08-11");
    expect(Date.parse(reading.observedAt)).not.toBeNaN();
  });
});

describe("extractSourceUpdatedOn", () => {
  it("normalizes the LW Connect date to ISO format", () => {
    expect(extractSourceUpdatedOn("Last Update: 8/1/2026")).toBe("2026-08-01");
  });

  it("rejects invalid dates", () => {
    expect(() => extractSourceUpdatedOn("Last Update: 02/31/2026")).toThrow(
      "invalid Last Update date",
    );
  });

  it("rejects a page without the source update date", () => {
    expect(() => extractSourceUpdatedOn("CURRENT USAGE 123 Gallons")).toThrow(
      "Could not find",
    );
  });
});
