import {
  PHOTO_LIMITS,
  type MediaState,
  type PersonalPhotoLibrary,
  type Photo,
  type PhotoAsset,
  type PhotoByteRange,
  type PhotoContent,
  type PhotoFormat,
  type PhotoListQuery,
  type QuotaUsage,
  type RenderCapability,
  type WorkingCopy,
} from "@niho/photo-personal-cloud-contract";
import { BrowserPhotoSourceError } from "niho-photo-editing/browser-photo-source";
import { PHOTO_EDITING_PERSONAL_CLOUD_COPY } from "niho-photo-editing/photo-editing-copy";
import type {
  PhotoLibrary,
  PhotoLibraryCapabilities,
  PhotoLibraryEditedPreview,
  PhotoLibraryItem,
  PhotoLibraryListPage,
  PhotoLibraryListQuery,
  PhotoLibraryOriginalSource,
  PhotoLibraryPhoto,
  PhotoLibraryPhotoInfo,
  PhotoLibraryRequestOptions,
  PhotoLibraryUsage,
  PhotoLibraryWorkStatus,
  PhotoLibraryWorkingCopyDownload,
  PhotoLibraryWorkingCopyResult,
} from "niho-photo-editing/library/photo-library";

import { contentBytes, readCheckedAsset } from "./content";
import { PersonalPhotoCloudError, isAbortError, personalPhotoCloudErrors, publicError } from "./errors";
import { MaterializationBudget, conservativeBytes, type MemoryLease } from "./memory";
import { PersonalPhotoScope } from "./scope";
import { projectRecipeSettings, rendererIntersection } from "./recipe";
import type {
  CreatePersonalPhotoCloudLibraryOptions,
  PersonalPhotoCloudLibraryHandle,
  PersonalPhotoCloudUrlFactory,
} from "./types";
import {
  validateAsset,
  validateInfo,
  validateLibrary,
  validateLookup,
  validateMediaState,
  validatePage,
  validatePhoto,
  validateRenderer,
  validateUsage,
} from "./validation";

const MAX_URL_ENTRIES = 64;
const MAX_URL_BYTES = 32 * 1024 ** 2;
const MAX_REFS = 256;
const MAX_PHOTO_STATES = 512;

const CLOSED_CAPABILITIES: PhotoLibraryCapabilities = {
  place: "cloud",
  rawWorkingCopy: false,
  nativeExport: false,
  nativeExportUpdateRequired: false,
  exportFolder: false,
  cutout: false,
  favorites: false,
  albums: false,
  articleImages: false,
  multiSelect: false,
  mobile: false,
  editedPreview: false,
  addFiles: false,
  addFromDevice: false,
  addFromDeviceFolder: false,
  info: false,
  versions: false,
};

type AssetRef =
  | { kind: "original"; photoId: string; asset: PhotoAsset; generation: number }
  | { kind: "working-copy"; photoId: string; asset: PhotoAsset; workingCopy: WorkingCopy; generation: number };

type UrlEntry = {
  url: string;
  photoId: string;
  assetKey: string;
  lease: MemoryLease;
  published: boolean;
  claims: Set<PreviewClaim>;
};

type PhotoState = {
  generation: number;
  fingerprint: string | null;
  purged: boolean;
  evicted: boolean;
  activeOperations: number;
  lifecycle: AbortController;
};
type PhotoFence = { state: PhotoState; generation: number };
type PhotoOperationLifetime = {
  fence: PhotoFence;
  signal: AbortSignal;
  assertCurrent(): void;
  release(): void;
};
type PreviewProjection = {
  editedPreview: PhotoLibraryEditedPreview | null;
  leaseKey: string | null;
  claim: PreviewClaim | null;
};
type PreviewClaim = {
  key: string;
  pending: PendingPreview | null;
  entry: UrlEntry | null;
  released: boolean;
};
type PendingPreview = {
  photoId: string;
  controller: AbortController;
  promise: Promise<UrlEntry>;
  claims: Set<PreviewClaim>;
};

export function createPersonalPhotoCloudLibrary(
  options: CreatePersonalPhotoCloudLibraryOptions,
): PersonalPhotoCloudLibraryHandle {
  return new Adapter(options).handle;
}

class Adapter {
  readonly handle: PersonalPhotoCloudLibraryHandle;

  private readonly scope: PersonalPhotoScope;
  private readonly urls: PersonalPhotoCloudUrlFactory;
  private readonly refs = new Map<string, AssetRef>();
  private readonly urlCache = new Map<string, UrlEntry>();
  private readonly pendingPreviews = new Map<string, PendingPreview>();
  private readonly photoStates = new Map<string, PhotoState>();
  private readonly originalMemory: MaterializationBudget;
  private readonly workingCopyMemory: MaterializationBudget;
  private readonly previewMemory: MaterializationBudget;
  private lifecycleVersion = 0;
  private disposed = false;

