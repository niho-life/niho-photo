# niho-camera-cutout

NIHO camera（Epic #18387）の**背景除去**。Apple Vision の端末内推論（`VNGenerateForegroundInstanceMaskRequest`）で被写体ごとのソフトマスクを作り、透明・白・任意色の背景に合成して、原寸の PNG（sRGB RGBA）か背景を合成した JPEG に書き出す。写真をネットへ送らない。C4 #18392。0.3.0 から、部分補正の**被写体のマスクの面**（`surface`。niho-photo#135）も同じ推論で作る。設計の正は `specs/initiatives/niho-camera-app.md`（決まりごと 7: Photo Bench から持ち込むのはこれだけで、Swift の sidecar として同梱する）。

- 移植元: Photo Bench（`takuyatakahamaT/photoedit`）c76775b（NIHO camera 0.4.0）の `Sources/NihoCameraCutout`・`Sources/NihoCameraCutoutCLI`・`Tests/NihoCameraCutoutTests`。ライブラリ 5 ファイルと `CutoutComposerTests.swift` は 0.1.0 でバイト単位で同じ（SHA-256 一致）。0.2.0 で `MaskRaster.swift` のブラシの落ちる不具合だけを直した（下の「決めたこと」）。CLI は引数の解析を `Options.swift` に分けてテストできるようにし、`version`・`help` を足しただけで、切り抜きの経路は変えていない。設計の背景（マスクと座標の契約・書き出しの保護・実写真の受入）は Photo Bench の `docs/NIHO_CAMERA_BACKGROUND_REMOVAL.md`。
- Photo Bench の色・トーンのコード（PhotoCore・LibRaw・Adobe の DCP）は持ち込まない。このツールはそれらに依存しない。
- **macOS 14 以上・Apple 製ハード**で動く。依存パッケージなし（SwiftPM、Swift 6）。CI は `.github/workflows/niho-camera-cutout.yml`（macOS ランナー・下の「ビルドとテスト」）。

## ビルドとテスト

```bash
cd packages/develop-engine/tools/niho-camera-cutout
swift build -c release          # .build/release/niho-camera-cutout（arm64）
swift test                      # 合成のマスク: Float32 のマスクの量子化・PNG の往復・ソフトマスクと元の alpha の乗算・透明 / 白 / 任意色・
                                # 半透明の元画像を色の背景で不透明にする・消す / 戻すのブラシ（左上原点の正規化座標）・
                                # 既存の出力を上書きしない・PNG は透明を保ち JPEG は白へ合成・CLI の引数と版の行・
                                # compose（マスク・ブラシ・背景・縦横比の拒否・SHA-256 の照合）と失敗の code / 終了コード・
                                # surface（正規形の PNG・Adler-32 / CRC-32・向きを当てて --max-side まで縮める・推論の前の失敗）
NIHO_CUTOUT_E2E=1 swift test    # Apple Vision を実際に回す（合成画像の物体を切り抜き、透明 PNG を書き、元画像の hash が変わらない。
                                # detect がマスクを 1 回だけ置き、もう一度回しても書き直さず、compose がそのマスクで切り抜く。
                                # surface が物体を 255・壁を 0 にした面を --max-side の大きさで書き、既にある出力には書かない）
```

- ブラシの照合: 編集面のプレビューは同じブラシを TS で塗る（`packages/photo-editing/src/photo-cutout.ts` の `applyCutoutStrokes`）。`BrushParityTests` は `packages/photo-editing/src/fixtures/cutout-brush-parity.json` が `MaskRaster.applying` の出力であることを、`photo-cutout.test.ts` は TS が同じバイト列を塗ることを確かめる（Swift の `hypot` と JS の `Math.hypot` を含めて一致）。ブラシを意図して変えたら `NIHO_CUTOUT_WRITE_FIXTURE=1 swift test --filter BrushParity` で書き直し、TS も合わせる。
- `swift test` の合成テストは Vision を呼ばない。E2E は `NIHO_CUTOUT_E2E=1` のときだけ動く（CI でも走らせる）。個人の写真は Git に入れない（E2E の入力はテストの中で描く）。
- `.build/`・`.swiftpm/` は `.gitignore`。Mac mini のようにディスクが少ない機では `swift build --scratch-path <外のディスク>/niho-camera-cutout-build` で成果物を外へ置ける。

## 使い方（CLI の契約）

```
niho-camera-cutout --input PATH --output PATH [--subject largest|all|ID] [--background transparent|white|#RRGGBB] [--jpeg-quality 0...1]
niho-camera-cutout detect  --input PATH --masks-dir DIR
niho-camera-cutout compose --input PATH --mask PATH --output PATH [--mask-sha256 HEX] [--background transparent|white|#RRGGBB] [--strokes FILE.json] [--jpeg-quality 0...1]
niho-camera-cutout surface --input PATH --output PATH --kind subject|sky [--max-side 1...4096]
niho-camera-cutout version      → niho-camera-cutout 0.3.0
niho-camera-cutout help         → 使い方
```

