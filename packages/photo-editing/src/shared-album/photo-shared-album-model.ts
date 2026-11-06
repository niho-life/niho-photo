/**
 * 「写真」「共有アルバム」と保存先の画面部品が読む形（Epic #240 B08 #249）。識別子は公開契約 B00 #241 と同じ語彙にする。
 *
 * - 部品は通信を持たず、この形と callback だけで動く。B00 の型が入ったら、接続側の adapter で B00 の値をこの形へ写す
 * - ここの権限の判定は「出さない操作を決める」ためだけに使う。認可は server が現在の台帳で行い、拒否はその結果として届く
 * - 時刻に依る表示（リンクの残り時間）は `now` を受け取り、描くたびに時計を読まない
 */

import { formatPhotoCloudUsage } from "../photo-library-usage";
import {
  PHOTO_SHARED_ALBUM_COPY,
  PHOTO_SHARED_ALBUM_SHARE_COPY,
  PHOTO_SHARED_ALBUM_UPLOAD_COPY,
  PHOTO_STORAGE_LOCATION_COPY,
} from "../photo-editing-copy";

/** 写真の保存先。標準は NIHO クラウドで、自前サーバー（常設 Mac）は設定から足す。 */
export type PhotoStorageLocationKind = "nihoCloud" | "hostedMac" | "thisMac";
/** 常設 Mac の接続状態。休止中・接続できない間も一覧・補正・共有アルバムは止めない。 */
export type PhotoHostedMacStatus = "online" | "sleeping" | "unreachable";
/** 共有アルバムでの役割（オーナー / 写真を追加できる / 見るだけ）。 */
export type PhotoSharedAlbumRole = "owner" | "contributor" | "viewer";
/** 招待リンクで渡せる役割（オーナーは渡せない）。 */
export type PhotoSharedAlbumMemberRole = Exclude<PhotoSharedAlbumRole, "owner">;
/** アルバムの項目の種類（所有者の写真 / メンバーが補正した写真 / 完成済みのファイル）。 */
export type PhotoSharedAlbumItemKind = "ownerPhoto" | "memberEdit" | "fileUpload";
/** アルバムの項目の状態（準備中 / 公開中 / 更新待ち / 削除）。 */
export type PhotoSharedAlbumItemState = "preparing" | "published" | "updatePending" | "removed";

export const PHOTO_SHARED_ALBUM_MEMBER_ROLES: readonly PhotoSharedAlbumMemberRole[] = ["contributor", "viewer"];

/** 人の表示。`userId` は不透明な ID で画面に出さない。 */
export interface PhotoSharedAlbumPerson {
  readonly userId: string;
  readonly displayName: string;
  /** 見ている本人か（「あなた」と出す） */
  readonly isSelf: boolean;
}

export interface PhotoSharedAlbumMember extends PhotoSharedAlbumPerson {
  readonly role: PhotoSharedAlbumRole;
}

/** 招待リンク。URL そのものは持たず、コピーするときに接続側から受け取る。 */
export interface PhotoSharedAlbumInviteLink {
  readonly linkId: string;
  readonly role: PhotoSharedAlbumMemberRole;
  /** ISO 8601 */
  readonly expiresAt: string;
  readonly revoked: boolean;
}

/** アルバムの 1 項目（完成写真）。元データ・補正値・mask・元のファイル名は持たない。 */
export interface PhotoSharedAlbumItem {
  readonly itemId: string;
  readonly kind: PhotoSharedAlbumItemKind;
  readonly state: PhotoSharedAlbumItemState;
  readonly addedBy: PhotoSharedAlbumPerson;
  /** 完成写真の縮小画像。準備中で、まだ無ければ null */
  readonly thumbnailUrl: string | null;
  /** 本人が前に見たあとに足された（追加者の表示を出す） */
  readonly isNew: boolean;
}

/** アルバムの容量。オーナーにだけ使用量を渡す（メンバーには「いっぱい」だけを伝える）。 */
export type PhotoSharedAlbumCapacity =
  | { readonly state: "available" }
  | { readonly state: "full"; readonly ownerUsage: { readonly usedBytes: number; readonly quotaBytes: number } | null };

/** 「共有アルバム」の一覧の 1 枚。 */
export interface PhotoSharedAlbumSummary {
  readonly albumId: string;
  readonly name: string;
  /** 見ている人の役割 */
  readonly role: PhotoSharedAlbumRole;
  readonly owner: PhotoSharedAlbumPerson;
  readonly memberCount: number;
  readonly itemCount: number;
  readonly coverUrl: string | null;
  /** 初めて共有したときの準備の進み具合（終わったら null） */
  readonly preparing: { readonly done: number; readonly total: number } | null;
}

