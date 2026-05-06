"""
FastAPI backend for EasyDL.

Changes vs original:
  - Multi-page frontend: /library, /browse, /settings served as separate HTML files
  - Static file routes: /css/style.css, /js/{filename} served without extra deps
  - POST /api/games: auto-creates a list named after the game and scrapes its links
  - GET /api/lists: now returns dl_ids + aggregate bytes/completed counts
  - All original bug fixes retained (async dm calls, lifespan, timezone, etc.)
"""

import asyncio
import logging
import os
import re as _re
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import Body, Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import Download, LinkList, SessionLocal, Setting, get_db, init_db
from downloader import dm
from scraper import get_fuckingfast_links, resolve_fuckingfast_download, search_fitgirl

logger = logging.getLogger(__name__)

FRONTEND_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "frontend")
)


# ── Static file helper ─────────────────────────────────────────────────────────

def _read_file(path: str, media_type: str) -> Response:
    """Synchronously read and serve a static file (runs in FastAPI's thread pool)."""
    try:
        with open(path, encoding="utf-8") as f:
            return Response(content=f.read(), media_type=media_type)
    except FileNotFoundError:
        raise HTTPException(404, "File not found")


# ── Lifespan ───────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
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

    yield

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

class GameAdd(BaseModel):
    """Used by the Browse page: create a game list and scrape its links in one shot."""
    title: str
    game_url: str


# ── Page routes ────────────────────────────────────────────────────────────────

@app.get("/")
def serve_root():
    return _read_file(os.path.join(FRONTEND_DIR, "library.html"), "text/html")

@app.get("/library")
def serve_library_page():
    return _read_file(os.path.join(FRONTEND_DIR, "library.html"), "text/html")

@app.get("/browse")
def serve_browse_page():
    return _read_file(os.path.join(FRONTEND_DIR, "browse.html"), "text/html")

@app.get("/settings")
def serve_settings_page():
    return _read_file(os.path.join(FRONTEND_DIR, "settings.html"), "text/html")


# ── Static asset routes ────────────────────────────────────────────────────────

@app.get("/css/style.css")
def serve_css():
    return _read_file(os.path.join(FRONTEND_DIR, "css", "style.css"), "text/css")

@app.get("/js/{filename}")
def serve_js(filename: str):
    if not _re.match(r'^[\w-]+\.js$', filename):
        raise HTTPException(404)
    return _read_file(os.path.join(FRONTEND_DIR, "js", filename), "application/javascript")


# ── Lists ──────────────────────────────────────────────────────────────────────

@app.get("/api/lists")
def api_get_lists(db: Session = Depends(get_db)):
    result = []
    for lst in db.query(LinkList).order_by(LinkList.created_at.desc()).all():
        dls = lst.downloads
        total_bytes = sum(d.total_bytes or 0 for d in dls)
        dl_bytes    = sum(d.bytes_downloaded or 0 for d in dls)
        completed   = sum(1 for d in dls if d.status == "completed")
        result.append({
            "id":               lst.id,
            "name":             lst.name,
            "created_at":       lst.created_at.isoformat() if lst.created_at else None,
            "count":            len(dls),
            "completed":        completed,
            "dl_ids":           [d.id for d in dls],
            "total_bytes":      total_bytes,
            "bytes_downloaded": dl_bytes,
        })
    return result


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
        result.append({
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
        })
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


# ── Games (Browse → Library) ───────────────────────────────────────────────────

@app.post("/api/games", status_code=201)
def api_add_game(data: GameAdd, db: Session = Depends(get_db)):
    """
    One-shot: create (or retrieve) a list named after the game, then scrape
    all fuckingfast.co links from the game page and add them as pending downloads.
    Called by the Browse page when the user clicks "Add to Library".
    """
    title = data.title.strip()[:200]
    if not title:
        raise HTTPException(400, "Title is required.")

    # Get or create the list
    lst = db.query(LinkList).filter(LinkList.name == title).first()
    if not lst:
        lst = LinkList(name=title)
        db.add(lst)
        db.commit()
        db.refresh(lst)

    # Scrape download links
    try:
        links = get_fuckingfast_links(data.game_url)
    except Exception as exc:
        raise HTTPException(400, str(exc))

    # Add new links, skip duplicates
    existing = {d.source_url for d in db.query(Download).filter(Download.list_id == lst.id).all()}
    new_links = [u for u in links if u not in existing]
    for url in new_links:
        db.add(Download(list_id=lst.id, source_url=url, status="pending"))
    db.commit()

    return {
        "id":          lst.id,
        "title":       title,
        "found":       len(links),
        "added":       len(new_links),
        "already_had": len(existing),
    }


# ── Downloads ──────────────────────────────────────────────────────────────────

async def _resolve_and_start(dl_id: int, base_path: str, list_name: str) -> None:
    actual_url:  Optional[str] = None
    output_path: Optional[str] = None

    db = SessionLocal()
    try:
        dl = db.query(Download).filter(Download.id == dl_id).first()
        if not dl:
            return
        dl.status = "queued"
        db.commit()

        try:
            actual_url = await asyncio.to_thread(
                resolve_fuckingfast_download, dl.source_url
            )
        except Exception as exc:
            dl.status = "failed"
            dl.error_message = str(exc)[:500]
            db.commit()
            return

        filename  = actual_url.split("/")[-1].split("?")[0] or f"file_{dl_id}"
        safe_name = (
            "".join(c if c.isalnum() or c in " _-" else "_" for c in list_name)
            .strip("_") or "default"
        )
        output_path = os.path.join(base_path, safe_name, filename)

        dl.resolved_url = actual_url
        dl.filename     = filename
        try:
            db.commit()
        except Exception:
            return
    finally:
        db.close()

    if actual_url is None or output_path is None:
        return

    async def on_update(snap: dict) -> None:
        def _write() -> None:
            db2 = SessionLocal()
            try:
                d = db2.query(Download).filter(Download.id == dl_id).first()
                if not d:
                    return
                d.status           = snap["status"]
                d.bytes_downloaded = snap["bytes_downloaded"]
                d.total_bytes      = snap["total_bytes"]
                if snap.get("filename"):
                    d.filename = snap["filename"]
                if snap["status"] == "completed":
                    d.completed_at = datetime.now(timezone.utc)
                if snap.get("error"):
                    d.error_message = snap["error"][:500]
                db2.commit()
            except Exception as exc:
                logger.error("on_update DB write failed for dl_id=%s: %s", dl_id, exc)
            finally:
                db2.close()
        await asyncio.to_thread(_write)

    try:
        await dm.enqueue(dl_id, actual_url, output_path, on_update)
    except Exception as exc:
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
    await dm.pause(dl_id)
    return {"status": "paused"}


@app.post("/api/downloads/{dl_id}/resume")
async def api_resume(dl_id: int):
    await dm.resume(dl_id)
    return {"status": "resumed"}


@app.post("/api/downloads/{dl_id}/stop")
async def api_stop(dl_id: int, db: Session = Depends(get_db)):
    await dm.stop(dl_id)
    dl = db.query(Download).filter(Download.id == dl_id).first()
    if dl:
        dl.status = "pending"
        db.commit()
    return {"status": "stopped"}


@app.delete("/api/downloads/{dl_id}")
async def api_delete_download(dl_id: int, db: Session = Depends(get_db)):
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


# ── WebSocket ──────────────────────────────────────────────────────────────────

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
        logger.debug("WebSocket closed: %s", exc)