# Photo / Docs公開アカウントクライアント

NIHO app-connect v1のnative public client。Photoは公開client ID `niho-camera`、Docsは `niho-docs` を使い、client secretを配布しない。公開wire contractに基づく独立再実装で、認証DB、署名鍵、private server実装を含まない。

## 接続フロー

1. 32byte乱数のPKCE verifierと独立したstateを作り、10分間有効なpendingを永続化する。
2. OSの標準ブラウザで `https://niho.life/connect/niho-camera?v=1&challenge=<S256>&state=<random>` を開く。
3. OS deep link `niho-camera://auth?code=<一回限りのコード>&state=<random>` を厳密検証する。scheme/host/path/port/fragment、未知・重複query、不正な文字種を拒否する。state一致後、HTTP交換より先にpendingへ消費済みを保存する。
4. `POST /api/auth/app-connect/exchange` に `clientId/code/codeVerifier/deviceName` を送る。端末名は個人情報を避けて固定表示 `Mac` を使う。
5. NIHO接続refresh tokenを保存し、返されたcustom tokenをGoogle Identity Toolkitの `accounts:signInWithCustomToken` へ交換する。
6. 短期ID tokenをBearer headerで `GET /api/auth/me` へ送り、接続時のuser IDと一致して初めて接続済みにする。JWTをdecodeしてroleやtenantを権限へ変換しない。
7. ID tokenの5分前から `POST /api/auth/app-connect/refresh` をsingle-flightで呼び、新しいNIHO接続tokenをFirebase交換より先に原子的に保存する。Firebase側のrefresh tokenは使用・保存しない。一時失敗は1秒から最大5分のbackoffで再試行する。

本番の宛先はNIHOとGoogleの固定HTTPS。public clientがissuer、JWKS、任意token endpointを設定する経路は持たない。HTTPはnativeに限定し、10秒timeout、64KiB上限、redirect/proxyなし。request/response/error/Debugに実値を出さず、UIへは固定分類のsnapshotだけを渡す。

## 保存と取消

Developer ID署名前は `FileSecretStore` を使う。app data内の新しい `public-account-v2/account-secrets/{pending,refresh-token}` にだけ保存し、旧形式の接続・プロフィール・Keychain項目を読んだり上書きしたりしない。既存の旧接続は一度ログインし直す。以後はこのversioned領域で再起動・更新をまたいで継続する。

保存先directoryは0700、通常ファイルは0600。同じ所有者であること、親のsymlink/他ユーザー書込権限がないことを確認し、fileのsymlink/hardlinkを拒否する。OS directory fdと`openat(O_NOFOLLOW)`を使い、一時ファイルも作成時から0600にしてfsync→同じdirectory fd内rename→directory fsyncで置換する。Keychain adapterも同じ `CredentialStore` 境界に残す。無断fallbackや旧Keychain移行はしない。同じOSユーザーや管理者による読み取りから隔離する方式ではない。

初回接続の取消はpendingと新規接続資格を消し、世代チェックで遅れた応答を保存させない。既存接続がある間の新規ログインはBusyで拒否する。既存接続のrefresh中取消は資格を保持し、自動再試行を止めたオフライン状態にする。明示再試行または次回起動で再接続できる。「このMacからログアウト」は手元の資格を削除し、取得済みID tokenがあればその接続のDELETEも試みる。オフライン等でDELETEできない場合も手元を消し、server全体の失効は意味しない。

exchange成功後、ID token取得済みで初回接続が失敗・取消になった場合は、その接続IDへDELETEで後始末を試みる。成功時は同じ接続の手元資格だけを消し、新しい別接続に触らない。ID tokenを取得できなかった場合や後始末の通信失敗では、serverに接続が残る場合がある。取消/ログアウト済みなら手元資格は消え、再起動で復活しない。初回のFirebase交換がNetwork/Pausedで止まった場合は、保存済みNIHO接続tokenを保持してrestore/明示再試行できる。Rejected・不正response・保存失敗等の恒久的な初回失敗では資格を消し、新しいログインを求める。serverの有効期限・失効処理が最終的に接続を制御する。

refresh保存に失敗したらFirebaseへ進まない。serverの猶予内なら保存済み旧tokenから再試行できるが、失効・再利用拒否になれば資格を消して再ログインを求める。停止スイッチとnetwork/5xxは資格を保持し、失効・アカウント利用不可は破棄する。ローカル写真編集は全状態で利用できる。

## 公開build設定と検証

Firebase Web API keyは公開client設定であり、共通client secretや権限証明ではない。Cameraはbuild時の `NIHO_PHOTO_PUBLIC_FIREBASE_WEB_API_KEY` に公式production projectの公開keyを明示した場合だけ接続を有効化する。宛先や環境はこの値から変更できない。key未設定/不正の公開CI・開発buildはlocal-onlyで起動する。実値をテストfixtureへ入れない。

公開keyの出典は既存NIHO production Webと共通のFirebase projectのWeb API keyで、既存の公式アプリ配布もこの公開設定をbuild環境へ入力している。この公開repoの公式releaseへその値を渡す配布設定はIssue #2の残件であり、このPRで配布設定の接続完了を主張しない。公開CIはkeyなしのunsigned buildを検証する。公式key入りbundleによる本番接続・OS deep linkの実機smokeは未実施で、配布前の必須受入として残る。

```sh
cargo test --locked --manifest-path packages/desktop-account/Cargo.toml
npm run test --workspace packages/desktop-account/ts
node --test scripts/ci/account-contract.test.mjs
```

mockは合成tokenだけを使い、productionでHTTP宛先を有効化するfeatureを用意しない。新しい安全契約の正は [native-account-v2.json](contract/native-account-v2.json)。Rust/TSとPhotoのdigest pinをCIで照合する。Docs側による同じv2の採用、双方CI連動、本番APIと署名済みアプリのE2E受入は別の統合条件である。

## 共有アルバムの native 通信（Epic #240 / B08 #249）

Camera は共有アルバム（`/cloud/sharing/v1`）も本人クラウド v2 と同じ authority で送る（`photo_sharing_request`・`photo_sharing_upload`・`photo_sharing_content`）。宛先は固定の origin と、build の設定で与える上流の prefix（`Config::with_sharing_prefix`。`/api/` で始まる固定の path）だけで、未設定なら `NotConfigured`。画面からは route の表の path・query・body・冪等 key だけを受け、`..`・区切りを復号する segment・BFF だけの経路を拒む。応答の upload の ticket は native に取り出して `https://upload.native.invalid/<handle>` の代わりを返し、ほかに token・URL が残れば拒む。完成写真は ticket の先へ 8MiB ずつ送り、download は宣言の SHA-256・長さ・形式と照合する。
