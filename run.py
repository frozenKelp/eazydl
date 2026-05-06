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
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        reload_dirs=["backend"],
    )
