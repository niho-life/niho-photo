# niho-14 H/S 応答の解析を軽くする（#89）

`niho-14` は Issue #89 の engine で、[`niho-13`](NIHO13.md) の数式（raster の相対 WB を処理の先頭で当てる）のまま、`niho-6` の Highlights / Shadows 応答の**解析**（特徴量と網）を軽くしたもの。応答の係数・750px の解析画像・gain・それ以外の数式はすべて `niho-13` と同じ。保存済みの `niho-1`〜`niho-13` の補正はその engine のまま描き、`niho-14` へ昇格させない。

状態: JPEG / PNG・raster 作業コピー・unsigned RAW 作業コピーの**新規編集の既定**（2026-10-22。計測の前に固定した「採否の規則」をすべて満たした）。

## 数式と入力境界

`niho-13` との違いは `niho-6` の解析の 2 か所だけ（`crates/niho-develop/src/niho14_analysis.rs`）。

1. 特徴量: 26 個の特徴量のうち、局所の 4 段（σ = 4・16・64・128 解析画素）の大きい 2 段（σ = 64・128）の局所平均を、`ln`（log2 輝度）と `y`（輝度）の plane を 4 分の 1 の格子へ面積平均で縮めてから求める。縮めた格子の間隔（軸ごと）で σ と半径 4σ を取り、`niho-13` と同じ反射の境界でぼかし、各解析画素の中心で双線形に読み戻す。σ = 4・16 と、それ以外の特徴量（ln・比・分位点・順位）は `niho-13` と同じ計算。
2. 網: 同じ係数を `f32` にし、4 画素を 1 本の SIMD（wasm simd128 / NEON の f32x4）で回す。各出力は bias に入力を順に足す（`niho-13` と同じ順、FMA なし）。`tanh x = ±(1 − t)/(1 + t)`（`t = e^{−2|x|}`、`|x|` は 9 で止める）、softplus は `max(v, 0) + ln(1 + e^{−|v|})`（対数は atanh の級数）。`e^x` は `x = n·ln 2 + r`（`|r| ≤ ln 2 / 2`、ln 2 は f32 で正確な上位と残りに分ける）にして `e^r` を 7 次までの Taylor 級数（次の項は f32 の精度より小さい）、`2^n` を指数部の bit で作る。`f32` の数 ulp の誤差。

演算は IEEE の加減乗除・比較・選択・最近接偶数への丸め・指数部の bit だけで、順序は固定。native（NEON）・wasm（simd128）・SIMD の無い移植版の lane が同じ bit を出す（`tests/niho6_cross_target.rs` が native と wasm で maps と画素の hash を固定、`tests/niho14.rs` が移植版と一致を検査）。

- H/S 応答を使わない設定（raster で Highlights < 0・Shadows > 0 が無い）と、旧（unsigned）RAW 作業コピーは `niho-13` と同じ byte 列（`tests/niho14.rs`）。
- signed `signed-gamma18-v1` と camera-linear: 拒否（`niho-13` と同じ）。
- XMP の読み書き・プリセット・相対 WB は `niho-13` と同じ。
- Session の cache（`niho-6` の特徴量・解析・master・gain）は解析の種類（`niho-6`〜`niho-13` の凍結した解析 / `niho-14` の軽い解析）を key に含み、同じ写真で両方を描いても混ざらない。

保存済み `niho-14` の画素は以後変えない。

## 画素を変えない高速化（全 engine）

`niho-6` を使う全 engine（`niho-6`・`niho-8`・`niho-10`・`niho-12`・`niho-13`）と NIHO 3 の RAW 応答に効く、画素を変えない変更も入れた。

