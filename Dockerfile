FROM python:3.11-slim

# Install git and curl (for healthcheck)
RUN apt-get update && \
    apt-get install -y git curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements first for better caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY src/ ./src/
COPY web/ ./web/
COPY config/ ./config/
COPY main.py main_web.py ./

# Create directories
RUN mkdir -p logs database

# Default command - run web UI on port 5001
CMD ["python", "main_web.py", "--port", "5001"]
