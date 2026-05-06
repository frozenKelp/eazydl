"""
SQLAlchemy models and DB bootstrap for EasyDL.

Fixes vs. original:
  - datetime.utcnow() replaced with datetime.now(timezone.utc) (deprecated in 3.12)
  - connections_per_file added to default settings (was missing, broke the UI)
  - Download.status now has a DB index (filtered constantly)
  - DateTime columns carry timezone=True so SQLAlchemy stores UTC properly
"""

import os
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String, create_engine
from sqlalchemy.orm import declarative_base, relationship, sessionmaker

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "data"))
DOWNLOADS_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "downloads"))
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(DOWNLOADS_DIR, exist_ok=True)

DATABASE_URL = f"sqlite:///{os.path.join(DATA_DIR, 'downloader.db')}"
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def _utcnow() -> datetime:
    """Timezone-aware UTC timestamp — replaces the deprecated datetime.utcnow()."""
    return datetime.now(timezone.utc)


class LinkList(Base):
    __tablename__ = "link_lists"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, unique=True, nullable=False)
    created_at = Column(DateTime(timezone=True), default=_utcnow)

    downloads = relationship(
        "Download", back_populates="link_list", cascade="all, delete-orphan"
    )


class Download(Base):
    __tablename__ = "downloads"

    id = Column(Integer, primary_key=True, index=True)
    list_id = Column(Integer, ForeignKey("link_lists.id"))
    source_url = Column(String, nullable=False)          # fuckingfast.co link
    resolved_url = Column(String, nullable=True)         # actual CDN URL
    filename = Column(String, default="")
    status = Column(String, default="pending", index=True)  # indexed: queried constantly
    bytes_downloaded = Column(Integer, default=0)
    total_bytes = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), default=_utcnow)
    completed_at = Column(DateTime(timezone=True), nullable=True)
    error_message = Column(String, nullable=True)

    link_list = relationship("LinkList", back_populates="downloads")


class Setting(Base):
    __tablename__ = "settings"

    key = Column(String, primary_key=True)
    value = Column(String)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Create tables and seed default settings on first run."""
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    try:
        # Reset any downloads stuck mid-flight from a previous crash/restart
        db.query(Download).filter(
            Download.status.in_(["downloading", "queued"])
        ).update({"status": "pending"}, synchronize_session=False)

        # BUG FIX: connections_per_file was missing — caused the settings UI
        # to display an empty input on first launch.
        defaults: dict[str, str] = {
            "download_path":        DOWNLOADS_DIR,
            "max_concurrent":       "3",
            "connections_per_file": "4",
        }
        for key, value in defaults.items():
            if not db.query(Setting).filter(Setting.key == key).first():
                db.add(Setting(key=key, value=value))

        db.commit()
    finally:
        db.close()
