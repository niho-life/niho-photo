# 作業座席と topic branch の運用

この文書は座席選びと branch の切り替え方を定めます。座席の固定パスや秘密情報・公開範囲などの規則は [AGENTS.md](../../AGENTS.md)、PR と検証は [CONTRIBUTING.md](../../CONTRIBUTING.md) と [公開 CI の実行契約](../ci/public-ci.md) が正です。

## 座席の状態

親フォルダにある root clone `niho-photo/` は `main` 専用です。作業は既存の `niho-photo-1/`〜`niho-photo-8/` で行い、座席や clone を増やしません。

`node scripts/seat.mjs status` は次のように読みます。

- `空き`: branch がなく、変更や保存先のない commit もありません。
- `再利用可`: 作業差分のない topic branch があります。branch があるだけでは使用中と判断しません。
- `使用中`: 未コミットの作業差分があります。別の作業へ切り替えません。
- `要確認`: branch のない detached commit があります。先に branch を付けて保護します。
- `なし`: その固定座席は現在ありません。新設しません。

一座席一セッションを守り、同じ座席を同時に編集しません。branch 名だけでは同時使用を判断できないため、同じ座席で並行する書き手がいないことを作業の割り当てで確認します。

## 新しい作業を始める

```sh
node scripts/seat.mjs status
node scripts/seat.mjs start 4 raw-preview-tuning
```

`start` は clean な座席なら現在の branch があっても使えます。新しい `feature/<topic>` を最新 `origin/main` から作り、以前の branch ref は消さずに残します。branch 名が既にある場合は停止し、既存 branch を上書きしません。

dirty な座席は変更を守るため停止します。detached HEAD に remote 未到達の commit がある場合も、その commit に保存先の ref を付けるまで止まります。

## 作業終了と branch の保持

```sh
node scripts/seat.mjs release 4
```

`release` は clean な座席を `origin/main` に detach します。topic branch 自体は削除しません。未 push commit がある branch も local ref に残るため、必要なら後からその branch に戻れます。別端末にも必要な commit は push してください。

stash と force push は使いません。push 前には `git fetch` し、共有 branch の先頭を確認します。
