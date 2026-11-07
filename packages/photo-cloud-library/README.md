# 本人クラウドの共通PhotoLibrary adapter

C02 / Photo #195。既存の `niho-photo-editing` の編集面を、`@niho/photo-personal-cloud-contract` v2の本人用portへ接続する。原本・owner・容量・補正revision・物理purgeの正本は既存backendに置く。

read/delete/content adapter、same-origin HTTP client/BFF、IndexedDBの送信前journalと明示コピーcontrollerを実装している。参照maskの実転送と最終ports接続、Macの派生画像・mask読取、正式hostの接続は残る。クラウドの名前付き版はowner指示（2026-11-04）で今回の実装・完了・出荷条件から除外し、既存Macのローカル版は維持する。HTTP wire・期限・公開前の再認証・容量境界の正本は [転送接続契約](../../docs/architecture/personal-photo-transfers.md)。

`@niho/photo-cloud-library/browser` は `createBrowserPersonalPhotoCloudClient({identity})` で実libraryをprobeし、`createBrowserPersonalPhotoTransferController({client, identity})` で明示コピーを扱う。controllerのstartはintentId/File/format/完全recipe候補を受け、resume/cancelは同じintentを使う。`list({cursor, limit})` は `{items, nextCursor}` を返し、`readPendingRecipe(intentId)` はC03へ引き継ぐ両snapshotを返す。IDB/Web Lockを利用できなければ転送を始めない。disposeで要求・reader・購読を解放する。

通常の `dispose()` と曖昧なnull identity/connection teardownは再起動後のresume用journalを保持する。logout・失効の確定イベント、検証済みの別scope、期限切れ、実認証拒否では旧scopeをfenceしてjournalを消去する。hostは境界上の明示cleanupに `revokeScope()` を呼べる。purgeはactor/library/session/epochの完全一致だけを対象にし、raceする別tabのlate writeは一方向hashのfence keyで拒否する。revoke後の同じscopeは再利用しない。

`@niho/photo-cloud-library/server` の `createPersonalPhotoCloudProxy` は、既存C01のauthService、trustedなupstreamOrigin/upstreamPathPrefixを受け、C06のcloudHandlerへ渡せる `Request => Promise<Response | null>` を返す。credentialはserver callback内だけに置く。`PERSONAL_PHOTO_CLOUD_HOST_LIMITS` をC08のNode設定へ明示し、既定64MiB/120秒のまま実接続を受け入れない。

最終unitは同package内の合成試験で確認する。原本保存後でも、候補の補正・実maskの照合が終わるまではpending-recipe。ticket/URL/credentialはjournal・UIへ保存せず、元写真を移動/削除しない。addFile capabilityの有効化とWeb/Macのcompositionは後続担当が接続する。

## ホストの責任

`createPersonalPhotoCloudLibrary` へ、検証済み本人に拘束したclient、本人snapshotと変更購読、実renderer能力、engine assets、実presets、明示的なメモリ予算を渡す。未認証時に別clientへfallbackしない。認証・libraryの切替時は古いbindingを直ちに失効させる。

mask surface の保存 capability は `@niho/photo-cloud-sync` のfactoryが提供する。同じIndexedDBへPNG・writerごとのpin lease・固定upload keysを保存し、recipe送信直前の共通barrierで実SDK検証とSTORED照合を行う。実SDKを呼ぶ `maskSurfaceValidator` が必要で、Browserは共通resumable runner、Macはcredentialを公開しない単一の `maskUploader` host portを使う。read adapterだけでは保存を開かない。明示コピーのBrowser transfer controllerにも実SDKを呼ぶ `maskValidator` を渡し、未接続時はmask参照付きコピーをpendingのままにする。hostはbinding破棄時にvalidator/uploaderを解放する。

