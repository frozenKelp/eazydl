from __future__ import annotations

import html
import re
from pathlib import Path
from urllib.parse import unquote, urlparse

import requests


HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


def clean_filename(value: str | None) -> str:
    text = html.unescape(str(value or "")).strip()
    text = re.sub(r"[\\/:*?\"<>|]+", "_", text)
    text = re.sub(r"\s+", " ", text).strip(" .")
    return text[:220] or "download.bin"


def filename_from_url(url: str) -> str:
    parsed = urlparse(url)
    fragment = unquote(parsed.fragment or "")
    if fragment:
        return clean_filename(Path(fragment).name)
    name = unquote(Path(parsed.path).name)
    return clean_filename(name or "download.bin")


def resolve_fuckingfast(url: str) -> dict[str, str]:
    response = requests.get(url, headers=HEADERS, timeout=30)
    response.raise_for_status()
    text = response.text

    patterns = [
        r"""https://fuckingfast\.co/dl/[A-Za-z0-9_./?=&%-]+""",
        r"""["'](https://[^"']+/dl/[^"']+)["']""",
        r"""href=["']([^"']+/dl/[^"']+)["']""",
    ]
    direct_url = ""
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            direct_url = match.group(1) if match.lastindex else match.group(0)
            break

    if direct_url.startswith("/"):
        parsed = urlparse(url)
        direct_url = f"{parsed.scheme}://{parsed.netloc}{direct_url}"
    if not direct_url:
        direct_url = url

    filename = filename_from_url(url)
    cd = response.headers.get("content-disposition", "")
    cd_match = re.search(r'filename="?([^";]+)"?', cd, re.IGNORECASE)
    if cd_match:
        filename = clean_filename(cd_match.group(1))

    return {"url": direct_url, "filename": filename}
