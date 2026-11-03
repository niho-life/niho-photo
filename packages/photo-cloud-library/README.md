# 本人クラウドの共通PhotoLibrary adapter

C02 / Photo #195。既存の `niho-photo-editing` の編集面を、`@niho/photo-personal-cloud-contract` v2の本人用portへ接続する。原本・owner・容量・補正revision・物理purgeの正本は既存backendに置く。

read/delete/content adapterを実装し、合成fixture53件で検証している。実backend transport、原本転送の実storage照合、補正・mask・名前付き版の書込み、Mac native IPC、正式host・端末受入は完了していない。

## ホストの責任

`createPersonalPhotoCloudLibrary` へ、検証済み本人に拘束したclient、本人snapshotと変更購読、実renderer能力、engine assets、実presets、明示的なメモリ予算を渡す。未認証時に別clientへfallbackしない。認証・libraryの切替時は古いbindingを直ちに失効させる。

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
