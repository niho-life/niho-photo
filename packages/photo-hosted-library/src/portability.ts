/**
 * Self-contained export and restore of a hosted Mac library (Epic §11, B01 #242). An export carries schema/engine,
 * full recipes, masks, album definitions, IDs and hashes, never credentials, tickets, sessions, invite secrets or
 * memberships. A restore never downgrades newer NIHO data and never grants access.
 */
import { decideLibraryAccess, findUnexpectedFields } from "../../photo-library-sharing-contract/src/policy.ts";
import type {
  AlbumId,
  Instant,
  LibraryId,
  PhotoId,
  PortableAlbum,
  PortableLibraryManifest,
  PortablePhoto,
  RequestFields,
  RestoreReport,
  SharingErrorCode,
  UserId,
} from "../../photo-library-sharing-contract/src/v1.ts";
import type { ReplicaStore } from "./replica.ts";
import { HostedLibraryError, assertNotAborted, canonicalSha256, isSha256, sha256Hex } from "./shared.ts";

const SOURCE_FIELDS = {
  generation: "value", sha256: "value", sizeBytes: "value", format: "value", width: "value", height: "value",
} as const satisfies RequestFields;
/** The whole manifest is closed: anything else (tokens, URLs, sessions, secrets, members) is rejected. */
export const PORTABLE_MANIFEST_SHAPE = {
  format: "value",
  formatVersion: "value",
  mode: "value",
  library: { fields: { id: "value", kind: "value", metadataRevision: "value" } },
  createdAt: "value",
  engines: { items: "value" },
  photos: {
    items: {
      fields: {
        photoId: "value",
        source: { fields: SOURCE_FIELDS },
        recipe: {
          fields: {
            revision: "value", settings: "open", settingsSha256: "value", baseVersion: "value",
            maskSurfaceIds: { items: "value" }, updatedAt: "value",
          },
        },
        recipeSourceGeneration: "value",
        masks: { items: { fields: { surfaceId: "value", sizeBytes: "value" } } },
        original: { fields: { included: "value", sha256: "value" } },
      },
    },
  },
  albums: {
    items: {
      fields: {
        albumId: "value", name: "value", revision: "value",
        items: {
          items: {
            variants: {
              ownerPhoto: {
                itemId: "value", renditionSha256: "value",
                source: {
                  variants: { libraryPhoto: { libraryId: "value", photoId: "value" }, devicePhoto: { deviceSourceRef: "value" } },
                },
              },
              memberEdit: { itemId: "value", renditionSha256: "value", source: "value" },
              fileUpload: { itemId: "value", renditionSha256: "value", source: "value" },
            },
          },
        },
      },
    },
  },
} as const satisfies RequestFields;

const safe = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Validates an untrusted manifest (closed shape, hashes, unique IDs, references). Throws invalid_request. */
export function parsePortableManifest(value: unknown): PortableLibraryManifest {
  const fail = (): never => { throw new HostedLibraryError("invalid_request"); };
  if (findUnexpectedFields(PORTABLE_MANIFEST_SHAPE, value).length) fail();
  const manifest = value as PortableLibraryManifest;
  if (manifest.format !== "niho-photo-library" || manifest.formatVersion !== 1) fail();
  if (manifest.mode !== "metadata" && manifest.mode !== "full") fail();
  if (!manifest.library || typeof manifest.library.id !== "string" || !safe(manifest.library.metadataRevision)) fail();
  if (manifest.library.kind !== "hostedMac" && manifest.library.kind !== "nihoCloud") fail();
  if (!Array.isArray(manifest.photos) || !Array.isArray(manifest.albums) || !Array.isArray(manifest.engines)) fail();
  const photoIds = new Set<string>();
  for (const photo of manifest.photos) {
    if (typeof photo.photoId !== "string" || photoIds.has(photo.photoId)) fail();
    photoIds.add(photo.photoId);
    if (!safe(photo.source?.generation) || !safe(photo.source.sizeBytes) || !(photo.source.sha256 === null || isSha256(photo.source.sha256))) fail();
    if (!safe(photo.recipe?.revision) || !isSha256(photo.recipe.settingsSha256) || !safe(photo.recipeSourceGeneration)) fail();
    if (photo.recipeSourceGeneration > photo.source.generation) fail();
    if (!Array.isArray(photo.masks) || photo.masks.some((mask) => !isSha256(mask.surfaceId) || !safe(mask.sizeBytes))) fail();
    if (typeof photo.original?.included !== "boolean" || !(photo.original.sha256 === null || isSha256(photo.original.sha256))) fail();
    if (photo.original.included && (manifest.mode !== "full" || photo.original.sha256 === null)) fail();
  }
  const albumIds = new Set<string>();
  for (const album of manifest.albums) {
    if (typeof album.albumId !== "string" || albumIds.has(album.albumId) || typeof album.name !== "string" || !safe(album.revision)) fail();
    albumIds.add(album.albumId);
    // A member's source reference is never part of an export.
    if (album.items.some((item) => item.kind !== "ownerPhoto" && item.source !== null)) fail();
  }
  return manifest;
}

