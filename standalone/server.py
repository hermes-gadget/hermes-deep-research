#!/usr/bin/env python3
"""Standalone web UI for the Deep Research plugin — no Hermes dashboard needed.

Serves the plugin's FastAPI router at /api/plugins/deep-research/* plus the
bundled frontend (with a Hermes plugin-SDK shim), so the same UI runs outside
the dashboard.

Usage:
  python3 standalone/server.py [--host 127.0.0.1] [--port 8842] [--token TOKEN]

Env vars DR_HOST / DR_PORT / DR_TOKEN work too. Requirements:
  pip install -r standalone/requirements.txt

With a Hermes install present it reads ~/.hermes/config.yaml (LLM + search
providers) and tracks jobs on the Kanban board; without Hermes it falls back to
OPENAI_API_KEY / OPENAI_BASE_URL env vars and skips Kanban tracking.
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STANDALONE = Path(__file__).resolve().parent
DIST = ROOT / "dashboard" / "dist"

_VENDOR_FILES = {
    "react.production.min.js": "application/javascript",
    "react-dom.production.min.js": "application/javascript",
}
_DIST_FILES = {
    "index.js": "application/javascript",
    "style.css": "text/css",
}


def _load_plugin_api():
    spec = importlib.util.spec_from_file_location(
        "deep_research_plugin_api", ROOT / "dashboard" / "plugin_api.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def create_app(token: str | None = None):
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
    from starlette.middleware.base import BaseHTTPMiddleware

    api = _load_plugin_api()
    app = FastAPI(title="Deep Research (standalone)", docs_url=None, redoc_url=None)
    app.include_router(api.router, prefix="/api/plugins/deep-research")

    @app.get("/healthz")
    def healthz() -> dict:
        return {"ok": True}

    @app.get("/", response_class=HTMLResponse)
    def index() -> HTMLResponse:
        return HTMLResponse((STANDALONE / "index.html").read_text())

    @app.get("/sdk-shim.js")
    def sdk_shim() -> FileResponse:
        return FileResponse(STANDALONE / "sdk-shim.js", media_type="application/javascript")

    @app.get("/vendor/{name}")
    def vendor(name: str) -> FileResponse:
        media = _VENDOR_FILES.get(name)
        if not media:
            raise HTTPException(status_code=404, detail="not found")
        return FileResponse(STANDALONE / "vendor" / name, media_type=media)

    @app.get("/dist/{name}")
    def dist(name: str) -> FileResponse:
        media = _DIST_FILES.get(name)
        if not media:
            raise HTTPException(status_code=404, detail="not found")
        return FileResponse(DIST / name, media_type=media)

    if token:
        class TokenGate(BaseHTTPMiddleware):
            """Optional shared-token auth: /api/* requires the token via header,
            cookie, or query; GET / with ?token= sets the cookie once."""

            async def dispatch(self, request: Request, call_next):
                if request.url.path.startswith("/api/"):
                    supplied = (
                        request.headers.get("x-hermes-session-token")
                        or request.cookies.get("dr_token")
                        or request.query_params.get("token")
                    )
                    if supplied != token:
                        return JSONResponse({"error": "unauthorized"}, status_code=401)
                resp = await call_next(request)
                if request.url.path == "/" and request.query_params.get("token") == token:
                    resp.set_cookie("dr_token", token, httponly=False, samesite="lax")
                return resp

        app.add_middleware(TokenGate)

    return app


def main() -> int:
    ap = argparse.ArgumentParser(description="Standalone Deep Research web UI")
    ap.add_argument("--host", default=os.environ.get("DR_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("DR_PORT", "8842")))
    ap.add_argument("--token", default=os.environ.get("DR_TOKEN") or None,
                    help="optional shared token; open /?token=<token> once")
    args = ap.parse_args()

    try:
        import uvicorn
    except ImportError:
        print("uvicorn is required: pip install -r standalone/requirements.txt", file=sys.stderr)
        return 1

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print(f"note: binding {args.host} exposes this UI beyond localhost"
              + (" (token auth is ON)" if args.token else " — consider --token"), file=sys.stderr)

    uvicorn.run(create_app(token=args.token), host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
