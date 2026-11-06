/**
 * Metadata of finished JPEGs on the device that renders them (B07 #248, Epic §9). The engine encoder writes untagged
 * sRGB with no metadata, and its capture-time writer emits a fixed tag set; every output is still rebuilt and verified
 * here, so a renderer that copied EXIF/XMP/IPTC/ICC/comments from the source, or hid data in a segment that looks
 * allowed, between scans or after EOI, never uploads location, serials or paths. The server re-decodes at commit as
 * well; this is the first fence, not the only one.
 */
import { readJpegHeaderSegments } from "niho-photo-editing/image-bytes-metadata";

const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP14 = 0xee;
const APP15 = 0xef;
const COM = 0xfe;
const SOS = 0xda;
const EOI = 0xd9;
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const JFIF_HEADER = [0x4a, 0x46, 0x49, 0x46, 0x00]; // "JFIF\0"
const ICC_HEADER = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00]; // "ICC_PROFILE\0"
const ADOBE_HEADER = [0x41, 0x64, 0x6f, 0x62, 0x65]; // "Adobe"
/** The only APP0 a finished photo carries: JFIF 1.01, no density unit, 1:1, no thumbnail (exactly 14 bytes). */
const CANONICAL_JFIF = new Uint8Array([...JFIF_HEADER, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
/** The engine's capture-time EXIF is about 250 bytes; anything much larger cannot be that block. */
const MAX_EXIF_BYTES = 1024;

/**
 * Tags the engine's capture-time writer (`withCaptureExif`) emits, and nothing else is allowed in a finished photo:
 * IFD0 Orientation(=1), YCbCrPositioning, ExifIFDPointer; Exif IFD ExifVersion, DateTimeOriginal, OffsetTimeOriginal,
 * ComponentsConfiguration, SubSecTimeOriginal, FlashpixVersion, ColorSpace, PixelXDimension, PixelYDimension.
 */
export const RENDITION_EXIF_ALLOWED_TAGS = {
  ifd0: [0x0112, 0x0213, 0x8769],
  exif: [0x9000, 0x9003, 0x9011, 0x9101, 0x9291, 0xa000, 0xa001, 0xa002, 0xa003],
} as const;

const EXIF_IFD_POINTER = 0x8769;
const GPS_IFD_POINTER = 0x8825;
const INTEROP_IFD_POINTER = 0xa005;
/** Names for tags whose presence matters to the B00 forbidden-key check (`findForbiddenMetadata`). */
const TAG_NAMES: Readonly<Record<number, string>> = {
  0x010e: "ImageDescription", 0x010f: "Make", 0x0110: "Model", 0x0112: "Orientation", 0x0131: "Software", 0x0132: "DateTime",
  0x013b: "Artist", 0x0213: "YCbCrPositioning", 0x8298: "Copyright", 0x8769: "ExifIFDPointer", 0x8825: "GPSInfo",
  0x9000: "ExifVersion", 0x9003: "DateTimeOriginal", 0x9011: "OffsetTimeOriginal", 0x9101: "ComponentsConfiguration",
  0x927c: "MakerNote", 0x9291: "SubSecTimeOriginal", 0xa000: "FlashpixVersion", 0xa001: "ColorSpace", 0xa002: "PixelXDimension",
  0xa003: "PixelYDimension", 0xa005: "InteropIFDPointer", 0xa420: "ImageUniqueID", 0xa430: "CameraOwnerName",
  0xa431: "BodySerialNumber", 0xa435: "LensSerialNumber", 0xc62f: "CameraSerialNumber",
};

export type JpegMetadataSegmentKind = "jfif" | "exif" | "xmp" | "icc" | "adobe" | "comment" | "otherApp";

export interface JpegMetadataScan {
  /** Metadata-bearing segments anywhere in the file, in order (frame/table/scan segments are not listed). */
  readonly segments: readonly JpegMetadataSegmentKind[];
  /** Whether every APP0 is exactly the canonical JFIF block. */
  readonly canonicalJfif: boolean;
  /** EXIF tag IDs by directory; null when there is no EXIF segment. */
  readonly exif: { readonly ifd0: readonly number[]; readonly exif: readonly number[]; readonly gps: readonly number[]; readonly interop: readonly number[] } | null;
  readonly exifBytes: number;
  /** XMP packet text, if any (for key scanning). */
  readonly xmp: readonly string[];
  /** Bytes after EOI. */
  readonly trailingBytes: number;
}

type Part =
  | { readonly kind: "segment"; readonly marker: number; readonly dataStart: number; readonly end: number }
  | { readonly kind: "entropy"; readonly start: number; readonly end: number };

/**
 * Every marker segment and entropy-coded run from SOI to EOI (header, between scans, after the last scan). null when
 * the structure cannot be followed to EOI.
 */
function walkJpeg(bytes: Uint8Array): { readonly parts: readonly Part[]; readonly eoiEnd: number } | null {
  const header = readJpegHeaderSegments(bytes);
  if (!header || header.length === 0 || header[header.length - 1].marker !== SOS) return null;
  const parts: Part[] = header.map((segment) => ({ kind: "segment", marker: segment.marker, dataStart: segment.dataStart, end: segment.end }));
  let offset = header[header.length - 1].end;
  while (offset < bytes.length) {
    const start = offset;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const next = bytes[offset + 1];
      if (next === 0x00 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
      if (next === 0xff) { offset += 1; continue; }
      break;
    }
    if (offset + 1 >= bytes.length) return null;
    if (offset > start) parts.push({ kind: "entropy", start, end: offset });
    const marker = bytes[offset + 1];
    if (marker === EOI) return { parts, eoiEnd: offset + 2 };
    if (offset + 4 > bytes.length) return null;
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    parts.push({ kind: "segment", marker, dataStart: offset + 4, end: offset + 2 + length });
    offset += 2 + length;
  }
  return null;
}

/**
 * Rebuilds a JPEG with its frame, tables and scans only: one canonical JFIF, no other APPn (EXIF, XMP, ICC, Adobe,
 * IPTC, vendor), no comments anywhere, nothing after EOI. null when the bytes are not a JPEG this can follow safely.
 * The engine writes untagged sRGB, so dropping ICC never changes how its pixels are meant to be read.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array<ArrayBuffer> | null {
  const walked = walkJpeg(bytes);
  if (!walked) return null;
  const out: Uint8Array[] = [new Uint8Array([0xff, 0xd8]), segmentBytes(APP0, CANONICAL_JFIF)];
  for (const part of walked.parts) {
    if (part.kind === "entropy") { out.push(bytes.subarray(part.start, part.end)); continue; }
    if (isMetadataMarker(part.marker)) continue;
    out.push(new Uint8Array([0xff, part.marker]), bytes.subarray(part.dataStart - 2, part.end));
  }
  out.push(new Uint8Array([0xff, EOI]));
  return concat(out);
}

/** Lists metadata segments (anywhere), EXIF tags and trailing data of a JPEG. null when the structure cannot be read. */
export function scanJpegMetadata(bytes: Uint8Array): JpegMetadataScan | null {
  const walked = walkJpeg(bytes);
  if (!walked) return null;
  const kinds: JpegMetadataSegmentKind[] = [];
  const xmp: string[] = [];
  let exif: JpegMetadataScan["exif"] = null;
  let exifBytes = 0;
  let canonicalJfif = true;
  for (const part of walked.parts) {
    if (part.kind !== "segment" || !isMetadataMarker(part.marker)) continue;
    const kind = segmentKind(bytes, part);
    kinds.push(kind);
    if (part.marker === APP0 && !equalBytes(bytes.subarray(part.dataStart, part.end), CANONICAL_JFIF)) canonicalJfif = false;
    if (kind === "exif") {
      exifBytes = Math.max(exifBytes, part.end - part.dataStart);
      // An unreadable EXIF block cannot be proven clean: report it as carrying an unknown tag.
      exif = readExifTags(bytes.subarray(part.dataStart + EXIF_HEADER.length, part.end)) ?? { ifd0: [0xffff], exif: [], gps: [], interop: [] };
    }
    if (kind === "xmp") xmp.push(new TextDecoder().decode(bytes.subarray(part.dataStart, part.end)));
  }
  return { segments: kinds, canonicalJfif, exif, exifBytes, xmp, trailingBytes: bytes.length - walked.eoiEnd };
}

/**
 * Problems that keep a finished JPEG from being uploaded. Allowed: the canonical JFIF and at most one small EXIF block
 * holding only the engine writer's tags. Anything else (ICC, Adobe, XMP, IPTC, comments, other EXIF tags, IFD1
 * thumbnails, GPS/Interop directories, data after EOI) is a violation.
 */
export function renditionMetadataViolations(bytes: Uint8Array): readonly string[] {
  const scan = scanJpegMetadata(bytes);
  if (!scan) return ["unreadable"];
  const violations: string[] = [];
  for (const kind of scan.segments) if (kind !== "jfif" && kind !== "exif") violations.push(`segment:${kind}`);
  if (!scan.canonicalJfif) violations.push("segment:jfif-noncanonical");
  if (scan.segments.filter((kind) => kind === "exif").length > 1) violations.push("segment:exif-duplicate");
  if (scan.exifBytes > MAX_EXIF_BYTES) violations.push("exif:oversized");
  if (scan.trailingBytes > 0) violations.push("trailing-data");
  if (scan.exif) {
    const allowedIfd0 = new Set<number>(RENDITION_EXIF_ALLOWED_TAGS.ifd0);
    const allowedExif = new Set<number>(RENDITION_EXIF_ALLOWED_TAGS.exif);
    for (const tag of scan.exif.ifd0) if (!allowedIfd0.has(tag)) violations.push(`exif:${tagName(tag)}`);
    for (const tag of scan.exif.exif) if (!allowedExif.has(tag)) violations.push(`exif:${tagName(tag)}`);
    for (const tag of [...scan.exif.gps, ...scan.exif.interop]) violations.push(`exif:${tagName(tag)}`);
  }
  return violations;
}

/**
 * Decoded metadata as named keys, in the shape the B00 forbidden-key check (`findForbiddenMetadata`) reads. Used by
 * the synthetic server to stand in for the real server validator.
 */
export function jpegMetadataRecord(bytes: Uint8Array): Readonly<Record<string, unknown>> {
  const scan = scanJpegMetadata(bytes);
  if (!scan) return { unreadable: true };
  const record: Record<string, unknown> = {};
  if (scan.exif) {
    for (const tag of [...scan.exif.ifd0, ...scan.exif.exif, ...scan.exif.interop]) record[tagName(tag)] = true;
    if (scan.exif.gps.length > 0) record.GPSInfo = Object.fromEntries(scan.exif.gps.map((tag) => [`GPSTag${tag}`, true]));
  }
  scan.xmp.forEach((packet, index) => {
    const names = [...packet.matchAll(/<([A-Za-z][\w.-]*:[\w.-]+)|([A-Za-z][\w.-]*:[\w.-]+)\s*=/gu)].map((match) => match[1] ?? match[2]);
    record[`xmp${index}`] = Object.fromEntries(names.map((name) => [name, true]));
  });
  if (scan.segments.includes("comment")) record.comment = true;
  return record;
}

// ---------------------------------------------------------------------------------------------------------

function isMetadataMarker(marker: number): boolean {
  return (marker >= APP0 && marker <= APP15) || marker === COM;
}

function segmentKind(bytes: Uint8Array, segment: { readonly marker: number; readonly dataStart: number }): JpegMetadataSegmentKind {
  const marker = segment.marker;
  if (marker === COM) return "comment";
  if (marker === APP0) return startsWith(bytes, segment.dataStart, JFIF_HEADER) ? "jfif" : "otherApp";
  if (marker === APP1) return startsWith(bytes, segment.dataStart, EXIF_HEADER) ? "exif" : "xmp";
  if (marker === APP2 && startsWith(bytes, segment.dataStart, ICC_HEADER)) return "icc";
  if (marker === APP14 && startsWith(bytes, segment.dataStart, ADOBE_HEADER)) return "adobe";
  return "otherApp";
}

/** Reads the tag IDs of IFD0 and the Exif, GPS and Interop IFDs of a TIFF block. null when malformed. */
function readExifTags(tiff: Uint8Array): { ifd0: number[]; exif: number[]; gps: number[]; interop: number[] } | null {
  try {
    return readExifTagsUnchecked(tiff);
  } catch {
    // An offset outside the block (RangeError) means the block cannot be read, so it cannot be proven clean.
    return null;
  }
}

function readExifTagsUnchecked(tiff: Uint8Array): { ifd0: number[]; exif: number[]; gps: number[]; interop: number[] } | null {
  if (tiff.length < 8) return null;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!little && !big) return null;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const u16 = (offset: number): number => view.getUint16(offset, little);
  const u32 = (offset: number): number => view.getUint32(offset, little);
  if (u16(2) !== 42) return null;
  const visited = new Set<number>();
  const readIfd = (offset: number): { tag: number; value: number }[] | null => {
    if (offset < 8 || offset + 2 > tiff.length || visited.has(offset)) return null;
    visited.add(offset);
    const count = u16(offset);
    if (offset + 2 + count * 12 + 4 > tiff.length || count > 512) return null;
    const entries: { tag: number; value: number }[] = [];
    for (let index = 0; index < count; index += 1) {
      const entry = offset + 2 + index * 12;
      entries.push({ tag: u16(entry), value: u32(entry + 8) });
    }
    return entries;
  };
  const ifd0Offset = u32(4);
  const ifd0 = readIfd(ifd0Offset);
  if (!ifd0) return null;
  const pointer = (entries: readonly { tag: number; value: number }[], tag: number): number | null =>
    entries.find((entry) => entry.tag === tag)?.value ?? null;
  const sub = (offset: number | null): number[] | null => {
    if (offset === null) return [];
    const entries = readIfd(offset);
    return entries ? entries.map((entry) => entry.tag) : null;
  };
  const exifPointer = pointer(ifd0, EXIF_IFD_POINTER);
  const exifEntries = exifPointer === null ? [] : readIfd(exifPointer);
  if (!exifEntries) return null;
  const gps = sub(pointer(ifd0, GPS_IFD_POINTER));
  const interop = sub(pointer(exifEntries, INTEROP_IFD_POINTER));
  if (!gps || !interop) return null;
  // IFD1 (thumbnail) may embed another JPEG with its own metadata; it is never allowed in a finished photo.
  const next = u32(ifd0Offset + 2 + ifd0.length * 12);
  const ifd0Tags = ifd0.map((entry) => entry.tag);
  if (next !== 0) ifd0Tags.push(0xfffe);
  return { ifd0: ifd0Tags, exif: exifEntries.map((entry) => entry.tag), gps, interop };
}

function tagName(tag: number): string {
  if (tag === 0xfffe) return "IFD1Thumbnail";
  if (tag === 0xffff) return "UnreadableExif";
  return TAG_NAMES[tag] ?? `Tag0x${tag.toString(16).padStart(4, "0")}`;
}

function segmentBytes(marker: number, payload: Uint8Array): Uint8Array {
  const length = payload.length + 2;
  return concat([new Uint8Array([0xff, marker, length >> 8, length & 0xff]), payload]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function startsWith(bytes: Uint8Array, offset: number, prefix: readonly number[]): boolean {
  if (offset + prefix.length > bytes.length) return false;
  return prefix.every((value, index) => bytes[offset + index] === value);
}
