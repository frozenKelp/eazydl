import os
from ipaddress import ip_address, ip_network
from socket import getaddrinfo
from typing import Optional
from urllib.parse import urlparse

import requests
from fastapi import HTTPException


PRIVATE_NETS = tuple(
    ip_network(net)
    for net in (
        "127.0.0.0/8",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
    )
)


def is_private_address(value: str) -> bool:
    try:
        addr = ip_address(value)
    except ValueError:
        return True
    return any(addr in net for net in PRIVATE_NETS)


def is_public_http_url(raw_url: str, allowed_hosts: Optional[set[str]] = None) -> bool:
    parsed = urlparse((raw_url or "").strip())
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in {"http", "https"} or not host:
        return False
    if allowed_hosts is not None and host not in allowed_hosts:
        return False
    try:
        addresses = [ip_address(info[4][0]) for info in getaddrinfo(host, None)]
    except OSError:
        return False
    return not any(any(addr in net for net in PRIVATE_NETS) for addr in addresses)


def is_public_image_url(raw_url: str) -> bool:
    return is_public_http_url(raw_url)


def clean_url(raw_url: str, allowed_hosts: Optional[set[str]] = None, label: str = "URL") -> str:
    url = (raw_url or "").strip()
    if not is_public_http_url(url, allowed_hosts):
        raise HTTPException(400, f"Unsupported {label}.")
    return url


def clean_download_path(raw_path: str) -> str:
    text = str(raw_path or "").strip().replace("\x00", "")
    if not text:
        raise HTTPException(400, "download_path cannot be empty.")
    if len(text) > 500:
        raise HTTPException(400, "download_path is too long.")
    return os.path.abspath(os.path.expanduser(text))


def response_peer_is_public(resp: requests.Response) -> bool:
    try:
        conn = getattr(resp.raw, "_connection", None)
        sock = getattr(conn, "sock", None) if conn else None
        if not sock:
            sock = getattr(
                getattr(getattr(resp.raw, "_fp", None), "fp", None),
                "raw",
                None,
            )
            sock = getattr(sock, "_sock", None)
        if not sock:
            return False
        return not is_private_address(sock.getpeername()[0])
    except OSError:
        return False
