/**
 * The shared-album screens' port (B08 #249) on top of the membership (B05) and album item (B12) actions. Contract
 * values are mapped to the B08 view-models here; idempotency keys, replays, invite secrets and thumbnail object URLs
 * stay on this side and never reach the components.
 *
 * - Roles, item kinds/states, pending reasons and storage vocabularies are the contract's; a compile-time check below
 *   keeps the view-model unions equal to them.
 * - Operations follow the server's permission table (`Album.access.permissions`), not a local role table.
 * - Thumbnails are the rendition thumbnails, read through the album client and shown as object URLs that are released
 *   on `dispose` (scope or actor change) and when the cache is full.
 * - `isNew` marks items that appeared after this session first saw the album (added by someone else).
 */
import type {
  PhotoHostedMacStatus,
  PhotoSharedAlbum,
  PhotoSharedAlbumCapacity,
  PhotoSharedAlbumInviteLink,
  PhotoSharedAlbumItem,
  PhotoSharedAlbumItemKind,
  PhotoSharedAlbumItemState,
  PhotoSharedAlbumMember,
  PhotoSharedAlbumMemberRole,
  PhotoSharedAlbumPendingReason,
  PhotoSharedAlbumRole,
  PhotoSharedAlbumSummary,
  PhotoSharedAlbumUploadReason,
  PhotoStorageLocation,
  PhotoStorageLocationKind,
} from "niho-photo-editing/shared-album/photo-shared-album-model";
import type { PhotoSharedAlbumPermissions, PhotoSharedAlbumPort } from "niho-photo-editing/shared-album/photo-shared-album-port";

import { readJpegCaptureFields } from "../render-executor/jpeg-metadata";
import { createTicketUploader } from "../render-executor/ticket-upload";
import type { PersonalPhotoCloudIdentity } from "../types";

import { createBrowserSharedAlbumClient } from "./album-client";
import {
  SharedAlbumFileError,
  createSharedAlbumItems,
  prepareAlbumFile,
  type PreparedAlbumFile,
  type SharedAlbumItems,
  type SharedAlbumItemsTransport,
} from "./album-items";
import {
  SHARING_LIMITS,
  sanitizeRenditionMetadata,
  type Album,
  type AlbumItem,
  type AlbumItemKind,
  type AlbumItemPendingReason,
  type AlbumItemState,
  type AlbumRole,
  type HostConnectorState,
  type InviteLink,
  type LibraryKind,
  type MemberRole,
  type Membership,
} from "./contract";
import { createBrowserSharedAlbumMembershipClient } from "./membership-client";
import { createSharedAlbumMembership, type SharedAlbumMembership } from "./membership";
import { isSharingErrorEnvelope } from "./membership-wire";

// The view-model vocabularies are the contract's (B08 kept them as literal unions so the components need no contract
// dependency). A change on either side fails this check.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const VOCABULARY_MATCHES: readonly [
  Same<PhotoSharedAlbumRole, AlbumRole>,
  Same<PhotoSharedAlbumMemberRole, MemberRole>,
  Same<PhotoSharedAlbumItemKind, AlbumItemKind>,
  Same<PhotoSharedAlbumItemState, AlbumItemState>,
  Same<PhotoSharedAlbumPendingReason, AlbumItemPendingReason>,
  Same<PhotoStorageLocationKind, LibraryKind>,
  Same<PhotoHostedMacStatus, HostConnectorState>,
] = [true, true, true, true, true, true, true];
void VOCABULARY_MATCHES;

export interface CreateSharedAlbumScreensPortOptions {
  readonly items: SharedAlbumItems;
  readonly membership: SharedAlbumMembership;
  /** Reads rendition thumbnails (the album client's `download`). */
  readonly download: SharedAlbumItemsTransport["download"];
  /** The link a member opens; it carries the secret outside the HTTP request (e.g. in the URL fragment). */
  readonly inviteUrl: (secret: string) => string;
  /** Hands a saved full-size photo to the device (download, share sheet, native save). */
  readonly saveFile: (name: string, file: Blob, signal: AbortSignal) => Promise<void>;
  /** Turns a picked file into an upload (default: `prepareAlbumFile` on its bytes). */
  readonly prepareFile?: (file: File) => Promise<PreparedAlbumFile>;
  /** The storage locations shown in the settings (default: NIHO cloud only). */
  readonly storageLocations?: (signal: AbortSignal) => Promise<readonly PhotoStorageLocation[]>;
  /** Whether the "originals stay on this device" note was shown (default: this session only). */
  readonly originalsNote?: { readonly shown: () => boolean; readonly markShown: () => void };
  readonly objectUrls?: { readonly create: (blob: Blob) => string; readonly revoke: (url: string) => void };
}

