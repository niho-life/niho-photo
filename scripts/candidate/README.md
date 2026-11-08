# NIHO photo Mac candidate 契約

このdirectoryのhelperは、完全な未公証・ad-hoc署名済みMac candidateを信頼buildで生成し、
後続のowner-local signerへ固定hashを持つdataとして渡します。build・data検証helperはnetworkを使わず、
公開済みSDKの取得は `prepare-published-sdk.mjs`、candidateのpublishは後述のworkflowが担当します。
実際のSwift/Rust/Tauri buildはApple Silicon CIで実行します。

## 入力

- clean Gitのcurrent HEADであるapp sourceのfull SHA。working tree、ancestor指定、短縮SHAは使いません。
- 既に外部から取得済みのSDK directory。通常の公式candidateは `published` とし、release manifestの
  輸送SHA-256を必須にします。PR検証だけは `local-validation` を使えますが、SDK source SHAとapp source SHAが
  同一でなければ失敗します。2 modeはcandidate manifestでも区別されます。
- release version、公開Firebase build config JSON、run ID、attempt。config JSONは
  `NIHO_PHOTO_PUBLIC_FIREBASE_WEB_API_KEY` だけを持ち、未設定や形式不正なら公式candidateを作りません。
  値はmanifestやログへ書かずSHA-256だけを記録します。
- overlay前にCIが用意したroot `node_modules` directory。その親にあるroot/workspace manifestとroot lockがapp sourceに一致することを検査し、workspace固有のnested `node_modules`も一時buildへcopyします。npm workspace/.binの相対linkを保ち、build先のsourceへ解決します。helper自身は `npm install` やdownloadをしません。

```sh
npm run candidate:build -- \
  --sdk-directory /input/photo-sdk-0.1.1 \
  --sdk-mode published \
  --sdk-manifest-sha256 <64hex> \
  --app-source <40hex> \
  --version 1.2.3 \
  --public-firebase-config /input/public-build-config.json \
  --node-modules /prepared/node_modules \
  --output /new/output-directory \
  --run-id 123456 --run-attempt 1
```

SDK全6 tarball、manifest、package hash、source ownershipを先に検証します。app sourceがSDK sourceと別SHAでも、
`sourceOwnership` の全path/digest/file countが一致すればapp-only変更として受け付けます。その後だけGit treeから
一時workspaceを作り、SDK runtimeとnative source closureを配置します。version overlayは次の4 fileだけです。

- `apps/camera/package.json`
- `apps/camera/src-tauri/tauri.conf.json`
- `apps/camera/src-tauri/Cargo.toml`
- `apps/camera/src-tauri/Cargo.lock` の `niho_camera` package

root npm lockはversion合わせのために変更しません。Tauriはrelease、`--locked`、`--bundles app`、
`official-updates` feature、ad-hoc署名でbuildします。Tauri updaterはversionも署名対象に含めて照合します。
固定bundle ID `life.niho.camera`、product `NIHO photo`、
deep link `niho-camera`、updater feedとpublic key、`camera_app_info` が使うnative crate versionをoverlay結果で固定します。

## 生成後の検査

builderは配る `.app` そのものについて、Info.plist identity/version/deep link、3 native toolの版、
system dylibだけの依存、calibration全hashとregistry、SDK wasm manifest/file hashと埋込みURL、updater key/feed、
`codesign --verify --deep --strict` を検査します。secret scannerは指定した公開Firebase値との完全一致だけを例外にし、
別の `AIza...`、token、private key、private path、source mapの検出は維持します。

rootの4 notice、engineのLICENSESとAdobe DNG SDK license、Nunito OFLは
`Contents/Resources/third-party-notices/` に元のbytesで同梱します。7 fileのhashを実bundleで照合し、
candidate manifestとapp file inventoryの両方で欠落・変更を拒否します。

出力は安全な同じstemを持つ次の4 fileだけです。

- `*.dmg`
- Tauri-compatible app-root `*.app.tar.gz`（rootは `NIHO photo.app`）
- CycloneDX `*.cdx.json`
- `*.candidate.json`

candidate manifestはapp/source tree、run/attempt、SDK mode/version/source/全asset hash、ownership、version overlayの
before/after hash、公開account config hash、toolchain、native/calibration/wasm/app file hash、SBOM proof、最終assetの
SHA-256/sizeを記録します。公開Firebaseのraw値、signing key、credentialは記録しません。

完成tarはPython標準ライブラリで展開・実行せず、全file hash/size/実行属性を検証済みapp inventoryへ照合します。
builderは完成DMGもreadonly/no-auto-openでmountし、同じinventoryへ照合してからdetachします。画像の検証前後で
外側hashも固定し、梱包後の差し替えや改変を拒否します。DMG直下はappと固定Applications linkの2件だけを許可し、
隠しmetadataを含む追加payloadも拒否します。候補のprogram/scriptは起動しません。

## Mac Studioでのローカル署名・Release公開

