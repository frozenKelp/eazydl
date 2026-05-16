from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class IndexStatus:
    exists: bool
    total: int
    store_root: str
    index_mtime: float | None
    categories: int
    tags: int
    updating: bool = False
    current_task: str | None = None
    last_report: dict[str, Any] | None = None
