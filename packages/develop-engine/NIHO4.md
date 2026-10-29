# NIHO 4 の機種別 RAW 現像式

`niho-4` / `niho-standard-3` は signed RAW 作業コピー用の式です。公開済みエンジンを製品が使うときは、対応3機種の未保存 signed RAW だけをこの式で初期化します。既存の `niho-3` と保存済み設定は変更しません。signed RAW の自動生成は別の明示フラグで制御します。

## 機種の選択

`WorkingCopyMeta::Raw.dcpSha256` の較正 ID だけで式を選びます。

- `cal-panasonic-dc-s5-apple-v<数字>`: R395 固定候補。R393 の明部モデルと R245 の暗部モデルを使います。
- `cal-sony-zv-e10m2-apple-v<数字>`、`cal-sony-ilme-fx30-apple-v<数字>`: R364 固定候補。
- それ以外の機種・較正、raster、旧 unsigned RAW は拒否します。ファイル名、プリセット、ISO、シーン名では分岐しません。

`engine=niho-4` と `look=niho-standard-3` は必ず対にします。`niho-3` / `niho-standard-2` の互換経路は維持します。

## 処理順と固定した補正

signed RAW → R209 CNR → 750px の共通解析 → 明部 H → 暗部 S → WB・露光 → RGB Texture → NIHO 3 後段、の順です。後段には ACR3、正の Black、R218 残差 profile、V65 Vibrance、Saturation/HSL、出力クリップを含みます。Panasonic だけ R281 pre-profile を ACR3 の直後に適用します。

Panasonic と Sony の明部は有界な色差保持式です。Panasonic の暗部は、H と S を同時に使うときだけ `1 - 0.45 × (−H/100)^4 × (S/100)` を暗部 gain に掛けます。これは R395 凍結前に既知データで固定した連続式で、シーンやプリセットには依存しません。H 単独と S 単独、Sony の経路は変わりません。

`Arc` / `Weak` の元画像共有、解析キャッシュ、preview cache、full master、thumbnail、auto-analysis の共有は NIHO 3 の構造を引き継ぎ、engine と機種でキャッシュキーを分けます。#17945 は画素を保つ安全な改善と同条件の実測を扱います。PCブラウザの先行表示・操作応答は #18229 で受け入れました。初回最終描画約1秒と Wasm peak 約200MB は #18358 で検証し、未達のまま追加投資を終了しました。

## 性能とメモリの確認（#17945）

R395最終候補の signed 作業コピーを、Wasm の新規インスタンスごとに開いて Final 1280px を描くと、Sony 2機種で約2.1秒、Panasonicで約2.35秒でした。プリセット見本を順に描く editor シナリオの Wasm linear memory peak は約331〜383MBです。Node上のWasm計測であり、Chromeの通信・画面表示時間とは分けます。測定条件・RAWを含まない結果は #17945、私有の再現入力はNAS `issue17945-performance/r395-final-baseline/` に保持します。

HかSの片方だけを使う設定では、使わない補正の全画面ゲイン画像と走査を省きます。両方を使う設定でも全画面のゲイン画像を同時に3枚保持しません。750pxの共通解析、CNR、補正の順番、画素値は変えません。Sony 2機種・Panasonicの Hのみ/Sのみと H/S両方の計7条件を旧Wasmと新Wasmで2回ずつ交互に測り、初回・操作・再openの全RGBAが一致しました。CNRなしの初回Wasm memoryは約190/189MBから約173/172MB、操作後peakはSony約226→204MB、Panasonic約225→203MBでした。CNR25のSonyは初回約261MBのまま、操作後peakが約279→261MBでした。

さらに実UIに近い preset見本・auto・操作を含むeditorシナリオを3回ずつ比較しました。全RGBA一致で、CNR25のSonyはWasm peak約331→314MB、CNRなしのSonyは見本生成後の約383MBで変わりません。時間はケース間・試行間で揺れ、初回/見本/操作/再openの速度改善としては判定しません。200MBの目標達成は主張しません。

