"""
Scraper module:
  - get_fuckingfast_links(game_url)      → list of fuckingfast.co URLs from a Fitgirl page
  - get_fuckingfast_downloads(game_url)  → list of {url, filename} dicts from a Fitgirl page
  - resolve_fuckingfast_download(ff_url) → actual direct download URL
  - resolve_fuckingfast_download_info(ff_url) → direct URL plus display filename
  - search_fitgirl(query, page)          → list of game dicts from Fitgirl search/homepage
"""

import re
import threading
from dataclasses import dataclass
from typing import Dict, List, Optional
from urllib.parse import unquote, urljoin, urlparse

import requests
from bs4 import BeautifulSoup

HEADERS: dict[str, str] = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.5",
    "referer": "https://fitgirl-repacks.site/",
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
}

ARCHIVE_RE = re.compile(
    r"(?P<name>[A-Za-z0-9][A-Za-z0-9 ._+()\[\]{}'!,&@#$%^=-]{2,240}\."
    r"(?:part\d+\.rar|rar|r\d{2}|zip|7z|iso|bin))",
    re.IGNORECASE,
)

# BUG FIX: thread-local storage gives each thread its own Session instance,
# preserving connection-pooling benefits while eliminating race conditions.
_tls = threading.local()


@dataclass
class ResolvedDownload:
    url: str
    filename: Optional[str] = None


def _get_session() -> requests.Session:
    """Return the calling thread's requests.Session, creating it on first use."""
    if not hasattr(_tls, "session"):
        s = requests.Session()
        s.headers.update(HEADERS)
        _tls.session = s
    return _tls.session


def clean_filename(value: Optional[str]) -> Optional[str]:
    """Return a safe archive-ish filename, or None if the text is not a filename."""
    if not value:
        return None
    text = unquote(str(value)).replace("\x00", " ").strip()
    text = re.sub(r"\s+", " ", text)
    text = text.split("?", 1)[0].split("#", 1)[0]
    # Strip directory/URL path pieces if a URL or path leaked in.
    text = text.rstrip("/").rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    text = text.strip(" \t\r\n'\"“”‘’<>|:")
    match = ARCHIVE_RE.search(text)
    if not match:
        return None
    name = match.group("name").strip(" .'\"")
    name = re.sub(r"^(?:download|file|filename|name)\s*[:—–-]?\s+", "", name, flags=re.I)
    return name[:240] or None


def _filename_from_content_disposition(header: Optional[str]) -> Optional[str]:
    if not header:
        return None
    # RFC 5987: filename*=UTF-8''file.rar, then plain filename="file.rar".
    match = re.search(r"filename\*=([^']*)''([^;]+)", header, re.I)
    if match:
        return clean_filename(match.group(2))
    match = re.search(r'filename="?([^";]+)"?', header, re.I)
    if match:
        return clean_filename(match.group(1))
    return None


def _best_filename_from_text(text: str) -> Optional[str]:
    names: list[str] = []
    for match in ARCHIVE_RE.finditer(unquote(text or "")):
        name = clean_filename(match.group("name"))
        if name and name not in names:
            names.append(name)
    if not names:
        return None
    # Prefer FitGirl-style names and part archives over generic page noise.
    names.sort(
        key=lambda n: (
            "fitgirl-repacks.site" not in n.lower(),
            ".part" not in n.lower(),
            len(n),
        )
    )
    return names[0]


def _filename_from_ff_page(soup: BeautifulSoup, html: str) -> Optional[str]:
    selectors = [
        "[download]",
        ".filename",
        ".file-name",
        ".file_name",
        "#filename",
        "#file-name",
        "h1",
        "h2",
        "title",
    ]
    for selector in selectors:
        for node in soup.select(selector):
            for value in (node.get("download"), node.get("title"), node.get_text(" ", strip=True)):
                if name := clean_filename(value):
                    return name
    return _best_filename_from_text(soup.get_text(" ", strip=True)) or _best_filename_from_text(html)


def _image_from_article(article, base_url: str) -> Optional[str]:
    """Extract the most likely post thumbnail from a WordPress/FitGirl article."""
    img_tag = (
        article.find("img", class_=re.compile(r"wp-post-image|attachment-", re.I))
        or article.select_one(".entry-content img, .post-thumbnail img, figure img")
        or article.find("img")
    )
    if not img_tag:
        return None

    # Lazy-load plugins disagree on attributes. Prefer real/lazy srcset because
    # FitGirl thumbnails commonly come through WordPress/i0.wp.com there.
    for attr in ("data-src", "data-lazy-src", "data-original", "data-orig-file", "src"):
        value = img_tag.get(attr)
        if value and not value.startswith("data:"):
            return urljoin(base_url, value)

    for attr in ("data-srcset", "data-lazy-srcset", "srcset"):
        srcset = img_tag.get(attr)
        if not srcset:
            continue
        # Use the last candidate: it is usually the largest thumbnail.
        candidates = [part.strip().split(" ", 1)[0] for part in srcset.split(",") if part.strip()]
        candidates = [c for c in candidates if c and not c.startswith("data:")]
        if candidates:
            return urljoin(base_url, candidates[-1])

    return None


