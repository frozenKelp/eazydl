from __future__ import annotations

import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Iterator, Mapping, cast
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

try:
    from ..paths import STORE_ROOT as APP_STORE_ROOT
except ImportError:
    APP_STORE_ROOT = Path("store")

STORE_ROOT = Path(os.getenv("CRAWLER_STORE_ROOT", str(APP_STORE_ROOT)))
STORE_DIR = STORE_ROOT / "games"
INDEX_PATH = STORE_ROOT / "index.json"
TAXONOMIES_PATH = STORE_ROOT / "taxonomies.json"

DELAY_MS = int(os.getenv("CRAWLER_DELAY_MS", "3000"))
CHECKPOINT = int(os.getenv("CRAWLER_CHECKPOINT", "250"))
TIMEOUT_MS = int(os.getenv("CRAWLER_TIMEOUT_MS", "20000"))
REQUEST_RETRIES = int(os.getenv("CRAWLER_REQUEST_RETRIES", "3"))
BACKOFF_MS = int(os.getenv("CRAWLER_BACKOFF_MS", "10000"))
DEFAULT_LIMIT = int(os.getenv("CRAWLER_LIMIT", "0"))
DEFAULT_START_PAGE = int(os.getenv("CRAWLER_START_PAGE", "1"))
DEFAULT_MAX_PAGES = int(os.getenv("CRAWLER_MAX_PAGES", "0"))
DEFAULT_SOURCE = os.getenv("CRAWLER_SOURCE", "wp-api")
DEFAULT_LOCAL_DIR = os.getenv("CRAWLER_LOCAL_DIR", "saved_pages")
DEFAULT_HTTP_CLIENT = os.getenv("CRAWLER_HTTP_CLIENT", "curl")
DEFAULT_PROGRESS_EVERY = int(os.getenv("CRAWLER_PROGRESS_EVERY", "500"))
DEFAULT_UPDATE_MAX_PAGES = int(os.getenv("CRAWLER_UPDATE_MAX_PAGES", "2"))

FITGIRL_ROOT = "https://fitgirl-repacks.site"
SITEMAP_INDEX = f"{FITGIRL_ROOT}/sitemap_index.xml"
WP_POSTS_API = f"{FITGIRL_ROOT}/wp-json/wp/v2/posts"
DIRECT_HOST = "fuckingfast.co"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": FITGIRL_ROOT,
}

XML_ACCEPT = "application/xml,text/xml;q=0.9,*/*;q=0.8"
JSON_ACCEPT = "application/json,*/*;q=0.8"
URL_RE = re.compile(r"https?://[^\s<>\"]+")
SIZE_RE = re.compile(
    r"(?:from\s+)?"
    r"[0-9][0-9.,]*"
    r"(?:\s*(?:-|\u2013|to|/)\s*[0-9][0-9.,]*)?"
    r"\s*(?:KB|MB|GB|TB)"
    r"(?:\s*(?:/|,|\+|and)\s*[0-9][0-9.,]*(?:\s*(?:KB|MB|GB|TB))?)*",
    re.IGNORECASE,
)

JsonDict = dict[str, Any]
TaxonomyMaps = dict[str, dict[str, str]]


def configure_output_streams() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(errors="replace")


configure_output_streams()


class ChallengeError(RuntimeError):
    """Raised when the origin returns an anti-bot challenge instead of data."""


class CurlResponse:
    def __init__(self, url: str, status_code: int, headers: dict[str, str], text: str) -> None:
        self.url = url
        self.status_code = status_code
        self.headers = headers
        self.text = text

    def json(self) -> Any:
        return json.loads(self.text)

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} Error for url: {self.url}")


@dataclass
class IndexedLink:
    url: str
    filename: str | None


@dataclass
class IndexedGame:
    id: str
    title: str
    source_url: str
    image_url: str | None
    original_size: str | None
    repack_size: str
    category_ids: list[int]
    tag_ids: list[int]
    description: str | None
    updated_at: str
    links: list[IndexedLink]


@dataclass
class ParsedGame:
    game: IndexedGame
    visible_tag_names: list[str]


def empty_int_list() -> list[int]:
    return []


def empty_str_list() -> list[str]:
    return []


@dataclass
class ParsedPost:
    title: str
    source_url: str
    content_html: str
    modified_at: str | None = None
    category_ids: list[int] = field(default_factory=empty_int_list)
    tag_ids: list[int] = field(default_factory=empty_int_list)
    category_names: list[str] = field(default_factory=empty_str_list)
    tag_names: list[str] = field(default_factory=empty_str_list)


