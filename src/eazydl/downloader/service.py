from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Any

from ..db import Database
from ..paths import DOWNLOADS_DIR
from .aria2 import Aria2Client
from .resolver import clean_filename, resolve_fuckingfast


STATUS_MAP = {
    "active": "downloading",
    "waiting": "queued",
    "paused": "paused",
    "error": "failed",
    "complete": "completed",
    "removed": "pending",
}


class DownloadService:
    def __init__(self, db: Database) -> None:
        self.db = db
        self.aria2 = Aria2Client()
        self.poll_thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.lock = threading.Lock()

    def start(self) -> None:
        try:
            self._ensure_aria2()
        except Exception:
            return
        self._ensure_poll_thread()

    def _ensure_aria2(self) -> None:
        settings = self.db.get_settings()
        self.aria2.start(int(settings.get("max_concurrent", "1")))

    def _ensure_poll_thread(self) -> None:
        if self.poll_thread and self.poll_thread.is_alive():
            return
        self.poll_thread = threading.Thread(target=self._poll_loop, name="eazydl-aria2-poll", daemon=True)
        self.poll_thread.start()

    def shutdown(self) -> None:
        self.stop_event.set()
        if self.poll_thread and self.poll_thread.is_alive():
            self.poll_thread.join(timeout=2)
        self.aria2.shutdown()

    def stats(self) -> dict[str, Any]:
        return self.aria2.stats()

    def _poll_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                self.sync()
                self.fill_queue()
            except Exception:
                pass
            time.sleep(1)

    def sync(self) -> None:
        rows = self.db.rows("SELECT * FROM downloads WHERE gid IS NOT NULL AND gid <> ''")
        for row in rows:
            status = self.aria2.tell(str(row["gid"]))
            if not status:
                continue
            mapped = STATUS_MAP.get(str(status.get("status")), str(status.get("status")))
            files = status.get("files") or []
            filename = row["filename"]
            if files and files[0].get("path"):
                filename = clean_filename(os.path.basename(files[0]["path"]))
            completed = int(status.get("completedLength") or 0)
            total = int(status.get("totalLength") or 0)
            speed = int(status.get("downloadSpeed") or 0)
            if mapped in {"completed", "failed", "pending", "paused"}:
                speed = 0
            error = status.get("errorMessage")
            self.db.execute(
                """
                UPDATE downloads
                SET status=?,
                    bytes_downloaded=?,
                    total_bytes=?,
                    download_speed=?,
                    filename=?,
                    error_message=COALESCE(?, error_message),
                    completed_at=CASE WHEN ?='completed' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE completed_at END,
                    gid=CASE WHEN ? IN ('completed', 'failed', 'pending') THEN NULL ELSE gid END
                WHERE id=?
                """,
                (mapped, completed, total, speed, filename, error, mapped, mapped, row["id"]),
            )

    def all_downloads(self) -> list[dict[str, Any]]:
        self.sync()
        self.fill_queue()
        return self.db.rows(
            """
            SELECT d.*, l.title AS game_title
            FROM downloads d
            JOIN library_items l ON l.id=d.library_item_id
            ORDER BY
              CASE d.status
                WHEN 'downloading' THEN 0
                WHEN 'queued' THEN 1
                WHEN 'paused' THEN 2
                WHEN 'pending' THEN 3
                WHEN 'failed' THEN 4
                WHEN 'completed' THEN 5
                ELSE 6
              END,
              CASE WHEN d.queue_position=0 THEN d.id ELSE d.queue_position END,
              d.id ASC
            """
        )

    def start_downloads(self, ids: list[int]) -> dict[str, Any]:
        self._ensure_aria2()
        marked: list[int] = []
        skipped: list[int] = []
        for dl_id in ids:
            row = self.db.row("SELECT id, status, gid FROM downloads WHERE id=?", (dl_id,))
            if not row or row["status"] in {"downloading", "completed"}:
                skipped.append(dl_id)
                continue
            if row.get("gid"):
                skipped.append(dl_id)
                continue
            self.db.execute(
                """
                UPDATE downloads
                SET status='queued',
                    queue_position=CASE WHEN queue_position=0 THEN id ELSE queue_position END,
                    error_message=NULL
                WHERE id=? AND gid IS NULL
                """,
                (dl_id,),
            )
            marked.append(dl_id)
        started = self.fill_queue()
        self._ensure_poll_thread()
        return {
            "queued": len(marked),
            "started": len(started),
            "skipped": len(skipped),
            "queued_ids": marked,
            "started_ids": started,
            "skipped_ids": skipped,
        }

    def fill_queue(self) -> list[int]:
        settings = self.db.get_settings()
        download_root = Path(settings.get("download_path") or DOWNLOADS_DIR)
        max_active = max(1, int(settings.get("max_concurrent", "1")))
        connections = int(settings.get("connections_per_file", "4"))
        self.enforce_active_limit(max_active)
        active = self.db.row(
            """
            SELECT COUNT(*) AS count
            FROM downloads
            WHERE gid IS NOT NULL
              AND status IN ('downloading', 'queued')
            """
        )
        open_slots = max(0, max_active - int(active["count"] if active else 0))
        if open_slots <= 0:
            return []
        rows = self._queue_rows(open_slots)
        started: list[int] = []
        for row in rows:
            dl_id = int(row["id"])
            try:
                if self._start_one(dl_id, download_root, connections):
                    started.append(dl_id)
            except Exception as exc:
                self.db.execute(
                    "UPDATE downloads SET status='failed', error_message=? WHERE id=?",
                    (str(exc)[:500], dl_id),
                )
        return started

    def move_to_top(self, ids: list[int]) -> dict[str, Any]:
        ids = [int(item) for item in ids]
        if not ids:
            return {"moved": 0, "moved_ids": []}
        ordered = self.db.rows(
            f"""
            SELECT id
            FROM downloads
            WHERE id IN ({",".join("?" for _ in ids)})
            ORDER BY CASE WHEN queue_position=0 THEN id ELSE queue_position END, id ASC
            """,
            ids,
        )
        if not ordered:
            return {"moved": 0, "moved_ids": []}
        row = self.db.row(
            """
            SELECT MIN(CASE WHEN queue_position=0 THEN id ELSE queue_position END) AS first_position
            FROM downloads
            WHERE status IN ('queued', 'pending', 'paused', 'failed')
            """
        )
        first_position = int(row["first_position"] if row and row["first_position"] is not None else 0)
        moved: list[int] = []
        start = first_position - len(ordered)
        if start <= 0 <= start + len(ordered) - 1:
            start -= len(ordered)
        for offset, item in enumerate(ordered):
            self.db.execute("UPDATE downloads SET queue_position=? WHERE id=?", (start + offset, item["id"]))
            moved.append(int(item["id"]))
        return {"moved": len(moved), "moved_ids": moved}

    def _queue_rows(self, open_slots: int) -> list[dict[str, Any]]:
        return self.db.rows(
            """
            SELECT id
            FROM downloads
            WHERE status='queued'
              AND (gid IS NULL OR gid='')
            ORDER BY CASE WHEN queue_position=0 THEN id ELSE queue_position END, id ASC
            LIMIT ?
            """,
            (open_slots,),
        )

    def enforce_active_limit(self, max_active: int) -> None:
        rows = self.db.rows(
            """
            SELECT *
            FROM downloads
            WHERE gid IS NOT NULL
              AND gid <> ''
              AND status IN ('downloading', 'queued')
            ORDER BY id ASC
            """
        )
        for row in rows[max_active:]:
            try:
                self.aria2.remove(str(row["gid"]))
            except Exception:
                pass
            self.db.execute(
                """
                UPDATE downloads
                SET status='queued',
                    gid=NULL,
                    download_speed=0,
                    error_message=NULL
                WHERE id=?
                """,
                (row["id"],),
            )

    def _start_one(self, dl_id: int, download_root: Path, connections: int) -> bool:
        with self.lock:
            row = self.db.row("SELECT * FROM downloads WHERE id=?", (dl_id,))
            if not row or row["status"] != "queued" or row.get("gid"):
                return False
            game = self.db.row("SELECT title FROM library_items WHERE id=?", (row["library_item_id"],))
            game_title = clean_filename(str(game["title"] if game else "default"))
            resolved = resolve_fuckingfast(str(row["source_url"]))
            filename = clean_filename(row["filename"] or resolved["filename"])
            out_dir = download_root / game_title
            out_dir.mkdir(parents=True, exist_ok=True)
            filename = self._unique_filename(out_dir, filename)
            gid = self.aria2.add_uri(resolved["url"], str(out_dir), filename, connections)
            self.db.execute(
                """
                UPDATE downloads
                SET resolved_url=?, gid=?, filename=?, status='downloading', download_speed=0, error_message=NULL
                WHERE id=?
                """,
                (resolved["url"], gid, filename, dl_id),
            )
            return True

    def _unique_filename(self, directory: Path, filename: str) -> str:
        stem = Path(filename).stem
        suffix = Path(filename).suffix
        candidate = clean_filename(filename)
        for number in range(1, 10000):
            if not (directory / candidate).exists() and not (directory / f"{candidate}.aria2").exists():
                return candidate
            candidate = f"{stem} ({number + 1}){suffix}"
        return f"{stem}-{int(time.time())}{suffix}"

    def pause(self, ids: list[int]) -> dict[str, Any]:
        changed: list[int] = []
        skipped: list[int] = []
        for dl_id in ids:
            row = self.db.row("SELECT * FROM downloads WHERE id=?", (dl_id,))
            if not row:
                skipped.append(dl_id)
                continue
            if not row.get("gid"):
                if row.get("status") == "queued":
                    self.db.execute("UPDATE downloads SET status='paused', download_speed=0 WHERE id=?", (dl_id,))
                    changed.append(dl_id)
                else:
                    skipped.append(dl_id)
                continue
            try:
                self.aria2.pause(str(row["gid"]))
                self.db.execute("UPDATE downloads SET status='paused', download_speed=0 WHERE id=?", (dl_id,))
                changed.append(dl_id)
            except Exception:
                skipped.append(dl_id)
        return {"paused": len(changed), "skipped": len(skipped), "paused_ids": changed, "skipped_ids": skipped}

    def resume(self, ids: list[int]) -> dict[str, Any]:
        resumed: list[int] = []
        start_ids: list[int] = []
        skipped: list[int] = []
        for dl_id in ids:
            row = self.db.row("SELECT * FROM downloads WHERE id=?", (dl_id,))
            if not row:
                skipped.append(dl_id)
            elif row.get("gid"):
                try:
                    self.aria2.unpause(str(row["gid"]))
                    self.db.execute("UPDATE downloads SET status='downloading' WHERE id=?", (dl_id,))
                    resumed.append(dl_id)
                except Exception:
                    skipped.append(dl_id)
            else:
                self.db.execute(
                    """
                    UPDATE downloads
                    SET status='queued',
                        queue_position=CASE WHEN queue_position=0 THEN id ELSE queue_position END,
                        error_message=NULL
                    WHERE id=?
                    """,
                    (dl_id,),
                )
                start_ids.append(dl_id)
        started_ids = self.fill_queue() if start_ids else []
        return {
            "resumed": len(resumed),
            "queued": len(start_ids),
            "started": len(started_ids),
            "skipped": len(skipped),
            "resumed_ids": resumed,
            "queued_ids": start_ids,
            "started_ids": started_ids,
            "skipped_ids": skipped,
        }

    def stop(self, ids: list[int]) -> dict[str, Any]:
        stopped: list[int] = []
        skipped: list[int] = []
        for dl_id in ids:
            row = self.db.row("SELECT * FROM downloads WHERE id=?", (dl_id,))
            if not row:
                skipped.append(dl_id)
                continue
            if row.get("gid"):
                try:
                    self.aria2.remove(str(row["gid"]))
                except Exception:
                    pass
            self.db.execute(
                """
                UPDATE downloads
                SET status='pending',
                    gid=NULL,
                    queue_position=0,
                    bytes_downloaded=0,
                    total_bytes=0,
                    download_speed=0
                WHERE id=?
                """,
                (dl_id,),
            )
            stopped.append(dl_id)
        return {"stopped": len(stopped), "skipped": len(skipped), "stopped_ids": stopped, "skipped_ids": skipped}