### 1 回で切り抜く（Photo Bench の CLI のまま）

- `--input`（`-i`）: ImageIO が読める画像（JPEG・HEIC・PNG・TIFF など）。EXIF の向きを当てた画像を正とする。
- `--output`（`-o`）: 拡張子で形式を決める（`.png` = 透明を保つ sRGB RGBA、`.jpg` / `.jpeg` = 背景を合成。透明の背景は白にする）。既にあるファイル・ディレクトリ・入力そのもの（symlink 越しを含む）には書かない。同じボリュームの一時領域に書いてから `link(2)` で置くので、失敗しても壊れたファイルを残さない。
- `--subject`: 既定 `largest`（面積が最大の被写体）。`all` は全被写体、正の整数は Vision の被写体の番号。
- `--background`: 既定 `transparent`。`white`・`#RRGGBB`（`#` は省略可）。
- `--jpeg-quality`: 既定 0.92。
- 成功: 標準出力に 1 行 `<幅>x<高さ> subject=<instance-N|all> <処理時間>ms -> <出力のパス>`、終了コード 0。
- 失敗: 標準エラーに 1 行 `niho-camera-cutout: <理由>`、終了コード 1（被写体が見つからない・読めない・既にある・形式が違う・引数の誤り）。
- `version`・`help` は引数がそれ 1 つのときだけ（`--input version` は `version` という名前のファイル）。

### 機械が読む契約（`detect`・`compose`。0.2.0。`surface`。0.3.0）

編集面の「背景を除去」は、推論を 1 回だけ回してマスクを保存し（`detect`）、背景とブラシを何度でも当て直して書き出す（`compose`）。プレビューは画面の側で同じマスクとブラシを描く（`packages/photo-editing` の `photo-cutout`）。

```
detect  → {"engine":"VNGenerateForegroundInstanceMaskRequest","engineRevision":1,"schemaVersion":1,
           "width":6000,"height":4000,"inputSHA256":"…","sourceOrientation":1,"largest":"instance-1",
           "subjects":[{"selection":"instance-1","pixelCount":812345,"mask":"<sha256>.png","maskSHA256":"<sha256>","maskWidth":6000,"maskHeight":4000},
                       …, {"selection":"all",…}],
           "durationMs":1141}
compose → {"width":6000,"height":4000,"format":"png"|"jpeg","output":"…","strokes":3,"durationMs":420}
surface → {"kind":"subject","engine":"VNGenerateForegroundInstanceMaskRequest","engineRevision":1,
           "width":4096,"height":2731,"sourceWidth":6000,"sourceHeight":4000,"subjects":2,
           "surfaceSHA256":"…","bytes":81234,"durationMs":1530}
失敗    → {"error":"<code>","message":"…"}（標準出力に 1 行）と終了コード
```

