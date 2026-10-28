#!/usr/bin/env bash
# Research only (#130): native Final 1280 timings on the bench's signed working
# copy (3 processes), then a `sample` profile of repeated preset frames.
# usage: tools/lane2/native-profile.sh <work dir>
set -euo pipefail
cd "$(dirname "$0")/../.."
W="$1"
cargo +1.98.1 build -q --release --locked -p niho-develop --example signed_final_timing
BIN=target/release/examples/signed_final_timing
for run in 1 2 3; do
  echo "== native run $run"
  "$BIN" "$W/signed.png" "$W/signed.json"
done
echo "== sample (preset frames, master prepared each time)"
"$BIN" "$W/signed.png" "$W/signed.json" --loop 40 > "$W/loop.txt" &
PID=$!
sleep 12
sample "$PID" 10 -file "$W/sample.txt" >/dev/null 2>&1 || true
wait "$PID" || true
tail -3 "$W/loop.txt"
# The summary of the busiest frames (top of stack).
awk '/Sort by top of stack/{p=1} p' "$W/sample.txt" | head -45