## 最終描画1秒・Wasm 200MBの検証（#18358、未達で終了）

公開版0.12.1を同じ入力で測ると、Sony/PanasonicのCNR0・青空設定は初回Final 1280pxが約2秒、editorシナリオのWasm peakが約383/382MBです。SonyのCNR25・鮮やか設定は初回約2秒、peak約314MBです。Nodeの単一Wasmインスタンスの値で、Chromeの通信・JS heap・RSSとは別です。

見本を1枚ずつ測ると、CNR0で開いたSonyのWasm容量は「青空」243MB→「パステル」261MB→CNR25の「鮮やか」383MBへ増えます。親の原寸マスターを保持したまま、見本用の別Sessionが原寸CNR結果と原寸マスターを作る構造が大きな要因です。Wasm linear memoryは解放後も確保済み容量が縮まないため、事後的な`free`だけではこのpeakを下げられません。

2026-10-11の試作は次の理由で採用しませんでした。

| 試作 | 同一条件の結果 | 判定 |
| --- | --- | --- |
| 解析用の原寸量子化コピーを行単位へ変更 | 3機種の全RGBAは一致。CNR0の初回Wasm容量が約173→195MB、editor peakが約383→387MB。初回時間も安定改善なし | 一時コピーの削除だけではallocatorの高水位が下がらず、逆効果 |
| Final 1280pxを縮小した入力から準備 | CNR0の初回は約0.3秒短縮、CNR25はほぼ不変。主画像のRGBAが変化 | 保存済みrecipeの再表示・原寸との画素契約を守る経路には採用しない |
| 見本だけ512pxの入力から準備 | CNR0のeditor peakは約383→313MB。ただし96px見本のRGB平均差は約1/255、最大差は50〜74/255 | 見本のFinal画質を変えるため採用しない |

原寸CNRの guided filter は17×17のbox passを2回使うため、各出力行が必要とする入力は上下16行までです。256行と上下16行だけでCNRを計算し、元の全画面出力へ同じ位置に書く方式に変更しました。入力・出力の全画面は残し、中間のguide・平均・分散・channelごとの配列だけを帯へ限定します。帯の境目・画像端・CNR 1/12.5/25/37.5/50で旧式との全f32 bit一致をunit testで確認しました。

同じR395 Wasmと同一3入力をeditorシナリオで2回交互に測ると、Sony CNR0はpeak 383→313MB、Panasonic CNR0は382→312MB、Sony CNR25は初回261→226MB、editor peak 331→314MBでした。全stepのRGBAは一致しました。公開0.12.1からの増分としては、CNR25のeditor peakは約314MBのままであり、1秒/200MBは達成していません。初回時間に安定した改善もありません。数値はWasm linear memoryの確保済み容量で、解放後に縮まない性質を含みます。

初回Finalのネイティブ診断では、Sony CNR0で原寸量子化・750px縮小が約0.15秒、750px応答モデルの特徴計算が約0.13秒、モデル推論が約0.5秒、原寸Textureが約0.2秒でした。これはWasmの時間内訳ではなく、支配段を探す補助測定です。`libm::tanh` を標準ライブラリの `tanh` に替える試作は3入力の初回RGBAが一致したものの、Wasm初回が各1試行で約2.9〜3.5秒へ遅くなり撤回しました。量子化を行単位にする試作も、CNR帯処理との併用で初回メモリ・editor peakの双方が増え、撤回しました。