- `detect`: EXIF の向きを当てた画像で推論し、被写体ごと（と `all`）のマスクを `--masks-dir` に `<マスクの SHA-256>.png`（8bit グレー・0 = 背景・255 = 被写体・画像と同じ寸法）で置く。同じ名前で同じ中身のファイルがあれば書き直さない（同じ写真をもう一度切り抜いても増えない）。中身が違えば置き換える。書きかけは `.<sha>.partial-<pid>` で、終わると消える。`width`・`height` は向きを当てた後の寸法。マスクの参照（`CutoutMaskReference`）に要る値は全部この行にある。
- `compose`: `--input`（現像した画像。向きを当てる）に `--mask` を当て、`--strokes` のブラシと `--background` を合成して `--output` に書く。`--mask-sha256` を渡すと中身を照合する（違えば `corrupt_mask`）。マスクと画像の縦横比が 1% より違えば `mask_mismatch`（切り抜き・90° 回転の後の画像に、元の枠のマスクを伸ばして当てない）。書き出しの守り（既存・入力・マスクに書かない・壊れたファイルを残さない）は 1 回の形と同じ。
- `surface`（0.3.0・niho-photo#135）: 部分補正の被写体のマスクの面（`docs/local-adjustments.md`「面の受け渡し」）を作る。`--input` は**作業画像**（マスクの座標の基準。RAW は作業コピーを sRGB 8bit にした画像、JPEG / PNG などは元の写真）で、EXIF の向きを当て、長辺が `--max-side`（既定 4096。エンジンの面の上限）を超えれば縮めてから推論する（大きくはしない）。全部の被写体（`allInstances`）を 1 枚にしたソフトマスク（0 = 外・255 = 被写体）を、推論した画像と同じ寸法の **正規形の PNG** で `--output` に書く: 署名・IHDR（8bit グレー・色の型 0・interlace 無し）・IDAT 1 つ・IEND だけ（tRNS・acTL・色の profile・EXIF を持たない）、行の filter はすべて 0、zlib（Apple の Compression の deflate）。同じ画素は同じ macOS で同じ byte になる（Rust の `encode_surface_png` と同じ byte ではない。面の id は書いた byte の SHA-256 で、`surfaceSHA256` に返す）。8 MiB を超えれば `encode_failed`。`width`・`height` は面の寸法、`sourceWidth`・`sourceHeight` は向きを当てた入力の寸法、`subjects` は Vision が見つけた被写体の数。`--output` は新しいファイルだけ（既にある・ディレクトリ・symlink には書かない。同じフォルダの `.` で始まる一時ファイルから `link(2)` で置く）。`--kind sky` は口だけで、検出の方式が決まるまで `unsupported_kind`（2）で断る（niho-photo#128）。
- `--strokes`: `[{"mode":"erase"|"restore","radius":0.05,"points":[{"x":0.5,"y":0.5},…]},…]`（`CutoutBrushStroke`）。座標は画像の左上を原点に 0〜1（ドラッグで写真の外へ出た点も残せるよう -1〜2 を受け付ける。外の分は塗らない）、`radius` は短い辺に対する割合（0 より大きく 1 以下）。順に塗る（消す = 被写体を減らす・戻す = 元の画素へ戻す）。
- オプションは `--key value`。知らない・2 回・値の無いオプションは `invalid_arguments`（1 回の形は Photo Bench のゆるい解析のまま）。

| 終了コード | `error` |
|---|---|
| 1 | `invalid_arguments`・`unsupported_output`（PNG / JPEG 以外）・`invalid_strokes`・`unknown_subject`・`internal_error` |
| 2 | `no_subjects`（切り抜ける被写体が無い）・`engine_failed`（この Mac で Vision が動かない・想定外のマスク）・`unsupported_kind`（`surface` のまだ作れない種類） |
| 3 | `input_unreadable`・`invalid_image`・`corrupt_mask`・`mask_mismatch` |
| 4 | `destination_exists`・`destination_is_directory`・`source_overwrite`・`encode_failed`・`write_failed` |

- `message` はログ向け（`CutoutError` の日本語。OS のエラーは `domain error code`）。画面の文言は `error` から呼ぶ側が決める。
- 書き出しは入力のメタデータ（EXIF・位置情報・カメラ・撮影日時）を写さない。ImageIO が向き 1 の EXIF（JPEG は APP1、PNG は `eXIf`）を自分で書くだけ。NIHO camera が撮影日時を付けるときは JPEG を `apple-raw-linear retag-jpeg` に通す（Epic #17114 Decision 10 と同じ規則）。
- 停止は呼ぶ側がプロセスに SIGTERM を送る。止めた時に書きかけの `.<sha>.partial-<pid>`（`--masks-dir`）や一時領域のファイルが残ることがある。完成した名前のファイルは壊れていない（置くのは書き終えた後の `rename` / `link`）。`.` で始まる書きかけは呼ぶ側が消してよい。

## 同梱と版（sidecar）

NIHO camera（`apps/camera`）が `Contents/MacOS/niho-camera-cutout` として同梱する。版と指紋は NIHO Desktop の `apple-raw-linear` と同じ形（`apps/desktop/scripts/develop-sidecars-lock.mjs`）:

- **版**: `Sources/NihoCameraCutoutCLI/Tool.swift` の `static let version`。実行ファイルは `niho-camera-cutout version` に `niho-camera-cutout X.Y.Z` の 1 行で答える（apple-raw-linear と同じ行）。同梱する側は起動時にこの行と lock の版を照合し、合わなければ背景除去を閉じる（spec 決まりごと 3）。
- **指紋**: `Package.swift`・`Package.resolved`（あれば）・`Sources/` の、git が追跡している・無視されていないファイルの `<sha256>  <path>` を並べた SHA-256（Desktop の lock の `sources.fingerprint` と同じ計算。テスト・README・`scripts/` は入れない）。
- camera の lock（`develop-sidecars.lock.json` と同じ形式）は C3 #18391 / C5 #18393 が作り、エンジンの公開の PR（`ops/runbooks/develop-engine-release.md`）が進める。ここでは lock を書かない。

