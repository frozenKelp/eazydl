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
from concurrent.futures import ThreadPoolExecutor, as_completed
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


GAME_CATEGORIES = {
    "lossless repack",
    "hypervisor bypass",
    "switch emulated",
}
SKIP_CATEGORIES = {
    "uncategorized",
    "updates digest",
}
STOP_EXCERPT_MARKERS = (
    "download mirrors",
    "download mirror",
    "filehoster:",
    "backwards compatibility",
    "problems during installation",
    "selective download",
)
STOPWORDS = {"a", "an", "and", "for", "of", "the", "to", "with", "in", "on", "pc", "game"}


def _article_categories(article) -> list[str]:
    return [
        node.get_text(" ", strip=True)
        for node in article.select('.cat-links a, a[rel="category tag"]')
    ]


def _is_game_article(article) -> bool:
    cats = {cat.lower() for cat in _article_categories(article)}
    if cats & SKIP_CATEGORIES:
        return False
    return bool(cats & GAME_CATEGORIES)


def _query_tokens(query: str) -> list[str]:
    tokens = []
    for raw in re.findall(r"[a-z0-9]+", query.lower()):
        if raw in STOPWORDS or len(raw) < 2:
            continue
        # A tiny singularization handles queries like "assassin" vs "assassins"
        # without fuzzy-matching unrelated words like "need" and "needy".
        token = raw[:-1] if len(raw) > 4 and raw.endswith("s") else raw
        tokens.append(token)
    return tokens


def _matches_query(title: str, query: str) -> bool:
    tokens = _query_tokens(query)
    if not tokens:
        return True
    normalized_title = " ".join(
        token[:-1] if len(token) > 4 and token.endswith("s") else token
        for token in re.findall(r"[a-z0-9]+", title.lower())
    )
    title_words = set(normalized_title.split())
    return all(token in title_words or token in normalized_title for token in tokens)


def _clean_excerpt(text: str) -> str:
    text = re.sub(r"\s+", " ", text or " ").strip()
    lower = text.lower()
    cut_at = len(text)
    for marker in STOP_EXCERPT_MARKERS:
        idx = lower.find(marker)
        if idx != -1:
            cut_at = min(cut_at, idx)
    text = text[:cut_at].strip(" -–—|\n\t")
    text = re.sub(r"#\d+\s*", "", text)
    return text[:260].rstrip(" ,;:-–—")


def _excerpt_from_article(article) -> str:
    content = article.find("div", class_="entry-content")
    if not content:
        return ""
    # Prefer the first meaningful paragraph. FitGirl game posts put genres,
    # companies, languages, and sizes there; download links come later.
    for node in content.find_all(["p", "div"], recursive=False):
        text = _clean_excerpt(node.get_text(" ", strip=True))
        if len(text) > 30:
            return text
    return _clean_excerpt(content.get_text(" ", strip=True))


def _enrich_game(game: Dict) -> Dict:
    if game.get("image") and game.get("excerpt"):
        return game
    session = _get_session()
    resp = session.get(game["url"], timeout=15)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    article = soup.find("article") or soup
    if not _is_game_article(article):
        game["is_game"] = False
        return game
    if not game.get("image"):
        game["image"] = _image_from_article(article, game["url"])
    if not game.get("excerpt"):
        game["excerpt"] = _excerpt_from_article(article)
    game["categories"] = _article_categories(article)
    game["is_game"] = True
    return game


def _enrich_games(games: list[Dict]) -> list[Dict]:
    enriched: list[Optional[Dict]] = [None] * len(games)
    with ThreadPoolExecutor(max_workers=min(6, max(1, len(games)))) as pool:
        futures = {pool.submit(_enrich_game, dict(game)): idx for idx, game in enumerate(games)}
        for future in as_completed(futures):
            idx = futures[future]
            try:
                enriched[idx] = future.result()
            except Exception:
                # Keep the base search card rather than making the whole Browse
                # request fail because one detail page timed out.
                enriched[idx] = games[idx]
    return [game for game in enriched if game and game.get("is_game", True)]


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
    Returns game-only dicts: {title, url, image, excerpt, categories}.
    """
    session = _get_session()
    query = query.strip()

    if query:
        url = f"https://fitgirl-repacks.site/?s={requests.utils.quote(query)}"
    elif page > 1:
        url = f"https://fitgirl-repacks.site/page/{page}/"
    else:
        url = "https://fitgirl-repacks.site/"

    resp = session.get(url, timeout=15)
    resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "html.parser")
    games: List[Dict] = []

    for article in soup.find_all("article", limit=32):
        if not _is_game_article(article):
            continue

        title_tag = article.find(["h1", "h2"], class_="entry-title")
        if not title_tag:
            continue
        link_tag = title_tag.find("a")
        if not link_tag:
            continue

        title: str = link_tag.get_text(" ", strip=True)
        if not _matches_query(title, query):
            continue

        game_url: str = urljoin(url, link_tag["href"])
        games.append({
            "title": title,
            "url": game_url,
            "image": _image_from_article(article, game_url),
            "excerpt": _excerpt_from_article(article),
            "categories": _article_categories(article),
            "is_game": True,
        })
        if len(games) >= 12:
            break

    # Search result pages often omit thumbnails/excerpts, so hydrate those cards
    # from their individual game pages. Homepage cards are already hydrated, but
    # this also fills any missing fields there.
    games = _enrich_games(games)
    for game in games:
        game.pop("is_game", None)
    return games
