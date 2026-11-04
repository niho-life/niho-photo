import {
  createPersonalPhotoCloudLibrary as createCloudLibrary,
  type CreatePersonalPhotoCloudLibraryOptions,
  type PersonalPhotoCloudLibraryHandle,
} from "@niho/photo-cloud-library";
import {
  PersonalPhotoCloudError,
  awaitBounded,
  contentBytes,
  linkedAbortController,
  projectRecipeSettings,
  readPhotoError,
  rendererIntersection,
  validateLibrary,
} from "@niho/photo-cloud-library/protocol";
import {
  runPersonalPhotoResumableUpload,
  type PersonalPhotoResumableUploadState,
} from "@niho/photo-cloud-library/browser";
import { sha256 } from "@noble/hashes/sha2.js";
import type {
  PersonalPhotoLibrary,
  Photo,
  PhotoAsset,
  RecipeCandidate,
  RecipeDocument,
  VerifiedPhotoActor,
} from "@niho/photo-personal-cloud-contract";
import { PHOTO_LIMITS } from "@niho/photo-personal-cloud-contract";
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
  BrowserMaskSurfaceBindingOptions,
  LocalRecipeCandidate,
  MaskSurfacePinLease,
  PersonalPhotoRecipeSync,
  PersonalPhotoRecipeWriter,
  PreviousRecipeWriterToken,
  RecipeConflictIntent,
  RecipeJournalScope,
  RecipeMaskSurfaceBarrier,
  RecipeStageRef,
  RecipeWriterBinding,
  ResolveRecipeConflictResult,
  SaveRecipeResult,
} from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;
const LIST_LIMIT = 16;

