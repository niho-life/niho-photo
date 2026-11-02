# 本人クラウドの描画入力と固定 renderer

C04 #197 の入力検証と実 SDK 接続。認証・DB・原本正本・decoder・queue・job publish・purge を実装しない。能力の交差と canonical recipe 検証は C02 が所有する。本 package の factory が存在するだけでは、本番の形式能力を有効にしない。

## 境界

- root は locator/credential のない C00 metadata selector。`recipeWritable` は C02 が実 host と server の能力を交差した結果を渡す。未知設定を落とさない。saved base と canonical working-copy が合わなければ入力を作らない。
- `./browser` は C00 `content.get` の全 asset を明示した bytes 予算内で読む。range、size、MIME、SHA-256、scope、abort、deadline を照合する。永続 cache は持たない。C01 の捕捉 signal を渡す。解決済み要求の signal だけに依存せず、host は scope/operation の失効イベントで保持 bytes と engine も破棄する。取得した bytes は解放する。
- `./server` は既存 backend が owner と immutable generation を照合して開く bytes を受け、固定 SDK の隔離 child で thumbnail/preview を生成する。入力の hash/size/base/metadata/mask を検証し、固定 error code のみ返す。backend は結果を公開する transaction で owner、親 session の失効世代、lifecycle、lease/deadline、原本 generation、recipe revision/hash、mask、renderer manifest を再照合する。
- C02 の `MediaRecipeValidator` は完全 recipe の canonical settings、hash、base、参照 mask を返す。provider はその結果を hash と照合し、インストール済み SDK の unknown-field、engine、base/metadata、数値・範囲 validator も通す。別の canonical JSON / field whitelist を本 package に作らない。

## 作業コピーと解像度

canonical base がある写真には、その base の作業コピーを使う。RAW・HEIC/HEIF・TIFF の原本を browser の汎用 raster decoder へ渡さない。原本の直接描画は SDK の対応する JPEG/PNG と明示的な bytes/pixels 上限内だけ。

既存 `photo-editing/develop-engine/develop-render-input` の `openDevelopWorkingCopy` と `exportDevelopJpeg` が host の開口を所有する。`jpeg8` は raster の `open`、`png16` は metadata 付き `openWorkingCopy`。この違いのために JPEG を PNG へ再変換しない。完全 metadata と saved recipe/base は保持する。

作業コピーの実寸法が書出し上限になる。原本の寸法を名乗らない。preview は recipe revision と renderer manifest が一致するときだけ最新として表示する。古い preview と、同じ原本/base に拘束された canonical working-copy の利用可否は別に判定する。

## 固定 SDK と出典

初期版は公式 `photo-sdk-v0.1.7`、source `5ff21a28ae5f7a0e3a64a98b1ef31a7ca523b2a6`、engine `niho-14`、crate `0.27.0`。`sdk-baseline.json` の package integrity と 実行入口を選ぶ package metadata と compiled contract files、runtime manifest/files を検証し、未検証の code を読まない。pixel algorithm を変更しない。

public Editor `d778248ff772496f131b347967b5a2c851899b31` の SDK baseline、PNG inspector、合成 PNG/JPEG fixture を監査して再利用した。元 path/hash は `provenance.json`。旧 store/queue/purge/DB adapter と非公開 Git 履歴は持ち込まない。新規の入力/provider 接続コードは Photo 所有。

## 検証と未受入

対象 test、strict typecheck、lint を package 内で実行する。重い native/WASM build は公開 CI に任せる。公式の既存 WASM と小さな合成画像による decode/render 試験は、実 storage、RAW decoder/calibration、実機 Safari/PWA のメモリ、claim/publish/即時 purge の受入とは別に記録する。C02/C04/C07/C08 の実接続が揃うまで #197 を close しない。
