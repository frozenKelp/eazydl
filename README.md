# EasyDL

EasyDL is a local Python web app for browsing a local FitGirl JSON index and
downloading selected files with `aria2c`.

The app is local-only. It does not use a shared index service, GitHub token, or
live FitGirl scraper routes. The FitGirl index is stored on disk under
`data/fitgirl-index/store`, and EasyDL's own library/download state is stored in
`data/eazydl.db`.

Use it only for content you are allowed to download.

## Requirements

- Python 3.12 or newer.
- `uv`.
- `aria2c` on `PATH` for downloads.
- `curl` on `PATH` for the most reliable index updates.

## Quick Start

```bash
uv run eazydl
```

Open:

```text
http://127.0.0.1:8001
```

The first run shows the setup view if `data/fitgirl-index/store/index.json` is
missing. Use rebuild for a full local index, or compile a saved page cache with:

```bash
uv run python -m eazydl.indexer.crawler --source local-dir --local-dir saved_pages --reset-store
```

## Project Layout

```text
src/eazydl/
|-- api/          HTTP and websocket routes
|-- db/           SQLite schema and helpers
|-- downloader/   aria2c RPC and link resolution
|-- indexer/      local FitGirl indexer and store reader
`-- web/          browser UI assets
```

Runtime data is ignored by git:

```text
data/eazydl.db
data/fitgirl-index/meta.yaml
data/fitgirl-index/store/
downloads/
```

## Useful Commands

```bash
uv run python -m compileall src/eazydl
uv run python -m eazydl.indexer.crawler --update
uv run python -m eazydl.indexer.crawler --rebuild
```
