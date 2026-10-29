# 現像エンジンのライセンスと第三者境界

NIHOコードと所有写真・測定値にはルートLICENSE.md / ASSET_LICENSE.mdを適用する。第三者コードには元の条件が優先する。

## rawlerのLGPL例外

RAW decoderの `rawler = =0.8.0` はLGPL-2.1。`niho-base-raw` とそれを利用する診断CLIに限定し、`niho-develop` / `niho-develop-wasm` は依存しない。所有DCPの入力と汎用色計算も独立crateに分離している。

LGPLが認める変更、再ビルド、再リンク、改変ライブラリ利用、デバッグのためのreverse engineeringをNIHOのproprietary条件で制限しない。公開ソースから `cargo build --locked -p niho-base-raw` でhelperを再ビルドできる。rawler本体とカメラ・レンズ定義を含む対応ソースはCargo.lockのregistry/checksumで固定する。端末向けバイナリを配る場合は、実際の対応ソース・ライセンス全文・告知・再リンク手順を配布物に添える（配布経路は #2）。このPRではビルド成果物を配布しない。

## Adobe DNG SDK

`niho-develop/src/acr3.rs`と`tools/colorcheck/colorcheck/data/acr3_default_tone_curve.json`の1025点表、`src/color.rs`の温度表・tint尺度・色空間行列はDNG SDK由来。これらをNIHO独自の測定値とは扱わない。Copyright 2006-2023 Adobe Systems Incorporated / All Rights Reserved の告知と、[DNG SDK License Agreement全文](licenses/Adobe-DNG-SDK-LICENSE.txt)を同梱する。

原本zip SHA-256: `740fbe95c69e09e9cd17654a5e4fef2d7021254b06fd2b8c5557b79a1496b50c`。全文SHA-256: `89d75e1bfd65269c41ec57be67adacd48926af81554574d92742f96296ed9166`。zip内`dng_sdk_1_7_1/LICENSE.txt`と展開済み全文の一致を確認した。Softwareには第1条の許諾、第2条の告知保持等の元の条件が適用され、ルートの再利用禁止はそれを制限しない。商用配布等は同梱全文の条件に従う。

LibRawの行列表、旧DCP8件、旧spec4件、rawtoaces-data、外部ICC、ColorChecker基準値のファイルは含めない。テスト内の旧行列も独立合成値へ変更した。新DCPの由来と限定した精度評価は `fixtures/independent-profile/` に記録する。

## 依存 crate（Cargo.lock 全体。build 時にだけ使う proc-macro を含む）

