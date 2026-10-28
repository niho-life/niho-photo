#!/usr/bin/env bash
# #152 の E2E: Mac アプリ（e2e feature・専用 identifier・ad-hoc 署名の debug build）の Worker から、native の sidecar
# （`niho-develop-render serve`。release build を NIHO_DEVELOP_RENDER_PATH で渡す）と同梱の wasm で同じ合成の写真を描き、
# 画素が同じかと時間を比べる（native-develop.js・native-develop-worker.js）。sidecar とアプリの RSS の高水位も 0.2 秒ごとに見る。
# 重いので Mac Studio で回す（studio-exec.sh run --class heavy）。実写真は使わない。
# usage: apps/camera/scripts/e2e/native-develop.sh <work dir> [runs]
set -euo pipefail
cd "$(dirname "$0")/../../../.."
W="$1"
RUNS="${2:-5}"
mkdir -p "$W"
W="$(cd "$W" && pwd)"
TARGET="${CARGO_TARGET_DIR:-$W/target}"
npm ci --ignore-scripts --no-audit --no-fund >/dev/null

# 段 2 の wasm（今の版）を公開物の置き場へ（stage-develop-engine.mjs がここから写す）
RUNTIME="$W/runtime-$(git rev-parse --short HEAD)"
[ -d "$RUNTIME" ] || node scripts/sdk/build-develop-engine-runtime.mjs --output "$RUNTIME"
ENGINE="$(sed -n 's/^export const DEVELOP_ENGINE_VERSION = "\(.*\)";/\1/p' packages/photo-editing/src/develop-engine/develop-engine-manifest.ts)"
ENGINE_DIR="packages/develop-engine/public/develop-engine/$ENGINE"
rm -rf "$ENGINE_DIR" && mkdir -p "$ENGINE_DIR" && cp "$RUNTIME"/* "$ENGINE_DIR"/
MANIFEST_PATH="/develop-engine/$ENGINE/$(cd "$ENGINE_DIR" && ls manifest-*.json)"

# native の sidecar（release）
cargo +1.98.1 build --release --locked --manifest-path packages/develop-engine/Cargo.toml -p niho-develop-render \
  --target-dir "$TARGET/develop-engine" >"$W/build-render.log" 2>&1 || { tail -40 "$W/build-render.log"; exit 1; }
RENDER="$TARGET/develop-engine/release/niho-develop-render"

mkdir -p apps/camera/public
cp apps/camera/scripts/e2e/native-develop-worker.js apps/camera/public/native-develop-probe-worker.js
trap 'rm -f apps/camera/public/native-develop-probe-worker.js' EXIT
sed "s#__PROBE_CONFIG__#$(printf '{"manifestPath":"%s","engine":"%s","runs":%d}' "$MANIFEST_PATH" "$ENGINE" "$RUNS")#" \
  apps/camera/scripts/e2e/native-develop.js >"$W/probe.js"

config='{"identifier":"life.niho.photo.native-develop-probe","plugins":{"deep-link":{"desktop":{"schemes":["niho-camera-native-develop-probe"]}}},"bundle":{"createUpdaterArtifacts":false,"macOS":{"signingIdentity":"-","hardenedRuntime":false}}}'
CARGO_TARGET_DIR="$TARGET/camera" npm -C apps/camera run tauri -- build --debug --bundles app --features e2e --config "$config" \
  >"$W/build-app.log" 2>&1 || { tail -40 "$W/build-app.log"; exit 1; }
APP="$TARGET/camera/debug/bundle/macos/NIHO photo.app"

rm -f "$W/report.json"
NIHO_DEVELOP_RENDER_PATH="$RENDER" NIHO_CAMERA_E2E_SCRIPT="$W/probe.js" NIHO_CAMERA_E2E_REPORT="$W/report.json" \
  NIHO_CAMERA_E2E_TRACE="$W/trace.log" "$APP/Contents/MacOS/niho_camera" >"$W/app.log" 2>&1 &
PID=$!
SIDECAR_KB=0
APP_KB=0
for _ in $(seq 1 1800); do
  [ -s "$W/report.json" ] && break
  kill -0 "$PID" 2>/dev/null || break
  kb=$(ps -o rss= -p "$PID" 2>/dev/null | tr -d ' ' || true)
  [ -n "$kb" ] && [ "$kb" -gt "$APP_KB" ] && APP_KB=$kb
  for child in $(pgrep -P "$PID" -f "niho-develop-render" 2>/dev/null || true); do
    kb=$(ps -o rss= -p "$child" 2>/dev/null | tr -d ' ' || true)
    [ -n "$kb" ] && [ "$kb" -gt "$SIDECAR_KB" ] && SIDECAR_KB=$kb
  done
  sleep 0.2
done
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
if [ -s "$W/report.json" ]; then
  node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); r.rssHighWaterMiB = { sidecar: Math.round(+process.argv[2] / 1024), app: Math.round(+process.argv[3] / 1024) }; console.log(JSON.stringify(r, null, 2))' \
    "$W/report.json" "$SIDECAR_KB" "$APP_KB"
else
  echo "no report"
  tail -20 "$W/app.log"
  exit 1
fi
sw_vers
sysctl -n machdep.cpu.brand_string hw.ncpu hw.memsize
