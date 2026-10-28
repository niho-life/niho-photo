# ディテール（シャープ・ノイズ軽減。developSettings v6）

Issue #32。Lightroom のディテール（シャープ・輝度のノイズ軽減・カラーノイズの軽減）を段 2 に足し、JPEG / PNG と RAW のどちらでも描く。XMP の取り込みで「使えない項目」として知らせていたシャープ・ノイズ軽減は、近い式で描く項目（`approximate`）になる。色のパイプラインは変えない。

## 保存形

`developSettings.detail` が存在する設定は `v: 6` とする。v5 は部分補正（マスク、Issue #31）が使う。形は次の exact object で、未知キー、欠落、非有限値、範囲外を Rust と TypeScript の両方で拒否する。

```json
{
  "sharpening": { "amount": 0, "radius": 1, "detail": 25, "masking": 0 },
  "luminanceNoiseReduction": 0
}
```

- `sharpening.amount` 0〜150、`radius` 0.5〜3.0、`detail` 0〜100、`masking` 0〜100、`luminanceNoiseReduction` 0〜100。
- `colorNoiseReduction`（0〜100）は任意。省略は signed RAW の旧 top-level `colorNoiseReduction`（R209、上限 50）を保ち、明示値は 0 を含めてそれを上書きする。JPEG / PNG・旧（unsigned）RAW は旧 top-level 値を引き続き無視し、v6 内で明示された値だけを使う。従って RAW でも raster でもカラー NR は一回だけ。
- 画面はすべてが既定（シャープ 0・半径 1・ディテール 25・マスク 0・ノイズ軽減 0・カラーの明示なし）に戻ったら `detail` ごと消す。ディテールを使っていない写真は v6 にならない。

## 処理順

immutable float source → カラー NR → edge-preserving 輝度 NR → canonical RAW H/S 解析または NIHO raster 解析 → WB / 露光 → 局所階調 → look / tone / color / color points / grading → output-resolution linear-sRGB luma sharpening → output transform → vignette の output 段・grain → RGBA8。NR 済み source を canonical 解析、local statistics、通常 render、`sampleColor` で共有する。シャープは RGBA8 を decode せず float 出力境界で行い、grain 等の output effect を再適用しない。

各スライダーの写し方は Lightroom のディテールの意味に合わせ、係数は Lightroom の書き出しの統計に当てた（下の「Lightroom への校正（round 32）」）。輝度 NR・カラー NR・USM の半径とマスクの判定の距離は 1500px の whole-image long edge 基準で拡縮する（局所処理と同じ規則。Lightroom の「原寸の画素」単位ではない）。crop は同じ whole-image scale と geometry window の halo を使うため、境界で radius や見た目を変えない（合成チャートで crop と全体の切り出しの差は 1 LSB 以内）。amount 0 は演算を通らず既存 pixel 経路を保持する。

原寸の書き出し（#133、`crates/niho-develop/examples/export_fidelity.rs`。合成の 6000×4000 を長辺 2560 で開いて描いた画面の画と、原寸で描いて線形光の Lanczos 3 で 2560 に縮めた画の ΔE00）: 半径は長辺の比で拡縮するので、細かい模様だけの写真では差が小さい（シャープ 80・半径 1・細部 25 で mean 0.08・p99 0.30、補正なしの床 0.06・0.12）。ノイズ軽減（輝度 40・カラー 25）も床に近い（p99 0.97、床 0.68）。縁では差が残る（明るい空の上の暗い枝の縁の画素で mean 2.15・p99 14.3、床 0.07・0.16）: 暗いハローの上限は明るさの 2 乗に比例し、原寸では縁をまたぐ画素ごとに上限を当ててから縮めるので、縁の暗い側が画面より深く沈む。上限を画面の縮尺で決め直す形（p99 14.0）と、画面での輝度の変化を原寸へ広げる形（p99 10.0。原寸の細かい模様の鮮鋭さが 32.7 → 26.9 に落ちる）は試したが入れていない。単位は今のまま（Lightroom の「原寸の画素」にはしない。owner 2026-10-28、#133）で、この差は既知の制限とする。

入力ごとの経路:

| 入力 | 数式（engine） | NR の場所 |
| --- | --- | --- |
| JPEG / PNG オリジナル | niho-1 / 2 / 6 / 8 / 10 | `render_linear` の先頭（linear sRGB） |
| raster 作業コピー（HEIC / TIFF / 大きな PNG） | 同上 | `render_linear` の先頭（linear ProPhoto） |
| 旧 RAW 作業コピー（unsigned） | niho-1 / 2 / 8 | `render_raw` の前（linear ProPhoto。この Issue で追加） |
| signed RAW 作業コピー | niho-3 / 4 / 5 / 7 / 11 | canonical master の準備（`niho3.rs` / `niho4.rs`） |

