"""Fetches sheet music from a web address.

The address may point straight at a PDF or image, or at a web page that links to
or embeds PDFs. Only public internet addresses are fetched (never this server's
own network), and downloads are size-limited.
"""

from __future__ import annotations

import ipaddress
import os
import socket
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import unquote, urljoin, urlsplit

import requests

MAX_DOWNLOAD = int(os.environ.get("NOTEREADER_MAX_UPLOAD_MB", "60")) * 1024 * 1024
MAX_HTML = 3 * 1024 * 1024
ALLOW_PRIVATE = os.environ.get("NOTEREADER_ALLOW_PRIVATE_URLS") == "1"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; sheet-music-reader)",
    "Accept": "application/pdf,text/html;q=0.9,image/*;q=0.8,*/*;q=0.5",
}
IMAGE_TYPES = ("image/png", "image/jpeg", "image/webp", "image/gif", "image/tiff", "image/bmp")


class LinkError(Exception):
    """A problem worth showing to the person who pasted the link."""


@dataclass
class Fetched:
    url: str
    kind: str  # "pdf" | "image" | "html"
    data: bytes
    content_type: str


def check_public(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise LinkError("That is not a web address. It should start with https://")
    if ALLOW_PRIVATE:
        return
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise LinkError("That website could not be found.") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise LinkError("Only public websites can be read.")


def fetch(url: str) -> Fetched:
    session = requests.Session()
    for _ in range(6):  # follow redirects by hand so every hop is checked
        check_public(url)
        try:
            res = session.get(url, headers=HEADERS, stream=True, timeout=(10, 30), allow_redirects=False)
        except requests.RequestException as exc:
            raise LinkError("The website did not answer.") from exc
        if res.is_redirect or res.is_permanent_redirect:
            target = res.headers.get("location")
            res.close()
            if not target:
                break
            url = urljoin(url, target)
            continue
        break
    else:
        raise LinkError("The link redirects too many times.")

    with res:
        if res.status_code in (401, 403):
            raise LinkError("The website does not allow this file to be downloaded (it may need a login).")
        if res.status_code >= 400:
            raise LinkError(f"The website answered with an error ({res.status_code}).")
        content_type = res.headers.get("content-type", "").split(";")[0].strip().lower()
        chunks: list[bytes] = []
        size = 0
        for chunk in res.iter_content(64 * 1024):
            chunks.append(chunk)
            size += len(chunk)
            head = b"".join(chunks[:2])[:1024].lstrip()
            is_html = content_type in ("text/html", "application/xhtml+xml") and not head.startswith(b"%PDF-")
            if is_html and size > MAX_HTML:
                break  # enough of the page to find its links
            if size > MAX_DOWNLOAD:
                raise LinkError("That file is too large.")
        data = b"".join(chunks)

    if data.lstrip()[:5] == b"%PDF-":
        return Fetched(url, "pdf", data, content_type)
    if content_type in IMAGE_TYPES:
        return Fetched(url, "image", data, content_type)
    if content_type in ("text/html", "application/xhtml+xml") or b"<html" in data[:2000].lower():
        return Fetched(url, "html", data, content_type)
    raise LinkError("That link is not a PDF, an image, or a web page.")


class _PdfLinks(HTMLParser):
    """Collects links that look like PDFs, and frames that may hold one."""

    def __init__(self, base: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base = base
        self.pdfs: dict[str, str] = {}  # url -> label
        self.frames: list[str] = []
        self._open: str | None = None
        self._text: list[str] = []

    def _add(self, raw: str | None, label: str = "") -> str | None:
        if not raw or raw.startswith(("javascript:", "mailto:", "data:", "#")):
            return None
        url = urljoin(self.base, raw.strip())
        if urlsplit(url).scheme not in ("http", "https"):
            return None
        return url

    @staticmethod
    def _looks_pdf(url: str, mime: str = "") -> bool:
        parts = urlsplit(url)
        return (
            mime == "application/pdf"
            or parts.path.lower().endswith(".pdf")
            or ".pdf" in unquote(parts.query).lower()
        )

    def handle_starttag(self, tag: str, attrs: list) -> None:
        a = dict(attrs)
        if tag == "base" and a.get("href"):
            self.base = urljoin(self.base, a["href"])
        elif tag == "a":
            url = self._add(a.get("href"))
            if url and self._looks_pdf(url, a.get("type", "")):
                self._open = url
                self._text = [a.get("title") or a.get("download") or ""]
                self.pdfs.setdefault(url, "")
        elif tag in ("embed", "iframe", "object"):
            url = self._add(a.get("src") or a.get("data"))
            if not url:
                return
            # PDF viewers (pdf.js, Google viewer) carry the real file in ?file= or ?url=
            for part in urlsplit(url).query.split("&"):
                key, _, value = part.partition("=")
                if key in ("file", "url", "src") and ".pdf" in unquote(value).lower():
                    inner = self._add(unquote(value))
                    if inner:
                        self.pdfs.setdefault(inner, "")
                        return
            if self._looks_pdf(url, a.get("type", "")):
                self.pdfs.setdefault(url, "")
            else:
                self.frames.append(url)

    def handle_data(self, data: str) -> None:
        if self._open:
            self._text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._open:
            label = " ".join(" ".join(self._text).split())
            if label and not self.pdfs[self._open]:
                self.pdfs[self._open] = label[:90]
            self._open = None


def _label(url: str, label: str) -> str:
    name = unquote(urlsplit(url).path.rsplit("/", 1)[-1]) or url
    return label if len(label) > 2 else name


def resolve(url: str) -> tuple[Fetched | None, list[dict]]:
    """Returns the music file behind `url`, or the PDFs to choose from if a page has several."""
    url = url.strip()
    if url and "://" not in url:
        url = "https://" + url
    found = fetch(url)
    if found.kind != "html":
        return found, []

    parser = _PdfLinks(found.url)
    parser.feed(found.data.decode("utf-8", errors="replace"))
    if not parser.pdfs:
        # Some sites show the PDF inside a frame whose address doesn't end in .pdf
        for frame in parser.frames[:3]:
            try:
                inner = fetch(frame)
            except LinkError:
                continue
            if inner.kind == "pdf":
                return inner, []
    if not parser.pdfs:
        raise LinkError("No PDF was found on that page. Open the PDF itself and copy its address.")
    choices = [{"url": u, "label": _label(u, label)} for u, label in parser.pdfs.items()][:40]
    if len(choices) == 1:
        return fetch(choices[0]["url"]), []
    return None, choices
