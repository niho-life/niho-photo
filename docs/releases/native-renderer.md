# Native renderer成果物の契約

Issue #236 のnative専用releaseは、既存Photo SDK releaseと同じ公開source commitから `niho-develop-render` だけをGitHub-hosted runnerで一度buildし、source固定の再利用可能な成果物にする。SDKのversion、schema、source ownership、既存release assetは変更しない。

## 公開境界

`.github/workflows/photo-renderer-release.yml` は `main` の手動実行だけを受け付け、入力は公開repositoryの `main` に含まれるfull 40桁 `source_sha` だけとする。運用helperはdispatchされた `main` のcheckoutから実行し、build対象のRust sourceだけを `source_sha` の別checkoutから読む。LinuxはRust 1.98.1 Bookwormのlinux/amd64 image digest、macOSはmacOS 26 arm64とRust 1.98.1に固定する。

build対象は公開済みRust crate `niho-develop-render` だけである。Swift、Apple RAW、cutout、校正処理、署名・公証、本番配布は含めない。build jobだけが合成PNGを入力したCLI smokeを実行する。publisherはartifactをdataとして検査し、tar内のbinaryやscriptを実行しない。

publisherはtrusted `main` のPython helperから、固定repositoryのGitHub REST artifact endpointをexact positive IDで呼び出す。REST metadataのID、name、digest、期限、workflow run ID、builder source commit、`main` branchをbuild jobの出力と照合し、raw ZIPをsize制限付きで取得する。展開前にZIP全体の実SHA-256をartifact digestとfail-closedで比較し、`renderer-build-<target>.json` とsource・target固定tgzのexact 2通常fileだけを新規directoryへdataとして書き出す。重複、未知entry、絶対path、traversal、backslash、directory、link、special file、暗号化、oversized、truncated、compression bombは拒否し、その後もtgzとmanifestの既存検査を省略しない。取得時のtokenはこの固定API helperのstepだけに渡し、候補binaryや候補codeは実行しない。

targetごとの決定的なtgzには次の通常fileだけを含める。

- `package/bin/niho-develop-render`
- `package/renderer.json`
- 公開source由来のlicenseとnotice

`renderer.json` はsource commit、engine tree、engine version、target、Rust toolchain、build recipeとbinaryのSHA-256・bytesを固定する。release manifestは両targetのtgzとbinary、builderのmain commit、workflow identity、run ID/attempt、入力artifact ID/digestを結ぶ。path traversal、link、device、重複、未知entry、oversized entryは拒否する。

## 初回公開

初回は既存SDK releaseの公開source `86ca0749c6b738e7f6b59dcff5ebe2f5cafa2804` を `source_sha` に指定する。release tagは `photo-renderer-<full-source-sha>` で、同じtagまたはreleaseが存在する場合は再実行で上書きせず失敗させる。release assetはmanifestとLinux/macOSのexact 2 tgzだけであり、manifestには公式workflow attestationを付ける。

## Consumer採用

consumerは採用前に次をすべて確認する。

1. GitHubの公式attestationが期待するrepository、workflow、`refs/heads/main` のmanifestをsubjectにしていること。
2. manifestの `sourceCommit` が利用するSDKの公開source pinと完全一致し、targetが実行環境のexact tripleと一致すること。
3. manifestに記録されたtgzとbinaryのSHA-256・bytes、engine tree、Rust toolchain、build recipeを照合すること。
4. キャッシュから再利用するときもmanifestとtgzを再検証し、source pin・target・digestのどれかが異なれば利用を拒否すること。

既存のPhoto SDK releaseへnative assetを追加したり、同名assetを置き換えたりしない。別sourceが必要なら、そのfull SHAに対応する新しいnative専用releaseを作る。
