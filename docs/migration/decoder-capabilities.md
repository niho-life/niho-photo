# RAW decoderの対応と証拠

入力形式の正本は `packages/desktop-photo/src/capabilities.rs` の `PHOTO_CAPABILITIES` である。各項目は拡張子、MIME、UTType、magic bytesまたは実decoderへ委ねるpolicy、`decoder` / `thumbnail` / `metadata` / `fullRender` の段階を持つ。既存の `PHOTO_FILE_EXTENSIONS` と `photo_kind` はこのレジストリから導出し、cameraの写真pickerとフォルダ走査も同じ値を使う。

| 製品で明示する形式 | 拡張子 | MIME / UTTypeの代表値 | 内容検査 | 段階 |
| --- | --- | --- | --- | --- |
| JPEG | jpg, jpeg | `image/jpeg` / `public.jpeg` | JPEG SOI | decoder, thumbnail, metadata, fullRender |
| PNG | png | `image/png` / `public.png` | PNG signature | decoder, thumbnail, metadata, fullRender |
| HEIC / HEIF | heic, heif | `image/heic`, `image/heif` / `public.heic`, `public.heif` | ISO BMFFの宣言範囲内の `ftyp` とHEVC固有brand（`mif1` / `msf1` だけでは受理しない、64KiB上限） | decoder, thumbnail, metadata, fullRender |
| TIFF | tif, tiff | `image/tiff` / `public.tiff` | classic TIFF byte order/magic。ImageIOの実UTTypeが別なら拒否 | decoder, thumbnail, metadata, fullRender |
| Panasonic RW2 | rw2 | `image/x-panasonic-rw2` / Panasonic RAW UTI | RW2の `IIU\0`。完全decodeは実decoder | decoder, thumbnail, metadata, fullRender |
| その他登録RAW | dng, cr2, cr3, crw, nef, nrw, arw, srf, sr2, raf, orf, pef, srw, rwl, 3fr, fff, iiq, erf, mef, mos, mrw, x3f, raw, kdc, dcr, gpr | `image/x-raw` / `public.camera-raw-image` | 別の強い形式への偽装を拒否後、実decoderが最終判定 | decoder, thumbnail, metadata, fullRender |

## 配布対象とRAW作業コピーの境界

このEpicの配布対象はmacOSアプリとWeb/PWAです。Windows版は配布せず、Windowsのdecoder・capability・受入を本Epicの完了条件に含めません。

