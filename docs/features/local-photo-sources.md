# この Mac の写真ソース

NIHO photo のローカルライブラリは、フォルダと個別に選んだ写真を同じ編集画面で扱います。写真と、その参照を覚える設定は端末を使うローカルユーザーに属します。アカウント、クラウドAPI、アップロードは使いません。

## 画面の動き

「この Mac」の追加メニューには「フォルダを追加」と「写真を選ぶ」があります。写真を選ぶと、実在する対応形式だけが「選んだ写真」に加わります。「選んだ写真」は1枚以上ある間だけフォルダより前に表示されます。一覧、絞り込み、複数選択、グリッド・ルーペ編集、補正、書き出しはフォルダと同じ `entryId` の経路を使います。

初めて使うときは「フォルダや写真を追加すると、ここで編集できます」と2つの操作を表示します。個別写真を扱わない `PhotoLibrary` は従来どおり「フォルダを追加」だけを表示します。

最後に見ていた場所は端末に覚えます。「選んだ写真」が残っていればそこへ戻り、無ければ最後に見た既存フォルダ、最初のフォルダ、空状態の順に戻ります。ダイアログを閉じたときは、場所、選択、通知を変えません。

## `PhotoLibrary` の契約

個別写真に対応するホストは、任意の `selectedPhotos` を実装します。

| 操作 | 契約 |
| --- | --- |
| `selectedPhotos.count(options?)` | 現在表示できる個別写真の数を返す |
| `selectedPhotos.add()` | ネイティブpickerを開き、追加できた一覧行をpicker順で返す。cancelは `[]` |
| `selectedPhotos.forget()` | 個別写真の参照をすべて外す。元ファイル、フォルダ登録、SHA-256に紐づく補正は変更しない |

一覧は `list({ localSource: "selected", ... })` で明示して読みます。`folderId` と `localSource` の同時指定は曖昧なので拒否します。ライブラリ内部の「現在の場所」には依存しません。検索、種類・補正済みの絞り込み、ページングは通常の一覧と同じです。「選んだ写真」では、過去に選んだクラウドの並び設定を適用せず、新しい選択グループを先頭にして各picker内の順を保ちます。同じ実体を選び直すと重複せず先頭へ移ります。

`selectedPhotos` は任意なので、クラウドやフォルダ専用の既存アダプターは変更せず利用できます。

## 永続化と失敗

ネイティブpickerは複数選択で、`packages/desktop-photo/src/capabilities.rs` の能力レジストリから生成した `PHOTO_FILE_EXTENSIONS` だけを候補にします。フォルダ走査の候補とpickerの候補は同じレジストリを使い、大文字・小文字を区別しません。選んだパスはcanonicalizeし、隠しファイル、無いファイル、通常ファイルでないもの、対象外形式を除きます。有効な写真が一部あればそれだけを残します。選択があったのに全て無効なら、パスを含まない日本語のエラーを返します。

一覧走査では全写真をdecodeせず、拡張子とファイルmetadataだけを読みます。写真をopen、thumbnail、metadata読取、原寸renderに使うときは、同じvalidatorが拡張子、magic bytes、対応段階を確認します。macOS ImageIOが実データのUTTypeを返したラスタは申告拡張子とも照合します。JPEG/PNG/HEIC/HEIF/TIFFを装った別形式、RW2を装った別形式、空・短すぎる入力は、処理段階が分かる日本語の失敗になります。未知のRAWをTIFFとして推測しません。

iCloud DriveやFinder連携の同期ストレージで未ダウンロードを示すフラグがあるファイルは、読み始めず `downloadRequired` を返します。読取開始時に同期providerが待機・timeoutを返した場合も同じ扱いにし、Finderでダウンロードしてから再試行するよう案内します。`formatMismatch`、`downloadRequired`、`unsupportedFormat` を含むnativeの `code` と `message` はTS adapterで置き換えず画面へ渡し、パス・ファイル名・個体metadataはログへ残しません。

参照は既存の `RememberedStore` に保存し、既定で最大2,000件です。保存失敗時も、上限内の参照をその起動中に保持し、次の一覧読み直しで失いません。一度の選択で上限を超えた場合も追加APIは有効な写真をすべて返し、後から再表示する参照だけを上限まで残します。元メディアが消えた場合はセッション・保存済みのどちらからも一覧に出しません。

「選んだ写真を一覧から外す」は、永続化の更新に成功してからセッション上の参照を消します。読み書きに失敗した場合は成功扱いにせず参照を残します。プライバシー消去が成功した場合は、永続ストアが無い構成を含めてセッション上の参照も消します。

画面へ返すのは安全なmetadataと不透明な `entryId` だけです。パスやpicker tokenは返さず、ログにも記録しません。

