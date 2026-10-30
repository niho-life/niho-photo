#!/bin/sh
# Research only (#173): probe を作り、全モードを順に開いて JSON を 1 行ずつ stdout へ出す。
#   run.sh build   cargo build（Tauri）と swiftc（素の WKWebView）。Rust の build は Mac Studio で回す（AGENTS.md）
#   run.sh run     この Mac で全モードを開く（GUI のログインが要る。窓は小さく、数秒で閉じる）
#   run.sh all     build してから run
# 別の Mac で開くときは、build した 2 つの実行ファイルのフォルダを PROBE_BIN_DIR で渡す。
set -eu

here=$(cd "$(dirname "$0")" && pwd)
bin=${PROBE_BIN_DIR:-$here/target/release}
port=${PROBE_PORT:-18173}
action=${1:-all}

case $action in
  build | all)
    cargo build --release --locked --manifest-path "$here/Cargo.toml"
    swiftc -O -o "$here/target/release/wkwebview-probe" "$here/wkwebview-probe.swift"
    ;;
  run) ;;
  *)
    echo "usage: run.sh build | run | all" >&2
    exit 2
    ;;
esac
[ "$action" = build ] && exit 0

webkit=$(defaults read /System/Library/Frameworks/WebKit.framework/Resources/Info.plist CFBundleVersion 2>/dev/null || echo unknown)
printf '{"environment":{"macos":"%s","build":"%s","webkit":"%s","model":"%s","memoryBytes":%s,"probe":"%s"}}\n' \
  "$(sw_vers -productVersion)" "$(sw_vers -buildVersion)" "$webkit" "$(sysctl -n hw.model)" "$(sysctl -n hw.memsize)" \
  "$(shasum -a 256 "$bin/webview-isolation-probe" | cut -c1-12)"

for mode in tauri-asset custom http http-plain; do
  "$bin/webview-isolation-probe" "$mode" || printf '{"mode":"%s","error":"exit %s"}\n' "$mode" "$?"
done

"$bin/webview-isolation-probe" serve "$port" >/dev/null &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT INT TERM
sleep 1
"$bin/wkwebview-probe" "$here/page" custom || printf '{"mode":"wk-custom","error":"exit %s"}\n' "$?"
"$bin/wkwebview-probe" "$here/page" http "$port" || printf '{"mode":"wk-http","error":"exit %s"}\n' "$?"