/** 開いているアルバム。 */
export interface PhotoSharedAlbum extends PhotoSharedAlbumSummary {
  readonly capacity: PhotoSharedAlbumCapacity;
  /** オーナーの写真の完成写真を描く常設 Mac の状態（オーナーにだけ渡す。常設 Mac でなければ null） */
  readonly hostedMacStatus: PhotoHostedMacStatus | null;
  /** 共有の解除・メンバーから外れた。追加中の写真は確定しない */
  readonly accessEnded: boolean;
}

/** 写真の追加の 1 件の段階。結果が分からない間は `checking`（同じ追加を照合する）。 */
export type PhotoSharedAlbumUploadPhase = "waiting" | "sending" | "checking" | "added" | "failed" | "notAdded";
/** 追加しなかった理由（`notAdded`）。 */
export type PhotoSharedAlbumUploadReason = keyof typeof PHOTO_SHARED_ALBUM_UPLOAD_COPY.reasons;

export interface PhotoSharedAlbumUpload {
  readonly uploadId: string;
  /** 本人の端末でのファイル名（本人にだけ見える） */
  readonly name: string;
  readonly previewUrl: string | null;
  readonly phase: PhotoSharedAlbumUploadPhase;
  /** `sending` の送った割合（0〜1。分からなければ null） */
  readonly fraction: number | null;
  /** `notAdded` の理由 */
  readonly reason: PhotoSharedAlbumUploadReason | null;
}

/** 常設 Mac・保存先の 1 行。 */
export interface PhotoStorageLocation {
  readonly locationId: string;
  readonly kind: PhotoStorageLocationKind;
  /** 利用者が付けた名前（自前サーバー）。無ければ種類の名前 */
  readonly name: string | null;
  /** 自前サーバーの接続状態（他の種類は null） */
  readonly hostedMacStatus: PhotoHostedMacStatus | null;
  /** 使用量（NIHO クラウドだけ。分からなければ null） */
  readonly usage: { readonly usedBytes: number; readonly quotaBytes: number } | null;
}

// ---------------------------------------------------------------------------
// 役割と表示

export function photoSharedAlbumRoleLabel(role: PhotoSharedAlbumRole): string {
  return PHOTO_SHARED_ALBUM_COPY.roles[role];
}

export function photoSharedAlbumPersonLabel(person: PhotoSharedAlbumPerson): string {
  return person.isSelf ? PHOTO_SHARED_ALBUM_COPY.you : person.displayName;
}

/** 写真を足せる（オーナーと「写真を追加できる」。解除後は足せない）。 */
export function photoSharedAlbumCanAdd(album: Pick<PhotoSharedAlbum, "role" | "accessEnded">): boolean {
  return album.role !== "viewer" && !album.accessEnded;
}

/** 招待・役割の変更・メンバーを外す（オーナーだけ）。 */
export function photoSharedAlbumCanManageMembers(role: PhotoSharedAlbumRole): boolean {
  return role === "owner";
}

/** 項目をアルバムから外せる（オーナーはどれでも、「写真を追加できる」は自分が足したものだけ）。 */
export function photoSharedAlbumCanRemoveItem(role: PhotoSharedAlbumRole, item: Pick<PhotoSharedAlbumItem, "addedBy">): boolean {
  if (role === "owner") return true;
  return role === "contributor" && item.addedBy.isSelf;
}

/** 完成写真ができていて保存できる（更新待ちの間は直前の完成写真を保存する）。 */
export function photoSharedAlbumItemSavable(item: Pick<PhotoSharedAlbumItem, "state">): boolean {
  return item.state === "published" || item.state === "updatePending";
}

/**
 * 見せる項目。削除した項目は出さない。準備中の項目はオーナーと追加者にだけ見せる（server も同じ範囲で返す。ここでは
 * 混入した古い値を出さないための二重の絞り込み）。
 */
export function visiblePhotoSharedAlbumItems(
  items: readonly PhotoSharedAlbumItem[],
  role: PhotoSharedAlbumRole,
): PhotoSharedAlbumItem[] {
  return items.filter((item) => {
    if (item.state === "removed") return false;
    if (item.state === "preparing") return role === "owner" || item.addedBy.isSelf;
    return true;
  });
}

