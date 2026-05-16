from __future__ import annotations

from .database import Database


def migrate(db: Database) -> None:
    db.init_schema()
