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
from email.utils import formatdate
from time import monotonic
from typing import List, Optional
from ipaddress import ip_address, ip_network
from socket import getaddrinfo
from urllib.parse import urlparse

import requests
from fastapi import Body, Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.orm import selectinload

from database import Download, LinkList, SessionLocal, Setting, get_db, init_db
from downloader import dm
from scraper import (
    clean_filename,
    get_fuckingfast_downloads,
    get_fuckingfast_links,
    resolve_fuckingfast_download_info,
    search_fitgirl,
)

logger = logging.getLogger(__name__)

FRONTEND_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "frontend")
)
MAX_IMAGE_BYTES = 8 * 1024 * 1024
PROGRESS_DB_WRITE_INTERVAL = 5.0
START_RESOLVE_CONCURRENCY = 4
FITGIRL_HOSTS = {"fitgirl-repacks.site", "www.fitgirl-repacks.site"}
FUCKINGFAST_HOSTS = {"fuckingfast.co", "www.fuckingfast.co"}

ALLOWED_SETTINGS = {
    "download_path",
    "max_concurrent",
    "connections_per_file",
    "auto_start_new_games",
    "browse_items_per_page",
    "browse_card_size",
    "browse_show_descriptions",
    "browse_open_links_new_tab",
    "library_card_size",
    "library_default_detail",
    "library_show_file_urls",
    "confirm_delete",
    "interface_scale",
    "theme_density",
    "reduce_motion",
}
INT_SETTING_RANGES = {
    "max_concurrent": (1, 32),
    "connections_per_file": (1, 16),
    "browse_items_per_page": (6, 60),
    "interface_scale": (85, 125),
}
CHOICE_SETTINGS = {
    "browse_card_size": {"compact", "medium", "large"},
    "library_card_size": {"compact", "medium", "large"},
    "theme_density": {"compact", "comfortable", "spacious"},
}
BOOL_SETTINGS = {
    "auto_start_new_games",
    "browse_show_descriptions",
    "browse_open_links_new_tab",
    "library_default_detail",
    "library_show_file_urls",
    "confirm_delete",
    "reduce_motion",
}
_starting_downloads: set[int] = set()
_cancelled_starts: set[int] = set()
_starting_lock = asyncio.Lock()
_resolve_semaphore = asyncio.Semaphore(START_RESOLVE_CONCURRENCY)
_settings_cache: dict[str, str] = {}


# ── Static file helper ─────────────────────────────────────────────────────────

def _read_file(path: str, media_type: str, cache_seconds: int = 0) -> Response:
    """Synchronously read and serve a static file (runs in FastAPI's thread pool)."""
    try:
        stat = os.stat(path)
        with open(path, encoding="utf-8") as f:
            headers = {
                "Cache-Control": (
                    f"public, max-age={cache_seconds}"
                    if cache_seconds > 0 else
                    "no-cache"
                ),
                "ETag": f'W/"{int(stat.st_mtime)}-{stat.st_size}"',
                "Last-Modified": formatdate(stat.st_mtime, usegmt=True),
            }
            return Response(content=f.read(), media_type=media_type, headers=headers)
    except FileNotFoundError:
        raise HTTPException(404, "File not found")


# ── Lifespan ───────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _settings_cache
    init_db()
    db = SessionLocal()
    try:
        s = {row.key: row.value for row in db.query(Setting).all()}
        _settings_cache = dict(s)
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
    image_url: Optional[str] = None
    description: Optional[str] = None
    size: Optional[str] = None
    categories: Optional[List[str]] = None

class DownloadBatch(BaseModel):
    ids: List[int]


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
    return _read_file(os.path.join(FRONTEND_DIR, "css", "style.css"), "text/css", 3600)

@app.get("/js/{filename}")
def serve_js(filename: str):
    if not _re.match(r'^[\w-]+\.js$', filename):
        raise HTTPException(404)
    return _read_file(os.path.join(FRONTEND_DIR, "js", filename), "application/javascript", 3600)

