import type {
  JsonObject,
  PersonalPhotoCloudClient,
  RecipeCandidate,
  RecipeConflict,
  RecipeConflictResolution,
  RecipeDocument,
  RenderCapability,
  VerifiedPhotoActor,
} from "@niho/photo-personal-cloud-contract";
import type { PersonalPhotoCloudIdentity } from "@niho/photo-cloud-library";

export interface LocalRecipeCandidate {
  readonly settings: JsonObject & { readonly v: number; readonly engine: string };
  readonly baseVersion: string | null;
  readonly maskSurfaceIds: readonly string[];
}

export type StageCommitResult =
  | { readonly status: "committed"; readonly generation: number }
  | { readonly status: "superseded" }
  | { readonly status: "unsaved"; readonly reason: "quota" | "unavailable" };

export interface RecipeStageRef {
  readonly committed: Promise<StageCommitResult>;
}

export interface PendingWriterToken {
  readonly token: string;
  readonly photoId: string;
  readonly hasUnknownAttempt: boolean;
  readonly hasLatest: boolean;
  readonly conflictIds: readonly string[];
  readonly terminalReason: "not-found" | "photo-deleted" | null;
}

export interface PendingWriterPage {
  readonly writers: readonly PendingWriterToken[];
  readonly nextCursor: string | null;
}

export type SaveRecipeResult =
  | { readonly status: "saved"; readonly generation: number; readonly recipe: RecipeDocument; readonly replayed: boolean }
  | { readonly status: "conflict"; readonly generation: number; readonly conflict: RecipeConflict }
  | { readonly status: "terminal"; readonly generation: number; readonly reason: "not-found" | "photo-deleted" }
  | { readonly status: "unknown"; readonly generation: number }
  | { readonly status: "unsupported"; readonly generation: number }
  | { readonly status: "superseded" | "unsaved" };

export type ResolveRecipeConflictResult =
  | { readonly status: "resolved"; readonly resolution: RecipeConflictResolution; readonly replayed: boolean }
  | { readonly status: "stale" }
  | { readonly status: "unknown" }
  | { readonly status: "terminal"; readonly reason: "not-found" | "photo-deleted" }
  | { readonly status: "unsupported" };

export interface RecipeConflictIntent {
  readonly intentId: string;
  readonly conflictId: string;
  readonly decision: "adopt" | "keep-current";
  readonly expectedRevision: number;
}

/** 同scopeの復旧表示用snapshot。要求key/credential/URLを含めない。 */
export interface RecipeDraftSnapshot {
  readonly photoId: string;
  readonly sourceSha256: string;
  readonly initialRevision: number;
  readonly latest: (JournalStage & { readonly ref: RecipeStageRef }) | null;
  readonly attempted: JournalStage | null;
  readonly conflictIds: readonly string[];
  readonly hasUnknownAttempt: boolean;
  readonly pendingResolution: RecipeConflictIntent | null;
  readonly terminalReason: "not-found" | "photo-deleted" | null;
}

export interface PersonalPhotoRecipeWriter {
  readonly token: string;
  stage(candidate: LocalRecipeCandidate): RecipeStageRef;
  readDraft(signal?: AbortSignal): Promise<RecipeDraftSnapshot>;
  save(ref: RecipeStageRef, signal?: AbortSignal): Promise<SaveRecipeResult>;
  retry(signal?: AbortSignal): Promise<SaveRecipeResult>;
  retryResolution(signal?: AbortSignal): Promise<ResolveRecipeConflictResult>;
  getConflict(conflictId: string, signal?: AbortSignal): Promise<RecipeConflict>;
  resolveConflict(intent: RecipeConflictIntent, signal?: AbortSignal): Promise<ResolveRecipeConflictResult>;
  discard(signal?: AbortSignal): Promise<void>;
  dispose(): void;
}

export interface ReopenedPersonalPhotoRecipeWriter {
  readonly writer: PersonalPhotoRecipeWriter;
  readonly latest: RecipeStageRef | null;
  readonly hasUnknownAttempt: boolean;
  readonly pendingResolution: RecipeConflictIntent | null;
}

/** 現在の再認証世代と旧record全体に束縛するobject identity。raw tokenとは交換できない。 */
export type PreviousRecipeWriterToken = Readonly<{ kind: "previous-recipe-writer" }>;

export type PreviousPendingWriter = Omit<PendingWriterToken, "token"> & {
  readonly token: PreviousRecipeWriterToken;
};

export interface PreviousPendingWriterPage {
  readonly writers: readonly PreviousPendingWriter[];
  readonly nextCursor: string | null;
}

export interface PreviousRecipeRecovery {
  listPending(options?: { readonly cursor?: string; readonly limit?: number }, signal?: AbortSignal): Promise<PreviousPendingWriterPage>;
  /** 明示して開いた旧入力だけを扱う。返るwriterのstageは拒否する。 */
  reopen(token: PreviousRecipeWriterToken, signal?: AbortSignal): Promise<ReopenedPersonalPhotoRecipeWriter>;
}

export interface PersonalPhotoRecipeSync {
  readonly previous?: PreviousRecipeRecovery;
  beginEditing(input: { readonly photoId: string; readonly sourceSha256: string; readonly expectedRevision: number }): PersonalPhotoRecipeWriter;
  listPending(options?: { readonly cursor?: string; readonly limit?: number }, signal?: AbortSignal): Promise<PendingWriterPage>;
  reopen(token: string, signal?: AbortSignal): Promise<ReopenedPersonalPhotoRecipeWriter>;
  dispose(): void;
}

