import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from config import FITGIRL_HOSTS, FUCKINGFAST_HOSTS
from database import Download, LinkList, get_db
from download_service import cancel_starting_download
from downloader import dm
from schemas import GameAdd, LinksAdd, ListCreate
from scraper import clean_filename, get_fuckingfast_downloads
from security import clean_url
from serializers import download_to_dict, list_to_dict

router = APIRouter(prefix="/api")


@router.get("/lists")
def api_get_lists(db: Session = Depends(get_db)):
    lists = (
        db.query(LinkList)
        .options(selectinload(LinkList.downloads))
        .order_by(LinkList.created_at.desc())
        .all()
    )
    return [list_to_dict(lst) for lst in lists]


@router.get("/library")
def api_get_library(db: Session = Depends(get_db)):
    lists = (
        db.query(LinkList)
        .options(selectinload(LinkList.downloads))
        .order_by(LinkList.created_at.desc())
        .all()
    )
    return {"lists": [list_to_dict(lst, include_downloads=True) for lst in lists]}


@router.post("/lists", status_code=201)
def api_create_list(data: ListCreate, db: Session = Depends(get_db)):
    name = data.name.strip()
    if not name:
        raise HTTPException(400, "List name cannot be empty.")
    if db.query(LinkList).filter(LinkList.name == name).first():
        raise HTTPException(400, "A list with that name already exists.")
    lst = LinkList(name=name)
    db.add(lst)
    db.commit()
    db.refresh(lst)
    return {"id": lst.id, "name": lst.name}


@router.delete("/lists/{list_id}")
async def api_delete_list(list_id: int, db: Session = Depends(get_db)):
    lst = db.query(LinkList).filter(LinkList.id == list_id).first()
    if not lst:
        raise HTTPException(404, "List not found.")
    for dl in lst.downloads:
        await cancel_starting_download(dl.id)
        await dm.stop(dl.id)
    db.delete(lst)
    db.commit()
    return {"status": "deleted"}


@router.get("/lists/{list_id}/downloads")
def api_get_downloads(list_id: int, db: Session = Depends(get_db)):
    dls = (
        db.query(Download)
        .filter(Download.list_id == list_id)
        .order_by(Download.created_at)
        .all()
    )
    return [download_to_dict(d) for d in dls]


@router.post("/lists/{list_id}/links")
def api_add_links(list_id: int, data: LinksAdd, db: Session = Depends(get_db)):
    if not db.query(LinkList).filter(LinkList.id == list_id).first():
        raise HTTPException(404, "List not found.")
    existing = {
        url
        for (url,) in db.query(Download.source_url).filter(Download.list_id == list_id).all()
    }
    added = 0
    for url in data.urls:
        if not (url or "").strip():
            continue
        url = clean_url(url, FUCKINGFAST_HOSTS, "download link")
        if url and url not in existing:
            db.add(Download(list_id=list_id, source_url=url, status="pending"))
            existing.add(url)
            added += 1
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "One or more links already exist.")
    return {"added": added}


@router.post("/games", status_code=201)
def api_add_game(data: GameAdd, db: Session = Depends(get_db)):
    title = data.title.strip()[:200]
    if not title:
        raise HTTPException(400, "Title is required.")
    game_url = clean_url(data.game_url, FITGIRL_HOSTS, "FitGirl URL")

    lst = db.query(LinkList).filter(LinkList.name == title).first()
    if not lst:
        lst = LinkList(name=title)
        db.add(lst)
        db.commit()
        db.refresh(lst)

    categories = [c.strip() for c in (data.categories or []) if c and c.strip()]
    if game_url and not lst.source_url:
        lst.source_url = game_url
    if data.image_url and not lst.image_url:
        lst.image_url = data.image_url.strip()
    if data.description and not lst.description:
        lst.description = data.description.strip()[:2000]
    if data.size and not lst.size:
        lst.size = re.sub(r"^from\s+", "", data.size.strip(), flags=re.I)[:80]
    if categories and not lst.categories:
        lst.categories = "|".join(categories[:12])

    try:
        downloads = get_fuckingfast_downloads(game_url)
    except Exception as exc:
        raise HTTPException(400, str(exc))

    existing_rows = {
        d.source_url: d
        for d in db.query(Download).filter(Download.list_id == lst.id).all()
    }
    added = 0
    for item in downloads:
        url = clean_url(item["url"], FUCKINGFAST_HOSTS, "download link")
        filename = clean_filename(item.get("filename"))
        if existing := existing_rows.get(url):
            if filename and not existing.filename:
                existing.filename = filename
            continue
        db.add(
            Download(
                list_id=lst.id,
                source_url=url,
                filename=filename or "",
                status="pending",
            )
        )
        added += 1
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "One or more links already exist.")

    return {
        "id": lst.id,
        "title": title,
        "found": len(downloads),
        "added": added,
        "already_had": len(existing_rows),
    }
