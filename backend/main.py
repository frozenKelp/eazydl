"""
FastAPI backend for EasyDL.

Bugs fixed vs. original:
  - @app.on_event("startup"/"shutdown") deprecated since FastAPI 0.93.
    Replaced with a proper lifespan context manager.
  - api_pause / api_resume / api_stop / api_delete_list / api_delete_download
    all called dm methods synchronously from async def endpoints.  Those dm
    methods are now async (downloader.py fix); endpoints now await them.
  - api_update_settings called dm.set_max_concurrent() (now async) without
    await — would have blocked the event loop.
  - _resolve_and_start: actual_url / output_path could be UnboundLocalError
    if db.commit() threw between the two commits.  Initialised to None and
    guarded before use.
  - _resolve_and_start: error_message truncated to 500 chars to avoid
    storing unbounded strings in SQLite.
  - api_start now cross-checks the live aria2c cache status (not only the
    DB value) to prevent double-start races.
  - datetime.utcnow() replaced with datetime.now(timezone.utc) throughout.
  - Missing logging import added.
  - on_update DB write now also truncates error messages.
"""

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import Body, Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import Download, LinkList, SessionLocal, Setting, get_db, init_db
from downloader import dm
from scraper import get_fuckingfast_links, resolve_fuckingfast_download, search_fitgirl

logger = logging.getLogger(__name__)

FRONTEND_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "frontend")
)


# ── Lifespan ───────────────────────────────────────────────────────────────────
# BUG FIX: @app.on_event is deprecated; use lifespan context manager instead.

@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── startup ──
    init_db()

    db = SessionLocal()
    try:
        s = {row.key: row.value for row in db.query(Setting).all()}
    finally:
        db.close()

    max_concurrent       = int(s.get("max_concurrent", 3))
    connections_per_file = int(s.get("connections_per_file", 4))

    try:
        await dm.start(
            max_concurrent=max_concurrent,
            connections_per_file=connections_per_file,
        )
        logger.info("✓ aria2c connected and ready.")
    except RuntimeError as exc:
        logger.warning("⚠  aria2c unavailable: %s", exc)

    yield  # ← app runs here

    # ── shutdown ──
    await dm.shutdown()
    logger.info("aria2c shut down cleanly.")


app = FastAPI(title="EasyDL", lifespan=lifespan)


# ── Pydantic models ────────────────────────────────────────────────────────────

class ListCreate(BaseModel):
    name: str


class LinksAdd(BaseModel):
    urls: List[str]


class ScrapeRequest(BaseModel):
    game_url: str
    list_id: int


# ── Lists ──────────────────────────────────────────────────────────────────────

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
    name = data.name.strip()
    if not name:
        raise HTTPException(400, "List name cannot be empty.")
    if db.query(LinkList).filter(LinkList.name == name).first():
        raise HTTPException(400, "A list with that name already exists.")
    lst = LinkList(name=name)
    db.add(lst)
    db.commit()
    db.refresh(lst)
    return {"id": lst.id, "name": lst.name}


