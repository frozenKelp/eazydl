"""
FastAPI backend for EasyDL.

Key differences from the aiohttp version:
  - on_startup launches aria2c and connects via aria2p
  - on_shutdown sends aria2.shutdown via RPC
  - _resolve_and_start callback receives a progress DICT (not a DownloadTask)
  - /api/status exposes aria2c global stats for the UI header
  - Settings include connections_per_file
"""

import asyncio
import os
from datetime import datetime
from typing import List

from fastapi import Body, Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import Download, LinkList, SessionLocal, Setting, get_db, init_db
from downloader import dm
from scraper import get_fuckingfast_links, resolve_fuckingfast_download, search_fitgirl

FRONTEND_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "frontend")
)

app = FastAPI(title="EasyDL")


# ── Lifecycle ─────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def on_startup() -> None:
    init_db()

    # Load persisted settings to configure aria2c
    db = SessionLocal()
    try:
        s = {row.key: row.value for row in db.query(Setting).all()}
    finally:
        db.close()

    max_concurrent      = int(s.get("max_concurrent", 3))
    connections_per_file = int(s.get("connections_per_file", 4))

    try:
        await dm.start(
            max_concurrent=max_concurrent,
            connections_per_file=connections_per_file,
        )
        print("✓ aria2c connected and ready.")
    except RuntimeError as exc:
        # App still starts — downloads will fail until aria2c is installed
        print(f"⚠  aria2c unavailable: {exc}")


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await dm.shutdown()


# ── Pydantic models ───────────────────────────────────────────────────────────

class ListCreate(BaseModel):
    name: str


class LinksAdd(BaseModel):
    urls: List[str]


class ScrapeRequest(BaseModel):
    game_url: str
    list_id: int


# ── Lists ─────────────────────────────────────────────────────────────────────

@app.get("/api/lists")
def api_get_lists(db: Session = Depends(get_db)):
    return [
        {
            "id":         lst.id,
            "name":       lst.name,
            "created_at": lst.created_at.isoformat() if lst.created_at else None,
            "count":      len(lst.downloads),
        }
        for lst in db.query(LinkList).order_by(LinkList.created_at.desc()).all()
    ]


@app.post("/api/lists", status_code=201)
def api_create_list(data: ListCreate, db: Session = Depends(get_db)):
    if db.query(LinkList).filter(LinkList.name == data.name).first():
        raise HTTPException(400, "A list with that name already exists.")
    lst = LinkList(name=data.name)
    db.add(lst)
    db.commit()
    db.refresh(lst)
    return {"id": lst.id, "name": lst.name}


@app.delete("/api/lists/{list_id}")
def api_delete_list(list_id: int, db: Session = Depends(get_db)):
    lst = db.query(LinkList).filter(LinkList.id == list_id).first()
    if not lst:
        raise HTTPException(404, "List not found.")
    for dl in lst.downloads:
        dm.stop(dl.id)
    db.delete(lst)
    db.commit()
    return {"status": "deleted"}


@app.get("/api/lists/{list_id}/downloads")
def api_get_downloads(list_id: int, db: Session = Depends(get_db)):
    dls = (
        db.query(Download)
        .filter(Download.list_id == list_id)
        .order_by(Download.created_at)
        .all()
    )
    result = []
    for d in dls:
        live      = dm.get_progress(d.id) or {}
        bytes_dl  = live.get("bytes_downloaded", d.bytes_downloaded)
        total     = live.get("total_bytes", d.total_bytes)
        result.append(
            {
                "id":               d.id,
                "url":              d.source_url,
                "filename":         live.get("filename") or d.filename or "",
                "status":           live.get("status", d.status),
                "bytes_downloaded": bytes_dl,
                "total_bytes":      total,
                "progress":         live.get("progress", (bytes_dl / total * 100) if total else 0),
                "speed":            live.get("speed", 0),
                "connections":      live.get("connections", 0),
                "gid":              live.get("gid", ""),
                "error_message":    d.error_message or live.get("error"),
            }
        )
    return result


@app.post("/api/lists/{list_id}/links")
def api_add_links(list_id: int, data: LinksAdd, db: Session = Depends(get_db)):
    if not db.query(LinkList).filter(LinkList.id == list_id).first():
        raise HTTPException(404, "List not found.")
    added = 0
    for url in data.urls:
        url = url.strip()
        if url:
            db.add(Download(list_id=list_id, source_url=url, status="pending"))
            added += 1
    db.commit()
    return {"added": added}


# ── Downloads ─────────────────────────────────────────────────────────────────

