"""Local HTTP API for the React video-search frontend."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import faiss
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sentence_transformers import SentenceTransformer

ROOT = Path(__file__).parent
DATA = ROOT / "data"
VIDEO = DATA / "video.mp4"
FRAMES = DATA / "frames"
INDEX = DATA / "index.faiss"
DOCUMENTS = DATA / "documents.json"
STATUS_FILE = DATA / "task_status.json"
DATA.mkdir(exist_ok=True)

_venv_bin = str(Path(__file__).resolve().parent.parent / "venv" / "bin")
if _venv_bin not in os.environ.get("PATH", ""):
    os.environ["PATH"] = _venv_bin + os.pathsep + os.environ.get("PATH", "")

app = FastAPI(title="SecureVisionAI API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/media", StaticFiles(directory=str(DATA)), name="media")


def _read_status() -> dict | None:
    if STATUS_FILE.exists():
        try:
            return json.loads(STATUS_FILE.read_text())
        except Exception:
            return None
    return None


def _write_status(data: dict) -> None:
    STATUS_FILE.write_text(json.dumps(data))


def public_frame_url(path: str | None) -> str | None:
    if not path:
        return None
    return "/media/frames/" + Path(path).name


@app.get("/api/health")
def health() -> dict:
    return {"ready": INDEX.exists() and DOCUMENTS.exists(), "video": VIDEO.exists()}


@app.post("/api/process")
async def process_video(
    video: UploadFile | None = File(default=None),
    url: str = Form(default=""),
    interval: float = Form(default=5.0),
    cookies: UploadFile | None = File(default=None),
) -> dict:
    if not video and not url.strip() and not VIDEO.exists():
        raise HTTPException(400, "Upload a video or provide a video URL.")
    try:
        DATA.mkdir(exist_ok=True)
        if video and video.filename:
            with VIDEO.open("wb") as output:
                shutil.copyfileobj(video.file, output)
        elif url.strip():
            cookie_path = None
            if cookies and cookies.filename:
                cookie_path = DATA / "cookies.txt"
                with cookie_path.open("wb") as output:
                    shutil.copyfileobj(cookies.file, output)
            from app import download_video
            download_video(url.strip(), VIDEO, cookie_path)

        task_id = str(uuid.uuid4())
        _write_status({
            "task_id": task_id,
            "status": "processing",
            "stage": "Starting processing...",
            "error": None,
            "result": None,
        })

        worker_script = ROOT / "_worker.py"
        env = os.environ.copy()
        env["PATH"] = _venv_bin + os.pathsep + env.get("PATH", "")
        subprocess.Popen(
            [sys.executable, str(worker_script), str(VIDEO), str(DATA), str(interval), task_id],
            env=env,
            cwd=str(ROOT),
        )

        return {"task_id": task_id, "status": "processing"}
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc


@app.get("/api/status/{task_id}")
def get_task_status(task_id: str) -> dict:
    st = _read_status()
    if not st or st.get("task_id") != task_id:
        raise HTTPException(404, f"Task {task_id} not found.")
    return st


@app.get("/api/search")
def search(q: str, top_k: int = 6) -> dict:
    if not INDEX.exists() or not DOCUMENTS.exists():
        raise HTTPException(409, "Process a video before searching.")
    model = SentenceTransformer("all-MiniLM-L6-v2")
    index = faiss.read_index(str(INDEX))
    documents = json.loads(DOCUMENTS.read_text(encoding="utf-8"))
    vector = model.encode([q], convert_to_numpy=True).astype(np.float32)
    distances, indices = index.search(vector, min(top_k, index.ntotal))
    results = []
    for distance, index_value in zip(distances[0], indices[0]):
        item = documents[int(index_value)]
        results.append({
            "text": item["text"],
            "timestamp": item["timestamp"],
            "distance": float(distance),
            "frame": public_frame_url(item.get("path")),
        })
    return {"query": q, "results": results}