/** 準備中・更新待ちの項目に出す短い状態（オーナーの写真で常設 Mac が止まっているときは「Mac の起動後に更新」）。 */
export function photoSharedAlbumItemStatus(
  item: Pick<PhotoSharedAlbumItem, "state" | "kind">,
  hostedMacStatus: PhotoHostedMacStatus | null,
): string | null {
  if (item.state !== "preparing" && item.state !== "updatePending") return null;
  if (item.kind === "ownerPhoto" && hostedMacStatus !== null && hostedMacStatus !== "online") {
    return PHOTO_SHARED_ALBUM_COPY.macWaiting;
  }
  return PHOTO_SHARED_ALBUM_COPY.itemStates[item.state];
}

/** タイルの読み上げ名（例「写真 3/24、佐藤さんが追加、新着」）。 */
export function photoSharedAlbumItemLabel(
  item: PhotoSharedAlbumItem,
  position: { index: number; total: number },
  hostedMacStatus: PhotoHostedMacStatus | null,
): string {
  const adder = item.addedBy.isSelf ? PHOTO_SHARED_ALBUM_COPY.you : `${item.addedBy.displayName}さん`;
  const parts = [
    `${PHOTO_SHARED_ALBUM_COPY.photoFallback} ${position.index + 1}/${position.total}`,
    PHOTO_SHARED_ALBUM_COPY.addedBy(adder),
  ];
  const status = photoSharedAlbumItemStatus(item, hostedMacStatus);
  if (status) parts.push(status);
  if (item.isNew) parts.push(PHOTO_SHARED_ALBUM_COPY.newMark);
  return parts.join("、");
}

// ---------------------------------------------------------------------------
// アルバムの状態（できないときだけ短く出す。Epic §12）

export type PhotoSharedAlbumNotice =
  | { readonly kind: "accessEnded"; readonly text: string; readonly actionLabel: string }
  | { readonly kind: "full"; readonly text: string; readonly actionLabel: string | null }
  | { readonly kind: "macWaiting"; readonly text: string }
  | { readonly kind: "preparing"; readonly text: string; readonly fraction: number };

/**
 * アルバムの上に出す 1 行（出さなければ null）。優先は 解除後 > 容量不足 > 常設 Mac の休止 > 準備中。
 * 容量不足はメンバーには「アルバムがいっぱいです」、オーナーには使用量と次の操作を出す。常設 Mac の休止は、オーナーの写真の
 * 完成写真を待っている項目があるときだけ出す（一覧・保存は止めない）。
 */
