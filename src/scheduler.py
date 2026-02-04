"""Main scheduler for automated git commits."""

import logging
import random
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

from .config import Config
from .git_operations import GitOperations
from .ollama_client import OllamaClient
from .message_generator import MessageGenerator
from .database import Database


logger = logging.getLogger(__name__)


class GitScheduler:
    """Scheduler for automated git commits."""

    def __init__(self, config_path: str = "config/config.yaml"):
        """Initialize the scheduler.

        Args:
            config_path: Path to configuration file
        """
        # Load configuration
        self.config = Config(config_path)
        self._setup_logging()

        logger.info("=" * 60)
        logger.info("Git Deploy Scheduler Starting")
        logger.info("=" * 60)

        # Initialize components
        self.git_ops = None
        self.ollama_client = None
        self.message_generator = None
        self.db = None
        self.paused = False
        self.next_commit_time = None

        self._initialize_components()

    def _setup_logging(self):
        """Setup logging configuration."""
        log_config = self.config.get_logging_config()
        log_level = getattr(logging, log_config.get('level', 'INFO'))
        log_file = log_config.get('file', 'logs/scheduler.log')

        # Create logs directory if it doesn't exist
        Path(log_file).parent.mkdir(parents=True, exist_ok=True)

        # Configure logging
        logging.basicConfig(
            level=log_level,
            format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            handlers=[
                logging.FileHandler(log_file),
                logging.StreamHandler()
            ]
        )

    def _initialize_components(self):
        """Initialize scheduler components."""
        # Get first enabled repository
        repos = self.config.get_repositories()
        enabled_repos = [r for r in repos if r.get('enabled', True)]

        if not enabled_repos:
            raise ValueError("No enabled repositories found in configuration")

        repo_config = enabled_repos[0]
        logger.info(f"Using repository: {repo_config['path']}")

        # Initialize git operations
        try:
            self.git_ops = GitOperations(
                repo_path=repo_config['path'],
                branch=repo_config.get('branch', 'main')
            )
            logger.info(f"Git repository initialized on branch: {self.git_ops.get_current_branch()}")
        except Exception as e:
            logger.error(f"Failed to initialize git repository: {e}")
            raise

        # Initialize Ollama client
        ollama_config = self.config.get_ollama_config()
        if ollama_config.get('enabled', True):
            try:
                self.ollama_client = OllamaClient(
                    url=ollama_config['url'],
                    model=ollama_config['model'],
                    timeout=ollama_config.get('timeout', 30),
                    max_tokens=ollama_config.get('max_tokens', 100)
                )

                # Health check
                if self.ollama_client.health_check():
                    logger.info(f"Ollama client initialized: {ollama_config['url']} (model: {ollama_config['model']})")
                else:
                    logger.warning("Ollama health check failed, will use template fallback")
                    self.ollama_client = None
            except Exception as e:
                logger.warning(f"Failed to initialize Ollama client: {e}")
                self.ollama_client = None
        else:
            logger.info("Ollama disabled in configuration")

        # Initialize message generator
        commit_config = self.config.get_commit_config()
        self.message_generator = MessageGenerator(
            ollama_client=self.ollama_client,
            config=commit_config
        )
        logger.info("Message generator initialized")

        # Initialize database
        try:
            self.db = Database()
            logger.info("Database initialized")
        except Exception as e:
            logger.warning(f"Failed to initialize database: {e}")

    def _calculate_next_interval(self) -> float:
        """Calculate next interval with jitter.

        Returns:
            Interval in seconds
        """
        schedule_config = self.config.get_schedule_config()
        base_interval = schedule_config.get('base_interval', 600)
        jitter_range = schedule_config.get('jitter_range', 50)

        # Calculate interval with random jitter
        jitter = random.uniform(-jitter_range, jitter_range)
        interval = base_interval + jitter

        logger.info(f"Next commit in {interval:.1f} seconds ({interval/60:.2f} minutes)")
        return interval

    def _perform_commit(self) -> bool:
        """Perform a git commit.

        Returns:
            True if commit was successful, False otherwise
        """
        try:
            # Check if there are changes
            if not self.git_ops.has_changes():
                logger.info("No changes to commit")
                return False

            # Stage all changes
            if not self.git_ops.stage_all():
                logger.error("Failed to stage changes")
                return False

            # Get changed files and diff
            changed_files = self.git_ops.get_changed_files()
            diff = self.git_ops.get_diff(staged=True)

            logger.info(f"Changes detected in {len(changed_files)} file(s)")
            for file in changed_files[:5]:  # Log first 5 files
                logger.info(f"  - {file}")

            # Generate commit message
            ollama_config = self.config.get_ollama_config()
            system_prompt = ollama_config.get('system_prompt', '')
            theme = ollama_config.get('theme', '')

            message = self.message_generator.generate(
                changed_files=changed_files,
                diff=diff,
                system_prompt=system_prompt,
                theme=theme
            )

            logger.info(f"Generated commit message: {message}")

            # Create commit
            commit_config = self.config.get_commit_config()
            success = self.git_ops.commit(
                message=message,
                author_name=commit_config.get('author_name'),
                author_email=commit_config.get('author_email')
            )

            if not success:
                logger.error("Failed to create commit")
                # Track failed commit
                if self.db:
                    self.db.add_commit(
                        commit_hash="",
                        message=message,
                        files_changed=len(changed_files),
                        success=False,
                        used_ollama=self.message_generator.use_ollama,
                        theme=theme,
                        error_message="Failed to create commit"
                    )
                return False

            # Get the commit hash
            commit_hash = self.git_ops.get_last_commit_hash() or ""

            # Push if enabled
            push_success = False
            push_config = self.config.get_push_config()
            if push_config.get('enabled', False):
                logger.info("Pushing to remote...")
                push_success = self.git_ops.push(
                    retry_attempts=push_config.get('retry_attempts', 3),
                    retry_delay=push_config.get('retry_delay', 30)
                )

                if push_success:
                    logger.info("Successfully pushed to remote")
                else:
                    logger.warning("Failed to push to remote (commit saved locally)")

            # Track successful commit in database
            if self.db:
                self.db.add_commit(
                    commit_hash=commit_hash,
                    message=message,
                    files_changed=len(changed_files),
                    success=True,
                    used_ollama=self.message_generator.use_ollama and self.ollama_client is not None,
                    theme=theme,
                    push_success=push_success
                )

            return True

        except Exception as e:
            logger.error(f"Error during commit: {e}")
            # Track error
            if self.db:
                self.db.add_commit(
                    commit_hash="",
                    message="Error during commit",
                    files_changed=0,
                    success=False,
                    used_ollama=False,
                    error_message=str(e)
                )
            return False

    def run_once(self) -> bool:
        """Run a single commit cycle.

        Returns:
            True if successful, False otherwise
        """
        logger.info("Starting commit cycle...")
        return self._perform_commit()

    def run(self):
        """Run the scheduler continuously."""
        logger.info("Scheduler running in continuous mode")
        logger.info("Press Ctrl+C to stop")

        try:
            while True:
                # Check if paused
                if self.paused:
                    logger.info("Scheduler paused, waiting...")
                    time.sleep(5)
                    continue

                # Calculate next interval
                interval = self._calculate_next_interval()

                # Store next commit time for API
                self.next_commit_time = datetime.now()
                self.next_commit_time = self.next_commit_time.replace(microsecond=0)
                from datetime import timedelta
                self.next_commit_time += timedelta(seconds=interval)

                # Wait for the interval (check pause every 5 seconds)
                logger.info(f"Waiting until {datetime.now().strftime('%H:%M:%S')} + {interval:.0f}s")
                elapsed = 0
                while elapsed < interval:
                    if self.paused:
                        break
                    sleep_time = min(5, interval - elapsed)
                    time.sleep(sleep_time)
                    elapsed += sleep_time

                # Perform commit if not paused
                if not self.paused:
                    self._perform_commit()

        except KeyboardInterrupt:
            logger.info("Scheduler stopped by user")
        except Exception as e:
            logger.error(f"Scheduler error: {e}")
            raise

    def status(self):
        """Print scheduler status."""
        logger.info("=" * 60)
        logger.info("Scheduler Status")
        logger.info("=" * 60)

        # Repository info
        logger.info(f"Repository: {self.git_ops.repo_path}")
        logger.info(f"Branch: {self.git_ops.get_current_branch()}")
        logger.info(f"Has changes: {self.git_ops.has_changes()}")
        logger.info(f"Commit count: {self.git_ops.get_commit_count()}")

        # Last commit
        last_message = self.git_ops.get_last_commit_message()
        if last_message:
            logger.info(f"Last commit: {last_message[:50]}...")

        # Ollama status
        if self.ollama_client:
            ollama_available = self.ollama_client.health_check()
            logger.info(f"Ollama available: {ollama_available}")
            if ollama_available:
                models = self.ollama_client.get_models()
                logger.info(f"Ollama models: {models}")
        else:
            logger.info("Ollama: Disabled")

        # Configuration
        schedule_config = self.config.get_schedule_config()
        logger.info(f"Base interval: {schedule_config.get('base_interval')}s")
        logger.info(f"Jitter range: ±{schedule_config.get('jitter_range')}s")

        push_config = self.config.get_push_config()
        logger.info(f"Push enabled: {push_config.get('enabled', False)}")

        logger.info("=" * 60)
