# Photo cloud B担当の調査・試験準備

対象は #194 → #197 → #199 → #200。#193 の契約確定前に作る試験準備であり、実接続・配備・実機受入の完了記録ではない。正式な型・API・能力表・配置・writer は #193 を正とする。本資料で新しいclient名、origin、callback、wire型、保存基盤を決定しない。

## 担当と依存

| 項目 | B担当 | 接続前に必要な担当成果物 |
| --- | --- | --- |
| #194 | Photo本人認証consumer、host session bridge、拒否系試験 | #193 のclient/origin/callback/BFF配置、認証producerのPhoto登録 |
| #197 | 形式/派生物identityの受入、共通host入出力、iPhone計測 | #193 の契約、#195 のlibrary/転送、既存実provider/decoder |
| #199 | Photo専用browser-only host、Safari/PWA | #194/#195/#196/#197、共有編集面、正式配備設定 |
| #200 | 独立harness、越権/容量/競合/削除、実Mac往復 | #194〜#199 の実接続、実storage/provider、実iPhone、正式候補 |

契約/fixture/export、adapter/転送、同期/outbox、Mac runtime、共有lock/CSP/release/manifestは各writerへ返す。非公開側のpurge/merge/native SDK sourceを別実装しない。Editorの `/photo` は開発先・受入面・配布先にしない。

## 調査結果（2026-11-03、公開source `5ff21a28ae5f7a0e3a64a98b1ef31a7ca523b2a6`）

| 資産 | 確認した範囲 | 実装時の条件 |
| --- | --- | --- |
| `packages/desktop-account` | nativeのPKCE/取消/refreshと安全なUI snapshot。Mac clientは `niho-camera` | snapshotは本人証明ではない。token/refresh/安全な保存はnative所有を維持し、canonical本人はserverで照合 |
| `apps/camera/src/personal-cloud-binding.ts` | trusted actor/library/session epochが揃うとbindingを構成。scope離脱で取消し、転送はnative portへ依存 | 実native転送・永続journal・本人照合が接続済みとは数えない。Mac本体の配線は #198 writer |
| `apps/camera/src/use-guarded-cloud-binding.ts` | 本人binding離脱・失効・未保存のguard | Webも旧本人のquery/転送/下書きを捨てる。単なるログイン表示を認可にしない |
| 旧公開Editorの `src/auth/niho.ts` | POST認証開始/callback、S256、短期pending cookie、opaque session、毎要求introspect、refresh/revoke/cancel | Editor client/cookie/origin/routeと結合している。名前置換だけでPhotoへ接続しない。C00後、由来SHA/hashと責務を監査して最小抽出 |
| 旧公開Editorの `src/server/photo-auth` | browser/Mac認証分離、固定応答DTO・上限・期限・失効の検査 | Docs providerへのfallbackや旧Editor sessionの受理をPhotoへ持ち込まない。新しい認証発行元は作らない |
| `packages/photo-editing` | 共通編集UI、版付き作業コピー、固定engine、能力不足時のwrite拒否、メモリ予算の既存試験 | 拠点用のprovider/URLを本人用とみなさない。メモリ係数のunit成功は実iPhone計測の代わりにしない |
| 旧公開Editorのmedia/Web/PWA | 画像provider、working-copy resolver、manifest/SW/更新guardの再利用候補 | 独自DB/派生物正本を再開しない。RAW/HEIC対応は実decoder/workerの能力で判断。Photo専用hostへ最小抽出 |

旧Editorの資産は `niho-life/niho-editor` の公開sourceを参照する。抽出時はその時点のexact SHA/ファイルhash/由来を改めて記録し、閉じたPRをそのまま再開しない。非公開の調査結果・実設定・認証値はこの資料へ転載しない。

## #194 の先行試験

- PKCE S256/state/一回限りcode、別client・本人差・期限・replayをunitと実handler+DBで分けて試す。
- callbackは承認済みPOSTを使い、query/fragment・想定外Origin/Host・重複cookie・過大/停止/abort bodyを拒否する。クロスサイトPOSTから同一originへの処理を、Safari/PWAでそれぞれ確認する。
- 短期attemptとHttpOnly cookieを使い、token/code/state/PIIをJS・URL・ログへ返さない。毎要求の本人/connection/client/期限/失効確認を欠かさない。
- 並行refreshと旧世代grace、logout/cancel/exchange競合、古いcallback/refresh応答の遅着を試す。取消・失効後に接続を復活させない。
- 本人A→B切替でepochを変え、Aのquery/転送/下書きの遅着をBへ適用しない。未接続/失効でも無料のMacローカル編集を続けられる。
- 正式設定readbackと合成canaryで認証経路の非保存を確認する。positive controlが取れない空の検索は合格にしない。実credentialは流さずに先に確認する。

