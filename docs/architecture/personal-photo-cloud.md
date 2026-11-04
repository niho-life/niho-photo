# NIHO photo 個人クラウドの接続契約

Epic [#192](https://github.com/niho-life/niho-photo/issues/192)、C00 [#193](https://github.com/niho-life/niho-photo/issues/193)。2026-11-03に製品境界を再確定した。型・合成fixture・負例・operation対応の正本は [`packages/photo-library-contract`](../../packages/photo-library-contract/)。契約確定は本番接続・配備・実機受入・正式配布の完了ではない。

## 製品・正本・配置

- NIHO photoは独立した写真編集製品。Macのログイン不要・無料のローカル編集と書き出しを維持し、利用者が選んだ写真だけを明示操作でコピーする。Macの原本・補正を移動/削除せず、自動uploadしない。
- 同じNIHO本人のMacアプリ、Macブラウザ、iPhone Safari/PWAが同じ原本と補正を扱う。拠点所属・ホスト権限・PWA追加は利用条件にしない。
- 本人枠は **5 × 1024³ = 5,368,709,120 bytes**、表示5GB。端末・拠点ごとに増やさず、超過課金を追加しない。
- 原本・owner・予約/使用量・補正revision/競合・即時purgeは既存の非公開NIHO本人写真backendが正本。DTO/read modelはここから構成する。Editorのphoto-storeへ二重原本書込み・二重quota・別owner台帳を作らない。
- NIHO editorは文書製品。ページ画像はページ添付資産であり、Photoライブラリ・容量・補正と共有しない。旧Editor写真画面を受入面・配布先にしない。
- 削除は即時purge。ゴミ箱・復元・猶予期間を追加しない。他人の招待・公開リンク、自前サーバー/Tailscale保存先は対象外。

| 面 | 正式配置・接続責任 |
| --- | --- |
| Photo Web/Safari/PWA | **`https://photo.niho.life`**。ownerが2026-11-03に選択。Photo repoの独立host `apps/photo-web` と既存 `packages/photo-editing` |
| Web BFF・callback | 同hostのserver境界。Photo専用opaque cookie・登録client・exact callback。Editor cookie/Docs actorへfallbackしない |
| 配備所有 | ソースはPhoto repo。DNS/TLS・登録・公式配備・secret・rollbackは既存非公開運用側、C08が窓口。公開CIへ配備権限を渡さない |
| Mac | `apps/camera` の既存App/cloudBinding/native。public client **`niho-camera`** と [desktop-account契約](../contracts/native-account.md) を維持 |
| API・DB・storage/media | 既存の非公開本人写真backend。内部endpoint・object locator・認証secretを公開adapterへ埋め込まない |

Web登録clientは **`niho-photo-web`**、写真用途audienceは **`niho-photo`**。これはC01で実登録・検証を合わせる契約で、現行backendが受理済みという主張ではない。旧Editor client名の置換だけで旧sessionを誤受理しない。Photo専用attempt・親session・世代・固定origin/callbackを登録する。

state/PKCE S256・短期attempt・一回限りcode・POST callbackを再利用し、code/stateをURL/ログへ出さない。長期資格情報はBFFのSecure/HttpOnly/host専用cookieに閉じ、JS/localStorage/IndexedDB/SWへ渡さない。exact callbackは `/auth/callback`、開始/refresh/logoutもPhoto host内へ閉じる。POST relay、CSRF/origin照合を維持し、C01/C08でDNS/TLS・登録・callback非保存をreadbackするまで本番は閉じる。

canonical本人IDは検証済みNIHO userから導く。メール・拠点ID・JWTのローカルdecode・bodyのowner/libraryは認可根拠でない。未認証/失効401、存在しないIDと他人のIDは同じ404。cookie/bearerの曖昧な混用は拒否。MacのReactへ原本path/bytes/token/署名URLを運ばず、browserへTauri/Keychain/sidecarを持ち込まない。

## 再利用と移管

公開Editor source `9c57b4698e755e025ab4bb53361a42421557722c` から型・合成fixtureだけを監査して抽出した。元SHA-256は [provenance](../../packages/photo-library-contract/provenance.json) とpublication manifestに保存する。以後はPhoto側だけで保守し、旧Editorへ双方向同期しない。

旧v1とは製品・上限・削除・操作の意味が異なるため、新しいclient portは **`@niho/photo-personal-cloud-contract` v2**。新HTTP APIの宣言ではない。旧 `/api/photo/v1` route表をコピーせず、C02が既存本人backendへ写す。存在しないoperationをfakeで成功させず、同じ正本に不足read modelを追加する。共有リンク用 `packages/niho-cloud-contract` は独立したまま維持する。

| 旧資産 | 到達点・今回の扱い |
| --- | --- |
| Editor #149 / PR #163 | 契約・fixture完了。完全recipe/競合の形を抽出。Editor配置・旧上限・ゴミ箱は不採用 |
| Editor #151/#171 | Editor DB/store・owner/容量/CAS/lease試験完了。負例を再利用候補とし、別DBを写真正本へ戻さない |
| Editor #150 | POST認証consumerと合成試験あり。C01がPhoto専用client/cookie/callbackへ監査移管。実Photo認証は未受入 |
| Editor #152/#153 | transfer core/catalog資産あり。C02が既存本人APIに接続し、Editor storageへ二重保存しない |
| Editor #154/#156 | recipe/CAS/lifecycle資産あり。C03は本人backendの両snapshot・即時purgeを再利用 |
| Editor #155 | media orchestration/候補providerあり。C04で形式・固定engine・実providerを受入。合成decodeを実対応に数えない |
| Editor #157 / cloud SDK 0.1.2 | fixture adapter配布済み。C02がPhotoへ監査移管。旧trash/delete・HTTP配置・未実装addFile/maskのまま本番注入しない |
| Editor #158/#159 | 旧Web/PWA部品あり。C06でPhoto独立hostへ必要部分だけ移す |
| Editor #160 / Photo cloudBinding | UIと未来のnative portあり。C05でbootstrap/journal/転送を実接続。`main.tsx` の `<App />` は未配線 |
| Editor #161/#162 | 合成harness・SDK配布・ローカルMac配布履歴。C07/C08で実製品/実backend/実機を再受入 |
| 閉じたEditor PR #216 | 限定list/get/purge client、runtime未接続。C02のDTO/abort/本人照合の参考。PRは再開しない |
| Photo SDK 0.1.7 / niho-14 / crate 0.27.0 | 正式発行済み。共通UI/engineを再利用。利用者Macへの新cloud配布はC08で別確認 |

## operation対応

2026-11-03のsource監査で、**全operationはPhoto製品へ未接続・実環境未受入**。「実装済み」はbackend sourceの存在だけを示す。詳細・担当は [operation-coverage.json](../../packages/photo-library-contract/operation-coverage.json)。内部endpoint/bucket/非公開sourceは公開物へ載せない。

| operation | 既存backendとの対応・追加条件 | writer |
| --- | --- | --- |
| `library.get` | 不足。usage/予約/削除待ち/能力snapshotを正本から提供 | C02 |
| `photos.list` | 本人・保存時刻/ID keyset・最大60件あり。usage/revision/filter DTO不足 | C02 |
| `photos.get` | 原本・現補正あり。寸法/asset/media/base projection不足 | C02 |
| `photos.info` | 本人専用EXIF read model不足 | C02 |
| `photos.lookup` | start時同一owner/hash照合あり。bulk lookup不足 | C02 |
| `uploads.start` | owner lock・200MiB・5GiB・requestId・予約あり。mask転送/台帳不足 | C02/C03 |
| `uploads.get` | 結果不明のrequestId照合API不足 | C02 |
| `uploads.renew` | 期限/offset照合の再開API不足。再startで延長と見なさない | C02 |
| `uploads.complete` | generation・実size/SHA-256・CASあり。magic bytes/寸法/形式検証の受入不足 | C02/C04 |
| `uploads.cancel` | 未保存原本purgeを再利用候補とする。requestId/状態を照合し保存済み原本を消さない契約が必要 | C02 |
| `content.get` | 本人確認後の短命原本downloadあり。認証transport/Range/streamの対応が必要 | C02 |
| `masks.get` | owner/photo/hashに拘束した面の保存/取得不足 | C03 |
| `recipes.put` | revision CAS・冪等保存・両snapshotあり。完全recipe/base/mask検証と旧64KiB制限の整合不足 | C03 |
| `versions.get` / `versions.put` | owner指示で今回対象外。クラウドの能力をfalseに維持 | 対象外 |
| `recipe-conflicts.list` / `recipe-conflicts.get` / `recipe-conflicts.resolve` | 両snapshot・adopt/keep-current・CAS・再送あり。ID直接取得は履歴のpage数に依存せず本人/Photo/候補IDへ束縛。未知設定/mask/base projectionを接続 | C03 |
| `media.ensure` | 本人原本用renderer/job/asset/base projection不足。拠点workerと混同しない | C04 |
| `photos.delete` | 即時非表示・全generation purge・request fence・退会/再試行基盤あり。Photo接続/受入が必要 | C02/C05/C06 |

## 容量・転送・即時削除

`PHOTO_LIMITS` がclient上限の正本。backendは改変clientを前提に再検証する。

| 対象 | 契約 |
| --- | --- |
| 本人枠 | `usedBytes = originalBytes + maskBytes`、`availableBytes = quotaBytes - usedBytes - reservedBytes`、`0 <= used + reserved <= 5,368,709,120` |
| 原本/mask | 再生成できないbinaryを同じ本人枠に算入。mask台帳は現行backendで不足しC03で追加。別DBへ逃がさない |
| 予約/検証中 | `reservedBytes`に算入。original/maskを同じowner lockで原子的に予約。遅着workerがcommitできる間は回収しない |
| 物理削除待ち | `pendingPurgeBytes`はusedの内数。非表示だけで空きを戻さず、固定generation削除確認後に一度だけ解放 |
| 派生物/JSON | 再生成可能thumbnail/preview/working-copyはサービス側cache。bounded recipe/history JSONもbinary枠外。別上限/清掃が必要 |
| サイズ | 原本200MiB、mask8MiB/一辺4096px。画像100MP、browser直接decode40MPは最大境界であり形式対応の保証ではない |
| 予約期限 | 30分、既存complete猶予60分。猶予内completeと取消/回収をfenceし、先に枠を再利用しない。再開はserverのexpiresAt/現在状態を照合 |
| ページング | 最大60件、opaque cursor、保存時刻/ID順。owner/条件/版に拘束。不正/条件違いは再読込、他人の内容を返さない |

`content.get` は開始byte/終端byteの単一区間とReadableStream・全体size/hash・実区間metadataを返す。HTTP Range/Content-Range/statusの変換はtransport内へ閉じ、認可→区間/長さ検証→上限付きstream読取とAbortSignalを維持する。正規化のために原本全量をbufferしない。

start前に本人/epoch・requestId・原本identity/hash・payloadをdurable journalへ記録する。結果不明は同じidentityで照合し、別keyの新規登録で隠さない。ticket/URL/tokenをjournal/UI/logへ保存しない。原本→参照mask→recipeを別に確定し、全工程を照合したときだけコピー成功とする。同一hashがあっても既存補正を自動上書きしない。

削除要求時に非表示にして新規読書きを止め、physical purge失敗時は容量を保持して再試行する。`photos.delete` 成功 `{state: "purged"}` は物理削除と台帳確定後だけ。旧upload request・recipe・描画jobはlifecycle/generationで拒否し、古い成功結果から復活させない。取得済み端末コピーの遠隔消去は保証しない。既存退会/owner merge executorを二重実装しない。deleteも同じ公開portの冪等keyで再試行する。backendのowner/photo指定の自然冪等性と既存fenceを再利用し、keyのためだけに別DB台帳を新設しない。

## recipe・能力・状態

能力の交差計算はC02 adapterだけが所有する。C04はserver能力、C05/C06は実hostのrenderer能力を渡し、`PhotoCapabilityContext` の双方を確認するまで編集不可とする。hostごとに交差判定を複製しない。

実runtimeの能力はRust coreの `renderer_capabilities()` がschema 1として宣言する。既存 `capabilities()` の `masks` とnative CLIの既存rootを保ち、同じ `renderer` を追加する。WASM・native serve・native CLIで設定version/engine/feature/maskの別一覧を作らない。SDK名や `version()` の表示文字列から能力を推定しない。

browser hostは既存engineの `ready()` を確認してから `renderCapabilities?.()` を呼ぶ。getterは既存ready経路だけを読み、新しいWorkerやloaderを起動しない。未対応・不正なschema・実glueとの不一致・dispose中/終了・旧readyはnullとし、返値は変更できないsnapshotとする。nativeからWASMへのfallback開始時も旧宣言を失効させ、次のengineのreadyまでnullを返す。読込・再生成が失敗しても旧宣言は復活しない。schema 1の非空maskKindsはmasks featureと実効mask能力の両方を必要とする。renderer宣言が不正でも既存のローカル編集/mask能力は維持する。

C00の `hasEdits` は、Nodeの正式 `niho-photo-contract` で公開する既存 `isNeutralDevelopSettings` を使って判定する。単なるrevision番号や別実装の初期値比較で判定せず、未知fieldを落として未編集にしない。初期recipeも同じ契約の `neutralDevelopSettings` で作る。これらの追加と実runtime getterはSDK 0.1.9向けであり、既存0.1.8のtag/assetsを変更しない。正式公開とconsumer選択は別途実artifact/source/署名の一致を検証する。

hostは取得した `crateVersion` と正式に固定したbuild metadataのcrateを完全一致で照合し、そのmetadataの `sdkVersion` / `manifestSha256` と実runtimeの設定version/engine/feature/maskをC00 `RenderCapability`へ明示投影する。schemaVersionはruntimeの検証用でありC00へ足さない。固定metadataが無い・不一致ならcloud編集を閉じる。接続probeは本人scopeの取消を確認してdisposeし、受入した同じmanifestでWorkbenchを起動する。getterの追加だけで端末接続・正式SDK配布・実機受入を完了にしない。

完全recipe JSON・version・engine・baseVersion・参照mask hash・revisionを保持する。保存はexpectedRevision必須、冪等keyは本人/操作/写真に拘束。競合時は両snapshotを永続保持し、本人の明示adopt/keep-currentだけをCASで反映。クラウドの名前付き版と独立versions API・保存層・同期はowner指示（2026-11-04）で今回の実装・完了・出荷条件から除外する。既存Macのローカル版は維持する。

未知version/engine/field/maskを落として保存しない。serverと実host rendererの能力の積集合だけを書込可能にし、未知recipeは保持したままread-only/書込拒否。canonicalな作業コピーとbaseが合わないローカル補正を暗黙変換せず、全cloud端末は同じbaseを使う。

| 状態 | 表示・許可 |
| --- | --- |
| 未接続/能力未取得 | cloud無効、ローカル編集継続。合成fixtureを本番へ注入しない |
| 原本転送/検証中 | 未保存・進捗/取消/照合。二重クリックで新規開始しない |
| 原本stored・media pending/processing/failed | 永続化と描画の成否を別表示。previewだけで保存成功にしない |
| 未対応形式/recipe/base | 理由を表示し編集/保存を拒否。許可された原本取得は別操作 |
| offline draft | 本人/library/photo/baseRevision/epochで隔離し未同期を表示。復帰時にCAS照合。iOS背景転送完了を保証しない |
| session切替/失効 | epoch更新、fetch/reader/worker abort、QueryClient/object URL/bytes/旧draftを破棄。遅着結果を次の本人へ適用しない |

epochはサーバーの検証済み親session/AppConnectionとその失効世代から導く。通常のcredential refresh/graceでは論理scopeを維持し、独立した端末sessionを一括で失効させない。logout・再接続・本人切替・失効では旧scopeを無効化する。BFF/nativeは捕捉scopeを毎要求のverified actorと照合し、対応するcredentialだけをbackendへforwardする。body/queryのepochを信用しない。backendはmutation commit前にも親session/世代/失効を再検証する。同じactorIdでもepochが異なれば別session。未保存guardで失効credentialを復活させない。下書き保持の選択と認証を切り分ける。

| 形式 | C04/C07の実受入 |
| --- | --- |
| JPEG/PNG | SDK/providerを再利用。magic bytes/向き/色/pixel上限/hashを実証 |
| HEIC/HEIF | server decoder/helperとcanonical作業コピーが必要。Safari表示だけで編集対応にしない |
| RAW | 実decoderの機種/形式・固定engine/baseごとに受入。拡張子一覧だけで対応を宣言しない |
| TIFF/その他 | 能力未確認は拒否。別形式への黙った変換をしない |

errorはclient portの `PHOTO_ERROR_STATUS` へ正規化する。backendのstatus/codeと同一とは限らない（現行quota超過はHTTP 413）。401は再認証、404/410は現状態照合、409はpayload/key/revision確認と本人選択、429/503はRetry-After/上限付きbackoffで同じkeyをretry。取消/epoch変更後はretryしない。内部error/URL/tokenを表示・記録しない。

## 2セッションのwriterと依存

owner指定のA/B分担。共有sourceを2セッションで編集せず、変更要求をwriterへ戻す。契約の窓口はA。shared export/依存lock/publication manifest/CSP/releaseもA/C08が集約する。

| Issue / 担当 | 専有パス・責務 | 完了依存 |
| --- | --- | --- |
| #193 C00 / A | `packages/photo-library-contract/**`、本書、契約fixture/CI | なし |
| #194 C01 / B | `packages/photo-cloud-session/**`、`apps/photo-web`内auth/server session/callback専用source。Mac認証bridgeも共通package | #193 |
| #195 C02 / A | `packages/photo-cloud-library/**` adapter/transport/原本転送。本人read modelは既存private担当と調整 | #193/#194 |
| #196 C03 / A | `packages/photo-cloud-sync/**` draft/CAS/競合/mask/history。adapterに同時writerを作らない | #193/#195 |
| #197 C04 / B | `packages/photo-cloud-media/**`、形式/作業コピー/provider検証。既存private media/native SDK担当を保護 | #193/#195 |
| #198 C05 / A | `apps/camera` bootstrap/App/cloudBinding/native journal。Bの認証/mediaへ接続 | #194/#195/#196/#197 |
| #199 C06 / B | `apps/photo-web` browser entry/UI/PWA。共通UI/adapterを再利用 | #194/#195/#196/#197 |
| #200 C07 / B | 独立conformance/実機harness。source修正は各writerへ返す | #194〜#199 |
| #201 C08 / A | root package/lock/shared export/manifest、公式配備/署名更新/運用統合/readback | #193〜#200 |

fixtureで先行可能でも、依存未達の実接続・受入を完了にしない。C04/C02の追加APIは同じprivate sourceを競合編集せず既存paneB担当と境界を確保する。

C08は現行migration ledger/runtime/flag/IAM/providerをreadbackし、古い「未適用」コメントだけで再適用しない。既定OFFの合成→限定本人→実storage/端末→段階有効化と、原本・補正を残すrollbackを準備する。正式Photo Webと署名済みMac更新が利用者に届き、Mac↔ブラウザ/iPhone往復・容量/越権/失効/即時purgeを実受入するまでEpicをcloseしない。
