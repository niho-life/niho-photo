export {
  createHostedReplicaSync,
  type CreateHostedReplicaSyncOptions,
  type HostedReplicaSync,
  type ReplicaBatch,
  type ReplicaRecord,
  type ReplicaReplacement,
  type ReplicaStatus,
  type ReplicaStore,
  type ReplicaSyncResult,
} from "./replica.ts";
export {
  recoverLocalIndex,
  type IndexRecoveryEntry,
  type IndexRecoveryReason,
  type IndexRecoveryReport,
  type IndexRecoveryState,
  type SourceScanner,
} from "./index-recovery.ts";
export {
  PORTABLE_ACCESS_MATERIAL,
  PORTABLE_MANIFEST_SHAPE,
  buildFullExport,
  buildMetadataManifest,
  findAccessMaterial,
  manifestSha256,
  parsePortableManifest,
  planRestore,
  verifyFullExport,
  type ExportSink,
  type RestoreAlbumAction,
  type RestorePhotoAction,
  type RestorePlan,
  type RestoreTargetView,
} from "./portability.ts";
export { HostedLibraryError, sharingErrorCode, type HostedLibraryErrorCode } from "./shared.ts";