@dataclass
class CrawlerReport:
    inspected: int = 0
    new: int = 0
    updated: int = 0
    skipped: int = 0
    total: int = 0
    index_written: bool = False
    taxonomies_written: bool = False
    stopped_reason: str | None = None
    new_games: list[str] = field(default_factory=empty_str_list)
    updated_games: list[dict[str, Any]] = field(default_factory=list)
    started_at: str = field(default_factory=lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    finished_at: str = ""

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def configure_store_root(store_root: str | Path) -> None:
    global STORE_ROOT, STORE_DIR, INDEX_PATH, TAXONOMIES_PATH
    STORE_ROOT = Path(store_root)
    STORE_DIR = STORE_ROOT / "games"
    INDEX_PATH = STORE_ROOT / "index.json"
    TAXONOMIES_PATH = STORE_ROOT / "taxonomies.json"


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", html.unescape(str(value or ""))).strip()


def attr_as_str(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, list) and value and isinstance(value[0], str):
        return value[0]
    return None


def unique_clean(values: list[Any] | None) -> list[str]:
    unique: list[str] = []
    seen: set[str] = set()
    for value in values or []:
        cleaned = clean_text(value)
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            unique.append(cleaned)
    return unique


def id_list(values: Any) -> list[int]:
    ids: list[int] = []
    seen: set[int] = set()
    if not isinstance(values, list):
        return ids
    for value in cast(list[Any], values):
        try:
            term_id = int(value)
        except (TypeError, ValueError):
            continue
        if term_id not in seen:
            seen.add(term_id)
            ids.append(term_id)
    return ids


def slugify(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return slug[:120]


def slug_from_url(url: str) -> str | None:
    path = urlparse(url).path.strip("/")
    if not path:
        return None
    return slugify(path.split("/")[-1])


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class Fetcher:
    def __init__(self, http_client: str = DEFAULT_HTTP_CLIENT) -> None:
        self.http_client = http_client
        self.session = requests.Session()
        self.session.headers.update(HEADERS)

    def get(self, url: str, *, accept: str | None = None) -> requests.Response | CurlResponse:
        last_error: Exception | None = None
        for attempt in range(1, REQUEST_RETRIES + 1):
            try:
                response = curl_get(url, accept=accept) if self.http_client == "curl" else self.requests_get(url, accept)

                if is_challenge_response(response):
                    last_error = ChallengeError(
                        f"anti-bot challenge from {url} (HTTP {response.status_code})"
                    )
                    if attempt == REQUEST_RETRIES:
                        break
                    sleep_for_retry(attempt, str(last_error))
                    continue

                if response.status_code in {429, 500, 502, 503, 504}:
                    last_error = requests.HTTPError(f"temporary HTTP {response.status_code} from {url}")
                    if attempt == REQUEST_RETRIES:
                        break
                    sleep_for_retry(attempt, str(last_error))
                    continue

                response.raise_for_status()
                return response
            except requests.RequestException as exc:
                last_error = exc
                if attempt == REQUEST_RETRIES:
                    break
                sleep_for_retry(attempt, f"{type(exc).__name__}: {exc}")

        if last_error:
            raise last_error
        raise RuntimeError(f"Could not fetch {url}")

    def requests_get(self, url: str, accept: str | None) -> requests.Response:
        headers = {"Accept": accept} if accept else None
        return self.session.get(url, headers=headers, timeout=max(5, TIMEOUT_MS // 1000))


def sleep_for_retry(attempt: int, reason: str) -> None:
    delay = (BACKOFF_MS / 1000) * (2 ** (attempt - 1))
    print(f"  Retry in {delay:.1f}s: {reason}")
    time.sleep(delay)


def sleep_between_requests() -> None:
    if DELAY_MS > 0:
        time.sleep(DELAY_MS / 1000)


def parse_curl_headers(raw_headers: str) -> dict[str, str]:
    headers: dict[str, str] = {}
    blocks = [block for block in re.split(r"\r?\n\r?\n", raw_headers.strip()) if block.strip()]
    if not blocks:
        return headers
    for line in blocks[-1].splitlines()[1:]:
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        headers[key.strip().lower()] = value.strip()
    return headers


def header_value(headers: Mapping[str, str], key: str, default: str = "") -> str:
    return headers.get(key, headers.get(key.lower(), default))


def curl_get(url: str, *, accept: str | None = None) -> CurlResponse:
    curl_bin = shutil.which("curl.exe") or shutil.which("curl")
    if not curl_bin:
        raise RuntimeError("curl executable was not found on PATH")

    timeout = str(max(5, TIMEOUT_MS // 1000))
    with TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        body_path = temp_path / "body.out"
        headers_path = temp_path / "headers.out"
        cmd = [
            curl_bin,
            "-L",
            "--silent",
            "--show-error",
            "--compressed",
            "--connect-timeout",
            timeout,
            "--max-time",
            timeout,
            "-D",
            str(headers_path),
            "-o",
            str(body_path),
            "--write-out",
            "%{http_code}",
        ]
        if accept:
            cmd.extend(["-H", f"Accept: {accept}"])
        cmd.append(url)

        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            raise requests.RequestException(result.stderr.strip() or f"curl exited {result.returncode}")

        status_text = result.stdout.strip() or "0"
        status_code = int(status_text[-3:]) if status_text[-3:].isdigit() else 0
        body = body_path.read_text(encoding="utf-8-sig", errors="replace") if body_path.exists() else ""
        raw_headers = headers_path.read_text(encoding="utf-8-sig", errors="replace") if headers_path.exists() else ""
        return CurlResponse(url, status_code, parse_curl_headers(raw_headers), body)


def is_challenge_response(response: requests.Response | CurlResponse) -> bool:
    text = response.text[:2000].lower()
    return (
        response.status_code in {403, 429}
        and (
            "ddos-guard" in text
            or "/.well-known/ddos-guard/" in text
            or "checking your browser before accessing" in text
        )
    )


def fetch_text(url: str, fetcher: Fetcher | None = None, *, accept: str | None = None) -> str:
    return (fetcher or Fetcher()).get(url, accept=accept).text


def extract_locs(xml_or_html: str) -> list[str]:
    try:
        root = ET.fromstring(xml_or_html)
    except ET.ParseError:
        return [m.strip() for m in re.findall(r"<loc>([^<]+)</loc>", xml_or_html) if m.strip()]

    locs: list[str] = []
    for element in root.iter():
        if element.tag.endswith("loc") and element.text:
            loc = element.text.strip()
            if loc:
                locs.append(loc)
    return locs


def normalize_wrapped_urls(text: str) -> str:
    return re.sub(r"(?<=fitgirl-)\s+(?=repacks\.site)", "", text)


def extract_urls(xml_or_text: str) -> list[str]:
    text = normalize_wrapped_urls(xml_or_text)
    urls = extract_locs(text)
    urls.extend(URL_RE.findall(text))

    unique: list[str] = []
    seen: set[str] = set()
    for url in urls:
        cleaned = html.unescape(url).rstrip(").,]>\"'")
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            unique.append(cleaned)
    return unique


def is_likely_game_url(url: str) -> bool:
    excluded_parts = (
        "/category/",
        "/tag/",
        "/page/",
        "/author/",
        "sitemap",
        "updates-digest",
        "upcoming-repacks",
    )
    return url != f"{FITGIRL_ROOT}/" and not any(part in url for part in excluded_parts)


def is_post_sitemap_url(url: str) -> bool:
    return bool(re.search(r"/post-sitemap\d*\.xml$", url))


def iter_local_sitemap_files(path: Path) -> Iterator[Path]:
    suffixes = {".xml", ".html", ".htm", ".txt"}
    if path.is_file():
        yield path
        return
    if not path.exists():
        raise FileNotFoundError(f"Local sitemap path does not exist: {path}")
    for item in sorted(path.rglob("*")):
        if item.is_file() and item.suffix.lower() in suffixes:
            yield item


def iter_local_sitemap_urls(path: Path, *, url_filter: str = "all") -> Iterator[str]:
    seen: set[str] = set()
    for file_path in iter_local_sitemap_files(path):
        try:
            text = file_path.read_text(encoding="utf-8", errors="replace")
        except Exception as exc:
            print(f"  Skipping {file_path}: {exc}")
            continue
        for url in extract_urls(text):
            if not url.startswith(FITGIRL_ROOT):
                continue
            if url_filter == "post-sitemaps" and not is_post_sitemap_url(url):
                continue
            if url_filter == "games" and not is_likely_game_url(url):
                continue
            if url not in seen:
                seen.add(url)
                yield url


def get_game_urls(fetcher: Fetcher) -> list[str]:
    sitemap_urls: list[str] = []
    try:
        sitemap_urls = [
            url
            for url in extract_locs(fetch_text(SITEMAP_INDEX, fetcher, accept=XML_ACCEPT))
            if is_post_sitemap_url(url)
        ]
    except Exception as exc:
        print(f"Could not fetch sitemap index: {exc}")

    if not sitemap_urls:
        sitemap_urls = [f"{FITGIRL_ROOT}/post-sitemap{'' if i == 1 else i}.xml" for i in range(1, 21)]

    urls: list[str] = []
    for sitemap in sorted(set(sitemap_urls)):
        try:
            found = [
                url
                for url in extract_locs(fetch_text(sitemap, fetcher, accept=XML_ACCEPT))
                if url.startswith(FITGIRL_ROOT) and is_likely_game_url(url)
            ]
            print(f"  {sitemap} -> {len(found)} URLs")
            urls.extend(found)
        except Exception as exc:
            print(f"  Skipping {sitemap}: {exc}")
        sleep_between_requests()

    unique = sorted(set(urls))
    if not unique:
        raise RuntimeError("Zero game URLs discovered from sitemaps.")
    return unique


def extract_blocks(soup: BeautifulSoup) -> list[str]:
    blocks: list[str] = []
    for element in soup.select("h1, h2, h3, h4, p, li"):
        text = clean_text(element.get_text(" ", strip=True))
        if text:
            blocks.append(text)
    blocks.append(clean_text(soup.get_text(" ", strip=True)))
    return blocks


def normalize_size(value: str) -> str:
    return re.sub(r"^from\s+", "", clean_text(value), flags=re.IGNORECASE)


def extract_size_by_label(soup: BeautifulSoup, label: str) -> str | None:
    label_re = re.compile(rf"\b{re.escape(label)}\s*:?", re.IGNORECASE)
    for text in extract_blocks(soup):
        match = label_re.search(text)
        if not match:
            continue
        after_label = text[match.end() : match.end() + 160]
        size_match = SIZE_RE.search(after_label)
        if size_match:
            return normalize_size(size_match.group(0))
    return None


def extract_tag_names(soup: BeautifulSoup) -> list[str]:
    names: list[str] = []
    stop_labels = re.compile(
        r"\b(?:Companies?|Languages?|Original Size|Repack Size|Download Mirrors|Screenshots)\b",
        re.IGNORECASE,
    )

    for element in soup.select("p, li"):
        text = clean_text(element.get_text(" ", strip=True))
        if not re.search(r"\bGenres/Tags\s*:?", text, re.IGNORECASE):
            continue
        linked_names = [
            clean_text(a.get_text(" ", strip=True))
            for a in element.select('a[href*="/tag/"]')
            if clean_text(a.get_text(" ", strip=True))
        ]
        if linked_names:
            names.extend(linked_names)
            continue

        match = re.search(r"\bGenres/Tags\s*:?\s*(.+)", text, re.IGNORECASE)
        if match:
            value = stop_labels.split(match.group(1))[0]
            names.extend(part.strip(" -:;") for part in value.split(","))

    return unique_clean(names)


def extract_image_url(soup: BeautifulSoup, source_url: str) -> str | None:
    img = soup.select_one(".wp-post-image, img.attachment-post-thumbnail, .entry-content img, img")
    if not img:
        return None
    for attr in ("src", "data-src", "data-lazy-src"):
        src = attr_as_str(img.get(attr))
        if src:
            return urljoin(source_url, src)
    return None


def is_noise_description(text: str) -> bool:
    lowered = text.lower()
    return (
        len(text) < 40
        or text.startswith("#")
        or lowered.startswith("genres/tags:")
        or lowered.startswith("companies:")
        or lowered.startswith("company:")
        or lowered.startswith("languages:")
        or lowered.startswith("original size:")
        or lowered.startswith("repack size:")
        or lowered.startswith("filehoster:")
        or lowered.startswith("click to show")
        or "download mirrors" in lowered
        or "if you like what i do" in lowered
    )


def description_after_marker(marker: Any, stop_heading: re.Pattern[str]) -> str | None:
    parts: list[str] = []
    for sibling in marker.find_next_siblings():
        text = clean_text(sibling.get_text(" ", strip=True))
        if not text or text.lower() == "game description":
            continue
        if sibling.name in {"h2", "h3", "h4", "p"} and stop_heading.search(text):
            break
        if not is_noise_description(text):
            parts.append(text)
        if len(" ".join(parts)) >= 1000:
            break
    return clean_text(" ".join(parts))[:1200] if parts else None


def extract_description(soup: BeautifulSoup) -> str | None:
    stop_heading = re.compile(
        r"^(Backwards Compatibility|Repack Features|Download Mirrors|Screenshots|Game Updates)\b",
        re.IGNORECASE,
    )

    for title in soup.select(".su-spoiler-title"):
        if clean_text(title.get_text(" ", strip=True)).lower() != "game description":
            continue
        spoiler = title.find_parent(class_="su-spoiler")
        content = spoiler.select_one(".su-spoiler-content") if spoiler else None
        if content:
            text = clean_text(content.get_text(" ", strip=True))
            text = clean_text(re.split(r"\bIncluded (?:DLCs|Soundtracks)\s*:", text, maxsplit=1)[0])
            if text and not is_noise_description(text):
                return text[:1200]

    for marker in soup.find_all(["h2", "h3", "h4", "p"]):
        if clean_text(marker.get_text(" ", strip=True)).lower() != "game description":
            continue
        description = description_after_marker(marker, stop_heading)
        if description:
            return description

    for block in extract_blocks(soup):
        if not is_noise_description(block):
            return block[:1200]
    return None


def is_direct_host(url: str) -> bool:
    host = urlparse(url).netloc.lower()
    return host == DIRECT_HOST or host.endswith(f".{DIRECT_HOST}")


def extract_direct_links(soup: BeautifulSoup, source_url: str) -> list[IndexedLink]:
    links: list[IndexedLink] = []
    seen: set[str] = set()
    for anchor in soup.select("a[href]"):
        href_value = attr_as_str(anchor.get("href"))
        if not href_value:
            continue
        href = urljoin(source_url, href_value)
        if not is_direct_host(href) or href in seen:
            continue
        seen.add(href)
        links.append(IndexedLink(url=href, filename=clean_text(anchor.get_text(" ", strip=True)) or None))
    return links


def parse_game(
    html_content: str,
    source_url: str,
    *,
    title: str | None = None,
    category_ids: list[int] | None = None,
    tag_ids: list[int] | None = None,
    modified_at: str | None = None,
) -> ParsedGame | None:
    soup = BeautifulSoup(html_content, "html.parser")
    title_el = soup.select_one("article h1.entry-title, article h1.post-title, h1.entry-title, h1.post-title")
    parsed_title = clean_text(title) or (clean_text(title_el.get_text(" ", strip=True)) if title_el else "")
    if not parsed_title:
        return None

    repack_size = extract_size_by_label(soup, "Repack Size")
    if not repack_size:
        return None

    game_id = slug_from_url(source_url) or slugify(parsed_title)
    game = IndexedGame(
        id=game_id,
        title=parsed_title,
        source_url=source_url,
        image_url=extract_image_url(soup, source_url),
        original_size=extract_size_by_label(soup, "Original Size"),
        repack_size=repack_size,
        category_ids=category_ids or [],
        tag_ids=tag_ids or [],
        description=extract_description(soup),
        updated_at=modified_at or utc_now(),
        links=extract_direct_links(soup, source_url),
    )
    return ParsedGame(game=game, visible_tag_names=extract_tag_names(soup))


def embedded_term_maps(data: JsonDict) -> tuple[dict[str, str], dict[str, str]]:
    categories: dict[str, str] = {}
    tags: dict[str, str] = {}
    embedded_value = data.get("_embedded")
    embedded = cast(JsonDict, embedded_value) if isinstance(embedded_value, dict) else {}
    term_groups_value = embedded.get("wp:term", [])
    term_groups = cast(list[Any], term_groups_value) if isinstance(term_groups_value, list) else []

    for group in term_groups:
        if not isinstance(group, list):
            continue
        for term in cast(list[Any], group):
            if not isinstance(term, dict):
                continue
            term_data = cast(JsonDict, term)
            term_id = term_data.get("id")
            name = clean_text(term_data.get("name"))
            taxonomy = term_data.get("taxonomy")
            if term_id is None or not name:
                continue
            if taxonomy == "category":
                categories[str(term_id)] = name
            elif taxonomy == "post_tag":
                tags[str(term_id)] = name
    return categories, tags


def names_for_ids(ids: list[int], term_map: dict[str, str]) -> list[str]:
    return unique_clean([term_map.get(str(term_id), "") for term_id in ids])


def parsed_posts_from_json(data: Any) -> Iterator[ParsedPost]:
    if isinstance(data, list):
        for item in cast(list[Any], data):
            yield from parsed_posts_from_json(item)
        return

    if not isinstance(data, dict):
        return

    post = cast(JsonDict, data)
    content_value = post.get("content") or post.get("content_html") or post.get("html") or ""
    if isinstance(content_value, dict):
        content_data = cast(JsonDict, content_value)
        content_html = str(content_data.get("rendered") or "")
    else:
        content_html = str(content_value)
    if not content_html:
        return

    title_value = post.get("title", "")
    title_data = cast(JsonDict, title_value) if isinstance(title_value, dict) else {}
    title = clean_text(title_data.get("rendered") if title_data else title_value)
    category_ids = id_list(post.get("categories"))
    tag_ids = id_list(post.get("tags"))
    category_map, tag_map = embedded_term_maps(post)
    tag_names = names_for_ids(tag_ids, tag_map)

    if not tag_names:
        visible_tags = extract_tag_names(BeautifulSoup(content_html, "html.parser"))
        if len(visible_tags) == len(tag_ids):
            tag_names = visible_tags

    yield ParsedPost(
        title=title,
        source_url=clean_text(post.get("link") or post.get("source_url") or ""),
        content_html=content_html,
        modified_at=clean_text(post.get("modified") or post.get("updated_at")) or None,
        category_ids=category_ids,
        tag_ids=tag_ids,
        category_names=names_for_ids(category_ids, category_map),
        tag_names=tag_names,
    )


def source_url_from_soup(soup: BeautifulSoup, fallback: str) -> str:
    canonical = soup.select_one('link[rel="canonical"][href]')
    if canonical:
        href = attr_as_str(canonical.get("href"))
        if href:
            return href
    og_url = soup.select_one('meta[property="og:url"][content]')
    if og_url:
        content = attr_as_str(og_url.get("content"))
        if content:
            return content
    return fallback


def title_from_soup(soup: BeautifulSoup, fallback: str) -> str:
    title_el = soup.select_one("article h1.entry-title, article h1.post-title, h1.entry-title, h1.post-title")
    if title_el:
        return clean_text(title_el.get_text(" ", strip=True))
    if soup.title:
        title = clean_text(soup.title.get_text(" ", strip=True))
        return re.sub(r"\s+-\s+FitGirl Repacks\s*$", "", title, flags=re.IGNORECASE)
    return fallback


def iter_wp_posts(fetcher: Fetcher, *, start_page: int = 1, max_pages: int = 0) -> Iterator[ParsedPost]:
    page = max(1, start_page)
    last_page = page + max_pages - 1 if max_pages > 0 else None

    while True:
        url = (
            f"{WP_POSTS_API}?per_page=100&page={page}"
            "&_embed=wp:term"
            "&_fields=id,link,title,content,date,modified,categories,tags,_links,_embedded"
        )
        response = fetcher.get(url, accept=JSON_ACCEPT)
        posts_value = response.json()
        posts = cast(list[Any], posts_value) if isinstance(posts_value, list) else []
        if not posts:
            break

        total_pages = int(header_value(response.headers, "X-WP-TotalPages", "0") or "0")
        print(f"  API page {page}{f'/{total_pages}' if total_pages else ''} -> {len(posts)} posts")
        for post in posts:
            yield from parsed_posts_from_json(post)

        if total_pages and page >= total_pages:
            break
        if last_page and page >= last_page:
            break
        page += 1
        sleep_between_requests()


def iter_local_posts(local_dir: Path) -> Iterator[ParsedPost]:
    if not local_dir.exists():
        raise FileNotFoundError(f"Local source directory does not exist: {local_dir}")

    files = sorted(
        path
        for path in local_dir.rglob("*")
        if path.is_file() and path.suffix.lower() in {".html", ".htm", ".json"}
    )
    print(f"  Local source {local_dir} -> {len(files)} files")

    for path in files:
        fallback_url = path.resolve().as_uri()
        fallback_title = clean_text(path.stem.replace("-", " ").replace("_", " "))
        try:
            raw = path.read_text(encoding="utf-8-sig", errors="replace")
            if path.suffix.lower() == ".json":
                yield from parsed_posts_from_json(json.loads(raw))
                continue

            soup = BeautifulSoup(raw, "html.parser")
            yield ParsedPost(
                title=title_from_soup(soup, fallback_title),
                source_url=source_url_from_soup(soup, fallback_url),
                content_html=raw,
            )
        except Exception as exc:
            print(f"  Skipping {path}: {exc}")


def iter_sitemap_posts(fetcher: Fetcher) -> Iterator[ParsedPost]:
    urls = get_game_urls(fetcher)
    print(f"Total URLs from sitemap: {len(urls)}")
    for url in urls:
        try:
            yield ParsedPost(title="", source_url=url, content_html=fetch_text(url, fetcher))
        except Exception as exc:
            print(f"  Skipping {url}: {exc}")
        sleep_between_requests()


def iter_json_objects(data: Any) -> Iterator[JsonDict]:
    if isinstance(data, dict):
        obj = cast(JsonDict, data)
        yield obj
        for value in obj.values():
            yield from iter_json_objects(value)
    elif isinstance(data, list):
        for item in cast(list[Any], data):
            yield from iter_json_objects(item)


def get_local_taxonomy_maps(local_dir: Path) -> TaxonomyMaps:
    taxonomies: TaxonomyMaps = {"categories": {}, "tags": {}}
    if not local_dir.exists():
        return taxonomies

    for path in local_dir.rglob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig", errors="replace"))
        except Exception:
            continue
        for obj in iter_json_objects(data):
            term_id = obj.get("id")
            name = clean_text(obj.get("name"))
            taxonomy = obj.get("taxonomy")
            if term_id is None or not name:
                continue
            if taxonomy == "category":
                taxonomies["categories"][str(term_id)] = name
            elif taxonomy == "post_tag":
                taxonomies["tags"][str(term_id)] = name

    return taxonomies


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    text = path.read_text(encoding="utf-8-sig")
    if not text.strip():
        return default
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        print(f"Could not read {path}: {exc}. Starting fresh.")
        return default


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def save_json_if_changed(path: Path, data: Any) -> bool:
    serialized = json.dumps(data, indent=2, ensure_ascii=False)
    if path.exists():
        existing = path.read_text(encoding="utf-8")
        if existing == serialized:
            return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(serialized, encoding="utf-8")
    return True


def load_index() -> list[dict[str, Any]]:
    loaded = load_json(INDEX_PATH, [])
    return cast(list[dict[str, Any]], loaded) if isinstance(loaded, list) else []


def save_index(index: list[dict[str, Any]]) -> bool:
    return save_json_if_changed(INDEX_PATH, sorted(index, key=lambda item: item["title"].lower()))


def load_taxonomies() -> dict[str, dict[str, str]]:
    loaded = load_json(TAXONOMIES_PATH, {"categories": {}, "tags": {}})
    data = cast(JsonDict, loaded) if isinstance(loaded, dict) else {}
    categories = data.get("categories", {})
    tags = data.get("tags", {})
    return {
        "categories": cast(dict[str, str], categories) if isinstance(categories, dict) else {},
        "tags": cast(dict[str, str], tags) if isinstance(tags, dict) else {},
    }


def save_taxonomies(taxonomies: dict[str, dict[str, str]]) -> bool:
    compact = {
        key: dict(sorted(value.items(), key=lambda item: (item[1].lower(), item[0])))
        for key, value in taxonomies.items()
    }
    return save_json_if_changed(TAXONOMIES_PATH, compact)


def merge_taxonomy_names(
    taxonomies: dict[str, dict[str, str]],
    kind: str,
    ids: list[int],
    names: list[str],
) -> None:
    if len(ids) != len(names):
        return
    for term_id, name in zip(ids, names, strict=False):
        if name:
            taxonomies[kind][str(term_id)] = name


def merge_taxonomies(target: dict[str, dict[str, str]], incoming: dict[str, dict[str, str]]) -> None:
    for kind in ("categories", "tags"):
        target[kind].update(incoming.get(kind, {}))


def index_entry(game: IndexedGame) -> dict[str, Any]:
    letter = game.id[0] if game.id else "_"
    return {
        "id": game.id,
        "title": game.title,
        "path": f"games/{letter}/{game.id}.json",
        "original_size": game.original_size,
        "repack_size": game.repack_size,
        "image_url": game.image_url,
        "category_ids": game.category_ids,
        "tag_ids": game.tag_ids,
        "updated_at": game.updated_at,
    }


def normalized_timestamp(value: Any) -> str:
    text = clean_text(value)
    return text[:-1] if text.endswith("Z") else text


def index_entries_by_id(index: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    entries: dict[str, dict[str, Any]] = {}
    for item in index:
        game_id = clean_text(item.get("id"))
        if game_id and game_id not in entries:
            entries[game_id] = item
    return entries


def replace_index_entry(index: list[dict[str, Any]], entry: dict[str, Any]) -> None:
    game_id = clean_text(entry.get("id"))
    replaced = False
    next_index: list[dict[str, Any]] = []
    for item in index:
        if clean_text(item.get("id")) != game_id:
            next_index.append(item)
            continue
        if not replaced:
            next_index.append(entry)
            replaced = True
    if not replaced:
        next_index.append(entry)
    index[:] = next_index


def game_json_path(game: IndexedGame) -> Path:
    letter = game.id[0] if game.id else "_"
    return STORE_DIR / letter / f"{game.id}.json"


def should_update_game(game: IndexedGame, existing_entry: dict[str, Any]) -> bool:
    if not game_json_path(game).exists():
        return True

    incoming_updated = normalized_timestamp(game.updated_at)
    existing_updated = normalized_timestamp(existing_entry.get("updated_at"))
    if incoming_updated and not existing_updated:
        return True
    if incoming_updated and existing_updated:
        return incoming_updated > existing_updated
    return False


def upsert_game(
    game: IndexedGame,
    index: list[dict[str, Any]],
    indexed_entries: dict[str, dict[str, Any]],
) -> tuple[str, list[str]]:
    entry = index_entry(game)
    existing_entry = indexed_entries.get(game.id)
    if existing_entry is not None and not should_update_game(game, existing_entry):
        return ("skipped", [])

    changed_fields = sorted(key for key in entry if existing_entry is not None and existing_entry.get(key) != entry.get(key))

    save_json(game_json_path(game), asdict(game))
    replace_index_entry(index, entry)
    indexed_entries[game.id] = entry
    return ("updated", changed_fields) if existing_entry is not None else ("new", sorted(entry.keys()))


def reset_store_root() -> None:
    target = STORE_ROOT.resolve()
    if not target.exists():
        return
    workspace = Path.cwd().resolve()
    home = Path.home().resolve()
    if (
        target == workspace
        or target == home
        or target.parent == target
        or target.name.lower() != "store"
    ):
        raise RuntimeError(f"Refusing to rebuild unsafe store path: {target}")
    shutil.rmtree(target)


def print_wp_api_urls(pages: int) -> None:
    for page in range(1, pages + 1):
        print(
            f"{WP_POSTS_API}?per_page=100&page={page}"
            "&_embed=wp:term"
            "&_fields=id,link,title,content,date,modified,categories,tags,_links,_embedded"
        )


def run_indexer(
    *,
    store_root: str | Path | None = None,
    source: str = "wp-api",
    http_client: str = DEFAULT_HTTP_CLIENT,
    local_dir: Path | str = Path(DEFAULT_LOCAL_DIR),
    limit: int = 0,
    start_page: int = 1,
    max_pages: int = 0,
    progress_every: int = DEFAULT_PROGRESS_EVERY,
    verbose: bool = False,
    reset_store: bool = False,
) -> CrawlerReport:
    if store_root is not None:
        configure_store_root(store_root)
    if reset_store:
        reset_store_root()

    index = load_index()
    taxonomies = load_taxonomies()
    indexed_entries = index_entries_by_id(index)
    fetcher = Fetcher(http_client)
    local_path = Path(local_dir)

    if source == "wp-api":
        posts = iter_wp_posts(fetcher, start_page=start_page, max_pages=max_pages)
    elif source == "sitemap":
        posts = iter_sitemap_posts(fetcher)
    elif source == "local-dir":
        merge_taxonomies(taxonomies, get_local_taxonomy_maps(local_path))
        posts = iter_local_posts(local_path)
    else:
        raise ValueError(f"Unsupported source: {source}")

    report = CrawlerReport()
    try:
        for post in posts:
            if limit and report.inspected >= limit:
                break
            report.inspected += 1

            parsed = parse_game(
                post.content_html,
                post.source_url,
                title=post.title,
                category_ids=post.category_ids,
                tag_ids=post.tag_ids,
                modified_at=post.modified_at,
            )
            if not parsed:
                report.skipped += 1
                continue

            game = parsed.game
            tag_names = post.tag_names
            if not tag_names and len(post.tag_ids) == len(parsed.visible_tag_names):
                tag_names = parsed.visible_tag_names
            merge_taxonomy_names(taxonomies, "categories", post.category_ids, post.category_names)
            merge_taxonomy_names(taxonomies, "tags", post.tag_ids, tag_names)

            result, changed_fields = upsert_game(game, index, indexed_entries)
            if result == "skipped":
                report.skipped += 1
                continue
            if result == "new":
                report.new += 1
                report.new_games.append(game.title)
            elif result == "updated":
                report.updated += 1
                report.updated_games.append({"title": game.title, "fields": changed_fields})
            if verbose:
                marker = "+" if result == "new" else "~"
                print(f"[{report.inspected}] {marker}{game.title}")
            elif progress_every and report.inspected % progress_every == 0:
                print(
                    f"  inspected={report.inspected} new={report.new} "
                    f"updated={report.updated} skipped={report.skipped}"
                )

            changed_games = report.new + report.updated
            if changed_games and changed_games % CHECKPOINT == 0:
                save_index(index)
                save_taxonomies(taxonomies)
    except ChallengeError as exc:
        report.stopped_reason = str(exc)

    report.index_written = save_index(index)
    report.taxonomies_written = save_taxonomies(taxonomies)
    report.total = len(index)
    report.finished_at = utc_now()
    return report


def rebuild_store(
    store_root: str | Path,
    *,
    http_client: str = DEFAULT_HTTP_CLIENT,
    max_pages: int = DEFAULT_MAX_PAGES,
    limit: int = 0,
) -> CrawlerReport:
    return run_indexer(
        store_root=store_root,
        source="wp-api",
        http_client=http_client,
        max_pages=max_pages,
        limit=limit,
        reset_store=True,
    )


def update_store(
    store_root: str | Path,
    *,
    http_client: str = DEFAULT_HTTP_CLIENT,
    max_pages: int = DEFAULT_UPDATE_MAX_PAGES,
    limit: int = 0,
) -> CrawlerReport:
    return run_indexer(
        store_root=store_root,
        source="wp-api",
        http_client=http_client,
        max_pages=max_pages,
        limit=limit,
        reset_store=False,
    )


def compile_saved_pages(
    local_dir: str | Path,
    store_root: str | Path,
    *,
    limit: int = 0,
    reset_store: bool = True,
) -> CrawlerReport:
    return run_indexer(
        store_root=store_root,
        source="local-dir",
        local_dir=local_dir,
        limit=limit,
        reset_store=reset_store,
    )


def print_report(report: CrawlerReport) -> None:
    if report.stopped_reason:
        print(f"Stopped early: {report.stopped_reason}")
        print("The site returned a browser challenge. Try --http-client curl or --source local-dir.")
    print(
        f"Done. inspected={report.inspected} new={report.new} "
        f"updated={report.updated} skipped={report.skipped} total={report.total}"
    )
    print(
        "Writes: "
        f"index.json={'yes' if report.index_written else 'no'} "
        f"taxonomies.json={'yes' if report.taxonomies_written else 'no'}"
    )
    if report.new_games:
        print("New games:")
        for title in report.new_games:
            print(f"  + {title}")
    if report.updated_games:
        print("Updated games:")
        for item in report.updated_games:
            details = ", ".join(item.get("fields") or []) or "details unavailable"
            print(f"  ~ {item.get('title')}: {details}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Index FitGirl repack metadata.")
    parser.add_argument("--rebuild", action="store_true", help="Rebuild the full online store from scratch.")
    parser.add_argument("--update", action="store_true", help="Update the online store from the latest API pages.")
    parser.add_argument("--print-api-urls", type=int, metavar="PAGES", default=0)
    parser.add_argument("--print-local-sitemap-urls", type=Path, metavar="PATH")
    parser.add_argument("--sitemap-filter", choices=("all", "post-sitemaps", "games"), default="all")
    parser.add_argument("--source", choices=("wp-api", "sitemap", "local-dir"), default=None)
    parser.add_argument("--http-client", choices=("requests", "curl"), default=None)
    parser.add_argument("--local-dir", type=Path, default=Path(DEFAULT_LOCAL_DIR))
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    parser.add_argument("--start-page", type=int, default=DEFAULT_START_PAGE)
    parser.add_argument("--max-pages", type=int, default=None)
    parser.add_argument("--progress-every", type=int, default=DEFAULT_PROGRESS_EVERY)
    parser.add_argument("--verbose", action="store_true", help="Print every indexed game title.")
    parser.add_argument("--reset-store", action="store_true", help="Delete the current store before indexing.")
    args = parser.parse_args()

    if args.rebuild and args.update:
        parser.error("Choose either --rebuild or --update, not both.")
    if args.rebuild and args.source and args.source != "wp-api":
        parser.error("--rebuild is the full online rebuild. Use --reset-store for local-dir compiles.")
    if args.update and args.source and args.source != "wp-api":
        parser.error("--update only supports the online WordPress API source.")
    return args


def run_config(args: argparse.Namespace) -> tuple[str, str, int, bool]:
    if args.rebuild:
        return (
            "wp-api",
            args.http_client or DEFAULT_HTTP_CLIENT,
            args.max_pages if args.max_pages is not None else DEFAULT_MAX_PAGES,
            True,
        )
    if args.update:
        return (
            "wp-api",
            args.http_client or DEFAULT_HTTP_CLIENT,
            args.max_pages if args.max_pages is not None else DEFAULT_UPDATE_MAX_PAGES,
            False,
        )
    return (
        args.source or DEFAULT_SOURCE,
        args.http_client or DEFAULT_HTTP_CLIENT,
        args.max_pages if args.max_pages is not None else DEFAULT_MAX_PAGES,
        args.reset_store,
    )


def main() -> None:
    args = parse_args()
    if args.print_api_urls:
        print_wp_api_urls(args.print_api_urls)
        return
    if args.print_local_sitemap_urls:
        for url in iter_local_sitemap_urls(args.print_local_sitemap_urls, url_filter=args.sitemap_filter):
            print(url)
        return

    source, http_client, max_pages, reset_store = run_config(args)

    report = run_indexer(
        source=source,
        http_client=http_client,
        local_dir=args.local_dir,
        limit=args.limit,
        start_page=args.start_page,
        max_pages=max_pages,
        progress_every=args.progress_every,
        verbose=args.verbose,
        reset_store=reset_store,
    )
    print_report(report)


if __name__ == "__main__":
    main()
