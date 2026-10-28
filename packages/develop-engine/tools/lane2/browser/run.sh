#!/usr/bin/env bash
# Research only (#130): runs worker.js in headless Chrome (a fresh profile per
# trial) against a wasm-bindgen --target web build in <work dir>/<pkg>, with
# <threads> wasm threads (0: single threaded), and prints per-step medians.
# usage: tools/lane2/browser/run.sh <work dir> <pkg name> <threads> [trials]
set -euo pipefail
cd "$(dirname "$0")"
W="$1"; PKG="$2"; THREADS="$3"; TRIALS="${4:-5}"
SITE="$W/site"
mkdir -p "$SITE"
cp index.html worker.js "$SITE/"
rm -rf "${SITE:?}/$PKG"
cp -R "$W/$PKG" "$SITE/$PKG"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUTS=()
for trial in $(seq 1 "$TRIALS"); do
  PORT=$((18000 + RANDOM % 1000))
  OUT="$W/browser-$PKG-t$THREADS-$trial.json"
  rm -f "$OUT"
  node server.mjs "$SITE" "$W" "$OUT" "$PORT" &
  SERVER=$!
  PROFILE=$(mktemp -d)
  "$CHROME" --headless=new --no-first-run --no-default-browser-check --disable-extensions \
    --user-data-dir="$PROFILE" "http://127.0.0.1:$PORT/?pkg=$PKG&threads=$THREADS" >/dev/null 2>&1 &
  CHROME_PID=$!
  for _ in $(seq 1 360); do [ -s "$OUT" ] && break; sleep 0.5; done
  kill "$CHROME_PID" 2>/dev/null || true
  wait "$CHROME_PID" 2>/dev/null || true
  kill "$SERVER" 2>/dev/null || true
  rm -rf "$PROFILE"
  OUTS+=("$OUT")
done
node -e '
const runs = process.argv.slice(1).map((p) => { try { return JSON.parse(require("fs").readFileSync(p, "utf8")); } catch { return { error: "no result " + p }; } });
const errors = runs.filter((r) => r.error); if (errors.length) console.log("errors:", errors.map((e) => e.error.slice(0, 300)));
const ok = runs.filter((r) => !r.error); if (!ok.length) process.exit(1);
console.log("isolated", ok[0].crossOriginIsolated, "cores", ok[0].cores, "threads", ok[0].threads, ok[0].ua);
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
for (const step of ok[0].steps.map((s) => s.step)) {
  const xs = ok.map((r) => r.steps.find((s) => s.step === step));
  const hashes = new Set(xs.map((s) => s.rgbaSha256).filter(Boolean));
  console.log(step.padEnd(24), med(xs.map((s) => s.ms)).toFixed(0).padStart(6), "ms", ((Math.max(...xs.map((s) => s.memory ?? 0))) / 1e6).toFixed(0).padStart(5), "MB", [...hashes].map((h) => h.slice(0, 12)).join(","));
}' "${OUTS[@]}"