## ネイティブコマンドとE2E

Macアプリの権限 `allow-camera-library` は、次の7コマンドだけを許可します。

- `camera_library_add_folder`
- `camera_library_add_photos`
- `camera_library_remembered`
- `camera_library_selected_photos`（選択写真だけを読み、フォルダ木は再走査しない）
- `camera_library_list_folder`
- `camera_library_forget_folder`
- `camera_library_forget_photos`

`camera_library_add_photos` はネイティブpickerのcancelを `{ "photos": [] }` で返します。`camera_library_forget_photos` は参照だけを外します。

`e2e` featureのビルドだけは `NIHO_CAMERA_E2E_PICK_PHOTOS` を読み、`std::env::split_paths` で複数のネイティブパスに分けます。変数が無い場合はcancelとして扱います。通常の製品ビルドには環境変数を読む分岐自体がコンパイルされません。

2026-10-20時点の受入状況は次のとおりです。CIで通る合成入力をprovider実機の完了証拠へ読み替えません。

| 経路 | 現状 | 残る制約・実機確認 |
| --- | --- | --- |
| ローカル通常ファイル | 公開macOS CIでメモリ生成したPNG/JPEG/TIFF/HEICをフォルダ追加・個別写真追加の両方からImageIOで検査 | native pickerの複数選択、cancel、対象外混在は署名済みappで未確認 |
| iCloud Drive | dataless/offline flagとtimeoutを `downloadRequired` へ変換する実装、段階別code/messageのunit testまで | 未取得表示、Finderでのダウンロード、再試行復帰を実アカウントで未確認 |
| Google Drive for desktop | 同期providerに依存しないtimeout/error契約まで | provider固有のplaceholder属性、未取得からの復帰、再起動後の参照復元を実機で未確認 |
| 外部メディア | 参照先消失時に一覧から外し、戻れば再表示するfilesystem testまで | SD/USBの取り外し中の画面、再接続、補正保持を署名済みappで未確認 |

公式配布工程で、上表の未確認項目に加え、参照を外した後も元ファイルと補正が残ることを確認します。RAW現像エンジンの実RW2受入は公開CIのdevelop-engine scopeで常時実行し、OSのRAW対応機種全体の保証とは分けます。

## 個人クラウドとの接続境界

公開版の `App` は、trusted host が `cloudBinding` を明示的に注入した場合だけ「クラウド / この Mac」の切り替えと「クラウドにコピー」を表示します。保存先切り替えは編集面の上部に常に表示し、左の場所パネルを隠しても利用できます。binding は本人のクラウド `PhotoLibrary`、`PhotoEditingHost`、`actorId`、`copyLocalPhoto` から成ります。binding が無い、`actorId` が空、または library の `place` が `cloud` でない場合は従来のローカル専用画面のままで、クラウド操作を表示しません。公開版単体の本番接続は無効です。

どちらの保存先も同じ `BrowserPhotoEditingWorkbench` を使います。切り替え時は provider と workbench を作り直し、query と端末内の補正下書きは `personal-user:<actorId>:local|cloud` の本人用 namespace で分けます。この値は従来の prop 名が `spotId` の共有編集面へ渡しますが、拠点 ID や認可証明として扱いません。クラウド側には camera の背景除去 host を渡しません。

コピーは、この Mac で選んだ 1 枚に対する利用者の明示操作だけで、元ファイルをこの Mac から移動・削除しません。React が binding へ渡す写真の情報は不透明な `photoId` のみで、path、bytes、token は渡しません。切り替えとコピー開始は共通の route leave guard を通り、補正の保存または破棄確認が完了できない場合は進みません。コピー中は進捗を表示して二重実行を止め、失敗を成功として扱いません。成功結果に `cloudPhotoId` がある場合だけ「クラウドで開く」を表示します。ログインやアカウント状態の変化からコピーを自動開始しません。本人の写真削除と退会 purge の基盤は既存 private backend にありますが、Photo 製品への実接続・受入は未完了のため、公開UIからのクラウド削除は無効です。

実ファイルの upload、idempotency key、通信中断後の resume、認証・認可、容量制限は private integration の `copyLocalPhoto` 実装の責務です。公開 React 層へこれらの資格情報や転送データを追加しません。個人クラウドの共有リンクは別機能であり、この binding は共有 UI を有効にしません。

本人クラウドの現行製品境界・API対応・5GiB・即時削除・Photo専用Webとwriterは [個人クラウド接続契約](../architecture/personal-photo-cloud.md) とPhoto Epic #192 / #193を正本とします。旧Editor側の配置・ゴミ箱契約は再開しません。
