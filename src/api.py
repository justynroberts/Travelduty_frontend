"""FastAPI HTTP server for web UI integration."""

import logging
import os
import subprocess
from typing import Optional, Dict, Any
from datetime import datetime
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .database import Database


logger = logging.getLogger(__name__)

app = FastAPI(title="Git Deploy Scheduler API")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global scheduler instance (set from main)
scheduler_instance = None
db_instance = None


def set_scheduler(scheduler):
    """Set the scheduler instance for API access."""
    global scheduler_instance, db_instance
    scheduler_instance = scheduler
    db_instance = scheduler.db if scheduler else None


class ControlAction(BaseModel):
    """Control action model."""
    action: str  # pause, resume, trigger


class TokenUpdate(BaseModel):
    """Token update model."""
    token: str


# Token storage path (in mounted database directory for persistence)
TOKEN_FILE = Path("database/.github_token")


@app.get("/")
async def root():
    """Serve the main UI page."""
    return FileResponse("web/frontend/index.html")


@app.get("/api/status")
async def get_status():
    """Get current scheduler status."""
    if not scheduler_instance:
        raise HTTPException(status_code=503, detail="Scheduler not initialized")

    try:
        last_commit = db_instance.get_last_commit() if db_instance else None

        # Calculate next commit time
        next_in = None
        if hasattr(scheduler_instance, 'next_commit_time') and scheduler_instance.next_commit_time:
            next_in = int((scheduler_instance.next_commit_time - datetime.now()).total_seconds())
            next_in = max(0, next_in)

        return {
            "running": True,
            "paused": getattr(scheduler_instance, 'paused', False),
            "next_commit_in": next_in,
            "last_commit": {
                "hash": last_commit['hash'][:7] if last_commit else None,
                "message": last_commit['message'] if last_commit else None,
                "timestamp": last_commit['timestamp'] if last_commit else None,
                "files_changed": last_commit['files_changed'] if last_commit else 0,
                "success": last_commit['success'] if last_commit else False,
            } if last_commit else None,
            "ollama_available": scheduler_instance.ollama_client is not None if scheduler_instance else False,
            "current_theme": scheduler_instance.config.get('ollama.theme', '') if scheduler_instance else '',
            "repository": scheduler_instance.git_ops.repo_path if scheduler_instance and scheduler_instance.git_ops else None,
            "branch": scheduler_instance.git_ops.get_current_branch() if scheduler_instance and scheduler_instance.git_ops else None,
        }
    except Exception as e:
        logger.error(f"Error getting status: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/history")
async def get_history(limit: int = 50):
    """Get commit history."""
    if not db_instance:
        raise HTTPException(status_code=503, detail="Database not initialized")

    try:
        commits = db_instance.get_recent_commits(limit=limit)
        total = db_instance.get_commit_count()

        return {
            "commits": commits,
            "total": total
        }
    except Exception as e:
        logger.error(f"Error getting history: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/stats")
async def get_stats():
    """Get statistics."""
    if not db_instance:
        raise HTTPException(status_code=503, detail="Database not initialized")

    try:
        daily_stats = db_instance.get_daily_stats(days=7)
        commit_types = db_instance.get_commit_types()

        # Calculate commits last 24h
        commits_24h = daily_stats[0]['total_commits'] if daily_stats else 0

        # Get commits by day for chart
        commits_by_day = [stat['total_commits'] for stat in reversed(daily_stats)]

        return {
            "total_commits": db_instance.get_commit_count(),
            "success_rate": round(db_instance.get_success_rate(), 1),
            "ollama_usage_rate": round(db_instance.get_ollama_usage_rate(), 1),
            "commits_last_24h": commits_24h,
            "commits_by_day": commits_by_day,
            "commit_types": commit_types
        }
    except Exception as e:
        logger.error(f"Error getting stats: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/control")
async def control_action(action: ControlAction):
    """Control the scheduler."""
    if not scheduler_instance:
        raise HTTPException(status_code=503, detail="Scheduler not initialized")

    try:
        if action.action == "pause":
            scheduler_instance.paused = True
            logger.info("Scheduler paused via API")
            return {"status": "paused"}

        elif action.action == "resume":
            scheduler_instance.paused = False
            logger.info("Scheduler resumed via API")
            return {"status": "resumed"}

        elif action.action == "trigger":
            # Trigger immediate commit in background
            def trigger_commit():
                try:
                    scheduler_instance._perform_commit()
                except Exception as e:
                    logger.error(f"Error triggering commit: {e}")

            thread = threading.Thread(target=trigger_commit)
            thread.daemon = True
            thread.start()

            logger.info("Commit triggered via API")
            return {"status": "triggered"}

        else:
            raise HTTPException(status_code=400, detail=f"Unknown action: {action.action}")

    except Exception as e:
        logger.error(f"Error in control action: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/config")
async def get_config():
    """Get current configuration."""
    if not scheduler_instance:
        raise HTTPException(status_code=503, detail="Scheduler not initialized")

    try:
        return {
            "config": scheduler_instance.config.config
        }
    except Exception as e:
        logger.error(f"Error getting config: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/logs")
