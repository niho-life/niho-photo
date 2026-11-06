import { describe, expect, it } from "vitest";

import {
  createRenderJobMockServer,
  createSourceDeviceRenderExecutor,
  renditionMetadataViolations,
  scanJpegMetadata,
  type CreateSourceDeviceRenderExecutorOptions,
} from "../src/render-executor";
import type { RenderExecutor } from "../src/render-executor/contract";
import {
  CAPABILITY,
  bindingFor,
  cameraExifWithLocation,
  fakeRenderer,
  hex,
  photoRef,
  recipeFor,
  sourcePort,
  syntheticJpeg,
  syntheticSource,
  type SyntheticSource,
} from "./render-support";

const EXECUTOR: RenderExecutor = { kind: "userDevice", userId: "synthetic-member" };
const START = Date.parse("2026-11-07T00:00:00.000Z");

function setup(input: {
  photos?: readonly string[];
  sources?: Map<string, SyntheticSource>;
  renderer?: ReturnType<typeof fakeRenderer>;
  quotaBytes?: number;
  leaseSeconds?: number;
  executor?: Partial<CreateSourceDeviceRenderExecutorOptions>;
} = {}) {
  let now = START;
  const sources = input.sources ?? new Map((input.photos ?? []).map((id) => [id, syntheticSource(id)]));
  const server = createRenderJobMockServer({
    executor: EXECUTOR, now: () => now,
    ...(input.quotaBytes === undefined ? {} : { quotaBytes: input.quotaBytes }),
    ...(input.leaseSeconds === undefined ? {} : { leaseSeconds: input.leaseSeconds }),
  });
  const renderer = input.renderer ?? fakeRenderer();
  const port = sourcePort(sources);
  let keys = 0;
  const executor = createSourceDeviceRenderExecutor({
    transport: server.transport, executor: EXECUTOR, renderer: renderer.renderer, sources: port, uploader: server.uploader,
    now: () => now, newIdempotencyKey: () => `key-${++keys}`, sleep: async () => undefined, ...input.executor,
  });
  const add = (itemId: string, photoId: string, revision = 1, extra: { isNew?: boolean; albumId?: string } = {}) => {
    const recipe = recipeFor(revision);
    const binding = bindingFor(hex(sources.get(photoId)?.bytes ?? new Uint8Array()), recipe);
    server.addAlbumItem({ albumId: extra.albumId ?? "album-a", itemId, photo: photoRef(photoId), binding, recipe, ...(extra.isNew === undefined ? {} : { isNew: extra.isNew }) });
    return binding;
  };
  const newer = (photoId: string, revision: number) => {
    const recipe = recipeFor(revision);
    return { recipe, binding: bindingFor(hex(sources.get(photoId)?.bytes ?? new Uint8Array()), recipe) };
  };
  return { server, executor, renderer, sources, port, add, newer, signal: new AbortController().signal, advance: (ms: number) => { now += ms; } };
}

