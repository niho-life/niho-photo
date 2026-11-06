/**
 * Synthetic inputs for the source-device render executor tests: JPEG byte structures (no real photos), EXIF blocks with
 * chosen tags, a fake renderer standing in for the engine, and an in-memory source port.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { RecipeDocument, RenderBinding, RenderCapability } from "../src/render-executor/contract";
import type { DeviceRenderer, PhotoRef, RenderSource, RenderSourcePort } from "../src/render-executor";

export const MANIFEST = "a".repeat(64);
export const ENGINE = "niho-14";
export const CAPABILITY: RenderCapability = {
  sdkVersion: "synthetic", crateVersion: "0.27.0", manifestSha256: MANIFEST, settingsVersions: [1], engines: [ENGINE],
  features: [], maskKinds: [], maskSurfaces: true,
};

type Entry = { readonly tag: number; readonly type: 2 | 3 | 4; readonly value: number | string };

/** A little-endian TIFF block (IFD0 + optional Exif and GPS IFDs) wrapped as an APP1 "Exif\0\0" payload. */
export function exifPayload(spec: { ifd0?: readonly Entry[]; exif?: readonly Entry[]; gps?: readonly Entry[] }): Uint8Array {
  const ifd0 = [...(spec.ifd0 ?? [])];
  const exifEntries = spec.exif ? [...spec.exif] : null;
  const gpsEntries = spec.gps ? [...spec.gps] : null;
  if (exifEntries) ifd0.push({ tag: 0x8769, type: 4, value: 0 });
  if (gpsEntries) ifd0.push({ tag: 0x8825, type: 4, value: 0 });
  ifd0.sort((a, b) => a.tag - b.tag);
  const ifdSize = (entries: readonly Entry[]): number => 2 + entries.length * 12 + 4;
  const extraSize = (entries: readonly Entry[]): number => entries.reduce((sum, entry) => sum + (typeof entry.value === "string" && entry.value.length + 1 > 4 ? entry.value.length + 1 : 0), 0);
  const ifd0Offset = 8;
  const exifOffset = ifd0Offset + ifdSize(ifd0) + extraSize(ifd0);
  const gpsOffset = exifOffset + (exifEntries ? ifdSize(exifEntries) + extraSize(exifEntries) : 0);
  const total = gpsOffset + (gpsEntries ? ifdSize(gpsEntries) + extraSize(gpsEntries) : 0);
  const tiff = new Uint8Array(total);
  const view = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49, 42, 0]);
  view.setUint32(4, ifd0Offset, true);
  const writeIfd = (offset: number, entries: readonly Entry[]): void => {
    view.setUint16(offset, entries.length, true);
    let extra = offset + ifdSize(entries);
    entries.forEach((entry, index) => {
      const at = offset + 2 + index * 12;
      view.setUint16(at, entry.tag, true);
      view.setUint16(at + 2, entry.type, true);
      if (entry.tag === 0x8769) { view.setUint32(at + 4, 1, true); view.setUint32(at + 8, exifOffset, true); return; }
      if (entry.tag === 0x8825) { view.setUint32(at + 4, 1, true); view.setUint32(at + 8, gpsOffset, true); return; }
      if (typeof entry.value === "string") {
        const bytes = new TextEncoder().encode(`${entry.value}\0`);
        view.setUint32(at + 4, bytes.length, true);
        if (bytes.length <= 4) tiff.set(bytes, at + 8);
        else { view.setUint32(at + 8, extra, true); tiff.set(bytes, extra); extra += bytes.length; }
      } else {
        view.setUint32(at + 4, 1, true);
        if (entry.type === 3) view.setUint16(at + 8, entry.value, true);
        else view.setUint32(at + 8, entry.value, true);
      }
    });
    view.setUint32(offset + 2 + entries.length * 12, 0, true);
  };
  writeIfd(ifd0Offset, ifd0);
  if (exifEntries) writeIfd(exifOffset, exifEntries);
  if (gpsEntries) writeIfd(gpsOffset, gpsEntries);
  return concat([new TextEncoder().encode("Exif\0\0"), tiff]);
}

/** The tags the engine's capture-time writer emits (allowed). */
export function engineCaptureExif(dateTimeOriginal: string, offset: string, width: number, height: number): Uint8Array {
  return exifPayload({
    ifd0: [{ tag: 0x0112, type: 3, value: 1 }, { tag: 0x0213, type: 3, value: 1 }],
    exif: [
      { tag: 0x9000, type: 2, value: "023" }, { tag: 0x9003, type: 2, value: dateTimeOriginal }, { tag: 0x9011, type: 2, value: offset },
      { tag: 0x9101, type: 2, value: "123" }, { tag: 0xa000, type: 2, value: "010" }, { tag: 0xa001, type: 3, value: 1 },
      { tag: 0xa002, type: 4, value: width }, { tag: 0xa003, type: 4, value: height },
    ],
  });
}

