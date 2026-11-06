# 常設Macライブラリの控え・索引復旧・export/restore の core

Epic #240 / B01 #242 の公開側。常設 Mac の接続用ソフト（B03 #244）が埋め込む、純粋な TypeScript の core。契約は [`@niho/photo-library-sharing-contract`](../photo-library-sharing-contract/) v1（B00）に従う。登録・常駐・既存フォルダの走査・プレビュー送信・本物の正本 API への接続は含まない。

## 正本と控え

補正・mask・アルバム定義・索引の正本は NIHO にある。常設 Mac は元データと控え（replica）だけを持つ。控えで正本を上書きせず、控えを正本へ昇格させない。

| 部品 | 内容 |
| --- | --- |
| `createHostedReplicaSync` | `canonicalRevision`（NIHO で観測した最大の世代。古い heartbeat では下がらない）と `replicaRevision`（控えに永続化した世代）を分けて持つ。復帰時は控えの世代からの差分だけを取り込み、1ページずつ原子的に適用する（`ReplicaStore.apply` の CAS）。NIHO より先に進んだ控えや、tombstone が詰められた範囲は snapshot から作り直す。作り直しは別領域に組み立て、最後に入れ替えるので、途中で失敗しても前の控えが残る。mask は SHA-256 と大きさを照合してから控えに入れる。呼ぶのは `connector.pullReplica`・`connector.getReplicaContent`・`connector.ackReplica` だけで、書き戻しの経路はない。ack は世代ごとに決まった key で送るので、応答を失っても二重に記録されない |
| `recoverLocalIndex` | 索引を失ったあと、控えと元データから写真・補正・mask・アルバムを組み直す。登録済みの `localKey` のファイルが大きさと SHA-256 まで一致したときだけ再紐付けする（`relinked`）。食い違いは `sourceMismatch`（大きさ・hash・hash 未記録）、元データに届かない間は `sourceUnavailable`（未 mount・ファイルなし・読めない）。除外済みの写真には触れない。source 世代を作らず、NIHO の識別をそのまま `connector.putIndex` 用に返す |
| `buildMetadataManifest` / `buildFullExport` / `verifyFullExport` | schema・engine・完全 recipe・mask・アルバム定義・ID・hash を持つ export。<br>full export は元データと mask を hash で照合してから書き、一致しない元データは含めずに報告する。参照する mask が1つでも欠けたら manifest を書かない。<br>restore 前に、アーカイブの実体を manifest の hash で照合する |
| `parsePortableManifest` / `findAccessMaterial` | export を入れ子まで閉じた形で検査する（`PORTABLE_MANIFEST_SHAPE`）。<br>補正の open な JSON の中も含め、鍵・token・session・ticket・署名 URL・招待・在籍を拒否する（`PORTABLE_ACCESS_MATERIAL`） |
| `planRestore` | restore は本人の library にだけ行う。<br>補正を戻すのは、hash が記録済みで一致し、その世代に対して保存された写真だけ（未記録は `source_missing`、違いは `hash_mismatch`）。<br>NIHO の方が新しい補正・アルバムは残す（`keptNewer`）。mask が欠けた補正は戻さない。<br>別の library の export は新しい ID で取り込み、元の ID へ結び付けない。在籍は一切戻さない（`membershipsRestored: 0`） |

保存の確定（mask の参照・source 世代・expectedRevision・冪等な再送）は NIHO 側の意味で、B00 の `decideHostedRecipeSave`・`compareIdempotency` に従う。`test-support/canonical.ts` はその合成 mock で、非公開側の実装が守る挙動を試験で固定する。本番の正本ではなく、何の権限も与えない。

## 試験

```sh
npm run test --workspace packages/photo-hosted-library
npm run typecheck --workspace packages/photo-hosted-library
npm run lint --workspace packages/photo-hosted-library
```

fault injection として、次を合成の正本 mock とメモリ上の控えで試験する。

- 保存の commit 前の喪失と、commit 後の応答喪失
- ack の応答喪失
- 控えのページ途中の書き込み失敗
- 休止中の保存と復帰後の差分
- 圧縮と、snapshot の途中での圧縮
- 古い heartbeat と、順序の乱れた・重複した・止まったページ
- mask の欠落・破損
- 元データの到着前（hash 未記録）
- 除外後に遅れて届く索引・保存
- 索引の喪失と、未 mount・読めない元データ

## 残り

- 本物の正本 API（非公開側）と B03 の接続用ソフトへの接続。`ReplicaStore`・`SourceScanner`・`ExportSink` の永続実装は B03 が用意する。
- 常設 Mac の library をクライアントで編集する経路への #196（`@niho/photo-cloud-sync`）の durable draft の接続。今の sync core は v2 の Library・Photo に結び付いているので、recipe の保存先を port にしてから接続する。
- 1TB 規模での走査・hash の並列度と、export の stream 化は B03 で計測して決める。
