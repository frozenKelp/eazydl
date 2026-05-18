from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..paths import STORE_ROOT


class IndexStore:
    def __init__(self, root: Path = STORE_ROOT) -> None:
        self.root = root
        self.index_path = self.root / "index.json"
        self.taxonomies_path = self.root / "taxonomies.json"
        self.sections_path = self.root / "sections.json"
        self._index: list[dict[str, Any]] | None = None
        self._taxonomies: dict[str, dict[str, str]] | None = None
        self._by_id: dict[str, dict[str, Any]] = {}

    def reload(self) -> None:
        self._index = None
        self._taxonomies = None
        self._by_id = {}

    @property
    def exists(self) -> bool:
        return self.index_path.exists()

    def index(self) -> list[dict[str, Any]]:
        if self._index is None:
            if not self.index_path.exists():
                self._index = []
            else:
                self._index = json.loads(self.index_path.read_text(encoding="utf-8-sig"))
            self._by_id = {str(item.get("id")): item for item in self._index}
        return self._index

    def taxonomies(self) -> dict[str, dict[str, str]]:
        if self._taxonomies is None:
            if not self.taxonomies_path.exists():
                self._taxonomies = {"categories": {}, "tags": {}}
            else:
                raw = json.loads(self.taxonomies_path.read_text(encoding="utf-8-sig"))
                self._taxonomies = {
                    "categories": {str(k): str(v) for k, v in raw.get("categories", {}).items()},
                    "tags": {str(k): str(v) for k, v in raw.get("tags", {}).items()},
                }
        return self._taxonomies

    def status(self) -> dict[str, Any]:
        tax = self.taxonomies()
        mtime = self.index_path.stat().st_mtime if self.index_path.exists() else None
        return {
            "exists": self.exists,
            "total": len(self.index()),
            "store_root": str(self.root),
            "index_mtime": mtime,
            "categories": len(tax["categories"]),
            "tags": len(tax["tags"]),
        }

    def resolve_terms(self, item: dict[str, Any]) -> dict[str, Any]:
        tax = self.taxonomies()
        category_ids = [int(x) for x in item.get("category_ids") or [] if str(x).isdigit()]
        tag_ids = [int(x) for x in item.get("tag_ids") or [] if str(x).isdigit()]
        item = dict(item)
        item["categories"] = [tax["categories"].get(str(term_id), str(term_id)) for term_id in category_ids]
        item["tags"] = [tax["tags"].get(str(term_id), str(term_id)) for term_id in tag_ids]
        return item

    def search(self, query: str = "", page: int = 1, limit: int = 36) -> dict[str, Any]:
        page = max(1, page)
        limit = max(1, min(100, limit))
        needle = query.strip().lower()
        rows = self.index()
        if needle:
            tax = self.taxonomies()

            def matches(item: dict[str, Any]) -> bool:
                title = str(item.get("title") or "").lower()
                if needle in title:
                    return True
                for term_id in item.get("tag_ids") or []:
                    if needle in tax["tags"].get(str(term_id), "").lower():
                        return True
                return False

            rows = [item for item in rows if matches(item)]

        total = len(rows)
        start = (page - 1) * limit
        end = start + limit
        return {
            "items": [self.resolve_terms(item) for item in rows[start:end]],
            "page": page,
            "limit": limit,
            "total": total,
            "pages": (total + limit - 1) // limit if total else 0,
        }

    def get_entry(self, id_or_slug: str) -> dict[str, Any] | None:
        self.index()
        if id_or_slug in self._by_id:
            return self._by_id[id_or_slug]
        normalized = id_or_slug.strip().lower()
        return next((item for item in self._by_id.values() if str(item.get("id", "")).lower() == normalized), None)

    def game_path_for_entry(self, entry: dict[str, Any]) -> Path:
        return self.root / str(entry["path"])

    def get_game(self, id_or_slug: str) -> dict[str, Any] | None:
        entry = self.get_entry(id_or_slug)
        if not entry:
            return None
        path = self.game_path_for_entry(entry)
        if not path.exists():
            return None
        game = json.loads(path.read_text(encoding="utf-8-sig"))
        game["path"] = str(path.relative_to(self.root)).replace("\\", "/")
        return self.resolve_terms(game)

    def sections(self, limit: int = 18) -> dict[str, Any]:
        limit = max(1, min(60, limit))
        rows = self.index()

        def by_updated(item: dict[str, Any]) -> str:
            return str(item.get("updated_at") or "")

        def resolve_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
            return [self.resolve_terms(item) for item in items[:limit]]

        latest = sorted(rows, key=by_updated, reverse=True)
        sections = [
            {"id": "latest", "title": "Latest Repacks", "items": resolve_items(latest)},
            {"id": "recently-updated", "title": "Recently Updated", "items": resolve_items(latest)},
        ]

        if self.sections_path.exists():
            raw = json.loads(self.sections_path.read_text(encoding="utf-8-sig"))
            labels = {
                "top_month": "Most Popular Repacks of the Month",
                "top_year": "Top Repacks of the Year",
            }
            for key, title in labels.items():
                ids = raw.get(key) or []
                items = []
                for game_id in ids:
                    entry = self.get_entry(str(game_id))
                    if entry:
                        items.append(entry)
                if items:
                    sections.insert(-1, {"id": key.replace("_", "-"), "title": title, "items": resolve_items(items)})

        return {"sections": sections}
