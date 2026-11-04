import type {
  PersonalPhotoCloudClient,
  PhotoOperation,
  PhotoOperationMap,
  PhotoRequestOptions,
  VerifiedPhotoActor,
} from "@niho/photo-personal-cloud-contract";
import { sha256 } from "@noble/hashes/sha2.js";
import { deflateSync as zlibDeflateSync } from "node:zlib";
import { IDS, library, responses } from "@niho/photo-personal-cloud-contract/fixtures";
import type { PhotoLibraryPresets } from "niho-photo-editing/library/photo-library";
import { afterEach } from "vitest";

import { createPersonalPhotoCloudLibrary } from "../src/index";
import type { CreatePersonalPhotoCloudLibraryOptions, PersonalPhotoCloudIdentity } from "../src/index";

export type RecordedCall = {
  operation: PhotoOperation;
  request: unknown;
  signal: AbortSignal;
  idempotencyKey: string | null;
};

export class FakeClient implements PersonalPhotoCloudClient {
  readonly scope: { actorId: string; libraryId: string; sessionEpoch: string } = {
    actorId: IDS.userA,
    libraryId: IDS.library,
    sessionEpoch: "epoch-1",
  };
  readonly calls: RecordedCall[] = [];
  disposeCount = 0;
  libraryResponse: PhotoOperationMap["library.get"]["response"] | null = null;
  dispatch: ((operation: PhotoOperation, request: unknown, options: { signal: AbortSignal; idempotencyKey: string | null }) => Promise<unknown>) | null = null;

  async request<K extends PhotoOperation>(
    operation: K,
    request: PhotoOperationMap[K]["request"],
    options: PhotoRequestOptions<K>,
  ): Promise<PhotoOperationMap[K]["response"]> {
    const idempotencyKey = "idempotencyKey" in options ? options.idempotencyKey ?? null : null;
    this.calls.push({ operation, request, signal: options.signal, idempotencyKey });
    if (operation === "library.get" && this.libraryResponse !== null) return this.libraryResponse as PhotoOperationMap[K]["response"];
    const value = this.dispatch
      ? await this.dispatch(operation, request, { signal: options.signal, idempotencyKey })
      : defaultResponse(operation, request);
    return value as PhotoOperationMap[K]["response"];
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}

export class FakeIdentity implements PersonalPhotoCloudIdentity {
  private readonly listeners = new Set<() => void>();

  constructor(private actor: VerifiedPhotoActor | null = defaultActor()) {}

