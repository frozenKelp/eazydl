import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from database import init_db
from downloader import dm
from routers import downloads, images, library, pages, scrape, settings, status
from settings_service import load_settings_cache, settings_snapshot

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    load_settings_cache()
    snapshot = settings_snapshot()

    max_concurrent = int(snapshot.get("max_concurrent", 3))
    connections_per_file = int(snapshot.get("connections_per_file", 4))

    try:
        await dm.start(
            max_concurrent=max_concurrent,
            connections_per_file=connections_per_file,
        )
        logger.info("aria2c connected and ready.")
    except RuntimeError as exc:
        logger.warning("aria2c unavailable: %s", exc)

    yield

    await dm.shutdown()
    logger.info("aria2c shut down cleanly.")


app = FastAPI(title="EasyDL", lifespan=lifespan)
app.include_router(pages.router)
app.include_router(images.router)
app.include_router(library.router)
app.include_router(downloads.router)
app.include_router(settings.router)
app.include_router(scrape.router)
app.include_router(status.router)
