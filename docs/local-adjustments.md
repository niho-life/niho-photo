# 部分補正（マスク）（developSettings の `masks`）

Epic #31 の契約。線形・円形・ブラシ・被写体・空の「面」で、全体と同じ補正を局所に当てる。このファイルが保存の形・座標・面の式・混ぜ方の正で、Rust（`packages/develop-engine/crates/niho-develop`）と TypeScript（`packages/photo-editing`）は同じ fixture でこれに合わせる。

| 子 Issue | 範囲 |
| --- | --- |
| #65 M1 | この契約と、設定の読み書き（検証）。描画はしない |
| #66 M2 | 線形・円形の面と、混ぜる描画（native / wasm の画素一致） |
| #67 M3 | UI（マスクタブ・画像の上の操作） |
| #68 M4 | ブラシ。面の保存と受け渡し（被写体・空の面も同じ口で読む） |
| #69 M6 | Lightroom XMP の読み（線形・円形。ブラシ・AI などは知らせるだけ。下の「Lightroom の XMP の読み」） |

被写体・空の面を作って保存する側（Mac ワーカー・API）は非公開側（`niho-coliving/niho-app#19218`）で、ここでは「面が来れば同じ経路で混ざる」ところまでを扱う。

## 保存形

`developSettings.masks` は最大 8 枚の配列で、1 枚でもあれば `v` を要求する（下の「版と互換」）。空配列は無いのと同じで `v` を上げない。

```json
{
  "v": 5,
  "masks": [
    {
      "id": "mask-a1",
      "kind": "linear",
      "zero": { "x": 0.5, "y": 0.2 },
      "full": { "x": 0.5, "y": 0.5 },
      "adjust": { "exposure": -0.7, "highlights": -30 }
    },
    {
      "id": "mask-b2",
      "kind": "radial",
      "invert": true,
      "center": { "x": 0.5, "y": 0.45 },
      "radius": { "x": 0.3, "y": 0.2 },
      "angle": 15,
      "feather": 50,
      "adjust": { "exposure": 0.4, "saturation": 10 }
    },
    {
      "id": "mask-c3",
      "kind": "brush",
      "surface": { "id": "<sha256 の 16 進 64 文字>", "width": 1024, "height": 683 },
      "adjust": { "shadows": 25 }
    }
  ]
}
```

- 共通: `id`（1〜64 byte の ASCII `[A-Za-z0-9_-]`・配列内で一意）、`kind`（`linear` `radial` `brush` `subject` `sky`）、`adjust`（必須。空は何もしない）、`enabled`（省略は `true`）、`invert`（省略は `false`）。`enabled: false` は描かない（編集は残す）。
- `linear`: `zero`（面が 0 の点）と `full`（面が 1 の点）。`x` `y` は −1〜2（枠の外にも置ける）。2 点の距離は 0.001 以上。
- `radial`: `center`（0〜1）、`radius`（楕円の半軸。`x` は幅・`y` は高さに対する割合で 0.005〜1.5）、`angle`（度。−180〜180。時計回り）、`feather`（0〜100）。
- `brush` `subject` `sky`: `surface`（`id` は面の PNG の sha256 の小文字 16 進 64 文字、`width` `height` は 1〜4096）。`kind` の違いは由来（利用者が描いた／検出した）を表すだけで、描画は同じ。
- `adjust`（局所の補正。値は全体への**差分**）は次のキーだけを持てる。範囲は全体の同じキーと同じ。
  - `exposure`（−5〜5）、`contrast` `highlights` `shadows` `whites` `blacks`（−100〜100）
  - `texture` `clarity` `dehaze`（−100〜100）、`vibrance` `saturation`（−100〜100）
  - `relativeTemperature` `relativeTint`（−100〜100）
  - `hsl`（全体の `hsl` と同じ形・差分。各値 −100〜100）
- 各マスク・各入れ子は上のキーだけを持つ厳密な形とし、欠落、未知キー、種類に合わないキー、非有限値、範囲外、重複 id、9 枚以上を Rust と TypeScript の双方で拒む。
- 正規形（`to_value` / `writeDevelopMasks`）: キー順は上の例の順（`id` `kind` `enabled`（`false` のときだけ）`invert`（`true` のときだけ）、種類のキー、`adjust`）。`adjust` は 0 の項目を書かない。`adjust.hsl` は全体の `hsl` と同じ交互配列（帯の順は赤→マゼンタ。0 の帯は書かず、帯の中も 0 でない `hue` `saturation` `luminance` だけ）。TypeScript は数値を小数 6 桁に丸めて書く。Rust の `to_value` は JSON のキーが辞書順になるため、キー順はこの TypeScript の `writeDevelopMasks` が保ち、Rust は値の等価で突き合わせる（`tests/fixtures/masks/settings-cases.json` の `canonical`）。
- 設定全体の上限（Rust の 64 KiB・下書きの 32 KiB）に面の画素は入れない。ブラシ・被写体・空は `surface` で参照するだけにし、undo の 100 版にも面を載せない。

## 座標

マスクは**作業画像**（EXIF の向きを反映済み・`geometry` の回転／反転／遠近／角度補正／切り抜きの前）の上に置く。`x` `y` は作業画像の幅・高さに対する 0〜1（y は下向き）。切り抜き・回転・反転・遠近を変えても、マスクは画像の内容に付いたまま動く。

描画は出力の画素 `(i, j)` の中心 `((i + 0.5) / W, (j + 0.5) / H)` を、切り抜き（`geometry.rs` の座標・`frame.rs` の plan）で作業画像の位置 `(u, v)` に戻して面を評価する。TypeScript の `geometryOutputToSource` と同じ写像（切り抜き枠の上の位置〔遠近があれば補正後の枠の上〕。角度つきで角が枠から出る切り抜きは中心の回りに縮めて収め、遠近と「余白を埋める」（`constrain`）があれば描画と同じ `constrain_corners` で補正した写真の中に収める → 遠近の逆写像で枠へ戻す → 反転を戻す → 回転を戻す。幾何が無い・恒等なら `(u, v)` は出力の位置そのもの）で、Rust（`local_render::SourceMap`）と TS は同じ fixture（`tests/fixtures/masks/geometry-map-cases.json`。TS のテストがこの関数から作り、関数とずれたら落ちる。遠近と `constrain` の有無の組み合わせと、描画の大きさの画素の中心での面・描画の突き合わせを含む）で突き合わせる。要求は 1e-9 以内、実測の差は 1e-12 未満。写像は倍精度で計算する。遠近で空いた隅（`constrain` が off）は TS と同じく 0〜1 の外の位置になり（描画はそこを写真の端の画素で埋める）、消失線の向こうの点（TS は null、`SourceMap::checked_source_of` は `None`）は、面では描画の標本点と同じく同次座標を下限で止めたその方向の遠くの位置で評価する（`SourceMap::source_of` は全域で値を返し、隣の点と連続）。

形の計算は、作業画像の幅 `Ws` と高さ `Hs` から `A = Ws / Hs` を取り、長さの単位を高さにそろえた座標 `X = u·A, Y = v` で行う。円形が回しても楕円のままで、縦横比に引き延ばされない。`Ws` `Hs` と写像の作業画像の寸法は、JPEG / PNG の原本では EXIF の向きを反映した元の寸法（縮めて読んだ Session・書き出しの one-shot・プリセットの見本でも同じ値。`RasterInfo.source_width / source_height`）、作業コピーではその PNG の寸法（作業コピーは元の寸法を持たないため。2560 と原寸の作業コピーでは丸めの分だけ `A` が違い、差は半径 0.3 の円で 4000px の高さに対して 1 画素未満）。描画そのもの（切り抜きの plan）は読んだ寸法で行うので、縮めて読んだときのマスクの位置は内容に対して 1 画素未満ずれうる。

## 面の式

画素ごとの面の値 `m`（0〜1、f32）。画素ごとの計算は IEEE 754 の `+ − × ÷ sqrt` だけで、三角関数などは**マスク 1 枚につき 1 回**（libm）求めて使う。native と wasm で同じ結果にするためで、`fastmath` や FMA は使わない。実装（`local_render.rs`）は、上の写像で求めた `(u, v)`（f64）から `X = (u·A) as f32`・`Y = v as f32` を作り、形の定数（`Z` `d` `d.x² + d.y²`、`c` `a` `b` `cosθ` `sinθ` `max(f, 0.002)`）はマスクごとに f64 から f32 にして、画素ごとの式を f32 で計算する（角度は `angle·π/180`）。重みは `floor(m·65536 + 0.5)` を f64 で求め、`u32`（0〜65536）で持つ（`m = 1` の 65536 を表すため 2 byte に詰めない）。

