# Git Deploy Schedule

Automated git commit scheduler with AI-powered commit messages using Ollama.

## Overview

This tool automatically commits and pushes changes to a git repository at randomized intervals (default: 10 minutes ± 50 seconds). It uses Ollama to generate contextual, realistic commit messages based on actual file changes, falling back to template-based messages when Ollama is unavailable.

## Features

- 🤖 **AI-Powered Commit Messages**: Uses Ollama to generate meaningful commit messages based on git diffs
- ⏱️ **Randomized Scheduling**: Commits at configurable intervals with random jitter
- 🔄 **Automatic Fallback**: Falls back to template messages if Ollama is unavailable
- 🐳 **Docker Ready**: Fully containerized with docker-compose support
- 📝 **Conventional Commits**: Follows conventional commit format (feat, fix, chore, etc.)
- 🔧 **Highly Configurable**: YAML configuration with environment variable overrides
- 📊 **Comprehensive Logging**: Detailed logs for monitoring and debugging

## Requirements

- Python 3.11+
- Git repository
- Ollama (optional, for AI-generated messages)
- Docker & Docker Compose (for containerized deployment)

## Installation

### Local Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd git-deploy-schedule
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

3. Copy and configure the environment file:
```bash
cp .env.example .env
# Edit .env with your settings
```

4. Configure the scheduler:
```bash
# Edit config/config.yaml with your repository path and preferences
```

### Docker Installation

1. Configure your repository path in `.env`:
```bash
echo "REPO_PATH=/path/to/your/repo" > .env
```

2. Build and run with docker-compose:
```bash
docker-compose up -d
```

## Configuration

### YAML Configuration (`config/config.yaml`)

```yaml
repositories:
  - path: /path/to/repo
    branch: main
    enabled: true

schedule:
  base_interval: 600  # 10 minutes
  jitter_range: 50    # ±50 seconds

ollama:
  enabled: true
  url: http://oracle.local:11434
  model: llama3.2:latest
  timeout: 30
  max_tokens: 100
  theme: "kubernetes"  # Optional: kubernetes, docker, terraform, aws, etc.

commit:
  use_ollama: true
  message_template: "chore: automated update - {timestamp}"
  author_name: "Auto Deploy Bot"
  author_email: "bot@example.com"

push:
  enabled: false  # Set to true to push to remote
  retry_attempts: 3
  retry_delay: 30
```

### Environment Variables

Override configuration via environment variables:

- `REPO_PATH`: Repository path
- `OLLAMA_URL`: Ollama API URL
- `OLLAMA_MODEL`: Ollama model name
- `OLLAMA_THEME`: Commit message theme (e.g., "kubernetes", "docker")
- `BASE_INTERVAL`: Base interval in seconds
- `JITTER_RANGE`: Jitter range in seconds
- `GIT_AUTHOR_NAME`: Git author name
- `GIT_AUTHOR_EMAIL`: Git author email

## Usage

### Run Continuously

```bash
python main.py
```

### Run Once (for testing)

```bash
python main.py --once
```

### Check Status

```bash
python main.py --status
```

### Custom Configuration

```bash
python main.py --config /path/to/config.yaml
```

### Docker Usage

```bash
# Run in background
docker-compose up -d

# View logs
docker-compose logs -f

# Run once
docker-compose run git-scheduler python main.py --once

# Check status
docker-compose run git-scheduler python main.py --status

# Stop
docker-compose down
```

## Ollama Setup

1. Install Ollama: https://ollama.ai

2. Pull a model:
```bash
ollama pull llama3.2
# or
ollama pull codellama
```

3. Ensure Ollama is running:
```bash
ollama serve
```

4. Configure the Ollama URL in `config/config.yaml` or via `OLLAMA_URL` environment variable.

## Commit Message Examples

### Ollama-Generated (AI)

**Without Theme:**
- `feat: implement JWT token validation and refresh mechanism`
- `fix: resolve race condition in concurrent file uploads`
- `refactor: simplify error handling in authentication module`