export function photoSharedAlbumNotice(
  album: PhotoSharedAlbum,
  items: readonly PhotoSharedAlbumItem[],
): PhotoSharedAlbumNotice | null {
  if (album.accessEnded) {
    return { kind: "accessEnded", text: PHOTO_SHARED_ALBUM_COPY.accessEnded, actionLabel: PHOTO_SHARED_ALBUM_COPY.accessEndedAction };
  }
  if (album.capacity.state === "full") {
    if (album.role === "owner") {
      const usage = album.capacity.ownerUsage;
      return {
        kind: "full",
        text: usage ? PHOTO_SHARED_ALBUM_COPY.ownerFull(formatPhotoCloudUsage(usage)) : PHOTO_SHARED_ALBUM_COPY.albumFull,
        actionLabel: PHOTO_SHARED_ALBUM_COPY.ownerFullAction,
      };
    }
    return { kind: "full", text: PHOTO_SHARED_ALBUM_COPY.albumFull, actionLabel: null };
  }
  if (
    album.role === "owner"
    && album.hostedMacStatus !== null
    && album.hostedMacStatus !== "online"
    && items.some((item) => item.kind === "ownerPhoto" && (item.state === "preparing" || item.state === "updatePending"))
  ) {
    return { kind: "macWaiting", text: PHOTO_SHARED_ALBUM_COPY.macWaiting };
  }
  const preparing = album.preparing;
  if (preparing && preparing.total > 0 && preparing.done < preparing.total) {
    const done = Math.max(0, Math.min(preparing.done, preparing.total));
    return { kind: "preparing", text: PHOTO_SHARED_ALBUM_COPY.preparingProgress(done, preparing.total), fraction: done / preparing.total };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 招待リンク

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** 使えるリンクか（無効化・期限切れでない）。 */
export function photoSharedAlbumInviteLinkActive(link: PhotoSharedAlbumInviteLink, now: number): boolean {
  const expiresAt = Date.parse(link.expiresAt);
  return !link.revoked && Number.isFinite(expiresAt) && expiresAt > now;
}

/** その役割で今使えるリンク（いちばん長く使えるもの。無ければ null）。 */
export function activePhotoSharedAlbumInviteLink(
  links: readonly PhotoSharedAlbumInviteLink[],
  role: PhotoSharedAlbumMemberRole,
  now: number,
): PhotoSharedAlbumInviteLink | null {
  let best: PhotoSharedAlbumInviteLink | null = null;
  for (const link of links) {
    if (link.role !== role || !photoSharedAlbumInviteLinkActive(link, now)) continue;
    if (!best || Date.parse(link.expiresAt) > Date.parse(best.expiresAt)) best = link;
  }
  return best;
}

/** 有効期限の短いラベル（「あと7日」「あと5時間」「まもなく期限切れ」。使えなければ null）。 */
export function photoSharedAlbumInviteExpiryLabel(link: PhotoSharedAlbumInviteLink, now: number): string | null {
  if (!photoSharedAlbumInviteLinkActive(link, now)) return null;
  const remaining = Date.parse(link.expiresAt) - now;
  if (remaining >= DAY_MS) return PHOTO_SHARED_ALBUM_SHARE_COPY.expiresInDays(Math.floor(remaining / DAY_MS));
  if (remaining >= HOUR_MS) return PHOTO_SHARED_ALBUM_SHARE_COPY.expiresInHours(Math.floor(remaining / HOUR_MS));
  return PHOTO_SHARED_ALBUM_SHARE_COPY.expiresSoon;
}

// ---------------------------------------------------------------------------
// 追加の進捗

export interface PhotoSharedAlbumUploadSummary {
  readonly total: number;
  /** 終わった件数（追加済み・追加しなかった・失敗） */
  readonly settled: number;
  readonly added: number;
  /** 追加できなかった件数（失敗と追加しなかったもの） */
  readonly notAdded: number;
  /** まだ動いている（待機・送信・確認） */
  readonly active: boolean;
}

export function summarizePhotoSharedAlbumUploads(uploads: readonly PhotoSharedAlbumUpload[]): PhotoSharedAlbumUploadSummary {
  let added = 0;
  let notAdded = 0;
  for (const upload of uploads) {
    if (upload.phase === "added") added += 1;
    else if (upload.phase === "failed" || upload.phase === "notAdded") notAdded += 1;
  }
  const settled = added + notAdded;
  return { total: uploads.length, settled, added, notAdded, active: settled < uploads.length };
}

/** 進捗の見出しの 1 行（動いている間は「追加中 2/5」、終わったら結果）。 */
export function photoSharedAlbumUploadHeadline(summary: PhotoSharedAlbumUploadSummary): string {
  if (summary.active) return PHOTO_SHARED_ALBUM_UPLOAD_COPY.adding(summary.settled, summary.total);
  if (summary.notAdded > 0) return PHOTO_SHARED_ALBUM_UPLOAD_COPY.someNotAdded(summary.notAdded);
  return PHOTO_SHARED_ALBUM_UPLOAD_COPY.added(summary.added);
}

/** 1 件の状態の短いラベル（送信中で割合が分かるときは帯で見せるので、ラベルは「送信中」のまま）。 */
export function photoSharedAlbumUploadPhaseLabel(upload: Pick<PhotoSharedAlbumUpload, "phase" | "reason">): string {
  if (upload.phase === "notAdded") {
    return upload.reason ? PHOTO_SHARED_ALBUM_UPLOAD_COPY.reasons[upload.reason] : PHOTO_SHARED_ALBUM_UPLOAD_COPY.phases.failed;
  }
  return PHOTO_SHARED_ALBUM_UPLOAD_COPY.phases[upload.phase];
}

// ---------------------------------------------------------------------------
// 保存先

/** 保存先の名前（自前サーバーは付けた名前、無ければ「自前サーバー」）。 */
export function photoStorageLocationName(location: Pick<PhotoStorageLocation, "kind" | "name">): string {
  if (location.kind === "nihoCloud") return PHOTO_STORAGE_LOCATION_COPY.nihoCloud;
  if (location.kind === "thisMac") return PHOTO_STORAGE_LOCATION_COPY.thisMac;
  const name = location.name?.trim();
  return name ? name : PHOTO_STORAGE_LOCATION_COPY.hostedMacFallback;
}

/** 保存先の行の状態（自前サーバーだけ。休止中は「休止中・Mac の起動後に更新」）。 */
export function photoStorageLocationStatus(location: Pick<PhotoStorageLocation, "kind" | "hostedMacStatus">): string | null {
  if (location.kind !== "hostedMac" || location.hostedMacStatus === null) return null;
  const status = PHOTO_STORAGE_LOCATION_COPY.status[location.hostedMacStatus];
  return location.hostedMacStatus === "sleeping" ? `${status}・${PHOTO_STORAGE_LOCATION_COPY.macWaiting}` : status;
}