- 線形: `Z = (zero.x·A, zero.y)`、`F = (full.x·A, full.y)`、`d = F − Z`、`t = ((X − Z.x)·d.x + (Y − Z.y)·d.y) / (d.x² + d.y²)`、`m = clamp(t, 0, 1)`。
- 円形: 中心 `c = (center.x·A, center.y)`、半軸 `a = radius.x·A`、`b = radius.y`、`θ = angle`（時計回り）。`(dx, dy) = (X − c.x, Y − c.y)`、`p = (dx·cosθ + dy·sinθ, −dx·sinθ + dy·cosθ)`、`r = sqrt((p.x/a)² + (p.y/b)²)`、`f = feather/100`、`s = clamp((1 − r) / max(f, 0.002), 0, 1)`、`m = s²(3 − 2s)`。`feather = 0` は縁だけ約 1 画素でなじませた硬い縁、`100` は中心 1・縁 0。
- 面（ブラシ・被写体・空）: `surface` の PNG（8bit グレー。値 `/255`）を、作業画像全体に重ねて双一次補間する（面の縦横比は作業画像と違ってよい。`A` は使わない）。標本位置は `(u·width − 0.5, v·height − 0.5)`、端は端の値で延ばす。実装（`mask_surface.rs` の `Sampler`）は f32 の `+ − × ÷` と `floor` だけで、`x = (u as f32)·width − 0.5`、`y = (v as f32)·height − 0.5`、`x0 = floor(x)`、`y0 = floor(y)`、`fx = x − x0`、`fy = y − y0`、近い 4 画素 `a (x0, y0)` `b (x0+1, y0)` `c (x0, y0+1)` `d (x0+1, y0+1)` の添字はそれぞれ `0..width−1` / `0..height−1` に収め（端の値で延ばす）、byte の値のまま `top = a + (b − a)·fx`、`bottom = c + (d − c)·fx`、`m = (top + (bottom − top)·fy) / 255`。`m` は 0〜1 に収まり、全部 255 の面はちょうど 1。
- `invert` は最後に `m ← 1 − m`。

## 局所の補正

局所の設定 `L` は、全体の設定に `adjust` を足したもの。各キーは `clamp(全体 + 差分, 全体の範囲)`、`hsl` は項目ごとに足して ±100 に収める。それ以外（`engine` `look` `base` `geometry` 曲線・キャリブレーション・カラーグレーディング・色ポイント・効果）は全体と同じで、`masks` だけを除く。

- 相対 WB: 全体の WB が `relative` ならそのまま足す。`asShot` なら `relative` にして差分だけを入れる。`absolute` のときに `relativeTemperature` / `relativeTint` の差分が 0 でないマスクは設定として拒む（`localWhiteBalance`。UI は `absolute` の間このスライダーを出さない）。
- 差分を足しても `L` が全体と同じになるマスク、`enabled: false`、面が全部 0 のマスクは描かない（追加の描画をしない）。
- `hsl` の帯で、全体に無い帯の差分を足して 0 になったものは足さない（`L` が全体と同じかの比較を、値の同じ空の帯で外さない）。

## 描画と混ぜ方

1. 全体の結果 `R0` を、これまでと同じ経路で描く（`masks` を除いた設定）。
2. 描くマスクごとに `L_k` を描いて `R_k` を得る。`R_k` は `R0` と同じ寸法・同じ quality（drag 中は両方 interactive、離したら両方 final。interactive の `R_k` を final の `R0` と混ぜない）。設定が変わらない層の結果は使い回す（下の「層の持ち方」）。例外として、全体のスライダーの drag の interactive のフレームは層を描かず、drag の起点の差分を新しい `R0` に足す（下の「全体のスライダーの drag」。近似で、final は常にこの手順どおり）。
3. マスクの面を出力と同じ寸法で作り、重み `w_k = floor(m·65536 + 0.5)`（0〜65536）にする。
4. 8bit sRGB の各チャンネルを固定小数点で合算する。

   `out = clamp(R0 + Σ_k ((R_k − R0)·w_k + 32768) >> 16, 0, 255)`（整数。`>>` は算術右シフト。alpha は 255）

マスク 1 枚で `m = 1` なら `out = R_k`、`m = 0` なら `R0` に一致する。合算は項の順序に依らないので、配列の順で画が変わらない。重なったマスクは差分が足される（それぞれの補正が重なる）。

`masks` の無い設定（有効なマスクが無い設定も）の描画は、これまでと 1 bit も変えない（`Session` の経路にも追加のコストを入れない。one-shot の JPEG / PNG は有効なマスクがあるときだけ Session を通る。`tests/masks_render.rs` が原本・作業コピーで確かめる）。

### 層の持ち方（`mask_session.rs`）

Session は次の描画のための 1 枠のキャッシュ（cube・局所階調の pass・色ポイントの面・niho-6 / NIHO 3 の master・縮小・切り抜きの窓・統計）を持つ。`R0` と `R_k` を同じ枠で交互に描くと毎回追い出し合うので、層ごとに持つ。別の Session は作らない（source・niho-6 の解析・効果の面は 1 つを共有する）。

- 設定の側のキャッシュ（cube・局所階調の pass・色ポイントの面・その層が最後に使った niho-6 の解析）は層ごとに持ち、層を描く間だけ Session と入れ替える。
- source の側のキャッシュ（master・退避した master・縮小・窓・統計）は、層が描く画像が `R0` と同じ（どちらも master が無い、または master の key が同じ＝差分が master の入力を変えない）なら `R0` のものをそのまま使い、層には持たない。差分が master の入力を変える層（signed RAW の露光量・WB・ハイライト／シャドウ・テクスチャ・ノイズ低減、niho-6 系の露光量・ハイライト < 0・シャドウ > 0）は自分の master を持ち、`R0` の解析（CNR の結果・係数）から作る。drag 中の表示寸法の master は持ち続けるが、離した final の原寸の master（と縮小・窓）は層の結果を描いたらすぐ手放す（Session が持つ原寸の master は `R0` の 1 枚だけ。その層の final は結果の使い回しで足り、次に final を描き直すときは同じ key から同じ画素で作り直す）。`R0` の結果が前の描画のもので層だけを描くとき（マスクのスライダーを離した final など）、その層がこの描画の `R0` と同じ画像を描くなら、先に `R0` の master をこの描画の quality・寸法のもの（退避した原寸の master を戻す、drag なら表示寸法のもの）にしてから層を描き、層はそれを共有する（自分の master を描く層しか無いときは `R0` の master を作り直さない）。
- 同じ画像を描く層は、局所階調の pass が `R0` と同じ（入力・適応の値・quality が同じ＝差分がハイライト／シャドウ／テクスチャ／明瞭度の外）なら `R0` の pass を読み、写しを持たない。
- niho-6 系は、その層が最後に使った解析の露光量がちょうど同じなら final でもそれを使う（共有の解析の 1 枠を `R0` と層で取り合わない。同じ写真・同じ露光量の解析なので値は同じ）。
- 結果は `R0` と各 `R_k` を quality ごとに 1 枚、描いた設定の JSON・寸法・quality と組で持つ。1 枚のマスクのスライダーを動かす間はその層だけを描く。全体のスライダーの drag は下の「全体のスライダーの drag」で `R0` だけを描く（その規則に当たらない全体の変更ではすべての層を描く）。離した final も、ほかの層の final の設定が変わっていなければその層だけを描く。final はドラッグ中に固定して使う niho-6 解析を更新する場合があるため、次のドラッグ前に全 interactive フレーム（と下の起点）を破棄する。面は層ごとに 1 枚、形・`invert`・幾何・寸法が変わらない間は作り直さない（形だけを動かす間は面と合算だけ）。
- 無くなったマスク・有効でなくなったマスクの層は次の描画で手放し、有効なマスクが無い描画ですべて手放す。
- 自動補正と色の取得（色ポイントの picker）は `masks` を除いた全体の設定で測り、自動補正の結果の `masks` は渡されたまま返す。

### 全体のスライダーの drag（#92）

全体のスライダーを動かすと全部の層の設定が変わるので、正確に描くと「マスクの枚数 + 1」枚の描画になる。drag の間（interactive）だけ、層の差分を drag の起点のものにして `R0` だけを描く（owner 判断・2026-10-21）。

