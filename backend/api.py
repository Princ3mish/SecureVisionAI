"""Local HTTP API for the React video-search frontend."""

from __future__ import annotations

import asyncio
import json
import shutil
import uuid
from pathlib import Path

import faiss
import numpy as np
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sentence_transformers import SentenceTransformer

from app import download_video, process_pipeline


ROOT = Path(__file__).parent
DATA = ROOT / "data"
VIDEO = DATA / "video.mp4"
FRAMES = DATA / "frames"
INDEX = DATA / "index.faiss"
DOCUMENTS = DATA / "documents.json"
DATA.mkdir(exist_ok=True)

# In-memory store for background tasks
# Known limitation: Cleared when server reloads
tasks: dict[str, dict] = {}

app = FastAPI(title="Multimodal Video Search API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/media", StaticFiles(directory=str(DATA)), name="media")


def public_frame_url(path: str | None) -> str | None:
    if not path:
        return None
    return "/media/frames/" + Path(path).name


@app.get("/api/health")
def health() -> dict:
    return {"ready": INDEX.exists() and DOCUMENTS.exists(), "video": VIDEO.exists()}


def _background_worker(task_id: str, video_path: Path, interval: float) -> None:
    def on_progress(stage: str):
        if task_id in tasks:
            tasks[task_id]["stage"] = stage

    try:
        print(f"[_background_worker] calling process_pipeline with video_path={video_path}, interval={interval}")
        result = process_pipeline(video_path, DATA, interval, progress_callback=on_progress)
        print(f"[_background_worker] process_pipeline returned: {result}")
        tasks[task_id]["status"] = "completed"
        tasks[task_id]["stage"] = "Complete"
        tasks[task_id]["result"] = result
    except Exception as exc:
        tasks[task_id]["status"] = "failed"
        tasks[task_id]["stage"] = "Error"
        tasks[task_id]["error"] = str(exc)


@app.post("/api/process")
async def process_video(
    video: UploadFile | None = File(default=None),
    url: str = Form(default=""),
    interval: float = Form(default=5.0),
    cookies: UploadFile | None = File(default=None),
) -> dict:
    print(f"[process_video] video truthy={bool(video)}, video.filename={video.filename if video else None}, url={url!r}, interval={interval}, VIDEO.exists={VIDEO.exists()}")
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
            download_video(url.strip(), VIDEO, cookie_path)

        task_id = str(uuid.uuid4())
        tasks[task_id] = {
            "task_id": task_id,
            "status": "processing",
            "stage": "Starting background worker...",
            "error": None,
            "result": None,
        }

        # Run CPU-bound processing in a separate thread so polling requests remain non-blocking
        asyncio.create_task(asyncio.to_thread(_background_worker, task_id, VIDEO, interval))

        return {"task_id": task_id, "status": "processing"}
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc


@app.get("/api/status/{task_id}")
def get_task_status(task_id: str) -> dict:
    if task_id not in tasks:
        raise HTTPException(404, f"Task {task_id} not found.")
    return tasks[task_id]


@app.get("/api/search")
def search(q: str, top_k: int = 6) -> dict:
    if not INDEX.exists() or not DOCUMENTS.exists():
        raise HTTPException(409, "Process a video before searching.")
    model = SentenceTransformer("all-MiniLM-L6-v2")
    index = faiss.read_index(str(INDEX))
    documents = json.loads(DOCUMENTS.read_text(encoding="utf-8"))
    print(f"[search] documents loaded: len(documents)={len(documents)}, index.ntotal={index.ntotal}")
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
    print(f"[search] returning len(results)={len(results)}")
    return {"query": q, "results": results}
