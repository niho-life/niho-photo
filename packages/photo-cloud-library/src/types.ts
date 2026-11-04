import type {
  PersonalPhotoCloudClient,
  Photo,
  PhotoAsset,
  PhotoByteRange,
  PhotoContent,
  QuotaUsage,
  RenderCapability,
  VerifiedPhotoActor,
} from "@niho/photo-personal-cloud-contract";
import type { PersonalPhotoResumableUploadState } from "./browser/resumable-upload";
import type {
  PhotoLibrary,
  PhotoLibraryEngineAssets,
  PhotoLibraryPresets,
  PhotoLibraryRequestOptions,
} from "niho-photo-editing/library/photo-library";

export type PersonalPhotoCloudIdentity = {
  getSnapshot(): VerifiedPhotoActor | null;
  subscribe(listener: () => void): () => void;
};

export type PersonalPhotoCloudMemoryBudgets = {
  /** Adapterの一時materialization上限。Blob/Fileへの移管後のcaller所有メモリは含めない。 */
  originalBytes: number;
  /** Adapterの一時materialization上限。ArrayBufferへの移管後のcaller所有メモリは含めない。 */
  workingCopyBytes: number;
  /** 一時materializationと、releaseまでadapterが保持するBlob URLの合計上限。 */
  previewBytes: number;
};

export type PersonalPhotoCloudUrlFactory = {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
};

/** One persisted namespace shared by recipe drafts and mask PNG bytes. */
export interface PersonalPhotoCloudMaskJournalScope {
  readonly actorId: string;
  readonly libraryId: string;
  readonly sessionId: string;
  readonly sessionEpoch: string;
  readonly transport: VerifiedPhotoActor["transport"];
}

export interface PersonalPhotoCloudMaskSurfaceInput {
  /** Content-addressed surface id; must equal sha256. */
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly bytes: Uint8Array;
  readonly uploadState: PersonalPhotoResumableUploadState | null;
}

export interface PersonalPhotoCloudPersistedMaskSurface extends PersonalPhotoCloudMaskSurfaceInput {
  readonly photoId: string;
  readonly contentType: "image/png";
  readonly pinned: boolean;
}

/** Durable mask records and upload checkpoints use the recipe journal's same IndexedDB. */
export interface PersonalPhotoCloudMaskJournal {
  putMaskSurface(scope: PersonalPhotoCloudMaskJournalScope, photoId: string, surface: PersonalPhotoCloudMaskSurfaceInput, signal?: AbortSignal): Promise<void>;
  getMaskSurface(scope: PersonalPhotoCloudMaskJournalScope, photoId: string, sha256: string, signal?: AbortSignal): Promise<PersonalPhotoCloudPersistedMaskSurface | null>;
  compareAndSetMaskUploadState(
    scope: PersonalPhotoCloudMaskJournalScope,
    photoId: string,
    sha256: string,
    expected: PersonalPhotoResumableUploadState | null,
    next: PersonalPhotoResumableUploadState | null,
    signal?: AbortSignal,
  ): Promise<boolean>;
  setMaskSurfacePinned(scope: PersonalPhotoCloudMaskJournalScope, photoId: string, sha256: string, pinned: boolean, signal?: AbortSignal): Promise<void>;
  deleteMaskSurface(scope: PersonalPhotoCloudMaskJournalScope, photoId: string, sha256: string, signal?: AbortSignal): Promise<boolean>;
}

export interface PersonalPhotoCloudMaskLocks {
  request<T>(
    name: string,
    options: { readonly mode: "exclusive"; readonly signal: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T>;
}

/** Host-owned binary upload port. Provider tickets and URLs remain inside the host implementation. */
export type PersonalPhotoCloudMaskUploader = {
  upload(input: {
    readonly photoId: string;
    readonly surfaceId: string;
    readonly bytes: Uint8Array;
    readonly idempotencyKey: string;
    /** Latest durable checkpoint. Browser hosts resume it through the common runner. */
    readonly uploadState: PersonalPhotoResumableUploadState;
    /** Strict CAS into the same journal that stores the immutable PNG bytes. */
    readonly compareAndSetUploadState: (
      expected: PersonalPhotoResumableUploadState,
      next: PersonalPhotoResumableUploadState,
      signal: AbortSignal,
    ) => Promise<boolean>;
    readonly signal: AbortSignal;
  }): Promise<void>;
};

/** Host SDK decoder used to verify that stored mask PNGs can be drawn by the same renderer. */
export type PersonalPhotoCloudMaskValidator = {
  validateMaskSurface(
    png: Uint8Array,
    signal: AbortSignal,
  ): Promise<{ readonly id: string; readonly width: number; readonly height: number }>;
};

export type CreatePersonalPhotoCloudLibraryOptions = {
  client: PersonalPhotoCloudClient;
  identity: PersonalPhotoCloudIdentity;
  hostRenderer: RenderCapability;
  engineAssets: PhotoLibraryEngineAssets;
  presets: PhotoLibraryPresets;
  memoryBudgets: PersonalPhotoCloudMemoryBudgets;
  clock?: { now(): number };
  urls?: PersonalPhotoCloudUrlFactory;
  /** Absent until a trusted host can durably upload masks without exposing provider tickets. */
  maskUploader?: PersonalPhotoCloudMaskUploader;
  /** Absent until the host can validate masks with the same SDK decoder used for rendering. */
  maskValidator?: PersonalPhotoCloudMaskValidator;
  /** Same durable namespace as recipe sync; required before mask write capability opens. */
  maskJournal?: PersonalPhotoCloudMaskJournal;
  /** Serializes one content-addressed mask upload across tabs/windows sharing the journal. */
  maskLocks?: PersonalPhotoCloudMaskLocks;
};

export type PersonalPhotoCloudLibraryHandle = {
  library: PhotoLibrary;
  usage(options?: PhotoLibraryRequestOptions): Promise<QuotaUsage>;
  rawPhoto(photoId: string, options?: PhotoLibraryRequestOptions): Promise<Photo | null>;
  readAsset(
    photoId: string,
    asset: PhotoAsset,
    range?: PhotoByteRange,
    options?: PhotoLibraryRequestOptions,
  ): Promise<PhotoContent>;
  /** UIが表示を終えたedited previewのBlob URLを明示的に解放する。省略時は全件。 */
  releasePreviewResources(photoIds?: readonly string[]): void;
  dispose(): void;
};