Session の再利用単位は immutable source、NR 量、working size、geometry window、quality。量・サイズ・geometry・Interactive / Final の変更で一致しない cache を再利用しない。RAW の canonical response / statistics cache も effective CNR と輝度 NR 量を key に含める。

カラー NR は入力で二つに分かれる。JPEG / PNG・raster / 旧 RAW の作業コピーは、Lightroom の書き出しに合わせた raster の式（下の校正。25 で効き切り、25〜100 は同じ）。signed RAW は従来どおり R209 の契約（明示 v6 の 0〜50 は R209 と同じ、50 を超える範囲は同じ guided filter の正則化を連続的に強めて 100 で 50 時の 4 倍、旧 top-level は 50 で飽和）で、今回の JPEG のチャートでは校正していない。どちらも一回だけ当てる。

### drag と final

Interactive（つまみを動かしている間）はシャープを省き、Final（離した後・書き出し）は float plane から必ず確定する（Issue の「drag は final だけ」）。crate は NR を Interactive でも描く（RAW などの作業コピーで drag 中に NR を描き直さないのは画面側の送り方。下の「プレビューへの送り方」）。合成チャートの全入力で、Interactive のシャープあり / なしが同じ画素になり、Final でエッジの鋭さが上がることをテストで固定する（`tests/detail_effect.rs`）。

## XMP（Lightroom のディテール）

読み（`src/xmp/detail.rs`）は Lightroom のプリセットと同じパッチで、XMP にあるキーだけが写真の値を置き換える。値は有限数だけを範囲に丸めて使う。

| XMP | developSettings | 範囲 | Camera Raw の既定 | NIHO の読み | 書き（群） |
| --- | --- | --- | --- | --- | --- |
| `Sharpness` | `detail.sharpening.amount` | 0〜150 | RAW 40 / JPEG・TIFF 0 | approximate（0 は exact） | `sharpening` |
| `SharpenRadius` | `detail.sharpening.radius` | 0.5〜3.0 | 1.0 | approximate（量 0 は exact） | `sharpening`（小数 1 桁・符号付き） |
| `SharpenDetail` | `detail.sharpening.detail` | 0〜100 | 25 | approximate（量 0 は exact） | `sharpening` |
| `SharpenEdgeMasking` | `detail.sharpening.masking` | 0〜100 | 0 | approximate（量 0 は exact） | `sharpening` |
| `LuminanceSmoothing` | `detail.luminanceNoiseReduction` | 0〜100 | 0 | approximate（0 は exact） | `noiseReduction` |
| `LuminanceNoiseReductionDetail` / `Contrast` | なし（保持のみ） | 0〜100 | 50 / 0 | 既定値なら approximate、ほかは unsupported（輝度 0 なら exact） | 書かない |
| `ColorNoiseReduction` | `detail.colorNoiseReduction`（signed RAW で 50 以下なら旧 top-level） | 0〜100 | RAW 25 / JPEG・TIFF 0 | approximate（描く量が 0 なら exact） | `noiseReduction` |
| `ColorNoiseReductionDetail` / `Smoothness` | 旧 top-level（保持のみ） | 0〜100 | 50 / 50 | 50 なら approximate、ほかは unsupported（カラー 0 なら exact） | `noiseReduction` |

Photo Bench はどれも描かなかったので、Photo Bench の level は unsupported のまま。範囲外の値は丸めて approximate とし、丸めたことを注記する。読めない値は unsupported で `legacySettings` に残す。

既定値の扱い（テストで固定: `tests/xmp_detail.rs`）:

- XMP に無いキーは写真の今の値（`detail` が無ければ NIHO の既定）を保つ。片方だけある組では、無い側は Camera Raw の既定（半径 1.0・ディテール 25・マスク 0・輝度 0）と同じ NIHO の既定になる。
- Camera Raw の種類別の既定（RAW: `Sharpness` 40 / `ColorNoiseReduction` 25、JPEG・TIFF: 0 / 0）は、値が XMP に書かれていないときに補わない。NIHO の neutral の描画は既存の画素を保つためで、XMP が書いた値は写真の種類によらずそのまま当てる（Lightroom がプリセットを当てるのと同じ）。
- `detail` は、旧の形で表せない値のときだけ作る: シャープ（または既定でない半径・ディテール・マスク）、輝度 NR、旧 top-level が描かないカラー NR（JPEG / PNG・旧 RAW の 0 より大きい値、signed RAW の 50 を超える値）。JPEG の既定（全部 0）の XMP やカラー NR 25 だけの signed RAW 向け XMP は形の版を上げず、画素も以前と同じ。
- プリセットの適用量（0〜150%）は、写真の値（`detail` が無ければ既定、カラー NR は今描いている量）からプリセットの値へ各量を動かす。

