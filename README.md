# EasyDL

EasyDL is a local download manager built around a local FitGirl index.

It does three things:

1. Keeps a searchable copy of FitGirl metadata on your machine.
2. Lets you add games to a local library.
3. Sends selected download links to `aria2c`.

Normal browsing is fast because EasyDL searches the local index instead of
loading FitGirl pages live. When you add a game, EasyDL uses the stored
FuckingFast links and hands selected files to `aria2c`.

Use it only for content you are allowed to download.

## Run

Requirements:

```text
Python 3.12+
uv
curl
aria2c
```

Start the app:

```bash
uv run eazydl
```

Open:

```text
http://127.0.0.1:8001
```

No browser auto-open:

```bash
uv run eazydl --no-open
```

## How It Works

EasyDL reads game data from:

```text
fitgirl-index/store/
```

The app state lives in:

```text
data/eazydl.db
```

Downloads go to:

```text
downloads/
```

That split is intentional:

```text
fitgirl-index/  the searchable FitGirl cache
data/           EasyDL settings, library, download state
downloads/      downloaded files
```

You can delete `data/` to reset EasyDL without deleting the FitGirl index.
You can delete `fitgirl-index/` to rebuild the index without touching your
library database.

All runtime folders are ignored by git.

## Index

Update recent posts:

```bash
uv run python -m eazydl.indexer.crawler --update
```

Rebuild everything:

```bash
uv run python -m eazydl.indexer.crawler --rebuild
```

Build from saved API or HTML files:

```bash
uv run python -m eazydl.indexer.crawler --source local-dir --local-dir saved_pages --reset-store
```

The index stores compact records:

```text
index.json          searchable list
taxonomies.json     tag/category name lookup
games/              full game records with links
```

## Code Map

```text
src/eazydl/
  __main__.py        command entry
  app.py             local web app
  paths.py           folder locations
  api/               browser-facing routes
  db/                SQLite setup
  downloader/        aria2c control and link resolving
  indexer/           FitGirl index reader/crawler
  web/               HTML, CSS, JS
```

## Checks

Fast sanity check:

```bash
uv run python -m compileall src/eazydl
```

Package build:

```bash
uv build
```

Command help:

```bash
uv run eazydl --help
uv run python -m eazydl.indexer.crawler --help
```

## Folder Overrides

Defaults are simple, but you can move things if needed:

```text
EASYDL_ROOT           project root
EASYDL_DATA_DIR       app database folder
EASYDL_INDEX_DIR      FitGirl index folder
EASYDL_DOWNLOADS_DIR  download folder
```

Example:

```bash
EASYDL_DOWNLOADS_DIR=D:\Games\Downloads uv run eazydl
```
