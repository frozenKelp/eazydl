import asyncio

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from config import FITGIRL_HOSTS, FUCKINGFAST_HOSTS
from database import Download, LinkList, get_db
from schemas import ScrapeRequest
from scraper import get_fitgirl_game_details, get_fuckingfast_links, search_fitgirl
from security import clean_url

router = APIRouter(prefix="/api/scrape")


@router.post("/links")
def api_scrape_links(data: ScrapeRequest, db: Session = Depends(get_db)):
    if not db.query(LinkList).filter(LinkList.id == data.list_id).first():
        raise HTTPException(404, "List not found.")
    game_url = clean_url(data.game_url, FITGIRL_HOSTS, "FitGirl URL")
    try:
        links = get_fuckingfast_links(game_url)
    except Exception as exc:
        raise HTTPException(400, str(exc))
    existing = {
        url
        for (url,) in db.query(Download.source_url).filter(Download.list_id == data.list_id).all()
    }
    added = 0
    for url in links:
        url = clean_url(url, FUCKINGFAST_HOSTS, "download link")
        if url not in existing:
            db.add(Download(list_id=data.list_id, source_url=url, status="pending"))
            existing.add(url)
            added += 1
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "One or more links already exist.")
    return {"found": len(links), "added": added, "links": links}


@router.get("/search")
async def api_scrape_search(query: str = "", page: int = 1, limit: int = 24, hydrate: bool = False):
    try:
        limit = max(1, min(int(limit or 24), 60))
        games = await asyncio.to_thread(search_fitgirl, query, page, limit, hydrate)
        return {
            "games": games,
            "page": max(1, int(page or 1)),
            "limit": limit,
            "source": "search" if query.strip() else "popular-year",
            "hydrated": hydrate,
        }
    except Exception as exc:
        raise HTTPException(400, str(exc))


@router.get("/details")
async def api_scrape_details(url: str):
    game_url = clean_url(url, FITGIRL_HOSTS, "FitGirl URL")
    try:
        return await asyncio.to_thread(get_fitgirl_game_details, game_url)
    except Exception as exc:
        raise HTTPException(400, str(exc))
