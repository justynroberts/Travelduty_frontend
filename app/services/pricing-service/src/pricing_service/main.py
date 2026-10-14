"""ASGI entrypoint: `uvicorn pricing_service.main:app`."""

from .app import create_app

app = create_app()