@app.get("/favicon.svg")
def serve_favicon():
    return _read_file(os.path.join(FRONTEND_DIR, "favicon.svg"), "image/svg+xml", 86400)


PRIVATE_NETS = tuple(
    ip_network(net)
    for net in (
        "127.0.0.0/8",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
    )
)


def _is_private_address(value: str) -> bool:
    try:
        addr = ip_address(value)
    except ValueError:
        return True
    return any(addr in net for net in PRIVATE_NETS)


def _is_public_image_url(raw_url: str) -> bool:
    parsed = urlparse(raw_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False
    try:
        addresses = [ip_address(info[4][0]) for info in getaddrinfo(parsed.hostname, None)]
    except OSError:
        return False
    return not any(any(addr in net for net in PRIVATE_NETS) for addr in addresses)


def _is_public_http_url(raw_url: str, allowed_hosts: Optional[set[str]] = None) -> bool:
    parsed = urlparse((raw_url or "").strip())
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in {"http", "https"} or not host:
        return False
    if allowed_hosts is not None and host not in allowed_hosts:
        return False
    try:
        addresses = [ip_address(info[4][0]) for info in getaddrinfo(host, None)]
    except OSError:
        return False
    return not any(any(addr in net for net in PRIVATE_NETS) for addr in addresses)


def _clean_url(raw_url: str, allowed_hosts: Optional[set[str]] = None, label: str = "URL") -> str:
    url = (raw_url or "").strip()
    if not _is_public_http_url(url, allowed_hosts):
        raise HTTPException(400, f"Unsupported {label}.")
    return url


def _clean_download_path(raw_path: str) -> str:
    text = str(raw_path or "").strip().replace("\x00", "")
    if not text:
        raise HTTPException(400, "download_path cannot be empty.")
    if len(text) > 500:
        raise HTTPException(400, "download_path is too long.")
    return os.path.abspath(os.path.expanduser(text))


def _response_peer_is_public(resp: requests.Response) -> bool:
    try:
        conn = getattr(resp.raw, "_connection", None)
        sock = getattr(conn, "sock", None) if conn else None
        if not sock:
            sock = getattr(
                getattr(getattr(resp.raw, "_fp", None), "fp", None),
                "raw",
                None,
            )
            sock = getattr(sock, "_sock", None)
        if not sock:
            return False
        return not _is_private_address(sock.getpeername()[0])
    except OSError:
        return False


def _read_limited_content(resp: requests.Response) -> bytes:
    chunks: list[bytes] = []
    total = 0
    for chunk in resp.iter_content(chunk_size=64 * 1024):
        if not chunk:
            continue
        total += len(chunk)
        if total > MAX_IMAGE_BYTES:
            raise HTTPException(413, "Image is too large.")
        chunks.append(chunk)
    return b"".join(chunks)


@app.get("/api/image")
def api_proxy_image(url: str):
    """Proxy public thumbnails so Browse cards do not break on hotlink/referrer rules."""
    if not _is_public_image_url(url):
        raise HTTPException(400, "Unsupported image URL.")
    try:
        resp = requests.get(
            url,
            headers={
                "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                "referer": "https://fitgirl-repacks.site/",
                "user-agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/131.0.0.0 Safari/537.36"
                ),
            },
            allow_redirects=False,
            stream=True,
            timeout=10,
        )
        with resp:
            if 300 <= resp.status_code < 400:
                raise HTTPException(400, "Image redirects are not proxied.")
            if not _response_peer_is_public(resp):
                raise HTTPException(400, "Image host resolved to a private address.")
            resp.raise_for_status()
            media_type = resp.headers.get("content-type", "image/jpeg").split(";", 1)[0]
            if not media_type.startswith("image/"):
                raise HTTPException(400, "URL did not return an image.")
            return Response(
                content=_read_limited_content(resp),
                media_type=media_type,
                headers={"Cache-Control": "public, max-age=86400"},
            )
    except requests.RequestException as exc:
        raise HTTPException(502, f"Could not fetch image: {exc}")

