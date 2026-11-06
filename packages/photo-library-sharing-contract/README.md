# NIHO photo 保管場所・共有アルバム契約 v1

Epic #240 / B00 #241 の型・状態遷移・権限表・合成fixture・負例の正本。このpackageは **client/connector port** であり、HTTPサーバー、DB、storage、認証、製品の接続完了を提供しない。

- [契約の説明・writer表](../../docs/architecture/photo-library-sharing.md)
- [型・語彙・権限表・操作表](src/v1.ts) / [権限判定・表示用の射影・世代照合・metadata規則](src/policy.ts) / [v2互換adapter](src/compat-v2.ts)
- [合成fixture](fixtures/v1.ts) / [負例vector](fixtures/security-cases.json) / [型の負例](fixtures/type-boundary.ts)
- [操作ごとの担当Issueと未接続の記録](operation-coverage.json)

本人専用の `@niho/photo-personal-cloud-contract` v2 は変更しない。v2 の owner の読み替えや `albums: false` の置換で共有を足さず、追加契約 v1 と一方向の互換adapterで接続する。#195 の upload ticket・content stream、#196 の完全recipe・競合、#197 の renderer 能力は v2 の型を再利用し、portを重複実装しない。

| export | 内容 |
| --- | --- |
| `.` | 語彙（`LIBRARY_KINDS`・`ALBUM_ROLES`・`ALBUM_ITEM_KINDS`・`ALBUM_ITEM_STATES`・`HOST_CONNECTOR_STATES`）、モデル、`ALBUM_PERMISSIONS`、操作表、エラーと再試行、状態遷移 |
| `./policy` | 参照判定。serverの実装・conformance runner・hostの表示判断が共有する。認可の正本はserverの台帳 |
| `./compat-v2` | 本人の v2 library を `nihoCloud` として投影し、v2 scope を本人の NIHO クラウドだけに限る |
| `./fixtures` / `./cases` | 合成の応答例と負例。実API・実backend・実写真の証拠ではない |

```sh
npm run test --workspace packages/photo-library-sharing-contract
npm run typecheck --workspace packages/photo-library-sharing-contract
npm run lint --workspace packages/photo-library-sharing-contract
```

公開CIの `Photo editing` scope がこの3つを実行する。fixtureとvectorの合格は、実backend・常設Mac・配備・配布の受入とは別に記録する。
