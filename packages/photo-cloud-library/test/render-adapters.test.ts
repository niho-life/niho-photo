import { describe, expect, it, vi } from "vitest";

import { neutralDevelopSettings } from "niho-photo-editing/develop-engine/develop-settings";

import {
  SourceDeviceRenderFailure,
  createDevelopEngineDeviceRenderer,
  createPersonalCloudRenderSource,
  createTicketUploader,
  renderFinishedOutput,
  scanJpegMetadata,
  stripJpegMetadata,
  renditionMetadataViolations,
  type DeviceRenderer,
} from "../src/render-executor";
import type { RecipeDocument } from "../src/render-executor/contract";
import { CAPABILITY, bindingFor, cameraExifWithLocation, concat, engineCaptureExif, hex, insertExif, jpegSegment, syntheticJpeg } from "./render-support";

const signal = new AbortController().signal;

function engineRecipe(revision = 1, geometry?: object): RecipeDocument {
  // A geometry other than the identity is settings version 2.
  const settings = { ...neutralDevelopSettings(), engine: "niho-14", ...(geometry ? { v: 2, geometry } : {}) } as unknown as RecipeDocument["settings"];
  return { revision, settings, settingsSha256: "c".repeat(64), baseVersion: null, maskSurfaceIds: [], updatedAt: "2026-11-07T00:00:00.000Z" };
}

function jpegSource(width: number, height: number) {
  return { bytes: syntheticJpeg({ width, height }), format: "jpeg" as const, width, height, capturedAt: "2026-11-01T09:30:00", capturedAtOffset: "+09:00" };
}

function fakeEngine(output = (maxDimension: number) => syntheticJpeg({ width: maxDimension, height: Math.round(maxDimension * 2 / 3) })) {
  return {
    exportJpeg: vi.fn(async (_bytes: ArrayBuffer, _settings: object, options: { maxDimension: number; maskSurfaces?: unknown }) => output(options.maxDimension) as Uint8Array<ArrayBuffer>),
    exportWorkingCopyJpeg: vi.fn(async () => { throw new Error("not used"); }),
    withCaptureExif: vi.fn(async (jpeg: Uint8Array<ArrayBuffer>) => insertExif(jpeg, engineCaptureExif("2026:11:01 09:30:00", "+09:00", 1, 1)) as Uint8Array<ArrayBuffer>),
  };
}