export async function manifestSha256(manifest: PortableLibraryManifest): Promise<string> {
  return canonicalSha256(manifest);
}

/** Metadata export from the replica (references and hashes, no originals). Excluded photos are not exported. */
export async function buildMetadataManifest(input: {
  readonly store: ReplicaStore;
  readonly library: { readonly id: LibraryId };
  readonly createdAt: Instant;
  readonly signal: AbortSignal;
}): Promise<PortableLibraryManifest> {
  const { store, signal } = input;
  const metadataRevision = await store.revision();
  if (metadataRevision === 0) throw new HostedLibraryError("incomplete_replica");
  const masks = new Map<string, { surfaceId: string; sizeBytes: number }[]>();
  for await (const mask of store.records("mask")) {
    const list = masks.get(mask.body.photoId) ?? [];
    list.push({ surfaceId: mask.body.surfaceId, sizeBytes: mask.body.sizeBytes });
    masks.set(mask.body.photoId, list);
  }
  const photos: PortablePhoto[] = [];
  const engines = new Set<string>();
  for await (const photo of store.records("photo")) {
    assertNotAborted(signal);
    if (await store.get("exclusion", photo.id)) continue;
    const recipe = await store.get("recipe", photo.id);
    // Every hosted photo has a recipe in NIHO (revision 0 when unedited); a gap means the replica is incomplete.
    if (!recipe) throw new HostedLibraryError("incomplete_replica");
    engines.add(recipe.body.recipe.settings.engine);
    photos.push({
      photoId: photo.id,
      source: photo.body.source,
      recipe: recipe.body.recipe,
      recipeSourceGeneration: recipe.body.recipeSourceGeneration,
      masks: (masks.get(photo.id) ?? []).sort((a, b) => a.surfaceId.localeCompare(b.surfaceId)),
      original: { included: false, sha256: photo.body.source.sha256 },
    });
  }
  const albums: PortableAlbum[] = [];
  for await (const album of store.records("albumDefinition")) {
    albums.push({
      albumId: album.id,
      name: album.body.name,
      revision: album.body.revision,
      items: album.body.items.map((item) => ({
        itemId: item.itemId,
        kind: "ownerPhoto",
        source: { kind: "libraryPhoto", libraryId: input.library.id, photoId: item.photoId },
        renditionSha256: null,
      })),
    });
  }
  return {
    format: "niho-photo-library",
    formatVersion: 1,
    mode: "metadata",
    library: { id: input.library.id, kind: "hostedMac", metadataRevision },
    createdAt: input.createdAt,
    engines: [...engines].sort(),
    photos,
    albums,
  };
}