export type CreatePersonalPhotoCloudLibraryWithSyncOptions = CreatePersonalPhotoCloudLibraryOptions & BrowserMaskSurfaceBindingOptions & Pick<
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
  let masks: BrowserMaskSurfaceService | null = null;
  const maskSurfaceReader = options.maskSurfaceValidator === undefined ? undefined : {
    async loadMaskSurface(photoId: string, surfaceId: string): Promise<Uint8Array | null> {
      if (masks === null) throw new PersonalPhotoCloudError("unavailable");
      return await masks.load(photoId, surfaceId);
    },
  };
  const base = createCloudLibrary({
    ...options,
    ...(maskSurfaceReader === undefined ? {} : { maskSurfaceReader }),
  });
  masks = options.maskSurfaceValidator === undefined ? null : new BrowserMaskSurfaceService(options, base);
  const maskService = masks;
  let sync: PersonalPhotoRecipeSync;
  try {
    sync = createPersonalPhotoRecipeSync({
      client: options.client,
      identity: options.identity,
      hostRenderer: options.hostRenderer,
      journal: options.journal,
      locks: options.locks,
      ...(maskService === null ? {} : { maskSurfaceBarrier: maskService }),
      ...(options.clock === undefined ? {} : { now: options.clock.now }),
      ...(options.randomId === undefined ? {} : { randomId: options.randomId }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  } catch (error) {
    base.dispose();
    throw error;
  }
  const durable = new DurableBinding(options, base, sync, maskService);
  let disposed = false;
  return {
    ...base,
    library: {
      ...base.library,
      durableDevelopDrafts: durable.port,
      ...(maskService === null ? {} : {
        capabilities: async (requestOptions?: PhotoLibraryRequestOptions) => ({
          ...await base.library.capabilities(requestOptions),
          maskSurfaces: await maskService.capable(requestOptions?.signal),
        }),
        saveMaskSurface: (photoId: string, png: Uint8Array) => durable.saveMaskSurface(photoId, png),
        loadMaskSurface: (photoId: string, surfaceId: string) => maskService.load(photoId, surfaceId),
      }),
    },
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
  private readonly previousTokens = new WeakMap<PhotoLibraryDevelopDraftToken, PreviousRecipeWriterToken>();
  private readonly stages = new WeakMap<PhotoLibraryDevelopDraftStage, StageBinding>();
  private readonly conflicts = new WeakMap<PhotoLibraryDevelopConflictToken, ConflictBinding>();
  private readonly choices = new WeakMap<PhotoLibraryDevelopChoiceToken, ChoiceBinding>();
  private readonly listeners = new Set<() => void>();
  private readonly activeWriters = new Map<string, Set<BoundWriter>>();
  private readonly unsubscribeIdentity: () => void;
  private disposed = false;

  constructor(
    readonly options: CreatePersonalPhotoCloudLibraryWithSyncOptions,
    readonly handle: PersonalPhotoCloudLibraryHandle,
    readonly sync: PersonalPhotoRecipeSync,
    readonly masks: BrowserMaskSurfaceService | null,
  ) {
    const actor = options.identity.getSnapshot();
    if (actor === null) invalidIdentity();
    this.actor = actor;
    this.unsubscribeIdentity = options.identity.subscribe(() => this.changed());
    this.port = {
      ...(sync.previous === undefined ? {} : {
        previous: {
          list: (query, requestOptions) => this.listPrevious(query, requestOptions),
          reopen: (token, requestOptions) => this.reopenPrevious(token, requestOptions),
        },
      }),
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
    this.activeWriters.clear();
  }

  registerWriter(writer: BoundWriter): void {
    if (writer.previous) return;
    const writers = this.activeWriters.get(writer.photoId) ?? new Set<BoundWriter>();
    writers.add(writer);
    this.activeWriters.set(writer.photoId, writers);
  }

  unregisterWriter(writer: BoundWriter): void {
    const writers = this.activeWriters.get(writer.photoId);
    writers?.delete(writer);
    if (writers?.size === 0) this.activeWriters.delete(writer.photoId);
  }

  async saveMaskSurface(photoId: string, png: Uint8Array): Promise<{ id: string; width: number; height: number }> {
    this.assertCurrent();
    const writers = [...(this.activeWriters.get(photoId) ?? [])].filter((writer) => writer.open);
    if (this.masks === null || writers.length !== 1) throw new PersonalPhotoCloudError("unavailable");
    return await this.masks.save(photoId, png, writers[0]!.core.token);
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
    return new BoundWriter(this, core, input.photoId, input.sourceSha256, this.publicToken(core.token), false);
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
    return new BoundWriter(this, reopened.writer, snapshot.photoId, snapshot.sourceSha256, token, false);
  }

  private async listPrevious(
    query: { cursor?: string; limit?: number } = {},
    options?: PhotoLibraryRequestOptions,
  ): Promise<{ items: readonly PhotoLibraryDevelopDraftSummary[]; nextCursor: string | null }> {
    this.assertNetworkCurrent();
    const previous = this.sync.previous;
    if (previous === undefined) invalid();
    const limit = Math.min(LIST_LIMIT, query.limit ?? LIST_LIMIT);
    const page = await previous.listPending({ ...query, limit }, options?.signal);
    this.assertNetworkCurrent();
    return {
      items: page.writers.map((item) => {
        const token = Object.freeze({ kind: "develop-draft" as const });
        this.previousTokens.set(token, item.token);
        return Object.freeze({
          token,
          photoId: item.photoId,
          hasLatest: item.hasLatest,
          hasUnknownAttempt: item.hasUnknownAttempt,
          conflictCount: item.conflictIds.length,
        });
      }),
      nextCursor: page.nextCursor,
    };
  }

  private async reopenPrevious(
    token: PhotoLibraryDevelopDraftToken,
    options?: PhotoLibraryRequestOptions,
  ): Promise<PhotoLibraryDevelopDraftWriter> {
    this.assertNetworkCurrent();
    const previous = this.sync.previous;
    const coreToken = this.previousTokens.get(token);
    if (previous === undefined || coreToken === undefined) invalid();
    const reopened = await previous.reopen(coreToken, options?.signal);
    this.assertNetworkCurrent();
    const snapshot = await reopened.writer.readDraft(options?.signal);
    this.assertNetworkCurrent();
    return new BoundWriter(this, reopened.writer, snapshot.photoId, snapshot.sourceSha256, token, true);
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
      canAdopt: projectRecipeSettings(projected, cloud, this.options.hostRenderer, this.masks !== null) !== null,
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

class BrowserMaskSurfaceService implements RecipeMaskSurfaceBarrier {
  private readonly pending = new Map<string, Map<string, MaskSurfacePinLease[]>>();

  constructor(
    private readonly options: CreatePersonalPhotoCloudLibraryWithSyncOptions,
    private readonly handle: PersonalPhotoCloudLibraryHandle,
  ) {}

  async capable(signal?: AbortSignal): Promise<boolean> {
    try {
      const scope = this.scope();
      if (scope.transport === "mac-bearer" && this.options.maskSurfaceTransport === undefined) return false;
      const raw = await this.options.client.request("library.get", {}, { signal: signal ?? new AbortController().signal });
      this.assertScope(scope);
      const library = validateLibrary(raw, scope.actorId, scope.libraryId);
      const renderer = rendererIntersection(library.capabilities.renderer, this.options.hostRenderer);
      return library.state === "active" && library.capabilities.edits && library.capabilities.maskSurfaces &&
        renderer !== null && renderer.maskSurfaces && renderer.features.includes("masks");
    } catch { return false; }
  }

  async save(
    photoId: string,
    input: Uint8Array,
    writerId: string,
  ): Promise<{ id: string; width: number; height: number }> {
    const scope = this.scope();
    const bytes = checkedBytes(input);
    const validated = await this.validate(bytes);
    this.assertScope(scope);
    const lease = { writerId, pinToken: this.newId() } satisfies MaskSurfacePinLease;
    await this.options.journal.putMaskSurface(scope, photoId, {
      ...validated,
      sha256: validated.id,
      bytes,
      uploadState: null,
    }, undefined, lease);
    this.assertScope(scope);
    const bySurface = this.pending.get(writerId) ?? new Map<string, MaskSurfacePinLease[]>();
    bySurface.set(validated.id, [...(bySurface.get(validated.id) ?? []), lease]);
    this.pending.set(writerId, bySurface);
    return validated;
  }

  async load(photoId: string, surfaceId: string): Promise<Uint8Array | null> {
    const scope = this.scope();
    validateSha(surfaceId);
    const local = await this.options.journal.getMaskSurface(scope, photoId, surfaceId);
    this.assertScope(scope);
    if (local !== null) {
      const bytes = checkedBytes(local.bytes);
      const validated = await this.validate(bytes);
      this.assertScope(scope);
      if (validated.id !== surfaceId || validated.width !== local.width || validated.height !== local.height) invalid();
      return bytes;
    }
    let asset: PhotoAsset;
    try {
      asset = await this.options.client.request("masks.get", { photoId, surfaceId }, { signal: new AbortController().signal });
    } catch (error) {
      if (readPhotoError(error)?.code === "not_found") return null;
      throw error;
    }
    this.assertScope(scope);
    validateMaskAsset(asset, surfaceId);
    const content = await this.handle.readAsset(photoId, asset);
    const bytes = checkedBytes(await contentBytes(content));
    this.assertScope(scope);
    const validated = await this.validate(bytes);
    this.assertScope(scope);
    if (validated.id !== surfaceId || validated.width !== asset.width || validated.height !== asset.height) invalid();
    await this.options.journal.putMaskSurface(scope, photoId, {
      ...validated,
      sha256: validated.id,
      bytes,
      uploadState: null,
    }, undefined, null);
    this.assertScope(scope);
    return bytes;
  }

  snapshot(writerId: string): readonly MaskSurfacePinLease[] {
    const pending = this.pending.get(writerId);
    if (pending === undefined) return [];
    return Object.freeze([...pending.values()].flat().map((lease) => Object.freeze({ ...lease })));
  }

  settled(writerId: string, leases: readonly MaskSurfacePinLease[]): void {
    const pending = this.pending.get(writerId);
    if (pending === undefined) return;
    const settled = new Set(leases.map((lease) => lease.pinToken));
    for (const [surfaceId, current] of pending) {
      const remaining = current.filter((lease) => !settled.has(lease.pinToken));
      if (remaining.length === 0) pending.delete(surfaceId);
      else pending.set(surfaceId, remaining);
    }
    if (pending.size === 0) this.pending.delete(writerId);
  }

  async releaseWriter(writerId: string, signal?: AbortSignal): Promise<void> {
    const scope = this.scope();
    await this.options.journal.releaseMaskSurfaceLeases(scope, writerId, undefined, signal);
    this.assertScope(scope);
    this.pending.delete(writerId);
  }

  async ensureStored(
    binding: RecipeWriterBinding,
    candidate: LocalRecipeCandidate,
    recovered: boolean,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<void> {
    const currentScope = this.scope();
    if (binding.actorId !== currentScope.actorId || binding.libraryId !== currentScope.libraryId) invalid();
    const dimensions = surfaceDimensions(candidate);
    const missing: Array<{ surfaceId: string; expected: { width: number; height: number } }> = [];
    for (const surfaceId of candidate.maskSurfaceIds) {
      assertCurrent();
      const expected = dimensions.get(surfaceId);
      if (expected === undefined) invalid();
      const existing = await this.freshAsset(binding.photoId, surfaceId, signal);
      assertCurrent();
      if (existing !== null) {
        assertMaskDimensions(existing, expected);
        const local = await this.options.journal.getMaskSurface(currentScope, binding.photoId, surfaceId, signal);
        assertCurrent();
        if (local !== null && local.uploadState !== null) {
          if (local.bytes.byteLength !== existing.sizeBytes || local.width !== existing.width || local.height !== existing.height) invalid();
          if (!await this.options.journal.compareAndSetMaskUploadState(
            currentScope, binding.photoId, surfaceId, local.uploadState, null, signal,
          )) throw new PersonalPhotoCloudError("unavailable");
          assertCurrent();
        }
      } else missing.push({ surfaceId, expected });
    }

    for (const { surfaceId, expected } of missing) {
      const sourceScope = recovered ? scopeOfBinding(binding) : currentScope;
      const source = await this.options.journal.getMaskSurface(sourceScope, binding.photoId, surfaceId, signal);
      assertCurrent();
      if (source === null || source.id !== surfaceId || source.sha256 !== surfaceId ||
        source.width !== expected.width || source.height !== expected.height) throw new PersonalPhotoCloudError("unsupported");
      const bytes = checkedBytes(source.bytes);
      const validated = await this.validate(bytes);
      assertCurrent();
      if (validated.id !== surfaceId || validated.width !== expected.width || validated.height !== expected.height) invalid();

      if (recovered) {
        await this.options.journal.putMaskSurface(currentScope, binding.photoId, {
          id: surfaceId,
          width: expected.width,
          height: expected.height,
          sha256: surfaceId,
          bytes,
          uploadState: null,
        }, signal, null);
        assertCurrent();
      }
      await this.upload(currentScope, binding.photoId, surfaceId, expected, bytes, signal, assertCurrent);
    }
  }

  private async upload(
    scope: RecipeJournalScope,
    photoId: string,
    surfaceId: string,
    expected: { readonly width: number; readonly height: number },
    bytes: Uint8Array,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<void> {
    let local = await this.options.journal.getMaskSurface(scope, photoId, surfaceId, signal);
    assertCurrent();
    if (local === null) throw new PersonalPhotoCloudError("unsupported");
    if (local.uploadState === null) {
      const initial: PersonalPhotoResumableUploadState = {
        target: { kind: "mask", photoId },
        sizeBytes: bytes.byteLength,
        sha256: surfaceId,
        contentType: "image/png",
        startKey: this.newId(),
        completeKey: this.newId(),
        cancelKey: this.newId(),
        uploadId: null,
        deadline: null,
        offsetBytes: 0,
        phase: "start-pending",
      };
      if (!await this.options.journal.compareAndSetMaskUploadState(scope, photoId, surfaceId, null, initial, signal)) {
        local = await this.options.journal.getMaskSurface(scope, photoId, surfaceId, signal);
        assertCurrent();
        if (local === null || local.uploadState === null) throw new PersonalPhotoCloudError("unavailable");
      } else local = { ...local, uploadState: initial };
    }
    let durable = local.uploadState;
    if (durable === null) throw new PersonalPhotoCloudError("unavailable");
    if (durable.phase === "expired" || durable.phase === "cancelled") {
      const renewed: PersonalPhotoResumableUploadState = {
        ...durable,
        startKey: this.newId(), completeKey: this.newId(), cancelKey: this.newId(),
        uploadId: null, deadline: null, offsetBytes: 0, phase: "start-pending",
      };
      if (!await this.options.journal.compareAndSetMaskUploadState(scope, photoId, surfaceId, durable, renewed, signal)) {
        throw new PersonalPhotoCloudError("unavailable");
      }
      assertCurrent();
      durable = renewed;
    }
    for (let pass = 0; pass < 4; pass += 1) {
      const store = {
        compareAndSet: async (before: PersonalPhotoResumableUploadState, next: PersonalPhotoResumableUploadState) => {
          if (JSON.stringify(before) !== JSON.stringify(durable)) throw new PersonalPhotoCloudError("unavailable");
          if (!await this.options.journal.compareAndSetMaskUploadState(scope, photoId, surfaceId, before, next, signal)) {
            throw new PersonalPhotoCloudError("unavailable");
          }
          durable = next;
        },
      };
      const result = await runPersonalPhotoResumableUpload({
        ...(this.options.maskSurfaceTransport === undefined
          ? { client: this.options.client }
          : { transport: this.options.maskSurfaceTransport }),
        state: durable,
        source: new Blob([bytes.slice().buffer], { type: "image/png" }),
        store,
        signal,
        ...(this.options.clock === undefined ? {} : { now: this.options.clock.now }),
        assertCurrent,
      });
      assertCurrent();
      durable = result.state;
      if (result.error !== null) throw result.error;
      if (result.stored?.kind === "mask") assertMaskDimensions(result.stored.asset, expected);
      const confirmed = await this.freshAsset(photoId, surfaceId, signal);
      assertCurrent();
      if (confirmed !== null) {
        assertMaskDimensions(confirmed, expected);
        if (confirmed.sizeBytes !== bytes.byteLength) invalid();
        if (!await this.options.journal.compareAndSetMaskUploadState(scope, photoId, surfaceId, durable, null, signal)) {
          throw new PersonalPhotoCloudError("unavailable");
        }
        return;
      }
      if (!["uploading", "complete-pending", "verifying"].includes(durable.phase)) break;
    }
    throw new PersonalPhotoCloudError("unavailable");
  }

  private async freshAsset(photoId: string, surfaceId: string, signal: AbortSignal): Promise<PhotoAsset | null> {
    try {
      const asset = await this.options.client.request("masks.get", { photoId, surfaceId }, { signal });
      validateMaskAsset(asset, surfaceId);
      return asset;
    } catch (error) {
      if (readPhotoError(error)?.code === "not_found") return null;
      throw error;
    }
  }

  private async validate(bytes: Uint8Array): Promise<{ id: string; width: number; height: number }> {
    const validator = this.options.maskSurfaceValidator;
    if (validator === undefined) invalid();
    const result = await validator.validateMaskSurface(bytes.slice());
    if (!isMaskInfo(result) || result.id !== digestBytes(bytes)) invalid();
    return Object.freeze({ ...result });
  }

  private scope(): RecipeJournalScope {
    const actor = this.options.identity.getSnapshot();
    const now = this.options.clock?.now() ?? Date.now();
    if (actor === null || Date.parse(actor.expiresAt) <= now ||
      actor.userId !== this.options.client.scope.actorId || actor.sessionEpoch !== this.options.client.scope.sessionEpoch) {
      throw new PersonalPhotoCloudError("scope_changed");
    }
    return {
      actorId: actor.userId,
      libraryId: this.options.client.scope.libraryId,
      sessionId: actor.sessionId,
      sessionEpoch: actor.sessionEpoch,
      transport: actor.transport,
    };
  }

  private assertScope(scope: RecipeJournalScope): void {
    const current = this.scope();
    if (JSON.stringify(current) !== JSON.stringify(scope)) throw new PersonalPhotoCloudError("scope_changed");
  }

  private newId(): string {
    const value = (this.options.randomId ?? (() => crypto.randomUUID()))();
    if (typeof value !== "string" || value.length === 0 || value.length > PHOTO_LIMITS.maxIdempotencyKeyBytes) invalid();
    return value;
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
    readonly previous: boolean,
  ) { binding.registerWriter(this); }

  get open(): boolean { return !this.disposed; }

  stage(settings: DevelopSettings): PhotoLibraryDevelopDraftStage {
    this.assertOpen();
    const candidate = coreCandidate(settings);
    const leases = this.binding.masks?.snapshot(this.core.token) ?? [];
    const core = this.core.stage(candidate, leases);
    void core.committed.then((result) => {
      if (result.status === "committed") this.binding.masks?.settled(this.core.token, leases);
    });
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
    await this.binding.masks?.releaseWriter(this.core.token, options?.signal);
    this.binding.assertCurrent();
    this.binding.changed();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.binding.unregisterWriter(this);
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

function scopeOfBinding(binding: RecipeWriterBinding): RecipeJournalScope {
  return {
    actorId: binding.actorId,
    libraryId: binding.libraryId,
    sessionId: binding.sessionId,
    sessionEpoch: binding.sessionEpoch,
    transport: binding.transport,
  };
}

function surfaceDimensions(candidate: LocalRecipeCandidate): Map<string, { width: number; height: number }> {
  const dimensions = new Map<string, { width: number; height: number }>();
  for (const mask of readDevelopMasks(candidate.settings)) {
    if (!("surface" in mask)) continue;
    if (dimensions.has(mask.surface.id)) invalid();
    dimensions.set(mask.surface.id, { width: mask.surface.width, height: mask.surface.height });
  }
  if (dimensions.size !== candidate.maskSurfaceIds.length || candidate.maskSurfaceIds.some((id) => !dimensions.has(id))) invalid();
  return dimensions;
}

function checkedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > PHOTO_LIMITS.maxMaskBytes) invalid();
  return new Uint8Array(value).slice();
}

function validateMaskAsset(asset: PhotoAsset, surfaceId: string): void {
  if (
    asset.kind !== "mask" || asset.sha256 !== surfaceId || asset.contentType !== "image/png" ||
    !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 1 || asset.sizeBytes > PHOTO_LIMITS.maxMaskBytes ||
    !Number.isSafeInteger(asset.width) || asset.width < 1 || asset.width > PHOTO_LIMITS.maxMaskEdge ||
    !Number.isSafeInteger(asset.height) || asset.height < 1 || asset.height > PHOTO_LIMITS.maxMaskEdge
  ) invalid();
}

function assertMaskDimensions(asset: PhotoAsset, expected: { width: number; height: number }): void {
  if (asset.width !== expected.width || asset.height !== expected.height) invalid();
}

function isMaskInfo(value: unknown): value is { id: string; width: number; height: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === "height,id,width" &&
    typeof record.id === "string" && /^[0-9a-f]{64}$/u.test(record.id) &&
    typeof record.width === "number" && Number.isSafeInteger(record.width) && record.width >= 1 &&
    record.width <= PHOTO_LIMITS.maxMaskEdge &&
    typeof record.height === "number" && Number.isSafeInteger(record.height) && record.height >= 1 &&
    record.height <= PHOTO_LIMITS.maxMaskEdge;
}

function validateSha(value: string): void { if (!/^[0-9a-f]{64}$/u.test(value)) invalid(); }
function digestBytes(value: Uint8Array): string {
  return Array.from(sha256(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function clone<T>(value: T): T {
  try { return structuredClone(value); } catch { invalid(); }
}

function invalid(): never { throw new PersonalPhotoCloudError("invalid_response"); }
function invalidIdentity(): never { throw new PersonalPhotoCloudError("invalid_identity"); }
