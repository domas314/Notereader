"""Notereader server.

Serves the phone web app (../web) and turns uploaded photos / PDFs of sheet
music into MusicXML using the homr optical-music-recognition engine.

Recognition is slow (10 s - 2 min per page on a CPU), so uploads become jobs
that the app polls:

    POST /api/recognize        multipart "files" (images and/or PDFs, in page order)
    POST /api/recognize-url    {"url": ...}: a PDF/image address, or a web page with PDFs on it
    GET  /api/jobs/{id}        -> {"status": "queued|running|done|error", ...}
    GET  /api/jobs/{id}/musicxml
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from queue import Queue

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel

from . import weblink

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
MAX_FILES = int(os.environ.get("NOTEREADER_MAX_FILES", "30"))
MAX_BYTES = int(os.environ.get("NOTEREADER_MAX_UPLOAD_MB", "60")) * 1024 * 1024
MAX_IMAGE_SIDE = 3200  # px; larger photos only slow recognition down
JOB_TTL_SECONDS = 60 * 60
JOB_TIMEOUT_SECONDS = int(os.environ.get("NOTEREADER_JOB_TIMEOUT", "1800"))

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif"}


@dataclass
class Job:
    id: str
    workdir: Path
    inputs: list[Path]
    status: str = "queued"
    message: str = "Waiting to start"
    pages_done: int = 0
    pages_total: int = 0
    error: str | None = None
    result: Path | None = None
    created: float = field(default_factory=time.time)

    def public(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "message": self.message,
            "pagesDone": self.pages_done,
            "pagesTotal": self.pages_total,
            "error": self.error,
        }


jobs: dict[str, Job] = {}
job_queue: Queue[Job] = Queue()


def normalize_image(source: Path, target: Path) -> None:
    """Applies the phone's EXIF rotation, flattens transparency and limits the size."""
    with Image.open(source) as img:
        img = ImageOps.exif_transpose(img)
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGBA")
            background = Image.new("RGBA", img.size, "white")
            img = Image.alpha_composite(background, img)
        img = img.convert("RGB")
        if max(img.size) > MAX_IMAGE_SIDE:
            img.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE), Image.LANCZOS)
        img.save(target, "PNG")


def run_job(job: Job) -> None:
    job.status = "running"
    job.message = "Reading the music"
    cmd = [sys.executable, "-m", "homr.main", *[str(p) for p in job.inputs]]
    log_lines: list[str] = []
    try:
        proc = subprocess.Popen(  # noqa: S603 - fixed command, paths we created
            cmd,
            cwd=job.workdir,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
        )
        timer = threading.Timer(JOB_TIMEOUT_SECONDS, proc.kill)
        timer.start()
        try:
            assert proc.stderr is not None  # noqa: S101
            for line in proc.stderr:
                log_lines.append(line.rstrip())
                del log_lines[:-40]
                merging = re.match(r"Merging (\d+) files", line)
                if merging:
                    job.pages_total = int(merging.group(1))
                    job.pages_done = 0
                    job.message = f"Reading page 1 of {job.pages_total}"
                elif re.match(r"Finished (?!parsing)", line):
                    job.pages_done = min(job.pages_done + 1, job.pages_total)
                    if job.pages_done < job.pages_total:
                        job.message = f"Reading page {job.pages_done + 1} of {job.pages_total}"
                    else:
                        job.message = "Putting the pages together"
            proc.wait()
        finally:
            timer.cancel()

        results = sorted(job.workdir.glob("*.musicxml"))
        if proc.returncode != 0 or not results:
            tail = "\n".join(line for line in log_lines[-6:] if line)
            raise RuntimeError(tail or "The recognition engine stopped unexpectedly")
        job.result = results[0]
        job.status = "done"
        job.message = "Done"
    except Exception as exc:  # noqa: BLE001 - reported to the app
        job.status = "error"
        job.error = (
            "Could not find readable music on this upload. Try a sharper, flatter, "
            "well-lit photo with the whole page visible."
        )
        job.message = str(exc)[-600:]


def worker() -> None:
    while True:
        job = job_queue.get()
        try:
            run_job(job)
        finally:
            job_queue.task_done()
            cleanup_old_jobs()


def cleanup_old_jobs() -> None:
    now = time.time()
    for job_id, job in list(jobs.items()):
        if now - job.created > JOB_TTL_SECONDS and job.status in ("done", "error"):
            shutil.rmtree(job.workdir, ignore_errors=True)
            jobs.pop(job_id, None)


threading.Thread(target=worker, daemon=True).start()

app = FastAPI(title="Notereader")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("NOTEREADER_CORS_ORIGINS", "*").split(","),
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "queued": job_queue.qsize()}


def start_job(uploads: list[tuple[str, bytes]]) -> dict:
    """Queues recognition of (filename, bytes) pages given in reading order."""
    workdir = Path(tempfile.mkdtemp(prefix="notereader-"))
    inputs: list[Path] = []
    try:
        for index, (filename, data) in enumerate(uploads):
            ext = Path(filename or "").suffix.lower()
            if data.lstrip()[:5] == b"%PDF-" or ext == ".pdf":
                page = workdir / f"page_{index:03d}.pdf"
                page.write_bytes(data)
            else:
                raw = workdir / f"upload_{index:03d}.img"
                raw.write_bytes(data)
                page = workdir / f"page_{index:03d}.png"
                try:
                    normalize_image(raw, page)
                except Exception as exc:  # noqa: BLE001
                    raise HTTPException(
                        415, f"'{filename}' is not an image or PDF this app can read"
                    ) from exc
                raw.unlink(missing_ok=True)
            inputs.append(page)
    except Exception:
        shutil.rmtree(workdir, ignore_errors=True)
        raise

    job = Job(id=uuid.uuid4().hex, workdir=workdir, inputs=inputs, pages_total=len(inputs))
    jobs[job.id] = job
    job_queue.put(job)
    return job.public()


@app.post("/api/recognize")
async def recognize(files: list[UploadFile] = File(...)) -> dict:
    if not files:
        raise HTTPException(400, "No files uploaded")
    if len(files) > MAX_FILES:
        raise HTTPException(400, f"At most {MAX_FILES} files per score")
    uploads: list[tuple[str, bytes]] = []
    total = 0
    for upload in files:
        data = await upload.read()
        total += len(data)
        if total > MAX_BYTES:
            raise HTTPException(413, "Upload is too large")
        uploads.append((upload.filename or "", data))
    return start_job(uploads)


class LinkRequest(BaseModel):
    url: str


@app.post("/api/recognize-url")
def recognize_url(body: LinkRequest) -> dict:
    """Reads music from a web address. Returns a job, or PDFs to choose between."""
    try:
        found, choices = weblink.resolve(body.url)
    except weblink.LinkError as exc:
        raise HTTPException(422, str(exc)) from exc
    if found is None:
        return {"choices": choices}
    name = "link.pdf" if found.kind == "pdf" else "link.img"
    return {**start_job([(name, found.data)]), "source": found.url}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "Unknown job")
    return job.public()


@app.get("/api/jobs/{job_id}/musicxml")
def job_result(job_id: str) -> Response:
    job = jobs.get(job_id)
    if job is None or job.result is None:
        raise HTTPException(404, "No result")
    return FileResponse(job.result, media_type="application/vnd.recordare.musicxml+xml")


@app.middleware("http")
async def no_stale_app_shell(request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/api/") and "vendor/" not in request.url.path:
        response.headers["Cache-Control"] = "no-cache"
    return response


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
