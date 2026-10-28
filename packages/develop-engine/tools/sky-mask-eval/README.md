# sky-mask-eval — 空のマスクの検出方式を比べる（#128）

空の面（`docs/local-adjustments.md`「面（ブラシ・被写体・空）」と同じ 8bit グレーの PNG）を作る方式を、実装の前に数字で比べるための検証用の道具。**製品には入れない。**

- A（自前）: `sky_a.py`。学習した重みを使わない。色・位置・なめらかさで種を作り、空の色の場（位置の 2 次式）に合う画素を広げ、guided filter で境目を整える
- B（COCO panoptic の学習済みモデル）: `run_b.py`。Mask2Former / DETR の `sky-other-merged` の確率。重みは実行する機械（Mac Studio）の Hugging Face のキャッシュに置くだけで、repo には入れない（`.onnx`・`.mlmodel`・`.mlmodelc` は publication policy が拒否する）
- C（skyseg）: 学習データの由来を確かめられないので動かさない

## 写真と正解の面は非公開

owner の写真・正解の面・見比べの画像・場面の一覧（`scenes.json`・`annotations.json`）は、非公開の作業フォルダ（Mac Studio と hihirohub）にだけ置く。repo・Issue・PR・CI ログには載せない。公開してよいのは集計した数字だけ。

## 前提

- Python 3.13 の venv に `numpy`・`pillow`・`scipy`、B と `rank.py` には `torch`・`transformers`・`timm`、HEIC には `pillow-heif`（任意）。RAW は `exiftool` で埋め込みの JPEG を読み、露出（`prepare.py` の `ev100`）も `exiftool` で読む
- 重い処理（モデルの実行・ダウンロード）は Mac Studio で回す。Mac mini では回さない

## 手順

```sh
T=packages/develop-engine/tools/sky-mask-eval
W=<非公開の作業フォルダ>
python3 $T/pool.py    --pool $W/pool --out $W/sheets                 # 候補の一覧（番号つきのシート）
python3 $T/rank.py    --pool $W/pool --out $W/shortlist              # 大きいライブラリを種類ごとに絞る（CLIP。選ぶ手伝いだけ）
python3 $T/prepare.py --pool $W/pool --scenes $W/scenes.json --work $W   # input/<id>.png（長辺 1024・metadata なし）
python3 $T/sky_a.py   --input $W/input --out $W/A
python3 $T/run_b.py   --model facebook/mask2former-swin-large-coco-panoptic --input $W/input --out $W/B-M2F-L
python3 $T/refine.py  --input $W/input --map $W/B-M2F-L --out $W/B-M2F-L-gf     # B + guided filter
python3 $T/annotate.py build  --work $W --annotations $W/annotations.json      # 正解の面 reference/<id>.png
python3 $T/annotate.py review --work $W --scenes $W/scenes.json --mask reference --out $W/review --grid
python3 $T/evaluate.py --work $W --scenes $W/scenes.json --method A=$W/A --method B-M2F-L=$W/B-M2F-L
```

A の時間は Rust 版（`sky_a.rs`。依存なしの 1 ファイル。組み方は先頭のコメント）で測る。`bench_a.py` が native と wasm（`bench_a.mjs`・Node）で時間とメモリを測り、Python 版と出力を突き合わせる。

## 正解の面の作り方

手で描く代わりに、出発点の面（`base`。比べる方式の出力でもよい）に手で多角形（`sky` / `ground`）を足して大きな誤りを直す。`decide` の多角形（枝越し・窓越しの空）の中は、その写真の空の色と地上の色（k-means）の近い方に決め、`thin` では近くの空より暗い画素（電線・細い枝）を空から外す（`--coarse` で外さない版も作れる）。最後に境目の帯（既定 6px）を近くの空と地上の平均の色の近い方に決め、境目を出発点の面の形から切り離す。全場面を重ね描きのシート（`review`）で目で確かめる。出発点に使った方式の数字は、その分だけ有利に出る。

## 測るもの

- IoU（空の面。出力を正解の大きさへ双一次で合わせて 0.5 で切る）、境目の F 値（Perazzi et al. 2016。既定は 3px 以内を一致とする）、場面の種類ごとの平均
- 1 枚の時間（長辺 1024）・メモリ・配布物の大きさ。Studio の数字は受入値ではない（受入は MacBook Air M2 8GB の実 UI）

## 結果

2026-10-28 の比較（owner の写真 30 場面）と推す案は #128 のコメントにある。
