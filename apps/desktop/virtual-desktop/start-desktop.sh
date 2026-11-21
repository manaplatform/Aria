#!/bin/sh
set -eu

umask 077
xauth add "$DISPLAY" . "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
Xvfb "$DISPLAY" -nolisten tcp -auth "$XAUTHORITY" -screen 0 1024x768x24 -noreset &
display=$!
trap 'kill "$display" 2>/dev/null || true' EXIT INT TERM
for attempt in $(seq 1 50); do
  if xdpyinfo >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
xdpyinfo >/dev/null
dbus-run-session -- openbox --sm-disable &
wait "$display"