同梱プリセットでは `niho-colorful` だけがシャープ 40・カラー NR 25 を持ち、取り込むとそれを描く（Lightroom で当てたときと同じ）。Photo Bench との golden（`tests/golden.rs`、手元の参照が必要な ignored test）は色の比較なので、ディテールを外して比べる。

書き（`src/xmp/write.rs`）は群 `sharpening`（新規）と `noiseReduction` で、Camera Raw の型（半径だけ Real、ほかは Integer）に丸める。`detail` の無い写真は、signed RAW の旧カラー NR を除いて何も書かず、以前と同じバイト列になる。

## 画面

- PC の右パネルの効果の後ろに「ディテール」の群を足す。並びはよく使う 3 つ（シャープ・ノイズ軽減・カラーノイズの軽減）が先、シャープの効き方を決める応用の 3 つ（シャープの半径・シャープの細部・シャープのマスク）が後ろ（owner 2026-10-21: 応用的な機能は目立たない下の方へ。#86）。後ろの 3 つは Lightroom の「半径・ディテール・マスク」にあたり、離れていても何の設定か分かるよう名前に「シャープの」を付ける。半径は 0.1 刻みで小数 1 桁、ほかは整数。見出し・ⓘ・スライダーは既存の群と同じ部品。
- スマホの面（1 枚の編集の層）では、道具の帯の末尾（カラーミキサー・カラーグレーディング・ポイントカラー・切り抜きの後ろ）に「ディテール」を置く（#86）。帯は #80 から横に送れるので、道具が増えても名前は重ならない（320px でページ全体は横に送れず、帯だけが送れることを確認）。項目のチップの並びは PC と同じ。効果の項目（白黒の切り替え・周辺光量のスタイル等）はスライダー以外の部品が要り、層の段ではまだ描けないのでスマホには足さない。
- シャープが 0 の間はシャープの半径・細部・マスクを薄くして押せなくする（行は出したまま）。群名の横の ⓘ に項目ごとの 1 行の説明。シャープは「指を離すと反映します」、ノイズ軽減・カラーノイズの軽減は JPEG と挙動が違う所だけ「RAW などは指を離すと反映します」を足す。
- `v: 6` を読める wasm（Worker の `validateSettings` で最小の v6 を確かめる `ready.detail`）で開いた写真に出す。RAW・HEIC / TIFF の作業コピーや、RAW を開いている途中の仮の画にも出す（owner 判断 2026-10-21）。

### プレビューへの送り方（owner 判断 2026-10-21）

「RAW でも群を出す。ディテールを 0 以外にした写真だけ、drag 後の確定描画で当てる（drag 中はシャープを省く）。使わない写真の速さは今のまま」に従い、engine client（`develop-engine-client.ts` と `develop-detail-preview.ts`）が wasm へ送る設定を次のように決める。

| 入力 | drag 中（Interactive） | 確定描画（Final）・見本・色取得・書き出し |
| --- | --- | --- |
| JPEG / PNG・JPEG の作業コピー（`open`） | 今の値（NR を描く。シャープは crate が省く） | 今の値 |
| 旧 RAW・raster の作業コピー（16bit PNG） | `detail` を外す（NR もシャープも描かない） | 今の値 |
| signed RAW の作業コピー（niho-3/4/5/7/11） | 直前の確定描画の NR のまま（シャープは crate が省く） | 今の値 |

- 量の無い `detail`（シャープ 0・輝度 0・カラーの明示なし）はどの写真でも外して送る。ディテールを使わない写真は今までと同じ設定の JSON・同じ経路・同じ速さで描く。
- signed RAW は NR が原寸の canonical master の準備に入っている。drag 中に NR を外すと、master の key が変わって確定描画のたびに master を作り直す（実測で指を離すたびに 1.4〜3.1 秒）。直前の確定描画の NR のまま送ると、同じ master を使い回すので、ディテールを使っていない写真と同じ速さになる。NR を動かした後の確定描画では、今の NR で master を作り直す。
- drag 中の見た目が確定描画で変わるのは許容する（RAW などの NR とシャープは指を離すと反映）。

## 性能（Mac Studio M1 Max・wasm・Node 24 単スレッド）

`scripts/bench-session.mjs` の `detail` scenario で測った（合成チャートの作業コピー 2560×1707 と 24MP の JPEG）。detailFinal はシャープ 90・半径 1・ディテール 25・マスク 20・輝度 NR 40・カラー NR 25 の Final 2048、noiseFinal は輝度 NR 80 にした後の Final 2048。

Lightroom への校正（round 32）の前後を `paired`（同じ入力で前後の build を交互に 3 回）で比べた。Studio は別の重い作業と並行で負荷が非常に高い（load average 90〜100）ため、壁時計は大きくぶれる。process の CPU 時間の中央値を主に見る（壁時計の中央値 / CPU の中央値、ms。校正前 → 校正後）。