/** EXIF a camera would write: make/model, serials and a GPS position. Never allowed in a finished photo. */
export function cameraExifWithLocation(): Uint8Array {
  return exifPayload({
    ifd0: [{ tag: 0x010f, type: 2, value: "Synthetic Camera Co" }, { tag: 0x0110, type: 2, value: "Model Z" }, { tag: 0x0112, type: 3, value: 6 }],
    exif: [{ tag: 0x9003, type: 2, value: "2026:11:01 09:30:00" }, { tag: 0xa431, type: 2, value: "SERIAL-0001" }],
    gps: [{ tag: 0x0001, type: 2, value: "N" }, { tag: 0x0002, type: 4, value: 35 }, { tag: 0x0003, type: 2, value: "E" }, { tag: 0x0004, type: 4, value: 139 }],
  });
}

export interface SyntheticJpegOptions {
  readonly width: number;
  readonly height: number;
  readonly exif?: Uint8Array;
  readonly xmp?: string;
  readonly comment?: string;
  readonly iptc?: boolean;
  readonly icc?: boolean;
  /** Distinguishes otherwise identical images (entropy-coded filler). */
  readonly seed?: number;
}

/** A structurally valid JPEG header (SOI, metadata, DQT, SOF0, DHT, SOS) followed by filler scan data and EOI. */
/** One JPEG marker segment (marker, big-endian length, payload). */
export function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const length = payload.length + 2;
  return concat([new Uint8Array([0xff, marker, length >> 8, length & 0xff]), payload]);
}

export function syntheticJpeg(options: SyntheticJpegOptions): Uint8Array {
  const segment = jpegSegment;
  const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  parts.push(segment(0xe0, concat([ascii("JFIF\0"), new Uint8Array([1, 1, 0, 0, 1, 0, 1, 0, 0])])));
  if (options.exif) parts.push(segment(0xe1, options.exif));
  if (options.xmp) parts.push(segment(0xe1, concat([ascii("http://ns.adobe.com/xap/1.0/\0"), ascii(options.xmp)])));
  if (options.icc) parts.push(segment(0xe2, concat([ascii("ICC_PROFILE\0"), new Uint8Array([1, 1, 0, 0, 0, 0])])));
  if (options.iptc) parts.push(segment(0xed, concat([ascii("Photoshop 3.0\0"), ascii("8BIM synthetic-iptc")])));
  if (options.comment) parts.push(segment(0xfe, ascii(options.comment)));
  parts.push(segment(0xdb, new Uint8Array(65)));
  parts.push(segment(0xc0, new Uint8Array([8, options.height >> 8, options.height & 0xff, options.width >> 8, options.width & 0xff, 1, 1, 0x11, 0])));
  parts.push(segment(0xc4, new Uint8Array(29)));
  parts.push(segment(0xda, new Uint8Array([1, 1, 0, 0, 0x3f, 0])));
  parts.push(new Uint8Array([options.seed ?? 0, 0x12, 0x34, 0x56, 0xff, 0xd9]));
  return concat(parts);
}

/** Inserts an APP1 EXIF right after SOI (like the engine's capture-time writer). */
export function insertExif(jpeg: Uint8Array, exif: Uint8Array): Uint8Array {
  const length = exif.length + 2;
  return concat([jpeg.subarray(0, 2), new Uint8Array([0xff, 0xe1, length >> 8, length & 0xff]), exif, jpeg.subarray(2)]);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

export const hex = (bytes: Uint8Array): string => bytesToHex(sha256(bytes));

export function recipeFor(revision: number, masks: readonly string[] = []): RecipeDocument {
  return {
    revision, settings: { v: 1, engine: ENGINE, exposure: revision }, settingsSha256: `${revision}`.padStart(64, "0"), baseVersion: null,
    maskSurfaceIds: [...masks], updatedAt: "2026-11-07T00:00:00.000Z",
  };
}

export function bindingFor(sourceSha256: string, recipe: RecipeDocument, overrides: Partial<RenderBinding> = {}): RenderBinding {
  return {
    sourceGeneration: 1, sourceSha256, recipeRevision: recipe.revision, settingsSha256: recipe.settingsSha256, engine: ENGINE,
    rendererManifestSha256: MANIFEST, maskSurfaceIds: [...recipe.maskSurfaceIds], ...overrides,
  };
}

export type SyntheticSource = RenderSource & { readonly generation: number };

/** In-memory originals keyed by photo. */
export function sourcePort(sources: Map<string, SyntheticSource>, masks = new Map<string, Uint8Array>()): RenderSourcePort & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    async open(photo, expected) {
      opened.push(photo.photoId);
      const source = sources.get(photo.photoId);
      if (!source) return { kind: "missing" };
      if (source.generation !== expected.generation || hex(source.bytes) !== expected.sha256) return { kind: "changed" };
      return { kind: "ok", source };
    },
    async loadMaskSurface(_photo, surfaceId) {
      return masks.get(surfaceId) ?? null;
    },
  };
}

