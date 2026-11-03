import type { DevelopSettings } from "../develop-engine/develop-settings";
import type { PhotoLibraryRequestOptions } from "./photo-library";

/** 各portがobject identityで検証する印。別writer/本人の印を渡しても処理しない。 */
export type PhotoLibraryDevelopDraftToken = Readonly<{ kind: "develop-draft" }>;
export type PhotoLibraryDevelopConflictToken = Readonly<{ kind: "develop-conflict" }>;
export type PhotoLibraryDevelopChoiceToken = Readonly<{ kind: "develop-choice" }>;

/** 完全な設定を保つ。描画できない未知JSONも、既知fieldだけへ変換しない。 */
export type PhotoLibraryDevelopDraftCandidate = Readonly<{
  settings: Readonly<Record<string, unknown>>;
  baseVersion: string | null;
  maskSurfaceIds: readonly string[];
}>;

export type PhotoLibraryDevelopDraftStage = Readonly<{
  /** stageの呼出し時にclone/永続化を始め、strict commit後だけcommittedになる。 */
  committed: Promise<"committed" | "superseded" | "unsaved">;
}>;

export type PhotoLibraryDevelopDraftSaveResult =
  | { kind: "saved"; revision: number; updatedAt: string | null }
  | { kind: "conflict"; conflict: PhotoLibraryDevelopConflictToken }
  | { kind: "unknown" | "unsupported" | "unsaved" | "superseded" }
  | { kind: "terminal"; reason: "not-found" | "photo-deleted" };

export type PhotoLibraryDevelopDraftSummary = Readonly<{
  token: PhotoLibraryDevelopDraftToken;
  photoId: string;
  hasLatest: boolean;
  hasUnknownAttempt: boolean;
  conflictCount: number;
}>;

export type PhotoLibraryDevelopDraftSnapshot = Readonly<{
  /** このwriterの最新入力。結果不明の送信値と異なる場合も両方保持する。 */
  latest: PhotoLibraryDevelopDraftCandidate | null;
  latestStage: PhotoLibraryDevelopDraftStage | null;
  attempted: PhotoLibraryDevelopDraftCandidate | null;
  hasUnknownAttempt: boolean;
  hasPendingResolution: boolean;
  conflicts: readonly PhotoLibraryDevelopConflictToken[];
  terminalReason: "not-found" | "photo-deleted" | null;
}>;

export type PhotoLibraryDevelopConflictComparison = Readonly<{
  choice: PhotoLibraryDevelopChoiceToken;
  candidate: PhotoLibraryDevelopDraftCandidate;
  /** 比較を開いた時点の採用済み補正。競合発生時のsnapshotとは区別する。 */
  current: PhotoLibraryDevelopDraftCandidate;
  historicalCurrent: PhotoLibraryDevelopDraftCandidate;
  expectedRevision: number;
  canAdopt: boolean;
}>;

export type PhotoLibraryDevelopConflictResolution =
  | { kind: "resolved"; revision: number }
  | { kind: "stale" | "unknown" | "unsupported" }
  | { kind: "terminal"; reason: "not-found" | "photo-deleted" };

/** 一つの写真・原本・開始版・本人scopeに固定したwriter。URL/credentialは持ち出さない。 */
export type PhotoLibraryDevelopDraftWriter = {
  readonly photoId: string;
  readonly sourceSha256: string;
  readonly token: PhotoLibraryDevelopDraftToken;
  stage(settings: DevelopSettings): PhotoLibraryDevelopDraftStage;
  save(stage: PhotoLibraryDevelopDraftStage, options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryDevelopDraftSaveResult>;
  /** 結果不明の要求を元のkey/bodyで照合する。新しい版への暗黙rebaseはしない。 */
  retry(options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryDevelopDraftSaveResult>;
  read(options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryDevelopDraftSnapshot>;
  compare(conflict: PhotoLibraryDevelopConflictToken, options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryDevelopConflictComparison>;
  /** 選んだ時点の版とintentを固定。unknown中は決定やkeyを差し替えない。 */
  resolve(
    choice: PhotoLibraryDevelopChoiceToken,
    decision: "adopt" | "keep-current",
    options?: PhotoLibraryRequestOptions,
  ): Promise<PhotoLibraryDevelopConflictResolution>;
  retryResolution(options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryDevelopConflictResolution>;
  /** 結果不明のPUT/選択があれば拒否する。表示中writerだけを本人の明示操作で破棄する。 */
  discard(options?: PhotoLibraryRequestOptions): Promise<void>;
  /** 送信を止めるが未保存/unknownの永続値は削除しない。 */
  dispose(): void;
};

/**
 * cloud-syncが実装するoptional接続口。photo-editingはC00/core/IDBへ依存しない。
 * 書込前に復旧候補を確認し、同じ本人のpendingだけを小さいpageで読む。
 */
export type PhotoLibraryDurableDevelopDrafts = {
  /** 再認証後の同一本人が明示して開く入口。通常一覧や自動同期とは別のtoken/stateを使う。 */
  readonly previous?: {
    list: PhotoLibraryDurableDevelopDrafts["list"];
    reopen: PhotoLibraryDurableDevelopDrafts["reopen"];
  };
  /** local draftを読める本人tupleか。期限切れのnetwork許可は別に検証する。 */
  isCurrent(): boolean;
  subscribe(listener: () => void): () => void;
  open(input: { photoId: string; sourceSha256: string; expectedRevision: number }): PhotoLibraryDevelopDraftWriter;
  list(
    query?: { cursor?: string; limit?: number },
    options?: PhotoLibraryRequestOptions,
  ): Promise<{ items: readonly PhotoLibraryDevelopDraftSummary[]; nextCursor: string | null }>;
  reopen(token: PhotoLibraryDevelopDraftToken, options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryDevelopDraftWriter>;
};
