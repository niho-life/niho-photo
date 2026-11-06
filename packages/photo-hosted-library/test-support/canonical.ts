/**
 * Synthetic NIHO canonical store for one hosted Mac library, following the B00 contract decisions. It stands in for
 * the private service in tests; it is not the production backend and grants nothing.
 *
 * The replica feed is a compacted log: the latest state of every (entity, id), deletions kept as tombstones, ordered
 * by revision. Any sinceRevision at or after the tombstone floor can be served; older ones must rebuild.
 */
import {
  compareIdempotency,
  decideHostedRecipeSave,
  decideReplicaPull,
} from "../../photo-library-sharing-contract/src/policy.ts";
import type {
  HostConnectorClient,
  IdempotencyRecord,
  IndexEntry,
  IndexResult,
  MutationReceipt,
  PhotoContent,
  RecipeDocument,
  ReplicaAlbumDefinition,
  ReplicaChange,
  ReplicaEntity,
  ReplicaPage,
  SharingErrorCode,
  SharingOperationMap,
} from "../../photo-library-sharing-contract/src/v1.ts";
import type { RestoreTargetView } from "../src/portability.ts";
import { canonicalSha256, sha256Hex } from "../src/shared.ts";

export const OWNER = "synthetic-user-a";
export const LIBRARY = "synthetic-library-hosted";

export const contractError = (code: SharingErrorCode): Error & { code: SharingErrorCode } =>
  Object.assign(new Error(`synthetic ${code}`), { code });
/** A transport failure with an unknown outcome. */
export const networkError = (): Error => new Error("synthetic network failure");

type Latest = ReplicaChange;
type HostedRecipeResult = { readonly recipe: RecipeDocument; readonly durability: "niho"; readonly replica: "current" | "pendingHost" };

const NEUTRAL = { v: 1, engine: "niho-14", exposure: 0, contrast: 0, saturation: 0 } as const;

export class SyntheticHostedCanonical {
  revision = 0;
  tombstoneFloor = 0;
  acknowledgedRevision = 0;
  connectorState: "online" | "sleeping" = "online";
  /** Fault injection for the next mutation: lose it before commit, or commit and lose the response. */
  nextFault: "failBeforeCommit" | "dropResponseAfterCommit" | null = null;
  corruptMaskContent = false;
  readonly calls: string[] = [];
  private readonly latest = new Map<string, Latest>();
  private readonly maskData = new Map<string, Uint8Array>();
  private readonly idempotency = new Map<string, { readonly record: IdempotencyRecord; readonly result: unknown }>();
  private nextPhoto = 1;

  private key(entity: ReplicaEntity, id: string): string {
    return `${entity}:${id}`;
  }
  private write(change: Omit<ReplicaChange, "revision">): void {
    this.revision++;
    this.latest.set(this.key(change.entity, change.id), { ...change, revision: this.revision } as ReplicaChange);
  }
  private upsert<E extends ReplicaEntity>(entity: E, id: string): Extract<ReplicaChange, { op: "upsert"; entity: E }> | null {
    const change = this.latest.get(this.key(entity, id));
    return change && change.op === "upsert" ? (change as Extract<ReplicaChange, { op: "upsert"; entity: E }>) : null;
  }
  private async mutate<T>(
    operation: IdempotencyRecord["operation"],
    key: string,
    payload: unknown,
    commit: () => Promise<T>,
  ): Promise<MutationReceipt<T>> {
    const record: IdempotencyRecord = {
      actor: operation.startsWith("connector.") ? { kind: "connector", connectorId: "synthetic-connector" } : { kind: "user", userId: OWNER },
      scope: { kind: "library", libraryId: LIBRARY },
      operation,
      key,
      payloadSha256: await canonicalSha256(payload),
    };
    const stored = this.idempotency.get(key);
    const outcome = compareIdempotency(stored?.record ?? null, record);
    if (outcome === "conflict") throw contractError("idempotency_conflict");
    if (outcome === "replay" && stored) return { value: stored.result as T, replayed: true };
    const fault = this.nextFault;
    this.nextFault = null;
    if (fault === "failBeforeCommit") throw networkError();
    const value = await commit();
    this.idempotency.set(key, { record, result: value });
    if (fault === "dropResponseAfterCommit") throw networkError();
    return { value, replayed: false };
  }