`Photo Mac candidate release` は未署名のcandidateをprereleaseへ保存し、manifestをGitHub ActionsのSigstore identityでattestします。
正式配布は、ownerがMac Studioのcleanな最新 `main` checkoutで次のローカル手順を実行します。
最初に同じcheckoutでlockfile固定のTauri CLIを用意します。install scriptは実行しません。

```sh
npm ci --ignore-scripts --no-audit --no-fund
export NIHO_PHOTO_UPDATER_KEY_FILE="<既存Photo updater秘密鍵のローカルpath>"
npm run photo:release:prepare -- \
  --candidate-tag photo-candidate-v1.2.3-<source SHA先頭12桁> \
  --signing-key-path "$NIHO_PHOTO_UPDATER_KEY_FILE" \
  --output-dir /tmp/niho-photo-release-v1.2.3
```

helperはcurrent mainに含まれる固定workflowのattestation、run、source SHA、SDK proof、candidate manifestと全asset hashを照合します。
取得したcandidateのprogram・script・verifierは実行せず、tar/DMGも展開せずにdataとして検査します。署名対象のtarはmanifestに
hash固定された同じbytesです。秘密鍵の内容を引数・env・ログへ出さず、ローカルkey fileから直接Tauri署名します。

署名後は、元のDMG/app tar/SBOM/manifest、SDK proof、輸送receipt/provenance、`.sig` とTauri static updater用 `latest.json` を
新規output directoryへ作ります。helperはGitHubへ書き込まず、`publish-draft-instructions.txt` を出力します。assetとnotesを確認後、
instructionsに沿ってGitHub Releaseのdraftを作り、draft内の全assetを読み返してから `--draft=false --latest` で公開します。
一度確保したtag/versionは再利用しません。途中で失敗した版は捨て、より大きいapp versionで作り直します。
公開後は `npm run photo:release:verify -- --release-tag photo-app-v1.2.3 --prepared-dir /tmp/niho-photo-release-v1.2.3` を実行し、GitHub上のlatest Release・全asset hash・配信中の `latest.json` をprepared bytesへread-back照合します。

通常のapp Releaseは `photo-app-v<version>` とし、Photo updaterの `latest.json` URLに解決されるようrepositoryの最新Releaseにします。
SDK/Web/renderer/candidate Releaseは引き続き `--latest=false` のままです。GitHub Releaseのimmutable settingを有効にしてから
最初のapp Releaseを公開します。署名鍵はownerのMac Studio内に留め、公開repo・GitHub Actions・配布assetへ含めません。

このsource版を含むapp releaseを一度は手動でインストールしてください。旧インストール済みappは従来の `niho.life` feedを記録しているので、
新feedを埋め込んだappへ切り替える最初の一回はDMGから行います。それ以後はPhoto自身のGitHub Releaseから更新します。

## CIとprerelease

`Public CI` の `Photo Mac candidate proof` はcandidate関連変更だけでmacOS 26 ARM64を使い、current full SHAから
実WASM、local-validation SDK、native sidecar、Tauri appを順にbuildします。公開用の形式を持つ固定dummy Firebase Web
configを使う検証であり、本番loginの認証成功、公式release、署名・公証の証明ではありません。PR proofのbytesは保存・公開しません。

公式candidateはmain上の `Photo Mac candidate release` を手動実行し、次を入力します。

- `app_source_sha`: origin/mainの祖先である40桁SHA
- `sdk_version`: 既存のimmutable `photo-sdk-v<strict semver>`
- `app_version`: prerelease/build metadataを持たない新しい `x.y.z`
- `sdk_manifest_sha256`: 公開済みSDK manifest bytesの64桁SHA-256

read-only macOS builderは公開SDK releaseのtag/target、全6 tarball、manifest、元のartifact receiptを検証してcandidateと
SDK proofを同runの専用artifactへ保存します。Ubuntu publisherはdispatch時mainのverifierだけを実行し、artifact内codeや
appを起動せず、`photo-candidate-v<app version>-<app SHA先頭12桁>` の新規tagと `--latest=false` prereleaseを作ります。
candidate経路は署名済み正式Releaseとは分離されています。candidate build/publish自体ではupdater feedを変更しません。

tagはCASで先に確保し、release作成途中で失敗しても削除・再利用しません。その版は消費済みとして、rollbackまたは再実行は
**より高い新しいapp version**を指定します。前のsourceへ戻す場合も、保存済みの前source SHAと承認済みSDK hashを入力し、
高い新versionで新しいcandidateを作ります。既存tag/assetsの上書きやclobberは行いません。

公式publisherは検証済みcandidate manifestを `actions/attest` でattestします。SDK manifestにもSDK専用workflowのattestationがあり、
Studio側は実digest・公式workflow・main ref・tooling SHA・certificate内run/attemptを暗号学的に照合します。公開のSigstore署名用短命identityを使い、
private updater秘密鍵や新しいPATは不要です。
