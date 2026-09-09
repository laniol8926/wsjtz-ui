#!/usr/bin/env bash
# Starts the wsjtz-ui backend bridge (UDP <-> WebSocket) and the frontend dev
# server. Does NOT start WSJT-Z itself -- that's a separate manual step, this
# script just warns if it doesn't see it running.
#
# Safe to re-run: each piece is skipped if already listening on its port.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_DIR="$SCRIPT_DIR/frontend"
WS_PORT=8791
FRONTEND_PORT=5174

port_in_use() {
	# Quiet TCP connect check -- avoids depending on ss/lsof/fuser output
	# parsing, which needs root on this machine to see other users' sockets.
	# Checks both address families: Vite's dev server has been observed
	# binding [::1] only (IPv6), which an IPv4-only check misses entirely --
	# confirmed live 2026-09-09, caused a false "port free" and a doomed
	# second `vite` instance.
	(exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; }
	(exec 3<>"/dev/tcp/::1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; }
	return 1
}

if ! pgrep -x wsjtx >/dev/null 2>&1; then
	echo "warning: WSJT-Z (wsjtx) doesn't appear to be running -- start it first, or the backend will have nothing to relay." >&2
fi

if port_in_use "$WS_PORT"; then
	echo "backend already running (port $WS_PORT is in use) -- skipping"
else
	echo "starting backend (ws://127.0.0.1:$WS_PORT)..."
	(cd "$BACKEND_DIR" && nohup node server.js > server.log 2>&1 &)
	sleep 1
	if port_in_use "$WS_PORT"; then
		echo "  backend up, logging to $BACKEND_DIR/server.log"
	else
		echo "  backend failed to start -- check $BACKEND_DIR/server.log" >&2
	fi
fi

if port_in_use "$FRONTEND_PORT"; then
	echo "frontend already running (port $FRONTEND_PORT is in use) -- skipping"
else
	echo "starting frontend dev server (http://localhost:$FRONTEND_PORT)..."
	(cd "$FRONTEND_DIR" && nohup node_modules/.bin/vite > vite.log 2>&1 &)
	sleep 2
	if port_in_use "$FRONTEND_PORT"; then
		echo "  frontend up, logging to $FRONTEND_DIR/vite.log"
	else
		echo "  frontend failed to start -- check $FRONTEND_DIR/vite.log" >&2
	fi
fi

echo ""
echo "Open http://localhost:$FRONTEND_PORT in a browser."
