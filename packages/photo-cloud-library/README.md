# 本人クラウドの共通PhotoLibrary adapter

C02 / Photo #195。既存の `niho-photo-editing` の編集面を、`@niho/photo-personal-cloud-contract` v2の本人用portへ接続する。原本・owner・容量・補正revision・物理purgeの正本は既存backendに置く。

read/delete/content adapter、same-origin HTTP client/BFF、IndexedDBの送信前journalと明示コピーcontrollerを実装している。参照maskの実転送と最終ports接続、Macの派生画像・mask読取、正式hostの接続は残る。クラウドの名前付き版はowner指示（2026-11-04）で今回の実装・完了・出荷条件から除外し、既存Macのローカル版は維持する。HTTP wire・期限・公開前の再認証・容量境界の正本は [転送接続契約](../../docs/architecture/personal-photo-transfers.md)。

`@niho/photo-cloud-library/browser` は `createBrowserPersonalPhotoCloudClient({identity})` で実libraryをprobeし、`createBrowserPersonalPhotoTransferController({client, identity})` で明示コピーを扱う。controllerのstartはintentId/File/format/完全recipe候補を受け、resume/cancelは同じintentを使う。`list({cursor, limit})` は `{items, nextCursor}` を返し、`readPendingRecipe(intentId)` はC03へ引き継ぐ両snapshotを返す。IDB/Web Lockを利用できなければ転送を始めない。disposeで要求・reader・購読を解放する。

`@niho/photo-cloud-library/server` の `createPersonalPhotoCloudProxy` は、既存C01のauthService、trustedなupstreamOrigin/upstreamPathPrefixを受け、C06のcloudHandlerへ渡せる `Request => Promise<Response | null>` を返す。credentialはserver callback内だけに置く。`PERSONAL_PHOTO_CLOUD_HOST_LIMITS` をC08のNode設定へ明示し、既定64MiB/120秒のまま実接続を受け入れない。

最終unitは同package内の合成試験で確認する。原本保存後でも、候補の補正・実maskの照合が終わるまではpending-recipe。ticket/URL/credentialはjournal・UIへ保存せず、元写真を移動/削除しない。addFile capabilityの有効化とWeb/Macのcompositionは後続担当が接続する。

## ホストの責任

`createPersonalPhotoCloudLibrary` へ、検証済み本人に拘束したclient、本人snapshotと変更購読、実renderer能力、engine assets、実presets、明示的なメモリ予算を渡す。未認証時に別clientへfallbackしない。認証・libraryの切替時は古いbindingを直ちに失効させる。

mask surface の保存 capability を公開するには、永続uploadを行う `maskUploader`、表示と同じSDK decoderを呼ぶ `maskValidator`、補正journalと同じbytes/upload-state journalを指す `maskJournal`、scopeをまたぐ重複uploadを直列化する `maskLocks` がすべて必要。sync library factoryは補正journalとlockを自動で接続する。adapterはネットワーク要求より前にPNG bytesとstable upload stateを永続化し、共通resumable runnerで送信し、cloud readback・SDK decode・byte identityを確認した後だけupload stateをsettleする。Browser transfer controllerにも同じ `maskValidator` を渡し、未接続時はmask参照付きコピーをpendingのままにする。ホストはbindingの破棄時にvalidator/uploaderを破棄する。

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

## 完全補正の同期core

C03は `@niho/photo-cloud-sync` と組み合わせ、`recipes.put` / `recipe-conflicts.list` / `recipe-conflicts.get` / `recipe-conflicts.resolve` を同じ固定HTTP/BFFへ接続する。補正文書1MiB/depth32とPUT envelope2MiBを分離し、両版と選択結果を含む競合応答は4MiBまで検証する。`./protocol` はscope/有限待機/純粋なrecipe投影・比較の狭い共有口で、認証やhashの別正本ではない。

この接続だけでPhotoLibraryの編集capabilityは開かない。共有autosaverのdebounce前stage、実mask/base/versions、各hostへの注入と正式環境での受入を続ける。