| 入力 | detailFinal 2048 | シャープの drag 1280（6 コマの平均） | 輝度 NR の drag 1280（6 コマの平均） | noiseFinal 2048 |
| --- | --- | --- | --- | --- |
| JPEG 24MP（2560 で開く） | 1401 / 848 → 577 / 456 | 105 / 67 → 147 / 48 | 370 / 177 → 94 / 76 | 875 / 697 → 369 / 331 |
| JPEG 24MP（原寸で開く） | 968 / 960 → 706 / 645 | 117 / 92 → 70 / 71 | 194 / 193 → 149 / 106 | 841 / 822 → 652 / 487 |
| 旧 RAW 作業コピー（unsigned, niho-2） | 2727 / 1505 → 3721 / 1154 | 172 / 97 → 272 / 79 | 432 / 194 → 290 / 103 | 3626 / 1370 → 3303 / 1021 |
| signed RAW 作業コピー（niho-11） | 3687 / 2201 → 3492 / 2092 | 292 / 198 → 216 / 190 | 1562 / 724 → 734 / 632 | 3487 / 1980 → 3168 / 1917 |

校正後はどの入力でも CPU 時間が減る。主な理由は raster のカラー NR を 17×17 の guided filter（ProPhoto への往復つき）から σ 0.9 の色比のぼかし（3 チャンネルの Gaussian 1 回）にしたことと、輝度 NR の log / exp を √ と二乗にしたこと。シャープは Gaussian 1 回（マスクがあるときだけ 2 回追加）。JPEG の確定描画（Final 2048、ディテール全部）は CPU 約 0.46〜0.65 秒で 1 秒以内を保つ。以前（2026-10-21 午前、負荷のやや低い状態の 5 回の中央値）の記録は JPEG 2560 で開いたとき detailFinal 750ms・輝度 NR の drag 165ms だった。

上の表は rebase 前（db0f842 基準）の build で測った。detail を v6 にした rebase 後の build（`run` を 3 回、load average 55〜75）でも JPEG の detailFinal 2048 は 2560 で開いたとき 420〜428ms、原寸で開いたとき 570〜623ms、輝度 NR の drag 1280 は 73〜76ms / 98〜125ms だった。

判断: JPEG / PNG はディテールを全部当てても Final 2048 が 1 秒以内なので、drag 中も NR を描く。RAW の確定描画（Final 2048）は、ディテールを使ったときだけ約 1.4〜2.3 秒になる（旧 RAW は既存の約 0.8 秒から約 1.4 秒、signed RAW は既存の時点で約 2 秒で、NR を変えた直後は master を作り直す。開いた直後の初回は最大約 2.9 秒）。owner 判断により RAW でも群を出し、ディテールを 0 以外にした写真だけ確定描画で当てる（drag 中は NR も計算し直さない。上の表）。ディテールを使わない写真の描画は変わらない。

エディタのプレビュー（長辺 1280px）の流れでの実測（同じ合成チャート、`develop-detail-preview.ts` を通して wasm へ送る。3 回の中央値、ms。負荷のある状態）:

| 入力 | 動かす項目 | ディテール | drag 1 コマ | 指を離した後の確定描画 |
| --- | --- | --- | --- | --- |
| signed RAW | コントラスト | なし | 85 | 849 |
| signed RAW | コントラスト | あり（シャープ 70・輝度 40・カラー 25） | 88 | 837 |
| signed RAW | ノイズ軽減 | あり | 40 | 1046（最小 708） |
| 旧 RAW | コントラスト | なし | 65 | 383 |
| 旧 RAW | コントラスト | あり | 64 | 508 |
| 旧 RAW | ノイズ軽減 | あり | 43 | 478 |

以前（drag 中も NR を描き直す）は signed RAW のノイズ軽減の drag が 1 コマ約 670ms だった。

再現: `cargo +1.98.1 build --locked --release --config packages/develop-engine/.cargo/config.toml --manifest-path packages/develop-engine/Cargo.toml --target wasm32-unknown-unknown -p niho-develop-wasm` と `wasm-bindgen --target web` の出力を `--pkg` に渡し、`node scripts/bench-session.mjs run --pkg <dir> --cases <cases.json> --case <id> --scenario detail`。cases.json は作業コピー（`png` / `meta`）か JPEG（`raster` / `workingMaxDimension`）を指す。

## Lightroom への校正（round 32）

PR #76 の最初の式は Lightroom の書き出しと比べて向きと強さが大きくずれていた（ディテールが逆向き、輝度 NR が弱く暗部ほど効かない、カラー NR 25 が強すぎる等）。合成チャートの Lightroom の書き出しの統計に合わせて、各スライダーの写し方を作り直した。処理順・半径の長辺 1500px 基準・crop の halo・量 0 で演算を通らないこと・RAW の確定描画だけで当てる規則・detail v6 の設定の形は変えていない（値の意味＝画への写し方だけを変えた）。

### 方法

