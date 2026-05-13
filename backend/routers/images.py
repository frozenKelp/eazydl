import requests
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from config import MAX_IMAGE_BYTES
from security import is_public_image_url, response_peer_is_public

router = APIRouter(prefix="/api")


def read_limited_content(resp: requests.Response) -> bytes:
    chunks: list[bytes] = []
    total = 0
    for chunk in resp.iter_content(chunk_size=64 * 1024):
        if not chunk:
            continue
        total += len(chunk)
        if total > MAX_IMAGE_BYTES:
            raise HTTPException(413, "Image is too large.")
        chunks.append(chunk)
    return b"".join(chunks)


@router.get("/image")
def api_proxy_image(url: str):
    if not is_public_image_url(url):
        raise HTTPException(400, "Unsupported image URL.")
    try:
        resp = requests.get(
            url,
            headers={
                "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                "referer": "https://fitgirl-repacks.site/",
                "user-agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/131.0.0.0 Safari/537.36"
                ),
            },
            allow_redirects=False,
            stream=True,
            timeout=10,
        )
        with resp:
            if 300 <= resp.status_code < 400:
                raise HTTPException(400, "Image redirects are not proxied.")
            if not response_peer_is_public(resp):
                raise HTTPException(400, "Image host resolved to a private address.")
            resp.raise_for_status()
            media_type = resp.headers.get("content-type", "image/jpeg").split(";", 1)[0]
            if not media_type.startswith("image/"):
                raise HTTPException(400, "URL did not return an image.")
            return Response(
                content=read_limited_content(resp),
                media_type=media_type,
                headers={"Cache-Control": "public, max-age=86400"},
            )
    except requests.RequestException as exc:
        raise HTTPException(502, f"Could not fetch image: {exc}")
