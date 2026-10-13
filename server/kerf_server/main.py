"""`uvicorn kerf_server.main:app` entry point, configured from KERF_* environment variables."""
from .app import create_app

app = create_app()
