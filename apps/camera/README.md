# NIHO photo Macアプリ

この公開リポジトリを新規checkoutしてMac上で開発できます。macOS 14以降、Xcode Command Line Tools、Node 24、Rust stableが必要です。

```sh
npm ci
npm run dev --workspace apps/camera
npm run build:unsigned --workspace apps/camera
```

unsigned入口はdebugの `.app` をad-hoc署名し、認証キー・Apple署名証明書・更新署名秘密鍵を要求しません。出力は `apps/camera/src-tauri/target/debug/bundle/macos/NIHO photo.app`。通常の `build` はTauriの開発者向け入口です。公開CIのrelease mode検証app・SBOMと、非公開側の固定SHA取り込みは [公開成果物契約](../../docs/releases/public-artifact-contract.md) に従います。

```sh
npm run typecheck --workspace apps/camera
npm test --workspace apps/camera
npm run lint --workspace apps/camera
cargo test --locked --manifest-path packages/desktop-photo/Cargo.toml
```

ログインは不要です。フォルダまたは個別の写真を選び、JPEG/PNG表示、元画像の保存、補正設定とプリセットの管理をこのMac内で行います。個別写真の画面、復元、失敗時の扱いは [この Mac の写真ソース](../../docs/features/local-photo-sources.md) を参照してください。RAW現像・補正描画・背景除去に必要なエンジン/sidecar/modelは #9 で移行します。未導入時は能力判定により利用できない操作を表示します。WASMは公開engine配置入口からハッシュ検証して取り込み、欠落ならローカル機能で起動、壊れた配置はビルドを止めます。

`allow-camera-library` が同梱UIへ許可するライブラリコマンドは次のとおりです。パスを受け取る・返すコマンドはありません。

| コマンド | 用途 |
| --- | --- |
| `camera_library_add_folder` | ネイティブpickerでフォルダを1つ追加 |
| `camera_library_add_photos` | ネイティブpickerで写真を複数追加 |
| `camera_library_remembered` | 現在表示できる保存済みフォルダ・個別写真を取得 |
| `camera_library_list_folder` | 不透明な `folderId` のフォルダを取得 |
| `camera_library_forget_folder` | フォルダ参照だけを外す |
| `camera_library_forget_photos` | 個別写真の参照をすべて外す |

アカウントは公式NIHO app-connect/PKCE共通パッケージを使います。公開Firebase Web API keyをbuild設定に与えた場合は外部ブラウザとniho-camera deep linkで接続し、未設定の公開CI・開発buildはローカル専用です。クラウド共有は有効表示しません。認証状態は編集の利用条件にしません。[安全契約](../../docs/contracts/native-account.md) を参照してください。クラウド共有は #8。自動更新クライアントと公開鍵はコードに含みますが既定で無効です。公開検証appとSBOMは [公開成果物契約](../../docs/releases/public-artifact-contract.md) に従います。公式release権限、署名、公証、更新有効化は非公開側で扱います。

アプリ名と既存 `camera` パス・端末内データの互換方針は [移植計画](../../docs/migration/mac-client.md) を参照してください。

## 現像の native の口（#152）

Mac アプリの WKWebView は独自の scheme（`tauri://localhost`）の画面で `SharedArrayBuffer` を出さず、共有メモリを Worker へ渡せないので、wasm のスレッドを使えません（#148・#173）。COOP / COEP を付けても、WebKit が共有メモリを許す process へ切り替えるのは NetworkProcess を通る http(s) の読み込みだけで、`WKURLSchemeHandler` の読み込みは通りません。macOS 27 では画面と URL の Worker の `crossOriginIsolated` が true になっても共有メモリは渡せません。確かめる道具は [webview-isolation-probe](tools/webview-isolation-probe/README.md) です。代わりに、現像の Worker が読む glue（wasm-bindgen の口と同じ形）を native に差し替え、同梱の `niho-develop-render serve` で描きます。

