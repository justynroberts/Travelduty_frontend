"""Commit message generator using Ollama with template fallback."""

import logging
import random
from datetime import datetime
from typing import Optional
from .ollama_client import OllamaClient


logger = logging.getLogger(__name__)


class MessageGenerator:
    """Generate commit messages using Ollama or templates."""

    ACTIVITY_TYPES = [
        "chore", "fix", "feat", "refactor", "docs",
        "style", "test", "perf", "build"
    ]

    def __init__(self, ollama_client: Optional[OllamaClient], config: dict):
        """Initialize message generator.

        Args:
            ollama_client: Ollama client instance (None to disable)
            config: Commit configuration dictionary
        """
        self.ollama_client = ollama_client
        self.config = config
        self.use_ollama = config.get('use_ollama', True) and ollama_client is not None
        self.message_template = config.get('message_template', 'chore: automated update - {timestamp}')
        self.include_diff = config.get('include_diff_context', True)
        self.commit_counter = 0

    def generate(self, changed_files: list, diff: str, system_prompt: str = "", theme: str = "") -> str:
        """Generate a commit message.

        Args:
            changed_files: List of changed file paths
            diff: Git diff output
            system_prompt: System prompt for Ollama
            theme: Optional theme/context for commit messages (e.g., "kubernetes", "docker")

        Returns:
            Generated commit message
        """
        self.commit_counter += 1

        # Try Ollama first if enabled
        if self.use_ollama and self.ollama_client:
            message = self._generate_with_ollama(changed_files, diff, system_prompt, theme)
            if message:
                return message
            logger.warning("Ollama generation failed, falling back to template")

        # Fallback to template
        return self._generate_from_template()

    def _generate_with_ollama(self, changed_files: list, diff: str, system_prompt: str, theme: str = "") -> Optional[str]:
        """Generate commit message using Ollama.

        Args:
            changed_files: List of changed file paths
            diff: Git diff output
            system_prompt: System prompt
            theme: Optional theme/context for messages

        Returns:
            Generated message or None if failed
        """
        try:
            # Build user prompt with context
            prompt_parts = []

            # Add theme context if provided
            if theme:
                prompt_parts.append(f"Context: This is a {theme} project.")
                prompt_parts.append("")

            prompt_parts.append("Files changed:")

            # Add file list
            for file in changed_files[:10]:  # Limit to first 10 files
                prompt_parts.append(f"- {file}")

            if len(changed_files) > 10:
                prompt_parts.append(f"... and {len(changed_files) - 10} more files")

            # Add diff summary if enabled and available
            if self.include_diff and diff:
                prompt_parts.append("\nDiff summary:")
                diff_lines = diff.split('\n')[:50]  # Limit diff size
                prompt_parts.extend(diff_lines)

            prompt_parts.append("\nGenerate a concise conventional commit message:")

            if theme:
                prompt_parts.append(f"(Keep the {theme} context in mind when describing the changes)")

            prompt = '\n'.join(prompt_parts)

            # Call Ollama
            response = self.ollama_client.generate(prompt, system_prompt)

            if response:
                # Pass full response to sanitizer - it will find the actual commit message
                message = self._sanitize_message(response)

                if self._validate_message(message):
                    return message
                else:
                    logger.warning(f"Invalid message format: {message}")
                    return None

            return None

        except Exception as e:
            logger.error(f"Error generating message with Ollama: {e}")
            return None

    def _generate_from_template(self) -> str:
        """Generate commit message from template.

        Returns:
            Generated message
        """
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        activity = random.choice(self.ACTIVITY_TYPES)
        count = self.commit_counter

        # Replace template variables
        message = self.message_template.format(
            timestamp=timestamp,
            activity=activity,
            count=count
        )

        logger.info(f"Generated template message: {message}")
        return message

    def _sanitize_message(self, message: str) -> str:
        """Clean and sanitize commit message.

        Args:
            message: Raw message from Ollama

        Returns:
            Sanitized message
        """
        # Remove quotes if present
        message = message.strip('"\'')

        # Remove any leading/trailing whitespace
        message = message.strip()

        # Split into lines and find the actual commit message
        lines = message.split('\n')

        # Preamble patterns to skip (common LLM response patterns)
        preamble_patterns = [
            'here is', 'here\'s', 'sure', 'certainly', 'of course',
            'i\'ll', 'i will', 'let me', 'the commit message',
            'a commit message', 'commit message:', 'based on',
            'looking at', 'analyzing', 'after reviewing'
        ]

        # Find the first line that looks like a commit message
        commit_message = None
        for line in lines:
            line = line.strip().strip('"\'`')
            if not line:
                continue

            # Skip lines that look like preambles
            line_lower = line.lower()
            is_preamble = any(line_lower.startswith(p) for p in preamble_patterns)

            if is_preamble:
                continue

            # Check if this line looks like a conventional commit
            if ':' in line:
                parts = line.split(':', 1)
                commit_type = parts[0].strip().lower().replace('(', ' ').split()[0]
                valid_types = ['feat', 'fix', 'docs', 'style', 'refactor',
                              'perf', 'test', 'build', 'ci', 'chore', 'revert']
                if commit_type in valid_types:
                    commit_message = line
                    break

            # If we haven't found a conventional commit yet, save first non-preamble line
            if commit_message is None and len(line) >= 10:
                commit_message = line

        # Use the found message or fall back to first line
        message = commit_message or lines[0].strip()

        # Remove markdown backticks
        message = message.strip('`').strip()

        # Limit length to 72 characters (conventional commit guideline)
        if len(message) > 72:
            message = message[:69] + "..."

        return message

    def _validate_message(self, message: str) -> bool:
        """Validate commit message format.

        Args:
            message: Commit message to validate

        Returns:
            True if valid, False otherwise
        """
        if not message or len(message) < 5:
            return False

        # Check for conventional commit format (type: description)
        if ':' in message:
            parts = message.split(':', 1)
            commit_type = parts[0].strip().lower()

            # Check if type is valid
            valid_types = [
                'feat', 'fix', 'docs', 'style', 'refactor',
                'perf', 'test', 'build', 'ci', 'chore', 'revert'
            ]

            if commit_type in valid_types and len(parts[1].strip()) > 0:
                return True

        # Accept if it looks like a reasonable commit message
        return len(message) >= 10

    def set_ollama_enabled(self, enabled: bool):
        """Enable or disable Ollama usage.

        Args:
            enabled: Whether to use Ollama
        """
        self.use_ollama = enabled and self.ollama_client is not None
        logger.info(f"Ollama usage set to: {self.use_ollama}")
