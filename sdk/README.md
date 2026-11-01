# NIHO photo SDK release set

`sdk/release-set.json` は、NIHOapp が同じ版として固定する写真編集 SDK の構成です。次の 6 package を 1 個の release manifest に束ねます。

- `niho-photo-editing`: PhotoLibrary 境界、editor、develop-engine client と Web Worker の TypeScript source
- `niho-photo-ui`: SDK 専用名にした editor の UI dependency。React / React DOM は peer dependency のままで、consumer と同じ実体を使う
- `niho-photo-cloud-contract`: 既存の cloud sharing export が参照する純粋 TypeScript contract
- `niho-photo-contract`: recipe の読取・編集可否・作業コピー接続・signed RAW 判定・neutral 生成を提供する Node ESM JavaScript と `.d.ts`
- `niho-photo-develop-engine-source`: 同一 commit の Rust workspace source と、wasm build に必要な埋め込みデータ
- `niho-photo-develop-engine-runtime`: `manifest-<crate version>.json` が SHA-256 で固定する wasm-bindgen glue、wasm、型定義

workspace 内の package 名と import は変更しません。pack 用の一時領域でだけ `niho-ui` を `niho-photo-ui` に置き換えます。editor の `appDialog` と host が別 package instance にならないよう、consumer は `niho-photo-editing/sdk-dialog-host` の `PhotoEditingDialogHost` を描画します。この export は editor と同じ `niho-photo-ui` から host を再 export します。既存 app の `niho-ui/components/app-dialog-host` を代用してはいけません。`packages/photo-editing` は引き続き PhotoLibrary だけを host 境界にし、Next/API/Tauri や account client を SDK に含めません。

### host と SDK の「戻る」操作

SDK と host の UI はそれぞれの dialog request store を保持します。一方、同じ画面の Dialog / Popover / Sheet の開いた順は、browser の `window[Symbol.for("niho.ui.dismiss-layers.v1")]` にある `{ version: 1, layers: Array<{ id: symbol, close: () => void }> }` で共有します。host の `registerDismissLayer` / `dismissTopLayer` もこの v1 契約に接続してください。Android の hardware back は `dismissTopLayer()` を呼び、最も新しい面の close callback だけを実行します。面の解除は登録時に返した関数で行います。

registry は同じ window 内に限り、SDK の別 copy や HMR の再 import でも保持します。iframe / 別 window / SSR の request 間には共有しません。SSR での登録は何も保持せず、dismiss は false を返します。一般 UI 全体の alias や SDK の dialog store の置換は不要です。

recipe contract は `packages/photo-editing/src/develop-engine/develop-settings.ts` とその純粋 TypeScript dependency closure を正本にします。pack は選択した Git object からこの closure を取り出し、相対 import に `.js` を付けた Node ESM JavaScript と `.d.ts` を生成します。`niho-photo-contract` は TypeScript loader、React、DOM を必要とせず、`readDevelopSettings`、`isEditableDevelopSettings`、`developSettingsOnWorkingCopy`、signed RAW 判定と engine/look の世代情報を提供します。validator や既定値のロジックは別実装へ転記しません。

## 書込前のfield/feature能力判定（SDK 0.1.7）

`supportsDevelopSettingsWrite(value, { geometry?: boolean })` をNode contractとclientのdevelop-settings exportへ追加します。readerと従来の`isEditableDevelopSettings`は未知JSONを保持する既存の挙動を維持します。新しい判定は、未知のroot/nested field、未来のversion/engine、未解釈のlegacySettingsを含む設定をfalseにし、保存済みJSONを削除・正規化せずread-onlyとして扱えるようにします。

これはfield/featureを知っているかの判定です。trueでも数値・範囲の妥当性や描画可能性のすべてを保証しません。cloud writerは固定WASMの値検証、working-copy/base/meta互換性、mask surface所有権、本人認可、CASを独立して通す必要があります。既存readerや描画の数式・画素、crate/runtimeの版は変更しません。

## 生成

公開用 pack は clean な Git commit からだけ作ります。source は working tree からコピーせず `git ls-tree` / `git show` で読みます。

```sh
npm run sdk:pack -- --output sdk-dist/0.1.0
```

既定の runtime asset 入力は `packages/develop-engine/public/develop-engine/niho-13/` です。`manifest-0.25.0.json`、その manifest に列挙された `.js`、`.wasm`、`.d.ts` が揃い、bytes と SHA-256 が一致しない限り pack は失敗します。manifest の `source.commit` / `source.tree` は pack 対象の Git object と一致し、固定 Rust `1.98.1`、`wasm-bindgen 0.2.129`、release profile の provenance を持つ必要があります。同じ engine/version 名の任意ファイルを渡すだけでは release-ready になりません。source package だけを release-ready として扱う経路もありません。

runtime は固定 toolchain と `wasm-bindgen` が用意された CI で次の helper を実行して作ります。helper は toolchain を install しません。空の Cargo cache から `Cargo.lock` に固定された依存を取得するため、build 時には network access が必要です。