| crate | 版 | ライセンス（SPDX） | 採る条件 | 用途 |
|---|---|---|---|---|
| addr2line | 0.25.1 | Apache-2.0 OR MIT | MIT | niho-base-raw: 依存の依存 |
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 | MIT | 依存の依存 |
| adler32 | 1.2.0 | Zlib | Zlib | niho-base-raw: 依存の依存 |
| alloc-no-stdlib | 2.0.4 | BSD-3-Clause | BSD-3-Clause | niho-base-raw: 依存の依存 |
| alloc-stdlib | 0.2.4 | BSD-3-Clause | BSD-3-Clause | niho-base-raw: 依存の依存 |
| allocator-api2 | 0.2.21 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| android_system_properties | 0.1.6 | MIT OR Apache-2.0 | MIT | niho-base-raw: macOS・Linux では build されない（Windows・Android などの依存） |
| anstream | 1.0.0 | MIT OR Apache-2.0 | MIT | niho-base-raw: CLI の出力 |
| anstyle | 1.0.14 | MIT OR Apache-2.0 | MIT | niho-base-raw: CLI の出力 |
| anstyle-parse | 1.0.0 | MIT OR Apache-2.0 | MIT | niho-base-raw: CLI の出力 |
| anstyle-query | 1.1.5 | MIT OR Apache-2.0 | MIT | niho-base-raw: CLI の出力 |
| anstyle-wincon | 3.0.11 | MIT OR Apache-2.0 | MIT | niho-base-raw: macOS・Linux では build されない（Windows・Android などの依存） |
| anyhow | 1.0.104 | MIT OR Apache-2.0 | MIT | niho-camera-color / niho-camera-profile / niho-base-raw: エラーの伝播・表示 |
| autocfg | 1.5.1 | Apache-2.0 OR MIT | MIT | build 時のみ（proc-macro など） |
| backtrace | 0.3.76 | MIT OR Apache-2.0 | MIT | niho-base-raw: rawler の依存（backtrace） |
| bitflags | 2.13.2 | MIT OR Apache-2.0 | MIT | 依存の依存 |
| bitstream-io | 4.10.0 | MIT/Apache-2.0 | MIT | niho-base-raw: rawler の依存（ビット列の読み取り） |
| block-buffer | 0.10.4 | MIT OR Apache-2.0 | MIT | niho-camera-profile: SHA-256 の土台 |
| brotli-decompressor | 5.0.3 | BSD-3-Clause/MIT | MIT | niho-base-raw: 依存の依存 |
| bumpalo | 3.20.3 | MIT OR Apache-2.0 | MIT | 依存の依存 |
| bytemuck | 1.25.2 | Zlib OR Apache-2.0 OR MIT | MIT | 依存の依存 |
| byteorder | 1.5.0 | Unlicense OR MIT | MIT | niho-base-raw: rawler の依存（バイト順） |
| byteorder-lite | 0.1.0 | Unlicense OR MIT | MIT | 依存の依存 |
| cc | 1.5.1 | MIT OR Apache-2.0 | MIT | niho-base-raw: macOS・Linux では build されない（Windows・Android などの依存） |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 | MIT | 依存の依存 |
| chrono | 0.4.45 | MIT OR Apache-2.0 | MIT | niho-base-raw: rawler の依存（日時） |
| clap | 4.6.7 | MIT OR Apache-2.0 | MIT | niho-base-raw: CLI の引数解析 |
| clap_builder | 4.6.7 | MIT OR Apache-2.0 | MIT | niho-base-raw: CLI の引数解析 |
| clap_derive | 4.6.7 | MIT OR Apache-2.0 | MIT | niho-base-raw: build 時のみ（proc-macro など） |
| clap_lex | 1.1.1 | MIT OR Apache-2.0 | MIT | niho-base-raw: CLI の引数解析 |
| colorchoice | 1.0.5 | MIT OR Apache-2.0 | MIT | niho-base-raw: CLI の出力 |
| core-foundation-sys | 0.8.7 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| cpufeatures | 0.2.17 | MIT OR Apache-2.0 | MIT | niho-camera-profile: SHA-256 の土台（CPU 機能の判定） |
| crc32fast | 1.5.2 | MIT OR Apache-2.0 | MIT | PNG の CRC |
| crossbeam-deque | 0.8.8 | MIT OR Apache-2.0 | MIT | niho-base-raw・niho-develop（`threads`）: rayon の依存 |
| crossbeam-epoch | 0.9.21 | MIT OR Apache-2.0 | MIT | niho-base-raw・niho-develop（`threads`）: rayon の依存 |
| crossbeam-utils | 0.8.23 | MIT OR Apache-2.0 | MIT | niho-base-raw・niho-develop（`threads`）: rayon の依存 |
| crypto-common | 0.1.7 | MIT OR Apache-2.0 | MIT | niho-camera-profile: SHA-256 の土台 |
| dary_heap | 0.3.9 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| digest | 0.10.7 | MIT OR Apache-2.0 | MIT | niho-camera-profile: SHA-256 の土台 |
| either | 1.18.0 | MIT OR Apache-2.0 | MIT | niho-base-raw・niho-develop（`threads`）: rayon の依存 |
| enumn | 0.1.14 | MIT OR Apache-2.0 | MIT | niho-base-raw: build 時のみ（proc-macro など） |
| equivalent | 1.0.2 | Apache-2.0 OR MIT | MIT | niho-base-raw: 依存の依存 |
| fdeflate | 0.3.7 | MIT OR Apache-2.0 | MIT | PNG の圧縮 |
| find-msvc-tools | 0.1.14 | MIT OR Apache-2.0 | MIT | niho-base-raw: macOS・Linux では build されない（Windows・Android などの依存） |
| flate2 | 1.1.10 | MIT OR Apache-2.0 | MIT | PNG の圧縮（`image` の依存）、`niho-camera-linear-probe` の native-only 原寸測定実験（local-only、本番の `niho-develop` 経路には未接続） |
| foldhash | 0.2.0 | Zlib | Zlib | niho-base-raw: 依存の依存 |
| futures-core | 0.3.34 | MIT OR Apache-2.0 | MIT | 依存の依存 |
| futures-task | 0.3.34 | MIT OR Apache-2.0 | MIT | 依存の依存 |
| futures-util | 0.3.34 | MIT OR Apache-2.0 | MIT | 依存の依存 |
| generic-array | 0.14.7 | MIT | MIT | niho-camera-profile: SHA-256 の土台 |
| getrandom | 0.4.3 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| gimli | 0.32.3 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| glob | 0.3.4 | MIT OR Apache-2.0 | MIT | niho-base-raw: build 時のみ（proc-macro など） |
| hashbrown | 0.16.1 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| heck | 0.5.0 | MIT OR Apache-2.0 | MIT | niho-base-raw: build 時のみ（proc-macro など） |
| hex | 0.4.3 | MIT OR Apache-2.0 | MIT | niho-base-raw: rawler の依存 |
| iana-time-zone | 0.1.65 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| iana-time-zone-haiku | 0.1.2 | MIT OR Apache-2.0 | MIT | niho-base-raw: macOS・Linux では build されない（Windows・Android などの依存） |
| image | 0.25.10 | MIT OR Apache-2.0 | MIT | JPEG / PNG のデコード・エンコード |
| indexmap | 2.14.2 | Apache-2.0 OR MIT | MIT | niho-base-raw: 依存の依存 |
| is_terminal_polyfill | 1.70.2 | MIT OR Apache-2.0 | MIT | niho-base-raw: CLI の出力 |
| itertools | 0.14.0 | MIT OR Apache-2.0 | MIT | niho-base-raw: rawler の依存 |
| itoa | 1.0.18 | MIT OR Apache-2.0 | MIT | 依存の依存 |
| jpeg-decoder | 0.3.2 | MIT OR Apache-2.0 | MIT | 描く大きさの 4 倍以上の JPEG の縮小 IDCT（`platform_independent`、rayon なし） |
| js-sys | 0.3.106 | MIT OR Apache-2.0 | MIT | wasm の bindings |
| jxl-bitstream | 1.1.0 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| jxl-coding | 1.0.1 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| jxl-color | 0.11.0 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| jxl-frame | 0.13.3 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| jxl-grid | 0.6.2 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| jxl-image | 0.13.0 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| jxl-jbr | 0.2.1 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| jxl-modular | 0.11.3 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| jxl-oxide | 0.12.6 | MIT OR Apache-2.0 | MIT | niho-base-raw: rawler の依存（JPEG XL 圧縮の DNG） |
| jxl-oxide-common | 1.0.0 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| jxl-render | 0.12.4 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| jxl-threadpool | 1.0.0 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| jxl-vardct | 0.11.1 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| lazy_static | 1.5.0 | MIT OR Apache-2.0 | MIT | niho-base-raw: rawler の依存 |
| libc | 0.2.189 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| libflate | 2.3.2 | MIT | MIT | niho-base-raw: rawler の依存（deflate 圧縮の DNG） |
| libflate_lz77 | 2.3.0 | MIT | MIT | niho-base-raw: 依存の依存 |
| libm | 0.2.16 | MIT | MIT | 超越関数（native と wasm で同じ実装） |
| log | 0.4.34 | MIT OR Apache-2.0 | MIT | niho-base-raw: rawler の依存（ログ） |
| md5 | 0.8.1 | Apache-2.0 OR MIT | MIT | niho-base-raw: rawler の依存（digest） |
| memchr | 2.8.3 | Unlicense OR MIT | MIT | 依存の依存 |
| memmap2 | 0.9.11 | MIT OR Apache-2.0 | MIT | niho-base-raw: rawler の依存（ファイルの mmap） |
| miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 | MIT | deflate |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 | MIT | deflate |
| moxcms | 0.8.1 | BSD-3-Clause OR Apache-2.0 | BSD-3-Clause | ICC プロファイルの読み取り（matrix/TRC・LUT の表。LUT の評価は crate の `icc_lut.rs`） |
| multiversion | 0.8.0 | MIT OR Apache-2.0 | MIT | niho-base-raw: rawler の依存（CPU 機能別の関数） |
| multiversion-macros | 0.8.0 | MIT OR Apache-2.0 | MIT | niho-base-raw: build 時のみ（proc-macro など） |
| no_std_io2 | 0.9.4 | Apache-2.0 OR MIT | MIT | niho-base-raw: 依存の依存 |
| num | 0.4.3 | MIT OR Apache-2.0 | MIT | niho-base-raw: rawler の依存（数値型） |
| num-bigint | 0.4.8 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| num-complex | 0.4.6 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| num-integer | 0.1.47 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| num-iter | 0.1.46 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| num-rational | 0.4.2 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| num-traits | 0.2.19 | MIT OR Apache-2.0 | MIT | 依存の依存 |
| num_enum | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 | MIT | niho-base-raw: rawler の依存 |
| num_enum_derive | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 | MIT | niho-base-raw: build 時のみ（proc-macro など） |
| object | 0.37.3 | Apache-2.0 OR MIT | MIT | niho-base-raw: 依存の依存 |
| once_cell | 1.21.4 | MIT OR Apache-2.0 | MIT | 依存の依存 |
| once_cell_polyfill | 1.70.2 | MIT OR Apache-2.0 | MIT | niho-base-raw: macOS・Linux では build されない（Windows・Android などの依存） |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT | MIT | 依存の依存 |
| png | 0.18.1 | MIT OR Apache-2.0 | MIT | PNG（image 経由。niho-base-raw は作業コピーの 16bit PNG、niho-develop は部分補正のマスクの面の 8bit グレー PNG に直接使う） |
| proc-macro-crate | 3.5.0 | MIT OR Apache-2.0 | MIT | niho-base-raw: build 時のみ（proc-macro など） |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 | MIT | 依存の依存 |
| pxfm | 0.1.30 | BSD-3-Clause OR Apache-2.0 | BSD-3-Clause | moxcms の数学関数 |
| quick-xml | 0.36.2 | MIT | MIT | XMP の XML 解析 |
| quote | 1.0.47 | MIT OR Apache-2.0 | MIT | 依存の依存 |
| r-efi | 6.0.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later | MIT | niho-base-raw: macOS・Linux では build されない（Windows・Android などの依存） |
| rawler | 0.8.0 | LGPL-2.1 | LGPL-2.1（例外） | niho-base-raw: RAW のデコード（現行本番はワーカー、R4で端末向けを準備。下の「niho-base-raw の例外」） |
| rayon | 1.12.0 | MIT OR Apache-2.0 | MIT | niho-base-raw・niho-develop（`threads` feature、#148）: 行単位の並列化 |
| rayon-core | 1.13.0 | MIT OR Apache-2.0 | MIT | niho-base-raw・niho-develop（`threads` feature、#148）: 行単位の並列化 |
| rle-decode-fast | 1.0.3 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| rustc-demangle | 0.1.28 | MIT/Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| rustc_version | 0.4.1 | MIT OR Apache-2.0 | MIT | niho-base-raw: build 時のみ（proc-macro など） |
| rustversion | 1.0.23 | MIT OR Apache-2.0 | MIT | build 時のみ（proc-macro など） |
| semver | 1.0.28 | MIT OR Apache-2.0 | MIT | niho-base-raw: build 時のみ（proc-macro など） |
| serde | 1.0.229 | MIT OR Apache-2.0 | MIT | niho-camera-profile の DCP spec、niho-base-raw のサイドカーの derive |
| serde_core | 1.0.229 | MIT OR Apache-2.0 | MIT | 依存の依存 |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 | MIT | build 時のみ（proc-macro など） |
| serde_json | 1.0.151 | MIT OR Apache-2.0 | MIT | developSettings、niho-camera-profile の DCP spec、niho-base-raw のサイドカーの JSON |
| serde_spanned | 0.6.9 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| sha2 | 0.10.9 | MIT OR Apache-2.0 | MIT | niho-camera-profile: 元の DCP バイト列の SHA-256（baseVersion）。niho-develop: 部分補正のマスクの面の PNG の SHA-256（面の id） |
| shlex | 2.0.1 | MIT OR Apache-2.0 | MIT | niho-base-raw: macOS・Linux では build されない（Windows・Android などの依存） |
| simd-adler32 | 0.3.10 | MIT | MIT | deflate |
| slab | 0.4.12 | MIT | MIT | 依存の依存 |
| strsim | 0.11.1 | MIT | MIT | niho-base-raw: CLI の引数解析（候補の提示） |
| syn | 2.0.119 | MIT OR Apache-2.0 | MIT | niho-base-raw: build 時のみ（proc-macro など） |
| syn | 3.0.6 | MIT OR Apache-2.0 | MIT | 依存の依存 |
| target-features | 0.1.6 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| thiserror | 2.0.21 | MIT OR Apache-2.0 | MIT | niho-base-raw: rawler の依存（エラー型） |
| thiserror-impl | 2.0.21 | MIT OR Apache-2.0 | MIT | niho-base-raw: build 時のみ（proc-macro など） |
| toml | 0.8.23 | MIT OR Apache-2.0 | MIT | niho-base-raw: rawler の依存（同梱のカメラ定義 cameras.toml の読み取り） |
| toml_datetime | 0.6.11 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| toml_datetime | 1.1.1+spec-1.1.0 | MIT OR Apache-2.0 | MIT | niho-base-raw: build 時のみ（proc-macro など） |
| toml_edit | 0.22.27 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| toml_edit | 0.25.15+spec-1.1.0 | MIT OR Apache-2.0 | MIT | niho-base-raw: build 時のみ（proc-macro など） |
| toml_parser | 1.1.3+spec-1.1.0 | MIT OR Apache-2.0 | MIT | niho-base-raw: build 時のみ（proc-macro など） |
| toml_write | 0.1.2 | MIT OR Apache-2.0 | MIT | niho-base-raw: 依存の依存 |
| tracing | 0.1.44 | MIT | MIT | niho-base-raw: 依存の依存 |
| tracing-core | 0.1.36 | MIT | MIT | niho-base-raw: 依存の依存 |
| typenum | 1.20.1 | MIT OR Apache-2.0 | MIT | niho-camera-profile: SHA-256 の土台 |
| unicode-ident | 1.0.26 | (MIT OR Apache-2.0) AND Unicode-3.0 | (MIT OR Apache-2.0) AND Unicode-3.0 | 依存の依存 |
| utf8parse | 0.2.2 | Apache-2.0 OR MIT | MIT | niho-base-raw: CLI の出力 |
| uuid | 1.26.1 | Apache-2.0 OR MIT | MIT | niho-base-raw: rawler の依存。wasm32 では rawler の UUID v4 に必要な JS 乱数 bridge を有効化 |
| version_check | 0.9.5 | MIT/Apache-2.0 | MIT | niho-base-raw: build 時のみ（proc-macro など） |
| wasm-bindgen | 0.2.129 | MIT OR Apache-2.0 | MIT | wasm の bindings |
| wasm-bindgen-macro | 0.2.129 | MIT OR Apache-2.0 | MIT | build 時のみ（proc-macro など） |
| wasm-bindgen-macro-support | 0.2.129 | MIT OR Apache-2.0 | MIT | 依存の依存 |
| wasm-bindgen-shared | 0.2.129 | MIT OR Apache-2.0 | MIT | 依存の依存 |
| weezl | 0.1.12 | MIT OR Apache-2.0 | MIT | niho-base-raw: rawler の依存（LZW 圧縮） |
| windows-core | 0.62.2 | MIT OR Apache-2.0 | MIT | niho-base-raw: macOS・Linux では build されない（Windows・Android などの依存） |
| windows-implement | 0.60.2 | MIT OR Apache-2.0 | MIT | niho-base-raw: macOS・Linux では build されない（Windows・Android などの依存） |
| windows-interface | 0.59.3 | MIT OR Apache-2.0 | MIT | niho-base-raw: macOS・Linux では build されない（Windows・Android などの依存） |
| windows-link | 0.2.1 | MIT OR Apache-2.0 | MIT | niho-base-raw: macOS・Linux では build されない（Windows・Android などの依存） |
| windows-result | 0.4.1 | MIT OR Apache-2.0 | MIT | niho-base-raw: macOS・Linux では build されない（Windows・Android などの依存） |
| windows-strings | 0.5.1 | MIT OR Apache-2.0 | MIT | niho-base-raw: macOS・Linux では build されない（Windows・Android などの依存） |
| windows-sys | 0.61.2 | MIT OR Apache-2.0 | MIT | niho-base-raw: macOS・Linux では build されない（Windows・Android などの依存） |
| winnow | 0.7.15 | MIT | MIT | niho-base-raw: 依存の依存 |
| winnow | 1.0.4 | MIT | MIT | niho-base-raw: build 時のみ（proc-macro など） |
| zerocopy | 0.8.59 | BSD-2-Clause OR Apache-2.0 OR MIT | MIT | niho-base-raw: rawler の依存 |
| zerocopy-derive | 0.8.59 | BSD-2-Clause OR Apache-2.0 OR MIT | MIT | niho-base-raw: build 時のみ（proc-macro など） |
| zlib-rs | 0.6.8 | Zlib | Zlib | deflate |
| zmij | 1.0.23 | MIT | MIT | 依存の依存 |
| zune-core | 0.5.3 | MIT OR Apache-2.0 OR Zlib | MIT | zune-jpeg の土台 |
| zune-jpeg | 0.5.15 | MIT OR Apache-2.0 OR Zlib | MIT | JPEG デコーダ（image 経由） |