handleの `library` は既存PhotoLibrary、`usage` は予約・削除待ちを含む容量内訳、`rawPhoto` は完全なrecipe JSON、`readAsset` は検査付きstream、`dispose` は資源解放の口になる。metadataのwhole-asset SHA-256をrange本文のdigestと取り違えず、実transportが正本のgenerationとhash検証済みassetへ固定する。

File/Blobを要求する共通口だけを明示的な予算内で実体化する。大きな原本のMacコピー/書出しはnative側、ブラウザの保存はhost側のstream経路へ接続する。空のBlobで保存成功を偽装しない。予算はadapterの一時的な実体化と保持資源を管理するもので、ブラウザ全体のRSSを保証する値ではない。返したFile/Blobの寿命は呼出し元が管理する。

一覧の現在版の派生画像は `editedPreview` として返し、未補正の `previewUrl` と混同しない。hostは表示を終えた写真のIDを `releasePreviewResources(photoIds)` へ渡し、表示中のURLを解放しない。解放したURLを保持するquery/page cacheも無効化し、再表示時は一覧または写真を再取得する。省略時は全previewを解放する。scope離脱・purge時は即時に破棄する。 同じ未取得previewの同時要求は1回の取得を共有し、各要求の取消しは個別に扱う。全利用者が離れた場合だけ取得を止め、未公開URLも利用中の要求が残る間は保持する。保持中URLと処理中の予約が上限を占める場合、追加取得を開始する前に拒否する。実hostからの解放hookの接続と実機測定はC05/C06/C07の残作業である。

## 実装境界

- 本人・library・session epoch・認証親に拘束し、通常refreshは同じ論理scopeを維持する。
- 未知recipeはraw JSONを保持し、安全に編集できないものは拒否する。原本downloadの可否と混同しない。
- 画像の寸法、renderer manifest、base、library revision、生成時刻を捏造しない。
- 削除は物理purge確認後だけ成功とする。結果不明・保留・失敗は容量解放済みと扱わない。
- save/upload/versions/masks/native exportは、このread adapterだけで実装済みとしない。

型確認は共通SDK sourceと同じ `strict` policyを用いる。C00契約packageは独立した既存の厳格な設定を維持する。対象のtypecheck/test/lintをpackage scriptsから実行し、全体検証・native build・実DBは規約に従ってCIへ委譲する。

## 共有アルバムのメンバーと招待（`./sharing`、B05 #246）

`@niho/photo-cloud-library/sharing` は共有アルバムの招待リンク・メンバーの client（`createBrowserSharedAlbumMembershipClient`）、UI向けの操作（`createSharedAlbumMembership`）、開発と試験用の合成 in-memory server（`createSharedAlbumMockServer`）を持つ。契約は `@niho/photo-library-sharing-contract`（B00）が正本で、判定は同 package の `./policy` を使う。本人 v2 の port・認可・5GiB の契約は変えない。

- 本人 v2 の transport を複製せず、同じ部品を使う（`PersonalPhotoScope` を session だけに束縛、capture header、header の期限、bounded JSON、idempotency key の規則）。アルバムは library をまたぐので、scope は library を持たない。
- wire は契約の利用者の経路の表（`SHARING_ROUTES`、`/cloud/sharing/v1`）に従う。ID は path、`cursor`・`limit` は query、残りは閉じた JSON body、mutation は `Idempotency-Key`。合成 server も同じ表で decode する。capture header は BFF が検証済みの session と照合する fence で、認可の根拠にしない。招待の secret は `POST /invites/join` の body だけに載せ、URL・storage・log に出さない。
- 応答は厳密に検証し、人は `{displayName, isSelf}` 以外を拒否する。表示用の権限は契約の表と一致しなければ拒否する。
- 1 操作 1 key。応答喪失は同じ key で再送する（参加の通知は重複しない）。作成時の secret が replay で失われたリンクは毎回無効化してから作り直す。
- 合成 server は photo 単位のリンク共有（`cloudSharing`）とは別で、共有リンクを招待として受け付けない。実際の権限台帳・資格情報・回数制限は既存の非公開境界に置き、この server を本番で選ばない。
- 契約 package は package 名で読む（`src/sharing/contract.ts` の 1 箇所）。共有シート・招待画面と 401 の扱いへの接続は後続。