describe("source-device render executor (B07)", () => {
  it("renders, uploads and commits each finished photo under the job's binding", async () => {
    const t = setup({ photos: ["p1", "p2", "p3"] });
    const bindings = ["p1", "p2", "p3"].map((photo, index) => t.add(`item-${index + 1}`, photo));
    const summary = await t.executor.drain(t.signal);
    expect(summary).toMatchObject({ committed: 3, failed: 0, discarded: 0 });
    bindings.forEach((binding, index) => {
      const item = t.server.item("album-a", `item-${index + 1}`);
      expect(item).toMatchObject({ state: "published", revision: 1, published: binding });
      expect(renditionMetadataViolations(item.bytes as Uint8Array)).toEqual([]);
    });
    expect(t.server.commitOrder).toEqual(["item-1", "item-2", "item-3"]);
    expect(t.server.reservedBytes()).toBe(0);
  });

  it("never renders more jobs at once than the device limit", async () => {
    const photos = Array.from({ length: 8 }, (_, index) => `photo-${index}`);
    const t = setup({ photos, executor: { maxConcurrent: 2 } });
    photos.forEach((photo, index) => t.add(`item-${index}`, photo));
    expect((await t.executor.drain(t.signal)).committed).toBe(8);
    expect(t.renderer.maxInFlight).toBe(2);
  });

  it("a late result of an older recipe never replaces the newer finished photo", async () => {
    const t = setup({ photos: ["photo-late"] });
    t.add("item-late", "photo-late", 1);
    const release = t.renderer.hold("photo-late");
    const draining = t.executor.drain(t.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The owner saves revision 2 while revision 1 is still rendering; the server supersedes the old job, and the
    // member's other device (the Mac app next to the browser) finishes revision 2 first.
    const { recipe, binding } = t.newer("photo-late", 2);
    t.server.saveRecipe(photoRef("photo-late"), binding, recipe);
    const otherDevice = createSourceDeviceRenderExecutor({
      transport: t.server.transport, executor: EXECUTOR, renderer: fakeRenderer().renderer, sources: t.port, uploader: t.server.uploader,
      sleep: async () => undefined, now: () => START,
    });
    expect((await otherDevice.drain(t.signal)).committed).toBe(1);
    release();
    const summary = await draining;
    expect(t.server.item("album-a", "item-late")).toMatchObject({ state: "published", published: binding, revision: 1 });
    expect(summary.discarded + summary.cancelled).toBeGreaterThanOrEqual(1);
    expect(t.server.commitOrder).toEqual(["item-late"]);
  });

  it("a second drain on the same device joins the running one instead of rendering the same job twice", async () => {
    const t = setup({ photos: ["photo-once"], executor: { maxConcurrent: 2 } });
    t.add("item-once", "photo-once");
    const release = t.renderer.hold("photo-once");
    const first = t.executor.drain(t.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = t.executor.drain(t.signal);
    expect(second).toBe(first);
    release();
    expect(await second).toMatchObject({ committed: 1, discarded: 0, interrupted: 0 });
    expect(t.renderer.started).toHaveLength(1);
    expect(t.server.calls("renderJobs.startOutput")).toBe(1);
    // Once it ends, a new drain starts afresh.
    const third = t.executor.drain(t.signal);
    expect(third).not.toBe(first);
    expect((await third).committed).toBe(0);
  });

  it("drops work bound to an older recipe as soon as this device saves a newer one", async () => {
    const t = setup({ photos: ["photo-edit"] });
    t.add("item-edit", "photo-edit", 1);
    const release = t.renderer.hold("photo-edit");
    const draining = t.executor.drain(t.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const { recipe, binding } = t.newer("photo-edit", 2);
    t.executor.supersede(photoRef("photo-edit"), binding);
    release();
    const summary = await draining;
    expect(summary).toMatchObject({ cancelled: 1, committed: 0 });
    expect(t.server.calls("renderJobs.startOutput")).toBe(0);
    t.server.saveRecipe(photoRef("photo-edit"), binding, recipe);
    expect((await t.executor.drain(t.signal)).committed).toBe(1);
    expect(t.server.item("album-a", "item-edit").published).toEqual(binding);
  });

  it("removing an item or album leaves no pending job, upload or storage reservation", async () => {
    const t = setup({ photos: ["photo-r1", "photo-r2", "photo-r3"] });
    t.add("item-r1", "photo-r1");
    t.add("item-r2", "photo-r2", 1, { albumId: "album-b" });
    t.add("item-r3", "photo-r3", 1, { albumId: "album-b" });
    let hold: (() => void) | null = null;
    const uploader = t.server.uploader;
    const slowUploader = {
      async upload(...args: Parameters<typeof uploader.upload>) {
        // While the first output is uploading, the item is removed on the server.
        if (hold === null) await new Promise<void>((resolve) => { hold = resolve; t.server.removeItem("album-a", "item-r1"); resolve(); });
        return await uploader.upload(...args);
      },
    };
    const executor = createSourceDeviceRenderExecutor({
      transport: t.server.transport, executor: EXECUTOR, renderer: t.renderer.renderer, sources: t.port, uploader: slowUploader,
      sleep: async () => undefined, now: () => START,
    });
    t.server.removeAlbum("album-b");
    const summary = await executor.drain(t.signal);
    // The removal cancels the job and its ticket; the device drops the output (discarded or interrupted upload).
    expect(summary.committed).toBe(0);
    expect(summary.discarded + summary.interrupted).toBe(1);
    expect(t.server.item("album-a", "item-r1").state).toBe("removed");
    expect(t.server.reservedBytes()).toBe(0);
    expect(t.server.jobs().filter((job) => job.state === "queued" || job.state === "claimed")).toEqual([]);
    expect(t.server.commitOrder).toEqual([]);
  });

  it("stops at a full album storage without failing, and resumes once capacity frees", async () => {
    const t = setup({ photos: ["photo-q"], quotaBytes: 0 });
    t.add("item-q", "photo-q");
    const first = await t.executor.drain(t.signal);
    expect(first).toMatchObject({ deferredForQuota: 1, committed: 0, failed: 0 });
    expect(t.server.item("album-a", "item-q")).toMatchObject({ state: "preparing", pendingReason: "quotaExceeded", published: null });
    expect(t.server.reservedBytes()).toBe(0);
    expect((await t.executor.drain(t.signal)).committed).toBe(0);
    t.server.setQuotaBytes(10 * 1024 ** 2);
    expect((await t.executor.drain(t.signal)).committed).toBe(1);
    expect(t.server.item("album-a", "item-q")).toMatchObject({ state: "published", pendingReason: null });
  });

  it("in a first share of thousands of photos, the ones being viewed are finished first", async () => {
    const photos = Array.from({ length: 3000 }, (_, index) => `bulk-${index}`);
    const t = setup({ photos, executor: { maxConcurrent: 4, claimBatch: 8 } });
    photos.forEach((photo, index) => t.add(`bulk-item-${index}`, photo));
    const viewed = Array.from({ length: 24 }, (_, index) => `bulk-item-${2900 - index * 97}`);
    t.server.markVisible(viewed);
    const summary = await t.executor.drain(t.signal);
    expect(summary.committed).toBe(3000);
    expect(new Set(t.server.commitOrder.slice(0, viewed.length))).toEqual(new Set(viewed));
  }, 30_000);

  it("a photo this device shows starts first among the jobs it holds", async () => {
    const t = setup({ photos: ["photo-a", "photo-b", "photo-c"], executor: { maxConcurrent: 1, claimBatch: 3 } });
    ["photo-a", "photo-b", "photo-c"].forEach((photo, index) => t.add(`item-${index}`, photo));
    t.executor.prioritize([photoRef("photo-c")]);
    await t.executor.drain(t.signal);
    expect(t.server.commitOrder[0]).toBe("item-2");
  });

  it("strips location, serials and paths the renderer copied from the original, keeping only the allowed capture time", async () => {
    const sources = new Map([["photo-gps", syntheticSource("photo-gps", { exif: cameraExifWithLocation(), xmp: '<x:xmpmeta exif:GPSLatitude="35"/>' })]]);
    const renderer = fakeRenderer({ leakSourceMetadata: true });
    const t = setup({ sources, renderer });
    t.add("item-gps", "photo-gps");
    expect((await t.executor.drain(t.signal)).committed).toBe(1);
    const bytes = t.server.item("album-a", "item-gps").bytes as Uint8Array;
    const scan = scanJpegMetadata(bytes);
    // Rebuilt with one canonical JFIF; the engine's capture-time EXIF is the only other block.
    expect(scan?.segments).toEqual(["exif", "jfif"]);
    expect(scan?.canonicalJfif).toBe(true);
    expect(scan?.exif?.gps).toEqual([]);
    expect(renditionMetadataViolations(bytes)).toEqual([]);
    const text = new TextDecoder("latin1").decode(bytes);
    for (const leaked of ["SERIAL-0001", "Synthetic Camera Co", "/DCIM/100SYNTH", "GPSLatitude", "8BIM", "ICC_PROFILE"]) expect(text).not.toContain(leaked);
    expect(text).toContain("2026:11:01 09:30:00");
  });

  it("the server refuses an output that still carries location, if a device skipped the scrub", async () => {
    const t = setup({ photos: ["photo-raw"] });
    t.add("item-raw", "photo-raw");
    const [claimed] = (await t.server.transport.request("renderJobs.claim", { maxJobs: 1 }, { signal: t.signal })).jobs;
    const leaky = syntheticJpeg({ width: 1200, height: 800, exif: cameraExifWithLocation() });
    const start = await t.server.transport.request("renderJobs.startOutput", {
      jobId: claimed.job.id, leaseToken: claimed.lease.leaseToken,
      output: { kind: "rendition", sizeBytes: leaky.length, sha256: hex(leaky), contentType: "image/jpeg", width: 1200, height: 800, metadata: { capturedAt: null, capturedAtOffset: null, colorProfile: "sRGB", orientation: 1 } },
    }, { signal: t.signal, idempotencyKey: "manual-start" });
    await t.server.uploader.upload(start.value.ticket as never, leaky, "image/jpeg", t.signal);
    await expect(t.server.transport.request("renderJobs.commit", { jobId: claimed.job.id, leaseToken: claimed.lease.leaseToken, uploadId: start.value.uploadId }, { signal: t.signal, idempotencyKey: "manual-commit" }))
      .rejects.toMatchObject({ error: { code: "content_rejected" } });
  });

  it("refuses, with a reason and without uploading, jobs this device cannot render faithfully", async () => {
    const sources = new Map<string, SyntheticSource>([
      ["photo-ok", syntheticSource("photo-ok")],
      ["photo-huge", syntheticSource("photo-huge", { width: 6000, height: 4000 })],
      ["photo-heic", syntheticSource("photo-heic", { format: "heic" })],
      ["photo-changed", syntheticSource("photo-changed")],
    ]);
    const t = setup({ sources });
    const recipe = recipeFor(1);
    const ok = hex(sources.get("photo-ok")?.bytes as Uint8Array);
    t.server.addAlbumItem({ albumId: "album-a", itemId: "other-renderer", photo: photoRef("photo-ok"), recipe, binding: bindingFor(ok, recipe, { rendererManifestSha256: "f".repeat(64) }) });
    t.server.addAlbumItem({ albumId: "album-a", itemId: "inconsistent", photo: photoRef("photo-ok"), recipe, binding: bindingFor(ok, recipe, { recipeRevision: 7 }) });
    t.add("too-large", "photo-huge");
    t.add("heic", "photo-heic");
    t.add("missing", "photo-gone");
    t.add("changed", "photo-changed");
    sources.set("photo-changed", { ...syntheticSource("photo-changed"), generation: 2 });
    const summary = await t.executor.drain(t.signal);
    expect(summary).toMatchObject({ failed: 6, committed: 0 });
    expect(Object.fromEntries(t.server.jobs().map((job) => [job.purpose.kind === "albumItem" ? job.purpose.itemId : "", job.failure]))).toEqual({
      "other-renderer": "renderer_unavailable",
      inconsistent: "unsupported_settings",
      "too-large": "full_resolution_unavailable",
      heic: "unsupported_format",
      missing: "source_missing",
      changed: "source_changed",
    });
    expect(t.server.calls("renderJobs.startOutput")).toBe(0);
  });

  it("refuses an output whose capture-time writer added anything beyond the allowed tags", async () => {
    const renderer = fakeRenderer({ captureExif: (jpeg) => syntheticJpeg({ width: 1200, height: 800, exif: cameraExifWithLocation(), seed: jpeg[jpeg.length - 6] }) });
    const t = setup({ photos: ["photo-w"], renderer });
    t.add("item-w", "photo-w");
    expect((await t.executor.drain(t.signal)).failed).toBe(1);
    expect(t.server.jobs()[0].failure).toBe("renderer_unavailable");
    expect(t.server.calls("renderJobs.startOutput")).toBe(0);
  });

  it("an output the server refuses on re-decode is reported once as a renderer failure, not rendered on every claim", async () => {
    const t = setup({ photos: ["photo-reject"] });
    t.add("item-reject", "photo-reject");
    const real = t.server.transport;
    const rejecting: typeof real = {
      async request(operation, request, requestOptions) {
        if (operation === "renderJobs.commit") throw { error: { code: "content_rejected", requestId: "synthetic-request", retryable: false } };
        return await real.request(operation, request, requestOptions);
      },
    };
    const executor = createSourceDeviceRenderExecutor({
      transport: rejecting, executor: EXECUTOR, renderer: t.renderer.renderer, sources: t.port, uploader: t.server.uploader,
      sleep: async () => undefined, now: () => START,
    });
    expect(await executor.drain(t.signal)).toMatchObject({ failed: 1, committed: 0, interrupted: 0 });
    expect(t.server.jobs()[0]).toMatchObject({ state: "failed", failure: "renderer_unavailable" });
    expect(t.server.reservedBytes()).toBe(0);
    expect((await executor.drain(t.signal)).failed).toBe(0);
    expect(t.renderer.started).toHaveLength(1);
  });

  it("counts a refusal as failed only when the server took the report", async () => {
    const t = setup({ photos: [] });
    t.add("item-gone", "photo-gone");
    const real = t.server.transport;
    let lostReports = 0;
    const flaky: typeof real = {
      async request(operation, request, requestOptions) {
        if (operation === "renderJobs.fail") {
          lostReports += 1;
          throw new TypeError("Failed to fetch");
        }
        return await real.request(operation, request, requestOptions);
      },
    };
    const executor = createSourceDeviceRenderExecutor({
      transport: flaky, executor: EXECUTOR, renderer: t.renderer.renderer, sources: t.port, uploader: t.server.uploader,
      sleep: async () => undefined, now: () => START,
    });
    expect(await executor.drain(t.signal)).toMatchObject({ failed: 0, interrupted: 1 });
    // Sent up to the replay limit with the same key, then left for the next claim of the job.
    expect(lostReports).toBe(3);
    expect(t.server.jobs()[0].state).toBe("claimed");

    // A report answered with "no longer yours" is dropped, not counted.
    const t2 = setup({ photos: [] });
    t2.add("item-gone", "photo-gone");
    const gone: typeof real = {
      async request(operation, request, requestOptions) {
        if (operation === "renderJobs.fail") throw { error: { code: "not_found", requestId: "synthetic-request", retryable: false } };
        return await t2.server.transport.request(operation, request, requestOptions);
      },
    };
    const executor2 = createSourceDeviceRenderExecutor({
      transport: gone, executor: EXECUTOR, renderer: t2.renderer.renderer, sources: t2.port, uploader: t2.server.uploader,
      sleep: async () => undefined, now: () => START,
    });
    expect(await executor2.drain(t2.signal)).toMatchObject({ failed: 0, discarded: 1 });
  });

  it("an interrupted upload's storage reservation ends with its lease or its ticket", async () => {
    const broken = { async upload(): Promise<void> { throw new TypeError("Failed to fetch"); } };
    const t = setup({ photos: ["photo-cut"], executor: { uploader: broken } });
    t.add("item-cut", "photo-cut");
    expect(await t.executor.drain(t.signal)).toMatchObject({ interrupted: 1, committed: 0 });
    expect(t.server.reservedBytes()).toBeGreaterThan(0);
    // The lease (10 min) runs out before the ticket (1 h); offering the job again releases what the old lease reserved.
    t.advance(11 * 60 * 1000);
    expect(t.server.reservedBytes()).toBeGreaterThan(0);
    const [again] = (await t.server.transport.request("renderJobs.claim", { maxJobs: 1 }, { signal: t.signal })).jobs;
    expect(again.job.id).toBe(t.server.jobs()[0].id);
    expect(t.server.reservedBytes()).toBe(0);

    // Without a new claim, an expired ticket no longer counts as reserved storage.
    const t2 = setup({ photos: ["photo-cut"], executor: { uploader: broken } });
    t2.add("item-cut", "photo-cut");
    await t2.executor.drain(t2.signal);
    expect(t2.server.reservedBytes()).toBeGreaterThan(0);
    t2.advance(61 * 60 * 1000);
    expect(t2.server.reservedBytes()).toBe(0);
  });

  it("replays lost answers with the same key and starts a fresh output when the ticket was lost", async () => {
    const t = setup({ photos: ["photo-lost"] });
    t.add("item-lost", "photo-lost");
    t.server.loseNextResponse("renderJobs.startOutput");
    t.server.loseNextResponse("renderJobs.commit");
    expect((await t.executor.drain(t.signal)).committed).toBe(1);
    expect(t.server.commitOrder).toEqual(["item-lost"]);
    // start (lost) → replay without ticket → fresh start; commit (lost) → replay.
    expect(t.server.calls("renderJobs.startOutput")).toBe(3);
    expect(t.server.calls("renderJobs.commit")).toBe(2);
    expect(t.server.reservedBytes()).toBe(0);
  });

  it("drops a result whose lease ran out while rendering; the job is claimed again and finished", async () => {
    let advance = (_ms: number): void => undefined;
    const renderer = fakeRenderer({ onRender: () => advance(11 * 60 * 1000) });
    const t = setup({ photos: ["photo-slow"], renderer, leaseSeconds: 600 });
    advance = t.advance;
    t.add("item-slow", "photo-slow");
    const first = await t.executor.drain(t.signal);
    expect(first.discarded).toBeGreaterThanOrEqual(1);
    expect(t.server.calls("renderJobs.startOutput")).toBe(0);
    advance = () => undefined;
    expect((await t.executor.drain(t.signal)).committed).toBe(1);
  });

  it("makes reduced previews without capture metadata", async () => {
    const t = setup({ photos: ["photo-preview"] });
    const recipe = recipeFor(3);
    const binding = bindingFor(hex(t.sources.get("photo-preview")?.bytes as Uint8Array), recipe);
    t.server.requestPreview(photoRef("photo-preview"), binding, recipe);
    expect((await createSourceDeviceRenderExecutor({
      transport: t.server.transport, executor: EXECUTOR, renderer: t.renderer.renderer, sources: t.port, uploader: t.server.uploader,
      previewMaxEdge: 600, sleep: async () => undefined, now: () => START,
    }).drain(t.signal)).committed).toBe(1);
    const preview = t.server.preview(photoRef("photo-preview"));
    expect(preview.published).toEqual(binding);
    const scan = scanJpegMetadata(preview.bytes as Uint8Array);
    expect(scan?.exif).toBeNull();
    expect(CAPABILITY.manifestSha256).toBe(binding.rendererManifestSha256);
  });
});
