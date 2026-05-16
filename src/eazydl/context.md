# EasyDL Handoff Context

Active project: `C:\Users\anu\projects\eazydl`

EasyDL is now a Python local web app. It replaced the old Bun/Fastify/Playwright
scraper app. The app is local-first: no GitHub index repo, no PAT flow, no live
FitGirl scraper routes.

## Current Architecture

```text
src/eazydl/
|-- __main__.py          uv run eazydl entrypoint
|-- app.py               Starlette app, static UI, startup/shutdown
|-- paths.py             runtime paths
|-- api/                 index, library, downloads, settings routes
|-- db/                  sqlite schema and helper class
|-- downloader/          aria2 RPC wrapper and FuckingFast resolver
|-- indexer/             vendored FitGirl crawler and JSON store reader
`-- web/                 single-page browser UI
```

Runtime data is ignored:

```text
data/eazydl.db
data/fitgirl-index/meta.yaml
data/fitgirl-index/store/
downloads/
```

The local index currently lives at:

```text
C:\Users\anu\projects\eazydl\data\fitgirl-index\store
```

Last checked index count: `6849`.

## Run And Check

```bash
cd C:\Users\anu\projects\eazydl
uv run eazydl
```

Open:

```text
http://127.0.0.1:8001
```

Useful checks:

```bash
uv run python -m compileall src\eazydl
uv build
uv run eazydl --help
uv run python -m eazydl.indexer.crawler --help
```

Recent smoke checks passed:

- server health
- index status
- index search for `cyberpunk`
- empty-data setup mode
- settings route
- library add/delete

## API Surface

Index:

```text
GET  /api/index/status
POST /api/index/update
POST /api/index/rebuild
GET  /api/index/search?q=&page=&limit=
GET  /api/index/games/{id_or_slug}
```

Library and downloads:

```text
GET    /api/library
POST   /api/library
DELETE /api/library/{item_id}
GET    /api/downloads
POST   /api/downloads/batch/start
POST   /api/downloads/batch/pause
POST   /api/downloads/batch/resume
POST   /api/downloads/batch/stop
WS     /ws/progress
```

Settings:

```text
GET /api/settings
PUT /api/settings
```

## Database

SQLite file: `data/eazydl.db`

Tables:

- `settings`
- `library_items`
- `downloads`
- `index_runs`

SQLite stores EasyDL state only. The FitGirl index stays as JSON files and is
read through `IndexStore`.

## Current EasyDL Git State

At the time this context was written, EasyDL had three uncommitted fixes:

```text
M  src/eazydl/app.py
M  src/eazydl/db/database.py
?? LICENSE
```

Those fixes are intentional:

- app lifecycle no longer relies on a global `create_app.instance`
- SQLite has explicit `close()` / context-manager support
- MIT `LICENSE` was restored after the overhaul commit removed it

Commit these in EasyDL before doing UI refinement.

## UI Refinement Notes

The current UI is functional but basic. Good next targets:

- better first-run setup screen
- cleaner browse cards and detail dialog
- library filtering/search
- download row grouping by game
- selectable file groups for optional language/bonus packs
- clearer index update/rebuild progress
- stronger mobile layout polish

Keep the UI local-web-first. Do not reintroduce Tauri, Bun, or Playwright for
the app runtime.
