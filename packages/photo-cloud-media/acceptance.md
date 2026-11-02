# C04 形式・資源・実接続の受入

これは接続条件と試験範囲の台帳。source の存在、合成 SDK 試験、実 decoder/storage、実端末を別に記録し、空欄や未実行を合格へ変えない。

## 形式ごとの入力経路

| 形式 | C04 renderer の入力 | 原本保存 | 実形式の decoder 受入 | 原寸書出し |
| --- | --- | --- | --- | --- |
| JPEG | 予算内の原本、または同じ saved base の JPEG8 作業コピー | C02 実 storage 待ち | 小さい合成 JPEG/EXIF 向きの公式 SDK probe 成功。本人 worker 統合は別 | Web は選んだ入力の実寸法まで。Mac native は C05/C07 待ち |
| PNG | 予算内の原本、または同じ saved base の作業コピー | C02 実 storage 待ち | 小さい合成 PNG と EXIF 向き付き PNG の公式 SDK/provider 試験成功。巨大/alpha/色 profile の実接続は別 | 入力の実寸法まで |
| HEIC/HEIF | 既存 decoder が生成した canonical JPEG8/PNG16 のみ | C02 の実能力・storage 待ち | 本人 decoder 未受入。拡張子や factory の存在では対応扱いにしない | 低解像度作業コピーから原寸を名乗らない。native 実受入待ち |
| TIFF | 既存 decoder が生成した canonical 作業コピーのみ | C02 の実能力・storage 待ち | 本人 decoder 未受入 | native 実受入待ち |
| RAW | 既存 decoder の版付き PNG16 と完全 linear/color/calibration metadata | C02 の実能力・storage 待ち | 合成 PNG16 で metadata が画素に反映される probe のみ。実 RAW/機種/DCP/calibration は未受入 | native と元の原本/base の実照合待ち |

公式 SDK probe の固定版は README を参照。crop と mask の実 SDK probe も小さい合成入力で実施済みだが、本人 backend の面保存・owner 照合・job publish の成功を示すものではない。本 package の対象テスト結果は PR の exact head と対応付けて別途記録する。

## 資源と失敗の扱い

C00 の上限は原本 200 MiB、100 MP、browser direct 40 MP、作業コピー長辺 2560、preview 1280、thumbnail 512、mask 8 MiB/長辺 4096。direct renderer の JPEG は 64 MiB、PNG は 10 MiB までとし、実 host の明示予算が小さければそちらを使う。server 設定も上限を拡大する権限ではない。PNG 入力は bytes 内で最大65,536 chunks、sanitized output は256 chunksに制限する。APNG は対象外。PNG16 の合法な多数の IDAT chunks を小さい出力用の上限で拒否しない。

browser は metadata と全 range を照合してから予算内の buffer を割り当て、完全 SHA-256 照合後に engine へ渡す。失敗・失効・解放時には保持 bytes を消す。server は owner/generation を照合済みの読み口から入力を取得し、隔離した固定 SDK で処理する。deadline/abort、入力/出力上限、scratch 清掃、固定 error code を対象試験で確認する。

renderer 自体は storage 書込みや job publish をしない。既存 backend の atomic publish が、owner、親 session の失効世代、lifecycle、job/lease/deadline、原本 generation、全 recipe revision/hash、base/mask、renderer manifest と output policy を比較する。削除後・旧 lease・旧 recipe の成果物を、新しい ready として公開しない。

## iPhone の測定記録

実測は C06 の正式候補を使い、C07 で独立確認する。機種/iOS、Safari/standalone、source/API/SDK 版、原本と作業コピーの bytes/寸法、実取得量、連続編集/書出し回数、中断復帰、tab の再読込/停止、観測方法と memory 高水位を非公開証跡へ記録する。Web Inspector 等で観測できない値は測定不可とし、SDK の係数や推定値を実測と呼ばない。

実 iPhone の Safari/PWA、実本人 storage/provider、配布 Mac との往復は未実施。これらが揃うまで #197/#199/#200 の完了・出荷済みを宣言しない。
