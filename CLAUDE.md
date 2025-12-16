# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Git Deploy Schedule is an automated git commit scheduler that uses Ollama AI to generate contextual commit messages. It commits changes at randomized intervals (10 minutes ± 50 seconds) with intelligent commit messages based on actual file diffs.

The project has three deployment modes:
1. **CLI Mode** (`main.py`) - Command-line scheduler for headless/server operation
2. **Web UI Mode** (`main_web.py`) - Web-based dashboard with real-time monitoring via FastAPI
3. **Electron App** (`electron-app/`) - Desktop application wrapper for the web UI

## Common Commands

### Python Backend

```bash
# Install dependencies
pip install -r requirements.txt

# CLI Mode - Run scheduler continuously
python main.py

# CLI Mode - Run once (testing mode)
python main.py --once

# CLI Mode - Check scheduler status
python main.py --status

# Web UI Mode - Run scheduler with web interface
python main_web.py

# Web UI Mode - API only (no scheduler)
python main_web.py --no-scheduler

# Web UI Mode - Custom port
python main_web.py --port 8080
```

### Testing
```bash
# Run all tests
pytest

# Run with coverage
pytest --cov=src --cov-report=html

# Run specific test file
pytest tests/test_config.py

# Run specific test
pytest tests/test_config.py::test_config_load
```

### Electron App
```bash
cd electron-app

# Install dependencies
npm install

# Run in development
npm run dev

# Build for current platform
npm run build

# Build for specific platforms
npm run build:mac
npm run build:win
npm run build:linux
```

### Docker
```bash
# Build and run
docker-compose up -d

# View logs
docker-compose logs -f git-scheduler

# Run once mode
docker-compose run git-scheduler python main.py --once

# Check status
docker-compose run git-scheduler python main.py --status

# Stop
docker-compose down

# Rebuild after changes
docker-compose up -d --build
```

## Architecture

### Core Python Components

1. **scheduler.py** - Main orchestrator (`src/scheduler.py`)
   - `GitScheduler` class manages timing with randomized intervals
   - Coordinates git operations, message generation, and database tracking
   - Handles continuous running, pause/resume, and logging
   - Two entry points: `run()` for continuous, `run_once()` for single commit
   - Stores `next_commit_time` for API access
   - Supports pause/resume via `paused` attribute

2. **git_operations.py** - Git wrapper (`src/git_operations.py`)
   - Wraps GitPython for all git operations
   - Methods: `stage_all()`, `commit()`, `push()`, `get_diff()`, `get_changed_files()`
   - Handles errors gracefully with retries on push
   - Uses configured author name/email for commits

