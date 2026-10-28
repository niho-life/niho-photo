#!/usr/bin/env bash
# Research only (#148 の 0): COOP / COEP を足した Mac アプリ（e2e feature・専用 identifier・ad-hoc 署名）を作り、
# 画面と Worker の crossOriginIsolated を見る（COI_BASELINE=1 で headers を外した build も見る）。続けて素の WKWebView で、
# 独自の scheme と http://127.0.0.1 の読み込みを比べる（wkwebview-isolation.swift）。
# usage: apps/camera/scripts/e2e/cross-origin-isolation.sh <work dir>
set -euo pipefail
cd "$(dirname "$0")/../../../.."
W="$1"
mkdir -p "$W"
TARGET="${CARGO_TARGET_DIR:-$W/target}"
npm ci --ignore-scripts --no-audit --no-fund >/dev/null

# 段 2 の wasm（今の 1 本の版）を公開物の置き場へ（stage-develop-engine.mjs がここから写す）
RUNTIME="$W/runtime-$(git rev-parse --short HEAD)"
[ -d "$RUNTIME" ] || node scripts/sdk/build-develop-engine-runtime.mjs --output "$RUNTIME"
ENGINE_DIR="packages/develop-engine/public/develop-engine/$(sed -n 's/^export const DEVELOP_ENGINE_VERSION = "\(.*\)";/\1/p' packages/photo-editing/src/develop-engine/develop-engine-manifest.ts)"
rm -rf "$ENGINE_DIR" && mkdir -p "$ENGINE_DIR" && cp "$RUNTIME"/* "$ENGINE_DIR"/
MANIFEST_PATH="/develop-engine/$(basename "$ENGINE_DIR")/$(cd "$ENGINE_DIR" && ls manifest-*.json)"

mkdir -p apps/camera/public
cp apps/camera/scripts/e2e/cross-origin-isolation-worker.js apps/camera/public/coi-probe-worker.js
sed "s#__PROBE_CONFIG__#$(printf '{"manifestPath":"%s"}' "$MANIFEST_PATH")#" apps/camera/scripts/e2e/cross-origin-isolation.js >"$W/probe.js"

build_and_run() {
  local label="$1" headers="$2"
  local config
  config=$(printf '{"identifier":"life.niho.photo.coi-probe","plugins":{"deep-link":{"desktop":{"schemes":["niho-camera-coi-probe"]}}},"bundle":{"createUpdaterArtifacts":false,"macOS":{"signingIdentity":"-","hardenedRuntime":false}},"app":{"security":{"headers":%s}}}' "$headers")
  CARGO_TARGET_DIR="$TARGET" npm -C apps/camera run tauri -- build --debug --bundles app --features e2e --config "$config" >"$W/build-$label.log" 2>&1 \
    || { tail -40 "$W/build-$label.log"; return 1; }
  local app="$TARGET/debug/bundle/macos/NIHO photo.app"
  rm -f "$W/report-$label.json"
  NIHO_CAMERA_E2E_SCRIPT="$W/probe.js" NIHO_CAMERA_E2E_REPORT="$W/report-$label.json" NIHO_CAMERA_E2E_TRACE="$W/trace-$label.log" \
    "$app/Contents/MacOS/niho_camera" >"$W/app-$label.log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 120); do
    [ -s "$W/report-$label.json" ] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  echo "== $label"
  if [ -s "$W/report-$label.json" ]; then
    node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")), null, 2))' "$W/report-$label.json"
  else
    echo "no report"; tail -20 "$W/app-$label.log"
  fi
}

build_and_run with-headers '{"Cross-Origin-Opener-Policy":"same-origin","Cross-Origin-Embedder-Policy":"require-corp"}'
[ "${COI_BASELINE:-0}" = 1 ] && build_and_run without-headers 'null'

# Tauri を介さない素の WKWebView: 独自の scheme と http://127.0.0.1 の比べ
E2E=apps/camera/scripts/e2e
swiftc -O "$E2E/wkwebview-isolation.swift" -o "$W/wkwebview-isolation"
node "$E2E/wkwebview-isolation/server.mjs" 18149 &
SERVER=$!
sleep 1
echo "== bare WKWebView"
"$W/wkwebview-isolation" "$E2E/wkwebview-isolation" 18149 || true
kill "$SERVER" 2>/dev/null || true
sw_vers
