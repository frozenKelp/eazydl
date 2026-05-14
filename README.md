# EasyDL Node

EasyDL migrated to a Bun/Fastify backend with the existing vanilla frontend and
SQLite database preserved.

Use it only for content you are legally allowed to download.

## Requirements

- Bun 1.1 or newer.
- `aria2c` installed and available on `PATH`.

## Quick Start

```bash
bun install
bun start
```

Open:

```text
http://localhost:8001
```

The default port is `8001` so this project can run next to the original Python
app on `8000` during migration testing.

## Build

```bash
bun run build
./dist/easydl
```

On Windows the compiled output is `dist/easydl.exe`.

## Project Layout

```text
eazydl-node/
|-- frontend/        copied from the Python app unchanged
|-- src/
|   |-- db/
|   |-- routes/
|   |-- config.ts
|   |-- downloader.ts
|   |-- downloadService.ts
|   |-- scraper.ts
|   |-- security.ts
|   |-- serializers.ts
|   |-- server.ts
|   `-- index.ts
|-- data/
|   `-- downloader.db
|-- downloads/
|-- package.json
`-- tsconfig.json
```

## Notes

The database schema is unchanged, and `data/downloader.db` can be copied
directly from the Python project. Bun on Windows currently refuses to load the
native `better-sqlite3` binding, so the database module uses a small synchronous
adapter over Bun's native SQLite API with the same `prepare/get/all/run`
calling style used by the port.