- native の glue（`packages/photo-editing/src/develop-engine/develop-engine-native-glue.ts`）は同期の XHR で `niho-develop://localhost/<method>` を呼びます。Tauri の scheme（`src-tauri/src/develop_engine_scheme.rs`）は main 窓だけに答え、知らない口は 404 です。画面の CSP の `connect-src` に `niho-develop:` があります。Mac アプリの画面は `preferNative` で現像の Worker にこの glue を先に読ませ、読めなければ単一の wasm に戻します（スレッドの wasm は Mac アプリに同梱しません）
- sidecar（`src-tauri/src/develop_engine_sidecar.rs`）は最初の要求で起動する長く生きる 1 プロセスで、`Developer` を handle で持ちます。落ちたら次の要求で起動し直し、画面の読み込み直しとアプリの終了で止めます。sidecar は受け取った bytes を描くだけで、ファイルを読み書きしません
- 口と画素は wasm と同じです（どちらも `niho_develop::api` を呼ぶ）。sidecar が無い・`serve` を知らない古い版・版（`hello` の `crateVersion` と `engine`）が画面の `DEVELOP_ENGINE_CRATE_VERSION`・`DEVELOP_ENGINE_VERSION` と違う・起動に失敗したときは、今の wasm で描きます
- 開発の debug build は `NIHO_DEVELOP_RENDER_PATH` で sidecar を差し替えられます。Mac アプリの中で native と wasm の画素と時間を比べる E2E は `scripts/e2e/native-develop.sh <作業フォルダ>`、画面で合成 PNG の露光・プリセットを操作して `runtime: native` を確かめる E2E は続けて `scripts/e2e/native-develop-ui.sh <同じ作業フォルダ>`（Mac Studio で `studio-exec.sh run --class heavy` から）。

## 公式candidateのSDK runtime

公式配布は`npm run candidate:build`から作成します。選択したSDKのruntimeとmanifestを専用Mach-O sectionへ埋め込み、Tauriのasset providerは同じtable/payloadから返します。署名前の検証は候補プログラムを起動せず、sectionの実bytes・path・size・SHA-256をSDKへ照合します。`official-updates` featureの直接buildにはこの固定bundleが必要です。通常の開発buildは従来のfrontend assetsを使います。

## 個人クラウド接続の準備段階

現在の production 入口は引き続き `<App />` で、cloud binding を渡しません。`createMacPersonalCloudPhotoBinding(null)` は `not_connected` と未定義の binding を返します。ログインや写真追加ではコピーを開始しません。P01 の正式な認証済み native transport、P03 の実 API、P08 の scope 対応 immutable adapter（manifest・source SHA・tarball digest）の採用が揃うまで有効化しません。現在の P08 fixture source や SDK 0.1.4 を仮の production 接続としてコピー・注入しません。

`src/personal-cloud-binding.ts` は正式な接続を後で渡すための境界です。trusted host が検証済み library/host と本人・library・session epoch、native の `recover/start/status/cancel` を渡します。React が扱うのは不透明な photo/request ID と進捗だけです。native の回復台帳は本人・library・接続世代・原本 hash/identity・補正の版へ束縛し、request ID を消失結果の照合にも使います。元の絶対 path や upload ticket/token は台帳や IPC に保存・返却しません。再起動時に原本を選び直す必要がある場合も、同一 hash/identity の照合前に再開しません。

この native port の実装時は P00 v1 の `/api/photo/v1` と `uploads.start`（POST `/uploads`）、`uploads.get`（GET `/uploads/{uploadId}`）、`uploads.renew`、`uploads.complete`、`uploads.cancel`（各 POST 子 route）を使います。start/complete/cancel の冪等 key は操作ごとに永続化し、通信失敗時も再利用します。再開はサーバーが返す offset と renew ticket に従い、ticket を永続化しません。既存原本の dedup は補正の成功ではありません。原本、参照 mask、canonical 作業コピーと互換な補正の確定を別々に照合し、全工程が確認できるまで `completed` を返しません。既存補正への自動上書き、未知設定の欠落、RAW baseVersion の無断変換は禁止です。実 API の無い現状ではこれらの HTTP 呼出しや成功結果を生成する transport は提供していません。

`src-tauri/src/cloud_copy_source.rs` は、今後の native staging 転送で用いる原本の読取境界です。開いた photo ID からのみ捕捉し、サイズ上限、SHA-256、device/inode/mtime/ctime、同じ開いた file handle を開始・転送・再確認で照合します。symlink・置換・変更・取消・書込失敗は成功にせず、原本を変更・削除しません。実サーバーは別途、受信した全 bytes の hash を照合して immutable 原本を確定する必要があります。この helper のテストは native 転送・認可・署名済み Mac/iPhone の実機受入の完了証跡ではありません。
