# Photo専用Webのhost境界

正式な提供先は `https://photo.niho.life`、Safariとホーム画面PWAの起動先は `/`。共通の写真編集面を使い、Editorの `/photo` や新しい画像処理エンジンを追加しない。

このpackageはC01本人session consumer、既存C02/C03への接続口、共通編集面、静的配信とPWAを扱う。認証producer・クラウドHTTP操作の配置・永続下書き/outbox・実保存先はそれぞれの正本を使う。factoryの対象試験が成功しても、正式配備や実端末の受入が完了した意味にはならない。

## 境界

- `src/server/auth.ts`: 既存C01の固定認証ルート。未設定時は503へ閉じる。
- `src/server/fetch-host.ts`: exact origin、固定C01ルート、注入されたC02 handler、検証済み静的ファイルだけを扱う。認証/APIはno-store。認証失敗のナビゲーションは、共有copyから作る匿名の日本語HTMLを返す。
- `src/server/node-server.ts`: listenしないNode HTTP adapter。呼出側がloopbackへのbindとTLS reverse proxyを用意する。raw Host/target/headerを検査し、要求・応答をbounded streamで渡す。切断と通常のPOST完了を区別し、取消し・期限・backpressure・処理枠を保持する。
- `src/build/static-bundle.ts`: 信頼されたVite成果物と公式SDKの検証済みbytesから、匿名document、content-addressed静的asset、manifest、classic SW、公開build metadataを生成する。既存outputは上書きしない。
- `src/server/static-store.ts`: 起動前に全ファイルの長さ・SHA256を確認し、immutable Blobで保持する。要求URLからfilesystem pathを作らない。root/SW/manifest/build metadataはno-store、列挙済みの静的assetだけをpublic immutableで返す。
- `src/pwa`: 匿名offline HTMLだけを初回cacheし、静的assetを正確なhash/長さ/MIMEで検証する。認証/API/写真/root/アプリmanifestはcacheしない。更新は開いている全画面のguardが許可した場合だけ適用し、他画面を強制reloadしない。
- `src/runtime`: C01 controllerを1個所有し、C02 connectionとC03 guard/失効消去portを接続する。Query、表示用URL、dialog、遅着connectを本人と世代に拘束し、通常refreshで編集を作り直さない。C03のjournalを実装しない。
- `src/browser/mount.tsx`: runtimeとReact rootを各1個だけ所有し、scope通知を同期描画する。開始失敗・終了時の後始末を隔離し、同rootの二重mountを拒否する。
- `src/copy.ts` / `src/styles.css`: 共通copyとTailwind/theme/tokenを各host境界へ接続する。Viteは共通編集面と既存のstateless export workerを配布する。
- `src/view`: `PhotoLibraryProvider`、`BrowserPhotoEditingWorkbench`、`AppDialogHost`を使う。API、永続journal、別の編集面を持たない。文言は共通copyから受け取る。

静的配布は1ファイル8MiB、合計32MiB、128ファイル以内。Nodeの既定64MiB要求/応答・16処理枠はadapterの防御上限で、対応形式やクラウド転送能力の宣言ではない。C02/C08が実際の転送契約に合わせて明示設定する。V8 heap制限をWASM全体のメモリ上限とみなさない。

## 接続と配布

C08の信頼された設定に、C01実producer登録、C02実transport、C03下書き・guard・失効消去、共有dialog取消し、正式なCSP/immutable asset保持を合わせる。安全なUI identity metadataをserverの本人証明として送らない。通常のcredential refreshでは編集を維持し、失効・本人切替では処理と派生資源を同期的に止める。通常の画面終了を下書きの失効消去にしない。

## 共有アルバムの BFF（`/cloud/sharing/v1`）