- 網（`niho6_response.rs`）: 層の出力を横に並べ、各入力をすべての出力に足してから次の入力へ進む（各出力の加算の順は同じ）。8 出力が独立に並び、compiler が SIMD の lane に置ける。凍結した参照の計算と 4096 標本 × 2 網で bit 一致（unit test）。
- ぼかし（`raw_response/simd.rs`）: 1 回に 32 画素（f32x4 × 8 本の累積）を進める。各出力の tap の順は同じ（参照のぼかしと bit 一致の unit test に 32・16・端数の幅を追加）。
- 分位点（`raw_response.rs`）: 全体を並べ替えず、読む順位の値だけを選ぶ（`select_nth_unstable`。`f32::total_cmp` の順位の値は並べ替えと同じ）。

`f64` の `tanh` を 2 lane の SIMD で同じ算法（musl の分岐を lane の選択に）にする案は、1 億組で `libm::tanh` と bit 一致したが、wasm でも native でも速くならなかった（分岐の無い全経路の計算が lane の利得を打ち消す）ので入れていない。

旧 engine の不変は、合成入力で `crates/niho-develop/examples/engine_digests.rs`（`niho-1`〜`niho-13` × raster 2 場面・raster 作業コピー・旧 RAW・signed RAW × 13 設定 × Interactive・Final・縮小 Interactive・WB の drag 3 コマと確定・戻し・色取得・自動・one-shot）の 8,112 行（描けない組のエラー 3,614 行を含む）を base（`f4b878b`）と比べ、すべて一致した。

## 採否の規則（計測の前に固定、2026-10-22）

次をすべて満たせば `niho-14` を JPEG / PNG・raster 作業コピー・unsigned RAW 作業コピーの新規編集の既定にする。1 つでも満たさなければ `niho-14` は既定にせず、画素を変えない高速化だけを残す。

1. 性能: wasm（Studio の Node、SIMD）1280×960 の合成写真で、H/S を使う設定の WB を drag して離した後の確定（Final）が 1 秒以内（6 process の中央値）。
2. Lightroom との差（開発用教師 57 場面 × 中立・プリセット 3 本 = 228 組。gate と同じ 2048px 描画 → 長辺 1500・blur 2・平坦画素・位置合わせの CIEDE2000）:
   - 中立・各プリセットの mean の平均と p99 の平均が、`niho-13` から +0.02 以内。
   - 各組の mean の増加が 0.5 未満。
   - p99 > 8 の組の数が `niho-13` より増えない。
3. `niho-13` との画素差（開発用教師 57 場面 × プリセット 3 本 × 相対 WB 5 通り = 855 組。`tools/color-review-build-diff.py` と同じ手順）: 各組で mean ≤ 0.3 かつ p99 ≤ 1.5（#27 で「解析は WB 前」の代案に当てたのと同じ規則）。

sealed の独立 cohort は開かない。

## 結果（2026-10-22）

規則の 1〜3 をすべて満たしたので、`niho-14` を新規編集の既定にした。規則は計測の前に `b3d5bc8` で固定した。その後 `e^x` の多項式を第三者の係数から Taylor 級数に替えた（`a220848`）ので、2・3 は最終の定義で計測し直した（替える前も同じ結果だった）。

### 1. 性能（wasm）

[公開測定](fixtures/color/review-2026-10-22/round89-wasm-performance.json)。`color-review-wasm-bench.cjs` の合成写真（1024×768 と、画面のプレビューの長辺の 1280×960）、Highlights −75・Shadows +55 などの同じ設定で、コントラストの drag の後に相対の色温度を 5 コマ drag して離す。base（`f4b878b`）と今（`a220848`）の build を 1 回ずつ別 process で交互に 6 回走らせた中央値（engine の順は回す）。Studio の Node・wasm SIMD、`nice -n 10`、load average は 1280×960 で 3.8〜8.2、1024×768 で 2.4〜3.8。単位は ms。