1. チャート: `tools/calibrate/make_lr_round32.py` が 1500×1000 の sRGB チャート（段差 3 本 64→192 / 100→156 / 120→136、正弦格子 4 本 周期 4 / 8 / 16 / 32px・振幅 48、seed 32 のノイズ入り平坦部 10 枚〔輝度 σ・色 σ〕）を作り、20 の variant（neutral、Sharpness 40 / 80 / 150、Sharpness 80 × Radius 0.5 / 2.0 / 3.0、× Detail 0 / 75 / 100、× Masking 50 / 90、LuminanceSmoothing 25 / 50 / 75 / 100、ColorNoiseReduction 25 / 50 / 100、combo）の XMP を埋める。長辺 1500px なので NIHO の半径の基準と Lightroom の「原寸の画素」が一致する。
2. Lightroom（Classic ではない方）で JPEG 品質 100・原寸・sRGB・出力シャープなしで書き出す（書き出し画像は公開しない）。
3. 統計: `tools/calibrate/round32_stats.py`（段差の 10-90% 幅・オーバーシュート / アンダーシュート、格子の利得、平坦部の輝度 σ と Cb / Cr σ。8bit の sRGB コード値の Rec.601）。Lightroom の値は `fixtures/color/review-2026-10-21/detail-round32-lightroom.json`。
4. NIHO: `cargo run --release -p niho-develop --example round32_settings -- <manifest.json> niho-10 <dir>` が各 variant の XMP を製品と同じ XMP プリセット変換で設定にし、`niho-develop-render render --raster base-chart.jpg --settings <dir>/<variant>.json --out <variant>.png` で原寸に描く。`round32_stats.py collect` で測り、`round32_stats.py compare` で誤差表・誤差の平均・スライダーごとの向きを出す（`detail-round32-niho.json`・`detail-round32-errors.json`）。
5. 当てはめ: 式を numpy で写して全 variant の統計の二乗誤差（コード値・格子の利得 ×48・幅 ×4〜10）を Nelder-Mead で最小化し、係数を丸めてから Rust の描画で確かめた。係数はシャープ 14・輝度 NR 5・カラー NR 2 で、統計（約 400 個）に対して少数に抑えた（`src/detail.rs` の `calibration`）。

### 写し方

| スライダー | Lightroom の意味 | NIHO の式（線形光） |
| --- | --- | --- |
| シャープ（Amount） | 強さ | 線形光の輝度の USM の利得 `2.9 × (amount/100)^1.2`（ディテール 25・σ 1 のとき）。輝度の変化に合わせて RGB を同じ比で掛ける（色の比は保つ。暗すぎる画素は差を均等に足す） |
| 半径（Radius） | USM の半径 | Gaussian の σ = `0.81 × radius^0.785`。σ が広いほど 1 画素あたりの利得を `σ^-1.22` で弱める（Lightroom の 0.5〜3.0 で細かい格子の利得がほぼ同じ、ノイズの増幅は小さい半径ほど大きい） |
| ディテール（Detail） | ハロー抑制（低いほど抑える） | 利得を `(d^0.785 + 0.074) / (0.25^0.785 + 0.074)` 倍（0 で約 0.18 倍、100 で約 2.6 倍）。ハローは明るい側を線形 0.237、暗い側を `5.9·Y²` と 0.225 の小さい方へ soft-limit（暗い側が黒へ潰れない。Lightroom の 64→192 の暗い側が約 9 で止まるのと同じ向き） |
| マスク（Masking） | エッジの勾配による mask の閾値 | √輝度を σ 1.31 でぼかした勾配の二乗を σ 1.17 でぼかした値 e に対し `e / (e + T²)`、`T = 0.0874 × (masking/100)^2.67`。0 は計算しない |
| ノイズ軽減（LuminanceSmoothing） | 輝度 NR の強さ | √輝度（gamma 2 の領域。明るさで効きが偏らない）に edge-avoiding à-trous（B3 の 5 タップ、間隔 1 / 2 / 4、各段の入力から読む Tukey の範囲重み、段ごとに範囲を 0.77 倍、範囲外にも 0.01 の重み）。範囲 `0.12 × t^0.05`、混ぜる量 `t^0.62`（t = 量/100）。変化分を各チャンネルの √ に足す |
| カラーノイズの軽減（ColorNoiseReduction） | 色 NR | raster（JPEG / PNG・作業コピー）: 各画素の輝度を保ち、σ 0.9（小さい画では 0.5px 未満にしない）の Gaussian でぼかした `RGB / 輝度` の比を使う（`Y × blur(RGB) / blur(Y)`）。25 で効き切り、25〜100 は同じ。signed RAW は R209 のまま |

### 結果

誤差の平均（|NIHO − Lightroom|、全 20 variant）:

| 統計 | 校正前 | 校正後 |
| --- | --- | --- |
| 段差の 10-90% 幅（px） | 0.457 | 0.381 |
| オーバーシュート（コード値） | 8.56 | 1.62 |
| アンダーシュート（コード値） | 14.20 | 0.85 |
| 格子の利得 | 0.122 | 0.034 |
| 平坦部の輝度 σ | 4.93 | 0.88 |
| 平坦部の色 σ | 0.784 | 0.158 |

主な統計（Lightroom / 校正前 / 校正後。全統計は `detail-round32-errors.json`）:

| variant | 64→192 の山 | 120→136 の山 | 120→136 の幅 | 4px 格子 | 32px 格子 | σ6（64） | σ6（128） | σ12 | 色 σ8 | 色 σ12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| neutral | 0.0 / 0.0 / 0.0 | 0.0 / 0.0 / 0.0 | 0.80 / 0.80 / 0.80 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 6.1 / 6.1 / 6.1 | 6.1 / 6.0 / 6.0 | 12.2 / 12.2 / 12.2 | 8.13 / 8.06 / 8.06 | 12.11 / 12.05 / 12.05 |
| sharp_a40 | 25.6 / 8.0 / 21.0 | 5.9 / 1.0 / 5.0 | 0.46 / 0.67 / 0.47 | 1.40 / 1.30 / 1.42 | 1.02 / 1.00 / 1.02 | 10.1 / 7.9 / 10.6 | 10.8 / 7.9 / 11.9 | 21.1 / 16.0 / 23.3 | 8.13 / 8.05 / 8.08 | 12.57 / 11.53 / 12.59 |
| sharp_a80 | 33.5 / 15.0 / 32.0 | 13.5 / 3.0 / 10.0 | 0.29 / 0.56 / 0.33 | 1.52 / 1.73 / 1.55 | 1.03 / 1.02 / 1.04 | 15.3 / 9.9 / 14.3 | 18.0 / 9.7 / 18.7 | 30.6 / 20.0 / 32.5 | 8.16 / 8.04 / 8.09 | 13.31 / 11.18 / 13.27 |
| sharp_a150 | 33.9 / 27.0 / 34.0 | 24.9 / 5.0 / 20.0 | 2.52 / 0.46 / 0.21 | 1.58 / 2.15 / 1.58 | 1.07 / 1.02 / 1.08 | 22.5 / 13.8 / 19.9 | 26.8 / 13.0 / 28.0 | 38.8 / 28.3 / 41.1 | 8.19 / 8.03 / 8.10 | 14.26 / 10.83 / 14.39 |
| sharp_a80_r05 | 28.0 / 5.0 / 27.0 | 10.0 / 1.0 / 7.0 | 1.84 / 0.71 / 0.40 | 1.48 / 1.15 / 1.48 | 1.02 / 1.00 / 1.02 | 14.5 / 7.5 / 13.3 | 16.9 / 7.5 / 16.8 | 29.1 / 15.1 / 30.1 | 8.15 / 8.06 / 8.09 | 13.16 / 11.63 / 13.05 |
| sharp_a80_r20 | 30.9 / 23.0 / 28.0 | 11.0 / 5.0 / 8.0 | 0.33 / 0.47 / 0.39 | 1.50 / 2.10 / 1.52 | 1.06 / 1.05 / 1.06 | 12.3 / 11.5 / 11.9 | 13.7 / 11.1 / 14.2 | 25.5 / 23.4 / 26.8 | 8.14 / 8.03 / 8.08 | 12.86 / 10.95 / 12.82 |
| sharp_a80_r30 | 25.5 / 26.0 / 24.0 | 7.5 / 5.0 / 6.0 | 0.41 / 0.46 / 0.44 | 1.39 / 2.12 / 1.47 | 1.08 / 1.11 / 1.07 | 9.3 / 11.8 / 10.6 | 9.9 / 11.4 / 11.9 | 19.3 / 24.0 / 23.2 | 8.13 / 8.03 / 8.07 | 12.46 / 10.91 / 12.60 |
| sharp_a80_d0 | 16.2 / 18.0 / 10.0 | 2.9 / 4.0 / 2.0 | 0.58 / 0.53 / 0.64 | 1.29 / 2.04 / 1.27 | 1.01 / 1.02 / 1.00 | 8.4 / 10.5 / 8.3 | 8.7 / 10.3 / 8.5 | 17.2 / 21.3 / 17.1 | 8.13 / 8.04 / 8.07 | 12.35 / 11.09 / 12.27 |
| sharp_a80_d75 | 33.7 / 9.0 / 34.0 | 23.8 / 2.0 / 20.0 | 2.48 / 0.64 / 0.21 | 1.58 / 1.34 / 1.58 | 1.05 / 1.00 / 1.08 | 22.7 / 8.7 / 19.9 | 30.7 / 8.6 / 28.0 | 44.0 / 17.6 / 41.1 | 8.19 / 8.05 / 8.10 | 14.74 / 11.38 / 14.38 |
| sharp_a80_d100 | 33.9 / 7.0 / 34.0 | 27.5 / 1.0 / 24.0 | 2.76 / 0.67 / 0.18 | 1.60 / 1.21 / 1.58 | 1.05 / 1.00 / 1.10 | 24.8 / 8.2 / 21.9 | 35.3 / 8.1 / 30.8 | 47.8 / 16.4 / 43.1 | 8.22 / 8.05 / 8.11 | 15.29 / 11.49 / 14.76 |
| sharp_a80_m50 | 32.6 / 13.0 / 32.0 | 8.5 / 1.0 / 5.0 | 0.38 / 0.67 / 0.46 | 1.38 / 1.00 / 1.47 | 1.01 / 1.00 / 1.00 | 6.8 / 6.8 / 6.7 | 7.5 / 7.4 / 6.8 | 19.3 / 16.3 / 17.6 | 8.13 / 8.06 / 8.06 | 12.20 / 11.67 / 12.12 |
| sharp_a80_m90 | 29.0 / 12.0 / 29.0 | 1.0 / 1.0 / 0.0 | 0.71 / 0.71 / 0.75 | 1.06 / 1.00 / 1.09 | 1.00 / 1.00 / 1.00 | 6.1 / 6.5 / 6.1 | 6.1 / 7.0 / 6.0 | 12.6 / 15.2 / 12.4 | 8.13 / 8.06 / 8.06 | 12.11 / 11.78 / 12.05 |
| lnr_25 | 0.0 / 0.0 / 0.0 | 0.0 / 0.0 / 0.0 | 2.97 / 0.80 / 1.80 | 0.94 / 1.00 / 0.98 | 0.98 / 1.00 / 0.94 | 3.2 / 6.1 / 3.5 | 3.2 / 6.0 / 3.5 | 7.7 / 12.2 / 8.3 | 8.14 / 8.06 / 8.07 | 12.38 / 12.05 / 12.13 |
| lnr_50 | 0.0 / 0.0 / 0.0 | 0.0 / 0.0 / 0.0 | 4.07 / 0.85 / 3.80 | 0.92 / 1.00 / 0.98 | 0.96 / 0.99 / 0.91 | 2.2 / 6.1 / 2.2 | 2.2 / 5.6 / 2.2 | 6.2 / 12.1 / 6.1 | 8.14 / 8.06 / 8.07 | 12.49 / 11.96 / 12.17 |
| lnr_75 | 0.0 / 0.0 / 0.0 | 0.0 / 0.0 / 0.0 | 4.91 / 0.91 / 6.80 | 0.90 / 1.00 / 0.97 | 0.95 / 0.99 / 0.89 | 1.3 / 5.6 / 1.1 | 1.3 / 4.8 / 1.1 | 4.8 / 11.4 / 4.6 | 8.14 / 8.06 / 8.07 | 12.60 / 11.90 / 12.20 |
| lnr_100 | 0.0 / 0.0 / 0.0 | 0.0 / 0.0 / 0.0 | 5.94 / 5.80 / 7.80 | 0.89 / 0.98 / 0.96 | 0.94 / 0.97 / 0.88 | 0.2 / 5.1 / 0.4 | 0.2 / 3.7 / 0.4 | 3.6 / 10.6 / 3.7 | 8.15 / 8.05 / 8.07 | 12.69 / 11.78 / 12.24 |
| cnr_25 | 0.0 / 0.0 / 0.0 | 0.0 / 0.0 / 0.0 | 0.80 / 0.80 / 0.80 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 6.1 / 6.1 / 6.1 | 6.1 / 6.0 / 6.0 | 12.2 / 12.2 / 12.2 | 2.52 / 1.10 / 2.55 | 3.95 / 4.47 / 3.97 |
| cnr_50 | 0.0 / 0.0 / 0.0 | 0.0 / 0.0 / 0.0 | 0.80 / 0.80 / 0.80 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 6.1 / 6.1 / 6.1 | 6.1 / 6.0 / 6.0 | 12.2 / 12.2 / 12.2 | 2.51 / 0.38 / 2.55 | 3.90 / 0.85 / 3.97 |
| cnr_100 | 0.0 / 0.0 / 0.0 | 0.0 / 0.0 / 0.0 | 0.80 / 0.80 / 0.80 | 1.00 / 1.00 / 1.00 | 1.00 / 1.00 / 1.00 | 6.1 / 6.1 / 6.1 | 6.1 / 6.0 / 6.0 | 12.2 / 12.2 / 12.2 | 2.51 / 0.37 / 2.55 | 3.90 / 1.67 / 3.97 |
| combo | 30.6 / 15.0 / 31.0 | 2.3 / 2.0 / 4.0 | 0.65 / 0.61 / 0.51 | 1.46 / 1.71 / 1.54 | 0.99 / 1.00 / 0.94 | 6.4 / 9.7 / 6.4 | 6.9 / 9.0 / 6.9 | 17.5 / 19.6 / 17.0 | 2.52 / 1.09 / 2.55 | 4.08 / 3.53 / 4.40 |