`PHOTO_WEB_CLOUD_ENABLED=true` で、非公開の運用側が `PHOTO_WEB_SHARING_UPSTREAM_PATH_PREFIX`（共有の上流 prefix）と `PHOTO_WEB_PENDING_INVITE_KEYS`（base64url の 32 bytes を 1〜2 個、カンマ区切り。先頭で封じ、どちらでも開く）を両方渡したときだけ、`@niho/photo-cloud-library/server` の 2 つを `/cloud/v2` の前に組み込む。片方だけなら起動しない。値は source・log・エラーに出さない。鍵の入れ替えは新しい鍵を先頭に足し、15分後に古い鍵を外す。

- `createPendingInviteHandler`: 未ログインで開いた招待の保留と参加（`/cloud/sharing/v1/invites/pending`・`.../pending/join`）
- `createSharingCloudProxy`: 契約の経路の表（`SHARING_ROUTES`）を `/cloud/v2` と同じ作りで上流へ中継する。中継するのは応答を検査できる操作（`SHARING_PROXY_OPERATIONS`）だけで、ほかは `not_found`

拠点の rollout（`sharedAlbums`）は、この 2 つの値と、上流の `/cloud/sharing/v1`（非公開側の権限台帳・最終認可・参加の通知）がそろったら開ける。

## production artifact

Node 24でrepository rootからPhoto Webの静的ファイル、Node host bundle、検証済みSDK artifactを生成する:

```sh
npm run build --workspace @niho/photo-web
```

生成物は `apps/photo-web/dist/web`、`dist/server/entry.mjs`、`dist/static`。buildはこの3つの生成済みdirectoryだけを削除して作り直す。`dist/static/photo-build.json`のbuild IDとSDK proofを確認し、release imageには `dist/server/entry.mjs` と`dist/static`を一緒に梱包する。

containerは `node /app/entry.mjs` で起動する。既定portは8080、static rootは `/app/static`、受け入れ済み旧buildは `/app/accepted-prior/<release>/static`。`PHOTO_WEB_STATIC_DIRECTORY`と`PHOTO_WEB_ACCEPTED_PRIOR_DIRECTORY`は検証・ローカル起動用にrootを差し替える。クラウド機能は `PHOTO_WEB_CLOUD_ENABLED=true` のときだけ有効になり、未設定のimageはOFFで起動する。これは正式hostの設定・DNS/TLS・認証登録・proxy readback・実機受け入れを代替しない。

WebのVite bundleは共通の `develop-engine.worker.ts` を、既存の `develop-engine-export.worker.ts` へexact absolute aliasで解決する。これで同じ画素処理を使いながらnative glueや永続analysis DBを含めない。実際の配布graphとworker起動を確認し、SDK名の一致だけで能力や読み込まれたbytesを保証しない。

公式SDK baseline、notice、既存512pxアイコンの由来は `src/build/build-baseline.json` と `provenance.json`。C08が別の正式SDKセットを選ぶ場合は、実発行物のsource/hash/receiptを受入してから更新する。古いassetはPWA更新が終わるまで保持する。CDNで圧縮・変形してContent-Lengthを変えると固定bytes検証に失敗するため、静的配信はno-transformとし、実際の公開応答のbytes/長さ/MIMEをreadbackする。

## 検証

workspace登録後の対象検証:

```sh
npm run test --workspace @niho/photo-web
npm run lint --workspace @niho/photo-web
```

Node対象には実際のVite bundle検査、View対象には単一rootと終了・失敗・遅着のmount試験を含む。Vite graphでnative/server依存の混入と共通CSS生成を確認する。正式root/mainとC02/C03実接続は引き続き配備前の受入条件。

完全な共通UI型検査と重いnative/WASM buildは公開CIで行う。ローカルでは `tsconfig.pwa.json`、`tsconfig.build.json`、`tsconfig.server.json`、`tsconfig.runtime.json` の対象限定検査を使う。合成画像・fake portの試験と、正式origin/本人/実保存先/実iPhoneの受入を混同しない。

#194/#197/#199/#200の完了には、実認証、JPEG/PNG/受入済み形式の追加・編集・再読込・書出し・即時purge、Mac Chrome/Safari、実iPhone Safari/PWA、署名済みMacとの両方向の往復、越権/容量/競合/失効/遅着の独立証跡が必要。

