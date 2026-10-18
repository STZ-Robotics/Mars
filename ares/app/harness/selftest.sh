#!/bin/bash
# The real app (Tauri, WebKitGTK) driving itself through its flows on a copy
# of a robot project: harness/selftest.ts clicks, types and drags, and logs
# every JS error, failing backend command and step. Nothing of yours is
# touched: the project is copied, the app's data (last robot, preferences)
# goes to a temporary folder, it runs on its own port, and only its own
# processes are stopped at the end.
#
#   harness/selftest.sh <robot project folder> [flows]
#
# "flows" skips the random clicking at the end. The log is printed, and kept
# in the copy's selftest/log.java.
set -u
src=${1:?"usage: selftest.sh <robot project folder> [flows]"}
mode=${2:-all}
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d /tmp/ares-selftest.XXXXXX)
cp -r "$src" "$work/proj"
robot=$(ls "$work"/proj/src/main/deploy/ares/*.robot.json | head -1)
port=1437
if (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null; then echo "port $port is in use: is a self-test already running?"; exit 1; fi
cd "$here" && . ~/.nvm/nvm.sh >/dev/null
flows=0; [ "$mode" = flows ] && flows=1
setsid env XDG_DATA_HOME="$work/data" VITE_ARES_SELFTEST=1 VITE_ARES_SELFTEST_FLOWS=$flows VITE_ARES_SELFTEST_ROBOT="$robot" \
  npx tauri dev --config "{\"build\":{\"devUrl\":\"http://localhost:$port\",\"beforeDevCommand\":\"npx vite --port $port --strictPort\"}}" -- -- "$robot" \
  > "$work/tauri.log" 2>&1 &
group=$!
log="$work/proj/selftest/log.java"
for _ in $(seq 1 120); do [ -f "$log" ] && break; sleep 2.5; done
if [ ! -f "$log" ]; then echo "the app did not start the self-test: see $work/tauri.log"; kill -- -$group 2>/dev/null; exit 1; fi
for _ in $(seq 1 150); do grep -q DONE "$log" && break; sleep 4; done
kill -- -$group 2>/dev/null
cat "$log"
echo "(project copy and logs in $work)"