**With Kubernetes Theme:**
- `feat: add kubernetes theme support and configuration`
- `fix: resolve pod scheduling issue in production cluster`
- `chore: update helm chart values for autoscaling`
- `docs: add deployment guide for kubernetes ingress`

### Template-Based (Fallback)
- `chore: automated update - 2025-10-23 14:23:45`
- `feat: automated changes - 2025-10-23 14:33:52`
- `fix: automated changes - 2025-10-23 14:44:01`

## Testing

Run the test suite:

```bash
# Install test dependencies
pip install pytest pytest-cov

# Run all tests
pytest

# Run with coverage
pytest --cov=src --cov-report=html

# Run specific test file
pytest tests/test_config.py
```

## Project Structure

```
git-deploy-schedule/
├── src/
│   ├── scheduler.py          # Main scheduling logic
│   ├── git_operations.py     # Git command wrapper
│   ├── ollama_client.py      # Ollama API integration
│   ├── message_generator.py  # Commit message generation
│   └── config.py             # Configuration loader
├── tests/
│   ├── test_config.py
│   ├── test_ollama_client.py
│   └── test_message_generator.py
├── config/
│   └── config.yaml           # Configuration file
├── logs/
│   └── scheduler.log         # Application logs
├── main.py                   # Entry point
├── requirements.txt          # Python dependencies
├── Dockerfile                # Docker image definition
└── docker-compose.yml        # Docker Compose configuration
```

## Development Commands

```bash
# Install dependencies
pip install -r requirements.txt

# Run tests
pytest

# Run with custom config
python main.py --config config/config.yaml

# Run once for testing
python main.py --once

# Check scheduler status
python main.py --status
```

## Logging

Logs are written to both console and file (`logs/scheduler.log` by default).

Log levels: DEBUG, INFO, WARNING, ERROR, CRITICAL

Configure via `config/config.yaml`:
```yaml
logging:
  level: INFO
  file: logs/scheduler.log
```

## Git Authentication

To push commits to a remote repository, you need to configure git authentication.

### Quick Setup (PAT Token)

1. **Create Personal Access Token** on GitHub/GitLab
2. **Configure git credential helper:**
   ```bash
   git config --global credential.helper osxkeychain  # macOS
   git config --global credential.helper store        # Linux
   ```
3. **Set remote URL with username:**
   ```bash
   git remote add origin https://YOUR_USERNAME@github.com/user/repo.git
   ```
4. **Enable push in config:**
   ```yaml
   push:
     enabled: true
   ```
5. **Test:** When you push, enter your PAT token when prompted

See [GIT_AUTH.md](GIT_AUTH.md) for detailed authentication options including SSH keys, Docker setup, and security best practices.

## Troubleshooting

### Ollama Connection Issues
- Ensure Ollama is running: `curl http://oracle.local:11434/api/tags`
- Check firewall settings
- Verify URL in configuration
- Check logs for connection errors

### Git Authentication Issues
- **PAT Token**: Use git credential helper to store token securely
- **For SSH**: Ensure SSH keys are configured and added to ssh-agent
- **For HTTPS**: Configure git credentials with `git config credential.helper`
- **Docker**: Mount SSH keys or git-credentials file as volumes
- See [GIT_AUTH.md](GIT_AUTH.md) for complete authentication guide

### No Changes to Commit
- The scheduler only commits when there are file changes
- Use `--once` mode to test without waiting
- Check git status in the repository

### Permission Errors
- Ensure the repository path is accessible
- Check file permissions
- Docker: Verify volume mounts

## Security Considerations

- Never commit sensitive files (.env, credentials, keys)
- Use `.gitignore` to exclude sensitive data
- Configure git authentication securely (SSH keys, credential helpers)
- Review Ollama-generated messages before enabling push
- Use separate git user for automated commits

## License

MIT License

## Contributing

Contributions welcome! Please open an issue or pull request.

## Support

For issues, questions, or feature requests, please open a GitHub issue.
# Updated: Wed Feb  4 21:23:21 UTC 2026
