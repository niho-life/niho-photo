# 第三者の告知

NIHOのproprietary条件は、第三者コード・資産に付属する許諾と利用者の権利を制限しない。

- 現像: [現像エンジンのLICENSES](packages/develop-engine/LICENSES.md)。Adobe DNG SDKの転記箇所と全文、RAW decoder rawlerのLGPL-2.1例外、Cargo.lock固定依存の一覧を記録する。
- UIのNunito: 既存のSIL Open Font License 1.1を同梱する。
- 公開認証: [desktop-accountのLICENSES](packages/desktop-account/LICENSES.md)。PKCE/HTTP/Keychainと合成issuerの依存を記録する。
- Macクライアント: [cameraのLICENSES](apps/camera/LICENSES.md)と[desktop-photoのLICENSES](packages/desktop-photo/LICENSES.md)。

NIHO所有写真・校正・モデルを第三者資産として扱わず、所有宣言と出力hashを資産台帳に記録する。既存DCP8件とLibRaw表、外部ICC、実ユーザー提供素材を移植しない。

## ブラウザ転送の増分SHA-256

`@noble/hashes` 2.4.0（MIT、Copyright (c) 2022 Paul Miller）を依存として固定する。200MiB原本を全量複製せずにhashする用途で使い、配布bundleには次の許諾を含める。upstream: https://github.com/paulmillr/noble-hashes/releases/tag/2.4.0 。

```text
The MIT License (MIT)

Copyright (c) 2022 Paul Miller (https://paulmillr.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

IndexedDB回帰試験だけに `fake-indexeddb` 6.2.7（Apache-2.0）を使う。製品runtimeへはimportしない。依存packageが同梱するLICENSEを維持する。