# ── Lists ──────────────────────────────────────────────────────────────────────

def _download_to_dict(d: Download) -> dict:
    live     = dm.get_progress(d.id) or {}
    bytes_dl = live.get("bytes_downloaded", d.bytes_downloaded)
    total    = live.get("total_bytes", d.total_bytes)
    status   = live.get("status") or d.status
    return {
        "id":               d.id,
        "url":              d.source_url,
        "filename":         clean_filename(d.filename) or clean_filename(live.get("filename")) or d.filename or live.get("filename") or "",
        "status":           status,
        "bytes_downloaded": bytes_dl,
        "total_bytes":      total,
        "progress":         live.get("progress", (bytes_dl / total * 100) if total else 0),
        "speed":            live.get("speed", 0),
        "connections":      live.get("connections", 0),
        "gid":              live.get("gid", ""),
        "error_message":    live.get("error") or (d.error_message if status == "failed" else "") or "",
    }


def _list_to_dict(lst: LinkList, include_downloads: bool = False) -> dict:
    dls = lst.downloads
    total_bytes = sum(d.total_bytes or 0 for d in dls)
    dl_bytes    = sum(d.bytes_downloaded or 0 for d in dls)
    completed   = sum(1 for d in dls if d.status == "completed")
    data = {
        "id":               lst.id,
        "name":             lst.name,
        "source_url":       lst.source_url or "",
        "image_url":        lst.image_url or "",
        "description":      lst.description or "",
        "size":             lst.size or "",
        "categories":       [c for c in (lst.categories or "").split("|") if c],
        "created_at":       lst.created_at.isoformat() if lst.created_at else None,
        "count":            len(dls),
        "completed":        completed,
        "dl_ids":           [d.id for d in dls],
        "total_bytes":      total_bytes,
        "bytes_downloaded": dl_bytes,
    }
    if include_downloads:
        data["downloads"] = [_download_to_dict(d) for d in dls]
    return data


@app.get("/api/lists")
def api_get_lists(db: Session = Depends(get_db)):
    lists = (
        db.query(LinkList)
        .options(selectinload(LinkList.downloads))
        .order_by(LinkList.created_at.desc())
        .all()
    )
    return [_list_to_dict(lst) for lst in lists]


@app.get("/api/library")
def api_get_library(db: Session = Depends(get_db)):
    lists = (
        db.query(LinkList)
        .options(selectinload(LinkList.downloads))
        .order_by(LinkList.created_at.desc())
        .all()
    )
    return {"lists": [_list_to_dict(lst, include_downloads=True) for lst in lists]}


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
        await _cancel_starting_download(dl.id)
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
    return [_download_to_dict(d) for d in dls]


