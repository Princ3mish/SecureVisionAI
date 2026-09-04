"""Build and query a multimodal video search index.

This is a standalone version of the supplied Colab workflow. It does not
require notebook magics, Google Colab, or hard-coded /content paths.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import os
from pathlib import Path

DEFAULT_URL = "https://www.youtube.com/watch?v=CiVelfKFtcQ"


def download_video(url: str, destination: Path, cookies: Path | None = None) -> Path:
    import yt_dlp

    destination.parent.mkdir(parents=True, exist_ok=True)
    # Remove any existing incomplete or corrupted video file
    if destination.exists():
        try:
            destination.unlink()
        except Exception:
            pass

    temp_stem = destination.parent / "temp_download"
    for old in destination.parent.glob("temp_download*"):
        try:
            old.unlink()
        except Exception:
            pass

    options = {
        "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "outtmpl": str(temp_stem) + ".%(ext)s",
        "merge_output_format": "mp4",
        "noplaylist": True,
        "quiet": False,
        "extractor_args": {"youtube": {"player_client": ["android", "web"]}},
    }
    if cookies and cookies.exists():
        options["cookiefile"] = str(cookies)

    with yt_dlp.YoutubeDL(options) as downloader:
        downloader.download([url])

    candidates = list(destination.parent.glob("temp_download*.mp4"))
    if not candidates:
        candidates = [p for p in destination.parent.glob("temp_download*") if p.suffix.lower() in {".mp4", ".webm", ".mkv", ".mov"}]
    
    if not candidates:
        raise FileNotFoundError(f"No downloaded video found in {destination.parent}")

    downloaded = candidates[0]
    if destination.exists():
        destination.unlink()
    downloaded.rename(destination)
    return destination


def ensure_ffmpeg() -> str:
    ffmpeg_exe = os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg")
    if not ffmpeg_exe:
        # Fallback check for standard Windows WinGet location
        winget_pattern = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/WinGet/Packages"
        if winget_pattern.exists():
            for p in winget_pattern.glob("**/ffmpeg.exe"):
                ffmpeg_exe = str(p)
                os.environ["FFMPEG_PATH"] = ffmpeg_exe
                bin_dir = str(p.parent)
                if bin_dir not in os.environ.get("PATH", ""):
                    os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
                break
    if not ffmpeg_exe:
        raise RuntimeError(
            "FFmpeg is required and must be available on PATH or set the FFMPEG_PATH environment variable."
        )
    bin_dir = str(Path(ffmpeg_exe).parent)
    if bin_dir not in os.environ.get("PATH", ""):
        os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
    return ffmpeg_exe


def extract_frames(video: Path, frame_dir: Path, interval: float) -> list[dict]:
    """Extract frames using ffmpeg."""
    ffmpeg_exe = ensure_ffmpeg()
    frame_dir.mkdir(parents=True, exist_ok=True)
    for old_frame in frame_dir.glob("frame_*.jpg"):
        old_frame.unlink()
    command = [
        ffmpeg_exe, "-y", "-i", str(video), "-vf", f"fps=1/{interval}",
        "-q:v", "2", str(frame_dir / "frame_%06d.jpg"),
    ]
    completed = subprocess.run(command, capture_output=True, text=True)
    if completed.returncode:
        raise RuntimeError(f"FFmpeg frame extraction failed:\n{completed.stderr[-2000:]}")
    files = sorted(frame_dir.glob("frame_*.jpg"))
    return [{"path": str(path), "timestamp": i * interval} for i, path in enumerate(files)]


def transcribe(video: Path, device: str) -> list[dict]:
    import whisper

    ensure_ffmpeg()
    model = whisper.load_model("base", device=device)
    return model.transcribe(str(video), fp16=device == "cuda")["segments"]


def caption_frames(frames: list[dict], device: str) -> list[dict]:
    import torch
    from PIL import Image
    from transformers import BlipForConditionalGeneration, BlipProcessor

    processor = BlipProcessor.from_pretrained("Salesforce/blip-image-captioning-base")
    model = BlipForConditionalGeneration.from_pretrained(
        "Salesforce/blip-image-captioning-base"
    ).to(device)
    captions = []
    for item in frames:
        image = Image.open(item["path"]).convert("RGB")
        inputs = processor(images=image, return_tensors="pt").to(device)
        with torch.no_grad():
            output = model.generate(**inputs, max_new_tokens=40)
        captions.append({
            "text": "Visual: " + processor.decode(output[0], skip_special_tokens=True),
            "timestamp": item["timestamp"],
            "path": item["path"],
        })
    return captions


def build_index(documents: list[dict], index_path: Path, metadata_path: Path) -> None:
    import faiss
    import numpy as np
    from sentence_transformers import SentenceTransformer

    embedder = SentenceTransformer("all-MiniLM-L6-v2")
    vectors = embedder.encode([doc["text"] for doc in documents], convert_to_numpy=True)
    vectors = np.asarray(vectors, dtype="float32")
    index = faiss.IndexFlatL2(vectors.shape[1])
    index.add(vectors)
    index_path.parent.mkdir(parents=True, exist_ok=True)
    faiss.write_index(index, str(index_path))
    metadata_path.write_text(json.dumps(documents, ensure_ascii=False, indent=2), encoding="utf-8")


def search(query: str, index_path: Path, metadata_path: Path, top_k: int) -> None:
    import faiss
    from sentence_transformers import SentenceTransformer

    documents = json.loads(metadata_path.read_text(encoding="utf-8"))
    index = faiss.read_index(str(index_path))
    embedder = SentenceTransformer("all-MiniLM-L6-v2")
    query_vector = embedder.encode([query], convert_to_numpy=True).astype("float32")
    distances, indices = index.search(query_vector, min(top_k, index.ntotal))
    print(f"\nResults for: {query!r}")
    for rank, (distance, idx) in enumerate(zip(distances[0], indices[0]), 1):
        item = documents[int(idx)]
        seconds = float(item["timestamp"])
        print(f"{rank}. {seconds // 60:02.0f}:{seconds % 60:04.1f}  distance={distance:.3f}")
        print(f"   {item['text']}\n   frame: {item.get('path', 'n/a')}")


def process_pipeline(
    video: Path,
    data_dir: Path,
    interval: float = 5.0,
    progress_callback: callable | None = None,
) -> dict:
    import torch

    def update_progress(msg: str):
        if progress_callback:
            progress_callback(msg)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    frames_dir = data_dir / "frames"
    index_path = data_dir / "index.faiss"
    docs_path = data_dir / "documents.json"

    update_progress("Extracting frames with FFmpeg...")
    frames = extract_frames(video, frames_dir, interval)

    update_progress("Transcribing audio with Whisper...")
    segments = transcribe(video, device)

    update_progress(f"Generating captions for {len(frames)} frames with BLIP...")
    captions = caption_frames(frames, device)

    update_progress("Building FAISS search index...")
    documents = (
        [{"text": "Auditory: " + s["text"].strip(), "timestamp": s["start"]} for s in segments]
        + captions
    )
    documents.sort(key=lambda item: item["timestamp"])
    build_index(documents, index_path, docs_path)

    update_progress("Complete")
    return {
        "ok": True,
        "frames": len(frames),
        "segments": len(segments),
        "device": device,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=False)
    source.add_argument("--video", type=Path, help="Existing local video file")
    source.add_argument("--url", default=None, help="Video URL to download")
    parser.add_argument("--cookies", type=Path, help="yt-dlp cookies.txt, if needed")
    parser.add_argument("--query", default="missile launch", help="Search query")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--interval", type=float, default=5.0, help="Seconds between sampled frames")
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    args = parser.parse_args()

    data_dir = args.data_dir
    video = args.video or data_dir / "video.mp4"
    if args.url:
        video = download_video(args.url, video, args.cookies)
    if not video.exists():
        raise FileNotFoundError("Provide --video or --url; the selected video does not exist.")

    process_pipeline(video, data_dir, args.interval, progress_callback=print)
    search(args.query, data_dir / "index.faiss", data_dir / "documents.json", args.top_k)


if __name__ == "__main__":
    main()
