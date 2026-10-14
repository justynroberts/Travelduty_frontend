# Build context: repository root.
#   docker build -f services/pricing-service/Dockerfile -t travelduty/pricing-service .
FROM python:3.12-slim AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /src
COPY libs/py-common libs/py-common
COPY services/pricing-service services/pricing-service
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install ./libs/py-common ./services/pricing-service

FROM python:3.12-slim
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8084 \
    REFERENCE_DATA_DIR=/app/data
WORKDIR /app
COPY --from=build /opt/venv /opt/venv
RUN useradd --system --uid 10001 --no-create-home app
USER 10001
EXPOSE 8084
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/health', timeout=2)"
CMD ["pricing-service"]
