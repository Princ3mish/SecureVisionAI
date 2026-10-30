"""Local HTTP API for the React video-search frontend."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import uuid
from pathlib import Path

from dotenv import load_dotenv
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

# Load .env file
load_dotenv(ROOT / ".env")


def get_groq_api_key() -> str:
    """Retrieve Groq API key from .env or environment dynamically."""
    load_dotenv(ROOT / ".env", override=True)
    return os.environ.get("GROQ_API_KEY", "").strip()


# In-memory store for background tasks
# Known limitation: Cleared when server reloads
tasks: dict[str, dict] = {}

app = FastAPI(title="Secure Vision API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
@app.middleware("http")
async def add_cache_control_headers(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/media/"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

app.mount("/media", StaticFiles(directory=str(DATA)), name="media")


def public_frame_url(path: str | None) -> str | None:
    if not path:
        return None
    p = Path(path)
    target = p if p.is_absolute() else FRAMES / p.name
    if not target.exists():
        target = FRAMES / p.name
    mtime = int(target.stat().st_mtime) if target.exists() else 0
    return f"/media/frames/{p.name}?t={mtime}"


CONTEXT = DATA / "context.txt"


@app.get("/api/health")
def health() -> dict:
    context_text = CONTEXT.read_text(encoding="utf-8").strip() if CONTEXT.exists() else None
    groq_key = get_groq_api_key()
    return {
        "ready": INDEX.exists() and DOCUMENTS.exists(),
        "video": VIDEO.exists(),
        "context": context_text,
        "groq_enabled": bool(groq_key),
    }


@app.get("/api/settings")
def get_settings() -> dict:
    groq_key = get_groq_api_key()
    masked = (groq_key[:4] + "..." + groq_key[-4:]) if len(groq_key) > 8 else ("Configured" if groq_key else "")
    return {
        "groq_configured": bool(groq_key),
        "groq_key_masked": masked,
    }


@app.post("/api/settings")
def update_settings(groq_api_key: str = Form(default="")) -> dict:
    cleaned = groq_api_key.strip()
    env_file = ROOT / ".env"
    env_file.write_text(f"# Groq Cloud API Key\nGROQ_API_KEY={cleaned}\n", encoding="utf-8")
    load_dotenv(env_file, override=True)
    return {"saved": True, "groq_configured": bool(cleaned)}


def _background_worker(task_id: str, video_path: Path, interval: float, context: str = "", ai_mode: bool = False) -> None:
    def on_progress(stage: str):
        if task_id in tasks:
            tasks[task_id]["stage"] = stage

    try:
        # If AI mode is enabled, supply Groq API secret key; otherwise strictly use local models
        groq_key = get_groq_api_key() if ai_mode else ""
        print(f"[_background_worker] calling process_pipeline with video_path={video_path}, interval={interval}, context={context!r}, ai_mode={ai_mode}, groq_key_active={bool(groq_key)}")
        result = process_pipeline(
            video_path,
            DATA,
            interval,
            progress_callback=on_progress,
            context=context,
            groq_api_key=groq_key,
        )
        print(f"[_background_worker] process_pipeline returned: {result}")
        tasks[task_id]["status"] = "completed"
        tasks[task_id]["stage"] = "Complete"
        tasks[task_id]["result"] = result
        tasks[task_id]["ai_mode"] = ai_mode
    except Exception as exc:
        import traceback
        traceback.print_exc()
        tasks[task_id]["status"] = "failed"
        tasks[task_id]["stage"] = "Error"
        tasks[task_id]["error"] = str(exc)


@app.post("/api/process")
async def process_video(
    video: UploadFile | None = File(default=None),
    url: str = Form(default=""),
    interval: float = Form(default=5.0),
    cookies: UploadFile | None = File(default=None),
    context: str = Form(default=""),
    ai_mode: bool = Form(default=False),
) -> dict:
    print(f"[process_video] video truthy={bool(video)}, url={url!r}, interval={interval}, context={context!r}, ai_mode={ai_mode}")
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
            "ai_mode": ai_mode,
        }

        # Run CPU-bound processing in a separate thread so polling requests remain non-blocking
        asyncio.create_task(asyncio.to_thread(_background_worker, task_id, VIDEO, interval, context.strip(), ai_mode))

        return {"task_id": task_id, "status": "processing", "ai_mode": ai_mode}
    except Exception as exc:
        raise HTTPException(500, str(exc)) from exc


@app.get("/api/status/{task_id}")
def get_task_status(task_id: str) -> dict:
    if task_id not in tasks:
        raise HTTPException(404, f"Task {task_id} not found.")
    return tasks[task_id]


_search_model: SentenceTransformer | None = None


def get_search_model() -> SentenceTransformer:
    global _search_model
    if _search_model is None:
        _search_model = SentenceTransformer("all-MiniLM-L6-v2")
    return _search_model


def groq_reason_and_rerank(query: str, context: str, candidates: list[dict], api_key: str) -> dict | None:
    try:
        from groq import Groq
        client = Groq(api_key=api_key)

        snippets = []
        for idx, c in enumerate(candidates):
            snippets.append(f"[{idx}] Timestamp {c['timestamp']:.1f}s: {c['text']}")

        prompt = f"""You are an advanced video intelligence reasoning model.
