# 公開ゲート

## 適用範囲

`niho-photo` の全コミット、PR、CI artifact に適用する。**Photoクライアントは原則公開**とし、本番権限・実ユーザーデータ・権利未確認の第三者資産だけを例外として止める。非公開 `niho-clients` / `niho-app` の Git 履歴は取り込まず、初回移植時は出典を固定したmanifestのパスを新しいコミットとして移す。公開 PR に置いた内容はマージ前でも外部から読めるため、push 前に同じ判定を行う。

## 判定と証拠

| 判定 | 条件 | 処理 |
| --- | --- | --- |
| 公開可能 | NIHO作成・所有の宣言があり、第三者由来部分、不要なmetadata、秘密情報の混入がない。または第三者ライセンスに従って公開できる | 初回移植の出典とhashをmanifestに記録する。所有資産は一件ずつ公開許可を取り直さない |
| 要置換 | 機能・テストには必要だが、実データや権利未確認資産を含む | 合成 fixture、NIHO が作成した代替物、公開 interface に置き換える。元ファイルは持ち込まない |
| 非公開維持 | 本番権限、個人情報、内部運用、配布できない第三者資産、出所不明の素材 | 公開 repo、PR、ログ、artifact へ入れない。必要なら非公開側で保持 |
| 確認待ち | 権利・機密・metadataの必要な監査が未完了 | 監査証拠がそろうまで公開 repo、PR、ログ、artifact へ含めない |

「gitleaks の誤検知」は公開許可を意味しない。検出ごとに原本の利用箇所と型を確認し、secret の真偽と資産の権利を別々に判定する。広域の除外設定を追加しない。真の secret は公開前に失効・再発行し、値や復旧手順を公開記録に書かない。オーナーが自作・撮影・公開許可を確認した資産は公開既定だが、埋め込み ICC・EXIF、GPS、serial、氏名、Finder属性、thumbnail と第三者由来データを検査する。

## 公開禁止

- API・DB・認可の最終実装、内部topology・管理経路・private remote / package / runner 情報
- 本番 token、client secret、Apple 署名・公証・updater の資格情報、秘密鍵、証明書
- 個人情報、実利用ログ、実ユーザー提供の写真・RAW・音声と不要な位置情報・端末識別metadata
- 権利未確認の第三者アイコン、フォント、画像、カラープロファイル、モデル、校正入力・派生値
- Git履歴や公開CI artifactに置く署名済み成果物、本番配布用の権限付き workflow

例外として、ownerが信頼済みMac Studioで署名したTauri updater asset一式は、sourceとSigstore attestationを検証した後にGitHub Releaseへ手動公開できます。署名鍵はMacのowner-only fileに保ち、公開CI・repo・Issue・PR・ログ・Release assetへ含めません。公開CIは署名・公証・本番配布を行いません。手順とasset契約は [`scripts/candidate/README.md`](../../scripts/candidate/README.md) を参照してください。

機械検査の初期設定は [publication-policy.json](publication-policy.json) に置く。禁止パス・機密拡張子・サイズ上限と、初回移植の出典manifestを求める契約を定義した。所有資産の公開許可はオーナーの包括的な宣言を根拠とし、候補ごとの由来とmetadata検査結果を台帳に残す。大きなRAW等は、公開リポジトリのサイズ上限に収まる最小fixtureか、[#2](https://github.com/niho-life/niho-photo/issues/2)で定義する公開成果物経路へ分ける。

既存DCP 8件は、7件にLibRaw由来行列、1件にrawtoaces-data由来部分があるため、オーナーの個別判断で公開対象から除外し、所有RAWとカメラJPEGから独立推定した新しいDCPへ置換する。新DCPは色の対応対・source hash・未使用写真での検証結果と生成bytesの再現を要求し、旧8件はhashと転記行列で継続して拒否する。チャート測色の精度は保証しない。

## PR を通す条件

1. 初回移植では移行 manifest の明示パスだけを新規コミットへ追加し、移行元の完全 commit SHA、各ファイルの SHA-256、所有の宣言または第三者ライセンス、metadata処理を記録する。submodule、private remote、親 commit の移植は禁止。以後の公開開発は原則公開とし、非公開例外をガードで止める。
2. 差分と全公開履歴に secret scan を実行する。検出を単に ignore せず、個別監査記録を更新する。
3. 実データ・禁止パス・巨大な binary・未登録資産を publication guard で拒否する。`pull_request` では read-only 権限、GitHub-hosted runner、secret なしを使う。
4. コード・依存物のライセンスと notice、資産の出所と再配布条件、生成物への混入を確認する。所有資産は一件ずつ許可申請せず由来宣言を使う。第三者由来が判断不能なら非公開維持または置換する。
5. 公開前の安全・権利レビューを記録し、レビュー対象の exact commit を固定する。レビュー後に差分が増えたら再走査する。

公開 CI は署名・公証・本番配布を起動しない。CI が通っても配布の承認にはならない。

## 報告と記録

公開 Issue・PR には検出件数、分類、影響範囲、修正 commit だけを書く。secret の値、検出行の原文、private URL、実画像やログを貼らない。脆弱性は公開 Issue にせず、[GitHub の非公開報告窓口](https://github.com/niho-life/niho-photo/security/advisories)を使う。窓口を利用できない場合も公開Issueへ投稿せず、メンテナーへ非公開で連絡する。監査の元レポートは非公開環境で保持し、公開側には値を除いた [検出台帳](gitleaks-findings.csv) だけ置く。

## Docs / Photo 共通contract

[Docs #15](https://github.com/niho-coliving/niho-docs/issues/15) を共通仕様の起点とし、Docs正本の [`packages/niho-cloud-contract`](https://github.com/niho-coliving/niho-docs/tree/main/packages/niho-cloud-contract) と [`cloud-contract-v1.md`](cloud-contract-v1.md) を完全な40桁SHAで固定して取り込む。Photo側の `packages/niho-cloud-contract` は型、mock、負例vector、test-only reference modelを同一byte列で保ち、`docs/security/cloud-contract-source.json` と Publication manifest の双方で出典SHA・各ファイルhashを記録する。CIは公開Docsを資格情報なしで取得し、固定SHAと全対象ファイルのhash一致を検証する。契約変更はDocsを先に更新し、Photoを同じSHAへ追随させる対応PRを用意する。公開contractとmockはクライアントの合意面・テスト用であり、認証・認可を実行するコードではない。

## 公式SDKをRelease tarから使う依存

通常の依存は公開npm registryまたは公開workspaceへ限定する。C04の固定SDKだけは、publication policyの `publicSdkDependencies` に登録したconsumer・package名・NIHO公式Release URL・版・source SHA・artifact size/SHA-256・lock SHA-512と、公開baseline proofおよび同一取得物の両digestを記録したreceiptのhashを全て照合する。tar取得時に同じbytesの両digestを確認し、版を更新するときは対応する公開proofとpolicyを同時にレビューする。別consumer、別URL、未固定版、改変hash、認証付き取得やprivate packageへの一般的な許可には使わない。CIのpublication guardとnpm ciによるintegrity確認を維持する。

正式Release tarのSBOMは、取得URLとchecksumを含む[generic PURL](https://github.com/package-url/purl-spec/blob/main/types/generic-definition.json)とdistribution参照・SHA-256で識別する。registry上の別packageと混同せず、公開guardで検証してfreezeした依存proofだけをSBOM生成へ渡す。
