# 本人写真のHTTP転送とコピーjournal

C02 / [#195](https://github.com/niho-life/niho-photo/issues/195)。[本人クラウド契約](personal-photo-cloud.md)とC00の公開型を、同じ本人backendへ写す。別catalog・quota・認証authorityを作らない。本書は接続実装の契約であり、正式環境・実storage・Safari/PWA・署名Macでの受入証跡ではない。

## HTTPの境界

ブラウザは同じPhoto originの `/cloud/v2` だけを呼ぶ。BFFは既存Photo auth serviceの `withAuthorizedCredential` で本人・親session・epochを検証し、trusted startup設定の固定upstreamへだけcredentialを渡す。設定は非公開運用側が供給し、公開sourceへ内部URL・prefix・secretを埋め込まない。ブラウザが送る本人/session/epochは古い要求を拒否するfenceであり、認可根拠ではない。

clientのlibrary IDは最初の実 `library.get` から得る。通常refreshで期限だけが変わる場合は同じscopeを維持し、本人・親・epochが変われば要求とstreamを破棄する。元のcookieやtokenをclient portへ渡さない。Macのcredential・原本・ticketを汎用React clientへ流さない。

operationごとにpath/method/query/bodyを固定し、繰返しformatsを維持する。GET/DELETE body、未知query、同じscalarの重複、caller指定upstream、redirectを拒否する。`uploads.renew` はC00上のmutationではないためidempotency keyを要求しない。補正/mask/versions等の未接続operationは成功を偽装せず閉じる。

以下のpathは公開BFFの `/cloud/v2` に続く。upstreamは同じsuffixをtrusted prefixへ写す。path内IDは単一のopaque segmentとして検査/encodeし、slash・dot segment・queryを混ぜない。

| operation | method / suffix | query / body | key |
| --- | --- | --- | --- |
| library.get | GET `/library` | なし | 不可 |
| photos.list | GET `/photos` | cursor、limit、sort、繰返しformats、edited、editable | 不可 |
| photos.get | GET `/photos/{photoId}` | なし | 不可 |
| photos.info | GET `/photos/{photoId}/info` | なし | 不可 |
| photos.lookup | POST `/photos/lookup` | `{sha256s}` | 不可 |
| uploads.start | POST `/uploads` | C00 StartUploadRequest | 必須 |
| uploads.get | GET `/uploads/{uploadId}` | なし | 不可 |
| uploads.renew | POST `/uploads/{uploadId}/renew` | `{}` | 不可 |
| uploads.complete | POST `/uploads/{uploadId}/complete` | `{}` | 必須 |
| uploads.cancel | POST `/uploads/{uploadId}/cancel` | `{}` | 必須 |
| photos.delete | DELETE `/photos/{photoId}` | なし | 必須 |
| content.get | GET `/photos/{photoId}/assets/{assetId}/content` | `Range`のみ | 不可 |

captureは `X-NIHO-Photo-Actor-Id` / `X-NIHO-Photo-Session-Id` / `X-NIHO-Photo-Session-Epoch` の3header、transportはbrowser-session固定。keyは `Idempotency-Key`。BFFはfresh actorへ3項目を照合し、upstreamへ本人/epochと新鮮なcredentialを渡す。callerのAuthorizationやcookie全体はforwardしない。C01のscope_changed/401はC00のunauthenticated、設定/上流不明はtemporarily_unavailableへ写し、任意error本文を返さない。

JSONはparse前にstreamの総byte数を制限する。`photos.list` はContent-Lengthなし・分割streamも含め4MiBまで。個別Photoやuploadの成功応答は1MiBの完全recipeを含み得るため2MiBまで、errorは64KiBまでとする。UTF-8/JSON/depth/DTOを検査し、ページ全体を再serializeするだけの検査を重ねない。全応答をno-storeとし、上流error本文・URL・provider応答を表示/ログへ出さない。

`content.get` は原本200MiBまでのgeneration固定stream。whole-asset SHA、全体size、200/206、Content-Range/Length、実際のbyte数、timeout/abort/cancelを検証し、全量bufferしない。BFFはdispatch前と応答公開前にactorを再検証し、backendのcommit fenceを代用しない。開始済みstreamや取得済み端末コピーの遠隔消去は保証しない。

再照合は同じrequest/captureで `withAuthorizedCredential` を二度呼ぶ。2度目はJSON全体の検査後、contentではheaders検査後に行い、callbackではcredentialを保存/返却しない。失敗ならupstream bodyをcancelし、1byteも公開しない。

contentの200は要求rangeなしの全体、206は単一の `bytes start-end/total` が要求と一致する場合だけ。`X-NIHO-Photo-Sha256` は全原本hash、`X-NIHO-Photo-Total-Bytes` は全体size、Content-Lengthは実区間長。416は閉じたrange_not_satisfiable errorとする。未知/重複metadataや短読/超過を成功にしない。

C08はNode hostへ `maxResponseBytes=209715200` と `requestTimeoutMs=600000` を明示する。既定64MiB/120秒では接続受入しない。C02側はheader/idleとも15秒とし、hostの10分absolute上限も残す。中断後は固定asset/rangeで再要求し、原本全量をbufferする回避をしない。正式hostと前段proxyの実設定・200MiB境界・低速時の中断はC08/C07でreadbackする。

## 明示コピーと再開

コピーは利用者の明示操作から始める。ログイン・一覧表示・再接続だけで自動uploadしない。Fileはbrowser host内、native原本はnative内で所有し、元写真を移動/削除しない。

browserは最大1MiBのsliceでSHA-256を増分計算し、原本全体をarrayBufferへ複製しない。ファイル上限200MiBを確認するが、形式の実受入・magic bytes・寸法/向き・100MP境界はbackendの検証を通る。browser直接編集40MPの境界と混同しない。

File.typeが空でも、明示formatと受入済み拡張子から正規MIMEを選べる場合は開始できる。空MIMEをdecode未対応と同一視せず、JSONへ実原本を展開しない。非空の不正なMIMEや形式との不一致は閉じ、原本の実形式はbackendが検証する。

送信前にjournalのtransaction完了を待つ。保存するのは、owner/library/session/epochと明示intent、固定request key、正規start payload、原本hash/size/name/format、完全recipe/base/mask参照、opaque upload/photo ID、元期限、確認済み進捗、phaseだけ。File・原本bytes・handle・credential・ticket・URL・provider本文は保存しない。IndexedDBを利用できない・quota/transaction失敗の場合はnetwork mutationを始めない。

journalはscope内に隔離し、同じintentをadd-if-absentとCASで更新する。active runには同じentryのWeb Lockを必要とし、対応しないhostで同時実行を安全と偽らない。hash/network待機中にIDB transactionを保持しない。再起動後にFileを失っていれば再選択と全hash/sizeの再照合を要求する。

一覧はcursor付きpageとして読み、最大16件かつ完全snapshot合計4MiBまでとする。無制限getAllや全文cloneを使わず、上限を超えた候補は次pageへ残す。controllerは `{items, nextCursor}` の安全なstatusを返し、残るintentを黙って切り捨てない。候補とcloud recipeは個別にも上限を検査する。

結果不明のstartは同じpayload/keyで再送する。upload IDを得た後はget/renewで現在状態を照合する。エラー・expiry・purgeで自動的に新keyへ切り替えない。削除済み410はterminal。新しいcopyには新しい明示intentが必要である。

provider PUTは8MiB単位のBlob sliceとし、末尾以外は256KiBの倍数。ticketは許可されたHTTPS origin・method/header・期限・offsetを検査し、memory内だけで使う。資格情報はomit、referrerを送らず、redirectを追わない。Fetchのmanual redirectで308がopaqueになる場合は進捗確定に使わず、まずbackendのgetで実受信位置を確認する。fullsizeならcompleteへ進み、未完了の場合だけrenewする。送信予定byte数を実受信量にしない。

PUTの `Content-Range` はcontrollerが `bytes {offset}-{endInclusive}/{total}` と計算する。ticket由来headerは `Content-Type` だけを受理し、start payloadのtypeと完全一致させる。Authorization/Cookie/Host/Origin/Content-Length/Content-Range/Locationや任意headerをticketから採用しない。browserが禁止するContent-Lengthは設定しない。BFFとbrowserの双方で同じticket validatorを使い、upstreamからの不正ticketも転送しない。URLはtrusted hostが許可するexact origin（正式GCSは `https://storage.googleapis.com`）のHTTPS、userinfo/hashなし、長さ上限8KiBとする。origin設定をrequestから変更しない。

読み取れる308のRangeは `bytes=0-{last}` の一つだけ、safe integer、直前のoffset以上かつ送信chunk終端以下を確認し、次位置をlast+1にする。欠落/不正/不透明応答はbackendのgetで照合する。offset全体を受信済みの場合、renewがneeds-finalizeで閉じることがあるためgetのfullsizeをcompleteへ写す。再照合で元期限が変わる・offsetが不正/逆行する場合は閉じる。

providerの200/201は原本保存完了ではない。全SHA/実metadataを検証して本人completeがstoredを返すまでverifyingとする。30分の転送受付と60分のcomplete猶予を区別し、renewで元期限を延ばさない。確認処理は有限とし、iOSの背景処理完了や無限retryを約束しない。

completeの最終期限は元expiresAtに60分を加えた時点、開始から最大90分である。8MiBのprovider PUTは送信時間を含め1回120秒で閉じる。JSON/contentの15秒header/idleをupload送信時間へ流用しない。signalを無視する依存もtimeout/abortでpublic promiseを解放し、timer/listenerを直ちに除き、遅れて届いたbodyはcancelして公開しない。

## 補正・競合・取消

原本storedとコピー全体のdoneを区別する。local candidateがある場合は、その完全JSON・base・参照maskがfreshなcloud Photoと一致するまでpending-recipeに置く。C03がmask転送/CAS/競合を接続する。既存の別補正を自動上書きせず、両候補を保持する。local candidateがnullの場合は「端末に保存済み補正がない」を意味し、既存cloud recipeを初期値へ戻さない。

mask参照のJSON一致だけでは実体の確認にならない。photoに束縛したmasks.getの実assetでhash/kind/size/寸法を検証できるまでpending-recipeを維持する。C03前の未対応応答や欠損maskを、コピー全体の完了に読み替えない。

取消も送信前にjournalへ記録する。応答不明は同じcancel keyで照合し、物理purge確認前に空き容量/取消成功を表示しない。completeが先にstoredへ進んだ409では原本を削除しない。取消/失敗からの再試行を暗黙の新copyにしない。

## 実接続の完了条件

対象試験は、client→BFFの閉じた認証境界、4MiB+1の分割body、epoch切替、stream短読/超過/取消、IDB abort/CAS/reopen、start/complete/cancel応答欠落、308不透明応答、実offset、期限、再選択不一致、重複原本の既存補正保全を含む。合成試験と実handler/DB/storage/端末受入を区別する。

Mac native IPC・journalの実実装はC05、Webのmount/UIへの注入はC06、補正/maskはC03、実mediaはC04、正式配備/署名更新/実機readbackはC08まで続ける。このcoreのPRだけでC02やEpicをcloseしない。

protocol参照: [GCS resumable uploads](https://docs.cloud.google.com/storage/docs/performing-resumable-uploads)、[Fetchのredirect処理](https://fetch.spec.whatwg.org/#http-fetch)。増分hashの固定依存とnoticeは [第三者告知](../../THIRD_PARTY_NOTICES.md)に記録する。
