#!/bin/sh
cd "$(dirname "$0")" || exit 1
PORT=8765
python3 server.py "$PORT" &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT INT TERM
sleep 0.7
chromium --app="http://127.0.0.1:$PORT/index.html" --auto-accept-this-tab-capture --window-size=1400,950 2>/dev/null