describe("develop engine renderer adapter", () => {
  it("renders the original at full size (or the preview edge) through the existing engine export", async () => {
    const engine = fakeEngine();
    const renderer = createDevelopEngineDeviceRenderer({ engine, capability: CAPABILITY });
    const source = { bytes: syntheticJpeg({ width: 1500, height: 1000 }), format: "jpeg" as const, width: 1500, height: 1000, capturedAt: "2026-11-01T09:30:00", capturedAtOffset: "+09:00" };
    const recipe = engineRecipe();
    const masks = vi.fn(async () => null);
    const binding = { ...bindingFor(hex(source.bytes), recipe), engine: "niho-14" };
    const rendition = await renderFinishedOutput({ renderer, source, recipe, binding, kind: "rendition", loadMaskSurface: masks, signal });
    expect(engine.exportJpeg.mock.calls[0][2]).toMatchObject({ maxDimension: 1500, maskSurfaces: masks });
    expect(rendition.request).toMatchObject({ kind: "rendition", width: 1500, height: 1000, metadata: { capturedAt: "2026-11-01T09:30:00", capturedAtOffset: "+09:00", colorProfile: "sRGB", orientation: 1 } });
    // Capture time goes through the engine's own writer, in UTC with the recorded offset.
    expect(engine.withCaptureExif).toHaveBeenCalledWith(expect.any(Uint8Array), "2026-11-01T00:30:00.000Z", 540);
    expect(renditionMetadataViolations(rendition.bytes)).toEqual([]);

    const preview = await renderFinishedOutput({ renderer, source, recipe, binding, kind: "preview", loadMaskSurface: masks, previewMaxEdge: 800, signal });
    expect(engine.exportJpeg.mock.calls[1][2]).toMatchObject({ maxDimension: 800 });
    expect(preview.request).toMatchObject({ kind: "preview", width: 800 });
    // The engine owns the bytes it is given; the source stays intact.
    expect(engine.exportJpeg.mock.calls[0][0]).not.toBe(source.bytes.buffer);
  });

  it("declares only what the engine path does: JPEG/PNG originals up to 4096 px, settings it can read", async () => {
    const engine = fakeEngine();
    const renderer = createDevelopEngineDeviceRenderer({ engine, capability: CAPABILITY });
    expect(renderer.formats).toEqual(["jpeg", "png"]);
    expect(renderer.fullResolutionMaxEdge).toBe(4096);
    const source = { bytes: syntheticJpeg({ width: 1200, height: 800 }), format: "jpeg" as const, width: 1200, height: 800, capturedAt: null, capturedAtOffset: null };
    const broken = { ...engineRecipe(), settings: { v: 99, engine: "niho-14" } as unknown as RecipeDocument["settings"] };
    await expect(renderer.render({ source, recipe: broken, maxEdge: null, loadMaskSurface: async () => null }, signal)).rejects.toMatchObject({ code: "unsupported_settings" });
    expect(engine.exportJpeg).not.toHaveBeenCalled();
  });

  it("exports at the engine's own web quality and proves full size against the recipe's rotation and crop", async () => {
    // 1500×1000 turned 90° is a 1000×1500 frame; its left half is 500×1500.
    const engine = fakeEngine(() => syntheticJpeg({ width: 500, height: 1500 }));
    const renderer = createDevelopEngineDeviceRenderer({ engine, capability: { ...CAPABILITY, settingsVersions: [1, 2] } });
    const source = jpegSource(1500, 1000);
    const recipe = engineRecipe(1, { rotate: 90, crop: { left: 0, top: 0, right: 0.5, bottom: 1 } });
    const binding = { ...bindingFor(hex(source.bytes), recipe), engine: "niho-14" };
    const rendition = await renderFinishedOutput({ renderer, source, recipe, binding, kind: "rendition", loadMaskSurface: async () => null, signal });
    expect(engine.exportJpeg.mock.calls[0][2]).toMatchObject({ maxDimension: 1500, quality: 90 });
    expect(rendition.request).toMatchObject({ width: 500, height: 1500 });
    for (const quality of [0, 0.9, 101]) expect(() => createDevelopEngineDeviceRenderer({ engine, capability: CAPABILITY, quality })).toThrow(RangeError);
  });

  it("refuses a rendition the engine returned smaller than the full-resolution size", async () => {
    const engine = fakeEngine(() => syntheticJpeg({ width: 600, height: 400 }));
    const renderer = createDevelopEngineDeviceRenderer({ engine, capability: CAPABILITY });
    const source = jpegSource(3000, 2000);
    const recipe = engineRecipe();
    const binding = { ...bindingFor(hex(source.bytes), recipe), engine: "niho-14" };
    await expect(renderFinishedOutput({ renderer, source, recipe, binding, kind: "rendition", loadMaskSurface: async () => null, signal }))
      .rejects.toMatchObject({ code: "full_resolution_unavailable" });
    expect(engine.withCaptureExif).not.toHaveBeenCalled();
    // The same short answer is a valid preview.
    const preview = await renderFinishedOutput({ renderer, source, recipe, binding, kind: "preview", loadMaskSurface: async () => null, previewMaxEdge: 600, signal });
    expect(preview.request).toMatchObject({ kind: "preview", width: 600, height: 400 });
  });

  it("refuses a colour space other than untagged sRGB, since the scrub drops ICC profiles", async () => {
    const source = jpegSource(1200, 800);
    const recipe = engineRecipe();
    const binding = { ...bindingFor(hex(source.bytes), recipe), engine: "niho-14" };
    const renderer: DeviceRenderer = {
      capability: CAPABILITY, formats: ["jpeg"], fullResolutionMaxEdge: 4096,
      async render() { return { bytes: syntheticJpeg({ width: 1200, height: 800, icc: true }), width: 1200, height: 800, colorProfile: "displayP3", fullResolution: true }; },
    };
    await expect(renderFinishedOutput({ renderer, source, recipe, binding, kind: "rendition", loadMaskSurface: async () => null, signal }))
      .rejects.toMatchObject({ code: "renderer_unavailable" });
  });
});

