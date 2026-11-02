# Photo cloud session consumer

Photo 専用の browser-safe identity/controller と、明示 import する server consumer を提供する。issuer、DB、JWT decode、library bootstrap、UI、native token verifier は含まない。

browser entry `@niho/photo-cloud-session` は安全な metadata だけを扱う。snapshot は UI と非同期処理の fencing 用で、認可証明ではない。Mac public client は `niho-camera` のままにし、共通 bridge は trusted native metadata だけを読む。native token verifier と app bootstrap は別の integration である。server entry `@niho/photo-cloud-session/server` は毎回 producer introspection を行い、credential を HttpOnly cookie と server-only callback に閉じる。

公開 source と public CI の既定 runtime は未設定で 503 になる。本番有効化には、非公開 producer 側で Photo client `niho-photo-web`、audience `niho-photo`、exact origin `https://photo.niho.life`、POST callback `/auth/callback`、安定した server-issued `sessionEpoch` DTO、全 operation path、失効時の commit fence を登録・受入し、feature flag と trusted configuration を同時に渡す必要がある。consumer の合成試験は producer の one-use、DB grace、revoke race、native verifier の受入を意味しない。

## Producer wire contract

endpoint は設定で明示された固定 path だけを使い、既定 endpoint は持たない。callback は producer 側の登録値であり、begin request から選択できない。既存 POST v2 wire は次の閉じた JSON shape を維持する。

| operation | request | success response |
| --- | --- | --- |
| begin | `{clientId:"niho-photo-web",state,codeChallenge,codeChallengeMethod:"S256",protocolVersion:2,responseMode:"form_post"}` | `{attemptId,expiresAt,confirmationPath}` |
| cancel | `{clientId:"niho-photo-web",attemptId,codeVerifier}` | body なし |
| exchange | `{clientId:"niho-photo-web",audience:"niho-photo",attemptId,code,codeVerifier,replaceCredential?}` | credential envelope |
| introspect | `{clientId:"niho-photo-web",audience:"niho-photo",credential}` | identity envelope |
| refresh | `{clientId:"niho-photo-web",audience:"niho-photo",credential}` | credential envelope |
| revoke | `{clientId:"niho-photo-web",audience:"niho-photo",credential}` | body なし |

identity envelope は `{actor:{id},sessionId,sessionEpoch,expiresAt,clientId:"niho-photo-web",audience:"niho-photo",refreshRequired:boolean}`、credential envelope は同じ top-level fields に `credential` を加えたものだけを受ける。`actor.id` は browser metadata の `userId` に写し、`transport` は consumer が trusted constant `browser-session` として付与する。profile/PII claim、欠落した `sessionEpoch`、旧 session fallback は拒否する。

この Photo registration と安定 epoch extension は private producer 側で未実装・未受入であるため、configuration は既定 OFF のままである。attempt replay、PKCE cancel による late exchange revocation、refresh grace、credential revocation、mutation commit fence は producer の責任であり、この package の synthetic stub test はその実装や deployment acceptance を証明しない。Mac の `mac-bearer` verifier と実ブラウザ form POST acceptance も別途必要である。

`provenance.json` は監査した公開 repository の commit、元の repository path、hash だけを記録する。private source は import しない。