3. **ollama_client.py** - Ollama API client (`src/ollama_client.py`)
   - Communicates with local Ollama instance (default: http://oracle.local:11434)
   - Methods: `generate()`, `health_check()`, `get_models()`
   - Configurable timeout and token limits
   - Graceful degradation when unavailable

4. **message_generator.py** - Commit message generation (`src/message_generator.py`)
   - Primary: Uses Ollama with diff context and optional theme
   - Fallback: Template-based messages with timestamp
   - Validates and sanitizes all messages
   - Enforces conventional commit format (feat, fix, chore, etc.)
   - Theme support for domain-specific messages (kubernetes, docker, etc.)

5. **config.py** - Configuration management (`src/config.py`)
   - Loads YAML configuration from `config/config.yaml`
   - Supports environment variable overrides via `.env`
   - Provides typed accessors: `get_repositories()`, `get_schedule_config()`, etc.
   - Environment variables take precedence over YAML

6. **database.py** - SQLite storage (`src/database.py`)
   - Tracks commit history in `database/scheduler.db`
   - Tables: `commits` (individual commits), `stats` (daily aggregates)
   - Methods: `add_commit()`, `get_recent_commits()`, `get_stats()`
   - Used by web UI for dashboards and history

7. **api.py** - FastAPI REST API (`src/api.py`)
   - HTTP endpoints for web UI integration
   - `/api/status` - Current scheduler state and next commit time
   - `/api/history` - Commit history with pagination
   - `/api/stats` - Statistics and charts
   - `/api/control` - Pause/resume/trigger scheduler
   - `/api/logs` - Recent log entries
   - Requires `set_scheduler()` to inject scheduler instance

### Application Entry Points

1. **main.py** - CLI scheduler
   - Direct execution for headless/server operation
   - Three modes: continuous (`run()`), once (`--once`), status (`--status`)
   - No web interface, pure command-line

2. **main_web.py** - Web UI scheduler
   - Runs FastAPI server (default port 5000) + scheduler in background thread
   - Scheduler thread runs `scheduler.run()` as daemon
   - API server runs in main thread via `uvicorn.run()`
   - Use `set_scheduler()` to inject scheduler into API module
   - `--no-scheduler` flag runs API-only mode (for debugging UI)

3. **electron-app/** - Desktop wrapper
   - Electron app that embeds the web UI
   - Spawns Python backend (`main_web.py`) as subprocess
   - Built with electron-builder for macOS/Windows/Linux

### Data Flow (Main Commit Cycle)

**CLI Mode (`main.py`):**
1. Scheduler calculates next interval (base ± jitter)
2. Waits for interval to elapse
3. Calls `_perform_commit()` which:
   - Checks for git changes via `GitOperations.has_changes()`
   - Stages all changes with `git_ops.stage_all()`
   - Gets changed files and diff
   - `MessageGenerator.generate()` queries Ollama with diff context and theme
   - If Ollama fails, falls back to template messages
   - `GitOperations.commit()` creates commit with generated message
   - Optionally pushes to remote (if `push.enabled: true`)
   - Tracks commit in database via `db.add_commit()`
4. Logs all operations
5. Repeats from step 1

**Web Mode (`main_web.py`):**
- Same as CLI mode, but scheduler runs in background thread
- FastAPI server provides real-time status, history, and control
- Web UI polls `/api/status` for next commit countdown
- Pause/resume/trigger actions via `/api/control` endpoint
- Database enables statistics and commit history views

### Configuration System

- **Primary config**: `config/config.yaml` - All settings
- **Environment overrides**: `.env` file - Overrides YAML values
- **Docker environment**: `docker-compose.yml` - Container-specific overrides

Configuration priority: Environment variables > YAML file

Key config sections:
- `repositories`: Git repos to manage
- `schedule`: Timing configuration
- `ollama`: AI model settings
- `commit`: Message generation settings
- `push`: Remote push settings
- `logging`: Log configuration

### Key Design Decisions

1. **Ollama Integration**: Uses local Ollama API (http://oracle.local:11434) for privacy and no API costs
2. **Fallback Strategy**: Always has template fallback if Ollama unavailable
3. **Conventional Commits**: Enforces conventional commit format (type: description)
4. **Random Jitter**: Adds ±50s randomness to avoid predictable patterns
5. **No Auto-Push by Default**: Push is disabled by default for safety
6. **Comprehensive Logging**: All operations logged to file and console

## Project Structure

```
git-deploy-schedule/
├── src/                    # Python backend
│   ├── scheduler.py        # Main scheduler logic
│   ├── git_operations.py   # Git wrapper
│   ├── ollama_client.py    # Ollama API client
│   ├── message_generator.py # Commit message generation
│   ├── config.py           # Configuration management
│   ├── database.py         # SQLite database
│   └── api.py              # FastAPI REST API
├── tests/                  # Python tests
├── config/
│   └── config.yaml         # Main configuration file
├── database/
│   └── scheduler.db        # SQLite database (auto-created)
├── logs/
│   └── scheduler.log       # Application logs (auto-created)
├── web/
│   └── frontend/           # Web UI (HTML/CSS/JS)
│       ├── index.html
│       ├── css/styles.css
│       └── js/app.js
├── electron-app/           # Electron desktop wrapper
│   ├── src/
│   │   ├── main.js         # Electron main process
│   │   └── preload.js      # Preload script
│   └── package.json
├── main.py                 # CLI entry point
├── main_web.py             # Web UI entry point
├── requirements.txt        # Python dependencies
├── Dockerfile              # Docker image
└── docker-compose.yml      # Docker Compose config
```

## Development Guidelines

### Working with the Web UI

- Web UI files are in `web/frontend/`
- API endpoints must be added to both `src/api.py` (backend) and `web/frontend/js/app.js` (frontend)
- Web UI connects to API at `http://localhost:5000/api/*`
- Test API independently: `python main_web.py --no-scheduler`
- Static files served by FastAPI via `app.mount("/static", ...)`

### Working with the Database

- Database auto-initializes on first run at `database/scheduler.db`
- Schema changes require migration strategy (currently manual)
- Always use `Database` class methods, never raw SQL in other modules
- Commits tracked immediately after git commit succeeds
- Stats aggregated daily in `stats` table

### Adding New Features

When adding features:
- Update tests in `tests/` directory
- Add configuration options to `config/config.yaml` and `.env.example`
- Update `Config` class with accessor methods for new config sections
- If adding API endpoints, update both `api.py` and web UI JavaScript
- Maintain fallback behavior for robustness (especially for Ollama)

### Testing Strategy

- Unit tests for each module in isolation
- Mock external dependencies (Ollama via `requests`, git via `GitPython`)
- Test both success and failure paths
- Test configuration loading and environment variable overrides
- Use pytest fixtures for common test objects
- Database tests should use temporary database files

### Error Handling Philosophy

All modules follow these patterns:
- Log errors with appropriate level (ERROR, WARNING)
- Return `None` or `False` on failure (never raise in main flow)
- Provide fallback behavior where possible (e.g., template messages when Ollama fails)
- Retry network operations with configurable attempts (e.g., git push)
- Continue operation when non-critical components fail (e.g., database)

### Logging Conventions

- `INFO`: Normal operations, commit messages, intervals, component initialization
- `WARNING`: Fallback usage, retries, non-critical component failures
- `ERROR`: Failed operations, configuration issues, critical errors
- `DEBUG`: Detailed operation info, API payloads, diff contents

## Common Development Patterns

### Adding a New Configuration Option

1. Add to `config/config.yaml` with default value
2. Add to `.env.example` for environment override
3. Add override logic to `Config._apply_env_overrides()`
4. Add accessor method to Config class if needed
5. Add test in `tests/test_config.py`

### Adding a New Commit Message Type

1. Add type to `MessageGenerator.ACTIVITY_TYPES`
2. Update Ollama system prompt in config if needed
3. Update validation in `MessageGenerator._validate_message()`
4. Add test cases in `tests/test_message_generator.py`

### Integrating a New LLM Provider

1. Create new client class (e.g., `openai_client.py`) in `src/`
2. Implement same interface as `OllamaClient`:
   - `generate(prompt, system_prompt)` - Returns message string
   - `health_check()` - Returns boolean
   - `get_models()` - Returns list of available models
3. Add configuration section to `config/config.yaml`
4. Update `MessageGenerator` to accept multiple client types
5. Update `Config._apply_env_overrides()` for new environment variables
6. Add tests for new client in `tests/`

### Adding API Endpoints

1. Add endpoint handler in `src/api.py`:
   ```python
   @app.get("/api/my-endpoint")
   async def my_endpoint():
       if not scheduler_instance:
           raise HTTPException(status_code=503)
       # Implementation
   ```

2. Update web UI JavaScript in `web/frontend/js/app.js`:
   ```javascript
   async function fetchMyData() {
       const response = await fetch('/api/my-endpoint');
       const data = await response.json();
       // Update UI
   }
   ```

3. Test endpoint independently:
   ```bash
   python main_web.py --no-scheduler
   curl http://localhost:5000/api/my-endpoint
   ```

## Troubleshooting

### Tests Failing
- Ensure you're in project root: `cd /Users/justynroberts/work/git-deploy-schedule`
- Check Python path includes src: tests use relative imports
- Verify `config/config.yaml` exists and is valid YAML
- Mock external calls (Ollama via `unittest.mock`, git via `GitPython` mocks)
- Check test database is isolated (use temporary files)

### Ollama Not Connecting
- Check Ollama is running: `curl http://oracle.local:11434/api/tags`
- Verify URL in config matches Ollama host
- Check network connectivity to oracle.local (or change to `localhost`)
- Review logs for connection errors in `logs/scheduler.log`
- Scheduler will fall back to template messages if Ollama unavailable

### Web UI Not Loading
- Check FastAPI is running: `ps aux | grep main_web.py`
- Verify port 5000 is not in use: `lsof -i :5000`
- Check browser console for JavaScript errors
- Verify static files exist in `web/frontend/`
- Check API responses: `curl http://localhost:5000/api/status`

### Git Operations Failing
- Ensure repository path is valid git repo: `git -C /path/to/repo status`
- Check git authentication (SSH keys, credentials)
- Verify user has write permissions
- For push failures, check remote URL and credentials
- Review git configuration: `git config --list`

### Database Issues
- Check database file exists: `ls -la database/scheduler.db`
- Verify SQLite is accessible: `sqlite3 database/scheduler.db ".tables"`
- Look for schema errors in logs
- Database will auto-create tables on initialization
- Use `database.py::Database` class methods only

### Electron App Issues
- Check Python is in PATH for spawned subprocess
- Verify `main_web.py` runs independently
- Check Electron DevTools console for errors
- Ensure electron-app dependencies installed: `cd electron-app && npm install`
- Build issues: Clear `electron-app/dist/` and rebuild

## Production Deployment

### Docker Deployment (Recommended)
1. Configure environment variables in `.env`
2. Enable push only after testing: `push.enabled: true` in config
3. Mount SSH keys securely in `docker-compose.yml`:
   ```yaml
   volumes:
     - ~/.ssh:/root/.ssh:ro
   ```
4. Set appropriate log level: `logging.level: INFO`
5. Use restart policy: `restart: unless-stopped`
6. Monitor logs: `docker-compose logs -f git-scheduler`
7. Test with `--once` mode before continuous run

### Bare Metal Deployment
1. Install Python 3.11+ and dependencies: `pip install -r requirements.txt`
2. Configure `config/config.yaml` with production settings
3. Test with: `python main.py --once`
4. Run as systemd service or screen/tmux session
5. Monitor `logs/scheduler.log` for issues
6. Optionally run web UI: `python main_web.py`

### Security Considerations
- Never commit `.env` or `config/config.yaml` with secrets
- Use SSH keys for git authentication, not passwords
- Limit API access (currently allows all origins via CORS)
- Run Docker container with minimal permissions
- Review Ollama-generated commit messages before enabling push
- Use separate git author for automated commits
