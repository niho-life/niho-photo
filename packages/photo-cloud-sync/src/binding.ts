import {
  createPersonalPhotoCloudLibrary as createCloudLibrary,
  type CreatePersonalPhotoCloudLibraryOptions,
  type PersonalPhotoCloudLibraryHandle,
} from "@niho/photo-cloud-library";
import {
  PersonalPhotoCloudError,
  awaitBounded,
  linkedAbortController,
  projectRecipeSettings,
  validateLibrary,
} from "@niho/photo-cloud-library/protocol";
import type {
  PersonalPhotoLibrary,
  Photo,
  RecipeCandidate,
  RecipeDocument,
  VerifiedPhotoActor,
} from "@niho/photo-personal-cloud-contract";
import { readDevelopMasks } from "niho-photo-editing/develop-engine/develop-masks";
import { readDevelopSettings, type DevelopSettings } from "niho-photo-editing/develop-engine/develop-settings";
import type {
  PhotoLibraryDevelopChoiceToken,
  PhotoLibraryDevelopConflictComparison,
  PhotoLibraryDevelopConflictResolution,
  PhotoLibraryDevelopConflictToken,
  PhotoLibraryDevelopDraftCandidate,
  PhotoLibraryDevelopDraftSaveResult,
  PhotoLibraryDevelopDraftSnapshot,
  PhotoLibraryDevelopDraftStage,
  PhotoLibraryDevelopDraftSummary,
  PhotoLibraryDevelopDraftToken,
  PhotoLibraryDevelopDraftWriter,
  PhotoLibraryDurableDevelopDrafts,
} from "niho-photo-editing/library/photo-library-durable-drafts";
import type { PhotoLibraryRequestOptions } from "niho-photo-editing/library/photo-library";

import { createPersonalPhotoRecipeSync } from "./sync";
import type {
  CreatePersonalPhotoRecipeSyncOptions,
  LocalRecipeCandidate,
  PersonalPhotoRecipeSync,
  PersonalPhotoRecipeWriter,
  RecipeConflictIntent,
  RecipeStageRef,
  ResolveRecipeConflictResult,
  SaveRecipeResult,
} from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;
const LIST_LIMIT = 16;

export type CreatePersonalPhotoCloudLibraryWithSyncOptions = CreatePersonalPhotoCloudLibraryOptions & Pick<
  CreatePersonalPhotoRecipeSyncOptions,
  "journal" | "locks" | "randomId" | "timeoutMs"
>;

type StageBinding = {
  readonly owner: BoundWriter;
  readonly core: RecipeStageRef;
  readonly candidate: PhotoLibraryDevelopDraftCandidate;
};

type ConflictBinding = {
  readonly owner: BoundWriter;
  readonly id: string;
};

type ChoiceBinding = {
  readonly owner: BoundWriter;
  readonly conflict: ConflictBinding;
  readonly expectedRevision: number;
  readonly canAdopt: boolean;
  intent: RecipeConflictIntent | null;
};

