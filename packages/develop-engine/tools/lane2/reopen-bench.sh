#!/usr/bin/env bash
# Research only (lane 2 of #125): builds the wasm and a signed working copy
# stand-in from the public RW2, then runs tools/reopen-wasm-bench.mjs.
# usage: tools/lane2/reopen-bench.sh <work dir> <pkg name> [trials]
set -euo pipefail
cd "$(dirname "$0")/../.."
W="$1"; NAME="$2"; TRIALS="${3:-6}"
mkdir -p "$W"
if [ ! -f "$W/signed.png" ]; then
  cargo +1.98.1 run -q --release --locked -p niho-base-raw -- render \
    --raw fixtures/public-raw/dc-s5-owner.rw2 \
    --dcp crates/niho-base-raw/profiles/panasonic-dc-s5/niho-dc-s5-independent-v1.dcp \
    --out "$W/linear.png" --long-edge 2560
  cargo +1.98.1 run -q --release --locked -p niho-develop --example signed_bench_copy -- \
    "$W/linear.png" "$W/linear.json" "$W/signed.png" "$W/signed.json"
fi
cargo +1.98.1 build -q --release --locked --config .cargo/config.toml \
  --target wasm32-unknown-unknown -p niho-develop-wasm
wasm-bindgen --target web --out-dir "$W/$NAME" target/wasm32-unknown-unknown/release/niho_develop_wasm.wasm
ls -la "$W/$NAME" "$W/signed.png"
node tools/reopen-wasm-bench.mjs paired --pkg "$W/$NAME" --png "$W/signed.png" --meta "$W/signed.json" \
  --trials "$TRIALS" --modes "${MODES:-fresh,retained,thumb}" --out "$W/$NAME-reopen.json"
for r in ${RETAINS:-0 1 2}; do
  for prepare in ${PREPARES:-0}; do
    node tools/reopen-wasm-bench.mjs walk --pkg "$W/$NAME" --png "$W/signed.png" --meta "$W/signed.json" --retain "$r" --photos 30 --prepare "$prepare"
    echo
  done
done
