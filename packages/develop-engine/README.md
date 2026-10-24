# NIHO RAW現像エンジン

NIHO所有コード・モデル・校正値の公開SSOT。ソースと資産にはルートのproprietary条件を適用し、第三者の許諾は [LICENSES.md](LICENSES.md) と [第三者告知](../../THIRD_PARTY_NOTICES.md) に従う。

Rust workspaceはRAW decode、色計算、DCP入出力、現像、WASM境界と診断CLIの8 crateを含む。decoder `rawler = =0.8.0` はLGPL-2.1の段1専用で、段2とそのWASMはdecoderに依存しない。各crateは `publish = false` / `UNLICENSED`。

JPEG / PNG・raster 作業コピー・旧（unsigned）RAW 作業コピーの新規編集の既定は [niho-14](NIHO14.md)（#89。raster の相対 WB を処理の先頭で当てる [niho-13](NIHO13.md) の H/S 応答の解析を軽くした engine）。保存済みの engine はそのまま描く。評価中の公開候補は [niho-8 float cube](NIHO8.md) と [Issue #26/#27 research paths](RESEARCH26-27.md) に分離している。いずれも product default ではなく、外部 gate 未完了の品質主張をしない。

```sh
cargo +1.98.1 test --locked --manifest-path packages/develop-engine/Cargo.toml
cargo +1.98.1 build --locked --config packages/develop-engine/.cargo/config.toml --manifest-path packages/develop-engine/Cargo.toml --target wasm32-unknown-unknown -p niho-develop-wasm
python3 packages/develop-engine/tools/independent-profile/check.py
```

実RW2は `fixtures/public-raw/dc-s5-owner.rw2`。オーナー撮影の無人の教室・ストーブの写真を目視確認し、顔・人体の自動検出だけで採否を決めていない。RAWの圧縮画素、sensor寸法、crop、WB、black/whiteと原寸camera RGBを元の写真と照合した。GPS・serial・氏名・EXIF・MakerNotes・camera IFD・thumbnail・ICCを含めず、decodeに必要なタグと圧縮stripだけから再構築している。監査記録と512pxの元画素goldenを同梱し、Rustテストは環境変数なしで必ず走る。

独立DCPは所有RAWと所有カメラJPEGの色の測定対から、外部カメラ行列を初期値に使わず解析的に推定した。写真単位で先に5学習/2検証へ分離し、検証2写真の輝度を揃えた色差は平均ΔE76 4.14/4.19、p95 13.34/13.61。これは色だけの参考評価で、トーン一致、絶対WB、チャート測色精度、他機種の品質を実証するものではない。公開RAW fixtureは学習側の写真であり、検証写真の画素画像は同梱しない。

`fixtures/independent-profile/` の匿名化した色の測定対からPython標準ライブラリだけでspecと検証結果を再生成する。RustではspecからDCP bytesを再生成し、公開DCPと完全一致させる。既存DCP8件、LibRaw表とその生成初期値、旧spec、外部ICC、第三者ColorChecker値は含めない。

校正の補助toolは `tools/calibrate/` と `tools/colorcheck/`、新DCP生成は `tools/independent-profile/`、RAW監査は `tools/asset-audit/`。元の写真やLightroom・Appleの参照出力を再計測する場合は、所有データの配置を引数・環境変数で指定する。非公開の配置や秘密情報は公開ソースに埋め込まない。第三者チャートの既定参照ファイルは同梱せず、測定者が監査した参照値を明示入力する。

## 忠実度

- 階調（#29、`niho-12`）: 入力 8bit 量子化の無い linear f32 の 1024 段ランプ（空・肌の 2 色の線形補間、中庸と 3 プリセットの 4 設定）で、出力 8bit の隣接差 2 以上は Final で raster 2 → 0（`niho-10` → `niho-12`）、旧 RAW 12 → 5（`niho-2` → `niho-12`）、Interactive で raster 0 → 0、旧 RAW 7 → 5。`niho-12` に残る 5 件（channel 単位）はすべてランプの暗端 11 画素以内で、4096 段ではどの engine も 0 件。[公開測定](fixtures/color/review-2026-10-21/niho12-public-measurement.json)は `crates/niho-develop/examples/niho12_measure.rs` で再現する。
- Lightroom の開発用教師 57 場面（独立評価ではない）では、preset ごとの平均 mean・p99 平均が `niho-10` から悪化せず、組ごとの mean 増加は最大 0.29（0.5 未満）、p99 > 8 は 23 → 22 件（[NIHO12.md](NIHO12.md)）。教師は相対 WB を持たないので `niho-13` も同じ byte 列。
- H/S 応答の解析（#89、`niho-14`）: 開発用教師 57 場面 × 中立・プリセット 3 本の Lightroom との差は `niho-13` と variant の平均で mean ±0.00001・p99 −0.0002〜+0.00005、p99 > 8 は 23 → 23 件。WB 5 通りの 855 組の `niho-13` との差は mean 最大 0.0007・p99 最大 0.0098。wasm（1280×960）で H/S を使う設定の WB を離した後の確定は 1189ms → 551ms（画素を変えない高速化だけの `niho-13` は 988ms）、写真を開いた直後の初回は 1067ms → 352ms（[NIHO14.md](NIHO14.md)、[公開測定](fixtures/color/review-2026-10-22/round89-wasm-performance.json)）。
- JPEG の相対 WB（#27、`niho-13`）: 合成 17³ 色見本の Lightroom 書き出しとの CIEDE2000 で、WB 単独 4 組の mean の平均は 0.49 → 0.15（`niho-12` の出力側 → `niho-13` の先頭）、WB + 編集 28 組は 2.55 → 1.83、プリセット + WB 12 組は 4.05 → 2.96。p99 は 44 組中 35 組で改善し、悪化した 9 組は端の飽和色（純青・純緑付近）に集まる（温度 −30 + bluesky2 18.5 → 20.8 が最大。[NIHO13.md](NIHO13.md)、[公開測定](fixtures/color/review-2026-10-21/round27-niho-13.json)）。線形光の 3×3 はどの条件も単独 WB の合格線（mean ≤ 0.5）に届かない（[当てはめ](fixtures/color/review-2026-10-21/round27-linear-3x3.json)）。

[decoder capability](../../docs/migration/decoder-capabilities.md)、[移植と検証の記録](../../docs/migration/raw-engine.md)、[モデル9件の由来](../../docs/legal/model-provenance.json)も参照する。Apple RAWと背景除去のSwift toolのソースは含むが、このRust workspaceの公開CIはSwiftやOS機能の動作を証明しない。署名・公証・アプリ配布は #2 の範囲。