export interface ExportSink {
  add(path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
}

/**
 * Full export on the Mac: originals and masks verified against the manifest hashes, then the manifest last.
 * A missing or changed original is reported and marked not included; it is never written as empty or wrong bytes.
 */
export async function buildFullExport(input: {
  readonly manifest: PortableLibraryManifest;
  readonly readOriginal: (photo: PortablePhoto, signal: AbortSignal) => Promise<Uint8Array | null>;
  readonly readMask: (photoId: PhotoId, surfaceId: string, signal: AbortSignal) => Promise<Uint8Array | null>;
  readonly sink: ExportSink;
  readonly signal: AbortSignal;
}): Promise<{ readonly manifest: PortableLibraryManifest; readonly missingOriginals: readonly PhotoId[]; readonly missingMasks: readonly string[] }> {
  const source = parsePortableManifest(input.manifest);
  const { signal, sink } = input;
  const missingOriginals: PhotoId[] = [];
  const missingMasks: string[] = [];
  const written = new Set<string>();
  const photos: PortablePhoto[] = [];
  for (const photo of source.photos) {
    assertNotAborted(signal);
    const expected = photo.source.sha256;
    const bytes = expected === null ? null : await input.readOriginal(photo, signal);
    const ok = expected !== null && bytes !== null && bytes.byteLength === photo.source.sizeBytes && (await sha256Hex(bytes)) === expected;
    if (ok && expected && bytes) {
      if (!written.has(`originals/${expected}`)) {
        await sink.add(`originals/${expected}`, bytes, signal);
        written.add(`originals/${expected}`);
      }
    } else {
      missingOriginals.push(photo.photoId);
    }
    for (const mask of photo.masks) {
      const path = `masks/${mask.surfaceId}.png`;
      if (written.has(path)) continue;
      const maskBytes = await input.readMask(photo.photoId, mask.surfaceId, signal);
      if (maskBytes && maskBytes.byteLength === mask.sizeBytes && (await sha256Hex(maskBytes)) === mask.surfaceId) {
        await sink.add(path, maskBytes, signal);
        written.add(path);
      } else {
        missingMasks.push(mask.surfaceId);
      }
    }
    photos.push({ ...photo, original: { included: ok, sha256: expected } });
  }
  const manifest: PortableLibraryManifest = { ...source, mode: "full", photos };
  await sink.add("manifest.json", new TextEncoder().encode(`${JSON.stringify(manifest)}\n`), signal);
  return { manifest, missingOriginals, missingMasks };
}

/** What NIHO currently holds for the target library; supplied by the canonical side. */
export interface RestoreTargetView {
  photo(photoId: PhotoId): { readonly sourceSha256: string | null; readonly recipeRevision: number } | null;
  album(albumId: AlbumId): { readonly revision: number } | null;
}
export type RestorePhotoAction =
  | { readonly action: "restore"; readonly photo: PortablePhoto; readonly targetPhotoId: PhotoId; readonly expectedRevision: number | null }
  | { readonly action: "keepNewer" | "unchanged"; readonly photoId: PhotoId }
  | { readonly action: "mismatch"; readonly photoId: PhotoId; readonly reason: "hash_mismatch" | "mask_missing" };
export type RestoreAlbumAction =
  /** Album definitions only. Members, invite links and renditions are never restored. */
  | {
      readonly action: "restore";
      readonly album: PortableAlbum;
      readonly targetAlbumId: AlbumId;
      readonly expectedRevision: number | null;
      readonly items: readonly { readonly itemId: string; readonly photoId: PhotoId }[];
    }
  | { readonly action: "keepNewer" | "unchanged"; readonly albumId: AlbumId };
export type RestorePlan =
  | {
      readonly ok: true;
      /** restore: same library, same IDs. import: another library's export; every ID is new and nothing links back. */
      readonly mode: "restore" | "import";
      readonly photos: readonly RestorePhotoAction[];
      readonly albums: readonly RestoreAlbumAction[];
      readonly report: RestoreReport;
    }
  | { readonly ok: false; readonly code: SharingErrorCode };

/**
 * Plans a restore. The target library must be the actor's own. Newer NIHO data is kept (never downgraded), hashes
 * must match, every referenced mask must be in the manifest, and no membership is ever part of the plan.
 */
export function planRestore(input: {
  readonly manifest: PortableLibraryManifest;
  readonly actorId: UserId | null;
  readonly target: { readonly libraryId: LibraryId; readonly ownerId: UserId; readonly lifecycle: "active" | "deleting" } | null;
  readonly current: RestoreTargetView;
  readonly newId: (kind: "photo" | "album" | "item") => string;
}): RestorePlan {
  const access = decideLibraryAccess(input.actorId, input.target && { ownerId: input.target.ownerId, lifecycle: input.target.lifecycle });
  if (!access.ok || !input.target) return { ok: false, code: access.ok ? "not_found" : access.code };
  let manifest: PortableLibraryManifest;
  try { manifest = parsePortableManifest(input.manifest); }
  catch { return { ok: false, code: "invalid_request" }; }
  const mode = manifest.library.id === input.target.libraryId ? "restore" : "import";
  const photoIdMap = new Map<PhotoId, PhotoId>();
  const photos: RestorePhotoAction[] = [];
  const mismatches: { photoId: PhotoId; reason: "hash_mismatch" | "source_missing" | "mask_missing" }[] = [];
  let keptNewer = 0;
  for (const photo of manifest.photos) {
    const masks = new Set(photo.masks.map((mask) => mask.surfaceId));
    if (photo.recipe.maskSurfaceIds.some((id) => !masks.has(id))) {
      photos.push({ action: "mismatch", photoId: photo.photoId, reason: "mask_missing" });
      mismatches.push({ photoId: photo.photoId, reason: "mask_missing" });
      continue;
    }
    if (mode === "import") {
      const targetPhotoId = input.newId("photo");
      photoIdMap.set(photo.photoId, targetPhotoId);
      photos.push({ action: "restore", photo, targetPhotoId, expectedRevision: null });
      continue;
    }
    photoIdMap.set(photo.photoId, photo.photoId);
    const current = input.current.photo(photo.photoId);
    if (!current) {
      photos.push({ action: "restore", photo, targetPhotoId: photo.photoId, expectedRevision: null });
    } else if (current.sourceSha256 !== null && photo.source.sha256 !== null && current.sourceSha256 !== photo.source.sha256) {
      photos.push({ action: "mismatch", photoId: photo.photoId, reason: "hash_mismatch" });
      mismatches.push({ photoId: photo.photoId, reason: "hash_mismatch" });
    } else if (current.recipeRevision > photo.recipe.revision) {
      photos.push({ action: "keepNewer", photoId: photo.photoId });
      keptNewer++;
    } else if (current.recipeRevision === photo.recipe.revision) {
      photos.push({ action: "unchanged", photoId: photo.photoId });
    } else {
      // NIHO lost revisions: restore through CAS on the current revision, never a blind overwrite.
      photos.push({ action: "restore", photo, targetPhotoId: photo.photoId, expectedRevision: current.recipeRevision });
    }
  }
  const albums: RestoreAlbumAction[] = [];
  for (const album of manifest.albums) {
    const items = album.items.flatMap((item) => {
      const photoId = item.source?.kind === "libraryPhoto" && item.source.libraryId === manifest.library.id
        ? photoIdMap.get(item.source.photoId)
        : undefined;
      return photoId ? [{ itemId: mode === "import" ? input.newId("item") : item.itemId, photoId }] : [];
    });
    if (mode === "import") {
      albums.push({ action: "restore", album, targetAlbumId: input.newId("album"), expectedRevision: null, items });
      continue;
    }
    const current = input.current.album(album.albumId);
    if (!current) albums.push({ action: "restore", album, targetAlbumId: album.albumId, expectedRevision: null, items });
    else if (current.revision > album.revision) {
      albums.push({ action: "keepNewer", albumId: album.albumId });
      keptNewer++;
    } else if (current.revision === album.revision) albums.push({ action: "unchanged", albumId: album.albumId });
    else albums.push({ action: "restore", album, targetAlbumId: album.albumId, expectedRevision: current.revision, items });
  }
  return {
    ok: true,
    mode,
    photos,
    albums,
    report: {
      libraryId: input.target.libraryId,
      restoredPhotos: photos.filter((photo) => photo.action === "restore").length,
      restoredAlbums: albums.filter((album) => album.action === "restore").length,
      keptNewer,
      membershipsRestored: 0,
      mismatches,
    },
  };
}

