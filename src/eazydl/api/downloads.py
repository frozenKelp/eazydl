from __future__ import annotations

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route


def clean_ids(value: object) -> list[int]:
    if not isinstance(value, list):
        return []
    ids: list[int] = []
    seen: set[int] = set()
    for item in value:
        try:
            number = int(item)
        except (TypeError, ValueError):
            continue
        if number > 0 and number not in seen:
            seen.add(number)
            ids.append(number)
    return ids


async def list_downloads(request: Request) -> JSONResponse:
    return JSONResponse({"items": request.app.state.downloads.all_downloads(), "stats": request.app.state.downloads.stats()})


async def batch_start(request: Request) -> JSONResponse:
    body = await request.json()
    return JSONResponse(request.app.state.downloads.start_downloads(clean_ids(body.get("ids"))))


async def batch_pause(request: Request) -> JSONResponse:
    body = await request.json()
    return JSONResponse(request.app.state.downloads.pause(clean_ids(body.get("ids"))))


async def batch_resume(request: Request) -> JSONResponse:
    body = await request.json()
    return JSONResponse(request.app.state.downloads.resume(clean_ids(body.get("ids"))))


async def batch_stop(request: Request) -> JSONResponse:
    body = await request.json()
    return JSONResponse(request.app.state.downloads.stop(clean_ids(body.get("ids"))))


download_routes = [
    Route("/api/downloads", list_downloads, methods=["GET"]),
    Route("/api/downloads/batch/start", batch_start, methods=["POST"]),
    Route("/api/downloads/batch/pause", batch_pause, methods=["POST"]),
    Route("/api/downloads/batch/resume", batch_resume, methods=["POST"]),
    Route("/api/downloads/batch/stop", batch_stop, methods=["POST"]),
]