export interface RecipeSyncLocks {
  request<T>(
    name: string,
    options: { readonly mode: "exclusive"; readonly signal: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T>;
}

export interface CreatePersonalPhotoRecipeSyncOptions {
  readonly client: PersonalPhotoCloudClient;
  readonly identity: PersonalPhotoCloudIdentity;
  readonly hostRenderer: RenderCapability;
  readonly journal: RecipeSyncJournal;
  readonly locks: RecipeSyncLocks;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly timeoutMs?: number;
}

export interface RecipeJournalScope {
  readonly actorId: string;
  readonly libraryId: string;
  readonly sessionId: string;
  readonly sessionEpoch: string;
  readonly transport: VerifiedPhotoActor["transport"];
}

export interface RecipeWriterBinding extends RecipeJournalScope {
  readonly token: string;
  readonly writerId: string;
  readonly photoId: string;
  readonly sourceSha256: string;
  readonly initialRevision: number;
}

export interface JournalStage {
  readonly generation: number;
  readonly candidate: LocalRecipeCandidate;
}

export interface JournalPutAttempt {
  readonly kind: "put";
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly generation: number;
  readonly candidate: LocalRecipeCandidate;
  readonly expectedRevision: number;
  readonly parentAckGeneration: number;
  readonly requestBody: string;
  readonly requestBytesSha256: string;
  readonly conflictId: string | null;
}

export interface JournalResolutionAttempt {
  readonly kind: "resolve";
  readonly attemptId: string;
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly conflictId: string;
  readonly decision: "adopt" | "keep-current";
  readonly expectedRevision: number;
  readonly requestBody: string;
  readonly requestBytesSha256: string;
  readonly proof: JournalResolutionProof;
}

export interface JournalConflictMetadata {
  readonly conflictId: string;
  readonly generation: number | null;
  readonly snapshotSha256: string;
  readonly candidateSha256: string | null;
}

export type JournalResolutionProof = {
  readonly conflictSnapshotSha256: string;
  readonly originGeneration: number | null;
  readonly expectedResultingRevision: number;
} & (
  | { readonly decision: "adopt"; readonly selectedCandidate: RecipeCandidate }
  | { readonly decision: "keep-current"; readonly selectedRecipe: RecipeDocument }
);

export interface JournalKnownResolution {
  readonly intentId: string;
  readonly conflictId: string;
  readonly decision: "adopt" | "keep-current";
  readonly expectedRevision: number;
  readonly outcome: "resolved" | "stale";
}

export interface ReopenedJournalWriter {
  readonly binding: RecipeWriterBinding;
  readonly nextGeneration: number;
  readonly latest: JournalStage | null;
  readonly attempt: JournalPutAttempt | null;
  readonly resolution: JournalResolutionAttempt | null;
  readonly conflicts: readonly JournalConflictMetadata[];
  readonly knownResolution: JournalKnownResolution | null;
  readonly conflictIds: readonly string[];
  readonly terminalReason: "not-found" | "photo-deleted" | null;
}

/** journal内部だけの旧record識別。UIへbindingやraw tokenを公開しない。 */
export interface JournalPreviousPendingWriter {
  readonly binding: RecipeWriterBinding;
  readonly summary: PendingWriterToken;
}

export interface JournalPreviousPendingWriterPage {
  readonly writers: readonly JournalPreviousPendingWriter[];
  readonly nextCursor: string | null;
}

export interface RecipeSyncJournal {
  /** 同canonical user/libraryの旧tupleを最大16件/4MiBで返す。通常listのscope条件は変えない。 */
  listPrevious?(scope: RecipeJournalScope, options?: { readonly cursor?: string; readonly limit?: number }, signal?: AbortSignal): Promise<JournalPreviousPendingWriterPage>;
  stage(binding: RecipeWriterBinding, stage: JournalStage, signal?: AbortSignal): Promise<void>;
  createAttempt(binding: RecipeWriterBinding, stage: JournalStage, attemptId: string, idempotencyKey: string, signal?: AbortSignal): Promise<JournalPutAttempt>;
  acknowledgeAttempt(binding: RecipeWriterBinding, attemptId: string, generation: number, revision: number, signal?: AbortSignal): Promise<boolean>;
  conflictAttempt(binding: RecipeWriterBinding, attemptId: string, generation: number, conflictId: string, snapshotSha256: string | null, signal?: AbortSignal): Promise<boolean>;
  terminalAttempt(binding: RecipeWriterBinding, attemptId: string, generation: number, reason: "not-found" | "photo-deleted", signal?: AbortSignal): Promise<boolean>;
  terminalStage(binding: RecipeWriterBinding, generation: number, reason: "not-found" | "photo-deleted", signal?: AbortSignal): Promise<boolean>;
  terminalConflict(binding: RecipeWriterBinding, conflictId: string, generation: number | null, reason: "not-found" | "photo-deleted", signal?: AbortSignal): Promise<boolean>;
  createResolution(binding: RecipeWriterBinding, intent: RecipeConflictIntent, proof: JournalResolutionProof, attemptId: string, idempotencyKey: string, signal?: AbortSignal): Promise<JournalResolutionAttempt>;
  settleResolution(binding: RecipeWriterBinding, attemptId: string, outcome: "resolved" | "stale" | "terminal-not-found" | "terminal-photo-deleted", signal?: AbortSignal): Promise<boolean>;
  list(scope: RecipeJournalScope, options?: { readonly cursor?: string; readonly limit?: number }, signal?: AbortSignal): Promise<PendingWriterPage>;
  reopen(scope: RecipeJournalScope, token: string, signal?: AbortSignal): Promise<ReopenedJournalWriter | null>;
  discard(binding: RecipeWriterBinding, signal?: AbortSignal): Promise<void>;
  releaseCompleted(binding: RecipeWriterBinding, signal?: AbortSignal): Promise<boolean>;
  dispose(): void;
}
