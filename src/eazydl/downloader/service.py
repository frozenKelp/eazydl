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
        settings = self.db.get_settings()
        try:
            self.aria2.start(int(settings.get("max_concurrent", "3")))
        except Exception:
            return
        if self.poll_thread and self.poll_thread.is_alive():
            return
        self.poll_thread = threading.Thread(target=self._poll_loop, name="eazydl-aria2-poll", daemon=True)
        self.poll_thread.start()

    def shutdown(self) -> None:
        self.stop_event.set()
        self.aria2.shutdown()

    def stats(self) -> dict[str, Any]:
        return self.aria2.stats()

    def _poll_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                self.sync()
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
            error = status.get("errorMessage")
            self.db.execute(
                """
                UPDATE downloads
                SET status=?,
                    bytes_downloaded=?,
                    total_bytes=?,
                    filename=?,
                    error_message=COALESCE(?, error_message),
                    completed_at=CASE WHEN ?='completed' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE completed_at END,
                    gid=CASE WHEN ? IN ('completed', 'failed', 'pending') THEN NULL ELSE gid END
                WHERE id=?
                """,
                (mapped, completed, total, filename, error, mapped, mapped, row["id"]),
            )

    def all_downloads(self) -> list[dict[str, Any]]:
        self.sync()
        return self.db.rows(
            """
            SELECT d.*, l.title AS game_title
            FROM downloads d
            JOIN library_items l ON l.id=d.library_item_id
            ORDER BY d.created_at DESC, d.id DESC
            """
        )

    def start_downloads(self, ids: list[int]) -> dict[str, Any]:
        self.start()
        settings = self.db.get_settings()
        download_root = Path(settings.get("download_path") or DOWNLOADS_DIR)
        connections = int(settings.get("connections_per_file", "4"))
        queued: list[int] = []
        skipped: list[int] = []
        for dl_id in ids:
            try:
                if self._start_one(dl_id, download_root, connections):
                    queued.append(dl_id)
                else:
                    skipped.append(dl_id)
            except Exception as exc:
                self.db.execute(
                    "UPDATE downloads SET status='failed', error_message=? WHERE id=?",
                    (str(exc)[:500], dl_id),
                )
                skipped.append(dl_id)
        return {"queued": len(queued), "skipped": len(skipped), "queued_ids": queued, "skipped_ids": skipped}

    def _start_one(self, dl_id: int, download_root: Path, connections: int) -> bool:
        with self.lock:
            row = self.db.row("SELECT * FROM downloads WHERE id=?", (dl_id,))
            if not row or row["status"] in {"downloading", "queued", "completed"}:
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
                SET resolved_url=?, gid=?, filename=?, status='queued', error_message=NULL
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
            if not row or not row.get("gid"):
                skipped.append(dl_id)
                continue
            try:
                self.aria2.pause(str(row["gid"]))
                self.db.execute("UPDATE downloads SET status='paused' WHERE id=?", (dl_id,))
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
                start_ids.append(dl_id)
        started = self.start_downloads(start_ids) if start_ids else {"queued": 0, "skipped": 0, "queued_ids": [], "skipped_ids": []}
        return {
            "resumed": len(resumed),
            "queued": started["queued"],
            "skipped": len(skipped) + started["skipped"],
            "resumed_ids": resumed,
            "queued_ids": started["queued_ids"],
            "skipped_ids": skipped + started["skipped_ids"],
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
                "UPDATE downloads SET status='pending', gid=NULL, bytes_downloaded=0, total_bytes=0 WHERE id=?",
                (dl_id,),
            )
            stopped.append(dl_id)
        return {"stopped": len(stopped), "skipped": len(skipped), "stopped_ids": stopped, "skipped_ids": skipped}
