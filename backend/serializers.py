from database import Download, LinkList
from downloader import dm
from scraper import clean_filename


def download_to_dict(d: Download) -> dict:
    live = dm.get_progress(d.id) or {}
    bytes_dl = live.get("bytes_downloaded", d.bytes_downloaded)
    total = live.get("total_bytes", d.total_bytes)
    status = live.get("status") or d.status
    return {
        "id": d.id,
        "url": d.source_url,
        "filename": (
            clean_filename(d.filename)
            or clean_filename(live.get("filename"))
            or d.filename
            or live.get("filename")
            or ""
        ),
        "status": status,
        "bytes_downloaded": bytes_dl,
        "total_bytes": total,
        "progress": live.get("progress", (bytes_dl / total * 100) if total else 0),
        "speed": live.get("speed", 0),
        "connections": live.get("connections", 0),
        "gid": live.get("gid", ""),
        "error_message": live.get("error") or (d.error_message if status == "failed" else "") or "",
    }


def list_to_dict(lst: LinkList, include_downloads: bool = False) -> dict:
    dls = lst.downloads
    total_bytes = sum(d.total_bytes or 0 for d in dls)
    dl_bytes = sum(d.bytes_downloaded or 0 for d in dls)
    completed = sum(1 for d in dls if d.status == "completed")
    data = {
        "id": lst.id,
        "name": lst.name,
        "source_url": lst.source_url or "",
        "image_url": lst.image_url or "",
        "description": lst.description or "",
        "size": lst.size or "",
        "categories": [c for c in (lst.categories or "").split("|") if c],
        "created_at": lst.created_at.isoformat() if lst.created_at else None,
        "count": len(dls),
        "completed": completed,
        "dl_ids": [d.id for d in dls],
        "total_bytes": total_bytes,
        "bytes_downloaded": dl_bytes,
    }
    if include_downloads:
        data["downloads"] = [download_to_dict(d) for d in dls]
    return data
