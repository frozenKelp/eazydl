import asyncio
import logging
import os
from datetime import datetime, timezone
from time import monotonic

from fastapi import HTTPException
from sqlalchemy.orm import Session

from config import FUCKINGFAST_HOSTS, PROGRESS_DB_WRITE_INTERVAL, START_RESOLVE_CONCURRENCY
from database import Download, SessionLocal
from downloader import dm
from scraper import clean_filename, resolve_fuckingfast_download_info
from security import clean_url, is_public_http_url

logger = logging.getLogger(__name__)

_starting_downloads: set[int] = set()
_cancelled_starts: set[int] = set()
_starting_lock = asyncio.Lock()
_resolve_semaphore = asyncio.Semaphore(START_RESOLVE_CONCURRENCY)


async def release_starting_download(dl_id: int) -> None:
    async with _starting_lock:
        _starting_downloads.discard(dl_id)
        _cancelled_starts.discard(dl_id)


async def cancel_starting_download(dl_id: int) -> None:
    async with _starting_lock:
        if dl_id in _starting_downloads:
            _cancelled_starts.add(dl_id)


async def start_was_cancelled(dl_id: int) -> bool:
    async with _starting_lock:
        return dl_id in _cancelled_starts


async def is_starting_download(dl_id: int) -> bool:
    async with _starting_lock:
        return dl_id in _starting_downloads


async def mark_download_failed(dl_id: int, message: str) -> None:
    if await start_was_cancelled(dl_id):
        return

    def write() -> None:
        db = SessionLocal()
        try:
            dl = db.query(Download).filter(Download.id == dl_id).first()
            if dl:
                dl.status = "failed"
                dl.error_message = message[:500]
                db.commit()
        finally:
            db.close()

    await asyncio.to_thread(write)


async def resolve_and_start(dl_id: int, base_path: str, list_name: str) -> None:
    actual_url: str | None = None
    output_path: str | None = None
    last_db_write = 0.0

    try:
        async with _resolve_semaphore:
            db = SessionLocal()
            try:
                dl = db.query(Download).filter(Download.id == dl_id).first()
                if not dl or dl.status != "queued" or await start_was_cancelled(dl_id):
                    return

                try:
                    source_url = clean_url(dl.source_url, FUCKINGFAST_HOSTS, "download link")
                    resolved = await asyncio.to_thread(resolve_fuckingfast_download_info, source_url)
                    if not is_public_http_url(resolved.url):
                        raise ValueError("Resolved download URL is not public HTTP(S).")
                except Exception as exc:
                    if not await start_was_cancelled(dl_id):
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
                    .strip(" _.")
                    or "default"
                )
                output_path = os.path.join(base_path, safe_name, filename)

                if dl.status != "queued" or await start_was_cancelled(dl_id):
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

            def write() -> None:
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

            await asyncio.to_thread(write)

        try:
            if await start_was_cancelled(dl_id):
                return
            await dm.enqueue(dl_id, actual_url, output_path, on_update)
        except Exception as exc:
            await mark_download_failed(dl_id, str(exc))
    except Exception as exc:
        logger.exception("Unexpected start task failure for dl_id=%s", dl_id)
        await mark_download_failed(dl_id, str(exc))
    finally:
        await release_starting_download(dl_id)


async def queue_download_start(
    dl: Download,
    db: Session,
    base_path: str,
    allow_paused: bool = False,
) -> str:
    if not dm.is_running:
        raise HTTPException(503, "aria2c is not running. See server logs.")

    async with _starting_lock:
        live = dm.get_progress(dl.id)
        is_starting = dl.id in _starting_downloads
        effective_status = (live.get("status") if live else None) or dl.status
        if is_starting or (live and effective_status in {"downloading", "queued"}):
            return "already_running"
        if effective_status in {"downloading", "queued"}:
            # Recover stale DB state left behind by a cancelled resolver task or
            # server interruption. Without a live aria2 job or resolver task, a
            # queued row is only cosmetic and should be startable again.
            effective_status = "pending"
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
    asyncio.create_task(resolve_and_start(dl.id, base_path, list_name))
    return "queued"
