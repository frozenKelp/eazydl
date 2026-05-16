from __future__ import annotations

import asyncio
import time

from starlette.applications import Starlette
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket

from .api import download_routes, index_routes, library_routes, settings_routes
from .db import Database
from .downloader import DownloadService
from .indexer.store import IndexStore
from .indexer.updater import IndexUpdateManager
from .paths import STATIC_DIR, WEB_DIR, ensure_runtime_dirs


async def homepage(_request) -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


async def health(_request) -> JSONResponse:
    return JSONResponse({"ok": True})


async def progress_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            downloads = websocket.app.state.downloads.all_downloads()
            index_status = websocket.app.state.index_updater.status()
            await websocket.send_json({"type": "progress", "downloads": downloads, "index": index_status})
            await asyncio.sleep(1)
    except Exception:
        return


async def on_startup() -> None:
    app = create_app.instance
    settings = app.state.db.get_settings()
    if settings.get("auto_update_on_start") == "true" and app.state.index_store.exists:
        status = app.state.index_store.status()
        ttl_seconds = int(settings.get("index_update_ttl_hours", "24")) * 3600
        mtime = status.get("index_mtime") or 0
        if time.time() - float(mtime) >= ttl_seconds:
            app.state.index_updater.start("update", background=True)
    app.state.downloads.start()


async def on_shutdown() -> None:
    create_app.instance.state.downloads.shutdown()


def create_app() -> Starlette:
    ensure_runtime_dirs()
    routes = [
        Route("/api/health", health, methods=["GET"]),
        *index_routes,
        *library_routes,
        *download_routes,
        *settings_routes,
        WebSocketRoute("/ws/progress", progress_socket),
        Mount("/static", StaticFiles(directory=STATIC_DIR), name="static"),
        Route("/", homepage, methods=["GET"]),
        Route("/{path:path}", homepage, methods=["GET"]),
    ]
    app = Starlette(routes=routes, on_startup=[on_startup], on_shutdown=[on_shutdown])
    app.state.db = Database()
    app.state.index_store = IndexStore()
    app.state.index_updater = IndexUpdateManager(app.state.index_store, app.state.db)
    app.state.downloads = DownloadService(app.state.db)
    create_app.instance = app
    return app


create_app.instance: Starlette
