#!/bin/bash
# Stops the dashboard daemon started by start.sh.
set -e
cd "$(dirname "$0")"

PID_FILE=".run/server.pid"

if [ ! -f "$PID_FILE" ]; then
    echo "No pid file found; dashboard doesn't look like it's running."
    exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    echo "Stopped dashboard (pid $PID)."
else
    echo "Process $PID not running."
fi
rm -f "$PID_FILE"