async def _resolve_and_start(dl_id: int, base_path: str, list_name: str) -> None:
    """
    Background task:
      1. Resolve fuckingfast.co → direct download URL   (sync HTTP in thread)
      2. Persist resolved URL + filename to DB
      3. Enqueue in aria2c

    The on_update callback receives a progress DICT from the aria2 poll loop:
      { id, gid, filename, status, bytes_downloaded, total_bytes,
        progress, speed, connections, error }
    """
    db = SessionLocal()
    try:
        dl = db.query(Download).filter(Download.id == dl_id).first()
        if not dl:
            return

        dl.status = "queued"
        db.commit()

        try:
            actual_url: str = await asyncio.to_thread(
                resolve_fuckingfast_download, dl.source_url
            )
        except Exception as exc:
            dl.status = "failed"
            dl.error_message = str(exc)
            db.commit()
            return

        filename  = actual_url.split("/")[-1].split("?")[0] or f"file_{dl_id}"
        safe_name = "".join(c if c.isalnum() or c in " _-" else "_" for c in list_name)
        output_path = os.path.join(base_path, safe_name, filename)

        dl.resolved_url = actual_url
        dl.filename     = filename
        db.commit()
    finally:
        db.close()

    # DB sync callback — runs on every poll tick (~1 s) for this download
    async def on_update(progress: dict) -> None:
        def _write():
            db2 = SessionLocal()
            try:
                d = db2.query(Download).filter(Download.id == dl_id).first()
                if d:
                    d.status           = progress["status"]
                    d.bytes_downloaded = progress["bytes_downloaded"]
                    d.total_bytes      = progress["total_bytes"]
                    if progress.get("filename"):
                        d.filename = progress["filename"]
                    if progress["status"] == "completed":
                        d.completed_at = datetime.utcnow()
                    if progress.get("error"):
                        d.error_message = progress["error"]
                    db2.commit()
            finally:
                db2.close()

        await asyncio.to_thread(_write)

    await dm.enqueue(dl_id, actual_url, output_path, on_update)


@app.post("/api/downloads/{dl_id}/start")
async def api_start(dl_id: int, db: Session = Depends(get_db)):
    dl = db.query(Download).filter(Download.id == dl_id).first()
    if not dl:
        raise HTTPException(404, "Download not found.")
    if dl.status in ("downloading", "queued"):
        raise HTTPException(400, "Already running.")
    if not dm.is_running:
        raise HTTPException(503, "aria2c is not running. See server logs.")

    s = {row.key: row.value for row in db.query(Setting).all()}
    base_path = s.get("download_path", "downloads")
    list_name = dl.link_list.name if dl.link_list else "default"

    asyncio.create_task(_resolve_and_start(dl_id, base_path, list_name))
    return {"status": "queued"}


@app.post("/api/downloads/{dl_id}/pause")
def api_pause(dl_id: int):
    dm.pause(dl_id)
    return {"status": "paused"}


@app.post("/api/downloads/{dl_id}/resume")
def api_resume(dl_id: int):
    dm.resume(dl_id)
    return {"status": "resumed"}


@app.post("/api/downloads/{dl_id}/stop")
def api_stop(dl_id: int, db: Session = Depends(get_db)):
    dm.stop(dl_id)
    dl = db.query(Download).filter(Download.id == dl_id).first()
    if dl:
        dl.status = "pending"
        db.commit()
    return {"status": "stopped"}


@app.delete("/api/downloads/{dl_id}")
def api_delete_download(dl_id: int, db: Session = Depends(get_db)):
    dl = db.query(Download).filter(Download.id == dl_id).first()
    if not dl:
        raise HTTPException(404, "Download not found.")
    dm.stop(dl_id)
    db.delete(dl)
    db.commit()
    return {"status": "deleted"}


# ── Settings ──────────────────────────────────────────────────────────────────

@app.get("/api/settings")
def api_get_settings(db: Session = Depends(get_db)):
    return {s.key: s.value for s in db.query(Setting).all()}


@app.put("/api/settings")
async def api_update_settings(data: dict = Body(...), db: Session = Depends(get_db)):
    for key, value in data.items():
        s = db.query(Setting).filter(Setting.key == key).first()
        if s:
            s.value = str(value)
        else:
            db.add(Setting(key=key, value=str(value)))
    db.commit()

    if "max_concurrent" in data:
        dm.set_max_concurrent(int(data["max_concurrent"]))
    if "connections_per_file" in data:
        dm.set_connections_per_file(int(data["connections_per_file"]))

    return {"status": "updated"}


# ── Scraper ───────────────────────────────────────────────────────────────────

@app.post("/api/scrape/links")
def api_scrape_links(data: ScrapeRequest, db: Session = Depends(get_db)):
    if not db.query(LinkList).filter(LinkList.id == data.list_id).first():
        raise HTTPException(404, "List not found.")
    try:
        links = get_fuckingfast_links(data.game_url)
    except Exception as exc:
        raise HTTPException(400, str(exc))
    for url in links:
        db.add(Download(list_id=data.list_id, source_url=url, status="pending"))
    db.commit()
    return {"found": len(links), "added": len(links), "links": links}


@app.get("/api/scrape/search")
async def api_scrape_search(query: str = "", page: int = 1):
    try:
        games = await asyncio.to_thread(search_fitgirl, query, page)
        return {"games": games}
    except Exception as exc:
        raise HTTPException(400, str(exc))


# ── aria2c global status ──────────────────────────────────────────────────────

@app.get("/api/status")
async def api_status():
    return await dm.global_stats()


# ── WebSocket: live progress ───────────────────────────────────────────────────

_ws_clients: list = []


@app.websocket("/ws/progress")
async def ws_progress(ws: WebSocket):
    await ws.accept()
    _ws_clients.append(ws)
    try:
        while True:
            payload = {
                "type":     "progress",
                "data":     dm.all_progress(),
                "aria2_ok": dm.is_running,
            }
            await ws.send_json(payload)
            await asyncio.sleep(1)
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        if ws in _ws_clients:
            _ws_clients.remove(ws)


# ── Serve frontend ─────────────────────────────────────────────────────────────

@app.get("/")
async def serve_frontend():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))
