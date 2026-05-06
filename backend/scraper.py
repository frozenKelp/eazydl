"""
Scraper module:
  - get_fuckingfast_links(game_url)      → list of fuckingfast.co URLs from a Fitgirl page
  - resolve_fuckingfast_download(ff_url) → actual direct download URL
  - search_fitgirl(query, page)          → list of game dicts from Fitgirl search/homepage

Bug fixed vs. original:
  - A single module-level requests.Session was shared across threads.
    asyncio.to_thread() dispatches calls to a thread-pool, so concurrent
    scrape/resolve calls could corrupt the session's internal state (cookies,
    redirects, keep-alive connections).  Each public function now gets its
    own Session via _get_session(), which uses threading.local() so sessions
    are created once per worker thread and then safely reused within that thread.
"""

import re
import threading
from typing import Dict, List, Optional

import requests
from bs4 import BeautifulSoup

HEADERS: dict[str, str] = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.5",
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
}

# BUG FIX: thread-local storage gives each thread its own Session instance,
# preserving connection-pooling benefits while eliminating race conditions.
_tls = threading.local()


def _get_session() -> requests.Session:
    """Return the calling thread's requests.Session, creating it on first use."""
    if not hasattr(_tls, "session"):
        s = requests.Session()
        s.headers.update(HEADERS)
        _tls.session = s
    return _tls.session


def get_fuckingfast_links(game_url: str) -> List[str]:
    """
    Given a Fitgirl game-page URL, return all fuckingfast.co download links.
    These are found inside <div class="dlinks"> elements.
    """
    session = _get_session()
    resp = session.get(game_url, timeout=15)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    links: List[str] = []
    for div in soup.find_all("div", class_="dlinks"):
        for a in div.find_all("a", href=True):
            href: str = a["href"]
            if href.startswith("https://fuckingfast.co/"):
                links.append(href)

    if not links:
        raise ValueError(
            "No fuckingfast.co links found on that page. "
            "Make sure it's a valid Fitgirl game URL."
        )
    return links


def resolve_fuckingfast_download(ff_url: str) -> str:
    """
    Given a fuckingfast.co link, return the actual direct download URL.
    The page embeds a JavaScript function that calls window.open(url).
    """
    session = _get_session()
    referer_headers = {"referer": "https://fitgirl-repacks.site/"}
    resp = session.get(ff_url, headers=referer_headers, timeout=15)
    resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "html.parser")

    # Strategy 1: find window.open(...) in any <script> tag
    for script in soup.find_all("script"):
        text = script.string or ""
        m = re.search(r"window\.open\(['\"]+(https?://[^'\")\s]+)", text)
        if m:
            return m.group(1)

    # Strategy 2: look for a direct download anchor
    for a in soup.find_all("a", href=True):
        href: str = a["href"]
        if any(href.lower().endswith(ext) for ext in (".zip", ".rar", ".iso", ".7z")):
            return href
        # Part files like .part1.rar, .r00 etc.
        if re.search(r"\.(part\d+\.rar|r\d{2})$", href, re.I):
            return href

    raise ValueError(
        f"Could not resolve a direct download URL from: {ff_url}\n"
        "The page structure may have changed."
    )


def search_fitgirl(query: str = "", page: int = 1) -> List[Dict]:
    """
    Search Fitgirl repacks or browse the homepage.
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

        # Thumbnail — try data-src first (lazy-loaded), then src
        img_tag = article.find("img")
        image: Optional[str] = None
        if img_tag:
            image = img_tag.get("data-src") or img_tag.get("src")

        # Short excerpt
        content_div = article.find("div", class_="entry-content")
        excerpt = ""
        if content_div:
            excerpt = content_div.get_text(" ", strip=True)[:220]

        games.append({"title": title, "url": game_url, "image": image, "excerpt": excerpt})

    return games