  /** connector.putIndex semantics: identity by localKey, lazy hashes, generations, exclusions never revived. */
  async putIndex(entries: readonly IndexEntry[]): Promise<readonly IndexResult[]> {
    const results: IndexResult[] = [];
    for (const entry of entries) {
      const existing = [...this.latest.values()].find(
        (change): change is Extract<ReplicaChange, { op: "upsert"; entity: "photo" }> =>
          change.op === "upsert" && change.entity === "photo" && change.body.localKey === entry.localKey,
      );
      if (!existing) {
        const photoId = `synthetic-hosted-photo-${this.nextPhoto++}`;
        this.write({ op: "upsert", entity: "photo", id: photoId, body: { ...entry, source: { ...entry.source, generation: 1 }, addedAt: "2026-11-07T00:00:00.000Z" } } as never);
        const recipe: RecipeDocument = {
          revision: 0, settings: NEUTRAL, settingsSha256: await canonicalSha256(NEUTRAL), baseVersion: null, maskSurfaceIds: [],
          updatedAt: "2026-11-07T00:00:00.000Z",
        };
        this.write({ op: "upsert", entity: "recipe", id: photoId, body: { recipe, recipeSourceGeneration: 1 } } as never);
        results.push({ localKey: entry.localKey, photoId, state: "added" });
        continue;
      }
      const photoId = existing.id;
      if (this.upsert("exclusion", photoId)) {
        results.push({ localKey: entry.localKey, photoId, state: "excluded" });
        continue;
      }
      const known = existing.body.source;
      if (entry.source.sha256 === null || entry.source.sha256 === known.sha256) {
        // Not hashed yet (still arriving) or the same bytes: never wipe or bump the recorded identity.
        results.push({ localKey: entry.localKey, photoId, state: "unchanged" });
        continue;
      }
      const sameGeneration = known.sha256 === null && entry.source.sizeBytes === known.sizeBytes;
      const source = { ...entry.source, generation: sameGeneration ? known.generation : known.generation + 1 };
      this.write({ op: "upsert", entity: "photo", id: photoId, body: { ...existing.body, source, fileName: entry.fileName, capturedAt: entry.capturedAt } } as never);
      results.push({ localKey: entry.localKey, photoId, state: "updated" });
    }
    return results;
  }

  /** Simplified hosted mask upload (start + complete): stored by hash before any recipe may reference it. */
  async putMask(photoId: string, bytes: Uint8Array): Promise<string> {
    const surfaceId = await sha256Hex(bytes);
    const id = `${photoId}:${surfaceId}`;
    this.maskData.set(id, bytes);
    this.write({ op: "upsert", entity: "mask", id, body: { photoId, surfaceId, sizeBytes: bytes.byteLength, width: 4, height: 4 } } as never);
    return surfaceId;
  }

  async putRecipe(
    request: SharingOperationMap["hostedRecipes.put"]["request"],
    idempotencyKey: string,
  ): Promise<MutationReceipt<HostedRecipeResult>> {
    return this.mutate("hostedRecipes.put", idempotencyKey, request, async () => {
      const photo = this.upsert("photo", request.photoId);
      const current = this.upsert("recipe", request.photoId);
      if (request.libraryId !== LIBRARY || !photo || !current || this.upsert("exclusion", request.photoId)) throw contractError("not_found");
      const listed = (request.settings as unknown as { masks?: unknown }).masks;
      const masks = Array.isArray(listed)
        ? listed.map((mask: { surface?: { id?: unknown } }) => mask?.surface?.id).filter((id): id is string => typeof id === "string")
        : [];
      const stored = [...this.latest.values()]
        .filter((change) => change.op === "upsert" && change.entity === "mask" && change.body.photoId === request.photoId)
        .map((change) => (change.op === "upsert" && change.entity === "mask" ? change.body.surfaceId : ""));
      const decision = decideHostedRecipeSave({
        expectedRevision: request.expectedRevision,
        currentRevision: current.body.recipe.revision,
        sourceGeneration: request.sourceGeneration,
        currentSourceGeneration: photo.body.source.generation,
        referencedMaskSurfaceIds: masks,
        storedMaskSurfaceIds: stored,
        connectorState: this.connectorState,
      });
      if (!decision.ok) throw contractError(decision.code);
      const recipe: RecipeDocument = {
        revision: current.body.recipe.revision + 1,
        settings: request.settings,
        settingsSha256: await canonicalSha256(request.settings),
        baseVersion: request.baseVersion,
        maskSurfaceIds: masks,
        updatedAt: "2026-11-07T00:00:00.000Z",
      };
      this.write({ op: "upsert", entity: "recipe", id: request.photoId, body: { recipe, recipeSourceGeneration: request.sourceGeneration } } as never);
      return { recipe, durability: "niho", replica: decision.replica };
    });
  }

