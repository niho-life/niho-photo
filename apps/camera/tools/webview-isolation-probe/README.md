# webview-isolation-probe（研究用・#173）

Mac の Tauri WebView で、画面と Worker が cross-origin isolated になるか（`crossOriginIsolated`・`SharedArrayBuffer`・共有の
`WebAssembly.Memory`・入れ子の Worker への共有メモリと `Atomics.wait` / `notify`）を、同じページの配り方だけ変えて確かめる小さなアプリです。
写真・IPC・外部への通信は使いません。配布物と公開 CI には入れません。

| モード | 配り方 | COOP / COEP の付け方 |
| --- | --- | --- |
| `tauri-asset` | Tauri の asset protocol（`tauri://localhost`。本番の app と同じ） | `tauri.conf.json` の `app.security.headers` |
| `custom` | Tauri に登録した独自の scheme（`probe://localhost`） | `src/main.rs` の応答 |
| `http` | このプロセスが bind した `http://127.0.0.1:<port>` | `src/main.rs` の応答 |
| `http-plain` | `http` から COOP / COEP を外した対照 | なし |
| `wk-custom` | 素の WKWebView（Tauri / wry なし）の `WKURLSchemeHandler` | `wkwebview-probe.swift` の応答 |
| `wk-http` | 素の WKWebView で `http://127.0.0.1:<port>`（`webview-isolation-probe serve`） | `src/main.rs` の応答 |

どのモードでも、画面は次を集めて JSON で返します（1 回目の後に `?stage=2` で開き直し、2 回目も返す）。

- 画面と Worker 3 種（blob の classic・blob の module・同じ origin の URL の module。現像の Worker は最後の形）の `origin`・`isSecureContext`・
  `crossOriginIsolated`・`SharedArrayBuffer`・共有メモリ（上限 4GB）、Worker から入れ子の Worker へ共有メモリを渡した `Atomics.wait` の結果
- 同じ origin の文書・script・Worker の script の応答の COOP / COEP / CORP
- 別 origin の独自の scheme: `probe-thumb:` の画像（`niho-thumb:` と同じ形。CORP あり・なし）、`probe-develop:` の CORS の POST と
  Worker からの同期の XHR（`niho-develop:` と同じ形）

## 使い方

Rust の build は Mac Studio で回します（[AGENTS.md](../../../../AGENTS.md)）。push した clean な HEAD から:

```sh
studio-exec.sh run --class heavy --name webview-isolation -- sh apps/camera/tools/webview-isolation-probe/run.sh all
```

別の Mac で開くときは、`target/release/` の `webview-isolation-probe` と `wkwebview-probe` を写し、そのフォルダを渡します（`page/` は
`wkwebview-probe` が読むので、同じ commit の checkout から実行します）。

```sh
PROBE_BIN_DIR=<写したフォルダ> sh apps/camera/tools/webview-isolation-probe/run.sh run
```

最初の行は macOS・WebKit の版と機種、続く行がモードごとの結果です。GUI のログインが要ります（窓は小さく、数秒で閉じます）。
