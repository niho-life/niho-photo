# NIHO photo 本人クラウド契約 v2

Photo Epic #192 / C00 #193 の型・合成fixture・不足APIの正本。このpackageは **client port** であり、HTTPサーバー、認証、storage、製品の接続完了を提供しない。

- [製品・operation対応表・writer表](../../docs/architecture/personal-photo-cloud.md)
- [型](src/v2.ts) / [応答fixture](fixtures/v2.ts) / [負例](fixtures/security-cases.json)
- [既存backendとの対応](operation-coverage.json)
- [監査した公開ソースとSHA-256](provenance.json)

旧Editorの `@niho/photo-library-contract` v1から公開済みの型・合成fixtureだけを一度抽出した。製品境界、即時削除、上限、操作の意味が異なるため、別package名 `@niho/photo-personal-cloud-contract` のv2とする。旧 `/api/photo/v1` のHTTP配置・認証client・DBをコピーしない。ここに新しいHTTP prefixや実装済みの架空APIは定義しない。実transportは既存本人写真backendへ対応させるC02の責務で、未実装operationは利用不可とする。

以後の変更はPhoto側だけで保守する。旧Editorのsourceやcloud SDK 0.1.2を双方向同期せず、新adapterの移設・公開配布はC02/C08で監査・版・hashを固定する。旧共有リンク用 `packages/niho-cloud-contract` は独立した契約のまま維持する。

```sh
node --test scripts/ci/personal-photo-contract.test.mjs
```

rootから実行する。`scripts/ci/*.test.mjs` の既存required CIに含まれる。型・型の負例は既存Photo editingのtypecheckに含まれる。fixtureの形式/renderer能力、ticket、処理中状態は期待値であり、未設定の本番能力や本番認証へ注入しない。実backend・decoder・端末の合格証拠はC07/C08で別に残す。
