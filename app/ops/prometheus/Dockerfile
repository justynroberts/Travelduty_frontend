# Build context: repository root
#   docker build -f ops/prometheus/Dockerfile -t travelduty/prometheus .
FROM prom/prometheus:v2.55.1
COPY ops/prometheus/prometheus.yml ops/prometheus/alerts.yml /etc/prometheus/
