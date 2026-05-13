from fastapi import APIRouter, Body, Depends
from sqlalchemy.orm import Session

from database import get_db
from downloader import dm
from settings_service import normalize_settings, persist_settings, settings_snapshot

router = APIRouter(prefix="/api")


@router.get("/settings")
def api_get_settings(db: Session = Depends(get_db)):
    return settings_snapshot(db)


@router.put("/settings")
async def api_update_settings(data: dict = Body(...), db: Session = Depends(get_db)):
    normalized = normalize_settings(data)
    persist_settings(db, normalized)

    if "max_concurrent" in normalized:
        await dm.set_max_concurrent(int(normalized["max_concurrent"]))

    if "connections_per_file" in normalized:
        dm.set_connections_per_file(int(normalized["connections_per_file"]))

    return {"status": "updated"}