@app.post("/api/lists/{list_id}/links")
def api_add_links(list_id: int, data: LinksAdd, db: Session = Depends(get_db)):
    if not db.query(LinkList).filter(LinkList.id == list_id).first():
        raise HTTPException(404, "List not found.")
    existing = {
        url
        for (url,) in db.query(Download.source_url).filter(Download.list_id == list_id).all()
    }
    added = 0
    for url in data.urls:
        if not (url or "").strip():
            continue
        url = _clean_url(url, FUCKINGFAST_HOSTS, "download link")
        if url and url not in existing:
            db.add(Download(list_id=list_id, source_url=url, status="pending"))
            existing.add(url)
            added += 1
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "One or more links already exist.")
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
    game_url = _clean_url(data.game_url, FITGIRL_HOSTS, "FitGirl URL")

    # Get or create the list
    lst = db.query(LinkList).filter(LinkList.name == title).first()
    if not lst:
        lst = LinkList(name=title)
        db.add(lst)
        db.commit()
        db.refresh(lst)

    categories = [c.strip() for c in (data.categories or []) if c and c.strip()]
    if game_url and not lst.source_url:
        lst.source_url = game_url
    if data.image_url and not lst.image_url:
        lst.image_url = data.image_url.strip()
    if data.description and not lst.description:
        lst.description = data.description.strip()[:2000]
    if data.size and not lst.size:
        lst.size = _re.sub(r"^from\s+", "", data.size.strip(), flags=_re.I)[:80]
    if categories and not lst.categories:
        lst.categories = "|".join(categories[:12])

    # Scrape download links and keep FitGirl's human filenames when present.
    try:
        downloads = get_fuckingfast_downloads(game_url)
    except Exception as exc:
        raise HTTPException(400, str(exc))

    # Add new links, skip duplicates, and backfill missing filenames on old rows.
    existing_rows = {
        d.source_url: d
        for d in db.query(Download).filter(Download.list_id == lst.id).all()
    }
    added = 0
    for item in downloads:
        url = item["url"]
        filename = clean_filename(item.get("filename"))
        if existing := existing_rows.get(url):
            if filename and not existing.filename:
                existing.filename = filename
            continue
        db.add(Download(list_id=lst.id, source_url=_clean_url(url, FUCKINGFAST_HOSTS, "download link"), filename=filename or "", status="pending"))
        added += 1
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "One or more links already exist.")

    return {
        "id":          lst.id,
        "title":       title,
        "found":       len(downloads),
        "added":       added,
        "already_had": len(existing_rows),
    }


# ── Downloads ──────────────────────────────────────────────────────────────────

async def _release_starting_download(dl_id: int) -> None:
    async with _starting_lock:
        _starting_downloads.discard(dl_id)
        _cancelled_starts.discard(dl_id)


async def _cancel_starting_download(dl_id: int) -> None:
    async with _starting_lock:
        if dl_id in _starting_downloads:
            _cancelled_starts.add(dl_id)


async def _start_was_cancelled(dl_id: int) -> bool:
    async with _starting_lock:
        return dl_id in _cancelled_starts


async def _is_starting_download(dl_id: int) -> bool:
    async with _starting_lock:
        return dl_id in _starting_downloads


async def _mark_download_failed(dl_id: int, message: str) -> None:
    if await _start_was_cancelled(dl_id):
        return

    def _write() -> None:
        db = SessionLocal()
        try:
            dl = db.query(Download).filter(Download.id == dl_id).first()
            if dl:
                dl.status = "failed"
                dl.error_message = message[:500]
                db.commit()
        finally:
            db.close()
    await asyncio.to_thread(_write)