- **起点**: 層を描いて混ぜた interactive のフレーム（全部の層を描いたか、一部の層の結果を使い回したかに依らない）は、出力と一緒に合算の項 `S = Σ_k ((R_k − R0)·w_k + 32768) >> 16`（画素・RGB ごと、`i16`）を起点として持つ。出力は `clamp(R0 + S, 0, 255)` で、これは上の合算の式そのもの（起点のフレームはこれまでと 1 bit も変わらない）。`S` は層の枚数に依らず 6 byte/画素（640×427 で約 1.6 MB）で、Session に 1 つだけ持つ。描く層が無いフレーム（どの層も面が全部 0 か、`L` が全体と同じ）は起点を持たない。
- **使い回す条件**: 次の interactive のフレームが次の全部を満たすとき、層を描かず `R0` だけを今までの経路で描き、`out = clamp(R0 + S, 0, 255)`（整数だけ。native と wasm で同じ bytes）を返す。
  - 起点と同じ `maxDimension`（と、描いた `R0` が起点と同じ寸法）。
  - `masks` が起点と同じ（正規形の JSON。id・種類・形・`invert`・`enabled`・`adjust`・面の id と配列の順。1 つでも違えば描く）。
  - 全体の設定（`masks` を除いた正規形）が、起点と **1 つのスライダーの値だけ**違い、その差が上限以内。スライダーと上限: 露光量 0.5 EV、コントラスト・ハイライト・シャドウ・白レベル・黒レベル・テクスチャ・明瞭度・かすみの除去・自然な彩度・彩度・相対の色温度・色かぶり・パラメトリックの 4 つと 3 つの境・カラーノイズ軽減の 3 つは 25、絶対の白（`whiteBalance.mode` が両方 `absolute`）の色温度は 40 mired（スライダーと同じ mired で測る。5500 K から約 4600 / 7000 K）・色かぶりは 25。
  - 起点から 60 枚目まで（61 枚目は描く）。
- **描く（新しい起点になる）**: 上に当たらない interactive のフレーム。2 つ以上の値の変更、スライダーでない値（曲線・HSL・カラーグレーディング・キャリブレーション・色ポイント・効果・ディテール・幾何・修復・`engine` `look` `base`・白の mode の切り替え）、つまりプリセット・取り消し・やり直し・貼り付け・自動補正の結果、マスクの編集（形・スライダー）、寸法の変更、上限を超えた所・61 枚目。drag の最初の 1 枚（離した final の後の最初の interactive）も、起点が無いので層を描く。
- **final** は常にこれまでどおり正確に描き（bytes は変わらない）、interactive のフレームを破棄するときに起点も捨てる（final の層は起点にしない）。面を落としたときも起点を捨てる。
- **見え方（近似）**: drag 中の局所の見え方は「drag の起点での層の差 `R_k − R0` を、動いている全体の画に足したもの」になる。全体の値に合わせて局所の差が変わる分（露光量で暗部が詰まる・彩度の上限に当たるなど）は drag 中は反映されず、離すと final で正確な画に切り替わる（起点・上限ごとの描き直しのフレームも正確）。上限は、合成の写真で使い回した画と正確な画の差が、マスクを全部外した画との差のおよそ半分以下に収まるように決めた（下の表。`mask_session.rs` の `a_reused_drag_frame_stays_close_to_the_exact_one`）。

  合成の 320×213（`mask_timing` の場面、JPEG 相当 `niho-10`）、`mask_timing` の 3 枚のマスク、interactive 320。値は 8bit の段（RGB の各チャンネル）で、「平均」「最大」「3 段より大きい割合」、比較の「マスク無し」は `R0` だけの画と正確な画の平均の差（マスクの効きの大きさ）。

  | 全体の変更（起点から） | 平均 | 最大 | 3 段超 | マスク無し |
  | --- | ---: | ---: | ---: | ---: |
  | 露光量 +0.25 | 0.61 | 5 | 0.2% | 3.95 |
  | コントラスト +10 | 0.55 | 4 | 0.1% | 4.21 |
  | 露光量 +0.5（上限） | 0.88 | 10 | 3.0% | 3.84 |
  | 露光量 −0.5（上限） | 2.11 | 29 | 17.4% | 4.33 |
  | コントラスト +25（上限） | 0.88 | 8 | 3.4% | 4.40 |
  | ハイライト −25（上限） | 0.66 | 5 | 0.8% | 4.39 |
  | 白レベル +25（上限） | 1.51 | 10 | 16.6% | 4.88 |
  | 彩度 +25（上限） | 1.54 | 11 | 14.8% | 4.42 |
  | 自然な彩度 +25（上限） | 0.52 | 9 | 0.5% | 4.14 |

  signed RAW（`niho-11`、同じ寸法の合成の作業コピー）では、露光量 ±0.5 で平均 2.2〜2.3・最大 26〜39、±0.25〜0.3 で平均 1.2〜1.5、ほかのスライダーの 25 で平均 0.4〜1.8（彩度・かすみの除去が大きい）、絶対の白の色温度 5500 → 4583 K（36 mired）で平均 1.3・最大 26。露光量が最も効く（局所の露光量の層の差は、全体の明るさで階調の詰まり方が変わる）。微小な動きでも平均 0.4〜0.6 段の差が残るのは、起点と今の `R0` の 8bit の丸めの違い。
- 上限を緩める（全体の値の範囲の 50% など）と、露光量 ±1 EV で平均 2〜3.8・最大 21〜75 段になり、離したときの切り替わりが目立つ。速い drag（1 枚あたりの動きが大きい）は上限を超えるたびに層を描くので、その分は今までの費用に戻る（下の「drag（全体・速い）」）。
- final の層から最初の 1 枚の起点を作る案（final 1280 の `S` を 640 へ箱の平均で縮める。整数で決まる）は採らなかった: 明瞭度・テクスチャの層の細かい差分が平均で消え、その層だけで平均 1.2 段（2:1）〜2.9 段（3:1）の差になる（interactive で描いた起点では 0.2 段）。drag の最初の 1 枚は層を描く。

### 面の表示（エディタの重ね表示）

`Session::mask_plane(settings, maskId, maxDimension)`・wasm の `Developer.maskPlane(settingsJson, maskId, maxDimension)` は、1 枚のマスクの面を `{ width, height, data }`（`data` は `width·height` byte。`round(w / 65536 · 255)`、行優先、`invert` 込み、`enabled` に依らない）で返す。寸法はその `maxDimension` の描画と同じ（幾何込み）、写像と面の計算も描画と同じで、Session の描画のキャッシュには触れない。面の種類（ブラシ・被写体・空）はその Session の面を読む（`enabled` に依らず面が要る。無ければ `maskSurfaceMissing`、寸法が `surface` と違えば `maskSurfaceMismatch`）。無い id は `maskNotFound`。

## 面の受け渡し

M4（#68）。エンジン（native・wasm）・書き出しの CLI・Mac の置き場が同じ口で面を受け渡す。

- 面は PNG の**内容の sha256**（小文字 16 進 64 文字。設定の `surface.id`）で呼ぶ不変のファイルで、同じ `id` の中身は変わらない。エンジン（`mask_surface.rs`）が受け取る PNG は次の全部を満たすものだけ: 8 MiB 以下、sha256 が `id`、静止画の 8bit グレー（色の型 0・深さ 8。1 / 2 / 4 / 16bit のグレー・パレット・グレー＋α・RGB / RGBA は不可）、`tRNS`（透明）と `acTL`（アニメーション）が無い、1 辺 1〜4096 画素、最後まで読める（interlace は可）。値は `byte / 255`。
- 失敗の code（メッセージの先頭。Rust の `Error`）:
  - `maskSurfaceInvalid`（`Error::MaskSurfaceInvalid`）: 上の条件に合わない面を渡した（id の形・大きさ・sha256・形式・寸法）。Session は何も変えない。
  - `maskSurfaceMissing`（`Error::MaskSurfaceMissing`。マスクの id を持つ）: 描かれる（`enabled` で `adjust` が 0 でない）面のマスクの `surface.id` の面を Session が持っていない。無言で飛ばさず失敗する。描かれないマスクの面は無くてよい。
  - `maskSurfaceMismatch`（`Error::MaskSurfaceMismatch`）: Session の面の寸法が、マスクの `surface.width` / `surface.height` と違う。
  - 描画はこれらを `R0` を描く前に確かめる。
