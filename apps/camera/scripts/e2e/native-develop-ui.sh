#!/usr/bin/env bash
# #152: native-develop.sh の e2e bundle を使い、合成 PNG を画面から開いて
# progressive-open.js の露光・プリセット・実 paint と runtime=native を確かめる。
# Mac Studio の GUI-domain hub から実行する。usage: native-develop-ui.sh <native-develop.sh の work dir>
set -euo pipefail
cd "$(dirname "$0")/../../../.."
W="$(cd "$1" && pwd)"
TARGET="${CARGO_TARGET_DIR:-$W/target}"
APP="$TARGET/camera/debug/bundle/macos/NIHO photo.app"
RENDER="$TARGET/develop-engine/release/niho-develop-render"
test -x "$APP/Contents/MacOS/niho_camera"
test -x "$RENDER"

# raster の作業コピーにも camera の同梱 sidecar の availability probe が要る。
swift build --package-path packages/develop-engine/tools/apple-raw-linear -c release \
  --scratch-path "$TARGET/apple" --product apple-raw-linear >"$W/build-apple.log" 2>&1 ||
  { tail -40 "$W/build-apple.log"; exit 1; }
APPLE_DIR="$(swift build --package-path packages/develop-engine/tools/apple-raw-linear -c release \
  --scratch-path "$TARGET/apple" --show-bin-path)"
APPLE="$APPLE_DIR/apple-raw-linear"
test -x "$APPLE"

python3 - "$W/synthetic.png" <<'PY'
import struct
import sys
import zlib

width, height = 1600, 1067
raw = bytearray()
for y in range(height):
    raw.append(0)
    for x in range(width):
        raw.extend(((x * 180 // width + 35) % 256,
                    (y * 150 // height + 55) % 256,
                    ((x + y) // 19 + 70) % 256))

def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)

png = (b"\x89PNG\r\n\x1a\n"
       + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
       + chunk(b"IDAT", zlib.compress(raw, 6))
       + chunk(b"IEND", b""))
with open(sys.argv[1], "wb") as out:
    out.write(png)
PY

node - "$W/ui-probe.js" <<'NODE'
const fs = require("node:fs");
const template = fs.readFileSync("apps/camera/scripts/e2e/progressive-open.js", "utf8");
const config = { label: "synthetic", fileName: "synthetic.png", addPhotos: true, mode: "cold", iteration: 1 };
fs.writeFileSync(process.argv[2], template.replace("__BENCH_CONFIG__", JSON.stringify(config)));
NODE

rm -f "$W/ui-report.json"
NIHO_APPLE_RAW_LINEAR_PATH="$APPLE" NIHO_DEVELOP_RENDER_PATH="$RENDER" \
  NIHO_DEVELOP_CALIBRATION_DIR="$PWD/packages/develop-engine/calibration" \
  NIHO_CAMERA_E2E_PICK_PHOTOS="$W/synthetic.png" NIHO_CAMERA_E2E_WINDOW=foreground \
  NIHO_CAMERA_E2E_SCRIPT="$W/ui-probe.js" NIHO_CAMERA_E2E_REPORT="$W/ui-report.json" \
  NIHO_CAMERA_E2E_TRACE="$W/ui-trace.log" \
  "$APP/Contents/MacOS/niho_camera" >"$W/ui-app.log" 2>&1 &
PID=$!
/usr/bin/osascript -e 'delay 1' -e "tell application \"$APP\" to activate" >/dev/null 2>&1 || true
APP_KB=0
SIDECAR_KB=0
for _ in $(seq 1 1800); do
  [ -s "$W/ui-report.json" ] && break
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
test -s "$W/ui-report.json" || { tail -30 "$W/ui-app.log"; echo "no UI report"; exit 1; }
node - "$W/ui-report.json" "$SIDECAR_KB" "$APP_KB" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
report.rssHighWaterMiB = {
  sidecar: Math.round(+process.argv[3] / 1024),
  app: Math.round(+process.argv[4] / 1024),
};
console.log(JSON.stringify(report, null, 2));
if (
  report.ok !== true ||
  report.developRuntime !== "native" ||
  report.settingsRetained !== true ||
  report.presetRetained !== true ||
  !Number.isFinite(report.exposurePaintMs) ||
  !Number.isFinite(report.presetPaintMs)
) {
  console.error("native develop UI E2E failed");
  process.exitCode = 1;
}
NODE
