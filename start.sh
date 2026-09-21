#!/bin/bash
# Builds (if needed) and starts the test dashboard as a background daemon.
# Safe to re-run: if the server is already up, it does nothing.
# The test project defaults to the folder containing this one; override with NEVIS_TESTS_ROOT=/path/to/project.
set -e

cd "$(dirname "$0")"

PORT="${DASHBOARD_PORT:-4570}"
RUN_DIR=".run"
PID_FILE="$RUN_DIR/server.pid"
LOG_FILE="$RUN_DIR/server.log"
FORCE_REBUILD=false

for arg in "$@"; do
    case "$arg" in
        --rebuild) FORCE_REBUILD=true ;;
        -h|--help)
            echo "Usage: $0 [--rebuild]"
            echo "  --rebuild   Force reinstall/rebuild of client and server deps."
            exit 0
            ;;
    esac
done

mkdir -p "$RUN_DIR"

is_running() {
    [ -f "$PID_FILE" ] || return 1
    local pid
    pid="$(cat "$PID_FILE")"
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

if is_running && curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    echo "Dashboard already running (pid $(cat "$PID_FILE")) at http://localhost:$PORT"
    exit 0
fi

if is_running; then
    echo "Stale process found, cleaning up..."
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
fi

if [ "$FORCE_REBUILD" = true ] || [ ! -d node_modules ]; then
    echo "Installing server dependencies..."
    npm install --no-audit --no-fund
fi

if [ "$FORCE_REBUILD" = true ] || [ ! -d client/node_modules ]; then
    echo "Installing client dependencies..."
    (cd client && npm install --no-audit --no-fund)
fi

if [ "$FORCE_REBUILD" = true ] || [ ! -f client/dist/index.html ]; then
    echo "Building client..."
    (cd client && npm run build)
fi

echo "Starting dashboard server on port $PORT..."
DASHBOARD_PORT="$PORT" nohup node bin/nevis-dashboard.js >"$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
disown

for _ in $(seq 1 30); do
    if curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
        echo "Dashboard is up: http://localhost:$PORT"
        exit 0
    fi
    sleep 0.5
done

echo "Dashboard did not start. Last lines of $LOG_FILE:" >&2
tail -n 5 "$LOG_FILE" >&2
rm -f "$PID_FILE"
exit 1
