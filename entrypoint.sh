#!/bin/bash
set -e

echo "[entrypoint] Starting Xvfb on display :99..."
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!

# Wait until Xvfb is actually accepting connections
echo "[entrypoint] Waiting for Xvfb to be ready..."
MAX_WAIT=30
COUNT=0
until xdpyinfo -display :99 >/dev/null 2>&1; do
    sleep 0.5
    COUNT=$((COUNT + 1))
    if [ $COUNT -ge $((MAX_WAIT * 2)) ]; then
        echo "[entrypoint] ERROR: Xvfb did not start within ${MAX_WAIT}s"
        exit 1
    fi
done
echo "[entrypoint] Xvfb is ready"

# Start dbus (needed by Chrome for some features)
if command -v dbus-daemon &>/dev/null; then
    mkdir -p /run/dbus
    dbus-daemon --system --fork 2>/dev/null || true
fi

# Verify Chrome is available
echo "[entrypoint] Chrome path: $PUPPETEER_EXECUTABLE_PATH"
$PUPPETEER_EXECUTABLE_PATH --version || echo "[entrypoint] WARN: Could not get Chrome version"

echo "[entrypoint] Starting Node.js app..."
exec node dist/index.js