向き・単調性（`round32_stats.py compare` の `monotonicity`。スライダーの系列ごとに、Lightroom が動く統計は同じ向きへ動き、逆向きの段が無いこと）は、下の「残る差」の 1・2 を除いてすべて一致する。

### 残る差

1. 強いシャープの段差の 10-90% 幅: Lightroom のシャープは 2 画素目に逆向きのリンギングがあり（例: 100→156 の Sharpness 150 で暗い側の 2 画素目が +14）、それが 10% の高さを越えると幅の統計が 2.4〜2.8px に跳ぶ（Sharpness 150、Detail 75 / 100、Radius 0.5）。NIHO の Gaussian の USM はリンギングを作らないので幅は単調に狭くなる。見た目の鋭さの向きは同じ。
2. 64→192 の暗い側のハロー: NIHO は約 10 で一定、Lightroom は半径・ディテール・マスクで 8〜12 の間を動く。
3. 量: Detail 75 / 100 のノイズの増幅はやや少ない（128 の σ6 で 28.0 / 30.8、Lightroom 30.7 / 35.3）。Radius 3.0 のノイズはやや多い（11.9、Lightroom 9.9）。120→136 の段差の山は Sharpness 150 で 20（Lightroom 24.9）。色だけのノイズの灰の平坦部に出る輝度 σ は Sharpness 150 で 9.1（Lightroom 12.8）。
4. 輝度 NR: 4px の格子は Lightroom より残り（100 で 0.96、Lightroom 0.89）、8〜32px の格子は Lightroom より下がる（100 で 0.83〜0.88、Lightroom 0.94〜0.95）。120→136 の段差の幅は 1.8 / 3.8 / 6.8 / 7.8px（Lightroom 2.97 / 4.07 / 4.91 / 5.94px）。NIHO の書き出しはディザを入れないので、ノイズの無い段差では幅が整数の段で動く。192 の灰の σ6 は 100 で 0.5（Lightroom 1.5）。
5. カラー NR: Lightroom の 25 / 50 / 100 は画素単位の色ノイズで同じ残差なので 25〜100 を同じにした。Lightroom が大きい値で消す大きな色の斑は、このチャートでは測っていない。signed RAW のカラー NR（R209 とその 50〜100 の延長）はこのチャートで校正していない。