## #197 の形式・メモリ試験

JPEG/PNGを必須とし、HEIC/HEIF、実decoderが受けるRAW、TIFFは「保存・閲覧・編集・原寸書出し」を別々に記録する。未対応・未受入の欄を成功で埋めない。形式・dimensions/bytesの閾値はC00/実providerから取得し、本準備で新しい閾値を作らない。

合成画像は色パッチ、縦横回転、alpha、細線を含める。RAWは許可済みfixtureでlinear/color/calibrationを確認する。source hash/generation、recipe revision、engine/能力、mask identityを変えた派生物と、旧job/lease・削除後生成のpublish拒否を実providerで確認する。

iPhoneでは機種/iOS/Safariまたはstandalone、入力bytes/寸法、作業コピーbytes/寸法、転送量、連続編集/書出し回数、メモリ観測方法・高水位、tab再読込/停止の有無、背景中断からの復帰を非公開証跡へ記録する。Web Inspector等で取得できない値は「測定不可」と記録し推定値を実測扱いしない。巨大RAW原本の無条件先読み、低解像度previewの原寸表示を検査する。

## #199 と #200 の試験面

必須端末は配布Macアプリ、Mac Chrome、Mac Safari、実iPhone Safari、実iPhoneホーム画面PWA。Safariとstandaloneがcookie/保存領域を共有するとは決めつけず、それぞれログイン・失効・更新・背景中断・再開を試す。エミュレーションは実iPhoneの代替にしない。

SWの保存対象は許可した静的assetのみとし、認証/API/写真/署名URLがCache Storageにないことを確認する。下書きは #196 の本人別・容量制限・失効消去経路で扱う。更新前に未保存編集を保護し、初回未取得写真をオフラインで開けると案内しない。

独立検証ではA/B通常ユーザーの全operationにID/cursor/URL入替え、5GiB境界と並行予約、二重complete/応答欠落/再開、両競合revision採用、旧SDK、即時purgeと遅着処理、退会/mergeを加える。欠陥は対象writerへ返し、同じsourceを重複修正しない。

往復はMac→cloud→各Web→補正→Mac、および各Web→cloud→Mac→補正→各Webの両方向。原本がMacに残ることとhash一致、recipe/mask/historyの保持を確認する。正式配布後は配布source/SDKをreadbackして再受入する。ローカル編集とEditor文書/ページ画像の回帰も別に残す。

## 記録漏れ検査器

`scripts/cloud/acceptance/cases.mjs` は検証層・端末ごとの必要記録を列挙する。wire契約fixtureではない。`verify-evidence.mjs` はその記録漏れを検出するだけで、実API/DB/storage/実機を操作せず、証跡内容の正しさも保証しない。実行担当が独立に確認した証跡だけを登録する。

`scripts/ci/cloud-acceptance-evidence.test.mjs` が既存のPublication guardの `scripts/ci/*.test.mjs` から検査器の試験を読み込む。CIの実行配置・scope・必須checkは変更しない。

```sh
node --test scripts/cloud/acceptance/verify-evidence.test.mjs
node scripts/cloud/acceptance/verify-evidence.mjs /absolute/private/evidence.json
```

証跡JSONはrepo外の非公開領域へ保存する。トップレベルは `schemaVersion: 1`、`photoSourceSha` と `backendSourceSha`（40桁hex）、`sdkManifestSha256`（64桁hex）、`records`。各recordは `caseId`、`surface`、`result`（`pass`/`fail`/`blocked`/`not-run`）、`observations`（観測件数）、`evidenceRef`（非公開台帳に対応する無害な識別子）を持つ。URL・本人ID・写真・credential・自由文を入れない。source/SDKの異なる実行は台帳を分ける。

空集合・unitだけ・未実行/失敗・0件pass・重複・未知項目・source不明を完了扱いしない。終了値は全記録充足0、不足1、不正入力2。検査器のunitは合成記録をメモリ内に作るだけで、製品の合格記録を出力しない。必要記録が揃った後も、内容監査と #200/#201 の正式受入を行って初めて完了を判定する。

## 現時点の検証

2026-11-03の準備時点で `niho-desktop-account` の既存3試験と、cameraの本人binding/guard/account UIの既存24試験が通過。実Photo認証・実provider・実Mac往復・実iPhoneの受入は未実行。#193確定後の接続で再検証し、各Issueへ結果を戻す。