async def _resolve_and_start(dl_id: int, base_path: str, list_name: str) -> None:
    actual_url:  Optional[str] = None
    output_path: Optional[str] = None
    last_db_write = 0.0

    try:
        async with _resolve_semaphore:
            db = SessionLocal()
            try:
                dl = db.query(Download).filter(Download.id == dl_id).first()
                if not dl or dl.status != "queued" or await _start_was_cancelled(dl_id):
                    return

                try:
                    source_url = _clean_url(dl.source_url, FUCKINGFAST_HOSTS, "download link")
                    resolved = await asyncio.to_thread(
                        resolve_fuckingfast_download_info, source_url
                    )
                    if not _is_public_http_url(resolved.url):
                        raise ValueError("Resolved download URL is not public HTTP(S).")
                except Exception as exc:
                    if not await _start_was_cancelled(dl_id):
                        dl.status = "failed"
                        dl.error_message = str(exc)[:500]
                        db.commit()
                    return

                actual_url = resolved.url
                filename = (
                    clean_filename(dl.filename)
                    or clean_filename(resolved.filename)
                    or clean_filename(actual_url)
                    or f"file_{dl_id}"
                )
                safe_name = (
                    "".join(c if c.isalnum() or c in " _-" else "_" for c in list_name)
                    .strip(" _.") or "default"
                )
                output_path = os.path.join(base_path, safe_name, filename)

                if dl.status != "queued" or await _start_was_cancelled(dl_id):
                    return
                dl.resolved_url = actual_url
                dl.filename = filename
                try:
                    db.commit()
                except Exception as exc:
                    logger.error("Failed to persist resolved dl_id=%s: %s", dl_id, exc)
                    return
            finally:
                db.close()

        if actual_url is None or output_path is None:
            return

        async def on_update(snap: dict) -> None:
            nonlocal last_db_write
            now = monotonic()
            status = snap.get("status")
            should_write = (
                status in {"completed", "failed", "paused"}
                or now - last_db_write >= PROGRESS_DB_WRITE_INTERVAL
            )
            if not should_write:
                return
            last_db_write = now

            def _write() -> None:
                db2 = SessionLocal()
                try:
                    d = db2.query(Download).filter(Download.id == dl_id).first()
                    if not d:
                        return
                    d.status = snap["status"]
                    d.bytes_downloaded = snap["bytes_downloaded"]
                    d.total_bytes = snap["total_bytes"]
                    if snap_name := clean_filename(snap.get("filename")):
                        d.filename = snap_name
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
            if await _start_was_cancelled(dl_id):
                return
            await dm.enqueue(dl_id, actual_url, output_path, on_update)
        except Exception as exc:
            await _mark_download_failed(dl_id, str(exc))
    except Exception as exc:
        logger.exception("Unexpected start task failure for dl_id=%s", dl_id)
        await _mark_download_failed(dl_id, str(exc))
    finally:
        await _release_starting_download(dl_id)


async def _queue_download_start(
    dl: Download,
    db: Session,
    base_path: str,
    allow_paused: bool = False,
) -> str:
    if not dm.is_running:
        raise HTTPException(503, "aria2c is not running. See server logs.")

    async with _starting_lock:
        live = dm.get_progress(dl.id)
        effective_status = (live.get("status") if live else None) or dl.status
        if dl.id in _starting_downloads or effective_status in ("downloading", "queued"):
            return "already_running"
        if effective_status == "completed":
            return "completed"
        if effective_status == "paused" and not allow_paused:
            return "paused"
        if effective_status not in {"pending", "failed", "paused"}:
            return "skipped"
        dl.status = "queued"
        dl.error_message = None
        db.commit()
        _cancelled_starts.discard(dl.id)
        _starting_downloads.add(dl.id)

    list_name = dl.link_list.name if dl.link_list else "default"
    asyncio.create_task(_resolve_and_start(dl.id, base_path, list_name))
    return "queued"


@app.post("/api/downloads/{dl_id}/start")
async def api_start(dl_id: int, db: Session = Depends(get_db)):
    dl = db.query(Download).filter(Download.id == dl_id).first()
    if not dl:
        raise HTTPException(404, "Download not found.")
    base_path = _clean_download_path(_settings_snapshot(db).get("download_path", "downloads"))
    status = await _queue_download_start(dl, db, base_path)
    if status == "queued":
        return {"status": "queued"}
    if status == "already_running":
        raise HTTPException(400, "Already running.")
    if status == "paused":
        raise HTTPException(400, "Use resume for paused downloads.")
    if status == "completed":
        raise HTTPException(400, "Download is already completed.")
    raise HTTPException(400, "Download cannot be started.")
    return {"status": "queued"}


@app.post("/api/downloads/{dl_id}/pause")
async def api_pause(dl_id: int, db: Session = Depends(get_db)):
    dl = db.query(Download).filter(Download.id == dl_id).first()
    if not dl:
        raise HTTPException(404, "Download not found.")
    live = dm.get_progress(dl_id)
    effective_status = (live.get("status") if live else None) or dl.status
    if effective_status not in {"downloading", "queued"} and not await _is_starting_download(dl_id):
        raise HTTPException(400, "Download is not running.")
    await _cancel_starting_download(dl_id)
    await dm.pause(dl_id)
    dl.status = "paused"
    db.commit()
    return {"status": "paused"}


