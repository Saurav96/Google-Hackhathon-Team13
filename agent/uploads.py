"""Uploaded application documents, kept in a private Cloud Storage bucket."""

import os
import re
import uuid
from functools import lru_cache

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import Response
from google.cloud import storage

MAX_BYTES = 4 * 1024 * 1024
ALLOWED = ("image/", "application/pdf", "text/")
BUCKET = os.environ.get("UPLOAD_BUCKET") or f'{os.environ.get("GOOGLE_CLOUD_PROJECT")}-relief-desk-uploads'

router = APIRouter()


@lru_cache(maxsize=1)
def _bucket() -> storage.Bucket:
    return storage.Client().bucket(BUCKET)


@router.post("/api/upload")
async def upload(file: UploadFile) -> dict:
    content_type = file.content_type or "application/octet-stream"
    if not content_type.startswith(ALLOWED):
        raise HTTPException(status_code=415, detail="Attach an image, a PDF or a text file.")
    body = await file.read(MAX_BYTES + 1)
    if len(body) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="The file is larger than 4 MB.")
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", file.filename or "file")[-80:]
    file_id = uuid.uuid4().hex
    _bucket().blob(f"uploads/{file_id}/{name}").upload_from_string(body, content_type=content_type)
    return {"id": file_id, "name": name, "type": content_type, "size": len(body), "url": f"/api/files/{file_id}/{name}"}


@router.get("/api/files/{file_id}/{name}")
def download(file_id: str, name: str) -> Response:
    if not re.fullmatch(r"[0-9a-f]{32}", file_id) or not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", name):
        raise HTTPException(status_code=404, detail="No such file.")
    blob = _bucket().get_blob(f"uploads/{file_id}/{name}")
    if blob is None:
        raise HTTPException(status_code=404, detail="No such file.")
    # Served inline but sandboxed, so an uploaded HTML or SVG file cannot run scripts here.
    return Response(
        blob.download_as_bytes(),
        media_type=blob.content_type,
        headers={"Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff"},
    )
