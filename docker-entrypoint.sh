#!/bin/sh
# brave-mcp-server entrypoint — runs Webclaw L3 side-car in background,
# then exec the Node.js MCP server in foreground (so signals propagate
# properly to PID 1).

set -e

WEBCLAW_PORT="${WEBCLAW_PORT:-3001}"
WEBCLAW_HOST="${WEBCLAW_BIND_HOST:-127.0.0.1}"

# Launch Webclaw — localhost-only by default, no auth (internal traffic only).
echo "[entrypoint] starting webclaw-server on ${WEBCLAW_HOST}:${WEBCLAW_PORT}..."
webclaw-server --port "$WEBCLAW_PORT" --host "$WEBCLAW_HOST" > /tmp/webclaw.log 2>&1 &
WEBCLAW_PID=$!

# Readiness probe — up to 30s for cold start
for i in $(seq 1 30); do
  if curl -sf "http://${WEBCLAW_HOST}:${WEBCLAW_PORT}/health" > /dev/null 2>&1; then
    echo "[entrypoint] webclaw-server ready (PID=${WEBCLAW_PID})"
    break
  fi
  if [ "$i" = "30" ]; then
    echo "[entrypoint] WARN: webclaw-server did not respond on /health within 30s"
    echo "[entrypoint] webclaw log tail:"
    tail -n 20 /tmp/webclaw.log || true
    # Continue anyway — brave-mcp-server can still operate, L3 will return webclaw_network_error
  fi
  sleep 1
done

# Trap signals so SIGTERM also kills Webclaw side-car
trap 'echo "[entrypoint] stopping..."; kill -TERM "$WEBCLAW_PID" 2>/dev/null; wait "$WEBCLAW_PID" 2>/dev/null; exit 0' TERM INT

# Replace shell with brave-mcp-server (PID 1)
echo "[entrypoint] starting brave-mcp-server (npm run http)..."
exec npm run http