@app.post("/api/downloads/{dl_id}/resume")
async def api_resume(dl_id: int, db: Session = Depends(get_db)):
    dl = db.query(Download).filter(Download.id == dl_id).first()
    if not dl:
        raise HTTPException(404, "Download not found.")
    live = dm.get_progress(dl_id)
    if live and live.get("status") == "paused":
        await dm.resume(dl_id)
        dl.status = "downloading"
        db.commit()
        return {"status": "resumed"}
    base_path = _clean_download_path(_settings_snapshot(db).get("download_path", "downloads"))
    status = await _queue_download_start(dl, db, base_path, allow_paused=True)
    if status == "queued":
        return {"status": "queued"}
    if status == "already_running":
        return {"status": "already_running"}
    if status == "completed":
        raise HTTPException(400, "Download is already completed.")
    raise HTTPException(400, "Download cannot be resumed.")


@app.post("/api/downloads/batch/start")
async def api_batch_start(data: DownloadBatch, db: Session = Depends(get_db)):
    ids = list(dict.fromkeys(int(i) for i in data.ids if i))
    if not ids:
        return {"queued": 0, "skipped": 0}
    base_path = _clean_download_path(_settings_snapshot(db).get("download_path", "downloads"))
    rows = db.query(Download).filter(Download.id.in_(ids)).all()
    queued = 0
    skipped = 0
    for dl in rows:
        status = await _queue_download_start(dl, db, base_path)
        queued += 1 if status == "queued" else 0
        skipped += 0 if status == "queued" else 1
    return {"queued": queued, "skipped": skipped, "requested": len(ids)}


@app.post("/api/downloads/batch/resume")
async def api_batch_resume(data: DownloadBatch, db: Session = Depends(get_db)):
    ids = list(dict.fromkeys(int(i) for i in data.ids if i))
    if not ids:
        return {"resumed": 0, "queued": 0, "skipped": 0}
    base_path = _clean_download_path(_settings_snapshot(db).get("download_path", "downloads"))
    rows = db.query(Download).filter(Download.id.in_(ids)).all()
    resumed = 0
    queued = 0
    skipped = 0
    for dl in rows:
        live = dm.get_progress(dl.id)
        if live and live.get("status") == "paused":
            await dm.resume(dl.id)
            dl.status = "downloading"
            resumed += 1
            continue
        status = await _queue_download_start(dl, db, base_path, allow_paused=True)
        queued += 1 if status == "queued" else 0
        skipped += 0 if status == "queued" else 1
    db.commit()
    return {"resumed": resumed, "queued": queued, "skipped": skipped, "requested": len(ids)}


@app.post("/api/downloads/batch/pause")
async def api_batch_pause(data: DownloadBatch, db: Session = Depends(get_db)):
    ids = list(dict.fromkeys(int(i) for i in data.ids if i))
    rows = db.query(Download).filter(Download.id.in_(ids)).all() if ids else []
    paused = 0
    for dl in rows:
        live = dm.get_progress(dl.id)
        effective_status = (live.get("status") if live else None) or dl.status
        if effective_status not in {"downloading", "queued"} and not await _is_starting_download(dl.id):
            continue
        await _cancel_starting_download(dl.id)
        await dm.pause(dl.id)
        dl.status = "paused"
        paused += 1
    db.commit()
    return {"paused": paused, "requested": len(ids)}


@app.post("/api/downloads/{dl_id}/stop")
async def api_stop(dl_id: int, db: Session = Depends(get_db)):
    await _cancel_starting_download(dl_id)
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
    await _cancel_starting_download(dl_id)
    await dm.stop(dl_id)
    db.delete(dl)
    db.commit()
    return {"status": "deleted"}


# ── Settings ───────────────────────────────────────────────────────────────────

@app.get("/api/settings")
def api_get_settings(db: Session = Depends(get_db)):
    return _settings_snapshot(db)