@app.delete("/api/lists/{list_id}")
async def api_delete_list(list_id: int, db: Session = Depends(get_db)):
    # BUG FIX: was `def` — dm.stop() is now async, must be awaited.
    lst = db.query(LinkList).filter(LinkList.id == list_id).first()
    if not lst:
        raise HTTPException(404, "List not found.")
    for dl in lst.downloads:
        await dm.stop(dl.id)
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
        live     = dm.get_progress(d.id) or {}
        bytes_dl = live.get("bytes_downloaded", d.bytes_downloaded)
        total    = live.get("total_bytes", d.total_bytes)
        result.append(
            {
                "id":               d.id,
                "url":              d.source_url,
                "filename":         live.get("filename") or d.filename or "",
                "status":           live.get("status") or d.status,
                "bytes_downloaded": bytes_dl,
                "total_bytes":      total,
                "progress":         live.get("progress", (bytes_dl / total * 100) if total else 0),
                "speed":            live.get("speed", 0),
                "connections":      live.get("connections", 0),
                "gid":              live.get("gid", ""),
                "error_message":    d.error_message or live.get("error") or "",
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


# ── Downloads ──────────────────────────────────────────────────────────────────

async def _resolve_and_start(dl_id: int, base_path: str, list_name: str) -> None:
    """
    Background task:
      1. Resolve fuckingfast.co → direct CDN URL   (blocking HTTP in thread)
      2. Persist resolved URL + filename to DB
      3. Enqueue in aria2c

    Bugs fixed:
      - actual_url / output_path initialised to None to avoid UnboundLocalError
        if either db.commit() raises before they are assigned.
      - error_message capped at 500 chars.
      - dm.enqueue failure now also updates the DB status to 'failed'.
      - datetime.utcnow() → datetime.now(timezone.utc).
    """
    actual_url:  Optional[str] = None
    output_path: Optional[str] = None

    db = SessionLocal()
    try:
        dl = db.query(Download).filter(Download.id == dl_id).first()
        if not dl:
            logger.warning("_resolve_and_start: dl_id=%s not found in DB", dl_id)
            return

        dl.status = "queued"
        db.commit()

        try:
            actual_url = await asyncio.to_thread(
                resolve_fuckingfast_download, dl.source_url
            )
        except Exception as exc:
            logger.error("URL resolution failed for dl_id=%s: %s", dl_id, exc)
            dl.status = "failed"
            dl.error_message = str(exc)[:500]
            db.commit()
            return

        filename  = actual_url.split("/")[-1].split("?")[0] or f"file_{dl_id}"
        # Sanitise list name for use as a directory component
        safe_name = (
            "".join(c if c.isalnum() or c in " _-" else "_" for c in list_name)
            .strip("_") or "default"
        )
        output_path = os.path.join(base_path, safe_name, filename)

        dl.resolved_url = actual_url
        dl.filename     = filename
        try:
            db.commit()
        except Exception as exc:
            logger.error("DB commit failed for dl_id=%s: %s", dl_id, exc)
            return  # actual_url is set but output_path might not be — bail out

    finally:
        db.close()

    # Guard: if we returned early inside the try block, these may still be None
    if actual_url is None or output_path is None:
        return

    # DB-sync callback — runs on every poll tick (~1 s) for this download
    async def on_update(snap: dict) -> None:
        def _write() -> None:
            db2 = SessionLocal()
            try:
                d = db2.query(Download).filter(Download.id == dl_id).first()
                if not d:
                    return  # download was deleted while running — ignore
                d.status           = snap["status"]
                d.bytes_downloaded = snap["bytes_downloaded"]
                d.total_bytes      = snap["total_bytes"]
                if snap.get("filename"):
                    d.filename = snap["filename"]
                if snap["status"] == "completed":
                    d.completed_at = datetime.now(timezone.utc)  # BUG FIX: was utcnow()
                if snap.get("error"):
                    d.error_message = snap["error"][:500]        # BUG FIX: truncate
                db2.commit()
            except Exception as exc:
                logger.error("on_update DB write failed for dl_id=%s: %s", dl_id, exc)
            finally:
                db2.close()

        await asyncio.to_thread(_write)

    try:
        await dm.enqueue(dl_id, actual_url, output_path, on_update)
    except Exception as exc:
        logger.error("dm.enqueue failed for dl_id=%s: %s", dl_id, exc)
        # Update DB so the UI shows 'failed' rather than hanging on 'queued'
        def _mark_failed() -> None:
            db2 = SessionLocal()
            try:
                d = db2.query(Download).filter(Download.id == dl_id).first()
                if d:
                    d.status = "failed"
                    d.error_message = str(exc)[:500]
                    db2.commit()
            finally:
                db2.close()
        await asyncio.to_thread(_mark_failed)


@app.post("/api/downloads/{dl_id}/start")
async def api_start(dl_id: int, db: Session = Depends(get_db)):
    dl = db.query(Download).filter(Download.id == dl_id).first()
    if not dl:
        raise HTTPException(404, "Download not found.")

    # BUG FIX: check live aria2c cache status too, not only the (potentially
    # stale) DB value, to prevent a double-start race.
    live = dm.get_progress(dl_id)
    effective_status = (live.get("status") if live else None) or dl.status

    if effective_status in ("downloading", "queued"):
        raise HTTPException(400, "Already running.")
    if not dm.is_running:
        raise HTTPException(503, "aria2c is not running. See server logs.")

    s = {row.key: row.value for row in db.query(Setting).all()}
    base_path = s.get("download_path", "downloads")
    list_name = dl.link_list.name if dl.link_list else "default"

    asyncio.create_task(_resolve_and_start(dl_id, base_path, list_name))
    return {"status": "queued"}


@app.post("/api/downloads/{dl_id}/pause")
async def api_pause(dl_id: int):
    # BUG FIX: was `def` — dm.pause() is now async, must be awaited.
    await dm.pause(dl_id)
    return {"status": "paused"}


@app.post("/api/downloads/{dl_id}/resume")
async def api_resume(dl_id: int):
    # BUG FIX: was `def` — dm.resume() is now async, must be awaited.
    await dm.resume(dl_id)
    return {"status": "resumed"}


@app.post("/api/downloads/{dl_id}/stop")
async def api_stop(dl_id: int, db: Session = Depends(get_db)):
    # BUG FIX: was `def` — dm.stop() is now async, must be awaited.
    await dm.stop(dl_id)
    dl = db.query(Download).filter(Download.id == dl_id).first()
    if dl:
        dl.status = "pending"
        db.commit()
    return {"status": "stopped"}


@app.delete("/api/downloads/{dl_id}")
async def api_delete_download(dl_id: int, db: Session = Depends(get_db)):
    # BUG FIX: was `def` — dm.stop() is now async, must be awaited.
    dl = db.query(Download).filter(Download.id == dl_id).first()
    if not dl:
        raise HTTPException(404, "Download not found.")
    await dm.stop(dl_id)
    db.delete(dl)
    db.commit()
    return {"status": "deleted"}


# ── Settings ───────────────────────────────────────────────────────────────────

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

    # BUG FIX: dm.set_max_concurrent() is now async — must be awaited.
    # Also guard against non-integer values in the payload.
    if "max_concurrent" in data:
        try:
            await dm.set_max_concurrent(int(data["max_concurrent"]))
        except (ValueError, TypeError):
            pass

    if "connections_per_file" in data:
        try:
            dm.set_connections_per_file(int(data["connections_per_file"]))
        except (ValueError, TypeError):
            pass

    return {"status": "updated"}


# ── Scraper ────────────────────────────────────────────────────────────────────

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


# ── aria2c global status ───────────────────────────────────────────────────────

@app.get("/api/status")
async def api_status():
    return await dm.global_stats()


# ── WebSocket: live progress ───────────────────────────────────────────────────

@app.websocket("/ws/progress")
async def ws_progress(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            payload = {
                "type":     "progress",
                "data":     dm.all_progress(),
                "aria2_ok": dm.is_running,
            }
            await ws.send_json(payload)
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.debug("WebSocket closed with error: %s", exc)


# ── Serve frontend ─────────────────────────────────────────────────────────────

@app.get("/")
async def serve_frontend():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))
