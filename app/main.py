"""FastAPI 入口：计算接口 + 静态页面托管。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .core import CalibrationError, infer_opacities, solve

app = FastAPI(title="透明图层叠序校准台", version="1.1.0")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/solve")
async def api_solve(request: Request) -> JSONResponse:
    try:
        payload: Any = await request.json()
    except Exception:
        return JSONResponse(
            status_code=400,
            content={"errors": [{"scope": "form", "message": "请求体不是合法的 JSON"}]},
        )
    try:
        result = solve(payload)
    except CalibrationError as exc:
        return JSONResponse(status_code=400, content={"errors": exc.errors})
    return JSONResponse(status_code=200, content=result)


@app.post("/api/infer-opacity")
async def api_infer_opacity(request: Request) -> JSONResponse:
    try:
        payload: Any = await request.json()
    except Exception:
        return JSONResponse(
            status_code=400,
            content={"errors": [{"scope": "form", "message": "请求体不是合法的 JSON"}]},
        )
    try:
        result = infer_opacities(payload)
    except CalibrationError as exc:
        return JSONResponse(status_code=400, content={"errors": exc.errors})
    return JSONResponse(status_code=200, content=result)


STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
