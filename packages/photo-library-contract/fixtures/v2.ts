import { PHOTO_LIMITS } from "../src/v2.ts";
import type {
  PersonalPhotoLibrary, Photo, PhotoAsset, PhotoErrorEnvelope, PhotoOperationMap, PhotoPage,
  RecipeConflict, RecipeConflictPage, RecipeDocument, Upload, VersionSet,
} from "../src/v2.ts";

/** Synthetic metadata, not decoder fixtures or production authorization evidence. */
export const IDS = {
  userA: "synthetic-user-a",
  userB: "synthetic-user-b",
  library: "11111111-1111-4111-8111-111111111111",
  photo: "22222222-2222-4222-8222-222222222222",
  original: "33333333-3333-4333-8333-333333333333",
  upload: "44444444-4444-4444-8444-444444444444",
  job: "55555555-5555-4555-8555-555555555555",
  thumbnail: "66666666-6666-4666-8666-666666666666",
  preview: "77777777-7777-4777-8777-777777777777",
  mask: "88888888-8888-4888-8888-888888888888",
  recipeConflict: "99999999-9999-4999-8999-999999999999",
} as const;
export const TIME = "2026-11-01T00:00:00.000Z";
export const HASH = {
  original: "a".repeat(64),
  thumbnail: "b".repeat(64),
  preview: "c".repeat(64),
  mask: "d".repeat(64),
  settings: "198b7c25b44f10770c7301d31d8144dfedbb0393288d3555b7ce1d17a35ca62c",
  currentRecipeSettings: "6a02da77857da0d7012bdcdd948ae19829969315b205887cb90133af0f21aaf2",
  conflictSettings: "ef950b5347a361bc08ef0640555e5fec84bebda93e1f756efc542462833c0c27",
  maskedSettings: "9b830e0cee503e719a24750927cad444d306a77524be110dc1a6b9367077beef",
  futureSettings: "795636badeeefeb888808d3b3b57267a87670352528c7c88159f9de4ea94624b",
  manifest: "c3f175559b61ab5823c166abff9361aed9e2c00a1f090fbe665720f879fe321e",
} as const;
export const recipe: RecipeDocument = {
  revision: 0,
  settings: {
    v: 1, engine: "niho-14", look: "niho-standard-1", base: null,
    exposure: 0, contrast: 0, saturation: 0, relativeTemperature: 0, relativeTint: 0,
    whiteBalance: { mode: "asShot" },
  },
  settingsSha256: HASH.settings,
  baseVersion: null,
  maskSurfaceIds: [],
  updatedAt: TIME,
};
export const original: PhotoAsset = {
  id: IDS.original, kind: "original", sha256: HASH.original, sizeBytes: 1024 ** 2,
  contentType: "image/jpeg", width: 3000, height: 2000,
};
export const mask: PhotoAsset = {
  id: IDS.mask, kind: "mask", sha256: HASH.mask, sizeBytes: 4096,
  contentType: "image/png", width: 1024, height: 683,
};
export const thumbnail: PhotoAsset = {
  id: IDS.thumbnail, kind: "thumbnail", sha256: HASH.thumbnail, sizeBytes: 16384,
  contentType: "image/jpeg", width: 512, height: 341,
};
export const preview: PhotoAsset = {
  id: IDS.preview, kind: "preview", sha256: HASH.preview, sizeBytes: 65536,
  contentType: "image/jpeg", width: 1280, height: 853,
};
export const storedPhoto: Photo = {
  id: IDS.photo, libraryId: IDS.library, storageState: "stored", lifecycle: "active",
  fileName: "synthetic-photo.jpg", format: "jpeg", hasEdits: false, addedAt: TIME, capturedAt: null,
  width: 3000, height: 2000, original, recipe,
  media: { state: "processing", jobId: IDS.job },
};
/** Original is durable while a worker job is still waiting to be created from the outbox. */
export const pendingMediaPhoto: Photo = {
  ...storedPhoto, media: { state: "pending" },
};
export const readyPhoto: Photo = {
  ...storedPhoto,
  media: {
    state: "ready", thumbnail, preview, workingCopy: null, recipeRevision: 0,
    rendererManifestSha256: HASH.manifest,
  },
};
export const failedMediaPhoto: Photo = {
  ...storedPhoto, media: { state: "failed", code: "decoder_failed" },
};
export const futureRecipePhoto: Photo = {
  ...readyPhoto, hasEdits: true,
  recipe: {
    ...recipe, revision: 7,
    settingsSha256: HASH.futureSettings,
    settings: { ...recipe.settings, v: 10, engine: "synthetic-future-engine", futureField: { keep: [1, "opaque"] } },
  },
  media: { state: "unsupported", code: "unsupported_settings" },
};
export const library: PersonalPhotoLibrary = {
  contractVersion: 2, id: IDS.library, owner: { type: "user", userId: IDS.userA },
  state: "active", revision: 3, limits: PHOTO_LIMITS,
  usage: {
    quotaBytes: PHOTO_LIMITS.quotaBytes, usedBytes: original.sizeBytes + mask.sizeBytes,
    originalBytes: original.sizeBytes, maskBytes: mask.sizeBytes,
    pendingPurgeBytes: 0, reservedBytes: original.sizeBytes,
    availableBytes: PHOTO_LIMITS.quotaBytes - original.sizeBytes * 2 - mask.sizeBytes,
  },
  capabilities: {
    formats: [
      { format: "jpeg", extensions: ["jpg", "jpeg"], ingest: true, workingCopy: true },
      { format: "png", extensions: ["png"], ingest: true, workingCopy: true },
      { format: "heic", extensions: ["heic"], ingest: true, workingCopy: true },
      { format: "heif", extensions: ["heif"], ingest: true, workingCopy: true },
      { format: "tiff", extensions: ["tif", "tiff"], ingest: false, workingCopy: false },
      { format: "raw", extensions: ["rw2", "dng", "arw", "nef", "cr2", "cr3", "raf", "orf", "pef"], ingest: true, workingCopy: true },
    ],
    renderer: {
      sdkVersion: "0.1.7", crateVersion: "0.27.0", manifestSha256: HASH.manifest,
      settingsVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      engines: ["niho-1", "niho-2", "niho-3", "niho-4", "niho-6", "niho-7", "niho-10", "niho-11", "niho-12", "niho-13", "niho-14"],
      features: ["geometry", "masks"], maskKinds: ["linear", "radial", "brush", "subject", "sky"], maskSurfaces: true,
    },
    edits: true, versions: true, maskSurfaces: true, albums: false, publicSharing: false,
  },
};
export const page: PhotoPage = {
  items: [readyPhoto], nextCursor: null, libraryRevision: library.revision, usage: library.usage,
};
export const emptyLibrary: PersonalPhotoLibrary = {
  ...library, revision: 0,
  usage: {
    quotaBytes: PHOTO_LIMITS.quotaBytes, usedBytes: 0, originalBytes: 0, maskBytes: 0,
    pendingPurgeBytes: 0, reservedBytes: 0, availableBytes: PHOTO_LIMITS.quotaBytes,
  },
};
export const emptyPage: PhotoPage = {
  items: [], nextCursor: null, libraryRevision: 0, usage: emptyLibrary.usage,
};
export const fullLibrary: PersonalPhotoLibrary = {
  ...library,
  usage: {
    ...emptyLibrary.usage, usedBytes: PHOTO_LIMITS.quotaBytes,
    originalBytes: PHOTO_LIMITS.quotaBytes, availableBytes: 0,
  },
};
export const maskedPhoto: Photo = {
  ...storedPhoto, hasEdits: true,
  recipe: {
    ...recipe, revision: 1, maskSurfaceIds: [HASH.mask], settingsSha256: HASH.maskedSettings,
    settings: {
      ...recipe.settings, v: 5,
      masks: [{ id: "synthetic-sky", kind: "sky", surface: { id: HASH.mask, width: mask.width, height: mask.height }, adjust: { exposure: -0.5 } }],
    },
  },
};
export const reservedUpload: Upload = {
  id: IDS.upload, target: { kind: "original", fileName: "synthetic-photo.jpg", format: "jpeg" },
  sizeBytes: original.sizeBytes, sha256: HASH.original, expiresAt: "2026-11-01T00:30:00.000Z",
  state: "reserved", uploadedBytes: 0,
};
export const verifyingUpload: Upload = { ...reservedUpload, state: "verifying", jobId: IDS.job };
export const completedUpload: Upload = {
  ...reservedUpload, state: "stored", result: { kind: "original", photo: storedPhoto },
};
export const versions: VersionSet = { revision: 0, versions: [] };
export const recipeConflict: RecipeConflict = {
  id: IDS.recipeConflict, expectedRevision: 0, currentRevision: 1,
  conflictingRecipe: {
    settings: { ...recipe.settings, exposure: 0.5 }, baseVersion: null,
    settingsSha256: HASH.conflictSettings, maskSurfaceIds: [],
  },
  currentRecipe: {
    ...recipe, revision: 1, settings: { ...recipe.settings, exposure: 0.25 },
    settingsSha256: HASH.currentRecipeSettings,
  },
  createdAt: TIME,
  resolution: null, resolvedAt: null, resultingRevision: null,
};
export const recipeConflictPage: RecipeConflictPage = {
  items: [recipeConflict], nextCursor: null, currentRevision: 1,
};
export const recipeConflictError: PhotoErrorEnvelope = {
  error: {
    code: "revision_conflict", requestId: "synthetic-request", retryable: false,
    currentRevision: 1, conflictId: IDS.recipeConflict,
  },
};
export const adoptedRecipeConflict: RecipeConflict = {
  ...recipeConflict, resolution: "adopt", resolvedAt: TIME, resultingRevision: 2,
};
export const adoptedConflictRecipe: RecipeDocument = {
  ...recipe, revision: 2, settings: recipeConflict.conflictingRecipe.settings,
  settingsSha256: recipeConflict.conflictingRecipe.settingsSha256, updatedAt: TIME,
};

