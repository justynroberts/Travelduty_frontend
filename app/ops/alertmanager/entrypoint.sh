#!/bin/sh
# Alertmanager can't read env vars in its config, so write the routing key to the file
# alertmanager.yml points at (routing_key_file), then start as usual.
set -eu

if [ -z "${PAGERDUTY_ROUTING_KEY:-}" ]; then
  echo "alertmanager: PAGERDUTY_ROUTING_KEY is not set; refusing to start without a pager" >&2
  exit 1
fi
umask 077
printf '%s' "$PAGERDUTY_ROUTING_KEY" > /tmp/pagerduty_routing_key

exec /bin/alertmanager \
  --config.file=/etc/alertmanager/alertmanager.yml \
  --storage.path=/alertmanager \
  --cluster.listen-address= \
  "$@"