def _normalize_bool_setting(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return "true"
    if text in {"0", "false", "no", "off"}:
        return "false"
    raise ValueError("expected boolean")


def _normalize_settings(data: dict) -> dict[str, str]:
    if not isinstance(data, dict):
        raise HTTPException(400, "Settings payload must be an object.")
    unknown = sorted(set(data) - ALLOWED_SETTINGS)
    if unknown:
        raise HTTPException(400, f"Unsupported setting(s): {', '.join(unknown)}")

    normalized: dict[str, str] = {}
    for key, value in data.items():
        if key in INT_SETTING_RANGES:
            try:
                number = int(value)
            except (TypeError, ValueError):
                raise HTTPException(400, f"{key} must be an integer.")
            low, high = INT_SETTING_RANGES[key]
            if not low <= number <= high:
                raise HTTPException(400, f"{key} must be between {low} and {high}.")
            normalized[key] = str(number)
            continue

        if key in BOOL_SETTINGS:
            try:
                normalized[key] = _normalize_bool_setting(value)
            except ValueError:
                raise HTTPException(400, f"{key} must be a boolean.")
            continue

        if key in CHOICE_SETTINGS:
            text = str(value).strip()
            if text not in CHOICE_SETTINGS[key]:
                allowed = ", ".join(sorted(CHOICE_SETTINGS[key]))
                raise HTTPException(400, f"{key} must be one of: {allowed}.")
            normalized[key] = text
            continue

        text = str(value).strip()
        if key == "download_path":
            text = _clean_download_path(text)
        normalized[key] = text

    return normalized


def _settings_snapshot(db: Optional[Session] = None) -> dict[str, str]:
    if _settings_cache:
        return dict(_settings_cache)
    if db is None:
        db = SessionLocal()
        try:
            return {row.key: row.value for row in db.query(Setting).all()}
        finally:
            db.close()
    return {row.key: row.value for row in db.query(Setting).all()}


@app.put("/api/settings")
async def api_update_settings(data: dict = Body(...), db: Session = Depends(get_db)):
    global _settings_cache
    normalized = _normalize_settings(data)
    for key, value in normalized.items():
        s = db.query(Setting).filter(Setting.key == key).first()
        if s:
            s.value = value
        else:
            db.add(Setting(key=key, value=value))
    db.commit()
    _settings_cache = {**_settings_snapshot(db), **normalized}

    if "max_concurrent" in normalized:
        await dm.set_max_concurrent(int(normalized["max_concurrent"]))

    if "connections_per_file" in normalized:
        dm.set_connections_per_file(int(normalized["connections_per_file"]))

    return {"status": "updated"}


# ── Scraper ────────────────────────────────────────────────────────────────────

@app.post("/api/scrape/links")
def api_scrape_links(data: ScrapeRequest, db: Session = Depends(get_db)):
    if not db.query(LinkList).filter(LinkList.id == data.list_id).first():
        raise HTTPException(404, "List not found.")
    game_url = _clean_url(data.game_url, FITGIRL_HOSTS, "FitGirl URL")
    try:
        links = get_fuckingfast_links(game_url)
    except Exception as exc:
        raise HTTPException(400, str(exc))
    existing = {
        url
        for (url,) in db.query(Download.source_url).filter(Download.list_id == data.list_id).all()
    }
    added = 0
    for url in links:
        url = _clean_url(url, FUCKINGFAST_HOSTS, "download link")
        if url not in existing:
            db.add(Download(list_id=data.list_id, source_url=url, status="pending"))
            existing.add(url)
            added += 1
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "One or more links already exist.")
    return {"found": len(links), "added": added, "links": links}


@app.get("/api/scrape/search")
async def api_scrape_search(query: str = "", page: int = 1, limit: int = 24):
    try:
        limit = max(1, min(int(limit or 24), 60))
        games = await asyncio.to_thread(search_fitgirl, query, page, limit)
        return {
            "games": games,
            "page": max(1, int(page or 1)),
            "limit": limit,
            "source": "search" if query.strip() else "popular-year",
        }
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