Web hostのscopeSignal/isScopeCurrentは、共通の共有シート呼出し直前にも接続する必要がある。host.saveFileだけでは共通UIのnavigator.share経路を包めない。C03側の正式な共有portが未接続の状態を実機合格としない。

UI型検査は既存cameraと同じstrict設定を使う。PWA・build・serverの限定検査にはnoUncheckedIndexedAccess/exactOptionalPropertyTypesも適用する。runtimeのdownloadBudgetはC02/C08が実受入済みのhost memory budgetから明示設定し、未設定や不正値では接続を開始しない。

静的storeが保持するのは現在のbuildだけ。過去のファイルをdiskに残すだけでは、このexact mapから過去pathは配信されない。C08の静的配信層で旧content-addressed assetも配信し、passive画面が閉じるまで保持する。SWの2版cache上限をserver側の保持版数と同一視せず、root/SW/manifestは現在版だけを返す。

renderer probeは、このbundleに固定した受入済みSDK/manifest proofと、共通getterが検証した実WASMの能力を組み合わせる。mutableな現在の`photo-build.json`から旧画面の能力identityを作らない。probeの破棄が完了してから、同じimmutable manifestをC02/Workbenchへ渡す。失効・遅着・不一致・破棄失敗ではbindingを返さず、getterの無い旧runtimeや実能力宣言の無いSDKを対応済みとしない。能力のserver/host交差はC02だけが計算する。

## 転送の操作面

接続が `PhotoWebViewBinding.transfer` を提供し、runtimeのscope portが有効な場合だけ、共通編集面の上に原本追加と未完了転送の操作面を表示する。表示文言は共有copy、転送・再開・ファイル照合・取消はC02の実controllerを使う。共有の `PhotoLibrary.addFile` に架空の成功を返さず、画面内に原本bytesや別のjournalを保持しない。

一覧は現在ページの最大16件だけを読み、表示・再読込だけでは再送しない。新規追加は1件ずつ、再開には既存intentを使い、必要な場合だけ同じファイルを選び直す。本人確認中・オフラインではmutationを止め、scope失効・画面終了では進行中の処理をabortして遅着結果を捨てる。通常終了で永続journalを消さない。

最終compositionは実controllerの進行中操作を離脱/PWA guardへ含め、受け入れた結果で一覧と容量を再確認する必要がある。取消と保存が競合し `failed` / `stored` が返った場合も保存済みとして再確認し、再確認の失敗で保存結果を失敗へ書き換えない。進行中操作の取消ボタンと正式接続後の実機受入は、この操作面だけで完了した扱いにしない。

## 本人captureと受信stream

`src/browser/session-client.ts` はC01 controllerとC02の実clientをつなぐ。identity portは通常refresh中も同じ本人tupleを保ち、新規requestはC01のcapture入口で止める。開始済みrequestの成功値とC00 errorは、通常refreshの確認barrierを通して返す。contentは原本全体をbufferせず、EOF/error/cancelまでscope signalを保ち、失効後のchunk公開を止める。

正式compositionでは、固定Photo BFFへのfetchで得た401をruntimeのfence・peer通知・本人再確認へつなぐ。providerへの送信失敗はC02の再開・renewで扱う。helperの単体成功だけではこのHTTP接続、失効時の両journal消去、preview解放、実producer・SDK・memory budgetの受入は完了しない。

`connect` が受け取る `onAuthenticationRejected` を `createPhotoWebCloudFetch` へ渡し、そのfetchをC02 browser clientだけに注入する。固定same-origin `/cloud/v2/` の401でruntimeが同期的に旧接続を止め、匿名のpeer通知と実本人再確認を行う。同じ本人へ戻っても自動接続を繰り返さず、明示retryで再開する。この拒否状態はpeer通知やBFCache復帰をまたいで保持し、本人tupleが変わった場合にも解除する。旧世代・失効済み接続からの通知は無視する。403/409/503やproviderの401はこの本人通知へ変換しない。