- Rust: `Session::set_mask_surface(id, png)` / `drop_mask_surface(id)` / `has_mask_surface(id)` / `mask_surface_ids()`、`Session::export_jpeg(settings, maxDimension, quality)` / `export_png(settings, maxDimension)`（その Session の面と層で released の描画をして、one-shot の `export_jpeg` / `export_png` と同じ符号化。`encode_frame_jpeg` / `encode_frame_png`）。面は落とすまで Session に残り、次の描画でも使う（復号した `width·height` byte を持つ）。同じ id をもう一度渡すと sha256 だけを照らす。落とすとその面から作った層の面（plane）も捨てる。`Session::thumbnail`（プリセットの見本）・自動補正・色の取得の Session と one-shot の `render` / `export_*` は面を持たずに始まる（見本で面のマスクを描くなら、見本の Session にも渡す）。
- wasm: `Developer.setMaskSurface(id, png)` / `dropMaskSurface(id)`（持っていたら true）/ `hasMaskSurface(id)`、`Developer.exportJpeg(settingsJson, maxDimension, quality)` / `Developer.exportPng(settingsJson, maxDimension)`（その Developer の面と層で `render(settingsJson, maxDimension, false)` を描き、one-shot の `exportJpeg` / `exportPng` と同じ符号化。EXIF は `withCaptureExif` で足す。寸法は Developer の作業寸法まで）。補助の `encodeMaskSurface(width, height, data)`（`data` は `width·height` byte。上の形の非 interlace の PNG を返す。同じ画素は同じ byte＝同じ id で、native と wasm でも同じ byte。`tests/masks_cross_target.rs`）と `maskSurfaceId(png)`（sha256）。one-shot の `render` / `exportJpeg` / `exportPng` は面を持たないので、描かれる面のマスクがあると `maskSurfaceMissing`。
- 書き出しの CLI（`niho-develop-render render`）: `--mask-surface <id>=<path>`（`--mask-surface=<id>=<path>` も可。繰り返し可・8 個まで・同じ id は 1 回）。ファイルは元の写真・作業コピーより先に 8 MiB + 1 byte まで読み、Session を開いた後・描く前に `set_mask_surface` へ渡す。exit code: 形の違う引数は `invalid_arguments`（1）、ファイルが無い・読めないは `input_not_found` / `read_failed`（4）、`maskSurfaceInvalid` は `decode_failed`（5）、`maskSurfaceMissing` は `unsupported_settings`（2。M2 と同じ）、`maskSurfaceMismatch` は `invalid_settings`（3）。`--out` は面のファイルも上書きしない。
- Mac（NIHO camera）の置き場: `packages/desktop-photo` の `MaskSurfaceStore`（`mask_surfaces.rs`）。`~/Library/Application Support/life.niho.camera/mask-surfaces/<写真の中身の sha256>/<面の sha256>.png`（補正の `edits/<sha256>.json` と同じ写真のキー。フォルダ 0700・ファイル 0600・一時ファイル＋rename。キーと id の形を確かめてからパスを組み、シンボリックリンクのファイルは読まない）。
  - 保存は署名・IHDR（CRC・深さ 8・色の型 0・1〜4096 画素）・最初の IDAT までに PLTE / tRNS / acTL が無いこと・8 MiB 以下を確かめ、sha256 を id にする（画素まで読むのはエンジン）。同じ中身は書き直さない。読み出しは 8 MiB までで、sha256 を名前と照らす（壊れた・置き換わったファイルは渡さない）。
  - 上限は写真 1 枚 64 面・1 面 8 MiB（`MaskSurfaceLimits`）。上限で新しい面を保存するときは、その写真の保存した補正が参照する面（無効なマスクのものも）を残し、最後に使った（保存・読み出し＝ファイルの更新日時）のが古い面から消して空ける。空けられなければ `maskSurfaceQuota`。消した面を参照する undo の古い版に戻すと `maskSurfaceMissing` になる。
  - 掃除: 補正（NIHO camera は利用者のデータそのものなので古さ・件数で消さない）と同じく、古さ・写真の数では消さない。一覧から写真を外しても補正と面は残る（写真ごとの上限が大きさを抑える。ふつうのブラシの面は数十 KB）。補正を消す口ができたら `MaskSurfaceStore::forget_photo` を一緒に呼ぶ。途中で落ちた一時ファイルは、その写真へ次に保存するときに 1 時間を過ぎたものを消す。
  - コマンド（ACL は `allow-camera-photos`）: `camera_mask_surface_save`（raw IPC の PNG、`photoId` は header `x-niho-photo-id` → `{ id, width, height }`）、`camera_mask_surface_load`（`{ photoId, surfaceId }` → raw IPC の PNG）、`camera_mask_surface_exists`（`{ photoId, surfaceIds }`、1〜64 個 → `{ missing }`）。失敗は `maskSurfaceInvalid`・`maskSurfaceQuota`・`maskSurfaceMissing`・`notFound`・`invalidRequest`。TS は `apps/camera/src/local-library/commands.ts` の `saveMaskSurface` / `loadMaskSurface` / `missingMaskSurfaces`。
  - 原寸の書き出し（`PhotoDevelop::export`）: 描かれる面のマスクの面を `DevelopPhotos::mask_surface`（camera は上の置き場。既定は無し）で読み、sha256 を照らして仕事の一時フォルダへ写し、`--mask-surface <id>=<path>` で sidecar へ渡す（描かれないマスクの面は渡さない）。無いときは作業コピーを作る前に `maskSurfaceMissing`（`develop_code::MASK_SURFACE_MISSING`）で断る。
- クラウドの写真の面の置き場は非公開側（`niho-coliving/niho-app#19218`）。

## 版と互換

- `masks` に 1 枚でもあれば `v = 5`（`MASKS_SETTINGS_VERSION`）を要求する。`detail`（#32）も 5 を使う予定で、先に merge された側が 5、後の側が 6 に振り直す。古い reader は `v` が未知のため設定を補正なしとして読み替えず、閲覧のみにする。
- 能力の問い合わせ: `validateSettings` の probe は M1 の wasm（マスクを読めるが描かない）でも通るので使わない。wasm の `capabilities()`（`{"masks":{"kinds":["linear","radial","brush","subject","sky"],"max":8,"maskPlane":true,"surfaces":true}}`）が描ける種類を返し、この口の無い古い wasm は描けない扱いにする（画面の扱いは M3）。`surfaces` の無い M2 の wasm（`kinds` が `linear` `radial` だけ）は面の口を持たない。Mac の書き出しは同梱の niho-develop-render が `MASKS_MIN_RENDER_VERSION`（0.19.0）以上のときだけ `masks` 付きの設定を渡し、それより古ければ作業コピーを作る前に `unsupportedSettings` で断る。0.19.0 は線形・円形（M2）と `--mask-surface`（M4）を同じ版で出す（どちらも公開前）ので、版の境は 1 つで、`camera_develop_status` の `masks` は面のマスクの書き出しも含む。NIHO camera の `camera_develop_status` は `masks`（`PhotoLibraryCapabilities.nativeExportMasks`）でこれを画面へ知らせる。sidecar の lock（`apps/camera/develop-sidecars.lock.json`）は repo の外の公開の手順で 0.19.0 に上げる。
- 取り扱い: 「初期化」とプリセット適用前の比較は `masks` を除く。自動補正・設定のコピーは対象の `masks` を変えない（コピー元の `masks` も持ち出さない）。プリセット（XMP）の適用も `settings.masks` は当てる前の写真のままで、プリセット自身がマスクを持つときだけ、それを写真の座標へ写して置き換える（下の「Lightroom の XMP の読み」）。旧形式への変換 (`developSettingsToEditSettings`) は `masks` が有効なら null。XMP の書き出しは `masks` を書かず `notWritten: ["masks"]` を返す（Lightroom への書き出しは未対応のまま）。

## Lightroom の XMP の読み

M6（#69）。Lightroom のプリセット（XMP）の局所補正を `masks` として取り込む。Rust の `xmp/masks.rs`（`presetSettings` / `applyPreset` の結果の `masks`）が読み、TypeScript の `develop-preset-masks.ts`（`presetDevelopSettings` の第 3 引数）が写真に置く。下の事実は 2026-10-21 にオーナーの Lightroom（クラウド版）の写真ごとの XMP とプリセットで確かめたもので、実際の値・id・digest はリポジトリに入れていない（テストは同じ構造の合成の XMP）。

### 読む物

