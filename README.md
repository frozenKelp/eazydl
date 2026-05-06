# EasyDL — Fitgirl Download Manager

A full-featured web application for managing Fitgirl Repack downloads.
Built as a learning project for FastAPI, async Python, and the aria2c download engine.

## Architecture

```
easydl/
├── backend/
│   ├── main.py        FastAPI app — all HTTP/WebSocket routes
│   ├── downloader.py  aria2c manager via aria2p (pause/resume/progress)
│   ├── scraper.py     BeautifulSoup scraper for Fitgirl & fuckingfast.co
│   └── database.py    SQLite models via SQLAlchemy (lists, downloads, settings)
├── frontend/
│   └── index.html     Single-page UI (vanilla JS, no framework)
├── data/              SQLite DB lives here (auto-created)
├── downloads/         Default download destination (auto-created)
├── requirements.txt
└── run.py             Entry point
```

## Prerequisites

### 1. Install aria2c

aria2c is the actual download engine. It must be installed separately:

| OS            | Command                          |
|---------------|----------------------------------|
| Ubuntu/Debian | `sudo apt install aria2`         |
| macOS         | `brew install aria2`             |
| Windows       | Download from https://aria2.github.io/ and add to PATH |

### 2. Install Python dependencies

```bash
pip install -r requirements.txt
```

Python 3.10+ is recommended.

## Running

```bash
python run.py
```

Then open **http://localhost:8000** in your browser.

The app will:
1. Initialize the SQLite database in `data/`
2. Launch an aria2c subprocess listening on `localhost:6800`
3. Serve the web UI

## Features

| Feature | How it works |
|---|---|
| **Multiple lists** | SQLite stores named lists; each has N downloads |
| **Scrape game page** | BeautifulSoup extracts all `fuckingfast.co` links from a Fitgirl URL |
| **Browse Fitgirl** | In-app search/browse with one-click "Add to list" |
| **Pause / Resume** | aria2c native pause via JSON-RPC — file stays on disk as a partial |
| **Resume across restarts** | aria2c uses HTTP Range headers to continue from the last byte |
| **Multi-connection** | Configurable segments per file (default 4) — much faster on CDN links |
| **Real-time progress** | WebSocket pushes aria2c stats to the UI every second |
| **Settings** | Download path, max concurrent downloads, connections per file |

## How aria2c integration works

```
FastAPI startup
  └─ dm.start()
       └─ launches: aria2c --enable-rpc --rpc-listen-port=6800 ...

User clicks "Start"
  └─ /api/downloads/{id}/start
       └─ asyncio.create_task(_resolve_and_start(...))
            ├─ asyncio.to_thread(resolve_fuckingfast_download)   # sync HTTP in thread
            └─ dm.enqueue(id, url, path)
                 └─ aria2p.add_uris([url], options={split:4, ...})
                       ↓
                 aria2c downloads in background
                       ↓
              poll loop (every 1s)
                 └─ aria2p.get_downloads() → cache → WebSocket → UI
```

## Learning highlights

- **FastAPI async**: background tasks with `asyncio.create_task`, blocking calls in
  `asyncio.to_thread` so the event loop never stalls.
- **aria2c RPC**: controlling a C download engine from Python via JSON-RPC using `aria2p`.
- **SQLAlchemy**: relationship-aware ORM models, session management in async callbacks.
- **WebSocket**: server-push progress updates without polling from the client.
- **HTTP Range headers**: how every real download manager implements pause/resume.

## Disclaimer

This tool is for educational purposes only. Use it responsibly and only for content
you are legally permitted to download.