  getSnapshot(): VerifiedPhotoActor | null {
    return this.actor;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(actor: VerifiedPhotoActor | null): void {
    this.actor = actor;
    for (const listener of this.listeners) listener();
  }
}

export function defaultActor(overrides: Partial<VerifiedPhotoActor> = {}): VerifiedPhotoActor {
  return {
    userId: IDS.userA,
    sessionId: "parent-1",
    sessionEpoch: "epoch-1",
    transport: "browser-session",
    expiresAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeHandle(
  client = new FakeClient(),
  identity = new FakeIdentity(),
  overrides: Partial<CreatePersonalPhotoCloudLibraryOptions> = {},
) {
  const handle = createPersonalPhotoCloudLibrary({
    client,
    identity,
    hostRenderer: library.capabilities.renderer,
    engineAssets: { manifestUrl: () => "/synthetic-manifest.json" },
    presets,
    memoryBudgets: {
      originalBytes: 4 * 1024 ** 2,
      workingCopyBytes: 2 * 1024 ** 2,
      previewBytes: 1024 ** 2,
    },
    clock: { now: () => Date.parse("2026-11-03T00:00:00.000Z") },
    urls: {
      createObjectURL: () => "blob:synthetic",
      revokeObjectURL: () => undefined,
    },
    ...overrides,
  });
  activeHandles.add(handle);
  return handle;
}

export function stream(bytes: Uint8Array, onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

export function defaultResponse(operation: PhotoOperation, request: unknown): unknown {
  if (operation === "content.get") {
    const body = request as PhotoOperationMap["content.get"]["request"];
    const asset = [responses["photos.get"].original, responses["photos.get"].media.state === "ready" ? responses["photos.get"].media.thumbnail : null]
      .find((candidate) => candidate?.id === body.assetId);
    if (!asset) throw new Error("missing synthetic content response");
    const start = body.range?.start ?? 0;
    const endInclusive = body.range?.endInclusive ?? asset.sizeBytes - 1;
    return {
      body: stream(new Uint8Array(endInclusive - start + 1)),
      contentType: asset.contentType,
      sha256: asset.sha256,
      totalBytes: asset.sizeBytes,
      range: { start, endInclusive },
    } satisfies PhotoOperationMap["content.get"]["response"];
  }
  if (operation === "library.get") return responses["library.get"];
  if (operation === "photos.list") return responses["photos.list"];
  if (operation === "photos.get") return responses["photos.get"];
  if (operation === "photos.info") return responses["photos.info"];
  if (operation === "photos.lookup") return responses["photos.lookup"];
  if (operation === "uploads.start") return responses["uploads.start"];
  if (operation === "uploads.get") return responses["uploads.get"];
  if (operation === "uploads.renew") return responses["uploads.renew"];
  if (operation === "uploads.complete") return responses["uploads.complete"];
  if (operation === "uploads.cancel") return responses["uploads.cancel"];
  if (operation === "masks.get") return responses["masks.get"];
  if (operation === "recipes.put") return responses["recipes.put"];
  if (operation === "versions.get") return responses["versions.get"];
  if (operation === "versions.put") return responses["versions.put"];
  if (operation === "recipe-conflicts.list") return responses["recipe-conflicts.list"];
  if (operation === "recipe-conflicts.get") return responses["recipe-conflicts.get"];
  if (operation === "recipe-conflicts.resolve") return responses["recipe-conflicts.resolve"];
  if (operation === "media.ensure") return responses["media.ensure"];
  return responses["photos.delete"];
}

const presets: PhotoLibraryPresets = {
  list: async () => [],
  create: async (preset) => ({ id: "synthetic-preset", source: preset.source ?? "xmp", createdAt: "2026-11-03T00:00:00.000Z", name: preset.name, xmp: preset.xmp }),
  rename: async (_presetId, name) => ({ id: "synthetic-preset", source: "xmp", createdAt: "2026-11-03T00:00:00.000Z", name, xmp: "" }),
  delete: async () => undefined,
  nameMaxChars: 40,
  xmpMaxBytes: 1024,
  describeError: (_error, fallback) => fallback,
  isNameTaken: () => false,
};

const activeHandles = new Set<ReturnType<typeof createPersonalPhotoCloudLibrary>>();

afterEach(() => {
  for (const handle of activeHandles) handle.dispose();
  activeHandles.clear();
});

export function maskPngFixture(value = 128): { bytes: Uint8Array; surfaceId: string } {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]);
  const chunks = [pngChunk("IHDR", ihdr), pngChunk("IDAT", new Uint8Array(deflatePngRow(value))), pngChunk("IEND", new Uint8Array())];
  const bytes = new Uint8Array(signature.byteLength + chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  bytes.set(signature);
  let offset = signature.byteLength;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const surfaceId = Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { bytes, surfaceId };
}

export const testMaskValidator = Object.freeze({
  async validateMaskSurface(bytes: Uint8Array) {
    return {
      id: Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      width: 1,
      height: 1,
    };
  },
});

function deflatePngRow(value: number): Uint8Array {
  return new Uint8Array(zlibDeflateSync(Uint8Array.from([0, value])));
}

function pngChunk(name: string, data: Uint8Array): Uint8Array {
  const type = new TextEncoder().encode(name);
  const result = new Uint8Array(12 + data.byteLength);
  writeU32(result, 0, data.byteLength);
  result.set(type, 4);
  result.set(data, 8);
  writeU32(result, 8 + data.byteLength, pngCrc(result.subarray(4, 8 + data.byteLength)));
  return result;
}

function pngCrc(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