2026-10-13のowner判断により、PCブラウザの先行表示と操作応答を #18229 の製品受入にし、同じ最終画を1秒で作ることと Wasm peak 200MB は #18358 の研究目標に分けました。Chromeでは閲覧用プレビューを最終画より先に出し、画質・保存recipe・原寸との一致を優先します。数値目標を厳守するには、CNRの一時配列だけでなく、原寸source・CNR結果・フルmasterを別session間で同時に保持する構造と、750px応答の26特徴を全画素で実体化してモデル推論する構造を変える必要があります。特に1秒はモデル推論の実測が支配的で、表面的なバッファ解放だけでは届きません。原寸Final・保存recipe・native/Wasmの画素一致を守る限り、モデルの近似や縮小入力への置換は採用しません。

2026-10-13には、画像全体で一定の平均・分位点8特徴について、モデル第1層の積を画像につき1回だけ計算し、元の加算順で使う実装を試しました。Sony CNR0/CNR25、Panasonic CNR0の初回Final 1280pxを旧版と5回交互に測ると、中央値はそれぞれ2245→2147ms、2049→1997ms、2373→2344msでした。3入力のUI/editor全ステップのRGBAは一致し、Wasm高水位は不変です。改善は小さく、1秒/200MBを達成したとはみなしません。

同日の別試作では、26特徴の全画素配列を16値へ圧縮して推論時に復元しました。RGBAは一致しましたが、3入力のUI/editor全条件でWasm高水位は不変、初回の短縮も0〜2%程度だったため撤回しました。解析用16bitデコード・量子化テーブルのビルド時生成は初回4〜12msしか短縮せず、Wasm配信量が約0.66MB増えたため撤回しました。WasmアロケータをTalcへ替える試作はUI経路の高水位を各入力で約17.5MB増やしたため撤回しました。いずれも同一入力の独立したWasmインスタンスを交互に測った結果です。

最終判断は「目標未達・現時点で追加実装しない」です。初回Finalは約2秒、editorのWasm高水位は約312〜314MBで、Chrome全体の実メモリではありません。製品の先行表示は別経路で受け入れ済みです。残差を埋めるために画素一致や操作後の応答を犠牲にせず大規模な領域処理・並列化・事前計算を追加する便益は、現在の顧客症状から確認できません。実利用のniho-4で先行表示の遅延、操作後の待ち、メモリ不足・クラッシュが再現した場合は、`?photoDevelopPerf=1` のWorker段階計測とChrome traceを取り、症状に対応する目標を新たに設定して再開します。#18358のcloseは数値達成を意味しません。

