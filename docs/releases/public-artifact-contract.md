# 公開検証成果物と固定SHA取り込み契約 v1

Issue #2。公開リポジトリ `niho-life/niho-photo` の完全なcommit SHAを、検証用Mac app、SBOM、lockfile、toolchain、認証・共有contractへ結び付ける。公開mergeによって本番への署名・公証・配布・更新公開は始まらない。非公開側の取り込み実装は別の作業とする。移管前に公開済みの成果物は、manifestに記録された `niho-coliving/niho-photo` を履歴上のsource repositoryとして引き続き検証する。

この文書のmain push artifactはvalidation-onlyの旧経路である。Issue #113の手動Mac candidate prereleaseは、公開済みSDKの
manifest/receipt/release metadata、完全native closure、candidate manifest、Actions artifact receipt/provenanceを追加で固定する
別経路であり、この3-file artifactを公式candidateへ昇格・流用しない。どちらもprivate `camera-v` releaseやupdater feedを変更しない。

## 成果物と識別子

`Public CI` のmain pushは、文書だけの変更でもcameraを検証する。cameraの既存native検証後に、GitHub-hosted `macos-26` runnerでrelease modeのad-hoc署名 `.app` を作る。PRやfork側のmain pushでは成果物を生成・uploadしない。公開CIの権限は `contents: read` だけで、Apple署名、updater署名、認証、配備のsecretやOIDCを要求しない。ビルド環境は必要な公開値だけをallowlistし、Rustは1.98.1、Nodeは24.15.0、npm/Tauriはlockfileと記録された実行版へ結び付ける。Xcodeの実行版も記録する。

GitHub Actions artifact名は `niho-photo-<40桁commit>-macos-<arm64|x64>-run-<run ID>-attempt-<attempt>`。同じcommitのrerunも別名になり、immutable upload名が衝突しない。中の3ファイルは安定したbasename `niho-photo-<40桁commit>-macos-<arm64|x64>` を使う。

| ファイル | 内容 |
| --- | --- |
| `<payload basename>.zip` | ad-hoc署名を検査した `NIHO photo.app`。resource fork、extended attribute、ACLは転記しない |
| `<payload basename>.cdx.json` | CycloneDX 1.6のlockfile依存inventory |
| `<payload basename>.manifest.json` | [manifest-v1.schema.json](manifest-v1.schema.json) に一致するhash manifest |

同じcommitを再実行しても、run ID・attempt・GitHub artifact IDが異なり、バイナリのbyte単位一致は保証しない。各runのimmutable artifactを別物として扱い、取り込み側は **repository + commit + platform + run ID + attempt + artifact ID + artifact digest** の組を固定する。名前だけで過去の成果物を上書きしたり、SHAの短縮・branch・tag・latestで代用したりしない。manifest内のSHA-256は同じbytesから再計算できるが、署名されたprovenance/attestationではない。公開runner・workflow・dependencyを信頼できることまでhashだけで証明したとは扱わない。

GitHub Actionsへの認証済みupload/downloadとartifact ID・digestが輸送経路の照合点になる。upload stepの `artifact-id` / `artifact-digest` 出力を検査し、workflow job summaryへrun識別子と共に記録する。upload actionのdigestは64桁hexで、REST artifact metadataは同じSHA-256に `sha256:` を付けて返すため、非公開側で形式を正規化して照合する。job summaryは追跡用receiptであり、非公開側はsummaryを信頼根拠にせず、GitHub REST artifact metadataをAPIから取得してartifact ID・digest・repository・run・commit・attemptを照合し、監査記録へ保存する。manifestは外側のActions archive自身のdigestを自己参照しない。保存は30日で、長期保管と採用済み記録は非公開取り込み側の責務となる。

## manifestの検査

`npm run release:evidence` は公開main pushのGitHub context、正確な `GITHUB_SHA == HEAD`、clean checkout、全lockfile集合を検査し、次を記録する。ローカルで署名済みappを誤って公開成果物にする入口としては使えない。

- 40桁commit SHAと、そのcommitに対する `git rev-parse <commit>^{tree}`。
- `package-lock.json` と、camera / cameraのWebView分離probe（`apps/camera/tools/webview-isolation-probe`。研究用の道具） / desktop-account / desktop-photo / develop-engineの5つの `Cargo.lock` のSHA-256。lockfileの追加は収録範囲（`scripts/ci/release-evidence-lib.mjs` の `lockfiles`）の明示更新が必要。PRの `node --test scripts/ci/*.test.mjs` が、repoに入っている全lockfileと収録範囲の一致を検査する。
- Node、npm、rustc、cargo、Xcode、Tauri CLIの実行版。
- app archiveとSBOMのbasename・SHA-256・byte数、ad-hoc署名、release mode、updater/公式更新無効、検査したappファイル数。
- `niho.native-account` v2、cloud contract v1 / `@niho/cloud-contract` 1.0.0、対応JSONとpackage定義のSHA-256。`docs/security/cloud-contract-source.json` のSHA-256と、そこに固定された公開Docs source commit。
- GitHub workflow run IDとattempt。