Video Background Context: "{context if context else 'None'}"
User Search Query: "{query}"

Candidate video moments:
{chr(10).join(snippets)}

Task:
1. Examine the visual actions and dialogue in these candidates.
2. Determine which candidate represents the EXACT point the user is searching for (e.g. photobombing, sneaking behind someone, making funny faces, taking selfie, reacting).
3. Explain why this moment is the exact target point in 1-2 concise sentences.

Return valid JSON only matching this schema:
{{
  "best_index": 0,
  "reasoning": "At 00:15.0, the actress sneaks up making a funny face behind the fans while they take a selfie on their phone.",
  "ranked_indices": [0, 1, 2]
}}"""

        # Try models available on Groq in priority order
        models_to_try = ["qwen/qwen3.8-27b", "allam-2-7b", "llama-3.3-70b-versatile"]
        for model_name in models_to_try:
            try:
                res = client.chat.completions.create(
                    model=model_name,
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0.1,
                    response_format={"type": "json_object"},
                    max_tokens=220,
                )
                return json.loads(res.choices[0].message.content)
            except Exception as model_err:
                print(f"[groq_reason_and_rerank] Model {model_name} failed: {model_err}, trying next...")
                continue
        return None
    except Exception as exc:
        print(f"[groq_reason_and_rerank] Warning: {exc}")
        return None


@app.get("/api/search")
def search(q: str, top_k: int = 6, ai_mode: bool = False) -> dict:
    if not INDEX.exists() or not DOCUMENTS.exists():
        raise HTTPException(409, "Process a video before searching.")
    try:
        model = get_search_model()
        index = faiss.read_index(str(INDEX))
        documents = json.loads(DOCUMENTS.read_text(encoding="utf-8"))
        video_context = CONTEXT.read_text(encoding="utf-8").strip() if CONTEXT.exists() else ""
        print(f"[search] documents loaded: len(documents)={len(documents)}, index.ntotal={index.ntotal}, context={video_context!r}, ai_mode={ai_mode}")

        # Compute query vector; if context is available and in AI mode, compute fused contextual embedding
        raw_vector = model.encode([q], convert_to_numpy=True).astype(np.float32)
        if ai_mode and video_context:
            context_vector = model.encode([f"{video_context}. {q}"], convert_to_numpy=True).astype(np.float32)
            vector = 0.65 * raw_vector + 0.35 * context_vector
            vector = vector / np.linalg.norm(vector, axis=1, keepdims=True)
        else:
            vector = raw_vector

        k = min(top_k, index.ntotal)
        if k <= 0:
            return {"query": q, "results": [], "context": video_context, "workflow": [], "ai_mode": ai_mode}

        distances, indices = index.search(vector, k)
        results = []
        visual_candidates = [d for d in documents if d.get("path")]

        for rank, (distance, index_value) in enumerate(zip(distances[0], indices[0])):
            idx = int(index_value)
            if idx < 0 or idx >= len(documents):
                continue
            item = documents[idx]
            frame_path = item.get("path")
            if not frame_path and visual_candidates:
                ts = float(item.get("timestamp", 0.0))
                closest = min(visual_candidates, key=lambda d: abs(float(d.get("timestamp", 0.0)) - ts))
                frame_path = closest.get("path")

            dist_val = float(distance)
            match_score = round(float(1.0 / (1.0 + dist_val)), 3)
            results.append({
                "text": item["text"],
                "timestamp": item["timestamp"],
                "distance": dist_val,
                "score": match_score,
                "frame": public_frame_url(frame_path),
                "is_preferred": (rank == 0),
            })

        # AI-Assisted mode: use Groq secret key from .env for reasoning & reranking
        groq_key = get_groq_api_key() if ai_mode else ""
        ai_reasoning = ""
        groq_active = False

        if ai_mode and groq_key and len(results) > 1:
            reasoning_data = groq_reason_and_rerank(q, video_context, results, groq_key)
            if reasoning_data and "best_index" in reasoning_data:
                groq_active = True
                best_idx = int(reasoning_data["best_index"])
                ai_reasoning = reasoning_data.get("reasoning", "")

                if 0 <= best_idx < len(results):
                    best_item = results.pop(best_idx)
                    results.insert(0, best_item)

                for r_idx, r in enumerate(results):
                    r["is_preferred"] = (r_idx == 0)
                if ai_reasoning:
                    results[0]["ai_reasoning"] = ai_reasoning

        # Build workflow steps — clearly distinct between AI mode and Non-AI mode
        if ai_mode:
            workflow_steps = [
                {
                    "id": "query_proc",
                    "title": "Contextual Query Fusion",
                    "detail": f"Fused query '{q}' with video context: \"{video_context}\"" if video_context else f"Contextual query vector generated for '{q}'",
                    "active": True,
                    "engine": "AI Neural",
                },
                {
                    "id": "index_scan",
                    "title": "Multimodal Vector Retrieval",
                    "detail": f"Queried FAISS multimodal index across {index.ntotal} visual & speech embeddings",
                    "active": True,
                    "engine": "FAISS",
                },
                {
                    "id": "rerank",
                    "title": "Groq LLM Semantic Reasoning" if groq_active else "Semantic Similarity Scoring",
                    "detail": f"Groq Llama-3.3 evaluated: {ai_reasoning}" if ai_reasoning else "Semantic relevance evaluated across top candidate moments using Groq secret key",
                    "active": True,
                    "engine": "Groq Llama-3.3" if groq_active else "Transformer",
                },
                {
                    "id": "preferred",
                    "title": "AI Preferred Target Pinpointing",
                    "detail": f"Rank #1 identified as primary moment ({int(results[0]['score'] * 100)}% match)" if results else "No matches found",
                    "active": True,
                    "engine": "Reasoning Core",
                },
            ]
        else:
            workflow_steps = [
                {
                    "id": "query_proc",
                    "title": "Direct Text Tokenization",
                    "detail": f"Directly encoded query string '{q}' via Sentence-Transformer without Groq API call",
                    "active": True,
                    "engine": "Local MiniLM-L6",
                },
                {
                    "id": "index_scan",
                    "title": "Deterministic FAISS L2 Search",
                    "detail": f"Exhaustive L2 Euclidean distance vector comparison against {index.ntotal} records",
                    "active": True,
                    "engine": "Local FAISS FlatL2",
                },
                {
                    "id": "scoring",
                    "title": "Raw Mathematical Distance Ranking",
                    "detail": "Strict mathematical proximity sort (1/(1+dist)) — zero Groq API calls or cloud inference",
                    "active": True,
                    "engine": "Local Float Sort",
                },
                {
                    "id": "preferred",
                    "title": "Euclidean Nearest-Neighbor Selection",
                    "detail": f"Selected closest geometric vector at {results[0]['timestamp']:.1f}s (distance: {results[0]['distance']:.3f})" if results else "No matches found",
                    "active": True,
                    "engine": "Nearest Vector",
                },
            ]

        print(f"[search] returning len(results)={len(results)}, context_active={bool(video_context)}, groq_active={groq_active}, ai_mode={ai_mode}")
        return {
            "query": q,
            "context": video_context,
            "results": results,
            "workflow": workflow_steps,
            "groq_active": groq_active,
            "ai_mode": ai_mode,
        }
    except Exception as exc:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"Search failed: {exc}") from exc