- `crs:MaskGroupBasedCorrections`（Lightroom 11 以降）の `rdf:Seq` の 1 項目（`crs:What="Correction"`）が 1 つの補正で、その `crs:CorrectionMasks` にマスクが 1 枚だけある補正を 1 枚の NIHO のマスクにする。属性は `rdf:li` に直接・`rdf:Description`・`rdf:parseType="Resource"` の単純な要素のどれでも読む。
- 旧形式の `crs:GradientBasedCorrections` / `crs:CircularGradientBasedCorrections` は読まない。実物の書き出しで単位と形を確かめていないので、見た目が似ていても `MaskGroupBasedCorrections` の規則を当てはめず、補正ごとに `unsupported`（`<一覧>.<n>.legacyList`）にする。`crs:PaintBasedCorrections` は補正ごとに `brush`。`MaskGroupBasedCorrections` もある XMP では、旧形式の一覧は同じマスクの写しとして `metadata` にする（知らせない）。
- `Mask/Gradient` → `linear`: `ZeroX` `ZeroY` → `zero`（面が 0）、`FullX` `FullY` → `full`（面が 1）。`MaskInverted="true"` → `invert: true`。
- `Mask/CircularGradient`（`Angle = 0`・`Roundness = 0`・`Midpoint = 50`・`Flipped="true"`・`Version` は無いか 2）→ `radial`: `center = ((Left + Right) / 2, (Top + Bottom) / 2)`、`radius = ((Right − Left) / 2, (Bottom − Top) / 2)`、`angle = 0`。`Right > Left` と `Bottom > Top` が要り、中心 0〜1・半軸 0.005〜1.5 を外れる物は丸めずに読まない。`Feather`（0〜100）はそのまま `feather` にする（Lightroom のなじませ方の近似）。`Flipped="true"` は既定の円形（効果が内側）でしか見ていないので、これを通常の場合として扱う。
- 補正の量: `Local*` は Lightroom のスライダー（−100〜100）の 1/100 で保存されている（例 `LocalContrast2012 = 0.39` は +39、`LocalHighlights2012 = −1` は −100）。`LocalExposure2012` だけは EV のまま。`CorrectionAmount`（0〜1）を全部の差分に掛ける。

  | XMP | `adjust` |
  | --- | --- |
  | `LocalExposure2012` | `exposure`（EV） |
  | `LocalContrast2012` `LocalHighlights2012` `LocalShadows2012` `LocalWhites2012` `LocalBlacks2012` | `contrast` `highlights` `shadows` `whites` `blacks`（×100） |
  | `LocalTexture` `LocalClarity2012` `LocalDehaze` `LocalSaturation` | `texture` `clarity` `dehaze` `saturation`（×100） |
  | `LocalTemperature` `LocalTint` | `relativeTemperature` `relativeTint`（×100。相対のホワイトバランスでの近似。結果の全体の白が `absolute` なら使わない） |

- `CorrectionActive="false"` か `MaskActive="false"` は、あるが描かないマスク（`enabled: false`）。範囲外の差分は範囲に丸めて `approximate` にする。
- id は `xmp-1` から順。9 枚目からは読まない（`tooMany`）。

### 座標の枠

- **プリセット**のマスクの座標は、当てる写真の**見えている枠**（切り抜き・回転・反転の後）に対する 0〜1。切り抜きの無い写真に当てると写真ごとの XMP に同じ数が入り、切り抜いた写真では写真ごとの数がプリセットの数の `crop.left + x · crop.width`（y も同じ）になっていた。
- **写真ごとの XMP** の座標は切り抜く前の枠に対する 0〜1（今回は読まない）。
- NIHO の `masks` は作業画像（向き反映済み・幾何の前）の座標なので、Rust はプリセットのマスクを見えている枠の座標のまま返し（`PresetResult::masks`。`settings.masks` には入れない）、TypeScript が写真の `geometry` と作業画像の大きさで写す（`geometryOutputToSource`）。線形は 2 点、円形は中心と 2 本の半軸の端を写して中心・半軸・角度を求め直す（90° / 270° は半軸が入れ替わり、角度補正はその角度が付く。角度は −45〜45 にそろえる）。写した後で M1 の範囲を外れるマスク（小さな切り抜きで縮んだ物）は置かない。
- 写真の作業画像の大きさは、開いている写真（切り抜きの道具と同じ大きさ）でだけ分かる。一覧の一括のプリセットとプリセットの見本は大きさを持たないので、プリセットのマスクを置かない（写真のマスクのまま）。
- プリセットがマスクを持つときは、写真のマスクをプリセットのマスクで置き換える。持たないプリセットは写真のマスクを変えない。

### 適用量

`applyPreset` の適用量（0〜150%）は、プリセットのマスクの `adjust` の差分に掛けて範囲で止める（0% はマスクなし、100% はそのまま、150% は 1.5 倍）。形・有効・反転・id は変えない。写真自身のマスク（`settings.masks`）はどの適用量でも当てる前のまま。

### 読まない物と理由

読まない物は `unsupported` に `<一覧>.<n>.<理由>`（例 `MaskGroupBasedCorrections.3.brush`）で入れ、その補正は取り込まない（`Local*` の項目だけは、マスクを取り込んだまま項目ごとに入れる）。画面は取り込みの知らせ（「…は使えないので、それ以外を取り込みました」）で種類の名前を出す。

| 理由 | 何か | なぜ |
| --- | --- | --- |
| `brush` | ブラシ（`Mask/Paint`、その集まりの `Mask/Aggregate`、旧形式の `PaintBasedCorrections`） | 写真の上の位置に描いた線（`crs:Dabs`）で、プリセットが持つ意味が無い。NIHO に線から面を作る道もまだ無い（M4） |
| `aiMask` | AI のマスク（`Mask/Image`。`MaskSubType` で被写体・空・背景・人物など） | 写真ごとの検出で、プリセットからは面を作れない |
| `rangeMask` | 範囲マスク（`Mask/RangeMask`・`CorrectionRangeMask`。輝度・色・深度） | NIHO の対象外 |
| `multipleMasks` `maskBlend` | 1 つの補正の複数のマスク・`MaskBlendMode` が 0 以外 | 追加・交差・除外の重ね方は未対応 |
| `maskValue` | `MaskValue` が 1 以外 | マスクの不透明度は未対応 |
| `rotatedRadial` | `Angle` が 0 以外の円形 | 回した楕円の `Top` `Left` `Bottom` `Right` は外接の箱に見えず（`Left > Right`・`Top ≈ Bottom` があった）、同じプリセットでも写真ごとに違ったため、値の意味が分からない |
| `radialRoundness` `radialMidpoint` `radialFlipped` `radialVersion` | `Roundness ≠ 0`・`Midpoint ≠ 50`・`Flipped` が `true` 以外・`Version` が 2 以外 | 意味を確かめていない |
| `outOfRange` `invalid` `unknownMask` | NIHO の範囲の外・値が欠ける / 数でない・未知の種類 | 丸めて別の形にしない |
| `tooMany` | 9 枚目から | 上限 8 枚 |
| `legacyList` | 旧形式の `GradientBasedCorrections` / `CircularGradientBasedCorrections` の補正（`MaskGroupBasedCorrections` が無い XMP） | 実物の XMP で単位と形を確かめていない（形を推測しない） |
| `Local<項目>` | 0 でない `LocalHue`・`LocalToningSaturation`・`LocalSharpness`・`LocalLuminanceNoise`・`LocalMoire`・`LocalDefringe`・`LocalBrightness`・旧式の `LocalExposure` `LocalContrast` `LocalClarity`（2012 の値を使う）・100 以外の `LocalCurveRefineSaturation`・未知の `Local*` | NIHO の局所補正に無い。`LocalToningHue` は `LocalToningSaturation` が 0 なら効かないので知らせない（240 などの値が残る） |

結果のマスクを TypeScript が M1 の読み方で読めないときは、プリセットのマスクを全部使わず `unsupported` に `MaskGroupBasedCorrections` を足す（「読めないマスク」）。

### 写真ごとの XMP の座標の枠（2026-10-21、Lightroom のカタログの円形 86 件で確認。#94）

写真ごとの XMP（Lightroom が写真に付ける設定）の円形マスクを、写真の寸法・向き・クロップと突き合わせて読んだ。プリセットのファイルを読む今の取り込み（上）には使わないが、写真ごとの XMP を読む場合の前提になる。

- 座標は**クロップより前の枠**で保存される。同じプリセットを当てた、クロップの違う同じ向きの写真で数値が変わらない例が多数あり、クロップを後から変えても動かない。クロップした後にプリセットを当てた写真だけ `クロップの左 + x × クロップの幅` に換算されている。NIHO の `masks`（作業画像の座標）と同じ考え方
- 数値は**向き（EXIF の向き）で変わる**。同じプリセットの回転なしの円形が、横位置（向き 1）と縦位置（向き 8）で 90° 回した関係になる（横の `Left` `Right` = 縦の `Top` `Bottom`、横の `Top` `Bottom` = 1 − 縦の `Right` `Left`）。座標は表示の枠ではなく、向きを反映する前の枠（または表示の枠からの 90° 換算）で書かれている。プリセットのファイルがどちらの枠かは、マスク入りのプリセットの実物（手元に無い）が要る
- 回した円形の `Top` `Left` `Bottom` `Right` は外接矩形ではない（`Top` ≒ `Bottom`、`Left` > `Right` になる例が多い）。回す前の外接矩形 + 画素の空間での回転、正規化した空間・画素の空間で枠を回した矩形（回す向き 2 通り）は、横位置・縦位置の同じプリセットで同じ形にならず、棄却した。読み方は決められていない

