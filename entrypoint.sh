#!/bin/bash
set -e

# Configure git credentials if GITHUB_TOKEN is set
if [ -n "$GITHUB_TOKEN" ]; then
    echo "Configuring git credentials..."
    git config --global credential.helper store
    echo "https://x-access-token:${GITHUB_TOKEN}@github.com" > ~/.git-credentials
    chmod 600 ~/.git-credentials
fi

# Configure git user (required for commits)
git config --global user.email "scheduler@git-deploy.local"
git config --global user.name "Git Deploy Scheduler"

# Mark mounted repo as safe (fixes dubious ownership error)
git config --global --add safe.directory /repo

exec "$@"
