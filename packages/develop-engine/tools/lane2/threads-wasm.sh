#!/usr/bin/env bash
# Research only (#130): wasm single thread vs wasm threads (shared memory,
# wasm-bindgen-rayon) in headless Chrome, plus the memory walk.
# usage: tools/lane2/threads-wasm.sh <work dir> [trials]
set -euo pipefail
cd "$(dirname "$0")/../.."
W="$1"; TRIALS="${2:-5}"
cargo +1.98.1 build -q --release --locked --config .cargo/config.toml --target wasm32-unknown-unknown -p niho-develop-wasm
wasm-bindgen --target web --out-dir "$W/pkg-st" target/wasm32-unknown-unknown/release/niho_develop_wasm.wasm
echo "== memory walk (retain 1, prepare 1, parked photos release the analysis made ahead)"
node tools/reopen-wasm-bench.mjs walk --pkg "$W/pkg-st" --png "$W/signed.png" --meta "$W/signed.json" --retain 1 --photos 30 --prepare 1
echo
rustup component add rust-src --toolchain 1.98.1 >/dev/null 2>&1
RUSTC_BOOTSTRAP=1 RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals,+simd128 \
-C link-arg=--shared-memory -C link-arg=--max-memory=4294967296 -C link-arg=--import-memory \
-C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align \
-C link-arg=--export=__tls_base" \
  CARGO_TARGET_DIR=target-threads cargo +1.98.1 build -q --release --locked \
  --target wasm32-unknown-unknown -p niho-develop-wasm --features threads -Z build-std=panic_abort,std
wasm-bindgen --target web --out-dir "$W/pkg-mt" target-threads/wasm32-unknown-unknown/release/niho_develop_wasm.wasm
ls -la "$W/pkg-st"/*.wasm "$W/pkg-mt"/*.wasm
echo "== Chrome wasm single thread"
tools/lane2/browser/run.sh "$W" pkg-st 0 "$TRIALS" || true
for threads in 4 8; do
  echo "== Chrome wasm threads $threads"
  tools/lane2/browser/run.sh "$W" pkg-mt "$threads" "$TRIALS" || true
done
