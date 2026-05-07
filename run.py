"""
Run with:   python run.py
Then open:  http://localhost:8000
"""
import sys
import os

# Make sure backend/ is on the Python path so imports resolve
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "backend"))

import uvicorn

if __name__ == "__main__":
    reload_enabled = os.environ.get("EASYDL_RELOAD", "false").lower() in {"1", "true", "yes", "on"}
    options = {
        "host": os.environ.get("EASYDL_HOST", "127.0.0.1"),
        "port": int(os.environ.get("EASYDL_PORT", "8000")),
        "reload": reload_enabled,
    }
    if reload_enabled:
        options["reload_dirs"] = ["backend"]
    uvicorn.run("main:app", **options)