const MAX_THUMBNAILS = 400;
const THUMBNAIL_CONCURRENCY = 6;
const MAX_ITEM_PAGES = 20;

// ---------------------------------------------------------------------------------------------------------
// Contract → view-model

export function sharedAlbumPermissionsView(album: Album): PhotoSharedAlbumPermissions {
  const permissions = album.access.permissions;
  return {
    addItem: permissions.addItem,
    removeOwnItem: permissions.removeOwnItem,
    removeOthersItem: permissions.removeOthersItem,
    manageInvites: permissions.manageInvites,
    leave: permissions.leave,
    download: permissions.download,
  };
}

export function sharedAlbumSummaryView(album: Album, memberCount: number, coverUrl: string | null): PhotoSharedAlbumSummary {
  const preparation = album.access.preparation;
  return {
    albumId: album.id,
    name: album.name,
    role: album.access.role,
    // People are labels only; the owner never has an ID on this side.
    owner: { userId: `owner:${album.id}`, displayName: album.owner.displayName, isSelf: album.owner.isSelf },
    memberCount,
    itemCount: album.itemCount,
    coverUrl,
    preparing: preparation ? { done: preparation.prepared, total: preparation.total } : null,
  };
}

export function sharedAlbumView(
  album: Album,
  details: { readonly memberCount: number; readonly coverUrl: string | null; readonly capacity: PhotoSharedAlbumCapacity; readonly accessEnded?: boolean },
): PhotoSharedAlbum {
  return { ...sharedAlbumSummaryView(album, details.memberCount, details.coverUrl), capacity: details.capacity, accessEnded: details.accessEnded ?? false };
}

export function sharedAlbumItemView(item: AlbumItem, thumbnailUrl: string | null, isNew: boolean): PhotoSharedAlbumItem {
  return {
    itemId: item.id,
    kind: item.kind,
    state: item.state,
    // Only the label and whether it is the viewer; a stable key without any user ID.
    addedBy: { userId: `adder:${item.id}`, displayName: item.addedBy.displayName, isSelf: item.addedBy.isSelf },
    thumbnailUrl,
    isNew,
    pendingReason: item.state === "preparing" || item.state === "updatePending" ? item.pendingReason : null,
  };
}

export function sharedAlbumMemberView(membership: Membership): PhotoSharedAlbumMember {
  return { userId: membership.id, displayName: membership.member.displayName, isSelf: membership.member.isSelf, role: membership.role };
}

export function sharedAlbumInviteLinkView(link: InviteLink): PhotoSharedAlbumInviteLink {
  return { linkId: link.id, role: link.role, expiresAt: link.expiresAt, revoked: link.revoked };
}

// ---------------------------------------------------------------------------------------------------------

