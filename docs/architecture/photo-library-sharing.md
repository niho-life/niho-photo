# NIHO photo 保管場所・共有アルバム・完成写真の契約 v1

Epic [#240](https://github.com/niho-life/niho-photo/issues/240)、B00 [#241](https://github.com/niho-life/niho-photo/issues/241)。型・状態遷移・権限表・合成fixture・負例の正本は [`packages/photo-library-sharing-contract`](../../packages/photo-library-sharing-contract/)（`@niho/photo-library-sharing-contract` v1）。契約の確定は、実backend・常設Mac・配備・配布の完了ではない。

## 位置づけ

- 本人専用の [`@niho/photo-personal-cloud-contract` v2](personal-photo-cloud.md) は変更しない。v2 は本人専用・5GiB・`albums: false` のまま動く。共有は v2 の owner の読み替えや `false` の置換ではなく、追加契約 v1 で扱う。
- v1 は v2 の型を再利用する。#195 の `UploadTicket`・`PhotoContent`、#196 の `RecipeDocument`・`RecipeConflict`、#197 の `RenderCapability` を別に定義しない。
- 公開契約に実HTTP route・DB schema・内部locator・資格情報を入れない。request は入れ子まで閉じた形で、想定外の key は無視せず `invalid_request` にする（`SHARING_REQUEST_SHAPES`・`CONNECTOR_REQUEST_SHAPES`）。body の owner・role・revision・path を認可の証明にしない。recipe の settings だけは #196 の validator が検査する open JSON。

## 語彙（UI B08 と共有）

| 種類 | 値 |
| --- | --- |
| 保存先 | `nihoCloud`（標準。最初に選ばせない）/ `hostedMac`（自前サーバー）/ `thisMac` |
| 役割 | `owner` / `contributor`（写真を追加できる）/ `viewer`（見るだけ）。招待と役割変更で付与できるのは後ろの2つ |
| AlbumItem の種類 | `ownerPhoto` / `memberEdit` / `fileUpload` |
| AlbumItem の状態 | `preparing` / `published` / `updatePending` / `removed` |
| 待機理由（`pendingReason`） | `rendering` / `waitingForHost`（Mac の起動後に更新）/ `waitingForDevice`（追加した端末の起動後に更新）/ `sourceChanged` / `quotaExceeded`（準備中（容量不足）） |
| 人の表示（`PersonLabel`） | `displayName`・`isSelf`。他のメンバーの user ID は返さず、メンバー行は `membershipId` で操作する |
| 常設Macの状態 | `online` / `sleeping` / `unreachable` |
| InviteLink | `role`・`expiresAt`（7日）・`revoked` |

値の変更は契約の破壊的変更として扱う。任意の項目の追加は v1 のまま行える。

## モデルと世代

| モデル | 識別・世代 | 公開範囲 |
| --- | --- | --- |
| Library | `libraryId`、owner、kind、`metadataRevision`。server の library は metadata の正本が NIHO（`metadataAuthority: "niho"`） | owner |
| HostConnector | `connectorId`、owner、library、`credentialGeneration`、状態、renderer 能力、`transport: "outboundOnly"` | owner |
| HostedPhoto | `photoId`、`source.generation`/`sha256`（遅延hash）、recipe revision、recipe を保存した source 世代、preview | owner |
| RenderBinding | source 世代・hash、recipe revision・settings hash、engine、renderer manifest、mask surface hash | 追加者と server |
| Album | `albumId`、owner（表示名と本人かどうか）、名前（1〜100 code point）、`revision`、閲覧者ごとの `access`（役割・membership revision・表示用権限・準備中の進捗） | 在籍者 |
| AlbumItem | `itemId`、追加者（表示名と本人かどうか。離脱後も表示名を保持）、kind、`revision`、状態、待機理由、完成写真、元写真への参照（追加者だけ） | 在籍者（準備中と待機理由は owner と追加者） |
| Rendition | 原寸JPEG（`fullResolution: true`）、サムネイル、許可した metadata だけ。item revision ごとに1つ | 在籍者 |
| Membership | `membershipId`（album ごとの不透明な ID）、member（表示名と本人かどうか）、役割、`state`（active/left/removed）、`revision` | 在籍者 |
| InviteLink | 付与する役割、期限、無効化、参加数。secret は作成時の応答だけ | owner |
| RenderJob | 目的（item/preview/export）、実行端末、対象の束縛、完全recipe、lease | 実行端末 |

保存先アカウント、NIHO の owner、操作する actor を分ける。同じ hash の写真でも、他人や別 library の存在照会・自動統合に使わない。`thisMac` は端末内だけの library で、NIHO は一覧も保存もしない。

## 常設Mac

- metadata（補正・mask・アルバム定義・索引）の正本は NIHO。常設Macは元データと控え（replica）を持ち、控えで正本を上書きしない（`connector.pullReplica`/`ackReplica`）。
- 控えの変更は revision 順の型付き upsert/delete（`ReplicaChange`。写真の索引記録・完全 recipe・mask・アルバム定義・除外）。mask の中身は `connector.getReplicaContent` で取り込み、surface の SHA-256 で照合する。`sinceRevision: 0` は現在の状態の snapshot。journal から詰められた revision や NIHO より先の revision は `replica_reset_required` で、控えを snapshot から作り直す（控えを正本へ昇格させない）。
- 常設Mac library の mask は `hostedMasks.startUpload`/`completeUpload` で先に NIHO へ置く。参照する mask が全部そろうまで補正の保存は `missing_mask_surface` で拒否し、一部だけ保存しない。
- 常設Macが休止中でも補正の保存は完了する。`hostedRecipes.put` は `durability: "niho"` を返し、控えの状態だけが `pendingHost` になる。待つのは `HOST_DEFERRED_WORK` の原寸書き出しと所有者の写真の完成写真だけ。
- 通信は常設Macからの外向きだけ（登録・heartbeat・索引・控え・描画job）。NIHO から Mac へ入る経路はない。
- 登録は接続用ソフトが始め、owner が NIHO で承認する短期・一回限りの手順。接続用ソフトは乱数の poll secret を作り、その SHA-256 だけを送る。開始は冪等で、応答が失われても同じ key で同じ登録を返し、応答に bearer を含めない。端末資格は一度だけ返り、NIHO のログイン token と別。失効・再登録で `credentialGeneration` が進み、古い資格の確定を拒否する。
- 索引は path ではなく不透明な `localKey` で送る。未 mount は削除扱いにしない（`volumeUnmounted`）。除外は一覧からの除外で、再走査で復活させない。索引を作り直したときに hash・source 世代が合わない写真は自動で再紐付けせず `sourceMismatch` にする。
- 元データが外部で変わったら source 世代が進む。古い世代に対して保存した補正は黙って使わず、保存は `revision_conflict`、共有中の項目は `updatePending`（`sourceChanged`）になる。

## 状態遷移

遷移表は `src/v1.ts` の `*_TRANSITIONS`。表にない遷移は拒否する。

- AlbumItem: `preparing → published`（完成写真の確定）、`published → updatePending`（元データを持つ人の補正保存）、`updatePending → published`、どこからでも `removed`。`removed` は終端で、遅れた upload・job で復活しない。revision は準備中が0で、完成写真を確定するたびに1つ進む。
- RenderJob: `queued → claimed → committed`、`queued ⇄ waitingForHost`、`claimed → queued`（lease切れ）、`failed → queued`（再試行）、非終端から `superseded`/`cancelled`。`committed`・`superseded`・`cancelled` は終端。
- 待機理由（`ALBUM_ITEM_PENDING_TRANSITIONS`）: `rendering` から Mac・端末の休止で `waitingForHost`/`waitingForDevice`、元データの変更で `sourceChanged`、完成写真の予約が owner の容量で断られたら `quotaExceeded`。`quotaExceeded` は容量が空いたとき（または元データが変わったとき）だけ抜け、`rendering` に戻って描き直す。Mac が起動しても容量不足は解けない。
- Membership: `active → left`（本人）/ `removed`（owner）。`left` は有効なリンクで再参加できる。`removed` は削除より後に作られたリンクでだけ再参加できる（古いリンクで削除を回避させない）。
- HostConnector: heartbeat で `online`、休止の申告で `sleeping`、期限超過で `unreachable`。
- 原寸書き出し: `waitingForHost → rendering → ready → expired`。`ready` の一時領域は期限で消す。

## 共有アルバムの権限（Epic §10）

| 操作 | owner | contributor | viewer |
| --- | --- | --- | --- |
| 一覧・閲覧・完成写真の原寸保存（`view`/`download`） | 可 | 可 | 可 |
| 写真の追加（`addItem`） | 可 | 可 | 不可 |
| 自分が追加した写真の差し替え・削除 | 可 | 可 | 不可 |
| 他人が追加した写真の削除（`removeOthersItem`） | 可 | 不可 | 不可 |
| 他人の写真の補正、元データ・補正値・maskの取得 | 不可 | 不可 | 不可 |
| 招待・役割変更・メンバー削除・アルバムの改名と削除 | 可 | 不可 | 不可 |
| 離脱（`leave`） | 不可 | 可 | 可 |

- 権限は server が台帳から毎回導く。`Album.access.permissions` は表示用の写し。
- 在籍していない・離脱した・削除された・別アルバムの項目・見えない項目は、存在しないのと同じ 404（`not_found`）。在籍者で役割が足りないときだけ 403（`role_forbidden`）。
- 他人の項目は owner でも差し替えられない（削除だけ）。役割は現在の値で判定するため、viewer に変更されたメンバーは自分の項目も外せない。
- 所有者の写真・メンバーの補正写真を library から追加するときは、その library が追加者本人のものに限る（`decideAddPhoto`）。アルバムの役割で他人の library には届かない。
- 人は表示名と `isSelf` だけで返し、他のメンバーの user ID を出さない。役割変更とメンバー削除は `membershipId` で指定する。
- 準備中の項目と `pendingReason` は owner と追加者だけに見せる。他のメンバーには直前の完成写真を `published` として見せ、保管場所や Mac の状態を返さない。元写真への参照（`source`）は追加者だけ。件数・表紙も閲覧者に見える項目だけで作る。
- 追加・差し替えは確定時（`albumItems.commitUpload`・`renderJobs.commit`）に現在の在籍・役割・項目・revision・世代・metadata を照合する。削除・離脱・降格が先なら確定しない。
- 差し替えは最後に受け付けた意図（`AlbumItemSnapshot.pendingUpload`）だけが確定できる。新しい差し替えを始めると前の upload は置き換わり、先に始めた古い差し替えが後から届いても確定しない。端末が描いた差し替えの開始は、公開中と待機中の両方より新しい世代のときだけ受け付ける（`decideReplaceStart`）。

## 完成写真

- 元データを持つ端末が描く。所有者の常設Mac の写真は常設Mac、メンバーの写真はその人の端末、NIHO クラウドの写真は本人の端末。描いた入力は `RenderBinding` で束縛する。
- job の確定は、呼び出した端末が job の実行端末そのもので、その job の検証済み upload を使い、metadata が許可範囲で、job の束縛が対象の現在の束縛と完全に一致し、lease と端末資格が有効で、項目が残っているときだけ。別の端末・別 job の upload・未完了の upload・古い job・同じ revision で入力が違う結果・preview を完成写真として出す結果は拒否する。
- 端末が直接描いた写真の差し替えは、前の束縛より新しい世代のときだけ受け付ける。
- 完成済み JPEG の直接追加は元写真への参照を持たず、自動では差し替えない。
- metadata は許可した `capturedAt`・`capturedAtOffset`・`colorProfile` と、画素へ反映した向きだけ。位置情報・機材シリアル・元のパスを含むものは公開しない（`sanitizeRenditionMetadata`、`findForbiddenMetadata`、`content_rejected`）。download のファイル名に元のファイル名やパスを使わない。
- 共有人数で完成写真を複製しない。容量はアルバムの owner の共有容量（`SharedStorageUsage`）に算入する。追加のときに容量が足りなければ `quota_exceeded`、描いた後の予約で足りなければ項目を `quotaExceeded` で待たせる。
- アルバム名は 1〜100 文字（Unicode の code point で数える。空白だけは不可。サーバーと同じ規則）。

## 招待リンク

- 推測困難な secret（128bit 以上）を作成時の応答で一度だけ返し、一覧・ログ・永続保存に出さない。結果不明の再送では `secret: null` を返すので、そのリンクを無効化して作り直す。
- 参加はログイン必須で回数制限をかける。未知・期限切れ・無効化済み・削除済みアルバム・削除後の古いリンクは同じ `invite_unavailable`（「このリンクは使えません」）。在籍中の人が使っても役割は変えない。参加のたびに owner へ `MemberJoinedEvent` を通知する。
- owner が削除した時刻は台帳に album と user ごとに残す（`lastRemovedAt`）。その後に新しいリンクで再参加して離脱しても消えず、削除以前に作られたリンクでは参加できない。

## 冪等・結果不明・cursor

- mutation は `idempotencyKey` が必須。replay の識別は actor・album または library（参加は account、常設Macの登録開始は poll secret の hash）・operation・key で、payload digest が同じなら同じ結果を `replayed: true` で返し、違えば `idempotency_conflict`。
- 応答が失われたら、同じ key と payload で再送して結果を照合する。新しい key で二重に追加しない。
- cursor は actor・範囲・条件・membership revision に束縛し、15分で失効する。役割が変わった後の cursor は `invalid_cursor` で、別の写真を返さない。アルバム一覧の cursor は actor の在籍の世代（`accessRevision`。参加・離脱・削除・役割変更で進む）に束縛する。

## エラーと再試行

`SHARING_ERROR_STATUS` と `SHARING_ERROR_RECOVERY` が正本。

| 次の操作 | code |
| --- | --- |
| 同じ key で再試行（Retry-After・上限付き backoff） | `rate_limited`、`temporarily_unavailable` |
| 再認証 | `unauthenticated` |
| 一覧を読み直して表示から外す | `not_found`、`role_forbidden`、`item_removed` |
| 読み直して本人が選ぶ | `revision_conflict` |
| 結果を捨てる（新しいものがある） | `stale_render`、`lease_expired` |
| 一覧を最初から読む | `invalid_cursor`、`cursor_expired` |
| 控えを snapshot から作り直す | `replica_reset_required` |
| owner に頼む | `invite_unavailable` |
| 登録をやり直す | `pairing_unavailable` |
| mask を先に保存してから送り直す | `missing_mask_surface` |
| 止める（容量・削除中・key の誤用など） | `quota_exceeded`、`account_deleting`、`idempotency_conflict`、`origin_rejected`、`unsupported_settings` |

`quota_exceeded` の数値は owner だけに返す。メンバーには code だけを返し、UI は「アルバムがいっぱいです」と出す。

## export と restore

- B01 の範囲。schema/engine・完全 recipe・mask・アルバム定義・photo/album ID・元 asset の identity・hash を持ち、参照だけの `metadata` と元データ込みの `full` を分ける。
- 鍵・ticket・session・招待の secret・在籍は含めない（`PORTABLE_EXPORT_EXCLUDES`）。メンバーが追加した項目と直接追加の項目の `source` は型で `null` に固定し、owner へメンバーの元写真への参照を渡さない。
- restore は現在の台帳で権限を照合し、snapshot から在籍を戻さない（`membershipsRestored: 0`）。NIHO の方が新しい補正・アルバムは残し（`keptNewer`）、古い snapshot で戻さない。

## v2 との互換 adapter

`src/compat-v2.ts`。向きは一方向。

- `nihoCloudLibraryFromPersonalV2`: 本人の v2 library を `nihoCloud` として投影する。v2 の値は変えない。v2 が `albums: true` などに変わっていたら拒否する。
- `personalV2ScopeFor`: v2 の scope は本人の有効な `nihoCloud` library だけ。常設Mac・端末内・共有アルバム経由のアクセスは null。
- `renderBindingFromPersonalV2`: NIHO クラウドの写真の描画束縛（v2 の原本は不変なので source 世代は1）。
- 容量: v2 の 5GiB は NIHO クラウドの原本と mask だけ。プレビュー・常設Mac library の mask・完成写真・一時書き出しは owner の `SharedStorageUsage` に計上し、その上限は server の方針で決める（Epic §14）。v2 の枠を他の範囲へ当てない。

## 公開・非公開の責務と writer

公開側（このrepo）は型・状態・合成fixture・負例・client/connector の公開可能部分を持つ。最終認可・権限台帳・資格情報の保管・実保存先・公式運用の設定は既存の非公開境界に置く。公開 fixture の合格を実 backend の完成としない。

| 対象 | writer |
| --- | --- |
| `packages/photo-library-sharing-contract/**`、本書、root workspace/lock・CI scope への登録 | B00 #241 |
| 契約の変更（語彙・型・権限表・vector） | B00 の writer に戻す。各担当は追加 field を提案し、同時に編集しない |
| 常設Mac library の正本・控え・索引復旧・export/restore（`hostedRecipes.*`、`hostedRecipeConflicts.*`、`hostedPhotos.exclude`、`hostedMasks.*`、`portability.*`、`connector.pullReplica`/`ackReplica`/`getReplicaContent`、`libraries.*`） | B01 #242 |
| 常設Macの登録・索引・プレビュー送信・接続用ソフト（`connectors.*`、`hostedPhotos.list/get/info/content`、`connector.startPairing/pollPairing/heartbeat/putIndex`） | B03 #244 |
| 招待リンク・役割・解除（`invites.*`、`members.*`） | B05 #246 |
| 完成写真・プレビュー・原寸書き出しの描画（`renderJobs.*`、`exports.*`） | B07 #248 |
| アルバムと項目・共有容量（`albums.*`、`albumItems.*`、`storage.get`） | B12 #254 |
| Mac・Web・iPhone の UI | B08 #249 |
| SDK export・release set への追加、公式配備 | 既存 C08 #201 の窓口。B00 では追加しない |

操作ごとの担当と未接続の記録は [operation-coverage.json](../../packages/photo-library-sharing-contract/operation-coverage.json)。

## 第2段階の拡張点

初期の型の必須項目にしない。追加は新しい値・任意項目・次の契約版で行う。

- B02（自分の R2）: `LibraryKind` と `SharedStorageUsage` を拡張する。v1 に bucket・鍵の項目はない。
- B04（外部からの元データ取得）: `HostConnector.transport` に新しい値を足す。v1 は `outboundOnly` だけで、`hostedPhotos.content` は元データを返さない。
- B06（共同編集）: `AlbumRole` と権限表を拡張する。v1 では `editOthersPhoto`・`readOthersSource` をどの役割にも与えない。
- B10（保存先の移行）・B11（Linux・Docker・NAS）: library ID と connector の `platform` を保ったまま値を足す。

## 検証

`npm run test|typecheck|lint --workspace packages/photo-library-sharing-contract`。公開CIの `Photo editing` scope が実行する。test は語彙・§10 の表・全操作の担当と閉じた request の形・遷移の閉包・閲覧者ごとの射影・metadata 規則・v2 互換・確定時の照合（実行端末・upload・最新の意図）・114件の負例 vector を参照判定で照合する。型の負例（owner の偽装、ownerの付与、CAS 無しの更新、第2段階の値など）は typecheck で固定する。