### テスト

`tests/detail_round32.rs` が同じ配置のチャートを seed 固定の別のノイズで描き、各 variant の Camera Raw の値を製品の XMP 変換で設定にして原寸の Final を描き、全統計が Lightroom の値から許容幅（幅 2.5px、山 8、格子の利得 0.15、輝度 σ 1.5 + 20%、色 σ 1.0。残る差の 1・2 は除く）に入ること、スライダーの系列ごとの向き・単調性が一致することを確かめる（Lightroom の値は fixture の JSON から読む）。

`examples/detail_chart.rs`（2048×1366 の段差とノイズ。`tests/detail_effect.rs` と同じ統計）はチャートの別の確かめ用に残す。

## 版 `v` の定義箇所

Issue #31 のマスクが v5 を先に使うため、Issue #32 の detail は v6 を使う。次の実装・fixtureでもこの対応を保つ。

- Rust `crates/niho-develop/src/settings.rs`: `DETAIL_SETTINGS_VERSION`（6）、`MAX_SETTINGS_VERSION`、`from_value` の `v` の読み（`n == 6.0`）と `unsupportedVersion` の文言、`required_version`、`validate` の `versionTooLow` の文言、同ファイルの test（v5 は引き続き有効、v6 は detail、v7 は未来版）。
- Rust の test: `tests/detail_cross_target.rs`（`settings.v = 6`）、`tests/niho3.rs`・`tests/xmp_detail.rs`（`v == 6`）、`crates/niho-develop-render/tests/cli.rs`（`MAX_SETTINGS_VERSION + 1` を未来の版として使う）。
- TypeScript `packages/photo-editing/src/develop-engine/develop-settings.ts`: `DevelopSettingsVersion`、`isDevelopSettingsVersion`、`developSettingsVersion`、`readDevelopSettings` の `value.v < 6`。
- TypeScript `develop-engine-worker-core.ts`: `DETAIL_PROBE_SETTINGS_JSON` の `v: 6`。test は `develop-settings.test.ts`・`develop-open-settings.test.ts`・`photo-editing-color-mixer.test.tsx`（未知の版 7）・`photo-editing-detail.test.ts`・`develop-engine-worker-core.test.ts`。
- `packages/develop-engine/scripts/bench-session.mjs` の `detail` scenario（`v: Math.max(6, …)`）。