export function createSharedAlbumScreensPort(options: CreateSharedAlbumScreensPortOptions): PhotoSharedAlbumPort {
  const lifetime = new AbortController();
  const objectUrls = options.objectUrls ?? { create: (blob: Blob) => URL.createObjectURL(blob), revoke: (url: string) => URL.revokeObjectURL(url) };
  const prepareFile = options.prepareFile ?? (async (file: File) => prepareAlbumFile(new Uint8Array(await file.arrayBuffer())));
  let noteShown = false;
  const originalsNote = options.originalsNote ?? { shown: () => noteShown, markShown: () => { noteShown = true; } };
  const thumbnails = new Map<string, Promise<string | null>>();
  const seen = new Map<string, Set<string>>();
  const newMarks = new Map<string, Set<string>>();
  const loadedItems = new Map<string, readonly AlbumItem[]>();
  const memberRevisions = new Map<string, number>();
  /** Albums this member was told are full (members get no numbers; Epic §3). */
  const fullAlbums = new Set<string>();
  // Older Safari has no AbortSignal.any; there the browser clients' own dispose ends in-flight calls with the port.
  const live = (signal: AbortSignal): AbortSignal =>
    typeof AbortSignal.any === "function" ? AbortSignal.any([signal, lifetime.signal]) : signal;

  function thumbnail(albumId: string, itemId: string, renditionId: string, signal: AbortSignal): Promise<string | null> {
    const cached = thumbnails.get(renditionId);
    if (cached) return cached;
    const loading = (async () => {
      try {
        const content = await options.download({ albumId, itemId, renditionId, variant: "thumbnail" }, live(signal));
        const blob = await new Response(content.body).blob();
        if (lifetime.signal.aborted) return null;
        return objectUrls.create(blob.type === "" ? new Blob([blob], { type: content.contentType }) : blob);
      } catch {
        thumbnails.delete(renditionId);
        return null;
      }
    })();
    thumbnails.set(renditionId, loading);
    while (thumbnails.size > MAX_THUMBNAILS) {
      const [oldest, url] = thumbnails.entries().next().value as [string, Promise<string | null>];
      thumbnails.delete(oldest);
      void url.then((value) => { if (value) objectUrls.revoke(value); });
    }
    return loading;
  }

  async function memberCount(albumId: string, signal: AbortSignal): Promise<number> {
    try {
      const page = await options.membership.listMembers(albumId, { limit: SHARING_LIMITS.memberListMaxCount }, live(signal));
      return page.items.length;
    } catch {
      return 0;
    }
  }

  async function capacityOf(album: Album, signal: AbortSignal): Promise<PhotoSharedAlbumCapacity> {
    if (album.access.role === "owner") {
      try {
        const storage = await options.items.storage(live(signal));
        if (storage.availableBytes <= 0) return { state: "full", ownerUsage: { usedBytes: storage.usedBytes, quotaBytes: storage.quotaBytes } };
      } catch {
        // Unknown usage is not "full".
      }
      return { state: "available" };
    }
    return fullAlbums.has(album.id) ? { state: "full", ownerUsage: null } : { state: "available" };
  }

  async function allItems(albumId: string, signal: AbortSignal): Promise<AlbumItem[]> {
    const items: AlbumItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_ITEM_PAGES; page += 1) {
      const result = await options.items.listItems(albumId, cursor === undefined ? {} : { cursor }, live(signal));
      items.push(...result.items);
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    return items;
  }

  async function mapLimited<T, R>(values: readonly T[], run: (value: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(values.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(THUMBNAIL_CONCURRENCY, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await run(values[index] as T);
      }
    }));
    return results;
  }

  const gone = (error: unknown): boolean => isSharingErrorEnvelope(error) && (error.error.code === "not_found" || error.error.code === "role_forbidden");

  return {
    async listAlbums(signal) {
      const page = await options.items.listAlbums({ limit: SHARING_LIMITS.listMaxCount }, live(signal));
      return await Promise.all(page.items.map(async (album) => {
        const [count, cover] = await Promise.all([
          memberCount(album.id, signal),
          album.cover ? thumbnail(album.id, album.cover.itemId, album.cover.renditionId, signal) : Promise.resolve(null),
        ]);
        return sharedAlbumSummaryView(album, count, cover);
      }));
    },
    async createAlbum(name, signal) {
      return (await options.items.createAlbum(name, live(signal))).id;
    },
    async openAlbum(albumId, signal) {
      let album: Album;
      let items: AlbumItem[];
      try {
        [album, items] = await Promise.all([options.items.getAlbum(albumId, live(signal)), allItems(albumId, signal)]);
      } catch (error) {
        if (gone(error)) {
          loadedItems.delete(albumId);
          return null;
        }
        throw error;
      }
      loadedItems.set(albumId, items);
      const known = seen.get(albumId);
      const marks = newMarks.get(albumId) ?? new Set<string>();
      for (const item of items) {
        if (known && !known.has(item.id) && !item.addedBy.isSelf) marks.add(item.id);
      }
      seen.set(albumId, new Set([...(known ?? []), ...items.map((item) => item.id)]));
      newMarks.set(albumId, marks);
      const [count, capacity, thumbs] = await Promise.all([
        memberCount(albumId, signal),
        capacityOf(album, signal),
        mapLimited(items, (item) => (item.rendition ? thumbnail(albumId, item.id, item.rendition.id, signal) : Promise.resolve(null))),
      ]);
      const cover = album.cover ? await thumbnail(albumId, album.cover.itemId, album.cover.renditionId, signal) : null;
      return {
        album: sharedAlbumView(album, { memberCount: count, coverUrl: cover, capacity }),
        items: items.map((item, index) => sharedAlbumItemView(item, thumbs[index] ?? null, marks.has(item.id))),
        permissions: sharedAlbumPermissionsView(album),
      };
    },
    async people(albumId, signal) {
      const page = await options.membership.listMembers(albumId, { limit: SHARING_LIMITS.memberListMaxCount }, live(signal));
      for (const membership of page.items) memberRevisions.set(membership.id, membership.revision);
      const owner = page.items.some((membership) => membership.member.isSelf && membership.role === "owner");
      const links = owner ? (await options.membership.listInvites(albumId, live(signal))).links : [];
      return { members: page.items.map(sharedAlbumMemberView), inviteLinks: links.map(sharedAlbumInviteLinkView) };
    },
    async copyInviteLink(albumId, role, signal) {
      return options.inviteUrl((await options.membership.ensureInvite(albumId, role, live(signal))).secret);
    },
    async revokeInviteLink(albumId, linkId, signal) {
      await options.membership.revokeInvite(albumId, linkId, live(signal));
    },
    async changeRole(albumId, memberId, role, signal) {
      let revision = memberRevisions.get(memberId);
      if (revision === undefined) {
        const page = await options.membership.listMembers(albumId, { limit: SHARING_LIMITS.memberListMaxCount }, live(signal));
        revision = page.items.find((membership) => membership.id === memberId)?.revision;
      }
      if (revision === undefined) throw new Error("member not found");
      const changed = await options.membership.changeRole(albumId, memberId, revision, role, live(signal));
      memberRevisions.set(changed.id, changed.revision);
    },
    async removeMember(albumId, memberId, signal) {
      await options.membership.removeMember(albumId, memberId, live(signal));
    },
    async leave(albumId, signal) {
      await options.membership.leave(albumId, live(signal));
    },
    async addFile(albumId, file, signal) {
      let prepared: PreparedAlbumFile;
      try {
        prepared = await prepareFile(file);
      } catch (error) {
        if (error instanceof SharedAlbumFileError) return { ok: false, reason: fileReason(error) };
        throw error;
      }
      try {
        await options.items.addFile(albumId, prepared, live(signal));
        return { ok: true };
      } catch (error) {
        if (!isSharingErrorEnvelope(error)) return { ok: false, reason: null };
        const code = error.error.code;
        if (code === "quota_exceeded") {
          fullAlbums.add(albumId);
          return { ok: false, reason: "albumFull" };
        }
        if (code === "not_found" || code === "role_forbidden" || code === "item_removed") return { ok: false, reason: "accessEnded" };
        if (code === "content_rejected" || code === "unsupported_format") return { ok: false, reason: "unsupported" };
        return { ok: false, reason: null };
      }
    },
    async save(albumId, itemIds, signal) {
      const wanted = new Set(itemIds);
      const items = (loadedItems.get(albumId) ?? []).filter((item) => wanted.has(item.id));
      const results = await options.items.saveItems(albumId, items, async (item, content) => {
        const blob = await new Response(content.body).blob();
        await options.saveFile(savedFileName(item, items.indexOf(item)), new Blob([blob], { type: "image/jpeg" }), live(signal));
      }, live(signal));
      return { failed: results.filter((result) => !result.ok).length + (itemIds.length - items.length) };
    },
    async remove(albumId, itemIds, signal) {
      const results = await options.items.removeItems(albumId, itemIds, live(signal));
      return { failed: results.filter((result) => !result.ok).length };
    },
    async join(secret, signal) {
      try {
        const result = await options.membership.join(secret, live(signal));
        return { kind: "joined", albumId: result.album.id };
      } catch (error) {
        if (isSharingErrorEnvelope(error)) return { kind: "unavailable" };
        throw error;
      }
    },
    async storageLocations(signal) {
      if (options.storageLocations) return await options.storageLocations(live(signal));
      return [{ locationId: "nihoCloud", kind: "nihoCloud", name: null, hostedMacStatus: null, usage: null }];
    },
    originalsNoteShown: () => originalsNote.shown(),
    markOriginalsNoteShown: () => originalsNote.markShown(),
    dispose() {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      for (const url of thumbnails.values()) void url.then((value) => { if (value) objectUrls.revoke(value); });
      thumbnails.clear();
      options.membership.forgetSecrets();
    },
  };
}

