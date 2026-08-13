# lwconnect-mqtt

`lwconnect-mqtt` signs in to Loudoun Water's LW Connect portal with Playwright,
extracts configured water-usage values, and publishes them to MQTT. It also
publishes retained MQTT Discovery messages so Home Assistant can create the
sensors automatically.

LW Connect does not expose a documented customer API. This project therefore
automates the rendered portal and intentionally avoids its private Mendix
`/xas/` protocol. Portal changes can break extraction; the calibration workflow
makes those changes inspectable without changing application code.

## Security and account safety

- Put credentials only in `.env` or your container secret mechanism. `.env`,
  browser state, and calibration artifacts are gitignored.
- Calibration artifacts contain account information. They are written with
  owner-only permissions where supported; do not share them without redacting
  them.
- The poll interval defaults to 60 minutes to avoid placing unnecessary load on
  LW Connect. Do not lower it below five minutes.
- Confirm that automated access is acceptable under the portal's terms and your
  account agreement before long-term deployment.

## Quick start

Requirements: Node.js 22+, an MQTT broker, and a Linux/macOS host capable of
running Chromium.

```sh
cp .env.example .env
npm install
npx playwright install chromium
```

Edit `.env` with your LW Connect and MQTT credentials. Then run calibration:

```sh
npm run calibrate
```

This logs in, opens the usage page, and writes `usage-page.txt`,
`usage-page.html`, and `usage-page.png` under `artifacts/`. Review the text file
locally and adjust `config/readings.json` until the desired values appear in
`extractedMetrics` in the command output. Each extraction rule contains:

- `selector`: the page region whose visible text is examined;
- `patterns`: case-insensitive regular expressions; capture group 1 is the
  numeric value by default;
- Home Assistant metadata such as unit, device class, and state class.

The included rules are conservative starting heuristics because the
authenticated account view is not publicly inspectable. They require the page to
identify values as gallons instead of silently assuming a unit.

Test one complete scrape and publish:

```sh
npm run once
```

Run continuously after that succeeds:

```sh
npm run build
npm start
```

## Docker Compose

After creating `.env` and calibrating the extraction rules:

```sh
docker compose build
docker compose up -d
docker compose logs -f lwconnect-mqtt
```

The image versions Playwright and its browser together. It runs as the
unprivileged `pwuser` supplied by the official Playwright image.

## MQTT contract

Defaults can be changed in `.env`.

| Topic                                                 | Payload                                                                                | Retained |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- | -------- |
| `home/water/lwconnect/state`                          | `{"observedAt":"...","sourceUpdatedOn":"2026-08-11","metrics":{"current_usage":1234}}` | yes      |
| `home/water/lwconnect/availability`                   | `online` or `offline`                                                                  | yes      |
| `homeassistant/sensor/lwconnect-mqtt/<metric>/config` | Home Assistant MQTT Discovery config                                                   | yes      |

State and discovery messages use QoS 1. The MQTT connection also has a retained
`offline` last will, and an orderly continuous-service shutdown publishes
`offline` explicitly. A successful one-shot publish remains available. The water
sensor exposes `source_updated_on` and `observed_at` attributes, and MQTT
Discovery creates a separate diagnostic date sensor for the source update.

## Troubleshooting

- `Could not find LW Connect usage navigation`: set `usageNavigationSelector` in
  `config/readings.json` to a stable Playwright CSS selector from the calibrated
  page, or update `usageNavigationLabels`.
- `No configured usage readings matched`: inspect `artifacts/usage-page.txt` and
  update the regular expressions. JSON requires backslashes to be doubled.
- Login timeout: verify the credentials manually and inspect whether LW Connect
  introduced a challenge, consent prompt, or changed the login form.
- For interactive debugging, set `LWCONNECT_HEADLESS=false` on a machine with a
  graphical session and run `npm run calibrate`.

## Development

```sh
npm run check
```

The checks cover formatting, strict ESLint rules, TypeScript, extraction and
MQTT contract tests, a Playwright test against a local mock portal, and a
production build.