| 大きさ | build / engine | WB の drag 1 コマ（中央値 / 最大） | WB を離した後の確定 | 写真を開いた直後の初回（Interactive） |
| --- | --- | ---: | ---: | ---: |
| 1280×960 | base / `niho-13` | 100.7 / 107.2 | 1189.2 | 1067.3 |
| 1280×960 | 今 / `niho-13`（画素は同じ） | 101.9 / 105.1 | 988.1 | 799.9 |
| 1280×960 | 今 / `niho-14` | 102.9 / 104.5 | **551.0** | **352.2** |
| 1280×960 | 今 / `niho-12`（参考） | 75.3 / 78.5 | 220.4 | 782.3 |
| 1024×768 | base / `niho-13` | 65.4 / 70.3 | 1030.1 | 1064.7 |
| 1024×768 | 今 / `niho-13`（画素は同じ） | 63.8 / 66.9 | 853.6 | 755.9 |
| 1024×768 | 今 / `niho-14` | 66.8 / 71.1 | **424.1** | **347.2** |
| 1024×768 | 今 / `niho-12`（参考） | 48.1 / 48.9 | 137.7 | 774.6 |

- WB を離した後の確定: 画素を変えない高速化だけで 1280×960 は 1189 → 988ms と 1 秒をわずかに下回るが、余裕は 1% で host の load で超える（同じ日の別の 6 回は 973ms）。`niho-14` は 551ms（1024×768 は 424ms）。
- 写真を開いた直後の初回（最初の Interactive。解析を含む）: 1067 → 800ms（画素を変えない）→ 352ms（`niho-14`）。初回の確定（Final）は 1280×960 で 790〜830ms、1024×768 で 670〜710ms で、engine と build によらない（Final の 64³ cube を焼く分。解析は Interactive で済んでいる）。
- WB の drag の 1 コマは変わらない（drag 中は直前の解析を使い回す。1280×960 で目安の 100ms をわずかに超えるのは `niho-13` と同じ、WB 済みの元画像と master の作り直し）。コントラストの drag・確定も変わらない。

### 解析の内訳

[内訳](fixtures/color/review-2026-10-22/round89-analysis-breakdown.json)。上の合成写真（1280×960）の 750×563 の解析画像で、同じ commit の解析の段を JavaScript から呼べるようにした計測用の build（commit しない。画素は同じ）の `performance.now()`。3 process の中央値、load average 2.3〜2.5。単位は ms。

| 段 | base | 今・凍結した解析（`niho-6`〜`niho-13`） | 今・`niho-14` |
| --- | ---: | ---: | ---: |
| 特徴量 | 335.2 | 331.0 | 93.3 |
| 網（highlight・shadow の 2 本） | 452.6 | 279.3 | 75.7 |
| 合計 | 787.8 | 610.3 | 169.0 |
| 網の初回（wasm の baseline tier を含む） | 472.3 | 271.7 | 77.0 |

- 特徴量の大半は局所の 4 段のぼかし（1 plane で σ = 4・16・64・128 が 7.2・14.2・43.8・81.3ms、`ln` と `y` の 2 plane ずつ）。各出力の 8σ+1 tap の加算を順に保つ限り計算量は減らせず、画素を変えない変更では 1% しか縮まない。`niho-14` は σ = 64・128 を 4 分の 1 の格子でぼかし、残りは σ = 4・16 のぼかし（約 50ms）と対数・分位点・順位。
- 網は層の出力を横に並べるだけで 453 → 279ms（各出力の加算の順は同じ）。残りの大半は `libm::tanh`（1 画素 24 回）で、bit を変えずには削れない。`niho-14` の `f32` SIMD は 76ms。網の呼び出しを画素の loop から分けたので、wasm の engine が最適化した code へ移るのは最初の数千画素の後で、初回も 77ms（分ける前は 228ms）。
- 確定の残り（局所階調の統計・pass、描画など。[NIHO13.md](NIHO13.md) の内訳で約 0.4 秒）は変えていない。

### 2. Lightroom との差（開発用教師 228 組）