参考にする公開設計は、Adobeの[Smart Preview](https://helpx.adobe.com/uk/lightroom-classic/desktop/viewing-photos/lightroom-smart-previews.html)と[Camera Raw cache](https://helpx.adobe.com/lightroom-classic/desktop/technical-support/performance-guidelines/optimize-performance-lightroom.html)、libvipsの[領域単位の遅延計算](https://www.libvips.org/API/current/how-it-works.html)です。これらは先行表示・再計算の回避・原寸中間配列の削減を考える根拠であり、Lightroomが同条件のFinal 1秒・Wasm 200MBを達成している証拠ではありません。

## 同じ写真の使い回しと H/S の解析の先行（#129）

画素を変えない速さの手を 2 つ入れました（engine は上げません）。

- **同じ写真の Developer を保つ**: 画面の Worker は、開き方と入力の bytes の SHA-256 を鍵に、開いている 1 枚と直前に開いていた 1 枚の `Developer` を保ちます。同じ入力をもう一度開くと、デコード・解析・cube・master を作り直さずに使います。新しい写真をデコードする前に古いほうから手放します。
- **H/S の解析を先に作る**: `Session::prepare_analysis`（wasm の `Developer.prepareAnalysis`）は描かずに解析（CNR の元・応答の係数・niho-7 の面）だけを作ります。master の解析が設定の CNR に合えばその中へ、合わなければ「先に作った解析」として 1 つ持ち、master の解析と入れ替えるときは前の解析を取っておきます（colorful の CNR 25 と行き来しても作り直さない。最大 2 つ）。Worker は丁寧に描いた後、通常の要求が 500ms 来なければ、今の設定と同梱のプリセットの解析（違う CNR は 1 つまで）を 1 件ずつ作ります。

`niho4::prepare` の解析の段は `make_analysis` に切り出しただけで、処理と順番は同じです。`tests/session_reuse.rs` で、他の露光・プリセット・CNR・見本・drag を描いた後の Session と、解析を先に作った Session の Final が、新しく開いた Session と同じ byte になることを native と wasm で確かめます。

公開 RW2 から作った 2560×1707 の signed 作業コピー相当（色は Apple のものではない。大きさと中身だけ実写）を、Studio の Node の wasm（1 本のスレッド）で、niho-11・Final 1280 で 6 回ずつ別 process で測った中央値です（ms）。全条件の RGBA が一致しました。

| 段 | 今 | 保った Developer | 解析を先に作った後 |
|---|---|---|---|
| 開き直す（デコード） | 127 | 0 | 0 |
| 開き直した後の最初の Final（同じ設定） | 868 | 675 | 665 |
| 露光 +0.3 | 719 | 731 | 736 |
| 最初のプリセット（bluesky2） | 3559 | 3546 | 2215 |
| colorful（CNR 25） | 4243 | 4215 | 2468（CNR 25 も先に作った場合） |
| 先に作る解析（空き時間・途中で止められない） | – | – | CNR 0: 1341 / CNR 25: 1787 |

Wasm linear memory の高水位は、1 枚の Session で 260〜334MB、CNR 25 の解析も先に作ると 386MB です。30 枚を順に開く（各 open・最初・露光・プリセット）と、保たない場合 316MB、直前の 1 枚を保つと 552MB、解析の先行も合わせると 648MB で、どれも数枚目から増えません。保つ写真からは見本の session と、先に作った別の設定の解析を手放してから保ちます（手放さないと 771MB）。Air 8GB の実 UI での受入は #129 の手順で別に測ります。

Final の局所の段（`pipeline.rs` の `local_pass`）は、cube Q を通した 750px の統計から決まる `gain_scale`・`shift` が同じときだけ使い回します。色やトーンだけを変えても統計が変われば、局所の輝度の計算（`local_luminance`）の結果も変わるので、その計算は画素を変えずには省けません。省けるのは入力の対数輝度の面（色だけの変更では同じ）だけで、手を入れていません。

## 根拠と検証

- 内部固定記録 `round395-r394-interaction-freeze/freeze.json`: SHA-256 `01f10228a53475083bc4af205bcda5a20eab50d1a64b99fbc5a7eb302e5b2a2e`。
- Panasonic モデル asset: `fd5565d25183245ca7c88f105c3a4dcffa99c4dc827071e47782a51e138d00a7`。Sony R364 asset: `96bf1727622b05cc92f38dd98b52591247fbbb3f36a26e3d8caacfcdbdbbfb17`。
- R385 の独立 DC-S5 RAW 5 枚×4 設定は 20/20 合格。結果 SHA-256 `a29bffe11b96aced9897f27aa287c36e5a3e886eb2b6aee54d0680e1e60070c8`。判定は長辺 1500px・blur 2、neutral 平均 ΔE00 ≤2、各 preset 平均 ≤3、各シーン・設定 p99 ≤8 です。
- 旧164条件も合格。結果 SHA-256 `e5c97e0de1b42672afbd700a5a264a50d36befaaf21ac106c881ea3b75a3658d`。Panasonic 116条件は固定候補の既知回帰記録を再利用し、Sony 48条件は製品コードで再描画しました。
- 夜24条件も製品コードで合格。結果 SHA-256 `61d464441ba707ae1fb62fb9c191b59322a8e133389a6ca43cd27e1471343c99`。
- 製品コードの R385 20 出力は固定実行ファイルの JPEG と全件バイト一致。Sony の独立 R376 は既存 R364 の受入記録を維持します。
- 3機種×4設定の Native/Wasm RGBA は 12/12 でバイト一致しました。

RAW 原本・Lightroom 参照 JPEG・研究用データはリポジトリ外に保持します。モデル asset は固定係数の表現であり、製品コード内で学習や閾値選定は行いません。

## P5: signed RAW のクリップ領域（#18399、評価中）

`niho-5` / `niho-standard-4` は `niho-4` / `niho-standard-3` の R395 数式を保持し、負の Highlights のときだけ明部の再構成をその前段へ加える新しい対です。保存済みの補正を新しい版へ暗黙に移しません。公開 wasm、Desktop、Web/API の bundle pin と新規写真の既定版を切り替えるのは別の公開 PR です。R395 `freeze.json` の SHA-256 `01f10228a53475083bc4af205bcda5a20eab50d1a64b99fbc5a7eb302e5b2a2e` は変更しません。

白飛び候補は `signed-gamma18-v1` のメタデータの `encoding.ceiling` に対する相対明度と、明部の低彩度・局所平坦性で判定します。保存用 PNG コード 65535 への到達は条件にしません。R391 の白い平坦部には画素値約 2.06 / ceiling 4 のものがあり、コード最大値には張り付きません。長辺 320px の解析面で、候補の外にある明るい画素の ProPhoto 輝度に対する色差を最大 24 画素まで伝播します。元解像度へ戻した色差は Highlights の強さに比例して有界に加え、明部の輝度には最大 4% の肩を付けます。H=0、非候補画素、旧版の数式は不変です。この段は作業コピーの線形画素と ceiling だけを読み、段 1 のデコード方式や RAW ファイルに依存しません。現時点のマスク境界と肩の強さは既知開発資料で置いた暫定値で、新しいクリップ教師による gate を通すまでは採用を確定しません。

私有の比較出力は NAS `niho-color-work-p1/issue18399-raw-highlights/round*` に置きます。R391 の既知開発 5 場面×Highlights −60/−100 は、全解像度で描画して長辺 1500px・blur 2 で比較すると全画面 p99 最大 3.4545 でした（`round05-r391-full/summary.json`）。ceiling 相対の平坦・低彩度明部マスクで見ると2場面は有効画素 0、もう1場面は最大46画素です。新規のクリップ領域 gate の合否資料にはなりません（`round05-r391-full/clip-region-summary.json` と同フォルダの `highlight_gate.py`）。旧版の同条件出力は `round07-r391-niho4-full/` に保持します。

旧164条件は164/164合格で、neutral 平均 0.98309、各 preset 平均最大 2.1913、個別 p99 最大 7.9566 でした。R395 記録との差は各条件の p99 で −0.002〜+0.002 です（`round08-old164-full/summary.json`）。夜24条件は24/24合格で、neutral 平均 1.29797、各 preset 平均最大 2.63072、個別 p99 最大 7.1872 でした（`round06-night24-full/summary.json`）。R385 の旧独立20条件を新版の回帰確認に再利用した結果は20/20合格で、neutral 平均 0.89146、各 preset 平均最大 2.15728、個別 p99 最大 5.9223 でした（`round04-r385-full-regression/summary.json`）。これは新版にとって新規の独立評価ではありません。いずれも全解像度描画後の長辺 1500px・blur 2 判定です。R395 旧版の同じ作業コピーと設定は保存した旧バイナリと JPEG byte 一致を確認しました。新版の R391 signed 作業コピー 1枚を 1280px Final で H=0/−60/−100 に描いた Native/Wasm RGBA は 3/3 で byte 一致しました（`round09-wasm-parity/summary.json`）。

#18399 の [Issue コメント](SOURCE_REPOSITORY)で owner に新しいクリップ場面の RAW・XMP・Lightroom Highlights 0/−60/−100 書き出しを依頼しました。追加 gate「その明部で p99 ≤8」は新教師を受領して評価するまで未判定です。この版はその評価を終えるまで公開対象にしません。