describe("finished output scrub", () => {
  it("keeps the pixels and one canonical JFIF, and drops EXIF, ICC, XMP, IPTC and comments", () => {
    const dirty = syntheticJpeg({ width: 640, height: 480, exif: cameraExifWithLocation(), xmp: '<x exif:GPSLatitude="1"/>', comment: "/DCIM/100SYNTH/IMG_0001.JPG", iptc: true, icc: true });
    expect(renditionMetadataViolations(dirty)).toEqual(expect.arrayContaining(["segment:icc", "segment:xmp", "segment:otherApp", "segment:comment", "exif:GPSInfo", "exif:Make", "exif:BodySerialNumber"]));
    const clean = stripJpegMetadata(dirty) as Uint8Array;
    expect(renditionMetadataViolations(clean)).toEqual([]);
    expect(scanJpegMetadata(clean)).toMatchObject({ segments: ["jfif"], canonicalJfif: true, exif: null });
    expect(clean.subarray(clean.length - 6)).toEqual(dirty.subarray(dirty.length - 6));
    expect(stripJpegMetadata(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("rebuilds the whole file: a non-canonical JFIF, metadata between scans and bytes after the end are dropped", () => {
    const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);
    const header = syntheticJpeg({ width: 64, height: 48 });
    // Tables and frame of the synthetic JPEG: everything between its JFIF and its first scan.
    const jfifEnd = 4 + ((header[4] << 8) | header[5]);
    const sos = header.findIndex((value, index) => value === 0xff && header[index + 1] === 0xda);
    const tables = header.subarray(jfifEnd, sos);
    const scanHeader = jpegSegment(0xda, new Uint8Array([1, 1, 0, 0, 0x3f, 0]));
    const progressive = concat([
      new Uint8Array([0xff, 0xd8]),
      // JFIF with a 300 dpi density and a 1×1 thumbnail: not the canonical header.
      jpegSegment(0xe0, concat([ascii("JFIF\0"), new Uint8Array([1, 2, 1, 0x01, 0x2c, 0x01, 0x2c, 1, 1, 9, 9, 9])])),
      tables,
      scanHeader, new Uint8Array([0x12, 0xff, 0x00, 0x34]),
      jpegSegment(0xfe, ascii("/DCIM/100SYNTH/IMG_0001.JPG")),
      jpegSegment(0xe1, concat([ascii("http://ns.adobe.com/xap/1.0/\0"), ascii('<x exif:GPSLatitude="35"/>')])),
      scanHeader, new Uint8Array([0x56, 0xff, 0xd0, 0x78]),
      new Uint8Array([0xff, 0xd9]),
      ascii("GPS 35.3 139.5 SERIAL-0001"),
    ]);
    expect(renditionMetadataViolations(progressive)).toEqual(expect.arrayContaining(["segment:jfif-noncanonical", "segment:comment", "segment:xmp", "trailing-data"]));
    const clean = stripJpegMetadata(progressive) as Uint8Array;
    expect(renditionMetadataViolations(clean)).toEqual([]);
    expect(scanJpegMetadata(clean)).toMatchObject({ segments: ["jfif"], canonicalJfif: true, trailingBytes: 0 });
    const text = new TextDecoder("latin1").decode(clean);
    for (const leaked of ["SERIAL-0001", "GPS", "/DCIM", "xap"]) expect(text).not.toContain(leaked);
    // Both scans and their entropy bytes (stuffing and restart markers included) are kept as they were.
    const scans = [...clean.keys()].filter((index) => clean[index] === 0xff && clean[index + 1] === 0xda);
    expect(scans).toHaveLength(2);
    expect(clean.subarray(clean.length - 6)).toEqual(new Uint8Array([0x56, 0xff, 0xd0, 0x78, 0xff, 0xd9]));
  });

  it("refuses a full-size photo the device can only render smaller", async () => {
    const renderer = createDevelopEngineDeviceRenderer({ engine: fakeEngine(), capability: CAPABILITY });
    const source = { bytes: syntheticJpeg({ width: 6000, height: 4000 }), format: "jpeg" as const, width: 6000, height: 4000, capturedAt: null, capturedAtOffset: null };
    const recipe = engineRecipe();
    const refused = renderFinishedOutput({ renderer, source, recipe, binding: { ...bindingFor(hex(source.bytes), recipe), engine: "niho-14" }, kind: "rendition", loadMaskSurface: async () => null, signal });
    await expect(refused).rejects.toBeInstanceOf(SourceDeviceRenderFailure);
    await expect(refused).rejects.toMatchObject({ code: "full_resolution_unavailable" });
  });
});

describe("ticket uploader", () => {
  const ticket = (url = "https://storage.googleapis.com/synthetic-bucket/upload-1") => ({
    url, method: "PUT" as const, headers: { "Content-Type": "image/jpeg" }, expiresAt: "2026-11-07T01:00:00.000Z", resumeOffsetBytes: 0,
  });
  const now = () => Date.parse("2026-11-07T00:00:00.000Z");

  it("puts the bytes with a content range to the trusted provider, without credentials", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }));
    const bytes = syntheticJpeg({ width: 10, height: 10 });
    await createTicketUploader({ fetch: fetchSpy as unknown as typeof fetch, now }).upload(ticket(), bytes, "image/jpeg", signal);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://storage.googleapis.com/synthetic-bucket/upload-1");
    expect(init).toMatchObject({ method: "PUT", credentials: "omit", redirect: "manual" });
    expect(new Headers(init.headers).get("Content-Range")).toBe(`bytes 0-${bytes.length - 1}/${bytes.length}`);
  });

  it("refuses an untrusted origin and a failed provider answer", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 403 }));
    const uploader = createTicketUploader({ fetch: fetchSpy as unknown as typeof fetch, now });
    const bytes = syntheticJpeg({ width: 10, height: 10 });
    await expect(uploader.upload(ticket("https://upload.example.test/x"), bytes, "image/jpeg", signal)).rejects.toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(uploader.upload(ticket(), bytes, "image/jpeg", signal)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("treats a ticket resumed at the end as uploaded, and stops on a provider that makes no progress", async () => {
    const bytes = syntheticJpeg({ width: 10, height: 10 });
    const idle = vi.fn(async () => new Response(null, { status: 200 }));
    await createTicketUploader({ fetch: idle as unknown as typeof fetch, now }).upload({ ...ticket(), resumeOffsetBytes: bytes.length }, bytes, "image/jpeg", signal);
    expect(idle).not.toHaveBeenCalled();

    // 308 without a Range header: the provider holds nothing more than before.
    const stuck = vi.fn(async () => new Response(null, { status: 308 }));
    await expect(createTicketUploader({ fetch: stuck as unknown as typeof fetch, now }).upload(ticket(), bytes, "image/jpeg", signal)).rejects.toMatchObject({ code: "unavailable" });
    expect(stuck).toHaveBeenCalledTimes(1);
    // 308 confirming only what it held when the ticket was resumed.
    const same = vi.fn(async () => new Response(null, { status: 308, headers: { Range: "bytes=0-4" } }));
    await expect(createTicketUploader({ fetch: same as unknown as typeof fetch, now }).upload({ ...ticket(), resumeOffsetBytes: 5 }, bytes, "image/jpeg", signal)).rejects.toMatchObject({ code: "unavailable" });
    expect(same).toHaveBeenCalledTimes(1);

    // 308 confirming every byte is done.
    const confirmed = vi.fn(async () => new Response(null, { status: 308, headers: { Range: `bytes=0-${bytes.length - 1}` } }));
    await createTicketUploader({ fetch: confirmed as unknown as typeof fetch, now }).upload(ticket(), bytes, "image/jpeg", signal);
    expect(confirmed).toHaveBeenCalledTimes(1);
  });
});