[匿名集計](fixtures/color/review-2026-10-22/round89-teacher-development.json)（`a220848` の build）。

| 組 | mean の平均（`niho-13` → `niho-14`） | p99 の平均 | p99 の最大 | p99 > 8 |
| --- | ---: | ---: | ---: | ---: |
| 中立 | 0.2598 → 0.2598 | 0.9207 → 0.9207 | 2.215 → 2.215 | 0 → 0 |
| bluesky2 | 2.0976 → 2.0976 | 4.8729 → 4.8729 | 10.050 → 10.050 | 4 → 4 |
| pastel | 2.7773 → 2.7773 | 6.2172 → 6.2172 | 9.583 → 9.583 | 5 → 5 |
| colorful | 2.5358 → 2.5358 | 6.3743 → 6.3741 | 13.604 → 13.603 | 14 → 14 |

- 変化は preset の平均で mean ±0.00001、p99 −0.0002〜+0.00005（規則は +0.02 以内）。組ごとの mean の増加は最大 0.0001（規則は 0.5 未満）、p99 の増加は最大 0.0007。p99 > 8 は 23 → 23 件（新たに超えた組は 0）。
- 中立の 57 組は H/S 応答を使わないので同じ byte。
- `niho-13` の colorful の値は #27 の記録（p99 > 8 が 13 件）と違う。#27 の計測（`7ba8706`）の後の main の変更で colorful の 57 組の描画が変わったためで、#89 の前後（`f4b878b` と今）の `niho-13` は同じ byte（下の 4）。

### 3. `niho-13` との画素差（855 組）

[匿名集計](fixtures/color/review-2026-10-22/round89-niho14-vs-niho13.json)（教師 57 場面 × プリセット 3 本 × 相対 WB 5 通り、`color-review-build-diff.py --engine niho-13 --candidate-engine niho-14`）。

- mean の平均 0.0001・最大 0.0007、p99 の平均 0.0039・最大 0.0098、画素の最大 0.148。規則（各組 mean ≤ 0.3 かつ p99 ≤ 1.5）を超える組は 0。WB・プリセットのどの組み合わせでも同じ程度（p99 の最大は WB ごとに 0.008〜0.010）。
- 応答の gain の差（教師 59 枚の解析画像、Highlights −75・Shadows +55）は平均 1.2e-5 EV、p99 9.6e-5 EV、最大 1.1e-3 EV（σ = 16 も縮めると最大 1.5e-2 EV になるので縮めない）。

### 4. 旧 engine の不変（実写）

[匿名集計](fixtures/color/review-2026-10-22/round89-niho13-before-after.json)。#89 の前（`f4b878b`）と後（`5b4c555`）の build で、同じ教師 855 組（プリセット 3 本 × 相対 WB 5 通り）を `niho-13` で描き、855 組すべてで描画の PNG が同じ byte だった（`color-review-build-diff.py`）。合成入力の `engine_digests`（上の「画素を変えない高速化」）と合わせ、画素を変えない高速化が `niho-1`〜`niho-13` の画素を動かしていないことを確かめた。

## 既定と互換

- crate: `ENGINE_VERSION` は `niho-14`（reader capability）、workspace は 0.26.0（#89 の作業中に main が 0.25.0 を使ったので次の版）。`DevelopSettings::neutral()` / `new_edit()` は互換の既定（`niho-1`）のまま。
- 画面（`packages/photo-editing` の `develop-settings.ts`）: `DEVELOP_SETTINGS_ENGINE` は `niho-14`、保存済みの `niho-13` は `NIHO13_DEVELOP_SETTINGS_ENGINE`。直接描く JPEG / PNG、`raster.*`、unsigned の `raw-apple.*` の未保存の写真は `niho-14` で開く。作業コピーの無い RAW と版の分からない作業コピーは `niho-2`、signed RAW の既定（`niho-3` / `niho-11`）は変えない。
- 保存済みの `niho-2` / `niho-6` / `niho-10` / `niho-12` / `niho-13` は、開く・プリセット・初期化・貼り付けで `niho-14` に変えない（Rust の XMP 経路も同じ）。既定の切替前に作った未保存 draft（`niho-13` を含む）はその数式のまま戻す。
- 画面の wasm は `/develop-engine/niho-14/manifest-0.26.0.json` を読む。`niho-14` の補正を描く非公開側（ワーカー・Web の配備）は、この版の固定 SHA を取り込んでから画面を配る（#2）。

