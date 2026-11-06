/**
 * The render-job part of the shared-album contract (B00 #241) as the source-device executor uses it. Imported by
 * relative path until the package dependency and lock entry are added by the contract's writer; replace these paths
 * with `@niho/photo-library-sharing-contract` and `@niho/photo-library-sharing-contract/policy` then.
 */
export {
  FORBIDDEN_RENDITION_METADATA,
  SHARING_ERROR_RECOVERY,
  SHARING_ERROR_STATUS,
  SHARING_LIMITS,
} from "../../../photo-library-sharing-contract/src/v1.ts";
export type {
  AlbumId,
  AlbumItemId,
  AlbumItemState,
  ClaimedRenderJob,
  Instant,
  LibraryId,
  PhotoFormat,
  PhotoId,
  RecipeDocument,
  RenderBinding,
  RenderCapability,
  RenderExecutor,
  RenderExecutorOperation,
  RenderExecutorOperationMap,
  RenderExecutorRequestOptions,
  RenderFailureCode,
  RenderJob,
  RenderJobPurpose,
  RenderJobState,
  RenderOutputRequest,
  RenderOutputUploadStart,
  RenditionMetadata,
  Sha256,
  SharingErrorCode,
  SharingErrorEnvelope,
  UploadTicket,
} from "../../../photo-library-sharing-contract/src/v1.ts";
export {
  canonical,
  compareIdempotency,
  compareRenderBinding,
  decideRenderCommit,
  findForbiddenMetadata,
  sanitizeRenditionMetadata,
} from "../../../photo-library-sharing-contract/src/policy.ts";