/** cloud library と durable sync を、同じ client・本人scope・renderer から一度だけ構築する。 */
export function createPersonalPhotoCloudLibrary(
  options: CreatePersonalPhotoCloudLibraryWithSyncOptions,
): PersonalPhotoCloudLibraryHandle {
  const base = createCloudLibrary(options);
  let sync: PersonalPhotoRecipeSync;
  try {
    sync = createPersonalPhotoRecipeSync({
      client: options.client,
      identity: options.identity,
      hostRenderer: options.hostRenderer,
      journal: options.journal,
      locks: options.locks,
      ...(options.clock === undefined ? {} : { now: options.clock.now }),
      ...(options.randomId === undefined ? {} : { randomId: options.randomId }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  } catch (error) {
    base.dispose();
    throw error;
  }
  const durable = new DurableBinding(options, base, sync);
  let disposed = false;
  return {
    ...base,
    library: { ...base.library, durableDevelopDrafts: durable.port },
    dispose() {
      if (disposed) return;
      disposed = true;
      durable.dispose();
      sync.dispose();
      base.dispose();
    },
  };
}

class DurableBinding {
  readonly port: PhotoLibraryDurableDevelopDrafts;

  private readonly actor: VerifiedPhotoActor;
  private readonly tokens = new WeakMap<PhotoLibraryDevelopDraftToken, string>();
  private readonly publicTokens = new Map<string, PhotoLibraryDevelopDraftToken>();
  private readonly stages = new WeakMap<PhotoLibraryDevelopDraftStage, StageBinding>();
  private readonly conflicts = new WeakMap<PhotoLibraryDevelopConflictToken, ConflictBinding>();
  private readonly choices = new WeakMap<PhotoLibraryDevelopChoiceToken, ChoiceBinding>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeIdentity: () => void;
  private disposed = false;

  constructor(
    readonly options: CreatePersonalPhotoCloudLibraryWithSyncOptions,
    readonly handle: PersonalPhotoCloudLibraryHandle,
    readonly sync: PersonalPhotoRecipeSync,
  ) {
    const actor = options.identity.getSnapshot();
    if (actor === null) invalidIdentity();
    this.actor = actor;
    this.unsubscribeIdentity = options.identity.subscribe(() => this.changed());
    this.port = {
      isCurrent: () => this.isCurrent(),
      subscribe: (listener) => this.subscribe(listener),
      open: (input) => this.open(input),
      list: (query, requestOptions) => this.list(query, requestOptions),
      reopen: (token, requestOptions) => this.reopen(token, requestOptions),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeIdentity();
    this.changed();
    this.listeners.clear();
  }

  isCurrent(): boolean {
    if (this.disposed) return false;
    const actor = this.options.identity.getSnapshot();
    return actor !== null && sameActor(actor, this.actor) &&
      this.options.client.scope.actorId === this.actor.userId &&
      this.options.client.scope.libraryId.length > 0 &&
      this.options.client.scope.sessionEpoch === this.actor.sessionEpoch;
  }

  assertCurrent(): void {
    if (!this.isCurrent()) throw new PersonalPhotoCloudError("scope_changed");
  }

  assertNetworkCurrent(): void {
    this.assertCurrent();
    const actor = this.options.identity.getSnapshot();
    const now = this.options.clock?.now() ?? Date.now();
    if (actor === null || !Number.isFinite(Date.parse(actor.expiresAt)) || Date.parse(actor.expiresAt) <= now) {
      throw new PersonalPhotoCloudError("invalid_identity");
    }
  }

  newId(): string {
    const value = (this.options.randomId ?? (() => crypto.randomUUID()))();
    if (typeof value !== "string" || value.length === 0 || value.length > 128) invalid();
    return value;
  }

  stageBinding(stage: PhotoLibraryDevelopDraftStage, owner: BoundWriter): StageBinding {
    const binding = this.stages.get(stage);
    if (binding === undefined || binding.owner !== owner) invalid();
    return binding;
  }

  conflictBinding(conflict: PhotoLibraryDevelopConflictToken, owner: BoundWriter): ConflictBinding {
    const binding = this.conflicts.get(conflict);
    if (binding === undefined || binding.owner !== owner) invalid();
    return binding;
  }

  choiceBinding(choice: PhotoLibraryDevelopChoiceToken, owner: BoundWriter): ChoiceBinding {
    const binding = this.choices.get(choice);
    if (binding === undefined || binding.owner !== owner) invalid();
    return binding;
  }

  publicStage(owner: BoundWriter, core: RecipeStageRef, candidate: LocalRecipeCandidate): PhotoLibraryDevelopDraftStage {
    const publicStage = Object.freeze({
      committed: core.committed.then((result) => result.status === "committed" ? "committed" : result.status),
    });
    this.stages.set(publicStage, { owner, core, candidate: publicCandidate(candidate) });
    return publicStage;
  }

  publicConflict(owner: BoundWriter, id: string): PhotoLibraryDevelopConflictToken {
    const token = Object.freeze({ kind: "develop-conflict" as const });
    this.conflicts.set(token, { owner, id });
    return token;
  }

  publicToken(raw: string): PhotoLibraryDevelopDraftToken {
    const existing = this.publicTokens.get(raw);
    if (existing !== undefined) return existing;
    const token = Object.freeze({ kind: "develop-draft" as const });
    this.publicTokens.set(raw, token);
    this.tokens.set(token, raw);
    return token;
  }

  changed(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* observer failures do not change durable state */ }
    }
  }

  private subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private open(input: { photoId: string; sourceSha256: string; expectedRevision: number }): PhotoLibraryDevelopDraftWriter {
    this.assertCurrent();
    const core = this.sync.beginEditing(input);
    return new BoundWriter(this, core, input.photoId, input.sourceSha256, this.publicToken(core.token));
  }

  private async list(
    query: { cursor?: string; limit?: number } = {},
    options?: PhotoLibraryRequestOptions,
  ): Promise<{ items: readonly PhotoLibraryDevelopDraftSummary[]; nextCursor: string | null }> {
    this.assertCurrent();
    const limit = Math.min(LIST_LIMIT, query.limit ?? LIST_LIMIT);
    const page = await this.sync.listPending({ ...query, limit }, options?.signal);
    this.assertCurrent();
    return {
      items: page.writers.map((item) => Object.freeze({
        token: this.publicToken(item.token),
        photoId: item.photoId,
        hasLatest: item.hasLatest,
        hasUnknownAttempt: item.hasUnknownAttempt,
        conflictCount: item.conflictIds.length,
      })),
      nextCursor: page.nextCursor,
    };
  }

  private async reopen(
    token: PhotoLibraryDevelopDraftToken,
    options?: PhotoLibraryRequestOptions,
  ): Promise<PhotoLibraryDevelopDraftWriter> {
    this.assertCurrent();
    const raw = this.tokens.get(token);
    if (raw === undefined) invalid();
    const reopened = await this.sync.reopen(raw, options?.signal);
    this.assertCurrent();
    const snapshot = await reopened.writer.readDraft(options?.signal);
    this.assertCurrent();
    return new BoundWriter(this, reopened.writer, snapshot.photoId, snapshot.sourceSha256, token);
  }

  async comparison(
    owner: BoundWriter,
    conflictBinding: ConflictBinding,
    options?: PhotoLibraryRequestOptions,
  ): Promise<PhotoLibraryDevelopConflictComparison> {
    this.assertNetworkCurrent();
    const signal = options?.signal;
    const [conflict, photo, cloud] = await Promise.all([
      owner.core.getConflict(conflictBinding.id, signal),
      this.handle.rawPhoto(owner.photoId, options),
      this.loadCloud(signal),
    ]);
    this.assertCurrent();
    if (photo === null || photo.id !== owner.photoId || photo.original.sha256 !== owner.sourceSha256) {
      throw new PersonalPhotoCloudError("unsupported");
    }
    const candidate = publicCandidate(conflict.conflictingRecipe);
    const projected: Photo = {
      ...photo,
      recipe: {
        ...photo.recipe,
        settings: clone(conflict.conflictingRecipe.settings),
        settingsSha256: conflict.conflictingRecipe.settingsSha256,
        baseVersion: conflict.conflictingRecipe.baseVersion,
        maskSurfaceIds: clone(conflict.conflictingRecipe.maskSurfaceIds),
      },
    };
    const choice = Object.freeze({ kind: "develop-choice" as const });
    const choiceBinding: ChoiceBinding = {
      owner,
      conflict: conflictBinding,
      expectedRevision: photo.recipe.revision,
      canAdopt: projectRecipeSettings(projected, cloud, this.options.hostRenderer) !== null,
      intent: null,
    };
    this.choices.set(choice, choiceBinding);
    return Object.freeze({
      choice,
      candidate,
      current: publicCandidate(photo.recipe),
      historicalCurrent: publicCandidate(conflict.currentRecipe),
      expectedRevision: photo.recipe.revision,
      canAdopt: choiceBinding.canAdopt,
    });
  }

  private async loadCloud(signal?: AbortSignal): Promise<PersonalPhotoLibrary> {
    this.assertNetworkCurrent();
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const lifecycle = new AbortController();
    const link = signal === undefined
      ? linkedAbortController(lifecycle.signal)
      : linkedAbortController(lifecycle.signal, signal);
    try {
      const raw = await awaitBounded(this.options.client.request("library.get", {}, { signal: link.controller.signal }), {
        signal: link.controller.signal,
        timeoutMs,
        onTimeout: () => link.controller.abort(new PersonalPhotoCloudError("unavailable")),
      });
      this.assertCurrent();
      return validateLibrary(raw, this.actor.userId, this.options.client.scope.libraryId);
    } finally {
      link.dispose();
    }
  }
}

class BoundWriter implements PhotoLibraryDevelopDraftWriter {
  private disposed = false;

  constructor(
    readonly binding: DurableBinding,
    readonly core: PersonalPhotoRecipeWriter,
    readonly photoId: string,
    readonly sourceSha256: string,
    readonly token: PhotoLibraryDevelopDraftToken,
  ) {}

  stage(settings: DevelopSettings): PhotoLibraryDevelopDraftStage {
    this.assertOpen();
    const candidate = coreCandidate(settings);
    const core = this.core.stage(candidate);
    const stage = this.binding.publicStage(this, core, candidate);
    void stage.committed.finally(() => this.binding.changed());
    this.binding.changed();
    return stage;
  }

  async save(stage: PhotoLibraryDevelopDraftStage, options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryDevelopDraftSaveResult> {
    this.assertOpen();
    const bound = this.binding.stageBinding(stage, this);
    const result = await this.core.save(bound.core, options?.signal);
    this.binding.assertCurrent();
    const mapped = this.mapSave(result);
    this.binding.changed();
    return mapped;
  }

  async retry(options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryDevelopDraftSaveResult> {
    this.assertOpen();
    const result = await this.core.retry(options?.signal);
    const mapped = this.mapSave(result);
    this.binding.assertCurrent();
    this.binding.changed();
    return mapped;
  }

  async read(options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryDevelopDraftSnapshot> {
    this.assertOpen();
    const snapshot = await this.core.readDraft(options?.signal);
    this.binding.assertCurrent();
    const latestStage = snapshot.latest === null
      ? null
      : this.binding.publicStage(this, snapshot.latest.ref, snapshot.latest.candidate);
    return Object.freeze({
      latest: snapshot.latest === null ? null : publicCandidate(snapshot.latest.candidate),
      latestStage,
      attempted: snapshot.attempted === null ? null : publicCandidate(snapshot.attempted.candidate),
      hasUnknownAttempt: snapshot.hasUnknownAttempt,
      hasPendingResolution: snapshot.pendingResolution !== null,
      conflicts: Object.freeze(snapshot.conflictIds.map((id) => this.binding.publicConflict(this, id))),
      terminalReason: snapshot.terminalReason,
    });
  }

  async compare(
    conflict: PhotoLibraryDevelopConflictToken,
    options?: PhotoLibraryRequestOptions,
  ): Promise<PhotoLibraryDevelopConflictComparison> {
    this.assertOpen();
    return await this.binding.comparison(this, this.binding.conflictBinding(conflict, this), options);
  }

  async resolve(
    choice: PhotoLibraryDevelopChoiceToken,
    decision: "adopt" | "keep-current",
    options?: PhotoLibraryRequestOptions,
  ): Promise<PhotoLibraryDevelopConflictResolution> {
    this.assertOpen();
    const bound = this.binding.choiceBinding(choice, this);
    if (decision === "adopt" && !bound.canAdopt) return { kind: "unsupported" };
    if (bound.intent !== null && bound.intent.decision !== decision) invalid();
    bound.intent ??= Object.freeze({
      intentId: this.binding.newId(),
      conflictId: bound.conflict.id,
      decision,
      expectedRevision: bound.expectedRevision,
    });
    const result = await this.core.resolveConflict(bound.intent, options?.signal);
    this.binding.assertCurrent();
    this.binding.changed();
    return mapResolution(result);
  }

  async retryResolution(options?: PhotoLibraryRequestOptions): Promise<PhotoLibraryDevelopConflictResolution> {
    this.assertOpen();
    const result = await this.core.retryResolution(options?.signal);
    this.binding.assertCurrent();
    this.binding.changed();
    return mapResolution(result);
  }

  async discard(options?: PhotoLibraryRequestOptions): Promise<void> {
    this.assertOpen();
    await this.core.discard(options?.signal);
    this.binding.assertCurrent();
    this.binding.changed();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.core.dispose();
  }

  private mapSave(result: SaveRecipeResult): PhotoLibraryDevelopDraftSaveResult {
    if (result.status === "saved") {
      return { kind: "saved", revision: result.recipe.revision, updatedAt: result.recipe.updatedAt };
    }
    if (result.status === "conflict") {
      return { kind: "conflict", conflict: this.binding.publicConflict(this, result.conflict.id) };
    }
    if (result.status === "terminal") return { kind: "terminal", reason: result.reason };
    return { kind: result.status };
  }

  private assertOpen(): void {
    if (this.disposed) throw new PersonalPhotoCloudError("disposed");
    this.binding.assertCurrent();
  }
}

function coreCandidate(settings: DevelopSettings): LocalRecipeCandidate {
  const cloned = clone(settings);
  const read = readDevelopSettings(cloned);
  if (read === null) invalid();
  const base = read.base;
  if (base !== undefined && base !== null && typeof base !== "string") invalid();
  const maskSurfaceIds = readDevelopMasks(read).flatMap((mask) => "surface" in mask ? [mask.surface.id] : []);
  return {
    settings: cloned as LocalRecipeCandidate["settings"],
    baseVersion: typeof base === "string" ? base : null,
    maskSurfaceIds,
  };
}

function publicCandidate(
  candidate: Pick<RecipeCandidate, "settings" | "baseVersion" | "maskSurfaceIds"> |
    Pick<RecipeDocument, "settings" | "baseVersion" | "maskSurfaceIds"> |
    LocalRecipeCandidate,
): PhotoLibraryDevelopDraftCandidate {
  return Object.freeze({
    settings: clone(candidate.settings) as Readonly<Record<string, unknown>>,
    baseVersion: candidate.baseVersion,
    maskSurfaceIds: Object.freeze([...candidate.maskSurfaceIds]),
  });
}

function mapResolution(result: ResolveRecipeConflictResult): PhotoLibraryDevelopConflictResolution {
  if (result.status === "resolved") return { kind: "resolved", revision: result.resolution.recipe.revision };
  if (result.status === "terminal") return { kind: "terminal", reason: result.reason };
  return { kind: result.status };
}

function sameActor(left: VerifiedPhotoActor, right: VerifiedPhotoActor): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId &&
    left.sessionEpoch === right.sessionEpoch && left.transport === right.transport;
}

function clone<T>(value: T): T {
  try { return structuredClone(value); } catch { invalid(); }
}

function invalid(): never { throw new PersonalPhotoCloudError("invalid_response"); }
function invalidIdentity(): never { throw new PersonalPhotoCloudError("invalid_identity"); }
