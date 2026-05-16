from __future__ import annotations

from pathlib import Path

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route


ALLOWED = {
    "download_path",
    "max_concurrent",
    "connections_per_file",
    "auto_update_on_start",
    "index_update_ttl_hours",
}


def normalize(body: dict[str, object]) -> dict[str, str]:
    values: dict[str, str] = {}
    for key, raw in body.items():
        if key not in ALLOWED:
            continue
        text = str(raw).strip()
        if key in {"max_concurrent", "connections_per_file"}:
            number = max(1, min(32, int(text)))
            values[key] = str(number)
        elif key == "index_update_ttl_hours":
            values[key] = str(max(1, min(720, int(text))))
        elif key == "download_path":
            values[key] = str(Path(text).expanduser().resolve())
        else:
            values[key] = "true" if text.lower() in {"1", "true", "yes", "on"} else "false"
    return values


async def get_settings(request: Request) -> JSONResponse:
    return JSONResponse(request.app.state.db.get_settings())


async def put_settings(request: Request) -> JSONResponse:
    body = await request.json()
    if not isinstance(body, dict):
        return JSONResponse({"error": "Settings body must be an object"}, status_code=400)
    try:
        values = normalize(body)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    return JSONResponse(request.app.state.db.update_settings(values))


settings_routes = [
    Route("/api/settings", get_settings, methods=["GET"]),
    Route("/api/settings", put_settings, methods=["PUT"]),
]