### 共有アルバムの BFF（`@niho/photo-cloud-library/server` の `createSharingCloudProxy`）

`/cloud/sharing/v1` を本人 v2 の proxy と同じ作りで中継する（[本人写真のHTTP転送](../../docs/architecture/personal-photo-transfers.md)）。

- 経路は契約の表（`SHARING_ROUTES`）だけ。表に無い path・method、このpackageが応答を検査できない操作は `not_found`。path の ID は単一の opaque segment の正規の符号化だけを受ける。
- request は契約で decode し（配置と閉じた形）、client と同じ値の規則で検査してから正規の形に encode し直す。mutation は `Idempotency-Key` が必須、ほかは拒否。`Range` は content の経路だけ。呼び出し側の `Authorization` は拒否し、cookie・header を上流へ渡さない。
- `withAuthorizedCredential` で本人・親 session・epoch を capture header と照合し、新しい credential を固定の upstream（`NIHO_PRODUCTION_ORIGIN` と非公開の起動設定の prefix）にだけ渡す。同じ suffix を prefix へ写す。
- JSON は parse の前に byte 数を制限し、client と同じ応答の規則で検査する。error は契約の envelope で status が一致するものだけ。upload ticket は trusted provider の、その upload のものだけ。content は v2 と同じ（200 は全体、206 は要求した範囲、全体の size と SHA-256、正確な長さ、全量を buffer しない）。
- 公開の前に session をもう一度確かめ、失敗なら上流の body を取り消して 1 byte も出さない。応答はすべて `no-store`。
- 中継する操作は `SHARING_PROXY_OPERATIONS`: メンバーと招待（B05）、アルバム・項目・オーナーの共有容量・完成写真の download と upload ticket（B12）。家の Mac のライブラリ・書き出し・render job など、応答を検査する client がまだ無い操作は閉じている。

### 未ログインで開いた招待（`@niho/photo-cloud-library/server` の `createPendingInviteHandler`）

契約の `PENDING_INVITE_ROUTES` の BFF 側。`POST /cloud/sharing/v1/invites/pending` と `.../pending/join` だけを受け、他は次の handler へ渡す（`null`）。

- 保留: 画面は secret を一度だけ body で渡す。BFF は AES-256-GCM で封じ、`__Secure-niho-photo-pending-invite`（`HttpOnly; Secure; SameSite=Lax; Path=/cloud/sharing/v1/invites/pending; Max-Age=900`）に入れる。JS は secret も cookie も読めない。ログイン中に保留すると、その人だけが使える。
- 契約の path では `__Host-` を使えないので、親ドメインの別 host が同じ名前の cookie を置ける。保留の ID を host 限定の `__Host-niho-photo-pending-invite-id`（`Path=/`）にも入れ、封じた ID がそれと一致する cookie だけを開く（置かれた cookie は使わず、こちらの cookie も妨げない）。
- 参加: 検証済みの session で cookie を開き、`decidePendingInviteJoin` で決め、通常の `invites.join` を上流へ送る（key は保留の ID ごと）。session を確かめたあとは成否に関係なく cookie を消す。未ログインなら `unauthenticated` で cookie を残す。応答は `InviteJoinResult`（receipt を外した値）を検証してから返す。
- 鍵は非公開の運用側から渡す 32 bytes を 1〜2 個（先頭で封じ、どちらでも開く）。値を source・log・エラーに出さない。使った保留の ID は期限までこの process が覚え、別の instance で同じ cookie が使われたときは上流の key の replay（`replayed: true`）を `invite_unavailable` にする。
- 同一 origin・`Origin` 一致・`Sec-Fetch-Site: same-origin`（ある場合）・`Content-Type: application/json`・query と `Idempotency-Key` なし・閉じた body だけを受ける。

