from __future__ import annotations

import os
from pathlib import Path


PROJECT_ROOT = Path(os.getenv("EASYDL_ROOT", Path.cwd())).resolve()
DATA_DIR = Path(os.getenv("EASYDL_DATA_DIR", PROJECT_ROOT / "data")).resolve()
DOWNLOADS_DIR = Path(os.getenv("EASYDL_DOWNLOADS_DIR", PROJECT_ROOT / "downloads")).resolve()

FITGIRL_INDEX_DIR = Path(os.getenv("EASYDL_INDEX_DIR", PROJECT_ROOT / "fitgirl-index")).resolve()
STORE_ROOT = FITGIRL_INDEX_DIR / "store"
META_PATH = FITGIRL_INDEX_DIR / "meta.yaml"
DB_PATH = DATA_DIR / "eazydl.db"

PACKAGE_ROOT = Path(__file__).resolve().parent
WEB_DIR = PACKAGE_ROOT / "web"
STATIC_DIR = WEB_DIR / "static"


def ensure_runtime_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
    FITGIRL_INDEX_DIR.mkdir(parents=True, exist_ok=True)
