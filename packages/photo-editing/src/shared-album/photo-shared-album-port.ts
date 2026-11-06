/**
 * 「共有アルバム」の画面が接続側に求める口（Epic #240 B08 #249）。部品と同じ view-model だけを受け渡し、通信・冪等 key・
 * 再送の照合・招待の secret・object URL の寿命は接続側（`@niho/photo-cloud-library/sharing` の `createSharedAlbumScreensPort`）に
 * 閉じる。画面はこの口の結果だけで描き、権限は server が返した表（`permissions`）で操作を出し分ける。
 */

import type {
  PhotoSharedAlbum,
  PhotoSharedAlbumInviteLink,
  PhotoSharedAlbumItem,
  PhotoSharedAlbumMember,
  PhotoSharedAlbumMemberRole,
  PhotoSharedAlbumSummary,
  PhotoSharedAlbumUploadReason,
  PhotoStorageLocation,
} from "./photo-shared-album-model";

/** 見ている人に server が許した操作（B00 `Album.access.permissions` の画面に要る分）。 */
export interface PhotoSharedAlbumPermissions {
  readonly addItem: boolean;
  readonly removeOwnItem: boolean;
  readonly removeOthersItem: boolean;
  readonly manageInvites: boolean;
  readonly leave: boolean;
  readonly download: boolean;
}

export interface PhotoSharedAlbumOpened {
  readonly album: PhotoSharedAlbum;
  readonly items: readonly PhotoSharedAlbumItem[];
  readonly permissions: PhotoSharedAlbumPermissions;
}

export interface PhotoSharedAlbumPeople {
  readonly members: readonly PhotoSharedAlbumMember[];
  /** オーナーだけ。ほかの人には空 */
  readonly inviteLinks: readonly PhotoSharedAlbumInviteLink[];
}

/** 1 枚の追加の結果。足さなかった理由が分かれば `reason`、分からなければ null（再試行できる失敗）。 */
export type PhotoSharedAlbumAddResult = { readonly ok: true } | { readonly ok: false; readonly reason: PhotoSharedAlbumUploadReason | null };

export type PhotoSharedAlbumJoinResult = { readonly kind: "joined"; readonly albumId: string } | { readonly kind: "unavailable" };

export interface PhotoSharedAlbumPort {
  listAlbums(signal: AbortSignal): Promise<readonly PhotoSharedAlbumSummary[]>;
  /** 作ったアルバムの ID */
  createAlbum(name: string, signal: AbortSignal): Promise<string>;
  /** 見られなくなった（共有の解除・メンバーから外れた・削除）なら null */
  openAlbum(albumId: string, signal: AbortSignal): Promise<PhotoSharedAlbumOpened | null>;
  people(albumId: string, signal: AbortSignal): Promise<PhotoSharedAlbumPeople>;
  /** その役割の使えるリンクの URL（このセッションで作った URL があれば返し、無ければ作る） */
  copyInviteLink(albumId: string, role: PhotoSharedAlbumMemberRole, signal: AbortSignal): Promise<string>;
  revokeInviteLink(albumId: string, linkId: string, signal: AbortSignal): Promise<void>;
  changeRole(albumId: string, memberId: string, role: PhotoSharedAlbumMemberRole, signal: AbortSignal): Promise<void>;
  removeMember(albumId: string, memberId: string, signal: AbortSignal): Promise<void>;
  leave(albumId: string, signal: AbortSignal): Promise<void>;
  addFile(albumId: string, file: File, signal: AbortSignal): Promise<PhotoSharedAlbumAddResult>;
  /** 選んだ完成写真を端末に保存する。保存できなかった枚数を返す */
  save(albumId: string, itemIds: readonly string[], signal: AbortSignal): Promise<{ readonly failed: number }>;
  /** 選んだ項目をアルバムから外す。外せなかった枚数を返す */
  remove(albumId: string, itemIds: readonly string[], signal: AbortSignal): Promise<{ readonly failed: number }>;
  /** 招待リンクの secret で参加する（secret は呼び出しの中だけで使い、どこにも残さない） */
  join(secret: string, signal: AbortSignal): Promise<PhotoSharedAlbumJoinResult>;
  storageLocations(signal: AbortSignal): Promise<readonly PhotoStorageLocation[]>;
  /** 初めて追加するときの「元データはこの端末に残ります」を出したか（接続側が覚える） */
  originalsNoteShown(): boolean;
  markOriginalsNoteShown(): void;
  /** 本人・scope が変わったとき。縮小画像の object URL などを解放する */
  dispose(): void;
}