```sh
npm run sdk:build-engine-runtime -- --output packages/develop-engine/public/develop-engine/niho-13
```

builder は空の一時 `CARGO_HOME` と `CARGO_TARGET_DIR` を使い、外部の Cargo config、credentials、`RUSTFLAGS` を継承しません。source、build user、Cargo registry、Rust toolchain、一時領域は公開成果物へ絶対 path が残らないよう remap します。出力先は既存なら拒否します。

生成された `niho-photo-sdk-<version>-<full SHA>.json` に package 名、tarball の SHA-256/SRI、engine/recipe contract と build input の SHA-256、runtime file の SHA-256/SRI を記録します。`sourceOwnership` は `photo-editing`、UI、cloud contract、develop engine、desktop photo、SDK 定義・生成器とimportする検査moduleのclosure、同梱 notice の内容digestを個別に持ちます。root `package.json` / `package-lock.json` は再現用の `buildTooling` pin として別に記録します。この分離により、Mac app のみの変更は SDK commit と同じ SHA でなくても、共有sourceのdigestが公開済みSDKと一致することを照合できます。

repo 外 consumer の確認は次で行います。

```sh
npm run sdk:smoke -- --manifest sdk-dist/0.1.0/niho-photo-sdk-0.1.0-<full SHA>.json
```

CIで実WASMを生成した場合は、同じmanifestを使って次も実行します。この検査はWASM glueをNodeで`initSync`し、engine/crate版を照合したうえで、`niho-photo-contract`の`neutralDevelopSettings(null)`を実engineの`validateSettings`へ渡します。空WASMのunit fixtureでは実行しません。

```sh
npm run sdk:smoke-real-engine -- --manifest sdk-dist/0.1.0/niho-photo-sdk-0.1.0-<full SHA>.json
```

smoke は tarball を一時ディレクトリへ offline install し、代表 editor export、PhotoLibrary、develop-engine client、Web Worker、UI CSS を TypeScript と Vite で bundle します。

## GitHub Release

Public CIのrequired `Photo SDK real build` jobは、SDK所有source・生成器・root build lockが変わるpull requestで実WASM build、pack、repo外consumer smokeまでをread-onlyで行います。appだけの変更ではこのjobを選択しません。

`Photo SDK release` workflow は手動実行だけを受け付けます。`main`から起動し、`source_sha`には`origin/main`の祖先であるfull commit SHAを渡します。

build jobの成果物はartifact ID、digest、run ID、attempt、source SHA、release manifest SHAでpublish jobへ渡します。publish jobはmainにあるzero-dependency verifierだけを実行し、downloadしたartifact内のscriptや`npm install`を実行しません。検証後に新規`photo-sdk-v<version>` tagとGitHub Releaseを作り、manifest、全tarball、輸送receiptをassetとして載せます。既存tag/releaseは上書きせず、`latest`は変更しません。SemVer prerelease版はGitHub Releaseでもprereleaseにし、consumerは常に明示した`photo-sdk-v<version>` tagを取得します。

tag確保後に公開処理が失敗した場合も、確保済みversionは再利用しません。原因を修正して新しいversionを発行し、既存tagやassetの置換は行いません。

## Mac native build closure

SDK `0.1.1` 以降の `niho-photo-develop-engine-source` は、repo 外へ展開した
`package/engine/` だけから Apple Silicon 用 native tool を作れる closure を含みます。
対象は `apple-raw-linear`、`niho-develop-render`、`niho-camera-cutout`、全 calibration registry と
それらが参照する JSON、Adobe DNG SDK notice です。段2 renderer は
`niho-develop` / `image` の依存経路だけを build し、診断用 rawler binary は app に同梱しません。

```sh
node package/engine/build-macos-native.mjs \
  --engine package/engine \
  --lock /path/to/apps/camera/develop-sidecars.lock.json \
  --output /new/path/native-stage
```

helper は Rust `1.98.1`、`aarch64-apple-darwin`、`--release --locked` を固定します。
外部の `CARGO_HOME`、Cargo credentials/config、`RUSTFLAGS`、signing環境は継承せず、隔離した
HOME/Cargo/target/tempとpath remapを使います。生成した3 binaryは実際に `version` を起動し、
`otool -L` が `/usr/lib` / `/System` 以外を参照しないこと、両registryを
`apple-raw-linear registry` で読めること、calibration hashがcamera lockと一致することを検査します。
このhelperを実行するのは信頼されたcandidate buildだけです。署名工程はSDK内scriptを実行しません。

SDK publisherは検証済みmanifestにGitHub artifact attestationを付け、workflow path・main ref・tooling SHA・run/attemptを署名付きcertificateへ結び付けます。後段はmanifestの自己申告run IDだけを信用せず、Sigstore bundleをGitHub CLIで検証します。既存updater秘密鍵は公開側へ渡しません。
