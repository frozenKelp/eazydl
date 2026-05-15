# EasyDL Node

EasyDL is a local Bun/Fastify download workspace with a vanilla frontend,
SQLite persistence, aria2c transfer control, and Playwright-backed browsing for
sites that block normal HTTP fetches.

Use it only for content you are allowed to download.

## Requirements

- Bun 1.1 or newer.
- Node.js for the UI verification script.
- `aria2c` installed and available on `PATH`.
- Playwright's Chromium browser installed (`npx playwright install chromium` if
  it is not already present).

## Quick Start

```bash
bun install
bun start
```

Open:

```text
http://localhost:8001
```

The default port is `8001`; override it with `EASYDL_PORT`. Runtime paths are
resolved from the current working directory, or from `EASYDL_ROOT` if set.

## Checks

```bash
bun run typecheck
bun run build
npm run verify:ui
```

`verify:ui` starts the app on a temporary local port and checks the library and
settings pages at desktop and mobile sizes.

## Build

```bash
bun run build
./dist/easydl
```

On Windows the compiled output is `dist/easydl.exe`. Run the executable from the
project root, or set `EASYDL_ROOT` to the project root, so it can find
`frontend/`, `data/`, and the configured download folder.

## Project Layout

```text
eazydl-node/
|-- frontend/        static HTML, CSS, and browser JavaScript
|-- scripts/         verification scripts
|-- src/
|   |-- db/
|   |-- api.ts
|   |-- aria2-service.ts
|   |-- config.ts
|   |-- ensureDirs.ts
|   |-- index.ts
|   |-- scraper.ts
|   |-- security.ts
|   |-- server.ts
|   `-- settings.ts
|-- data/            ignored runtime database files
|-- downloads/       ignored downloaded files
|-- package.json
`-- tsconfig.json
```

## Notes

The scraper intentionally uses Playwright for FitGirl pages because plain
`fetch` can be rejected by DDoS protection. Runtime database files and logs are
ignored; they should not be committed.
