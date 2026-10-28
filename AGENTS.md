# NIHO photo の作業ルール（AI セッション向け）

人向けの PR の進め方は [CONTRIBUTING.md](CONTRIBUTING.md)、公開 CI は [docs/ci/public-ci.md](docs/ci/public-ci.md) を正とする。ここには、メンテナーの手元で動く AI セッションが守ることだけを書く。

## 作業場所は固定の座席だけ（owner 決定 2026-10-28）

- 親フォルダに、root の clone `niho-photo/` と、その worktree の座席 `niho-photo-1/`〜`niho-photo-8/` を固定で置く。**新しい clone や worktree を作らない**。座席が足りないときは増やさず owner に相談する
- root は main 専用。root で branch を切らない・編集しない
- 1 座席 ＝ 1 セッション。`node scripts/seat.mjs status` で「空き」の座席（branch なし・変更なし）を選び、`node scripts/seat.mjs start <番号> <topic>` で `feature/<topic>` を `origin/main` から切る。作業はその座席の中だけで行う
- 「使用中」の座席は他のセッションのもの。触らない
- PR が merge されたら（閉じたら）`node scripts/seat.mjs release <番号>` で座席を空ける。変更が残っている・push していない commit があるときは空かない
- stash・force push はしない。push の前に `git fetch` して remote の先頭を取り込む（別のセッションが同じ branch に CI の修正を積むことがある）

## 共通の決まり

- 画素を変える修正は engine を上げる（[packages/develop-engine/README.md](packages/develop-engine/README.md)）。速さの修正は同じ bytes のまま速くする
- 公開 manifest: 既存ファイルを編集したら `node scripts/update-publication-manifest.mjs --path <path> --reason <理由>`、新しいファイルは `docs/security/publication-manifest.json` の `generatedFiles` に `{ path, sha256, origin }`。`npm run verify:publication` が「違反なし」になるまで
- 検証: 対象の test、`npm run lint`、`npm run format:check`、`npm run verify:publication`、`git diff --check`、`gitleaks dir --redact=100 --ignore-gitleaks-allow --no-banner .`。重い全体は公開 CI（`Public CI required`）に任せる
- Mac mini では重い検証が exit 97 で止まる（`docs/ci/public-ci.md`「Mac mini のローカル重処理ガード」）。Rust・wasm・Tauri の build と重い計測は、push した clean な HEAD から Mac Studio へ送る
- 文言は `packages/photo-editing/src/photo-editing-copy.ts` に定数で足す（画面に英語の識別子を出さない）
- PR は ready で作り、`.github/PULL_REQUEST_TEMPLATE.md` を埋める。完了する Issue は `Fixes #<番号>`、途中なら `Refs #<番号>`。秘密・内部 URL・実写真・個人情報を Issue・PR・CI ログに書かない
- 着手・計測・完了は Issue へのコメントで残す