def get_fuckingfast_downloads(game_url: str) -> List[Dict[str, Optional[str]]]:
    """
    Given a FitGirl game-page URL, return fuckingfast.co links plus the human
    filename displayed next to each link when FitGirl exposes it.
    """
    session = _get_session()
    resp = session.get(game_url, timeout=15)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    downloads: List[Dict[str, Optional[str]]] = []
    seen: set[str] = set()
    containers = soup.find_all("div", class_="dlinks") or [soup]
    for div in containers:
        for a in div.find_all("a", href=True):
            href: str = urljoin(game_url, a["href"])
            host = (urlparse(href).hostname or "").lower()
            if host not in {"fuckingfast.co", "www.fuckingfast.co"} or href in seen:
                continue
            seen.add(href)
            filename = clean_filename(a.get_text(" ", strip=True))
            if not filename:
                # Some mirrors put the name in the surrounding table row/list item.
                parent = a.find_parent(["tr", "li", "p", "div"])
                filename = clean_filename(parent.get_text(" ", strip=True) if parent else None)
            downloads.append({"url": href, "filename": filename})

    if not downloads:
        raise ValueError(
            "No fuckingfast.co links found on that page. "
            "Make sure it's a valid FitGirl game URL."
        )
    return downloads


def get_fuckingfast_links(game_url: str) -> List[str]:
    """Backward-compatible URL-only wrapper around get_fuckingfast_downloads()."""
    return [item["url"] for item in get_fuckingfast_downloads(game_url)]


def resolve_fuckingfast_download_info(ff_url: str) -> ResolvedDownload:
    """
    Given a fuckingfast.co link, return the actual direct download URL and the
    display filename from the FuckingFast page when available.
    """
    session = _get_session()
    resp = session.get(ff_url, timeout=15)
    resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "html.parser")
    filename = _filename_from_content_disposition(resp.headers.get("content-disposition"))
    filename = filename or _filename_from_ff_page(soup, resp.text)

    # Strategy 1: find window.open(...) in any <script> tag
    for script in soup.find_all("script"):
        text = script.string or script.get_text("\n") or ""
        m = re.search(r"window\.open\(['\"]+(https?://[^'\")\s]+)", text)
        if m:
            return ResolvedDownload(m.group(1), filename)

    # Strategy 2: look for a direct download anchor
    for a in soup.find_all("a", href=True):
        href: str = urljoin(ff_url, a["href"])
        anchor_name = clean_filename(a.get("download")) or clean_filename(a.get_text(" ", strip=True))
        if any(href.lower().split("?", 1)[0].endswith(ext) for ext in (".zip", ".rar", ".iso", ".7z")):
            return ResolvedDownload(href, filename or anchor_name or clean_filename(href))
        # Part files like .part1.rar, .r00 etc.
        if re.search(r"\.(part\d+\.rar|r\d{2})(?:[?#].*)?$", href, re.I):
            return ResolvedDownload(href, filename or anchor_name or clean_filename(href))

    raise ValueError(
        f"Could not resolve a direct download URL from: {ff_url}\n"
        "The page structure may have changed."
    )


def resolve_fuckingfast_download(ff_url: str) -> str:
    """Backward-compatible URL-only wrapper around resolve_fuckingfast_download_info()."""
    return resolve_fuckingfast_download_info(ff_url).url


def search_fitgirl(query: str = "", page: int = 1) -> List[Dict]:
    """
    Search FitGirl repacks or browse the homepage.
    Returns a list of dicts: {title, url, image, excerpt}
    """
    session = _get_session()

    if query.strip():
        url = f"https://fitgirl-repacks.site/?s={requests.utils.quote(query)}"
    elif page > 1:
        url = f"https://fitgirl-repacks.site/page/{page}/"
    else:
        url = "https://fitgirl-repacks.site/"

    resp = session.get(url, timeout=15)
    resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "html.parser")
    games: List[Dict] = []

    for article in soup.find_all("article", limit=24):
        title_tag = article.find(["h1", "h2"], class_="entry-title")
        if not title_tag:
            continue
        link_tag = title_tag.find("a")
        if not link_tag:
            continue

        title: str = link_tag.get_text(strip=True)
        game_url: str = link_tag["href"]
        image = _image_from_article(article, game_url)

        # Short excerpt
        content_div = article.find("div", class_="entry-content")
        excerpt = ""
        if content_div:
            excerpt = content_div.get_text(" ", strip=True)[:220]

        games.append({"title": title, "url": game_url, "image": image, "excerpt": excerpt})

    return games