export function syntheticSource(photoId: string, options: { width?: number; height?: number; exif?: Uint8Array; xmp?: string; format?: RenderSource["format"] } = {}): SyntheticSource {
  const width = options.width ?? 1200;
  const height = options.height ?? 800;
  return {
    bytes: syntheticJpeg({ width, height, seed: seedOf(photoId), ...(options.exif ? { exif: options.exif } : {}), ...(options.xmp ? { xmp: options.xmp } : {}) }),
    format: options.format ?? "jpeg", width, height, capturedAt: "2026-11-01T09:30:00", capturedAtOffset: "+09:00", generation: 1,
  };
}

export interface FakeRendererControl {
  readonly renderer: DeviceRenderer;
  readonly started: string[];
  inFlight: number;
  maxInFlight: number;
  /** Hold the next render of this photo until released. */
  hold(photoId: string): () => void;
}

/**
 * Stands in for the engine: draws a synthetic JPEG of the full (or preview) size. `leakSourceMetadata` copies the
 * source's metadata segments like a careless encoder would; `captureExif` emulates the engine's capture-time writer.
 */
export function fakeRenderer(options: {
  leakSourceMetadata?: boolean;
  formats?: DeviceRenderer["formats"];
  capability?: RenderCapability;
  captureExif?: (jpeg: Uint8Array, utc: string, offsetMinutes: number) => Uint8Array;
  onRender?: (photoId: string) => void;
} = {}): FakeRendererControl {
  const holds = new Map<number, Promise<void>>();
  const control: FakeRendererControl = {
    started: [],
    inFlight: 0,
    maxInFlight: 0,
    hold(photoId) {
      let release = (): void => undefined;
      holds.set(seedOf(photoId), new Promise<void>((resolve) => { release = resolve; }));
      return () => release();
    },
    renderer: {
      capability: options.capability ?? CAPABILITY,
      formats: options.formats ?? ["jpeg", "png"],
      fullResolutionMaxEdge: 4096,
      async render(input) {
        const photoId = `rev${input.recipe.revision}`;
        control.started.push(photoId);
        control.inFlight += 1;
        control.maxInFlight = Math.max(control.maxInFlight, control.inFlight);
        options.onRender?.(photoId);
        try {
          await Promise.resolve();
          const held = [...holds.entries()].find(([key]) => key === seedOfSource(input.source));
          if (held) { holds.delete(held[0]); await held[1]; }
          const scale = input.maxEdge === null ? 1 : Math.min(1, input.maxEdge / Math.max(input.source.width, input.source.height));
          const width = Math.round(input.source.width * scale);
          const height = Math.round(input.source.height * scale);
          const base = syntheticJpeg({ width, height, seed: input.recipe.revision });
          const bytes = options.leakSourceMetadata
            ? syntheticJpeg({
                width, height, seed: input.recipe.revision, exif: cameraExifWithLocation(),
                xmp: '<x:xmpmeta><rdf:Description exif:GPSLatitude="35" aux:SerialNumber="SERIAL-0001" xmpMM:DerivedFrom="file:///DCIM/100SYNTH/IMG_0001.JPG"/></x:xmpmeta>',
                comment: "/DCIM/100SYNTH/IMG_0001.JPG", iptc: true, icc: true,
              })
            : base;
          return { bytes, width, height, colorProfile: "sRGB", fullResolution: input.maxEdge === null };
        } finally {
          control.inFlight -= 1;
        }
      },
      ...(options.captureExif === undefined
        ? {
            async withCaptureTime(jpeg: Uint8Array, utc: string, offsetMinutes: number) {
              const local = new Date(Date.parse(utc) + offsetMinutes * 60_000).toISOString().slice(0, 19).replace("T", " ").replace(/-/gu, ":");
              const sign = offsetMinutes < 0 ? "-" : "+";
              const minutes = Math.abs(offsetMinutes);
              const offset = `${sign}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
              return insertExif(jpeg, engineCaptureExif(local, offset, 1, 1));
            },
          }
        : { async withCaptureTime(jpeg: Uint8Array, utc: string, offsetMinutes: number) { return options.captureExif?.(jpeg, utc, offsetMinutes) as Uint8Array; } }),
    },
  };
  return control;
}

/** Each synthetic original carries a per-photo seed in its scan data, so a render can be held by photo. */
export function seedOf(photoId: string): number {
  let sum = 7;
  for (const char of photoId) sum = (sum * 31 + char.charCodeAt(0)) % 251;
  return sum;
}
function seedOfSource(source: RenderSource): number {
  return source.bytes[source.bytes.length - 6] ?? -1;
}

export const photoRef = (photoId: string): PhotoRef => ({ libraryId: "synthetic-library", photoId });
