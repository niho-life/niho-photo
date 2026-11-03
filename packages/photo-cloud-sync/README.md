# @niho/photo-cloud-sync

本人写真の recipe を、入力直後の durable draft、固定 idempotency key、exact generation ACK、明示的な競合選択へ接続する共有 core です。

この package は編集 UI、autosaver、認証、API URL、PhotoLibrary の編集 capability を提供しません。認証済み `PersonalPhotoCloudClient` と identity、journal、Web Locks 相当の port を host から受け取ります。

`save(ref)` は `StageRef.committed` が `committed` になってからだけ送信します。`unsaved` と `superseded` は durable ではないため、次段の UI は離脱 guard を維持する必要があります。

結果不明の PUT / conflict resolve は、body と idempotency key を journal に固定したまま保持します。`discard()` と完了 writer の budget 解放は、この結果不明 record を削除しません。再起動後は `reopen(token)` の `pendingResolution` を表示に使い、resolve の再送は `retryResolution()` を使います。通常の `retry()` は pending resolve を PUT に置き換えません。

確定済みの競合は generation ごとに保存した conflict ID / snapshot を使って読み直し、同じ編集を新しい PUT に変換しません。terminal fenceだけが残る writer も `listPending()` から `terminalReason` 付きで見つけられ、再起動後に明示 `discard()` して容量を解放できます。

競合選択は、競合発生時の immutable snapshot と、選択時に読み直した本人 Photo の exact recipe を分けて扱います。`expectedRevision` は選択時の active revision であり、古い `conflict.currentRevision` と一致する必要はありません。journal は選択した full snapshot の proof を固定し、unknown replay の receipt が conflict ID、decision、result revision、recipe body のいずれかを変えた場合は ACK しません。Photo の 404/410 は writer の terminal fence として残し、以後の新しい mutation key を作りません。

別端末が残したserver側の競合も、local stageや新しいPUTを作らず本人の選択を送れます。local起因のgenerationがない選択は、その端末の未同期draftやCAS基準を変更しません。選択結果が不明なら、再起動後も元のintent/key/proofを照合します。
