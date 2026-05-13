import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from config import FRONTEND_DIR

router = APIRouter()

MEDIA_TYPES = {
    ".css": "text/css",
    ".js": "application/javascript",
    ".svg": "image/svg+xml",
    ".html": "text/html",
}


def frontend_path(*parts: str) -> str:
    root = os.path.abspath(FRONTEND_DIR)
    path = os.path.abspath(os.path.join(root, *parts))
    if path != root and not path.startswith(root + os.sep):
        raise HTTPException(404, "File not found")
    return path


def read_file(path: str, media_type: str, cache_seconds: int = 0) -> Response:
    try:
        stat = os.stat(path)
        with open(path, encoding="utf-8") as f:
            headers = {
                "Cache-Control": (
                    f"public, max-age={cache_seconds}"
                    if cache_seconds > 0
                    else "no-cache"
                ),
                "ETag": f'W/"{int(stat.st_mtime)}-{stat.st_size}"',
            }
            return Response(content=f.read(), media_type=media_type, headers=headers)
    except FileNotFoundError:
        raise HTTPException(404, "File not found")


@router.get("/")
def serve_root():
    return read_file(frontend_path("library.html"), "text/html")


@router.get("/library")
def serve_library_page():
    return read_file(frontend_path("library.html"), "text/html")


@router.get("/browse")
def serve_browse_page():
    return read_file(frontend_path("browse.html"), "text/html")


@router.get("/settings")
def serve_settings_page():
    return read_file(frontend_path("settings.html"), "text/html")


@router.get("/css/{file_path:path}")
def serve_css(file_path: str):
    if not file_path.endswith(".css"):
        raise HTTPException(404)
    return read_file(frontend_path("css", file_path), "text/css", 3600)


@router.get("/js/{file_path:path}")
def serve_js(file_path: str):
    if not file_path.endswith(".js"):
        raise HTTPException(404)
    return read_file(frontend_path("js", file_path), "application/javascript", 3600)


@router.get("/favicon.svg")
def serve_favicon():
    return read_file(frontend_path("favicon.svg"), "image/svg+xml", 86400)
