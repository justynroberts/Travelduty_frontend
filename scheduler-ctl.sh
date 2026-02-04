#!/bin/bash
# Git Deploy Scheduler Control Script

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.scheduler.pid"
LOG_FILE="$SCRIPT_DIR/logs/scheduler.log"
PYTHON="$SCRIPT_DIR/venv/bin/python"

start() {
    if [ -f "$PID_FILE" ] && kill -0 $(cat "$PID_FILE") 2>/dev/null; then
        echo "Scheduler already running (PID: $(cat $PID_FILE))"
        return 1
    fi

    cd "$SCRIPT_DIR"
    nohup "$PYTHON" main_web.py --port 5001 >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 2

    if kill -0 $(cat "$PID_FILE") 2>/dev/null; then
        echo "Scheduler started (PID: $(cat $PID_FILE))"
        echo "Web UI: http://oracle.local:5001"
    else
        echo "Failed to start scheduler"
        rm -f "$PID_FILE"
        return 1
    fi
}

stop() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            kill "$PID"
            sleep 2
            if kill -0 "$PID" 2>/dev/null; then
                kill -9 "$PID"
            fi
            echo "Scheduler stopped"
        else
            echo "Scheduler not running"
        fi
        rm -f "$PID_FILE"
    else
        # Try to find and kill by name
        pkill -f "main_web.py --port 5001" 2>/dev/null
        echo "Scheduler stopped"
    fi
}

restart() {
    stop
    sleep 1
    start
}

status() {
    if [ -f "$PID_FILE" ] && kill -0 $(cat "$PID_FILE") 2>/dev/null; then
        echo "Scheduler running (PID: $(cat $PID_FILE))"
        curl -s http://localhost:5001/api/status | python3 -m json.tool 2>/dev/null || echo "API not responding"
    else
        echo "Scheduler not running"
    fi
}

logs() {
    tail -f "$LOG_FILE"
}

case "$1" in
    start)   start   ;;
    stop)    stop    ;;
    restart) restart ;;
    status)  status  ;;
    logs)    logs    ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs}"
        exit 1
        ;;
esac
