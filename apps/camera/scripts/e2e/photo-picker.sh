#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."

if [ "$(uname -s)" != "Darwin" ]; then
  echo "photo-picker E2E requires macOS" >&2
  exit 2
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" != "24" ]; then
  echo "photo-picker E2E requires Node.js 24" >&2
  exit 2
fi

W="$(mktemp -d "${TMPDIR:-/tmp}/niho-photo-picker-e2e.XXXXXX")"
W="$(cd "$W" && pwd -P)"
APP_PID=""
TEMP_VITE_CONFIG=""
cleanup() {
  if [ -n "$APP_PID" ]; then
    kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  if [ -n "$TEMP_VITE_CONFIG" ]; then rm -f "$TEMP_VITE_CONFIG"; fi
  rm -rf "$W"
}
show_build_failure() {
  local log="$1"
  sed -E 's#/[[:alnum:]_.-]+(/[[:alnum:]_.-]+)*#<path>#g' "$log" | tail -30 >&2
}
trap cleanup EXIT INT TERM
mkdir -p "$W/home" "$W/output" "$W/export" "$W/photos" "$W/fixture-folder"
mkdir -p "$W/home/Library"
RUN_ID="$(printf '%s' "${W##*.}" | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]')"
APP_IDENTIFIER="life.niho.photo.e2e.picker.$RUN_ID"

node --version >/dev/null
echo "photo-picker E2E: generate synthetic fixtures"
swift apps/camera/scripts/e2e/photo-picker-fixtures.swift "$W/photos"
cp "$W/photos/fixture-jpeg.jpg" "$W/fixture-folder/folder-photo.jpg"
cp packages/develop-engine/fixtures/public-raw/dc-s5-owner.rw2 "$W/photos/fixture-raw.rw2"
shasum -a 256 "$W/photos"/* "$W/fixture-folder"/* >"$W/source-before.sha256"

if [ ! -d node_modules ] || [ ! -x node_modules/.bin/vite ] || [ ! -f node_modules/typescript/package.json ]; then
  echo "photo-picker E2E: install locked JavaScript dependencies"
  npm ci --ignore-scripts --no-audit --no-fund >"$W/npm-ci.log" 2>&1 || {
    echo "photo-picker E2E dependency install failed" >&2
    exit 1
  }
fi

echo "photo-picker E2E: build pinned engine runtime from clean HEAD snapshot"
git clone --quiet --shared --no-checkout "$PWD" "$W/runtime-source"
git -C "$W/runtime-source" checkout --quiet --detach HEAD
ln -s "$PWD/node_modules" "$W/runtime-source/node_modules"
printf '\nnode_modules\n' >>"$W/runtime-source/.git/info/exclude"
node "$W/runtime-source/scripts/sdk/build-develop-engine-runtime.mjs" --output "$W/runtime" >"$W/runtime-build.log" 2>&1 || {
  echo "photo-picker E2E engine runtime build failed (check pinned Rust, wasm target, rust-src, and wasm-bindgen prerequisites)" >&2
  show_build_failure "$W/runtime-build.log"
  exit 1
}
ENGINE="$(sed -n 's/^export const DEVELOP_ENGINE_VERSION = "\(.*\)";/\1/p' packages/photo-editing/src/develop-engine/develop-engine-manifest.ts)"
if [ -z "$ENGINE" ]; then
  echo "photo-picker E2E could not identify the public engine version" >&2
  exit 1
fi
if [ ! -d "$W/runtime" ] || ! node - "$W/runtime" <<'NODE'
const fs = require("node:fs");
const names = fs.readdirSync(process.argv[2]);
process.exit(names.some((name) => /^manifest-[^/]+\.json$/u.test(name)) ? 0 : 1);
NODE
then
  echo "photo-picker E2E engine runtime output is incomplete" >&2
  show_build_failure "$W/runtime-build.log"
  exit 1
fi
PUBLIC_DIR="$W/public"
if [ -d apps/camera/public ]; then
  cp -R apps/camera/public "$PUBLIC_DIR"
else
  mkdir -p "$PUBLIC_DIR"
fi
mkdir -p "$PUBLIC_DIR/develop-engine/$ENGINE"
cp -R "$W/runtime/." "$PUBLIC_DIR/develop-engine/$ENGINE/" 2>/dev/null || {
  echo "photo-picker E2E could not copy the generated engine runtime" >&2
  exit 1
}
if ! node - "$PUBLIC_DIR/develop-engine/$ENGINE" <<'NODE'
const fs = require("node:fs");
const names = fs.readdirSync(process.argv[2]);
process.exit(names.some((name) => /^manifest-[^/]+\.json$/u.test(name)) ? 0 : 1);
NODE
then
  echo "photo-picker E2E runtime manifest is missing" >&2
  exit 1
fi

echo "photo-picker E2E: build native renderer and raster decoder"
CARGO_TARGET_DIR="$W/target/develop-engine" cargo +1.98.1 build --release --locked \
  --manifest-path packages/develop-engine/Cargo.toml -p niho-develop-render \
  >"$W/build-render.log" 2>&1 || { echo "photo-picker E2E native renderer build failed" >&2; exit 1; }
RENDER="$W/target/develop-engine/release/niho-develop-render"

swift build --package-path packages/develop-engine/tools/apple-raw-linear -c release \
  --scratch-path "$W/target/apple" --product apple-raw-linear >"$W/build-apple.log" 2>&1 || {
  echo "photo-picker E2E raster decoder build failed" >&2
  exit 1
}
APPLE_DIR="$(swift build --package-path packages/develop-engine/tools/apple-raw-linear -c release \
  --scratch-path "$W/target/apple" --show-bin-path)"
APPLE="$APPLE_DIR/apple-raw-linear"
if [ ! -x "$APPLE" ]; then
  echo "photo-picker E2E raster decoder is missing" >&2
  exit 1
fi

echo "photo-picker E2E: build frontend into isolated directory"
VITE_CONFIG_CANDIDATE="$PWD/apps/camera/.photo-picker-vite-$RUN_ID.mjs"
if [ -e "$VITE_CONFIG_CANDIDATE" ]; then
  echo "photo-picker E2E could not allocate its temporary Vite config" >&2
  exit 1
fi
TEMP_VITE_CONFIG="$VITE_CONFIG_CANDIDATE"
cat >"$TEMP_VITE_CONFIG" <<'VITE_CONFIG'
import config from "./vite.config.ts";

export default {
  ...config,
  publicDir: process.env.NIHO_CAMERA_E2E_PUBLIC_DIR,
  build: { ...config.build, outDir: process.env.NIHO_CAMERA_E2E_DIST_DIR },
};
VITE_CONFIG
NIHO_CAMERA_E2E_PUBLIC_DIR="$PUBLIC_DIR" NIHO_CAMERA_E2E_DIST_DIR="$W/dist" \
  npm -C apps/camera exec -- vite build "$PWD/apps/camera" --config "$TEMP_VITE_CONFIG" \
  >"$W/build-frontend.log" 2>&1 || {
  echo "photo-picker E2E frontend build failed" >&2
  show_build_failure "$W/build-frontend.log"
  exit 1
}

echo "photo-picker E2E: build isolated e2e app"
CARGO_TARGET_DIR="$W/target/camera" npm -C apps/camera run tauri -- build --debug --bundles app --features e2e \
  --config "$(node -e 'process.stdout.write(JSON.stringify({identifier:process.argv[1],build:{frontendDist:process.argv[2],beforeBuildCommand:""},bundle:{createUpdaterArtifacts:false,macOS:{signingIdentity:"-",hardenedRuntime:false}}}))' "$APP_IDENTIFIER" "$W/dist")" \
  >"$W/build-app.log" 2>&1 || {
  echo "photo-picker E2E app build failed" >&2
  show_build_failure "$W/build-app.log"
  exit 1
}
APP="$W/target/camera/debug/bundle/macos/NIHO photo.app/Contents/MacOS/niho_camera"
if [ ! -x "$APP" ]; then
  echo "photo-picker E2E app executable is missing" >&2
  exit 1
fi

FIXTURE_NAMES='["fixture-heic.heic","fixture-jpeg.jpg","fixture-png.png","fixture-raw.rw2","fixture-tiff.tiff"]'
EDIT_NAMES='["fixture-jpeg.jpg","fixture-png.png","fixture-heic.heic","fixture-tiff.tiff"]'
EXTENSIONS='["HEIC","JPEG","PNG","RW2","TIFF"]'
write_probe() {
  local phase="$1"
  local expected="${2:-null}"
  node - "$W/$phase.js" "$phase" "$expected" <<'NODE'
const fs = require("node:fs");
const output = process.argv[2];
const phase = process.argv[3];
const expectedText = process.argv[4];
const config = {
  phase,
  folderName: "fixture-folder",
  folderPhotoName: "folder-photo.jpg",
  fixtureNames: ["fixture-heic.heic", "fixture-jpeg.jpg", "fixture-png.png", "fixture-raw.rw2", "fixture-tiff.tiff"],
  rawName: "fixture-raw.rw2",
  editNames: ["fixture-jpeg.jpg", "fixture-png.png", "fixture-heic.heic", "fixture-tiff.tiff"],
  jpegName: "fixture-jpeg.jpg",
  extensions: ["HEIC", "JPEG", "PNG", "RW2", "TIFF"],
  expectedExposure: expectedText === "null" ? null : Number(expectedText),
};
const template = fs.readFileSync("apps/camera/scripts/e2e/photo-picker.js", "utf8");
fs.writeFileSync(output, template.replace("__PHOTO_PICKER_CONFIG__", JSON.stringify(config)));
NODE
}

run_phase() {
  local phase="$1"
  local pick_folder="${2:-}"
  local pick_photos="${3:-}"
  local expected="${4:-null}"
  local report="$W/$phase.report.json"
  local trace="$W/$phase.trace"
  local probe="$W/$phase.js"
  write_probe "$phase" "$expected"
  rm -f "$report" "$trace" "$W/$phase.app.log"
  HOME="$W/home" CFFIXED_USER_HOME="$W/home" \
    NIHO_CAMERA_E2E_SCRIPT="$probe" \
    NIHO_CAMERA_E2E_REPORT="$report" \
    NIHO_CAMERA_E2E_TRACE="$trace" \
    NIHO_CAMERA_E2E_PICK_FOLDER="$pick_folder" \
    NIHO_CAMERA_E2E_PICK_PHOTOS="$pick_photos" \
    NIHO_CAMERA_E2E_SAVE_DIR="$W/export" \
    NIHO_DEVELOP_RENDER_PATH="$RENDER" \
    NIHO_APPLE_RAW_LINEAR_PATH="$APPLE" \
    NIHO_DEVELOP_CALIBRATION_DIR="$PWD/packages/develop-engine/calibration" \
    "$APP" >"$W/$phase.app.log" 2>&1 &
  APP_PID=$!
  local waited=0
  while [ "$waited" -lt 1800 ]; do
    [ -s "$report" ] && break
    kill -0 "$APP_PID" 2>/dev/null || break
    sleep 0.2
    waited=$((waited + 1))
  done
  if [ ! -s "$report" ]; then
    kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
    APP_PID=""
    echo "photo-picker E2E phase failed before a report was written" >&2
    exit 1
  fi
  wait "$APP_PID" || {
    APP_PID=""
    echo "photo-picker E2E app exited unsuccessfully" >&2
    exit 1
  }
  APP_PID=""
  if ! node - "$report" "$trace" "$W/$phase.app.log" "$W" "$PWD" <<'NODE'
const fs = require("node:fs");
const files = process.argv.slice(2, 5);
const roots = process.argv.slice(5);
const userPath = /(?:\/Users\/[^/\s"']+(?:\/[^\s"']*)?|\/home\/[^/\s"']+(?:\/[^\s"']*)?|\/(?:private\/)?var\/folders\/[^\s"']+|\/tmp\/[^\s"']+)/u;
if (files.some((file) => {
  const text = fs.readFileSync(file, "utf8");
  return roots.some((root) => text.includes(root)) || userPath.test(text);
})) process.exit(1);
NODE
  then
    echo "photo-picker E2E found a local path in its report or logs" >&2
    exit 1
  fi
  node - "$report" "$phase" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.ok !== true || report.phase !== process.argv[3]) {
  console.error(JSON.stringify({
    failedPhase: process.argv[3],
    reason: report.reason ?? "invalid-report",
    stage: report.stage ?? null,
    tileCount: report.tileCount ?? null,
    missingFormats: report.missingFormats ?? [],
    observedFormats: report.observedFormats ?? [],
  }));
  process.exit(1);
}
console.log(JSON.stringify(report));
NODE
}

PHOTO_PATHS="$(printf '%s:' "$W"/photos/fixture-heic.heic "$W"/photos/fixture-jpeg.jpg "$W"/photos/fixture-png.png "$W"/photos/fixture-raw.rw2 "$W"/photos/fixture-tiff.tiff)"
PHOTO_PATHS="${PHOTO_PATHS%:}"
echo "photo-picker E2E: exercise folder and multiple-file selection, restart, duplicate selection, edits, and JPEG export"
run_phase seed "$W/fixture-folder" "$PHOTO_PATHS"
run_phase restart "" "$PHOTO_PATHS"
EXPECTED_EXPOSURE="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).expectedExposure' "$W/restart.report.json")"
run_phase cancel

echo "photo-picker E2E: exercise missing and restored media"
mv "$W/photos" "$W/photos-moved"
mv "$W/fixture-folder" "$W/folder-moved"
run_phase missing
mv "$W/photos-moved" "$W/photos"
mv "$W/folder-moved" "$W/fixture-folder"
run_phase reappear
echo "photo-picker E2E: exercise forget and re-add with edit restoration"
run_phase forget
shasum -a 256 "$W/photos"/* "$W/fixture-folder"/* >"$W/source-after.sha256"
if ! cmp -s "$W/source-before.sha256" "$W/source-after.sha256"; then
  echo "photo-picker E2E detected a modified or missing source fixture" >&2
  exit 1
fi
for name in fixture-jpeg.jpg fixture-png.png fixture-heic.heic fixture-tiff.tiff fixture-raw.rw2; do
  if [ ! -f "$W/photos/$name" ]; then
    echo "photo-picker E2E detected a removed source fixture" >&2
    exit 1
  fi
done
run_phase readd "" "$PHOTO_PATHS" "$EXPECTED_EXPOSURE"
node - "$W/export" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const directory = process.argv[2];
const files = fs.readdirSync(directory).filter((name) => name.toLowerCase().endsWith(".jpg"));
if (files.length !== 4 || files.some((name) => {
  const bytes = fs.readFileSync(path.join(directory, name));
  return bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9;
})) {
  console.error("photo-picker E2E JPEG export output is invalid");
  process.exit(1);
}
console.log(JSON.stringify({ jpegExports: files.length, originalFilesPreserved: true }));
NODE
