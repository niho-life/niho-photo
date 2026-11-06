# 常設Macの接続用ソフト core

Epic #240 / B03 #244 の公開側。所有者の常設 Mac にある既存の写真フォルダを、その場で NIHO のライブラリにする接続用ソフトの、OS に依存しない core。契約は [`@niho/photo-library-sharing-contract`](../photo-library-sharing-contract/)（B00）、控えの同期・索引の復旧・export は [`@niho/photo-hosted-library`](../photo-hosted-library/)（B01）を使う。

## 境界

- NIHO への外向きの通信だけ（[接続用ソフトの経路 `/connector/v1`](../../docs/architecture/photo-library-sharing.md)）。外から Mac へ入る入口は持たない。
- 元データは read-only。動かさない・書き換えない・複製しない。NIHO へ送るのは索引（不透明な `localKey`・大きさ・hash・利用可否）、控えの ack、描画 job の出力（プレビュー・完成写真）だけ。
- OS 依存の部分は port に分ける（`src/ports.ts`）。Linux・Docker・NAS（B11）も同じ protocol と core を使う。

| port | 役割 | Mac での実装 |
| --- | --- | --- |
| `CredentialVault` | 端末資格・登録中と回転中の秘密・`localKey` の salt | Keychain |
| `RootFileSystem` | 登録した root の下の通常ファイルだけを read-only で読む。symlink を辿らず、root 外を拒否し、command を実行しない。root は登録時の実体（real path と identity）に固定し、差し替えや symlink を未接続として扱う | 配布版は directory descriptor 相対（各要素を `O_NOFOLLOW` で開く）の native 実装。`node/index.ts` は開発・計測用で、親 directory の差し替えを狭めるが閉じきれないため配布の境界には使わない |
| `LocalIndexStore` | `localKey` → 実ファイルの対応と走査の checkpoint | Application Support の file |
| `ReplicaStore` | NIHO の正本の控え（B01） | Application Support の file |
| `PowerAssertions` | job・同期の間だけ休止を抑え、終わったら戻す | IOPM assertion |
| `JobExecutors` | 描画（プレビュー・完成写真・原寸書き出し） | B07 #248 が差し込む |
| `OutputUploader` | 出力を upload ticket へ送る | #195 の transfer |

## 中身

- **登録・端末資格**（`credentials.ts`）
  - poll secret と端末資格を接続用ソフトが乱数で作り、SHA-256 だけを送る。NIHO から bearer は返らない。
  - 秘密は送信前に vault へ書くので、開始・照会・回転の応答を失っても同じ key で再送できる。
  - 回転すると前の資格は止まる。回転の応答を失ったら、次の資格で確かめてから同じ key で再送する。
  - 資格の操作は1本ずつ順に実行するので、回転の途中に切断しても切断が後に勝ち、資格は戻らない。
  - 資格を拒まれたら失効として資格を消す。元データ・索引・控えは残す。
- **索引**（`indexer.ts`）: metadata を先に読み、hash は後回しにする。
  - 走査は directory ごとに checkpoint を残すので、中断・休止・再起動から続けられる。一覧できない directory はその pass では飛ばし、その下を missing にしない。
  - ファイルの同一性は大きさ・device と inode・ns 精度の mtime と ctime（`changeToken`）で見る。
  - 走査の順序: 一覧に出す → hash を取る → hash を NIHO へ送る。1回の tick で使う量に上限がある。
  - hash を読んでいる間にファイルが変わったら捨て、後でやり直す。
  - `localKey` は HMAC-SHA256(salt, rootId, 相対 path) で、path も inode も明かさない。
  - 未 mount の root は「未 mount」として残し、削除扱いにしない。mount 済みの root で消えたファイルは「missing」として届ける。
  - 中身が変わったり差し替えられたりした元データは、NIHO が新しい source 世代にする。除外済みの写真は hash・描画・再登録をしない。
- **描画 job**（`jobs.ts`）
  - 実行できる目的の job だけを claim する。
  - 元データは自分の索引から read-only で開く。executor には一度きりの順読みとして渡し、読んだ bytes をその場で hash する。読み残しも最後まで読んで、job が束縛する hash と一致しなければ出力を捨てる（メタデータを変えない書き換えも描画しない）。
  - 出力の大きさと SHA-256 を照合してから upload・確定する。休止は job の間だけ抑える。
  - claim・出力の開始・確定は key 付きで、応答を失ったら同じ key で1回だけ送り直す。claim は同じ job を返し、lease の期限切れまで job を止めない。再送した開始は ticket を返さないので、`renewOutput` で ticket を取り直して送り直す。
- **service**（`service.ts`）
  - tick ごとに heartbeat → 控えの同期（B01）→ 走査 → hash → 索引の送信 → job の順で進める。
  - 休止の前に `sleeping` を知らせ、復帰後は控えの差分だけを取り込む。
  - 索引を失ったら、B01 の `recoverLocalIndex` で一致する写真だけを再紐付けし、合わない元データは保留にする（`hold: "sourceMismatch"`）。
  - 復旧時に届かなかった元データは、戻ったときに NIHO の hash と照合する。
  - 切断は資格だけを消す。

## 試験と計測

```sh
npm run test --workspace packages/photo-hosted-connector
npm run typecheck --workspace packages/photo-hosted-connector
npm run lint --workspace packages/photo-hosted-connector
node packages/photo-hosted-connector/bench/scan-hash.mjs --files 256 --size 16777216 --tiny 20000
```

試験は、合成の NIHO（B01 の正本 mock に登録・端末資格・heartbeat・job を足したもの）・合成のファイル系・実際の一時フォルダ（node adapter）で行う。

- 登録: 一回限り、期限切れ（承認後を含む）、別 owner、応答喪失
- 端末資格: 回転、旧資格の拒否、失効、回転中の切断
- ファイル: symlink、root 外、root 自体の symlink と差し替え、ファイルの差し替え、メタデータを変えない書き換え、未 mount→再 mount、missing、変更、一覧できない directory
- 索引: 中断からの再開、除外、再起動、索引の再構築（保留・戻ったときの照合）
- 常駐: 休止→復帰の差分、job の出力だけの upload、休止の抑止と解放

計測は合成データ（乱数の bytes）だけで行い、実写真を使わない。結果は PR と Issue に記録する。

## 残り

- 配布版の Mac native 部分: 常駐（launchd の LaunchAgent・ログイン時の起動・再起動からの復帰）、Keychain の `CredentialVault`、IOPM の `PowerAssertions`、休止・復帰の通知、フォルダの登録画面、署名・公証付きの配布（既存の配布経路 #201）。
- 描画の executor（B07 #248）。この package は差し込み口だけを持つ。
- 本物の正本 API と端末資格の保管（非公開側）への接続。