async def get_logs(lines: int = 100):
    """Get recent log entries."""
    try:
        log_file = "logs/scheduler.log"
        with open(log_file, 'r') as f:
            log_lines = f.readlines()
            recent_logs = log_lines[-lines:]
            return {"logs": recent_logs}
    except Exception as e:
        logger.error(f"Error getting logs: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _configure_git_credentials(token: str):
    """Configure git to use the token for authentication."""
    try:
        # Set credential helper
        subprocess.run(["git", "config", "--global", "credential.helper", "store"], check=True)

        # Write credentials file
        creds_file = Path.home() / ".git-credentials"
        creds_file.write_text(f"https://x-access-token:{token}@github.com\n")
        creds_file.chmod(0o600)

        logger.info("Git credentials configured successfully")
        return True
    except Exception as e:
        logger.error(f"Failed to configure git credentials: {e}")
        return False


def _load_saved_token():
    """Load token from file if it exists."""
    if TOKEN_FILE.exists():
        try:
            token = TOKEN_FILE.read_text().strip()
            if token:
                _configure_git_credentials(token)
                return True
        except Exception as e:
            logger.error(f"Failed to load saved token: {e}")
    return False


# Load saved token on startup
_load_saved_token()


@app.get("/api/settings")
async def get_settings():
    """Get current settings."""
    has_token = TOKEN_FILE.exists() and TOKEN_FILE.read_text().strip() != ""

    # Test git push capability
    push_enabled = False
    if has_token:
        try:
            result = subprocess.run(
                ["git", "ls-remote", "--exit-code", "origin"],
                capture_output=True,
                timeout=10,
                cwd=os.environ.get("REPO_PATH", "/repo")
            )
            push_enabled = result.returncode == 0
        except Exception:
            pass

    return {
        "has_github_token": has_token,
        "push_enabled": push_enabled
    }


@app.post("/api/settings/token")
async def set_token(data: TokenUpdate):
    """Save GitHub token."""
    try:
        # Save token to file
        TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
        TOKEN_FILE.write_text(data.token)
        TOKEN_FILE.chmod(0o600)

        # Configure git credentials
        if _configure_git_credentials(data.token):
            logger.info("GitHub token saved and configured")
            return {"status": "success", "message": "Token saved successfully"}
        else:
            raise HTTPException(status_code=500, detail="Failed to configure git credentials")

    except Exception as e:
        logger.error(f"Error saving token: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/settings/token")
async def delete_token():
    """Remove saved GitHub token."""
    try:
        if TOKEN_FILE.exists():
            TOKEN_FILE.unlink()

        # Remove credentials file
        creds_file = Path.home() / ".git-credentials"
        if creds_file.exists():
            creds_file.unlink()

        logger.info("GitHub token removed")
        return {"status": "success", "message": "Token removed"}

    except Exception as e:
        logger.error(f"Error removing token: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/settings/test-push")
async def test_push():
    """Test git push capability with saved token."""
    try:
        repo_path = os.environ.get("REPO_PATH", "/repo")

        # Test remote access
        result = subprocess.run(
            ["git", "ls-remote", "--exit-code", "origin"],
            capture_output=True,
            text=True,
            timeout=15,
            cwd=repo_path
        )

        if result.returncode == 0:
            return {"status": "success", "message": "Git remote access working"}
        else:
            return {"status": "error", "message": f"Git remote access failed: {result.stderr}"}

    except subprocess.TimeoutExpired:
        return {"status": "error", "message": "Connection timed out"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.post("/api/settings/test-token")
async def test_token(data: TokenUpdate):
    """Test a token by checking push permissions via GitHub API."""
    import urllib.request
    import json as json_module

    try:
        repo_path = os.environ.get("REPO_PATH", "/repo")

        # Get the remote URL
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            cwd=repo_path
        )

        if result.returncode != 0:
            return {"status": "error", "message": "Could not get remote URL"}

        remote_url = result.stdout.strip()

        # Extract owner/repo from URL
        # https://github.com/owner/repo.git -> owner/repo
        if "github.com" not in remote_url:
            return {"status": "error", "message": "Remote is not a GitHub URL"}

        # Parse owner/repo
        parts = remote_url.replace("https://github.com/", "").replace("git@github.com:", "").replace(".git", "").split("/")
        if len(parts) < 2:
            return {"status": "error", "message": "Could not parse repo from URL"}

        owner, repo = parts[0], parts[1]

        # Check token permissions via GitHub API
        api_url = f"https://api.github.com/repos/{owner}/{repo}"
        req = urllib.request.Request(api_url)
        req.add_header("Authorization", f"token {data.token}")
        req.add_header("Accept", "application/vnd.github.v3+json")
        req.add_header("User-Agent", "git-deploy-scheduler")

        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                repo_data = json_module.loads(response.read().decode())

                # Check if we have push permission
                permissions = repo_data.get("permissions", {})
                can_push = permissions.get("push", False)

                if can_push:
                    return {"status": "success", "message": "Token valid with push access!"}
                else:
                    return {"status": "error", "message": "Token valid but no push permission"}

        except urllib.error.HTTPError as e:
            if e.code == 401:
                return {"status": "error", "message": "Invalid token"}
            elif e.code == 403:
                return {"status": "error", "message": "Token lacks repo access"}
            elif e.code == 404:
                return {"status": "error", "message": "Repo not found or token lacks access"}
            else:
                return {"status": "error", "message": f"GitHub API error: {e.code}"}

    except Exception as e:
        logger.error(f"Error testing token: {e}")
        return {"status": "error", "message": str(e)}


# Mount static files
try:
    app.mount("/static", StaticFiles(directory="web/frontend"), name="static")
except Exception:
    pass  # Static files may not exist yet
