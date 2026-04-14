#!/usr/bin/env python3
"""Main entry point for git-deploy-schedule with web UI."""

import sys
import argparse
import subprocess
import threading
import time
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent))

from src.scheduler import GitScheduler
from src.api import app, set_scheduler
import uvicorn


def run_api_server(host: str = "0.0.0.0", port: int = 5000):
    """Run the FastAPI server."""
    uvicorn.run(app, host=host, port=port, log_level="info")


def run_scheduler(scheduler: GitScheduler):
    """Run the scheduler in a thread."""
    try:
        scheduler.run()
    except Exception as e:
        print(f"Scheduler error: {e}")


def ensure_ollama():
    """Start Ollama if it's not already running."""
    try:
        import urllib.request
        urllib.request.urlopen("http://oracle.local:11434/api/tags", timeout=3)
        print("Ollama: already running")
    except Exception:
        print("Ollama: not running, starting...")
        subprocess.Popen(
            ["ollama", "serve"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(2)
        print("Ollama: started")


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Git Deploy Scheduler with Web UI"
    )

    parser.add_argument(
        '--config',
        type=str,
        default='config/config.yaml',
        help='Path to configuration file (default: config/config.yaml)'
    )

    parser.add_argument(
        '--port',
        type=int,
        default=5000,
        help='API server port (default: 5000)'
    )

    parser.add_argument(
        '--host',
        type=str,
        default='0.0.0.0',
        help='API server host (default: 0.0.0.0)'
    )

    parser.add_argument(
        '--no-scheduler',
        action='store_true',
        help='Run only the API server without the scheduler'
    )

    args = parser.parse_args()

    try:
        # Ensure Ollama is running for AI commit messages
        ensure_ollama()

        # Initialize scheduler
        scheduler = GitScheduler(config_path=args.config)
        set_scheduler(scheduler)

        print("=" * 60)
        print("Git Deploy Scheduler with Web UI")
        print("=" * 60)
        print(f"API Server: http://{args.host}:{args.port}")
        print(f"Web UI: http://localhost:{args.port}")
        print("=" * 60)

        if args.no_scheduler:
            print("Running in API-only mode (scheduler disabled)")
            run_api_server(host=args.host, port=args.port)
        else:
            # Run scheduler in background thread
            scheduler_thread = threading.Thread(target=run_scheduler, args=(scheduler,))
            scheduler_thread.daemon = True
            scheduler_thread.start()

            # Run API server in main thread
            run_api_server(host=args.host, port=args.port)

    except KeyboardInterrupt:
        print("\nShutting down...")
        sys.exit(0)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
