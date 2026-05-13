from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import Download, get_db
from download_service import cancel_starting_download, is_starting_download, queue_download_start
from downloader import dm
from schemas import DownloadBatch
from security import clean_download_path
from settings_service import settings_snapshot

router = APIRouter(prefix="/api")


@router.post("/downloads/batch/start")
async def api_batch_start(data: DownloadBatch, db: Session = Depends(get_db)):
    ids = list(dict.fromkeys(int(i) for i in data.ids if i))
    if not ids:
        return {
            "queued": 0,
            "skipped": 0,
            "already_running": 0,
            "requested": 0,
            "found": 0,
            "queued_ids": [],
            "skipped_ids": [],
            "already_running_ids": [],
        }
    base_path = clean_download_path(settings_snapshot(db).get("download_path", "downloads"))
    rows = db.query(Download).filter(Download.id.in_(ids)).all()
    found_ids = {dl.id for dl in rows}
    queued_ids = []
    skipped_ids = [dl_id for dl_id in ids if dl_id not in found_ids]
    already_running_ids = []
    for dl in rows:
        status = await queue_download_start(dl, db, base_path)
        if status == "queued":
            queued_ids.append(dl.id)
        elif status == "already_running":
            already_running_ids.append(dl.id)
        else:
            skipped_ids.append(dl.id)
    return {
        "queued": len(queued_ids),
        "skipped": len(skipped_ids),
        "already_running": len(already_running_ids),
        "requested": len(ids),
        "found": len(rows),
        "queued_ids": queued_ids,
        "skipped_ids": skipped_ids,
        "already_running_ids": already_running_ids,
    }


@router.post("/downloads/batch/resume")
async def api_batch_resume(data: DownloadBatch, db: Session = Depends(get_db)):
    ids = list(dict.fromkeys(int(i) for i in data.ids if i))
    if not ids:
        return {
            "resumed": 0,
            "queued": 0,
            "skipped": 0,
            "reset": 0,
            "resumed_ids": [],
            "queued_ids": [],
            "skipped_ids": [],
            "reset_ids": [],
            "already_running_ids": [],
        }
    base_path = clean_download_path(settings_snapshot(db).get("download_path", "downloads"))
    rows = db.query(Download).filter(Download.id.in_(ids)).all()
    found_ids = {dl.id for dl in rows}
    resumed_ids = []
    queued_ids = []
    skipped_ids = [dl_id for dl_id in ids if dl_id not in found_ids]
    reset_ids = []
    already_running_ids = []
    for dl in rows:
        live = dm.get_progress(dl.id)
        effective_status = (live.get("status") if live else None) or dl.status

        # Try to resume if paused
        if effective_status == "paused":
            try:
                await dm.resume(dl.id)
                dl.status = "downloading"
                resumed_ids.append(dl.id)
            except Exception as e:
                if "invalid" in str(e).lower() or "range" in str(e).lower():
                    await dm.stop(dl.id)
                    dl.status = "pending"
                    dl.bytes_downloaded = 0
                    dl.error_message = "Resuming failed due to corrupted range data. Reset to pending."
                    reset_ids.append(dl.id)
                else:
                    skipped_ids.append(dl.id)
            continue

        # Also reset failed downloads that have range errors
        if effective_status == "error" or (effective_status == "failed" and dl.error_message and "range" in dl.error_message.lower()):
            await dm.stop(dl.id)
            dl.status = "pending"
            dl.bytes_downloaded = 0
            dl.error_message = "Reset to pending due to corrupted range data."
            reset_ids.append(dl.id)
            continue

        # Queue startable downloads
        if effective_status in {"pending", "failed", None}:
            status = await queue_download_start(dl, db, base_path, allow_paused=True)
            if status == "queued":
                queued_ids.append(dl.id)
            elif status == "already_running":
                already_running_ids.append(dl.id)
            else:
                skipped_ids.append(dl.id)
        else:
            skipped_ids.append(dl.id)
    db.commit()
    return {
        "resumed": len(resumed_ids),
        "queued": len(queued_ids),
        "skipped": len(skipped_ids),
        "reset": len(reset_ids),
        "already_running": len(already_running_ids),
        "requested": len(ids),
        "found": len(rows),
        "resumed_ids": resumed_ids,
        "queued_ids": queued_ids,
        "skipped_ids": skipped_ids,
        "reset_ids": reset_ids,
        "already_running_ids": already_running_ids,
    }


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
    effective_status = (live.get("status") if live else None) or dl.status

    # Try to resume if paused
    if effective_status == "paused":
        try:
            await dm.resume(dl_id)
            dl.status = "downloading"
            db.commit()
            return {"status": "resumed"}
        except Exception as e:
            if "invalid" in str(e).lower() or "range" in str(e).lower():
                await dm.stop(dl_id)
                dl.status = "pending"
                dl.bytes_downloaded = 0
                dl.error_message = "Resuming failed due to corrupted range data. Reset to pending."
                db.commit()
                return {"status": "reset", "error": str(e)}
            raise

    # Reset if failed due to range error
    if effective_status == "error" or (effective_status == "failed" and dl.error_message and "range" in dl.error_message.lower()):
        await dm.stop(dl_id)
        dl.status = "pending"
        dl.bytes_downloaded = 0
        dl.error_message = "Reset to pending due to corrupted range data."
        db.commit()
        return {"status": "reset"}

    # Otherwise try to start the download
    base_path = clean_download_path(settings_snapshot(db).get("download_path", "downloads"))
    status = await queue_download_start(dl, db, base_path, allow_paused=True)
    if status == "queued":
        return {"status": "queued"}
    if status == "already_running":
        return {"status": "already_running"}
    if status == "completed":
        raise HTTPException(400, "Download is already completed.")
    raise HTTPException(400, "Download cannot be resumed.")


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