  constructor(private readonly options: CreatePersonalPhotoCloudLibraryOptions) {
    validateBudgets(options.memoryBudgets);
    validateRenderer(options.hostRenderer);
    this.urls = options.urls ?? defaultUrlFactory();
    this.originalMemory = new MaterializationBudget(options.memoryBudgets.originalBytes);
    this.workingCopyMemory = new MaterializationBudget(options.memoryBudgets.workingCopyBytes);
    this.previewMemory = new MaterializationBudget(Math.min(options.memoryBudgets.previewBytes, MAX_URL_BYTES));
    this.scope = new PersonalPhotoScope(options.client, options.identity, options.clock?.now ?? (() => Date.now()));
    this.scope.onInvalidated(() => this.clearScopedState());

    const library: PhotoLibrary = {
      place: "cloud",
      initialCapabilities: CLOSED_CAPABILITIES,
      capabilities: (requestOptions) => this.capabilities(requestOptions),
      rollout: async (requestOptions) => {
        await this.capabilities(requestOptions);
        return { crop: false, mobileEditing: false };
      },
      engineAssets: options.engineAssets,
      limits: {
        listPageSize: PHOTO_LIMITS.listMaxCount,
        lookupMaxCount: PHOTO_LIMITS.lookupMaxCount,
        referencesMaxCount: PHOTO_LIMITS.lookupMaxCount,
        photosPerRequest: PHOTO_LIMITS.lookupMaxCount,
      },
      errors: personalPhotoCloudErrors,
      list: (query, requestOptions) => this.list(query, requestOptions),
      get: (photoId, requestOptions) => this.get(photoId, requestOptions),
      lookup: (hashes, requestOptions) => this.lookup(hashes, requestOptions),
      info: (photoId, requestOptions) => this.info(photoId, requestOptions),
      openOriginal: (photoId, requestOptions) => this.openOriginal(photoId, requestOptions),
      loadOriginal: (photoId, source, requestOptions) => this.loadOriginal(photoId, source, requestOptions),
      ensureWorkingCopy: (photoId, requestOptions) => this.ensureWorkingCopy(photoId, requestOptions),
      loadWorkingCopy: (photoId, download, requestOptions) => this.loadWorkingCopy(photoId, download, requestOptions),
      retryWorkingCopy: (photoId) => this.retryWorkingCopy(photoId),
      saveDevelopSettings: async () => {
        throw new PersonalPhotoCloudError("unsupported");
      },
      ...(options.maskSurfaceValidator === undefined || options.maskSurfaceReader === undefined ? {} : {
        loadMaskSurface: (photoId: string, surfaceId: string) => options.maskSurfaceReader!.loadMaskSurface(photoId, surfaceId),
      }),
      downloadOriginal: (photo, requestOptions) => this.downloadOriginal(photo, requestOptions),
      delete: (photoIds) => this.deletePhotos(photoIds),
      presets: options.presets,
    };

    this.handle = {
      library,
      usage: (requestOptions) => this.usage(requestOptions),
      rawPhoto: (photoId, requestOptions) => this.rawPhoto(photoId, requestOptions),
      readAsset: (photoId, asset, range, requestOptions) => this.readAsset(photoId, asset, range, requestOptions),
      releasePreviewResources: (photoIds) => this.releasePreviewResources(photoIds),
      dispose: () => this.dispose(),
    };
  }

