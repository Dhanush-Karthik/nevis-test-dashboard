#!/bin/bash
# Installs, builds (only what changed) and starts the test dashboard as a background daemon.
# After a `git pull` just run this again: changed dependencies or sources are detected, the client is
# rebuilt, and a server still running old code is restarted. If nothing changed and it is up, it does nothing.
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

# Content fingerprint of some files/folders (names + bytes), so changes are noticed regardless of git or mtimes.
fingerprint() {
    find "$@" -type f -not -path '*/node_modules/*' -not -path '*/dist/*' -print0 2>/dev/null | sort -z | xargs -0 cksum 2>/dev/null | cksum | cut -d' ' -f1
}
DEPS_HASH="$(fingerprint package.json package-lock.json client/package.json client/package-lock.json)"
CLIENT_HASH="$(fingerprint client/src client/public client/index.html client/vite.config.js client/package.json)"
SERVER_HASH="$(fingerprint server bin package.json)-$CLIENT_HASH"
stamp_is() { [ "$(cat "$RUN_DIR/$1" 2>/dev/null)" = "$2" ]; }

is_running() {
    [ -f "$PID_FILE" ] || return 1
    local pid
    pid="$(cat "$PID_FILE")"
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

if [ "$FORCE_REBUILD" = false ] && is_running && curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    if stamp_is server.stamp "$SERVER_HASH"; then
        echo "Dashboard already running (pid $(cat "$PID_FILE")) at http://localhost:$PORT"
        exit 0
    fi
    echo "The running dashboard is out of date (new code pulled), restarting..."
fi

if is_running; then
    echo "Stopping the old dashboard process..."
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
    sleep 1
fi

if [ "$FORCE_REBUILD" = true ] || [ ! -d node_modules ] || [ ! -d client/node_modules ] || ! stamp_is deps.stamp "$DEPS_HASH"; then
    echo "Installing dependencies..."
    npm install --no-audit --no-fund
    (cd client && npm install --no-audit --no-fund)
    echo "$DEPS_HASH" > "$RUN_DIR/deps.stamp"
    FORCE_CLIENT=true
fi

if [ "${FORCE_CLIENT:-false}" = true ] || [ "$FORCE_REBUILD" = true ] || [ ! -f client/dist/index.html ] || ! stamp_is build.stamp "$CLIENT_HASH"; then
    echo "Building client..."
    (cd client && npm run build)
    echo "$CLIENT_HASH" > "$RUN_DIR/build.stamp"
fi

echo "Starting dashboard server on port $PORT..."
DASHBOARD_PORT="$PORT" nohup node bin/nevis-dashboard.js >"$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "$SERVER_HASH" > "$RUN_DIR/server.stamp"
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
