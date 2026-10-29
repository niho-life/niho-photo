# 空マスク研究ツール（#158）

NIHO 独自の小型 U-Net をゼロから学習し、推論結果を独立した正解マスクで評価する。学習済み重みの流用はしない。現時点の出力は研究用で、製品への組み込みや品質合格を意味しない。

## データの扱い

写真・マスク・個体のメタデータ・ライセンス台帳・学習重みは非公開領域だけに置く。この公開リポジトリへ追加しない。各画像について権利、原本とマスクのハッシュ、アノテーション確認、撮影系列を非公開台帳に記録する。近似重複と同じ撮影系列は train / validation / 独立評価の間で分ける。

`DATA/input/<id>.png` と `DATA/label/<id>.png` を用意する。露出情報がある場合だけ `DATA/input/<id>.json` に `{"ev100": 12.0}` を置く。ラベルは空を白、それ以外を黒にする。`validation-ids.json` は撮影系列ごと訓練から外した画像 ID（拡張子なし）の JSON 配列とする。省略時のランダム分割は学習中の監視専用で、品質判定には使えない。

## 実行

重い学習・推論・評価は STUDIO で実行する。Python 3.11 以降の仮想環境で `pip install -r requirements.txt` を行う。

```sh
python train_sky.py train --data "$DATA" --validation-ids "$VALIDATION_IDS" --epochs 60 --out "$RUN"
python train_sky.py predict --run "$RUN" --input "$HOLDOUT_INPUT" --out "$PREDICTIONS"
python evaluate.py --work "$HOLDOUT" --scenes "$HOLDOUT/scenes.json" --method own="$PREDICTIONS"
python train_sky.py export --run "$RUN"
```

`evaluate.py` は `HOLDOUT/reference/<id>.png` と `scenes.json` の `[{"id":"...","categories":["sunset"]}]` を読み、IoU・境界 F・空なし写真の誤検出率を計算する。独立評価セットを調整に使った場合は、別の未使用セットを品質判定に用いる。#141 の評価セットはモデルを固定してから確認する。

`export` は BatchNorm を畳み込んだ研究用の重みとレイアウトを非公開の `RUN` に書く。Rust/wasm 実装との一致、ボタンから結果までの実機時間、空なし写真の誤検出率を確認するまでは製品へ載せない。
