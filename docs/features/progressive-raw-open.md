# ローカルRAWの段階open

対象は公開NIHO photoの「このMac」です。クラウドライブラリには追加APIを要求せず、既存の作業コピー経路を使います。

## 編集と保存

`previewOnly → proxyInteractive → canonicalReady` の順に開きます。専用の長辺1600px Quick Look画像を暫定sRGB入力として段2へ渡し、256pxの一覧画像を拡大しません。取得できない・長辺1280px未満・時間切れの場合は従来の正規RAW入力を待ちます。Quick Lookは機種やmacOSによってフルdecodeを起こすため、常に2秒を保証するAPIではありません。

正規入力は従来と同じ2560px・16bit・linear ProPhoto・signed RAWのまま並行生成します。暫定入力は`provisional`で区別し、RAWのbaseVersionを付けません。暫定中は段2の既存Interactive品質で応答を優先し、正規切替時にFinal品質へ戻します。300ms続く待機には「高画質表示を準備中」を表示します。

補正値は暫定段階から編集できます。内容hashに結び付く、設定だけの端末内draftへ直列保存し、写真切替・終了時にflushします。正規入力を実際に開くまで通常保存・画像uploadを行いません。正規入力で最新の画を描き終えた後に、engine・session・canvasをまとめて替えます。未解決のpreset・適用量・hoverは旧engineで確定させてから切り替えます。補正値、preset選択と適用量、crop、undo/redoを保ち、構造metadataだけを正規入力へ結び直します。通常保存が成功した世代に対応するdraftだけを消します。

正規生成の失敗後も暫定編集とdraftを保ち、再読込では正規側だけを再試行します。補正を書き込む書出しは、受け付けたプリセット操作を確定してから編集をロックし、正規入力を待って準備中を表示します。RAW原本のバイトコピーは待ちません。

暫定画像は正規作業コピーと別cache・queueを持ちます。表示対象は古い暫定jobを止めて優先し、同一内容の処理をまとめます。idle先読みは隣接各1枚に限ります。利用者の画像、元の名前、パス、画像由来のhashを公開計測結果へ出しません。

## 検証と性能の読み方

`use-browser-photo-progressive-open.test.tsx` は実hookで、暫定編集、draft、正規切替、preset量、crop、履歴、遅い旧frame、失敗と再試行、写真切替を検査します。`use-browser-photo-export-delete.test.tsx` は実controllerで書出しの待機境界を検査します。ライブラリのテストはnativeキャンセルと内容hashの分離を検査します。

`photoDevelopPerf=1` をcamera rootのURLに付けると、区間だけの診断を明示的に有効化できます。native producer単体の時間とUIの`timeToEditable`は別の測定です。後者はT0から、露光と同梱presetが両方有効な状態で、最初の露光入力が状態へ反映され、変更後canvasが描画されたところまでを測ります。同梱presetも別操作で変更後paintを検証し、別区間として記録します。

集計入口は`node apps/camera/scripts/measure-progressive-open.mjs --case dc-s5=<非公開入力> --probe <実測probe> --probe-arg ... --runs 20`です。probeへ`{input}`、`{cache}`、`{condition}`、`{iteration}`を渡せます。coldは反復ごとにアプリcacheを空にし、warmは保持します。OS file cacheは落としません。probeは渡されたcache領域を実際に使う必要があります。mockの反復やnative producerだけの計測をUIの性能受入値に読み替えません。

プリセット更新（`presetRenderUpdated`）は、押してから変わった画が出るまでの内訳も同じ集計に出します（#126）。`presetResolve`は押してからプリセットを当てた結果が返るまで、`presetRenderQueue`は描画の枠でWorkerへ出すのを待った時間、`presetWorkerWait`はWorkerの列で待った時間、`presetRender`は描画そのもの、`presetThumbnailBlocked`はその間にWorkerが見本を描いていた時間、`presetThumbnailSession`は見本用sessionを作った時間、`presetDeveloperRebuild`は写真を開き直した時間です。`presetThumbnail`は見本1枚の長さ（反復内の中央値）です。どれも`photoDevelopPerf=1`の`[photo-develop-perf]`（Workerの区間と、メインスレッドから見た描画ごとの待ち・往復）と`[photo-develop-ui-perf]`の`presetResolved`から作り、画像・設定は出しません。

MacBook Air M2 / 8GBのcold p50 1秒・p95 2秒、warm p95 500ms、および入力100ms・描画p95 300msが性能受入条件です。Studioの実測はその代替にはしません。実機受入と非公開側のexact SHA取込み・署名・本番配布は別途行います。

## 実UI probeの再現

`e2e` featureのdebug appを、identifier `life.niho.photo.raw-bench`、専用deep-link scheme、ad-hoc署名で作ります。通常の製品identifierではprobeが停止します。段2は公開crateをrelease WASMでbuildし、既存のversioned manifest入口へ配置します。sidecarも公開sourceからbuildします。

`--runtime`には `app`（`.app`）、`apple`（apple-raw-linear）、`render`（niho-develop-render）、`calibration`（校正dir）の4つのローカルパスを持つ非公開JSONを渡します。現行公開checkoutの新規signed RAWだけを試す場合、試験専用校正dirへ公開校正をコピーし、起動probe用`apple-registry.json`にも公開signed registryの内容を配置できます。正規生成は元の`apple-signed-registry.json`を使います。このstagingは旧unsigned recipe復元や配布artifactの検証には使いません。

```sh
node apps/camera/scripts/measure-progressive-open.mjs \
  --case "dc-s5=$RAW_DC_S5" --case "fx30=$RAW_FX30" --case "zv-e10m2=$RAW_ZV_E10M2" \
  --probe python3 --probe-arg apps/camera/scripts/probe-progressive-open.py \
  --probe-arg --runtime --probe-arg "$RUNTIME_JSON" \
  --probe-arg --input --probe-arg '{input}' \
  --probe-arg --cache --probe-arg '{cache}' \
  --probe-arg --condition --probe-arg '{condition}' \
  --probe-arg --iteration --probe-arg '{iteration}' --runs 20
```

probeは写真を1枚だけ選んだ一覧を作り、段2のidle準備後にT0を開始します。露光とpresetが両方有効な状態で、最初の露光入力のstate反映と二度のrAF後の変更画を`editable`とし、presetも別操作で描画を検証します。暫定previewを取得できず正規入力を直接開いた回も除外せず、最初のFinal実paintを正規準備完了として遅い実測値を集計に含めます。warmは各反復で同じアプリ内で正規入力まで計測外で開き、一覧へ戻って同じsessionを再表示します。アプリ再起動後にnative cacheだけを残す条件とは区別します。

専用bundleの設定とWebKit storageは反復ごとに初期化し、native cacheはcoldだけ消します。warmのnative区間も再表示のT0以後だけを集計し、計測外primeを混ぜません。試験専用の`foreground`モードで窓を最前面に保つため、無人の試験Macで実行します。各probeでも一時的なuser-active assertionを作り直します。probe自体は直列です。集計processの実行中だけ`caffeinate`で画面と本体のidle sleepを止め、終了時に解除します。元画像は読み取りだけで、公開出力は許可した時間と検証結果だけです。失敗時のログ・script・reportは渡したcache内でローカルに確認します。