schemaと生成器は `scripts/ci/release-evidence.test.mjs` で検査する。未知field、短縮SHA、欠けたlock・contract、版ずれ、hash形式違反、成果物名の不一致を拒否する。manifestとSBOMのJSONへapp・ソース・ビルドログの実パスや環境変数を複写しない。

## SBOMの範囲

生成器はネットワーク・credential・追加packageを使わず、commit済みnpm lock v3とCargo lock v3/v4からCycloneDX 1.6を生成する。全npm workspaceとlockエントリ、全4 Cargo lockのpackageをpurlで重複排除し、安定した順で記録する。Cargo registry packageにはlock内のSHA-256 checksumも残す。npm依存は公開npm registry、Cargo依存はcrates.ioだけを許可する。

これはdevelopment、optional、対象外platformを含む**lockfile inventory**であり、配布binaryへ実際にlinkされた依存graphや到達性の証明ではない。ロックされないOS framework・Xcode SDK・ビルド済み公開WASMに含まれる依存の推定はしない。OS/SDKはtoolchain記録、公開WASMはcommit/treeと既存engine manifestのhash検査へ結び付ける。採用側はこの範囲を理解したうえでlicense・脆弱性判断を行う。SBOMは権利許諾書や脆弱性がないという証明ではない。

## 公開境界のguard

app内の全通常ファイルをbinaryも含めて検査し、symlink・特殊ファイル、source mapと埋込sourceMappingURL、debug symbol、token保存ファイル、秘密鍵・credential形式、内部endpoint、絶対workspace/home path、ログを拒否する。Rust releaseのdebug情報を除き、workspace・toolchain・一時build prefixをremapする。buildは一時的な空HOME/CARGO_HOMEと無効化したnpm user/global configで行い、利用者の `~/.npmrc` や `~/.cargo/config.toml` を読まない。公開manifest/SBOMも同じ検出値非表示のguardを通す。archive作成前に `codesign --verify --deep --strict` とad-hoc署名であることを確認する。出力先は空でなければ停止し、uploadはその専用directoryだけに限定する。build中の追跡ファイル変化も失敗とする。

このguardは既知の危険な形式を検出するもので、任意の符号化・未知の秘密を完全に検出する保証ではない。既存のpublication gate、全履歴secret scan、依存review、PR reviewも同時に必要となる。検出時は値や子プロセス出力を公開ログへ転載せず、修正後に新しいcommitで再検証する。署名済み/本番app、source map、デバッグログ、実ユーザーの写真・tokenをartifactに追加しない。

## 非公開側が要求する入力と返す記録

取り込み側は次の手順を独立した権限境界で実装する。公開PRや公開workflowから非公開runner・鍵・tokenへ接続させない。

1. 入力に上記のimmutable識別子の組、期待するmanifest/SBOM/archiveのSHA-256、承認済みcontract版とDocs source SHA、採用理由・承認者を与える。GitHub workflowはこのrepositoryの `Public CI` / main pushで、対象SHAの必須checkが成功したことをAPIで確認する。外部forkや同名workflowの成果物は採用しない。
2. 認証済みGitHub APIで指定artifact IDだけをdownloadし、repository・run・commit・attempt・platform・期限切れでないことと、保存済みartifact digestを照合する。追加ファイル、path traversal、symlinkを拒否して隔離先へ展開する。ブラウザの可変download URLや名前検索による最新候補へのfallbackは禁止。
3. manifest schemaを検証し、保存した3ファイルのhash/size、manifestのcommit、run/attempt、platformを入力と照合する。public commitをfull SHAでdetach checkoutし、tree hash、全lockfile、contractファイルのhash、Docs source SHAを再計算する。SBOMを同じ生成器で再生成しbyte/hashを照合する。checkoutへprivate configや鍵を投入する前にこれらを完了する。
4. 公開appは検証用であるため、本番配布物として流用しない。採用された公開commitを入力に、隔離したprivate側で必要なproduction構成・署名・公証・本番受入を行う。backend認可や契約互換性の合格もprivate側が判断する。
5. 出力に採用/却下の結果、入力一式、再計算hash、public/private source SHA、private build ID、contract互換性・受入結果、署名/公証結果、本番成果物hashと配布IDを保存する。公開へ返すのは秘密や内部pathを除いた互換性の結果だけ。採用したこと自体は自動配布を意味しない。

## rollback

採用ごとに、前回成功した公開full SHA・tree・lockfile/contract hash・Docs source SHA、Actions run/artifact ID/digest、private source SHA・署名済み成果物hash・配布IDの組を保持する。rollback入力はその保存済み組を選び、既に検証したprivate成果物へ戻すか、同じ公開/private SHAとtoolchainで隔離再ビルドして改めて受入する。期限切れpublic artifactを取得できなければ、private保管済みの照合可能なbytes/記録を使うか停止する。branch、tag、latest、最新のcontract、現在のmainへ自動fallbackしない。更新channelの切り替えとbackend互換性はprivate側の手順に従う。