```bash
node packages/develop-engine/tools/niho-camera-cutout/scripts/sidecar-lock.mjs version                 # ソースの版
node packages/develop-engine/tools/niho-camera-cutout/scripts/sidecar-lock.mjs fingerprint [--verbose]  # ソースの指紋
node packages/develop-engine/tools/niho-camera-cutout/scripts/sidecar-lock.mjs entry                   # lock に書く値 {"version","sources":{"fingerprint","fileCount"}}
node packages/develop-engine/tools/niho-camera-cutout/scripts/sidecar-lock.mjs check-binary --binary packages/develop-engine/tools/niho-camera-cutout/.build/release/niho-camera-cutout
                                # HOME と PATH だけ・cwd / で `version` を聞いてソースの版と照合し、macOS の外の dylib（Homebrew など）を読まないか
node packages/develop-engine/tools/niho-camera-cutout/scripts/sidecar-lock.mjs self-test
```

- lock を作る側は `entry` の値を書くか、`SOURCE_PATHS`・`sourceFingerprint`・`checkBinary` を import して自分の指紋と stage の照合に使う（import しても CLI は動かない）。
- 契約（コマンド・JSON・終了コード）か切り抜きの画素（マスクの作り方・合成・ブラシ・書き出し）を変える変更は minor、どちらも変えない修正は patch を上げる。`CutoutMaskReference.engineRevision`（Vision の revision）を変えるときは保存済みのマスクとの照合が変わるので minor。

## ライセンス

- 第三者のコード・モデル・データを含まない。使うのは macOS の framework（Vision・Core Image・Core Graphics・Core Video・ImageIO・CryptoKit・Compression・UniformTypeIdentifiers・Foundation）だけで、推論のモデルは macOS に入っているものを使い、同梱しない。`check-binary` は実行ファイルが `/usr/lib`・`/System` の外の dylib を読まないことを確かめる。
- Photo Bench の .app は LibRaw・lcms2・libjpeg・libomp のライセンス文を同梱するが、どれもこのツールは使わないので、NIHO camera の同梱物にライセンス文は増えない。`packages/develop-engine/LICENSES.md` にも同じことを書いた。
- 写したコードは Photo Bench（owner の私有リポジトリ）で書いた NIHO 自身の成果物で、第三者のコードの写しではない。

## 決めたこと

- 0.1.0（2026-10-15・C4 #18392）: Photo Bench c76775b をそのまま写し、`version`・`help` を足した。被写体が無い・引数の誤りなどはすべて終了コード 1（Photo Bench と同じ）。
- 0.2.0（2026-10-15・C4 #18392 の 2 本目）: `detect`・`compose` を足した（上の「機械が読む契約」）。ライブラリと 1 回の形の画素・出力は 0.1.0 と同じ。決めたこと: (1) マスクは中身の SHA-256 を名前にした不変のファイルにし、参照は名前と SHA-256 で持つ（Photo Bench の「マスクは不変ファイル・JSON は参照だけ」と同じ）。(2) `compose` はマスクと画像の縦横比が違えば拒否する。切り抜き・回転の後の画像へ元の枠のマスクを当てる変換は持たない（編集面で背景除去と切り抜き・回転を同時に使わない。`specs/initiatives/niho-camera-app.md` Decisions）。(3) 1 回の形は人向けの出力のまま残す（Photo Bench と同じ使い方ができる）。(4) Photo Bench の `MaskRaster.paint` は、半径より外にある点（写真の外へドラッグした筆）で `minY...maxY` が逆向きの範囲になって落ちた。外の点は塗らずに返すようにした（画像の中の画素は変わらない）。
- 0.3.0（2026-10-28・niho-photo#135）: `surface` を足した（上の「機械が読む契約」）。`detect`・`compose`・1 回の形の出力は 0.2.0 と同じ。決めたこと: (1) 推論は元の写真ではなく作業画像に当てる（RAW の作業コピーはレンズ補正を焼き込んでいるので、元の写真の面は端がずれる。作業画像を作るのは呼ぶ側）。(2) 面は全部の被写体を 1 枚にする（Lightroom の「被写体を選択」と同じ。被写体ごとの選び分けは背景除去の `detect` だけ）。(3) PNG はこのツールが自分で組む（ImageIO の PNG は色の profile・EXIF の chunk を足しうるので、エンジンと置き場が受ける最小の形にする）。(4) 4096 を超える作業画像は推論の前に縮める（Vision は内部で縮めて推論し、`generateScaledMaskForImage` が入力の寸法へ戻すので、先に縮めても面の質は変わらず、時間とメモリが減る）。
- 置き場は `packages/develop-engine/tools/`（apple-raw-linear と同じ）。NIHO Desktop には同梱しない（要るなら別 Issue）。
- CI は Desktop の CI と分けた（`niho-camera-cutout.yml`）。このツールだけを変えた PR で NIHO Desktop の Rust・Windows の job を走らせないため。
