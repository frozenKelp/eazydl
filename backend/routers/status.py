import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from downloader import dm

router = APIRouter()


@router.get("/api/status")
async def api_status():
    return await dm.global_stats()


@router.websocket("/ws/progress")
async def ws_progress(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            await ws.send_json({
                "type": "progress",
                "data": dm.all_progress(),
                "aria2_ok": dm.is_running,
            })
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
