#!/bin/sh
set -e

echo "Starting Xvfb on display :99..."
Xvfb :99 -screen 0 1280x720x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!

# Wait until Xvfb is actually ready (up to 30s)
MAX_WAIT=30
i=0
until xdpyinfo -display :99 >/dev/null 2>&1; do
    i=$((i + 1))
    if [ $i -ge $MAX_WAIT ]; then
        echo "ERROR: Xvfb did not start within ${MAX_WAIT}s" >&2
        exit 1
    fi
    echo "Waiting for Xvfb... ($i/${MAX_WAIT})"
    sleep 1
done

echo "Xvfb is ready (PID $XVFB_PID)"

# Forward SIGTERM/SIGINT to child processes
trap "kill $XVFB_PID 2>/dev/null; exit 0" TERM INT

export NODE_OPTIONS="--max-old-space-size=512"
exec node dist/index.js