## 再現手順

exact commit を push した後に Mac Studio で実行する。教師の写真・Lightroom の書き出し・行ごとの結果は repository の外の作業ディレクトリに置き、匿名集計だけを公開する。

```sh
cargo +1.98.1 build --release --locked --manifest-path packages/develop-engine/Cargo.toml -p niho-develop-render --bins
cargo +1.98.1 build --release --locked --manifest-path packages/develop-engine/Cargo.toml -p niho-develop --example render_rgba --example engine_digests

# 旧 engine の不変（base と今の build の engine_digests を比べる）
packages/develop-engine/target/release/examples/engine_digests > digests.txt

# 開発用教師（<work>/data/teachers と teachers2）
python3 packages/develop-engine/tools/color-review-teachers.py --repo . --work <work> --engines niho-13,niho-14 --workers 4

# niho-13 との画素差（同じ build で engine だけ替える）と、base の build との niho-13 の画素差
python3 packages/develop-engine/tools/color-review-build-diff.py --repo . --work <work> \
  --baseline-bin <niho-develop-render> --candidate-bin <niho-develop-render> --engine niho-13 --candidate-engine niho-14 --workers 4
python3 packages/develop-engine/tools/color-review-build-diff.py --repo . --work <work> \
  --baseline-bin <base の niho-develop-render> --candidate-bin <niho-develop-render> --engine niho-13 --workers 4

cargo +1.98.1 build --release --locked --target wasm32-unknown-unknown \
  --config packages/develop-engine/.cargo/config.toml \
  --manifest-path packages/develop-engine/Cargo.toml -p niho-develop-wasm
wasm-bindgen --target nodejs --out-dir <wasm-out> \
  packages/develop-engine/target/wasm32-unknown-unknown/release/niho_develop_wasm.wasm
node packages/develop-engine/tools/color-review-wasm-bench.cjs <wasm-out>/niho_develop_wasm.js niho-12,niho-13,niho-14 "" 1280x960
```

## 対象テスト

```sh
cargo +1.98.1 test --locked --manifest-path packages/develop-engine/Cargo.toml -p niho-develop \
  --test niho14 --test niho13 --test niho6 --test niho6_cross_target --lib
CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER=wasm-bindgen-test-runner cargo +1.98.1 test --locked \
  --config packages/develop-engine/.cargo/config.toml --manifest-path packages/develop-engine/Cargo.toml \
  --target wasm32-unknown-unknown -p niho-develop --test niho6_cross_target
npm -C packages/photo-editing test
```

`tests/niho14.rs` は H/S 応答を使わない設定での `niho-13` との byte 一致（raster・raster 作業コピー・旧 RAW、切り抜き、WB、Interactive / Final、色取得）、応答を使う設定での差の上限（gain 2e-3 EV 未満・画素 1 code 以下）、移植版の lane との一致、同じ Session で `niho-13` と `niho-14` を交互に描いても one-shot と同じこと、作業コピー、拒否、プリセットと XMP を検査する。`niho14_analysis.rs` の単体テストは近似の誤差（tanh 絶対 1.5e-7・softplus 相対 4e-7・exp 相対 1.5e-7 未満。実測の最大は 8.9e-8・2.3e-7・8.2e-8）と SIMD と移植版の一致を、`niho6_cross_target` は `niho-14` の maps と画素の hash を native と wasm で固定する。
