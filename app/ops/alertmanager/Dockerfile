# Build context: repository root
#   docker build -f ops/alertmanager/Dockerfile -t travelduty/alertmanager .
# The PagerDuty routing key comes from PAGERDUTY_ROUTING_KEY at runtime, never from the image.
FROM prom/alertmanager:v0.27.0
COPY ops/alertmanager/alertmanager.yml /etc/alertmanager/alertmanager.yml
COPY ops/alertmanager/templates /etc/alertmanager/templates
COPY ops/alertmanager/entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