function fileReason(error: SharedAlbumFileError): PhotoSharedAlbumUploadReason {
  return error.problem === "tooLarge" || error.problem === "tooManyPixels" ? "tooLarge" : "unsupported";
}

/** `NIHO-20261101-093000.jpg` from the capture time, else `NIHO-<n>.jpg`. No names or IDs. */
function savedFileName(item: AlbumItem, index: number): string {
  const capturedAt = item.rendition?.metadata.capturedAt;
  if (capturedAt) return `NIHO-${capturedAt.replace(/[-:]/gu, "").replace("T", "-")}.jpg`;
  return `NIHO-${index + 1}.jpg`;
}

// ---------------------------------------------------------------------------------------------------------
// Browser composition

export interface CreateBrowserSharedAlbumScreensPortOptions {
  readonly identity: PersonalPhotoCloudIdentity;
  readonly fetch?: typeof fetch;
  /** Fetch for the upload provider (default: global fetch). */
  readonly providerFetch?: typeof fetch;
  readonly inviteUrl: (secret: string) => string;
  readonly saveFile: (name: string, file: Blob, signal: AbortSignal) => Promise<void>;
  readonly storageLocations?: (signal: AbortSignal) => Promise<readonly PhotoStorageLocation[]>;
  readonly originalsNote?: { readonly shown: () => boolean; readonly markShown: () => void };
  readonly now?: () => number;
}