### 分かっていない物（実物の標本で広げる）

- 回した円形（`Angle ≠ 0`）の `Top` `Left` `Bottom` `Right` の決まり。写真ごとの XMP とプリセットの組を増やして式を当てる。
- `Flipped="false"` の円形、`Roundness`・`Midpoint` の効き方、`Version` 2 以外。
- ブラシの `Dabs`（`d x y`・`r 半径` の並び）を面にする道（M4 の面の受け渡しに載せられる）と、AI のマスクの `MaskSubType` の対応。
- 局所の色温度・色かぶりと Lightroom の見え方の差、`Feather` となじませ方の差（M2 の描画で実測する）。
- 旧形式の一覧（`GradientBasedCorrections` / `CircularGradientBasedCorrections`）の単位と形。実物の書き出しで確かめるまで読まない（`legacyList`）。確かめたら同じ読み方を当てられるかを決める。

## 画面（マスクの道具。M3・M4b・#93）

右端の道具の帯の「マスク」（PC の幅・マスクを描ける wasm の写真を 1 枚で見ている間だけ。背景除去・切り抜きの間は出さない）。スマホ（1024px 未満）で直せる拠点では、全画面の編集の層の道具の帯の「マスク」（#93。下の「スマホ」）。道具は 1 つずつで、切り抜きか背景除去に移ると「補正」に戻る。

- **追加**: 線形グラデーション・円形グラデーション・ブラシ（ブラシは wasm の `capabilities()` に `brush` があり、ライブラリが `saveMaskSurface` を持つときだけ）。8 枚で止まり理由を出す。原寸の書き出しがあって `nativeExportMasks !== true`（古い sidecar など）のときは「追加」「複製」だけを止める（今あるマスクの編集・削除はできる）。
- **一覧**: 名前は配列での位置（「線形 1」「円形 2」「ブラシ 3」「被写体 4」「空 5」。削除すると詰まる）、目（描く／描かない＝`enabled`）、反転、複製、削除。選んだマスクの補正スライダー（ライト 6・色温度/色かぶり（全体の WB が絶対値の間は出さない）・自然な彩度・彩度・テクスチャ・明瞭度・かすみ、円形はぼかし）。
- **局所のカラーミキサー（#93）**: カラーの群の後ろに、全体のカラーミキサー（#79）と同じ「調整」（色相・彩度・輝度）の切り替えと 8 色のスライダー（赤〜マゼンタ、各 −100〜100・整数）を置く（PC は既定で閉じた節、開閉は端末に覚える）。値は `adjust.hsl` の差分で、書くと 3 値とも 0 になった帯を消し、帯が残らなければ `adjust.hsl` ごと消す。保存は正規形（帯の中も 0 の値を書かない。例 `["blue",{"saturation":-100}]`）。「初期化」はそのマスクの 24 の値だけを戻す（取り消し 1 回）。全体が白黒の間は全体と同じく押せない。Lightroom のマスクには帯ごとの HSL が無いが、NIHO は全体と同じ 8 帯で持つ。
- **写真の上の操作**: 線形は始点・中央・終点、円形は中心・4 本の軸・回転のつまみ（28px）。1 回の操作で取り消し 1 回。矢印キーで短辺の 1%（Shift で 5%）、Delete で削除、Esc で選択を外す、O で範囲の赤い重ね表示（つまみを動かす間は自動で出る）。赤い面はエンジンの `maskPlane`（描画と同じ計算）をそのまま出す。表示の座標は `geometryOutputToSource` とその逆の `geometrySourceToOutput` で作業画像と行き来する（回転 4 通り × 反転 × 角度付き切り抜き × 4 種の縦横比で往復 1e-9 以内）。
- **drag の描画**: 有効なマスクがある間の drag（スライダー・つまみ）は長辺 640px の interactive（色ポイントと同じ。`developInteractiveMaxDimension`）、離した final は 1280px。小さい画は今の canvas の大きさのまま引き伸ばして描く（写真が縮んで見えない）。
- **ブラシ（M4b）**: 追加すると 1024（長辺）の空の面を作って塗る状態に入る。大きさ（見えている短辺に対する半径の %。既定 6、`[` `]` で約 1.25 倍）・ぼかし（既定 50）・流量（既定 50）・消しゴム（E。Alt を押している間も）・全体を塗る／消す。ストロークの間は面の画素の f32 に A ← A + (1 − A)·a を重ね、離したときに 1 回だけ丸める。中心は `geometryOutputToSource` で面の画素へ写し、半径は表示枠と位置ごとの局所ヤコビアンで写すため、遠近補正後も画面上の円形の筆跡になる。離すと 8bit グレーの PNG にして sha256 を id に保存し、`surface` を書き換える（**1 ストローク = 取り消し 1 回**。undo/redo はその版の面を置き場から読み直す）。保存中でも次のストロークを塗れ、確定は順番に 1 つずつ行う。写真を替えると塗りかけと待っている確定は捨てる。Esc は 1 回目で塗るのをやめ、2 回目で選択を外す。
- **スマホ（#93）**: 全体の編集の層の道具の帯の「マスク」（ポイントカラーの後ろ・切り抜きの前）。段には、足す（線形・円形・ブラシ。押せない理由は PC と同じ）・範囲を表示・「初期化」（マスクだけを外す）、マスクの一覧（種類の印と名前のチップ。押すと選ぶ）、選んだマスクの操作（表示・反転・複製・削除）、補正の種類（ブラシ／ライト／カラー／カラーミキサー／効果／円形の形）と、その項目のチップ・目盛り 1 本（全体の補正の段と同じ形）を縦に並べ、段の高さを超える分は段の中で送る。押せる範囲はどれも 44px。写真の上のつまみと印は、指（`pointer: coarse`）では押せる範囲を 44px にし（見た目は PC と同じ）、中心のつまみを端のつまみより上に重ね、回転のつまみを上の端から 44px 離す。
  - 指の操作: 写真の何も無い所は、指 1 本で離すまでにほとんど動かさなかったときだけ選択を外す（ピンチの 1 本目・拡大中の送りでは外さない）。マスクの間もピンチ・ダブルタップの拡大と拡大中の送りは使え、長押しの補正前は使わない。拡大の間もつまみ・赤い面・ブラシの面は写真に合わせて測り直す（写真の面の `style` の変化を見て 1 フレームに 1 回）。つまみを動かしている途中に別の指が写真に触れたら、動かし始めの形に戻す。
  - ブラシ: 指 1 本で塗る。2 本目の指が触れたら、塗っている途中のストロークを確定せずに捨て（保存を待っている確定はそのまま）、その指ではピンチで拡大・送る。ブラシの面の上の指は写真の面の指の操作にピンチとしてだけ数える（指 1 本の送り・ダブルタップにしない）。指の下の筆の輪は指に隠れるので出さず、塗っている途中の赤で見せ、大きさを変えたときだけ写真の中央に輪の見本を出す。大きさ・ぼかし・流量は目盛り、描く／消しゴム・全体を塗る／消すはチップ。大きさは PC と同じく見えている写真の短辺に対する割合（拡大しても写真の上の大きさは変わらない）。
- **面の読み込み**: エンジンのクライアントが描く前に、有効な面のマスクの面を wasm に 1 回だけ渡す（wasm は 16 枚まで・古いものから手放す。読んだ PNG は 24 件・32 MiB まで覚える）。読めない面（置き場に無い・壊れている）は、前の画を残し、パネルに「マスクの面を読めません（ブラシ 1）」と「もう一度読み込む」を出す（開いた直後で前の画が無いときだけ、その面のマスクを描かない画を 1 枚出す）。書き出しは 1 行の理由で断る。クラウドの写真は、ライブラリが面を読み書きできるまでブラシは出ず、被写体・空は「読めません」になる。

## 性能の目安と測り方

drag 100ms／final 1 秒（マスク 3 枚まで）が目安。層は「描くマスクの枚数 + 1」回の描画になる。

測り方（どちらも合成の入力だけを使う）:

