"""`uvicorn kerf_server.main:app` entry point, configured from KERF_* environment variables.

`kerf-server` (or `python -m kerf_server.main`) runs it with uvicorn on KERF_HOST:KERF_PORT (default 0.0.0.0:8000).
"""
import os

from .app import create_app

app = create_app()


def run() -> None:
    import uvicorn

    uvicorn.run(
        "kerf_server.main:app",
        host=os.environ.get("KERF_HOST", "0.0.0.0"),
        port=int(os.environ.get("KERF_PORT", "8000")),
        proxy_headers=True,  # behind Caddy/nginx: trust X-Forwarded-*
        forwarded_allow_ips=os.environ.get("KERF_FORWARDED_ALLOW_IPS", "127.0.0.1"),
        log_level=os.environ.get("KERF_LOG_LEVEL", "info").lower(),
    )


if __name__ == "__main__":
    run()