/** Port expectations only, including unimplemented operations. No live API/decoder claims. */
export const responses = {
  "library.get": library,
  "photos.list": page,
  "photos.get": readyPhoto,
  "photos.info": { camera: null, lens: null, iso: null, width: 3000, height: 2000, gps: null },
  "photos.lookup": { matches: [{ sha256: HASH.original, photoId: IDS.photo, recipeRevision: 0 }] },
  "uploads.start": {
    value: {
      kind: "upload", upload: reservedUpload,
      ticket: { url: "https://upload.example.test/synthetic", method: "PUT", headers: {}, expiresAt: "2026-11-01T00:15:00.000Z", resumeOffsetBytes: 0 },
    }, replayed: false,
  },
  "uploads.get": reservedUpload,
  "uploads.renew": {
    upload: reservedUpload,
    ticket: { url: "https://upload.example.test/synthetic-renew", method: "PUT", headers: {}, expiresAt: "2026-11-01T00:15:00.000Z", resumeOffsetBytes: 0 },
  },
  "uploads.complete": { value: completedUpload, replayed: false },
  "uploads.cancel": { value: { ...reservedUpload, state: "cancelled" }, replayed: false },
  "masks.get": mask,
  "recipes.put": { value: { ...storedPhoto, recipe: { ...recipe, revision: 1 } }, replayed: false },
  "versions.get": versions,
  "versions.put": { value: { revision: 1, versions: [] }, replayed: false },
  "recipe-conflicts.list": recipeConflictPage,
  "recipe-conflicts.get": recipeConflict,
  "recipe-conflicts.resolve": {
    value: { conflict: adoptedRecipeConflict, recipe: adoptedConflictRecipe }, replayed: false,
  },
  "media.ensure": { value: storedPhoto.media, replayed: false },
  "photos.delete": { state: "purged" },
} satisfies { readonly [K in Exclude<keyof PhotoOperationMap, "content.get">]: PhotoOperationMap[K]["response"] };