| Host | RAW原本からの作業コピー生成 | 作業コピーの編集 | 対応の根拠とfallback |
| --- | --- | --- | --- |
| macOSアプリ | native producerがApple RAW / RAW engineで生成 | NIHO段2のnative engine | 公開CIで実RAWの画素まで検証するのはDC-S5 RW2の1撮影条件。その他は、登録形式やOS decoderが読めるだけでは受入済みにしない。decoder・校正・形式の不一致は既存の明示エラーにする |
| Web/PWA | ブラウザ/WASMにはRAW decoderがない。原本を直接decodeせず、providerが用意したcanonical作業コピーを使う | NIHO段2のWASM engine | 作業コピーが未生成・未対応なら完了扱いにせず、待機または明示エラーにする。原本からのcloud作業コピー生成とpreviewは [#197](https://github.com/niho-life/niho-photo/issues/197) の担当 |
| Windows | 配布しない | 配布しない | 対応を表示・宣言しない。実装・検証は本Epicの対象外 |

現行の作業コピー契約はmacOS経路の2560px・16bit・linear ProPhoto・signed RAWを基準にします。WASMは同じ作業コピーを編集する側であり、RAW原本のdecode能力を示すものではありません。各形式を「対応」と表示する条件は、該当hostの実decoder、作業コピー契約、画質gate、性能・メモリ上限を実証し、未対応時のfallbackまで定めることです。実写真と画像由来hashを公開証跡に含めず、owner管理holdoutの非識別集計だけを記録します。

### 現在の性能証拠と未完了の計測

| Host | 既存の証拠 | 残る計測 |
| --- | --- | --- |
| macOS | [#63](https://github.com/niho-life/niho-photo/pull/63) はMac Studio M1 Max / 64GBでDC-S5・FX30・ZV-E10M2を各20回測定。編集可能までのcold p50は1,280〜1,291ms、p95は1,295〜1,301ms、warm p95は538〜913ms。これは進捗openの測定で、目標のMacBook Air M2 / 8GB受入の代わりではない | 対象RAW形式ごとの物理メモリ上限と連続処理を測り、MacBook Air M2 / 8GBの既存時間・描画gateを確認する |
| Web/WASM | WASM段2のnative/WASM画素一致検査はあるが、RAW decoderもRAWからの作業コピー生成経路もない | #197のcanonical作業コピー経路が接続された後、実ブラウザで編集時間・物理メモリ・連続処理を測る。RAW decode性能としては扱わない |
| Windows | 配布しない | 計測しない |

Sony ZV-E10 II・FX30の別撮影日holdoutは[#212](https://github.com/niho-life/niho-photo/issues/212)で評価中です。受入母数を増やすまで、公開CIで実証済みとする形式・機種はDC-S5 RW2の公開fixtureに限定します。

レジストリへの登録は到達可能なdecoder policyであり、各OS・全カメラ機種の実証済み宣言ではない。一覧では拡張子とmetadataだけを見て全件decodeを避け、実利用時の共通validatorと各実decoderを通す。macOS ImageIOから実UTTypeを取得できたラスタは申告形式と照合するため、TIFF構造を使う未知RAWを一律TIFFとは扱わない。

| 入力・経路 | 実装 | 公開CIの証拠 | 制約 |
| --- | --- | --- | --- |
| Panasonic DC-S5 RW2 / Bayer / 14 bit | rawler 0.8.0 → normalize/WB → demosaic → 独立DCP | 所有実RW2を毎回decode。sensor/crop/WB/black/white、元のcamera RGBとの512px golden、DCP描画を検証 | 公開fixtureは一つの撮影条件。全RW2・全機種の品質は保証しない |
| DC-S5 RW2 metadata除去 | numericタグallowlistと圧縮stripから再構築 | 元とのstrip hash・原寸camera RGB hash・decoder情報の一致を監査記録に固定。公開ファイルをguardで再検査 | sanitizerはPanasonic v5–v7のoffset独立形式だけ。未知形式は拒否 |
| DNG/ARW/NEF/CR2/CR3/RAF/ORF/PEF等 | rawlerの各decoder → 共通Bayer境界 | `decode`の形・境界をunit test。ライブラリが扱う形式と製品で実証した機種は区別する | この移植の実写真CIで検証済みとは表示しない。非Bayer、特殊RAW等はdecoder/境界で明示エラーになる |
| JPEG/PNG | Rust画像decode → 段2現像 | 所有写真・合成画像とPhoto Benchの数値fixture、幾何・WB・飽和色等の既存テスト | 外部ICCファイルは同梱しない。数学的ICCのテスト値はメモリ内で生成 |
| WASM段2 | niho-develop-wasm、decoder依存なし | wasm32 buildとNIHO6/7・camera-linear codecのnative/WASM共通hashテスト | ブラウザRAW decodeやSwift producerの受入を意味しない |
| Apple RAW / macOS framework | tools/apple-raw-linear | 公開CIでSwift packageを実行し、メモリ生成したPNG/JPEG/TIFF/HEICのImageIO実decode、RasterCommandのmetadata・画素・sanitizeを検証。HEIC encoder欠落はskipせずunsupportedとして失敗 | Appleのモデル・ICCは同梱しない。RAWのOS/機種別、provider別、署名済みアプリの実機検証は別の受入が必要 |

DCPはDC-S5の所有写真とカメラJPEGから独立推定した1件だけを含む。旧DCP8件やLibRaw表をfallbackとして使わない。今回の色差指標は輝度を揃えたΔE76で、従来のLightroom相当のトーン指標やチャート測色とは異なる。fixture欠落やdecode失敗をskipで成功扱いにしない。

capabilityのunit testは権利安全なメモリ内生成signatureで形式不一致・大文字小文字・段階別エラーを検証する。これだけを実decoder受入とは呼ばない。desktop-photoのmacOS testは小さい合成PNGからローカルのImageIO/sipsでJPEG/TIFF/HEICを生成し、フォルダ追加と個別写真追加の両経路でvalidatorとmetadata読取を検査する。develop-engineのSwift testは同じ4形式をImageIOで生成・decodeしてRasterCommandの画素まで検査する。公開サニタイズ済み `fixtures/public-raw/dc-s5-owner.rw2` はdesktop-photoのregistry境界でも確認し、実画素decode・camera RGB golden・独立DCP renderはdevelop-engineの `niho-base-raw/tests/fixture_pipeline.rs` が公開CIで常時検証する。