/** The port for a signed-in browser session: B05/B12 clients on the route table, the trusted ticket uploader. */
export function createBrowserSharedAlbumScreensPort(options: CreateBrowserSharedAlbumScreensPortOptions): PhotoSharedAlbumPort {
  const clientOptions = { identity: options.identity, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.now ? { now: options.now } : {}) };
  const albumClient = createBrowserSharedAlbumClient(clientOptions);
  const membershipClient = createBrowserSharedAlbumMembershipClient(clientOptions);
  const port = createSharedAlbumScreensPort({
    items: createSharedAlbumItems({ client: albumClient, uploader: createTicketUploader(options.providerFetch ? { fetch: options.providerFetch } : {}) }),
    membership: createSharedAlbumMembership({ client: membershipClient }),
    download: (request, signal) => albumClient.download(request, signal),
    inviteUrl: options.inviteUrl,
    saveFile: options.saveFile,
    prepareFile: prepareBrowserAlbumFile,
    ...(options.storageLocations ? { storageLocations: options.storageLocations } : {}),
    ...(options.originalsNote ? { originalsNote: options.originalsNote } : {}),
  });
  return {
    ...port,
    dispose() {
      port.dispose();
      albumClient.dispose();
      membershipClient.dispose();
    },
  };
}

/**
 * A picked file as an album upload. An upright JPEG is sent as is, cleaned of metadata on this device. A JPEG that
 * relies on its orientation tag (most iPhone portraits) and other formats the browser decodes (HEIC on Safari, PNG)
 * are re-encoded upright as JPEG, keeping only the capture time of a JPEG source.
 */
export async function prepareBrowserAlbumFile(file: File): Promise<PreparedAlbumFile> {
  if (file.size > SHARING_LIMITS.fileUploadMaxBytes) throw new SharedAlbumFileError("tooLarge");
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return prepareAlbumFile(bytes);
  } catch (error) {
    if (!(error instanceof SharedAlbumFileError) || (error.problem !== "notUpright" && error.problem !== "notJpeg")) throw error;
  }
  const capture = readJpegCaptureFields(bytes);
  const upright = await reencodeUpright(file);
  if (!upright) throw new SharedAlbumFileError("notJpeg");
  const prepared = prepareAlbumFile(upright);
  const metadata = sanitizeRenditionMetadata({ capturedAt: capture?.capturedAt ?? null, capturedAtOffset: capture?.capturedAtOffset ?? null, colorProfile: "sRGB" });
  return { bytes: prepared.bytes, rendition: { ...prepared.rendition, metadata } };
}

async function reencodeUpright(file: File): Promise<Uint8Array | null> {
  if (typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null;
  }
  try {
    if (bitmap.width * bitmap.height > SHARING_LIMITS.renditionMaxPixels) throw new SharedAlbumFileError("tooManyPixels");
    let blob: Blob | null = null;
    if (typeof OffscreenCanvas === "function") {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
      blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
    } else if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    }
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } finally {
    bitmap.close();
  }
}