  exclude(photoId: string): void {
    this.write({ op: "upsert", entity: "exclusion", id: photoId, body: { excludedAt: "2026-11-07T00:00:00.000Z" } } as never);
  }
  defineAlbum(albumId: string, name: string, items: ReplicaAlbumDefinition["items"]): void {
    const revision = (this.upsert("albumDefinition", albumId)?.body.revision ?? 0) + 1;
    this.write({ op: "upsert", entity: "albumDefinition", id: albumId, body: { name, revision, items } } as never);
  }
  deleteAlbum(albumId: string): void {
    this.write({ op: "delete", entity: "albumDefinition", id: albumId } as never);
  }
  /** Drops tombstones older than floor; replicas behind it must rebuild. */
  compact(floor: number): void {
    for (const [key, change] of this.latest) if (change.op === "delete" && change.revision < floor) this.latest.delete(key);
    this.tombstoneFloor = floor;
  }

  pull(sinceRevision: number, limit: number): ReplicaPage {
    const decision = decideReplicaPull({ sinceRevision, retainedFromRevision: this.tombstoneFloor, canonicalRevision: this.revision });
    if (!decision.ok) throw contractError(decision.code);
    const after = [...this.latest.values()]
      .filter((change) => change.revision > sinceRevision && !(sinceRevision === 0 && change.op === "delete"))
      .sort((a, b) => a.revision - b.revision);
    const changes = after.slice(0, limit);
    const complete = changes.length === after.length;
    const last = changes.at(-1);
    return { sinceRevision, changes, nextRevision: complete ? this.revision : last?.revision ?? sinceRevision, complete };
  }

  /** Connector transport over this store: only the outbound connector operations exist. */
  client(): Pick<HostConnectorClient, "request"> {
    const request = async (operation: string, body: Record<string, unknown>, options: { idempotencyKey?: string }): Promise<unknown> => {
      this.calls.push(operation);
      if (operation === "connector.pullReplica") return this.pull(body.sinceRevision as number, (body.limit as number | undefined) ?? 500);
      if (operation === "connector.getReplicaContent") {
        const data = this.maskData.get(body.id as string);
        const change = this.upsert("mask", body.id as string);
        if (!data || !change) throw contractError("not_found");
        const bytes = this.corruptMaskContent ? new Uint8Array(data.byteLength).fill(7) : data;
        const content: PhotoContent = {
          body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
          contentType: "image/png", sha256: change.body.surfaceId, totalBytes: data.byteLength,
          range: { start: 0, endInclusive: data.byteLength - 1 },
        };
        return content;
      }
      if (operation === "connector.ackReplica") {
        return this.mutate("connector.ackReplica", options.idempotencyKey ?? "", body, async () => {
          const revision = body.revision as number;
          if (revision > this.revision) throw contractError("invalid_request");
          this.acknowledgedRevision = Math.max(this.acknowledgedRevision, revision);
          return { acknowledgedRevision: this.acknowledgedRevision, state: this.acknowledgedRevision >= this.revision ? "current" : "pendingHost" };
        });
      }
      throw contractError("not_found");
    };
    return { request: request as unknown as HostConnectorClient["request"] };
  }

  /** What a restore planner sees for this library. */
  restoreView(): RestoreTargetView {
    return {
      photo: (photoId) => {
        const photo = this.upsert("photo", photoId);
        const recipe = this.upsert("recipe", photoId);
        return photo && recipe ? { sourceSha256: photo.body.source.sha256, recipeRevision: recipe.body.recipe.revision } : null;
      },
      album: (albumId) => {
        const album = this.upsert("albumDefinition", albumId);
        return album ? { revision: album.body.revision } : null;
      },
    };
  }
  recipeOf(photoId: string): RecipeDocument | null {
    return this.upsert("recipe", photoId)?.body.recipe ?? null;
  }
  photoOf(photoId: string) {
    return this.upsert("photo", photoId)?.body ?? null;
  }
  /** Current (entity, id) → upsert body, for comparing with a replica. */
  state(): Map<string, unknown> {
    return new Map([...this.latest].filter(([, change]) => change.op === "upsert").map(([key, change]) => [key, change.op === "upsert" ? change.body : null]));
  }
}
