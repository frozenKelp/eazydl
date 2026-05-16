from __future__ import annotations

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route


async def status(request: Request) -> JSONResponse:
    return JSONResponse(request.app.state.index_updater.status())


async def update(request: Request) -> JSONResponse:
    return JSONResponse(request.app.state.index_updater.start("update", background=True), status_code=202)


async def rebuild(request: Request) -> JSONResponse:
    return JSONResponse(request.app.state.index_updater.start("rebuild", background=True), status_code=202)


async def search(request: Request) -> JSONResponse:
    query = request.query_params.get("q", "")
    page = int(request.query_params.get("page", "1") or "1")
    limit = int(request.query_params.get("limit", "36") or "36")
    return JSONResponse(request.app.state.index_store.search(query, page, limit))


async def game(request: Request) -> JSONResponse:
    game_id = request.path_params["id_or_slug"]
    item = request.app.state.index_store.get_game(game_id)
    if not item:
        return JSONResponse({"error": "Game not found"}, status_code=404)
    return JSONResponse(item)


index_routes = [
    Route("/api/index/status", status, methods=["GET"]),
    Route("/api/index/update", update, methods=["POST"]),
    Route("/api/index/rebuild", rebuild, methods=["POST"]),
    Route("/api/index/search", search, methods=["GET"]),
    Route("/api/index/games/{id_or_slug:str}", game, methods=["GET"]),
]
