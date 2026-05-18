from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Any, Iterable

from ..paths import DB_PATH, DOWNLOADS_DIR


def utc_expr() -> str:
    return "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"


def link_sort_key(link: dict[str, Any]) -> tuple[int, int, str]:
    text = f"{link.get('filename') or ''} {link.get('url') or ''}".lower()
    optional = int(any(word in text for word in ("optional", "bonus", "soundtrack", "credits", "language")))
    match = re.search(r"(?:part|pt|\.)(\d{1,4})(?:\.|_|-|$)", text)
    part = int(match.group(1)) if match else 9999
    return (optional, part, text)


class Database:
    def __init__(self, path: Path = DB_PATH) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode = WAL")
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.init_schema()
        self.seed_defaults()

    def init_schema(self) -> None:
        schema_path = Path(__file__).with_name("schema.sql")
        self.conn.executescript(schema_path.read_text(encoding="utf-8"))
        self.ensure_columns()
        self.conn.commit()

    def ensure_columns(self) -> None:
        download_columns = {row["name"] for row in self.conn.execute("PRAGMA table_info(downloads)").fetchall()}
        if "queue_position" not in download_columns:
            self.conn.execute("ALTER TABLE downloads ADD COLUMN queue_position INTEGER NOT NULL DEFAULT 0")
        if "download_speed" not in download_columns:
            self.conn.execute("ALTER TABLE downloads ADD COLUMN download_speed INTEGER NOT NULL DEFAULT 0")

    def seed_defaults(self) -> None:
        defaults = {
            "download_path": str(DOWNLOADS_DIR),
            "max_concurrent": "1",
            "connections_per_file": "4",
            "auto_update_on_start": "true",
            "index_update_ttl_hours": "24",
        }
        self.conn.executemany(
            "INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)",
            defaults.items(),
        )
        self.conn.execute("UPDATE settings SET value='1' WHERE key='max_concurrent' AND value='3'")
        self.conn.commit()

    def rows(self, sql: str, params: Iterable[Any] = ()) -> list[dict[str, Any]]:
        return [dict(row) for row in self.conn.execute(sql, tuple(params)).fetchall()]

    def row(self, sql: str, params: Iterable[Any] = ()) -> dict[str, Any] | None:
        item = self.conn.execute(sql, tuple(params)).fetchone()
        return dict(item) if item else None

    def execute(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        cur = self.conn.execute(sql, tuple(params))
        self.conn.commit()
        return cur

    def executemany(self, sql: str, params: Iterable[Iterable[Any]]) -> None:
        self.conn.executemany(sql, params)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "Database":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def get_settings(self) -> dict[str, str]:
        return {row["key"]: row["value"] for row in self.rows("SELECT key, value FROM settings")}

    def update_settings(self, values: dict[str, str]) -> dict[str, str]:
        self.executemany(
            "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            values.items(),
        )
        return self.get_settings()

    def record_index_run(self, kind: str, status: str, report: dict[str, Any], message: str = "") -> None:
        self.execute(
            """
            INSERT INTO index_runs(
              kind, status, inspected, new_games, updated_games, skipped, total,
              message, started_at, finished_at, report_json
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                kind,
                status,
                int(report.get("inspected", 0)),
                int(report.get("new", 0)),
                int(report.get("updated", 0)),
                int(report.get("skipped", 0)),
                int(report.get("total", 0)),
                message,
                str(report.get("started_at") or ""),
                str(report.get("finished_at") or ""),
                json.dumps(report, ensure_ascii=False),
            ),
        )

    def upsert_library_item(self, game: dict[str, Any], game_path: str) -> int:
        category_ids = json.dumps(game.get("category_ids") or [])
        tag_ids = json.dumps(game.get("tag_ids") or [])
        self.execute(
            """
            INSERT INTO library_items(
              game_id, title, source_url, image_url, original_size, repack_size,
              category_ids, tag_ids, game_path
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(game_id) DO UPDATE SET
              title=excluded.title,
              source_url=excluded.source_url,
              image_url=excluded.image_url,
              original_size=excluded.original_size,
              repack_size=excluded.repack_size,
              category_ids=excluded.category_ids,
              tag_ids=excluded.tag_ids,
              game_path=excluded.game_path,
              updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            """,
            (
                game["id"],
                game["title"],
                game["source_url"],
                game.get("image_url"),
                game.get("original_size"),
                game.get("repack_size") or "",
                category_ids,
                tag_ids,
                game_path,
            ),
        )
        row = self.row("SELECT id FROM library_items WHERE game_id=?", (game["id"],))
        if not row:
            raise RuntimeError("Could not read created library item")
        return int(row["id"])

    def replace_download_links(self, library_item_id: int, game_id: str, links: list[dict[str, Any]]) -> None:
        existing = {
            row["source_url"]
            for row in self.rows("SELECT source_url FROM downloads WHERE library_item_id=?", (library_item_id,))
        }
        rows: list[tuple[Any, ...]] = []
        for link in sorted(links, key=link_sort_key):
            url = str(link.get("url") or "").strip()
            if not url or url in existing:
                continue
            rows.append((library_item_id, game_id, url, str(link.get("filename") or "")))
        if rows:
            self.executemany(
                """
                INSERT OR IGNORE INTO downloads(library_item_id, game_id, source_url, filename, status)
                VALUES(?, ?, ?, ?, 'pending')
                """,
                rows,
            )

    def library_payload(self) -> list[dict[str, Any]]:
        items = self.rows("SELECT * FROM library_items ORDER BY created_at DESC")
        for item in items:
            item["downloads"] = self.rows(
                """
                SELECT *
                FROM downloads
                WHERE library_item_id=?
                ORDER BY
                  CASE status
                    WHEN 'downloading' THEN 0
                    WHEN 'queued' THEN 1
                    WHEN 'paused' THEN 2
                    WHEN 'pending' THEN 3
                    WHEN 'failed' THEN 4
                    WHEN 'completed' THEN 5
                    ELSE 6
                  END,
                  CASE WHEN queue_position=0 THEN id ELSE queue_position END,
                  id ASC
                """,
                (item["id"],),
            )
            item["download_count"] = len(item["downloads"])
            item["completed_count"] = sum(1 for row in item["downloads"] if row["status"] == "completed")
            item["category_ids"] = json.loads(item.get("category_ids") or "[]")
            item["tag_ids"] = json.loads(item.get("tag_ids") or "[]")
        return items