  private async capabilities(options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryCapabilities> {
    const cloud = await this.loadLibrary(options?.signal);
    const renderer = rendererIntersection(cloud.capabilities.renderer, this.options.hostRenderer);
    const rawWorkingCopy =
      cloud.state === "active" &&
      cloud.capabilities.edits &&
      renderer !== null &&
      cloud.capabilities.formats.some(
        (format) => format.workingCopy && ["raw", "heic", "heif", "tiff"].includes(format.format),
      );
    return { ...CLOSED_CAPABILITIES, rawWorkingCopy, info: cloud.state === "active" };
  }

  private async usage(options?: PhotoLibraryRequestOptions): Promise<QuotaUsage> {
    const cloud = await this.loadLibrary(options?.signal, true);
    return cloud.usage;
  }

  private async list(query: PhotoLibraryListQuery, options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryListPage> {
    const lifecycleVersion = this.lifecycleVersion;
    const cloud = await this.loadLibrary(options?.signal);
    const request = listRequest(query);
    const page = validatePage(
      await this.withScope(options?.signal, (signal) => this.options.client.request("photos.list", request, { signal })),
      this.scope.captured.libraryId,
    );
    this.scope.assertCurrent(options?.signal);
    this.assertLifecycleVersion(lifecycleVersion);
    const previewClaims: PreviewClaim[] = [];
    const operations: PhotoOperationLifetime[] = [];
    try {
      const items: (PhotoLibraryItem & { contentSha256: string })[] = [];
      for (const photo of page.items) {
        this.assertLifecycleVersion(lifecycleVersion);
        const operation = this.beginPhotoOperation(photo.id, options?.signal);
        operations.push(operation);
        this.observePhoto(photo, operation.fence);
        const item = await this.toItem(photo, cloud, operation.fence, operation.signal);
        if (item.claim) previewClaims.push(item.claim);
        operation.assertCurrent();
        items.push(item.item);
      }
      this.scope.assertCurrent(options?.signal);
      this.assertLifecycleVersion(lifecycleVersion);
      for (const operation of operations) operation.assertCurrent();
      this.publishPreviewClaims(previewClaims);
      return { items, next: page.nextCursor, usage: sharedUsage(page.usage), counts: null };
    } catch (error) {
      for (const claim of previewClaims) this.releasePreviewClaim(claim);
      throw error;
    } finally {
      for (const operation of operations) operation.release();
    }
  }

  private async get(photoId: string, options?: PhotoLibraryRequestOptions): Promise<(PhotoLibraryItem & { contentSha256: string }) | null> {
    const operation = this.beginPhotoOperation(photoId, options?.signal);
    let previewClaim: PreviewClaim | null = null;
    try {
      const [photo, cloud] = await Promise.all([
        this.rawPhoto(photoId, { signal: operation.signal }),
        this.loadLibrary(operation.signal),
      ]);
      if (!photo) {
        this.scope.assertCurrent(options?.signal);
        return null;
      }
      const projected = await this.toItem(photo, cloud, operation.fence, operation.signal);
      previewClaim = projected.claim;
      operation.assertCurrent();
      this.publishPreviewClaims(previewClaim ? [previewClaim] : []);
      return projected.item;
    } catch (error) {
      if (error instanceof PersonalPhotoCloudError && error.code === "not_found") return null;
      throw error;
    } finally {
      if (previewClaim) this.releasePreviewClaim(previewClaim);
      operation.release();
    }
  }

  private async lookup(hashes: readonly string[], options?: PhotoLibraryRequestOptions) {
    if (hashes.length > PHOTO_LIMITS.lookupMaxCount || new Set(hashes).size !== hashes.length || !hashes.every(isSha256)) {
      throw new PersonalPhotoCloudError("invalid_response");
    }
    const lifecycleVersion = this.lifecycleVersion;
    const requested = new Set(hashes);
    const [response, cloud] = await Promise.all([
      this.withScope(options?.signal, (signal) =>
        this.options.client.request("photos.lookup", { sha256s: hashes }, { signal }),
      ),
      this.loadLibrary(options?.signal),
    ]);
    this.assertLifecycleVersion(lifecycleVersion);
    const matches = validateLookup(response.matches, requested);
    const result = [];
    for (const match of matches) {
      this.assertLifecycleVersion(lifecycleVersion);
      const photo = await this.rawPhoto(match.photoId, options);
      if (!photo || photo.original.sha256 !== match.sha256 || photo.recipe.revision !== match.recipeRevision) {
        throw new PersonalPhotoCloudError("invalid_response");
      }
      result.push({ contentSha256: match.sha256, photo: this.toPhoto(photo, cloud) });
    }
    this.scope.assertCurrent(options?.signal);
    this.assertLifecycleVersion(lifecycleVersion);
    return result;
  }

  private async info(photoId: string, options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryPhotoInfo | null> {
    assertId(photoId);
    const operation = this.beginPhotoOperation(photoId, options?.signal);
    try {
      const value = validateInfo(
        await this.withScope(operation.signal, (signal) =>
          this.options.client.request("photos.info", { photoId }, { signal }),
        ),
      );
      const result: PhotoLibraryPhotoInfo = {};
      if (value.camera !== undefined) result.camera = value.camera;
      if (value.lens !== undefined) result.lens = value.lens;
      if (value.iso !== undefined) result.iso = value.iso;
      if (value.exposureTimeSeconds !== undefined) result.exposureTimeSeconds = value.exposureTimeSeconds;
      if (value.fNumber !== undefined) result.fNumber = value.fNumber;
      if (value.focalLengthMm !== undefined) result.focalLengthMm = value.focalLengthMm;
      if (value.capturedAt !== undefined) result.capturedAt = value.capturedAt;
      if (value.width !== undefined) result.width = value.width;
      if (value.height !== undefined) result.height = value.height;
      if (value.gps !== undefined) result.gps = value.gps;
      operation.assertCurrent();
      return result;
    } catch (error) {
      if (error instanceof PersonalPhotoCloudError && error.code === "not_found") {
        this.invalidatePhoto(photoId);
        return null;
      }
      throw error;
    } finally {
      operation.release();
    }
  }

  private async rawPhoto(photoId: string, options?: PhotoLibraryRequestOptions): Promise<Photo | null> {
    assertId(photoId);
    this.scope.assertCurrent(options?.signal);
    const operation = this.beginPhotoOperation(photoId, options?.signal);
    try {
      const photo = validatePhoto(
        await this.withScope(operation.signal, (signal) =>
          this.options.client.request("photos.get", { photoId }, { signal }),
        ),
        this.scope.captured.libraryId,
      );
      if (photo.id !== photoId) throw new PersonalPhotoCloudError("invalid_response");
      operation.assertCurrent();
      this.observePhoto(photo, operation.fence);
      operation.assertCurrent();
      return photo;
    } catch (error) {
      if (error instanceof PersonalPhotoCloudError && error.code === "not_found") {
        this.observeNotFound(photoId, operation.fence);
        this.scope.assertCurrent(options?.signal);
        return null;
      }
      throw error;
    } finally {
      operation.release();
    }
  }

  private async readAsset(
    photoId: string,
    asset: PhotoAsset,
    range?: PhotoByteRange,
    options?: PhotoLibraryRequestOptions,
  ): Promise<PhotoContent> {
    assertId(photoId);
    const operation = this.beginPhotoOperation(photoId, options?.signal);
    let handedOff = false;
    try {
      const content = await readCheckedAsset(
        this.options.client,
        this.scope,
        photoId,
        asset,
        range,
        operation.signal,
        operation.release,
      );
      operation.assertCurrent();
      handedOff = true;
      return content;
    } catch (error) {
      if (error instanceof PersonalPhotoCloudError && error.code === "not_found") this.invalidatePhoto(photoId);
      throw error;
    } finally {
      if (!handedOff) operation.release();
    }
  }

  private async openOriginal(photoId: string, options?: PhotoLibraryRequestOptions) {
    return await this.withPhotoOperation(photoId, options?.signal, async (operation) => {
      const [photo, cloud] = await Promise.all([
        this.requirePhoto(photoId, { signal: operation.signal }),
        this.loadLibrary(operation.signal),
      ]);
      if (!projectRecipeSettings(photo, cloud, this.options.hostRenderer, this.bitmapMaskReader())) throw new PersonalPhotoCloudError("unsupported");
      operation.assertCurrent();
      const source = this.issueRef({
        kind: "original",
        photoId,
        asset: photo.original,
        generation: operation.fence.generation,
      });
      return { source: { ref: source, expiresAt: null }, photo: this.toPhoto(photo, cloud) };
    });
  }

  private async loadOriginal(
    photoId: string,
    source: PhotoLibraryOriginalSource,
    options: { signal: AbortSignal; fileName: string; maxBytes: number },
  ): Promise<File> {
    return await this.withPhotoOperation(photoId, options.signal, async (operation) => {
      const reference = this.resolveRef(source.ref, "original", photoId);
      if (source.expiresAt !== null) throw new PersonalPhotoCloudError("scope_changed");
      if (!positiveSafe(options.maxBytes) || reference.asset.sizeBytes > options.maxBytes) {
        throw new BrowserPhotoSourceError("too_large");
      }
      let lease: MemoryLease;
      try {
        lease = this.originalMemory.reserve(conservativeBytes(reference.asset.sizeBytes, 3));
      } catch {
        throw new BrowserPhotoSourceError("too_large");
      }
      try {
        const content = await this.readAsset(photoId, reference.asset, undefined, { signal: operation.signal });
        const bytes = await contentBytes(content);
        operation.assertCurrent();
        return new File([bytes], options.fileName, { type: reference.asset.contentType });
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (error instanceof BrowserPhotoSourceError) throw error;
        throw new BrowserPhotoSourceError("fetch_failed");
      } finally {
        lease.release();
      }
    });
  }

  private async downloadOriginal(
    requested: Pick<PhotoLibraryItem, "id" | "fileName" | "sizeBytes" | "hasOriginal">,
    options?: PhotoLibraryRequestOptions,
  ): Promise<{ blob: Blob; fileName: string }> {
    if (!requested.hasOriginal) throw new PersonalPhotoCloudError("not_found");
    return await this.withPhotoOperation(requested.id, options?.signal, async (operation) => {
      const photo = await this.requirePhoto(requested.id, { signal: operation.signal });
      const lease = this.originalMemory.reserve(conservativeBytes(photo.original.sizeBytes, 3));
      try {
        const content = await this.readAsset(photo.id, photo.original, undefined, { signal: operation.signal });
        const bytes = await contentBytes(content);
        operation.assertCurrent();
        return { blob: new Blob([bytes], { type: photo.original.contentType }), fileName: photo.fileName };
      } finally {
        lease.release();
      }
    });
  }

  private async ensureWorkingCopy(
    photoId: string,
    options?: PhotoLibraryRequestOptions,
  ): Promise<PhotoLibraryWorkingCopyResult> {
    return await this.withPhotoOperation(photoId, options?.signal, async (operation) => {
      const [photo, cloud] = await Promise.all([
        this.requirePhoto(photoId, { signal: operation.signal }),
        this.loadLibrary(operation.signal),
      ]);
      const renderer = rendererIntersection(cloud.capabilities.renderer, this.options.hostRenderer);
      if (!projectRecipeSettings(photo, cloud, this.options.hostRenderer, this.bitmapMaskReader())) {
        return { kind: "incompatible", message: PHOTO_EDITING_PERSONAL_CLOUD_COPY.readOnlySettings };
      }
      const format = cloud.capabilities.formats.find((candidate) => candidate.format === photo.format);
      if (!format?.workingCopy || renderer === null) {
        return { kind: "notApplicable" };
      }
      if (photo.media.state === "failed" || photo.media.state === "unsupported") return mediaResult(photo.media);
      if (
        photo.media.state === "ready" &&
        photo.media.recipeRevision === photo.recipe.revision &&
        photo.media.workingCopy
      ) {
        return this.readyWorkingCopy(photo, photo.media, renderer, operation.fence);
      }
      if (photo.media.state === "ready") {
        return { kind: "incompatible", message: PHOTO_EDITING_PERSONAL_CLOUD_COPY.unsupported };
      }
      if (photo.media.state === "queued" || photo.media.state === "processing") return mediaResult(photo.media);
      const idempotencyKey = await logicalKey(
        "media.ensure",
        this.scope.captured.actorId,
        this.scope.captured.libraryId,
        photo.id,
        photo.recipe.revision,
      );
      const receipt = await this.withScope(operation.signal, (signal) =>
        this.options.client.request(
          "media.ensure",
          { photoId: photo.id, recipeRevision: photo.recipe.revision },
          { signal, idempotencyKey },
        ),
      );
      const media = validateMediaState(receipt.value);
      if (media.state === "ready" && media.recipeRevision === photo.recipe.revision && media.workingCopy) {
        return this.readyWorkingCopy(photo, media, renderer, operation.fence);
      }
      return mediaResult(media);
    });
  }

  private async loadWorkingCopy(
    photoId: string,
    download: PhotoLibraryWorkingCopyDownload,
    options: { signal: AbortSignal },
  ) {
    return await this.withPhotoOperation(photoId, options.signal, async (operation) => {
      const reference = this.resolveRef(download.ref, "working-copy", photoId);
      const working = reference.workingCopy;
      if (
        download.expiresAt !== null ||
        download.work.baseVersion !== working.baseVersion ||
        download.work.sizeBytes !== working.asset.sizeBytes ||
        download.work.width !== working.asset.width ||
        download.work.height !== working.asset.height ||
        download.work.renderedAt !== null
      ) {
        throw new PersonalPhotoCloudError("invalid_response");
      }
      const lease = this.workingCopyMemory.reserve(conservativeBytes(working.asset.sizeBytes, 2));
      try {
        const content = await this.readAsset(photoId, working.asset, undefined, { signal: operation.signal });
        const bytes = await contentBytes(content);
        operation.assertCurrent();
        return {
          photoId,
          baseVersion: working.baseVersion,
          bytes: bytes.buffer,
          encoding: working.encoding,
          metaJson: JSON.stringify(working.meta),
        };
      } finally {
        lease.release();
      }
    });
  }

  private async retryWorkingCopy(photoId: string) {
    return await this.withPhotoOperation(photoId, undefined, async (operation) => {
      const photo = await this.rawPhoto(photoId, { signal: operation.signal });
      if (!photo) return { kind: "notApplicable" } as const;
      return { kind: "notFailed", workStatus: workStatus(photo.media) } as const;
    });
  }

  private async deletePhotos(photoIds: readonly string[]) {
    if (
      photoIds.length > PHOTO_LIMITS.lookupMaxCount ||
      new Set(photoIds).size !== photoIds.length ||
      !photoIds.every(validId)
    ) {
      throw new PersonalPhotoCloudError("invalid_response");
    }
    this.scope.assertCurrent();
    const deleted: string[] = [];
    const errors: unknown[] = [];
    for (const photoId of photoIds) {
      try {
        this.scope.assertCurrent();
        const idempotencyKey = await logicalKey(
          "photos.delete",
          this.scope.captured.actorId,
          this.scope.captured.libraryId,
          photoId,
        );
        const result = await this.withScope(undefined, (signal) =>
          this.options.client.request("photos.delete", { photoId }, { signal, idempotencyKey }),
        );
        if (result.state !== "purged") throw new PersonalPhotoCloudError("invalid_response");
        this.invalidatePhoto(photoId);
        deleted.push(photoId);
      } catch (error) {
        errors.push(publicError(error));
        if (error instanceof PersonalPhotoCloudError && (error.code === "scope_changed" || error.code === "disposed")) break;
      }
    }
    this.scope.assertCurrent();
    return { deleted, errors };
  }

  private async toItem(
    photo: Photo,
    cloud: PersonalPhotoLibrary,
    fence: PhotoFence,
    signal?: AbortSignal,
  ): Promise<{
    item: PhotoLibraryItem & { contentSha256: string };
    leaseKey: string | null;
    claim: PreviewClaim | null;
  }> {
    const projection = await this.previewProjection(photo, cloud, fence, signal);
    try {
      this.assertPhotoFence(fence);
      return {
        item: {
          ...this.toPhoto(photo, cloud),
          contentSha256: photo.original.sha256,
          previewUrl: null,
          editedPreview: projection.editedPreview,
        },
        leaseKey: projection.leaseKey,
        claim: projection.claim,
      };
    } catch (error) {
      if (projection.claim) this.releasePreviewClaim(projection.claim);
      throw error;
    }
  }

  private toPhoto(photo: Photo, cloud: PersonalPhotoLibrary): PhotoLibraryPhoto {
    const settings = projectRecipeSettings(photo, cloud, this.options.hostRenderer, this.bitmapMaskReader());
    const derivative = currentDerivative(photo, cloud, this.options.hostRenderer, this.bitmapMaskReader());
    return {
      id: photo.id,
      fileName: photo.fileName,
      fileExtension: extensionFor(photo.fileName, photo.format),
      sizeBytes: photo.original.sizeBytes,
      contentSha256: photo.original.sha256,
      createdAt: photo.addedAt,
      capturedAt: photo.capturedAt,
      uploadedBy: { userId: this.scope.captured.actorId, displayName: null },
      hasOriginal: true,
      hasPreview: derivative !== null,
      hasWebImage: false,
      hasDevelopSettings: photo.recipe.revision > 0,
      developSettings: settings,
      developSettingsUpdatedAt: photo.recipe.revision > 0 ? photo.recipe.updatedAt : null,
      developRevision: photo.recipe.revision,
      webRenderedRevision: null,
      workStatus:
        photo.media.state === "ready" && photo.media.recipeRevision !== photo.recipe.revision
          ? null
          : workStatus(photo.media),
      workQueuedAt: null,
      hasEdits: photo.hasEdits,
      editedPreview:
        derivative === null
          ? null
          : {
              revision: derivative.recipeRevision,
              width: derivative.preview.width,
              height: derivative.preview.height,
              url: null,
              thumbUrl: null,
            },
    };
  }

  private async previewProjection(
    photo: Photo,
    cloud: PersonalPhotoLibrary,
    fence: PhotoFence,
    signal?: AbortSignal,
  ): Promise<PreviewProjection> {
    const derivative = currentDerivative(photo, cloud, this.options.hostRenderer, this.bitmapMaskReader());
    if (!derivative) return { editedPreview: null, leaseKey: null, claim: null };
    const asset = derivative.thumbnail;
    const key = previewKey(photo.id, asset);
    const cached = this.urlCache.get(key);
    if (cached?.published) {
      this.assertPhotoFence(fence);
      return {
        editedPreview: {
          revision: derivative.recipeRevision,
          width: derivative.preview.width,
          height: derivative.preview.height,
          url: null,
          thumbUrl: cached.url,
        },
        leaseKey: key,
        claim: null,
      };
    }
    const claim = cached ? this.claimPreviewEntry(key, cached) : this.claimPendingPreview(photo.id, asset, key, fence);
    try {
      const entry = claim.entry ?? (await this.waitForPendingPreview(claim.pending!, signal));
      this.scope.assertCurrent(signal);
      this.assertPhotoFence(fence);
      return {
        editedPreview: {
          revision: derivative.recipeRevision,
          width: derivative.preview.width,
          height: derivative.preview.height,
          url: null,
          thumbUrl: entry.url,
        },
        leaseKey: key,
        claim,
      };
    } catch (error) {
      this.releasePreviewClaim(claim);
      throw error;
    }
  }

  private claimPreviewEntry(key: string, entry: UrlEntry): PreviewClaim {
    const claim: PreviewClaim = { key, pending: null, entry, released: false };
    entry.claims.add(claim);
    return claim;
  }

  private claimPendingPreview(photoId: string, asset: PhotoAsset, key: string, fence: PhotoFence): PreviewClaim {
    let pending = this.pendingPreviews.get(key);
    if (pending?.controller.signal.aborted) {
      if (this.pendingPreviews.get(key) === pending) this.pendingPreviews.delete(key);
      pending = undefined;
    }
    pending ??= this.createPreviewEntry(photoId, asset, key, fence);
    const claim: PreviewClaim = { key, pending, entry: null, released: false };
    pending.claims.add(claim);
    return claim;
  }

  private createPreviewEntry(
    photoId: string,
    asset: PhotoAsset,
    key: string,
    fence: PhotoFence,
  ): PendingPreview {
    if (this.urlCache.size + this.pendingPreviews.size >= MAX_URL_ENTRIES) {
      throw new PersonalPhotoCloudError("too_large");
    }
    const lease = this.previewMemory.reserve(conservativeBytes(asset.sizeBytes, 3));
    const controller = new AbortController();
    const claims = new Set<PreviewClaim>();
    let pending: PendingPreview;
    const promise = Promise.resolve().then(async (): Promise<UrlEntry> => {
      let url: string | null = null;
      try {
        const content = await this.readAsset(photoId, asset, undefined, { signal: controller.signal });
        const bytes = await contentBytes(content);
        this.scope.assertCurrent(controller.signal);
        this.assertPhotoFence(fence);
        url = this.urls.createObjectURL(new Blob([bytes], { type: asset.contentType }));
        this.scope.assertCurrent(controller.signal);
        this.assertPhotoFence(fence);
        lease.resize(asset.sizeBytes);
        const entry: UrlEntry = { url, photoId, assetKey: key, lease, published: false, claims: new Set() };
        for (const claim of pending.claims) {
          claim.pending = null;
          claim.entry = entry;
          entry.claims.add(claim);
        }
        pending.claims.clear();
        this.urlCache.set(key, entry);
        return entry;
      } catch (error) {
        if (url) this.urls.revokeObjectURL(url);
        lease.release();
        throw error;
      } finally {
        if (this.pendingPreviews.get(key) === pending) this.pendingPreviews.delete(key);
      }
    });
    pending = { photoId, controller, promise, claims };
    this.pendingPreviews.set(key, pending);
    void pending.promise.catch(() => undefined);
    return pending;
  }

  private async waitForPendingPreview(pending: PendingPreview, signal?: AbortSignal): Promise<UrlEntry> {
    if (!signal) return await pending.promise;
    if (signal.aborted) throw abortReason(signal);
    return await new Promise<UrlEntry>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        callback();
      };
      const abort = (): void => finish(() => reject(abortReason(signal)));
      signal.addEventListener("abort", abort, { once: true });
      void pending.promise.then(
        (entry) => finish(() => resolve(entry)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  private publishPreviewClaims(claims: readonly PreviewClaim[]): void {
    for (const claim of claims) {
      const entry = claim.entry;
      if (claim.released || !entry || this.urlCache.get(claim.key) !== entry) {
        throw new PersonalPhotoCloudError("unavailable");
      }
    }
    for (const claim of claims) claim.entry!.published = true;
    for (const claim of claims) this.releasePreviewClaim(claim);
  }

  private releasePreviewClaim(claim: PreviewClaim): void {
    if (claim.released) return;
    claim.released = true;
    const pending = claim.pending;
    claim.pending = null;
    if (pending) {
      pending.claims.delete(claim);
      if (pending.claims.size === 0) {
        if (this.pendingPreviews.get(claim.key) === pending) this.pendingPreviews.delete(claim.key);
        pending.controller.abort(new DOMException("Aborted", "AbortError"));
      }
    }
    const entry = claim.entry;
    claim.entry = null;
    if (!entry) return;
    entry.claims.delete(claim);
    if (entry.published || entry.claims.size > 0 || this.urlCache.get(claim.key) !== entry) return;
    this.urls.revokeObjectURL(entry.url);
    entry.lease.release();
    this.urlCache.delete(claim.key);
  }

  private readyWorkingCopy(
    photo: Photo,
    media: Extract<MediaState, { state: "ready" }>,
    renderer: RenderCapability,
    fence: PhotoFence,
  ): PhotoLibraryWorkingCopyResult {
    const workingCopy = media.workingCopy;
    if (
      !workingCopy ||
      media.recipeRevision !== photo.recipe.revision ||
      media.rendererManifestSha256 !== renderer.manifestSha256 ||
      !workingBaseCompatible(photo, workingCopy)
    ) {
      return { kind: "incompatible", message: PHOTO_EDITING_PERSONAL_CLOUD_COPY.unsupported };
    }
    validateAsset(workingCopy.asset, "working-copy");
    this.assertPhotoFence(fence);
    const ref = this.issueRef({
      kind: "working-copy",
      photoId: photo.id,
      asset: workingCopy.asset,
      workingCopy,
      generation: fence.generation,
    });
    return {
      kind: "ready",
      download: {
        ref,
        expiresAt: null,
        work: {
          baseVersion: workingCopy.baseVersion,
          sizeBytes: workingCopy.asset.sizeBytes,
          width: workingCopy.asset.width,
          height: workingCopy.asset.height,
          meta: workingCopy.meta,
          renderedAt: null,
        },
      },
    };
  }

  private issueRef(value: AssetRef): string {
    this.scope.assertCurrent();
    const ref = crypto.randomUUID();
    this.refs.set(ref, value);
    while (this.refs.size > MAX_REFS) {
      const oldest = this.refs.keys().next().value;
      if (oldest === undefined) break;
      this.refs.delete(oldest);
    }
    return ref;
  }

  private resolveRef<K extends AssetRef["kind"]>(ref: string, kind: K, photoId: string): Extract<AssetRef, { kind: K }> {
    this.scope.assertCurrent();
    const value = this.refs.get(ref);
    if (!value || value.kind !== kind || value.photoId !== photoId) throw new PersonalPhotoCloudError("scope_changed");
    const state = this.photoStates.get(photoId);
    if (!state) throw new PersonalPhotoCloudError("scope_changed");
    if (state.purged || state.generation !== value.generation) throw new PersonalPhotoCloudError("scope_changed");
    this.refs.delete(ref);
    this.refs.set(ref, value);
    return value as Extract<AssetRef, { kind: K }>;
  }

  private async requirePhoto(photoId: string, options?: PhotoLibraryRequestOptions): Promise<Photo> {
    const photo = await this.rawPhoto(photoId, options);
    if (!photo) throw new PersonalPhotoCloudError("not_found");
    return photo;
  }

  private async loadLibrary(signal?: AbortSignal, _refresh = false): Promise<PersonalPhotoLibrary> {
    this.scope.assertCurrent(signal);
    const value = validateLibrary(
      await this.withScope(signal, (requestSignal) => this.options.client.request("library.get", {}, { signal: requestSignal })),
      this.scope.captured.actorId,
      this.scope.captured.libraryId,
    );
    this.scope.assertCurrent(signal);
    return value;
  }

  private async withScope<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const request = this.scope.begin(signal);
    try {
      const result = await operation(request.signal);
      request.assertCurrent();
      return result;
    } catch (error) {
      const safe = publicError(error);
      if (safe instanceof PersonalPhotoCloudError && safe.code === "scope_changed") {
        this.scope.invalidateAuthentication();
      }
      throw safe;
    } finally {
      request.release();
    }
  }

  private async withPhotoOperation<T>(
    photoId: string,
    signal: AbortSignal | undefined,
    callback: (operation: PhotoOperationLifetime) => Promise<T>,
  ): Promise<T> {
    const operation = this.beginPhotoOperation(photoId, signal);
    try {
      const result = await callback(operation);
      operation.assertCurrent();
      return result;
    } finally {
      operation.release();
    }
  }

  private beginPhotoOperation(photoId: string, externalSignal?: AbortSignal): PhotoOperationLifetime {
    this.scope.assertCurrent(externalSignal);
    const state = this.getPhotoState(photoId);
    if (state.purged) throw new PersonalPhotoCloudError("not_found");
    const fence = { state, generation: state.generation };
    const lifecycleSignal = state.lifecycle.signal;
    const controller = new AbortController();
    const abortFromState = (): void => controller.abort(lifecycleSignal.reason);
    const abortFromExternal = (): void => controller.abort(externalSignal?.reason);
    lifecycleSignal.addEventListener("abort", abortFromState, { once: true });
    if (externalSignal?.aborted) abortFromExternal();
    else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
    state.activeOperations += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      state.activeOperations -= 1;
      lifecycleSignal.removeEventListener("abort", abortFromState);
      externalSignal?.removeEventListener("abort", abortFromExternal);
    };
    return {
      fence,
      signal: controller.signal,
      assertCurrent: () => {
        this.scope.assertCurrent(externalSignal);
        if (controller.signal.aborted) throw abortReason(controller.signal);
        this.assertPhotoFence(fence);
      },
      release,
    };
  }

  private invalidatePhoto(photoId: string): void {
    let state = this.photoStates.get(photoId);
    if (state?.purged) return;
    this.lifecycleVersion += 1;
    if (!state) {
      try {
        state = this.getPhotoState(photoId);
      } catch (error) {
        if (error instanceof PersonalPhotoCloudError && error.code === "too_large") return;
        throw error;
      }
    }
    state.generation += 1;
    state.fingerprint = null;
    state.purged = true;
    state.lifecycle.abort(new PersonalPhotoCloudError("not_found"));
    this.dropPhotoResources(photoId);
  }

  private clearScopedState(): void {
    for (const state of this.photoStates.values()) {
      state.generation += 1;
      state.evicted = true;
      state.lifecycle.abort(new PersonalPhotoCloudError("scope_changed"));
    }
    this.refs.clear();
    this.photoStates.clear();
    this.releasePreviewResources();
  }

  private bitmapMaskReader(): boolean {
    return this.options.maskSurfaceValidator !== undefined && this.options.maskSurfaceReader !== undefined;
  }

  private getPhotoState(photoId: string): PhotoState {
    const current = this.photoStates.get(photoId);
    if (current) {
      this.photoStates.delete(photoId);
      this.photoStates.set(photoId, current);
      return current;
    }
    if (this.photoStates.size >= MAX_PHOTO_STATES) {
      let evicted = false;
      for (const [candidateId, candidate] of this.photoStates) {
        if (this.isPhotoStateHeld(candidateId, candidate)) continue;
        candidate.generation += 1;
        candidate.evicted = true;
        candidate.lifecycle.abort(new PersonalPhotoCloudError("unavailable"));
        this.photoStates.delete(candidateId);
        evicted = true;
        break;
      }
      if (!evicted) throw new PersonalPhotoCloudError("too_large");
    }
    const created: PhotoState = {
      generation: 0,
      fingerprint: null,
      purged: false,
      evicted: false,
      activeOperations: 0,
      lifecycle: new AbortController(),
    };
    this.photoStates.set(photoId, created);
    return created;
  }

  private assertPhotoFence(fence: PhotoFence): void {
    if (fence.state.purged) throw new PersonalPhotoCloudError("not_found");
    if (fence.state.evicted || fence.state.generation !== fence.generation) {
      throw new PersonalPhotoCloudError("unavailable");
    }
  }

  private observePhoto(photo: Photo, fence?: PhotoFence): PhotoFence {
    const state = fence?.state ?? this.getPhotoState(photo.id);
    if (fence) this.assertPhotoFence(fence);
    if (state.purged) throw new PersonalPhotoCloudError("not_found");
    const fingerprint = photoFingerprint(photo);
    if (state.fingerprint !== null && state.fingerprint !== fingerprint) {
      state.generation += 1;
      const previousLifecycle = state.lifecycle;
      state.lifecycle = new AbortController();
      state.fingerprint = fingerprint;
      previousLifecycle.abort(new PersonalPhotoCloudError("unavailable"));
      this.dropPhotoResources(photo.id);
      throw new PersonalPhotoCloudError("unavailable");
    }
    state.fingerprint = fingerprint;
    return { state, generation: state.generation };
  }

  private observeNotFound(photoId: string, fence: PhotoFence): void {
    if (fence.state.purged) return;
    this.invalidatePhoto(photoId);
  }

  private assertLifecycleVersion(version: number): void {
    if (version !== this.lifecycleVersion) throw new PersonalPhotoCloudError("unavailable");
  }

  private isPhotoStateHeld(photoId: string, state: PhotoState): boolean {
    if (state.activeOperations > 0) return true;
    for (const value of this.refs.values()) if (value.photoId === photoId) return true;
    for (const value of this.urlCache.values()) if (value.photoId === photoId) return true;
    for (const value of this.pendingPreviews.values()) if (value.photoId === photoId) return true;
    return false;
  }

  private dropPhotoResources(photoId: string): void {
    for (const [ref, value] of this.refs) if (value.photoId === photoId) this.refs.delete(ref);
    this.releasePreviewResources([photoId]);
  }

  private releasePreviewResources(photoIds?: readonly string[]): void {
    const selected = photoIds === undefined ? null : new Set(photoIds);
    for (const [key, pending] of this.pendingPreviews) {
      if (selected && !selected.has(pending.photoId)) continue;
      if (this.pendingPreviews.get(key) === pending) this.pendingPreviews.delete(key);
      pending.controller.abort(new DOMException("Aborted", "AbortError"));
    }
    for (const [key, entry] of this.urlCache) {
      if (selected && !selected.has(entry.photoId)) continue;
      this.urls.revokeObjectURL(entry.url);
      entry.lease.release();
      this.urlCache.delete(key);
    }
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scope.dispose();
    this.options.client.dispose();
  }
}

function listRequest(query: PhotoLibraryListQuery): PhotoListQuery {
  if (
    query.hasOriginal === false ||
    query.favorite !== undefined ||
    query.albumId !== undefined ||
    query.flag !== undefined ||
    query.folderId !== undefined ||
    query.localSource !== undefined
  ) {
    throw new PersonalPhotoCloudError("unsupported");
  }
  if (query.limit !== undefined && (!positiveSafe(query.limit) || query.limit > PHOTO_LIMITS.listMaxCount)) {
    throw new PersonalPhotoCloudError("invalid_response");
  }
  if (query.cursor !== undefined && query.cursor !== null && (query.cursor.length === 0 || query.cursor.length > 4096)) {
    throw new PersonalPhotoCloudError("invalid_response");
  }
  const request: {
    cursor?: string;
    limit?: number;
    sort?: "added-desc" | "captured-desc";
    formats?: readonly PhotoFormat[];
    edited?: boolean;
  } = {};
  if (query.cursor !== undefined && query.cursor !== null) request.cursor = query.cursor;
  if (query.limit !== undefined) request.limit = query.limit;
  if (query.sort !== undefined) request.sort = query.sort === "added" ? "added-desc" : "captured-desc";
  if (query.kind !== undefined) request.formats = query.kind === "jpeg" ? ["jpeg"] : query.kind === "heic" ? ["heic", "heif"] : ["raw"];
  if (query.edited !== undefined) request.edited = query.edited;
  return request;
}

function sharedUsage(value: QuotaUsage): PhotoLibraryUsage {
  validateUsage(value);
  return { usedBytes: value.usedBytes + value.reservedBytes, quotaBytes: value.quotaBytes };
}

function currentDerivative(
  photo: Photo,
  cloud: PersonalPhotoLibrary,
  host: RenderCapability,
  bitmapReader = false,
): Extract<MediaState, { state: "ready" }> | null {
  if (
    projectRecipeSettings(photo, cloud, host, bitmapReader) === null ||
    photo.media.state !== "ready" ||
    photo.media.recipeRevision !== photo.recipe.revision ||
    photo.media.rendererManifestSha256 !== cloud.capabilities.renderer.manifestSha256 ||
    photo.media.rendererManifestSha256 !== host.manifestSha256
  ) {
    return null;
  }
  return photo.media;
}

function workingBaseCompatible(photo: Photo, workingCopy: WorkingCopy): boolean {
  const settingsBase = photo.recipe.settings.base;
  if (settingsBase !== undefined && settingsBase !== null && typeof settingsBase !== "string") return false;
  if (photo.recipe.baseVersion !== null && photo.recipe.baseVersion !== workingCopy.baseVersion) return false;
  if (typeof settingsBase === "string" && settingsBase !== workingCopy.baseVersion) return false;
  return true;
}

function photoFingerprint(photo: Photo): string {
  const media = photo.media;
  const mediaIdentity =
    media.state === "ready"
      ? [
          media.state,
          media.recipeRevision,
          media.rendererManifestSha256,
          assetFingerprint(media.thumbnail),
          assetFingerprint(media.preview),
          media.workingCopy
            ? [
                assetFingerprint(media.workingCopy.asset),
                media.workingCopy.baseVersion,
                media.workingCopy.encoding,
                media.workingCopy.meta,
              ]
            : null,
        ]
      : media.state === "queued" || media.state === "processing"
        ? [media.state, media.jobId]
        : media.state === "failed" || media.state === "unsupported"
          ? [media.state, media.code]
          : [media.state];
  return JSON.stringify([
    assetFingerprint(photo.original),
    photo.recipe.revision,
    photo.recipe.settingsSha256,
    photo.recipe.baseVersion,
    photo.recipe.maskSurfaceIds,
    mediaIdentity,
  ]);
}

function assetFingerprint(asset: PhotoAsset): readonly unknown[] {
  return [asset.kind, asset.id, asset.sha256, asset.sizeBytes, asset.contentType, asset.width, asset.height];
}

function previewKey(photoId: string, asset: PhotoAsset): string {
  return `${photoId}:${asset.id}:${asset.sha256}:${asset.sizeBytes}`;
}

function workStatus(media: MediaState): PhotoLibraryWorkStatus | null {
  if (media.state === "pending" || media.state === "queued") return "queued";
  if (media.state === "processing") return "rendering";
  if (media.state === "ready") return "ready";
  return "failed";
}

function mediaResult(media: MediaState): PhotoLibraryWorkingCopyResult {
  if (media.state === "failed" || media.state === "unsupported") {
    return { kind: "notReady", workStatus: "failed", workQueuedAt: null, lastErrorCode: media.code };
  }
  if (media.state === "pending" || media.state === "queued") {
    return { kind: "notReady", workStatus: "queued", workQueuedAt: null, lastErrorCode: null };
  }
  if (media.state === "processing") {
    return { kind: "notReady", workStatus: "rendering", workQueuedAt: null, lastErrorCode: null };
  }
  return { kind: "incompatible", message: PHOTO_EDITING_PERSONAL_CLOUD_COPY.unsupported };
}

async function logicalKey(namespace: string, ownerId: string, libraryId: string, photoId: string, revision?: number): Promise<string> {
  const payload = JSON.stringify({ namespace, ownerId, libraryId, photoId, revision: revision ?? null });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function extensionFor(fileName: string, format: PhotoFormat): string {
  const index = fileName.lastIndexOf(".");
  return index >= 0 && index < fileName.length - 1 ? fileName.slice(index + 1).toLowerCase() : format;
}

function validateBudgets(value: CreatePersonalPhotoCloudLibraryOptions["memoryBudgets"]): void {
  if (
    !positiveSafe(value.originalBytes) ||
    !positiveSafe(value.workingCopyBytes) ||
    !positiveSafe(value.previewBytes) ||
    value.originalBytes > PHOTO_LIMITS.maxFileBytes ||
    value.workingCopyBytes > PHOTO_LIMITS.maxFileBytes ||
    value.previewBytes > PHOTO_LIMITS.maxFileBytes
  ) {
    throw new PersonalPhotoCloudError("invalid_identity");
  }
}

function positiveSafe(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= 512;
}

function assertId(value: string): void {
  if (!validId(value)) throw new PersonalPhotoCloudError("invalid_response");
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

function defaultUrlFactory(): PersonalPhotoCloudUrlFactory {
  if (typeof URL.createObjectURL !== "function" || typeof URL.revokeObjectURL !== "function") {
    throw new PersonalPhotoCloudError("invalid_identity");
  }
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  };
}
