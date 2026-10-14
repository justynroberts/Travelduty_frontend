"""ASGI entrypoint: `uvicorn destination_service.main:app`."""

from .app import create_app

app = create_app()
