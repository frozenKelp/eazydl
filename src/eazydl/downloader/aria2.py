from __future__ import annotations

import shutil
import subprocess
import time
import sys
from typing import Any

import requests


class Aria2Client:
    def __init__(self, rpc_url: str = "http://127.0.0.1:6800/jsonrpc") -> None:
        self.rpc_url = rpc_url
        self.process: subprocess.Popen[bytes] | None = None
        self.owns_process = False
        self._rpc_id = 1

    def rpc(self, method: str, params: list[Any] | None = None) -> Any:
        payload = {"jsonrpc": "2.0", "id": str(self._rpc_id), "method": method, "params": params or []}
        self._rpc_id += 1
        response = requests.post(self.rpc_url, json=payload, timeout=10)
        response.raise_for_status()
        data = response.json()
        if data.get("error"):
            raise RuntimeError(data["error"].get("message") or "aria2 RPC error")
        return data.get("result")

    def is_available(self) -> bool:
        try:
            self.rpc("aria2.getGlobalStat")
            return True
        except Exception:
            return False

    def start(self, max_concurrent: int = 3) -> None:
        if self.is_available():
            self.set_max_concurrent(max_concurrent)
            return
        exe = shutil.which("aria2c")
        if not exe:
            raise RuntimeError("aria2c executable not found on PATH")
        creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        self.process = subprocess.Popen(
            [
                exe,
                "--enable-rpc",
                "--rpc-listen-all=false",
                "--rpc-listen-port=6800",
                "--rpc-allow-origin-all=true",
                f"--max-concurrent-downloads={max_concurrent}",
                "--continue=true",
                "--auto-file-renaming=true",
                "--allow-overwrite=false",
                "--quiet=true",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
        )
        self.owns_process = True
        for _ in range(20):
            time.sleep(0.2)
            if self.is_available():
                return
        raise RuntimeError("aria2c started but RPC did not become available")

    def shutdown(self) -> None:
        if self.owns_process:
            try:
                self.rpc("aria2.shutdown")
            except Exception:
                pass
        if self.process:
            self.process.kill()

    def set_max_concurrent(self, value: int) -> None:
        self.rpc("aria2.changeGlobalOption", [{"max-concurrent-downloads": str(max(1, value))}])

    def add_uri(self, url: str, output_dir: str, filename: str, connections: int) -> str:
        return str(
            self.rpc(
                "aria2.addUri",
                [
                    [url],
                    {
                        "dir": output_dir,
                        "out": filename,
                        "continue": "true",
                        "split": str(max(1, connections)),
                        "max-connection-per-server": str(max(1, connections)),
                        "min-split-size": "1M",
                    },
                ],
            )
        )

    def pause(self, gid: str) -> None:
        self.rpc("aria2.pause", [gid])

    def unpause(self, gid: str) -> None:
        self.rpc("aria2.unpause", [gid])

    def remove(self, gid: str) -> None:
        self.rpc("aria2.remove", [gid])

    def tell(self, gid: str) -> dict[str, Any] | None:
        try:
            return self.rpc(
                "aria2.tellStatus",
                [gid, ["gid", "status", "completedLength", "totalLength", "downloadSpeed", "connections", "errorMessage", "files"]],
            )
        except Exception:
            return None

    def stats(self) -> dict[str, Any]:
        if not self.is_available():
            return {"aria2_running": False}
        data = self.rpc("aria2.getGlobalStat")
        return {
            "aria2_running": True,
            "download_speed": int(data.get("downloadSpeed") or 0),
            "upload_speed": int(data.get("uploadSpeed") or 0),
            "num_active": int(data.get("numActive") or 0),
            "num_waiting": int(data.get("numWaiting") or 0),
            "num_stopped": int(data.get("numStoppedTotal") or 0),
        }
