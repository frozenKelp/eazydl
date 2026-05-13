from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import Download, get_db
from download_service import cancel_starting_download, is_starting_download, queue_download_start
from downloader import dm
from schemas import DownloadBatch
from security import clean_download_path
from settings_service import settings_snapshot

router = APIRouter(prefix="/api")


@router.post("/downloads/{dl_id}/start")
async def api_start(dl_id: int, db: Session = Depends(get_db)):
    dl = db.query(Download).filter(Download.id == dl_id).first()
    if not dl:
        raise HTTPException(404, "Download not found.")
    base_path = clean_download_path(settings_snapshot(db).get("download_path", "downloads"))
    status = await queue_download_start(dl, db, base_path)
    if status == "queued":
        return {"status": "queued"}
    if status == "already_running":
        raise HTTPException(400, "Already running.")
    if status == "paused":
        raise HTTPException(400, "Use resume for paused downloads.")
    if status == "completed":
        raise HTTPException(400, "Download is already completed.")
    raise HTTPException(400, "Download cannot be started.")


@router.post("/downloads/{dl_id}/pause")
async def api_pause(dl_id: int, db: Session = Depends(get_db)):
    dl = db.query(Download).filter(Download.id == dl_id).first()
    if not dl:
        raise HTTPException(404, "Download not found.")
    live = dm.get_progress(dl_id)
    effective_status = (live.get("status") if live else None) or dl.status
    if effective_status not in {"downloading", "queued"} and not await is_starting_download(dl_id):
        raise HTTPException(400, "Download is not running.")
    await cancel_starting_download(dl_id)
    await dm.pause(dl_id)
    dl.status = "paused"
    db.commit()
    return {"status": "paused"}


@router.post("/downloads/{dl_id}/resume")
async def api_resume(dl_id: int, db: Session = Depends(get_db)):
    dl = db.query(Download).filter(Download.id == dl_id).first()
    if not dl:
        raise HTTPException(404, "Download not found.")
    live = dm.get_progress(dl_id)
    if live and live.get("status") == "paused":
        await dm.resume(dl_id)
        dl.status = "downloading"
        db.commit()
        return {"status": "resumed"}
    base_path = clean_download_path(settings_snapshot(db).get("download_path", "downloads"))
    status = await queue_download_start(dl, db, base_path, allow_paused=True)
    if status == "queued":
        return {"status": "queued"}
    if status == "already_running":
        return {"status": "already_running"}
    if status == "completed":
        raise HTTPException(400, "Download is already completed.")
    raise HTTPException(400, "Download cannot be resumed.")


@router.post("/downloads/batch/start")
async def api_batch_start(data: DownloadBatch, db: Session = Depends(get_db)):
    ids = list(dict.fromkeys(int(i) for i in data.ids if i))
    if not ids:
        return {"queued": 0, "skipped": 0}
    base_path = clean_download_path(settings_snapshot(db).get("download_path", "downloads"))
    rows = db.query(Download).filter(Download.id.in_(ids)).all()
    queued = 0
    skipped = 0
    for dl in rows:
        status = await queue_download_start(dl, db, base_path)
        queued += 1 if status == "queued" else 0
        skipped += 0 if status == "queued" else 1
    return {"queued": queued, "skipped": skipped, "requested": len(ids)}


@router.post("/downloads/batch/resume")
async def api_batch_resume(data: DownloadBatch, db: Session = Depends(get_db)):
    ids = list(dict.fromkeys(int(i) for i in data.ids if i))
    if not ids:
        return {"resumed": 0, "queued": 0, "skipped": 0}
    base_path = clean_download_path(settings_snapshot(db).get("download_path", "downloads"))
    rows = db.query(Download).filter(Download.id.in_(ids)).all()
    resumed = 0
    queued = 0
    skipped = 0
    for dl in rows:
        live = dm.get_progress(dl.id)
        if live and live.get("status") == "paused":
            await dm.resume(dl.id)
            dl.status = "downloading"
            resumed += 1
            continue
        status = await queue_download_start(dl, db, base_path, allow_paused=True)
        queued += 1 if status == "queued" else 0
        skipped += 0 if status == "queued" else 1
    db.commit()
    return {"resumed": resumed, "queued": queued, "skipped": skipped, "requested": len(ids)}


@router.post("/downloads/batch/pause")
async def api_batch_pause(data: DownloadBatch, db: Session = Depends(get_db)):
    ids = list(dict.fromkeys(int(i) for i in data.ids if i))
    rows = db.query(Download).filter(Download.id.in_(ids)).all() if ids else []
    paused = 0
    for dl in rows:
        live = dm.get_progress(dl.id)
        effective_status = (live.get("status") if live else None) or dl.status
        if effective_status not in {"downloading", "queued"} and not await is_starting_download(dl.id):
            continue
        await cancel_starting_download(dl.id)
        await dm.pause(dl.id)
        dl.status = "paused"
        paused += 1
    db.commit()
    return {"paused": paused, "requested": len(ids)}


@router.post("/downloads/{dl_id}/stop")
async def api_stop(dl_id: int, db: Session = Depends(get_db)):
    await cancel_starting_download(dl_id)
    await dm.stop(dl_id)
    dl = db.query(Download).filter(Download.id == dl_id).first()
    if dl:
        dl.status = "pending"
        db.commit()
    return {"status": "stopped"}


@router.delete("/downloads/{dl_id}")
async def api_delete_download(dl_id: int, db: Session = Depends(get_db)):
    dl = db.query(Download).filter(Download.id == dl_id).first()
    if not dl:
        raise HTTPException(404, "Download not found.")
    await cancel_starting_download(dl_id)
    await dm.stop(dl_id)
    db.delete(dl)
    db.commit()
    return {"status": "deleted"}
