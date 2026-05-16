from __future__ import annotations

import threading
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable

import yaml

from ..config import DEFAULT_UPDATE_MAX_PAGES
from ..db import Database
from ..paths import META_PATH, STORE_ROOT
from . import crawler
from .store import IndexStore


class IndexUpdateManager:
    def __init__(self, store: IndexStore, db: Database, meta_path: Path = META_PATH) -> None:
        self.store = store
        self.db = db
        self.meta_path = meta_path
        self.lock = threading.Lock()
        self.thread: threading.Thread | None = None
        self.current_task: str | None = None
        self.last_report: dict[str, Any] | None = None

    @property
    def running(self) -> bool:
        return self.thread is not None and self.thread.is_alive()

    def load_meta(self) -> dict[str, Any]:
        if not self.meta_path.exists():
            return {}
        data = yaml.safe_load(self.meta_path.read_text(encoding="utf-8")) or {}
        return data if isinstance(data, dict) else {}

    def save_meta(self, values: dict[str, Any]) -> None:
        self.meta_path.parent.mkdir(parents=True, exist_ok=True)
        self.meta_path.write_text(yaml.safe_dump(values, sort_keys=True), encoding="utf-8")

    def status(self) -> dict[str, Any]:
        status = self.store.status()
        status.update(
            {
                "updating": self.running,
                "current_task": self.current_task,
                "last_report": self.last_report,
                "meta": self.load_meta(),
            }
        )
        return status

    def start(self, kind: str, *, background: bool = True) -> dict[str, Any]:
        if self.running:
            return {"accepted": False, "running": True, "task": self.current_task}
        if kind not in {"update", "rebuild"}:
            raise ValueError(f"Unsupported index task: {kind}")
        if background:
            self.thread = threading.Thread(target=self._run, args=(kind,), name=f"eazydl-index-{kind}", daemon=True)
            self.current_task = kind
            self.thread.start()
            return {"accepted": True, "running": True, "task": kind}
        report = self._run(kind)
        return {"accepted": True, "running": False, "task": kind, "report": report}

    def _run(self, kind: str) -> dict[str, Any]:
        with self.lock:
            self.current_task = kind
            status = "ok"
            message = ""
            try:
                if kind == "rebuild":
                    report_obj = crawler.rebuild_store(STORE_ROOT)
                else:
                    report_obj = crawler.update_store(STORE_ROOT, max_pages=DEFAULT_UPDATE_MAX_PAGES)
                report = asdict(report_obj)
                if report.get("stopped_reason"):
                    status = "partial"
                    message = str(report["stopped_reason"])
                self.store.reload()
                meta = self.load_meta()
                meta.update(
                    {
                        "schema_version": 1,
                        "last_report": report,
                        f"last_{kind}_at": report.get("finished_at"),
                    }
                )
                self.save_meta(meta)
            except Exception as exc:
                status = "failed"
                message = str(exc)
                report = {
                    "inspected": 0,
                    "new": 0,
                    "updated": 0,
                    "skipped": 0,
                    "total": len(self.store.index()),
                    "started_at": "",
                    "finished_at": "",
                    "error": message,
                }
            self.last_report = report
            self.db.record_index_run(kind, status, report, message)
            self.current_task = None
            return report

    def run_saved_pages(self, local_dir: Path, *, reset_store: bool = True) -> dict[str, Any]:
        report_obj = crawler.compile_saved_pages(local_dir, STORE_ROOT, reset_store=reset_store)
        report = asdict(report_obj)
        self.store.reload()
        meta = self.load_meta()
        meta.update({"schema_version": 1, "last_compile_at": report.get("finished_at"), "last_report": report})
        self.save_meta(meta)
        self.last_report = report
        self.db.record_index_run("compile", "ok", report)
        return report
