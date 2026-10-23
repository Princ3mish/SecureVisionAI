"""Subprocess worker for video processing. Writes progress to task_status.json."""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

STATUS_FILE = None


def write_status(task_id: str, **fields: object) -> None:
    data = {"task_id": task_id}
    if STATUS_FILE and STATUS_FILE.exists():
        try:
            data = json.loads(STATUS_FILE.read_text())
        except Exception:
            pass
    data.update(fields)
    STATUS_FILE.write_text(json.dumps(data))


def main() -> None:
    global STATUS_FILE
    video_path = Path(sys.argv[1])
    data_dir = Path(sys.argv[2])
    interval = float(sys.argv[3])
    task_id = sys.argv[4]

    STATUS_FILE = data_dir / "task_status.json"

    write_status(task_id, status="processing", stage="Initializing models...", error=None, result=None)

    try:
        from app import process_pipeline

        def on_progress(stage: str) -> None:
            print(f"[worker] {stage}", flush=True)
            write_status(task_id, stage=stage)

        result = process_pipeline(video_path, data_dir, interval, progress_callback=on_progress)
        print(f"[worker] done: {result}", flush=True)
        write_status(task_id, status="completed", stage="Complete", result=result)
    except Exception as exc:
        traceback.print_exc()
        write_status(task_id, status="failed", stage="Error", error=str(exc))
        sys.exit(1)


if __name__ == "__main__":
    main()
