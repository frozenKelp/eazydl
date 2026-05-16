from __future__ import annotations

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route


async def list_library(request: Request) -> JSONResponse:
    return JSONResponse({"items": request.app.state.db.library_payload()})


async def add_library_item(request: Request) -> JSONResponse:
    body = await request.json()
    game_id = str(body.get("game_id") or body.get("id") or "").strip()
    if not game_id:
        return JSONResponse({"error": "game_id is required"}, status_code=400)
    store = request.app.state.index_store
    entry = store.get_entry(game_id)
    game = store.get_game(game_id)
    if not entry or not game:
        return JSONResponse({"error": "Game not found in index"}, status_code=404)
    library_id = request.app.state.db.upsert_library_item(game, str(entry["path"]))
    request.app.state.db.replace_download_links(library_id, game["id"], game.get("links") or [])
    item = request.app.state.db.row("SELECT * FROM library_items WHERE id=?", (library_id,))
    return JSONResponse({"item": item, "downloads": request.app.state.db.rows("SELECT * FROM downloads WHERE library_item_id=?", (library_id,))}, status_code=201)


async def delete_library_item(request: Request) -> JSONResponse:
    item_id = int(request.path_params["item_id"])
    request.app.state.db.execute("DELETE FROM library_items WHERE id=?", (item_id,))
    return JSONResponse({"status": "deleted"})


library_routes = [
    Route("/api/library", list_library, methods=["GET"]),
    Route("/api/library", add_library_item, methods=["POST"]),
    Route("/api/library/{item_id:int}", delete_library_item, methods=["DELETE"]),
]
