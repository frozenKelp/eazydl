"""
Download manager backed by aria2c via the aria2p library.

How it works:
  1. On startup, we launch an aria2c subprocess with --enable-rpc
     (or connect to one that's already running on port 6800).
  2. Downloads are added via the JSON-RPC API using aria2p.
  3. A background polling loop runs every second, fetches all download
     statuses from aria2c, updates our in-memory cache, and fires
     optional per-download callbacks (used to sync the SQLite DB).
  4. Pause / resume / stop are async wrappers around aria2p calls that
     use asyncio.to_thread so the event loop is never blocked.

Bugs fixed vs. original:
  - pause() / resume() / stop() were synchronous but called blocking aria2p
    network I/O. When FastAPI endpoints were made async these would have
    frozen the event loop. All three are now async with asyncio.to_thread.
  - set_max_concurrent() had the same event-loop-blocking problem. Fixed.
  - shutdown() did not await the poll task cancellation, risking a race
    where the task ran one more iteration after self.api was cleared.
  - Exceptions in _sync_all / callbacks were silently swallowed with bare
    `pass`. Now logged at DEBUG so transient errors are visible.
  - stop() now also calls _clean() even when the api.get_download RPC
    fails, so internal maps never leak stale entries.
  - aria2c subprocess is killed if its RPC never becomes ready (was leaked).
"""

import asyncio
import logging
import os
import shutil
import subprocess
from typing import Callable, Dict, Optional

import aria2p

logger = logging.getLogger(__name__)

# Map aria2c status strings → our internal status vocabulary
_STATUS_MAP: dict[str, str] = {
    "active":   "downloading",
    "waiting":  "queued",
    "paused":   "paused",
    "error":    "failed",
    "complete": "completed",
    "removed":  "pending",
}


def _map_status(aria_status: str) -> str:
    return _STATUS_MAP.get(aria_status, aria_status)