- native: `cargo run --release -p niho-develop --example mask_timing [-- --source raster|raw --trials 3 --drag 640]`（`--drag` は interactive の長辺。既定 1280）
- wasm: `mask_timing -- --dump <dir>` が書く同じ入力で、`node tools/mask-wasm-bench.mjs <web 向けの wasm-bindgen の出力> <dir> [--drag 640]`（Node・SIMD・単一スレッド。場面ごとに新しい process で測り、wasm の linear memory はその場面の最大。1 つの場面だけは `--one raster:3:cube` など）。
- 入力: 合成 2048×1365 の JPEG 相当（PNG。`niho-10`、ハイライト −30・シャドウ +20・コントラスト 10・自然な彩度 10 で niho-6 の応答の master を使う）と、同じ寸法の signed RAW の作業コピー（`niho-11`、露光量 −0.2・ハイライト −40・シャドウ +20・コントラスト 10）。
- マスク: 線形（上の空）・円形（小さめ）・反転した円形（大きな周辺）の 1〜3 枚。局所の差分は 3 種: 「cube のみ」（彩度 +20・コントラスト +15。master と局所階調の入力を変えない）、「露光量」（露光量 −0.7。master の入力を変える）、「局所階調」（明瞭度 +25・テクスチャ +20・シャドウ +25・ハイライト −30）。動かすのは 1 枚目のスライダー（2 枚目以降は固定）。
- 場面: 初回 final 1280（新しい Session の最初の 1 枚）、初回 drag（その次の interactive 1280。1 枚目のマスクのスライダー、マスク無しはコントラスト）、drag（その 1 枚）＝続く 6 枚の中央値、離した final 1280、drag（全体）＝全体のコントラストを 1 ずつ動かす 6 枚の中央値（その最初の 1 枚も別に出す）、drag（全体・速い）＝続けて 1 枚ごとに 10 動かす 6 枚の平均（#92）、final 原寸（新しい Session の作業寸法の final）。
- 値は ms で「wasm / native」。それぞれ 3 回のうち最も速いもの（wasm は 2 回の計測の合計 6 回）。計測した Mac Studio（Apple M1 Max・64 GB）は他の作業の負荷（load average 7〜30）がかかっていて、負荷は時間を増やす向きにしか働かない。2026-10-21、エンジン 0.19.0（engine niho-11）、Node 24.18。

| 元 | 局所の差分 | 枚数 | 初回 final 1280 | 初回 drag | drag（その 1 枚） | 離した final 1280 | drag（全体） | final 原寸 | wasm memory |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| JPEG 相当 | — | 0 | 1296 / 1045 | 148 / 106 | 60 / 39 | 557 / 453 | 59 / 40 | 1759 / 1434 | 187 MiB |
| JPEG 相当 | cube のみ | 1 | 1908 / 1519 | 226 / 152 | 78 / 46 | 836 / 632 | 137 / 87 | 2897 / 2360 | 200 MiB |
| JPEG 相当 | cube のみ | 2 | 2411 / 1888 | 303 / 200 | 78 / 47 | 832 / 638 | 215 / 137 | 3972 / 3184 | 227 MiB |
| JPEG 相当 | cube のみ | 3 | 3033 / 2279 | 378 / 247 | 81 / 49 | 841 / 638 | 289 / 181 | 5010 / 3949 | 254 MiB |
| JPEG 相当 | 露光量 | 1 | 2288 / 1858 | 307 / 216 | 68 / 44 | 1023 / 816 | 125 / 83 | 3292 / 2648 | 260 MiB |
| JPEG 相当 | 露光量 | 2 | 3315 / 2666 | 450 / 318 | 66 / 44 | 994 / 820 | 188 / 124 | 4788 / 3878 | 295 MiB |
| JPEG 相当 | 露光量 | 3 | 3940 / 3162 | 597 / 429 | 68 / 46 | 1007 / 820 | 247 / 168 | 5885 / 4763 | 325 MiB |
| JPEG 相当 | 局所階調 | 1 | 1849 / 1503 | 314 / 223 | 90 / 60 | 575 / 448 | 121 / 80 | 2849 / 2283 | 257 MiB |
| JPEG 相当 | 局所階調 | 2 | 2452 / 1944 | 488 / 342 | 92 / 60 | 572 / 454 | 179 / 121 | 3947 / 3163 | 289 MiB |
| JPEG 相当 | 局所階調 | 3 | 3070 / 2399 | 654 / 465 | 94 / 62 | 595 / 450 | 240 / 160 | 5134 / 4023 | 322 MiB |
| signed RAW | — | 0 | 2631 / 2119 | 261 / 149 | 83 / 54 | 843 / 757 | 84 / 55 | 3829 / 3156 | 192 MiB |
| signed RAW | cube のみ | 1 | 3782 / 3054 | 361 / 212 | 106 / 64 | 1078 / 913 | 186 / 118 | 6260 / 5325 | 215 MiB |
| signed RAW | cube のみ | 2 | 4923 / 3990 | 456 / 275 | 106 / 65 | 1081 / 910 | 282 / 184 | 8649 / 7452 | 232 MiB |
| signed RAW | cube のみ | 3 | 6004 / 4948 | 560 / 342 | 108 / 67 | 1081 / 916 | 385 / 245 | 10993 / 9559 | 253 MiB |
| signed RAW | 露光量 | 1 | 3910 / 3152 | 519 / 302 | 193 / 93 | 1089 / 893 | 168 / 112 | 6327 / 5387 | 278 MiB |
| signed RAW | 露光量 | 2 | 5192 / 4210 | 775 / 462 | 195 / 96 | 1114 / 892 | 248 / 167 | 8816 / 7570 | 333 MiB |
| signed RAW | 露光量 | 3 | 6452 / 5268 | 1059 / 607 | 199 / 96 | 1114 / 893 | 326 / 225 | 11340 / 9755 | 375 MiB |
| signed RAW | 局所階調 | 1 | 4254 / 3461 | 643 / 410 | 112 / 81 | 1492 / 1206 | 163 / 113 | 6703 / 5703 | 278 MiB |
| signed RAW | 局所階調 | 2 | 5940 / 4828 | 1032 / 666 | 111 / 82 | 1474 / 1212 | 238 / 170 | 9635 / 8232 | 333 MiB |
| signed RAW | 局所階調 | 3 | 7641 / 6258 | 1418 / 916 | 114 / 84 | 1436 / 1217 | 321 / 227 | 12617 / 10832 | 390 MiB |

読み方（目安との比較）:

- **1 枚のマスクのスライダーの drag は JPEG 相当で目安内、RAW でほぼ目安**（wasm で JPEG 相当 66〜94 ms、RAW 106〜114 ms）。描き直すのはその層だけで、`R0` とほかの層は結果を使い回すので、枚数に依らずマスク無しの drag（wasm 59 / 84 ms）に面と合算など（native 約 7 ms・wasm 約 20 ms）を足した程度。RAW の露光量のマスクだけは、drag のたびにその層の master を作り直すので約 195 ms（全体の露光量を drag するのと同じ費用）で目安を超える。
- **離した final 1280 はほぼ目安**（wasm で JPEG 相当 0.57〜1.02 s、RAW 1.08〜1.49 s）。`R0` とほかの層の final を使い回し、その層だけを描く。RAW の局所階調の層は自分の原寸の master を作り直す分（約 0.4 s）重い（離した final の原寸の master を層に持たせないため。下の memory）。
- **全体のスライダーの drag は目安を超える**（マスク 3 枚の wasm で JPEG 相当 240〜289 ms、RAW 321〜385 ms）。全体が変わると全部の層を描き直すので、「枚数 + 1」枚の drag の描画になる（#92 の前の測定。#92 からは drag 中に層の差分を使い回す。下の 640px の表）。
- **初回 final と final 原寸は目安を超える**（マスク 3 枚の wasm で JPEG 相当の初回 3.0〜3.9 s・原寸 5.0〜5.9 s、RAW の初回 6.0〜7.6 s・原寸 11〜12.6 s）。全部の層の final を描く。マスク無しでも初回 final は niho-6 の解析（特徴 約 0.27 s・露光量ごとの係数 約 0.36 s、native）で 1 s を超えている。
- 主な費用（native、1 層あたり）: 1280 の final の全画素の描画 約 0.15 s（原寸 2048 では約 0.5 s）、その層の cube の焼き直し（cube P・Q 各 約 0.1 s）、露光量の層は niho-6 の解析（露光量ごと 約 0.36 s）と master（原寸 約 0.05 s）、局所階調の層は局所階調の pass（1280 で 約 0.1 s）、RAW の層は自分の master と（統計が設定に依るので）局所階調の pass。
- memory（wasm の最大）: マスク無し 187〜192 MiB に対し、3 枚で 253〜390 MiB（自分の master を持つ層が多いほど大きい）。1 層あたり、結果 2 枚（quality ごと）・面（4 byte/画素）と、自分の画像を描く層は表示寸法の master・局所階調の pass を持つ。色ポイントが有効なら、その面（24 byte/画素。2048×1365 で約 64 MiB）も層ごとに持つ。

