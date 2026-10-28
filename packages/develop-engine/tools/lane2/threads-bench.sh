#!/usr/bin/env bash
# Research only (#130): native single-thread vs rayon threads (B), and wasm
# single-thread vs wasm threads (A) in headless Chrome, on the bench's signed
# working copy. Every frame's RGBA SHA-256 is printed to check they are equal.
# usage: tools/lane2/threads-bench.sh <work dir> [trials]
set -euo pipefail
cd "$(dirname "$0")/../.."
W="$1"; TRIALS="${2:-5}"
echo "== native single thread"
cargo +1.98.1 build -q --release --locked -p niho-develop --example signed_final_timing
cp target/release/examples/signed_final_timing "$W/final-st"
echo "== native threads"
cargo +1.98.1 build -q --release --locked -p niho-develop --example signed_final_timing --features threads
cp target/release/examples/signed_final_timing "$W/final-mt"
for run in $(seq 1 "$TRIALS"); do
  for bin in final-st final-mt; do
    echo "-- $bin $run"
    "$W/$bin" "$W/signed.png" "$W/signed.json"
  done
done
echo "== wasm builds"
cargo +1.98.1 build -q --release --locked --config .cargo/config.toml --target wasm32-unknown-unknown -p niho-develop-wasm
wasm-bindgen --target web --out-dir "$W/pkg-st" target/wasm32-unknown-unknown/release/niho_develop_wasm.wasm
rustup component add rust-src --toolchain 1.98.1 >/dev/null 2>&1
RUSTC_BOOTSTRAP=1 RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals,+simd128" \
  CARGO_TARGET_DIR=target-threads cargo +1.98.1 build -q --release --locked \
  --target wasm32-unknown-unknown -p niho-develop-wasm --features threads -Z build-std=panic_abort,std
wasm-bindgen --target web --out-dir "$W/pkg-mt" target-threads/wasm32-unknown-unknown/release/niho_develop_wasm.wasm
ls -la "$W/pkg-st"/*.wasm "$W/pkg-mt"/*.wasm
echo "== Chrome wasm single thread"
tools/lane2/browser/run.sh "$W" pkg-st 0 "$TRIALS"
for threads in 4 8; do
  echo "== Chrome wasm threads $threads"
  tools/lane2/browser/run.sh "$W" pkg-mt "$threads" "$TRIALS"
done
echo "== memory walk (retain 1, prepare 1, parked photos release the analysis made ahead)"
node tools/reopen-wasm-bench.mjs walk --pkg "$W/pkg-st" --png "$W/signed.png" --meta "$W/signed.json" --retain 1 --photos 30 --prepare 1
echo