## 共有アルバムの写真（`./sharing`、B12 #254）

同じ `./sharing` に、アルバム・項目・オーナーの共有容量の client（`createBrowserSharedAlbumClient`）と UI 向けの操作（`createSharedAlbumItems`）を置く。B05 の client と同じ HTTP の芯（`sharing-http.ts`）と経路の表を使う。

- 追加は 3 種類。自分のライブラリの写真（`addLibraryPhotos`。元データを持つ端末が B07 で描く）、端末で描いた写真（`addDevicePhoto`。`renderFinishedOutput` の結果を `deviceRenderFile` で渡す）、完成済みの JPEG（`addFile`。`prepareAlbumFile` が端末で撮影日時以外の metadata を落とす。向きの tag に頼る JPEG は受け取らない）。
- 呼び出しごとに冪等 key を持ち、応答が失われたら同じ key で再送する。ticket のない再送の応答を受けたら、その upload を取り消して同じ項目へ同じ内容を出し直し、項目を二重に作らない。始めた upload は確定か解放で終わる（中断・確定の拒否・取消で予約を返し、公開されなかった追加は消す）。
- 差し替え（`replaceFile`・`replaceDeviceRender`）、複数選択の削除（`removeItems`）と保存（`saveItems`。原寸を hash と照合して渡す）。
- 合成 server は項目の状態、追加者の端末の描画 job、確定時の作り直し（許可した metadata だけ）、オーナーへの容量の算入と解放、補正の保存による自動差し替え、端末の休止、メンバーの解除・降格で公開前の追加を落とすことを持つ。画面への組み込みは B00・B08 の merge 後。

## 完全補正の同期core

C03は `@niho/photo-cloud-sync` と組み合わせ、`recipes.put` / `recipe-conflicts.list` / `recipe-conflicts.get` / `recipe-conflicts.resolve` を同じ固定HTTP/BFFへ接続する。補正文書1MiB/depth32とPUT envelope2MiBを分離し、両版と選択結果を含む競合応答は4MiBまで検証する。`./protocol` はscope/有限待機/純粋なrecipe投影・比較の狭い共有口で、認証やhashの別正本ではない。

この接続だけでPhotoLibraryの編集capabilityは開かない。共有autosaverのdebounce前stage、実mask/base/versions、各hostへの注入と正式環境での受入を続ける。

## 端末で仕上がり写真を作る（`./render-executor`、#248）

`@niho/photo-cloud-library/render-executor` は、原本を持つ端末（Macアプリ・Web。のちに常設Mac）で共有アルバムの仕上がり写真とpreviewを作り、`@niho/photo-library-sharing-contract` の `renderJobs.claim` → `startOutput` → upload → `commit` / `fail` で送る。

- 画素は既存engine（#197）の書出しだけで作り、engineの版は変えない。JPEGの品質はengineのWeb書出しと同じ90。
- 仕上がり写真は全画素に限る。recipeの回転・切抜きから決まる大きさとengineの出力が一致しなければ `full_resolution_unavailable` で止め、小さい画像を仕上がりとして送らない。このengine経路は長辺4096pxまでのJPEG/PNGの原本を扱う。
- metadataは端末で作り直す。既定のJFIFと画像のsegmentだけを残し、ほかのAPPn・COM・EOI後のbyteを落としてから、撮影日時（UTC offset付き）と向きだけをengineの `withCaptureExif` で書く。色はタグなしsRGBだけ。
- jobは `RenderBinding` に拘束し、古いrecipeの結果は送らない（サーバも `decideRenderCommit` で拒否する）。端末ごとの同時実行数を守り、`drain` は端末内で1本だけ走る。表示中の写真を先に作り、recipeの更新・項目やアルバムの削除で古いjobを止め、容量不足は失敗にせず空きができたら再開する。
- `createRenderJobMockServer` は契約のpolicyを使う合成のjob queueで、試験とUI確認に使う。実HTTP routeとhostへの接続は後続。