この PR で入れた対策: 層ごとのキャッシュの入れ替えと結果の使い回し（`R0` と各層・quality ごと）、`R0` と同じ画像を描く層の master・縮小・窓・統計・局所階調の pass の共有、面が全部 0 の層・`L` が全体と同じ層を描かない、面の使い回し（形だけを動かす間は描画しない）、niho-6 の解析を露光量が同じなら final でも使い回す（共有の 1 枠を層と取り合わない）、離した final の前に `R0` の master をその描画のものにそろえる、離した final の原寸の master を層に持たせない。

### drag を 640px で描くとき（M3 #67 の既定）

エディタは、有効なマスクがある間の drag（スライダー・つまみ）を長辺 640px の interactive で描く（`developInteractiveMaxDimension`。色ポイントと同じ。離した final は 1280px のまま）。同じ入力で `mask_timing -- --drag 640` と `mask-wasm-bench.mjs ... --drag 640` を、#92 の前（origin/main `f4b878b`）と後で同じ時間帯に測った（Mac Studio M1 Max・2026-10-21〜22・エンジン 0.24.0（engine niho-13）・Node 24.18・3 回のうち最も速いもの・load average 5〜30）。値は ms。

- drag（全体）＝離した final の後、全体のコントラストを 1 ずつ動かす 6 枚の中央値。その最初の 1 枚（起点。層を描く）は「最初の 1 枚」に分けて示す。
- drag（全体・速い）＝続けてコントラストを 1 枚ごとに 10 動かす 6 枚の平均（上限 25 を 3 枚に 1 回超え、その 1 枚は層を描く）。
- 「前 → 後」は #92 の前と後。ほかの列は後（前と ±5% の揺れの内で同じ。描く経路を変えていない）。

native:

| 元 | 局所の差分 | 枚数 | 初回 drag | drag（その 1 枚） | drag（全体）前 → 後 | drag（全体）の最初の 1 枚 | drag（全体・速い）前 → 後 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| JPEG 相当 | — | 0 | 63 | 23 | 23 → 23 | 62 | 23 → 23 |
| JPEG 相当 | cube のみ | 1 | 93 | 28 | 54 → 23 | 93 | 54 → 33 |
| JPEG 相当 | cube のみ | 2 | 121 | 28 | 84 → 23 | 126 | 84 → 44 |
| JPEG 相当 | cube のみ | 3 | 153 | 29 | 114 → 22 | 152 | 114 → 52 |
| JPEG 相当 | 露光量 | 1 | 126 | 25 | 49 → 22 | 87 | 49 → 31 |
| JPEG 相当 | 露光量 | 2 | 191 | 26 | 76 → 23 | 117 | 76 → 41 |
| JPEG 相当 | 露光量 | 3 | 254 | 26 | 103 → 22 | 140 | 101 → 48 |
| JPEG 相当 | 局所階調 | 1 | 128 | 22 | 45 → 22 | 89 | 45 → 30 |
| JPEG 相当 | 局所階調 | 2 | 188 | 22 | 67 → 22 | 112 | 68 → 38 |
| JPEG 相当 | 局所階調 | 3 | 260 | 23 | 94 → 22 | 136 | 93 → 45 |
| signed RAW | — | 0 | 101 | 42 | 41 → 43 | 84 | 41 → 42 |
| signed RAW | cube のみ | 1 | 151 | 50 | 90 → 42 | 134 | 90 → 59 |
| signed RAW | cube のみ | 2 | 203 | 50 | 141 → 43 | 190 | 141 → 77 |
| signed RAW | cube のみ | 3 | 248 | 49 | 190 → 42 | 236 | 192 → 93 |
| signed RAW | 露光量 | 1 | 200 | 47 | 92 → 41 | 142 | 89 → 56 |
| signed RAW | 露光量 | 2 | 313 | 49 | 128 → 43 | 190 | 127 → 69 |
| signed RAW | 露光量 | 3 | 410 | 48 | 175 → 43 | 233 | 171 → 87 |
| signed RAW | 局所階調 | 1 | 270 | 57 | 86 → 43 | 256 | 87 → 58 |
| signed RAW | 局所階調 | 2 | 436 | 57 | 127 → 43 | 301 | 129 → 72 |
| signed RAW | 局所階調 | 3 | 582 | 55 | 171 → 41 | 331 | 176 → 83 |

wasm（マスク 0 枚と 3 枚）:

| 元 | 局所の差分 | 枚数 | 初回 drag | drag（その 1 枚） | drag（全体）前 → 後 | drag（全体）の最初の 1 枚 | drag（全体・速い）前 → 後 | wasm memory |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| JPEG 相当 | — | 0 | 82 | 30 | 30 → 30 | 80 | 30 → 31 | 209 MiB |
| JPEG 相当 | cube のみ | 3 | 232 | 46 | 176 → 31 | 229 | 175 → 76 | 276 MiB |
| JPEG 相当 | 露光量 | 3 | 338 | 36 | 128 → 30 | 184 | 126 → 64 | 346 MiB |
| JPEG 相当 | 局所階調 | 3 | 328 | 34 | 122 → 30 | 178 | 122 → 60 | 340 MiB |
| signed RAW | — | 0 | 167 | 53 | 53 → 53 | 143 | 51 → 53 | 167 MiB |
| signed RAW | cube のみ | 3 | 371 | 71 | 259 → 53 | 354 | 259 → 122 | 241 MiB |
| signed RAW | 露光量 | 3 | 677 | 104 | 210 → 53 | 331 | 209 → 106 | 295 MiB |
| signed RAW | 局所階調 | 3 | 885 | 68 | 209 → 54 | 449 | 209 → 106 | 295 MiB |

- **全体のスライダーの drag（起点から上限の内）は目安内**: マスク 3 枚の wasm で JPEG 相当 30〜31 ms（前 122〜176 ms）、RAW 53〜54 ms（前 209〜259 ms）。マスク無しの drag（30 / 53 ms）と同じで、枚数と局所の差分の種類に依らない（`R0` の描画と 1 回の `clamp(R0 + S)` だけ。マスク無しとの差は計測の揺れの内）。
- **速い drag**（上限を 3 枚に 1 回超える）は平均で wasm の JPEG 相当 60〜76 ms、RAW 106〜122 ms。上限を超えた 1 枚は前の drag（全体）と同じ費用で全部の層を描く。1 枚あたりの動きが上限より大きい drag は毎回描くので、前と同じになる。
- **drag（全体）の最初の 1 枚は変わらない**（wasm で JPEG 相当 178〜229 ms、RAW 331〜449 ms）。離した final は interactive のフレームと起点を捨てるので、drag を始めるたびに 1 枚は全部の層を描く（final の層から起点を作る案を採らなかった理由は上の「全体のスライダーの drag」）。
- **1 枚のマスクのスライダー・つまみの drag**は wasm で JPEG 相当 34〜46 ms、RAW 68〜104 ms（RAW の露光量のマスクは、drag のたびにその層の master を作り直すので 104 ms）。1280px の drag（M2 の表。wasm で 66〜199 ms）から大きく下がる。
- 初回 drag（その写真・その設定で最初の interactive）は 100 ms を超える（層ごとの cube・局所階調の pass を作るため）。初回 final・離した final・final 原寸は変わらない（final の経路は変えていない。bytes も同じ）。
- memory: 起点の `S` は 640×427 で約 1.6 MB で、wasm の最大は前と同じか小さい（差は 2% 未満。アロケータの揺れ）。

残る費用（drag の最初の 1 枚、速い drag で上限を超えた 1 枚、初回 drag、初回 final、final 原寸）の次の対策（提案。描画の経路の変更が要る）:

1. **層を面の外接矩形の中だけ描く**: `R_k` が要るのは `w_k > 0` の画素だけ。出力の部分矩形を描く口（効果の位置と局所階調の pass の key は全体の枠のまま）を足すと、小さい円形の層は数分の 1、半分を覆う線形は約半分になる（層を描くすべてのフレームに効く）。
2. **cube だけが違う層を `R0` と同じ走査で描く**: 頭の段と局所階調の pass は 1 回、末尾の cube の段だけを層ごとに通す（「cube のみ」の層の 1 層あたりの費用が全画素の描画から末尾の段だけになる）。
3. **drag 中だけ層の差分を前のフレームのものにする**: #92 で入れた（上の「全体のスライダーの drag」）。起点を final の後も残して次の drag の最初の 1 枚に使う（final で更新される niho-6 の解析を起点が知らないまま近似する）のは、final で interactive のフレームを捨てる今の決まりを変えるので owner の判断が要る。

## 対象外（今回）

範囲マスク（輝度・色・深度）、マスクの不透明度、マスクごとのカーブ・カラーグレーディング・シャープ・ノイズ（#32 の後）、順序で結果が変わる重ね方、ブラシの自動なぞり補正、Lightroom の XMP へのマスクの書き出し。