class Aria2Manager:
    def __init__(self) -> None:
        self.api: Optional[aria2p.API] = None
        self._process: Optional[subprocess.Popen] = None

        # Bidirectional mapping: our DB ids ↔ aria2 GIDs
        self._gid_map: Dict[int, str] = {}   # dl_id  → aria2 GID
        self._rev_map: Dict[str, int] = {}   # aria2 GID → dl_id

        # Per-download async callbacks fired by the poll loop → syncs DB
        self._callbacks: Dict[int, Callable] = {}

        # In-memory progress cache returned to WS & REST endpoints
        self._cache: Dict[int, dict] = {}

        self._poll_task: Optional[asyncio.Task] = None
        self.is_running: bool = False
        self.max_concurrent: int = 3
        self.connections_per_file: int = 4

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    async def start(self, max_concurrent: int = 3, connections_per_file: int = 4) -> None:
        self.max_concurrent = max_concurrent
        self.connections_per_file = connections_per_file

        # Reuse an aria2c already running on 6800 (e.g. system daemon)
        test_api = aria2p.API(aria2p.Client(host="http://localhost", port=6800, secret=""))
        try:
            await asyncio.to_thread(test_api.get_stats)
            self.api = test_api
            self.is_running = True
            self._poll_task = asyncio.create_task(self._poll_loop())
            logger.info("Reused existing aria2c daemon on port 6800.")
            return
        except Exception:
            pass

        # aria2c not running — spawn our own subprocess
        aria2c_bin = shutil.which("aria2c")
        if not aria2c_bin:
            raise RuntimeError(
                "aria2c executable not found.\n"
                "Install it first:\n"
                "  Ubuntu / Debian : sudo apt install aria2\n"
                "  macOS           : brew install aria2\n"
                "  Windows         : https://aria2.github.io/"
            )

        self._process = subprocess.Popen(
            [
                aria2c_bin,
                "--enable-rpc",
                "--rpc-listen-all=false",
                "--rpc-listen-port=6800",
                "--rpc-allow-origin-all=true",
                f"--max-concurrent-downloads={max_concurrent}",
                "--continue=true",
                "--auto-file-renaming=false",
                "--allow-overwrite=true",
                "--quiet=true",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        # Poll until the RPC endpoint is ready (up to 3 s / 15 × 200 ms)
        for _ in range(15):
            await asyncio.sleep(0.2)
            try:
                new_api = aria2p.API(
                    aria2p.Client(host="http://localhost", port=6800, secret="")
                )
                await asyncio.to_thread(new_api.get_stats)
                self.api = new_api
                self.is_running = True
                self._poll_task = asyncio.create_task(self._poll_loop())
                logger.info("aria2c subprocess started; RPC ready.")
                return
            except Exception:
                continue

        # BUG FIX: kill the subprocess if we timed out — the original code leaked it.
        if self._process:
            self._process.terminate()
            self._process = None
        raise RuntimeError("aria2c started but its RPC server timed out after 3 s.")

    async def shutdown(self) -> None:
        self.is_running = False

        # BUG FIX: await the task cancellation so it cannot run one more tick
        # after self.api is cleared below.
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
            self._poll_task = None

        if self.api:
            try:
                await asyncio.to_thread(
                    self.api.client.call, "aria2.shutdown", []
                )
            except Exception:
                pass
            self.api = None

        if self._process:
            self._process.terminate()
            self._process = None

    # ── Poll loop ──────────────────────────────────────────────────────────────

    async def _poll_loop(self) -> None:
        """Runs forever; fetches aria2c status every second and updates cache."""
        while self.is_running:
            await asyncio.sleep(1)
            if not self.api:
                continue
            try:
                await self._sync_all()
            except asyncio.CancelledError:
                raise  # let cancellation propagate cleanly
            except Exception as exc:
                # BUG FIX: was bare `pass` — transient RPC errors now visible in logs.
                logger.debug("Poll loop transient error: %s", exc)

    async def _sync_all(self) -> None:
        all_dls = await asyncio.to_thread(self.api.get_downloads)

        for dl in all_dls:
            dl_id = self._rev_map.get(dl.gid)
            if dl_id is None:
                continue  # not one of ours

            error: Optional[str] = None
            if dl.has_failed:
                msg = getattr(dl, "error_message", None)
                code = getattr(dl, "error_code", None)
                error = (
                    str(msg) if msg
                    else (f"Error code {code}" if code else "Download failed")
                )

            cached_name = self._cache.get(dl_id, {}).get("filename", "")
            snapshot = {
                "id":               dl_id,
                "gid":              dl.gid,
                "filename":         dl.name or cached_name,
                "status":           _map_status(dl.status),
                "bytes_downloaded": dl.completed_length,
                "total_bytes":      dl.total_length,
                "progress":         round(dl.progress, 2),
                "speed":            dl.download_speed,
                "connections":      getattr(dl, "connections", 0),
                "error":            error,
            }
            self._cache[dl_id] = snapshot

            if cb := self._callbacks.get(dl_id):
                try:
                    await cb(snapshot)
                except Exception as exc:
                    logger.debug("on_update callback error for dl_id=%s: %s", dl_id, exc)

    # ── Enqueue ────────────────────────────────────────────────────────────────

    async def enqueue(
        self,
        dl_id: int,
        url: str,
        output_path: str,
        on_update: Optional[Callable] = None,
    ) -> str:
        """
        Add a URL to aria2c's queue. Returns the aria2 GID immediately.
        aria2c handles the download; we watch via the poll loop.
        """
        if not self.api:
            raise RuntimeError("aria2c is not running. Check server logs.")

        out_dir = os.path.dirname(output_path) or "."
        os.makedirs(out_dir, exist_ok=True)

        options = {
            "dir":                       out_dir,
            "out":                       os.path.basename(output_path),
            "continue":                  "true",
            # Multi-connection: aria2c opens N TCP connections to the same URL
            "split":                     str(self.connections_per_file),
            "min-split-size":            "1M",
            "max-connection-per-server": str(self.connections_per_file),
        }

        dl = await asyncio.to_thread(self.api.add_uris, [url], options=options)
        gid = dl.gid

        self._gid_map[dl_id] = gid
        self._rev_map[gid] = dl_id
        if on_update:
            self._callbacks[dl_id] = on_update

        # Pre-populate cache so the UI shows "queued" immediately
        self._cache[dl_id] = {
            "id":               dl_id,
            "gid":              gid,
            "filename":         os.path.basename(output_path),
            "status":           "queued",
            "bytes_downloaded": 0,
            "total_bytes":      0,
            "progress":         0.0,
            "speed":            0,
            "connections":      0,
            "error":            None,
        }
        return gid

    # ── Controls ───────────────────────────────────────────────────────────────
    # BUG FIX: all three were synchronous and called blocking aria2p network I/O.
    # When invoked from async FastAPI endpoints they would have frozen the event
    # loop. Converted to async with asyncio.to_thread for every RPC call.

    async def pause(self, dl_id: int) -> None:
        if not self.api:
            return
        gid = self._gid_map.get(dl_id)
        if not gid:
            return
        try:
            dl_obj = await asyncio.to_thread(self.api.get_download, gid)
            await asyncio.to_thread(self.api.pause, [dl_obj])
            if dl_id in self._cache:
                self._cache[dl_id]["status"] = "paused"
                self._cache[dl_id]["speed"] = 0
        except Exception as exc:
            logger.warning("pause(%s) failed: %s", dl_id, exc)

    async def resume(self, dl_id: int) -> None:
        if not self.api:
            return
        gid = self._gid_map.get(dl_id)
        if not gid:
            return
        try:
            dl_obj = await asyncio.to_thread(self.api.get_download, gid)
            await asyncio.to_thread(self.api.resume, [dl_obj])
            if dl_id in self._cache:
                self._cache[dl_id]["status"] = "downloading"
        except Exception as exc:
            logger.warning("resume(%s) failed: %s", dl_id, exc)

    async def stop(self, dl_id: int) -> None:
        gid = self._gid_map.get(dl_id)
        if self.api and gid:
            try:
                dl_obj = await asyncio.to_thread(self.api.get_download, gid)
                await asyncio.to_thread(self.api.remove, [dl_obj])
            except Exception as exc:
                # BUG FIX: original code returned without calling _clean on failure,
                # leaving stale entries in _gid_map / _rev_map / _cache forever.
                logger.warning("stop(%s) aria2c remove failed: %s", dl_id, exc)
        self._clean(dl_id, gid)  # always clean regardless of RPC outcome

    def _clean(self, dl_id: int, gid: Optional[str]) -> None:
        self._gid_map.pop(dl_id, None)
        if gid:
            self._rev_map.pop(gid, None)
        self._callbacks.pop(dl_id, None)
        self._cache.pop(dl_id, None)

    # ── Config ─────────────────────────────────────────────────────────────────

    async def set_max_concurrent(self, n: int) -> None:
        """BUG FIX: was sync; calling blocking client.call() from async context
        would freeze the event loop. Now uses asyncio.to_thread."""
        self.max_concurrent = max(1, n)
        if self.api:
            try:
                await asyncio.to_thread(
                    self.api.client.call,
                    "aria2.changeGlobalOption",
                    [{"max-concurrent-downloads": str(n)}],
                )
            except Exception as exc:
                logger.warning("set_max_concurrent RPC failed: %s", exc)

    def set_connections_per_file(self, n: int) -> None:
        # No RPC call needed — applied to the next enqueue() call.
        self.connections_per_file = max(1, min(16, n))

    # ── Queries ────────────────────────────────────────────────────────────────

    def get_progress(self, dl_id: int) -> Optional[dict]:
        return self._cache.get(dl_id)

    def all_progress(self) -> list:
        return list(self._cache.values())

    async def global_stats(self) -> dict:
        if not self.api:
            return {"aria2_running": False}
        try:
            s = await asyncio.to_thread(self.api.get_stats)
            return {
                "aria2_running":  True,
                "download_speed": s.download_speed,
                "upload_speed":   s.upload_speed,
                "num_active":     s.num_active,
                "num_waiting":    s.num_waiting,
                "num_stopped":    s.num_stopped_total,
            }
        except Exception:
            return {"aria2_running": False}


# Module-level singleton used throughout the app
dm = Aria2Manager()