describe("personal cloud source", () => {
  const original = syntheticJpeg({ width: 30, height: 20 });
  const photo = {
    id: "photo-1", libraryId: "library-1", format: "jpeg", width: 30, height: 20, capturedAt: "2026-11-01T00:30:00.000Z",
    original: { id: "asset-1", kind: "original", sha256: hex(original), sizeBytes: original.length, contentType: "image/jpeg", width: 30, height: 20 },
  };
  const handle = {
    rawPhoto: vi.fn(async () => photo as never),
    readAsset: vi.fn(async () => ({
      body: new Blob([original.slice()]).stream(), contentType: "image/jpeg", sha256: hex(original), totalBytes: original.length,
      range: { start: 0, endInclusive: original.length - 1 },
    }) as never),
  };

  it("reads the member's original, checks it is the bound one and passes on capture time only", async () => {
    const port = createPersonalCloudRenderSource({ libraryId: "library-1", handle });
    const opened = await port.open({ libraryId: "library-1", photoId: "photo-1" }, { generation: 1, sha256: hex(original) }, signal);
    expect(opened).toMatchObject({ kind: "ok", source: { format: "jpeg", width: 30, height: 20, capturedAt: "2026-11-01T00:30:00", capturedAtOffset: "+00:00" } });
    expect(Object.keys((opened as { source: object }).source).sort()).toEqual(["bytes", "capturedAt", "capturedAtOffset", "format", "height", "width"]);
  });

  it("reports another library as missing and a different generation or hash as changed", async () => {
    const port = createPersonalCloudRenderSource({ libraryId: "library-1", handle });
    expect(await port.open({ libraryId: "library-2", photoId: "photo-1" }, { generation: 1, sha256: hex(original) }, signal)).toEqual({ kind: "missing" });
    expect(await port.open({ libraryId: "library-1", photoId: "photo-1" }, { generation: 2, sha256: hex(original) }, signal)).toEqual({ kind: "changed" });
    expect(await port.open({ libraryId: "library-1", photoId: "photo-1" }, { generation: 1, sha256: "0".repeat(64) }, signal)).toEqual({ kind: "changed" });
  });
});
