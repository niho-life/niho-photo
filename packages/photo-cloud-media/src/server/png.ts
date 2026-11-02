import { PHOTO_LIMITS } from "../../../photo-library-contract/src/v2.ts";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < CRC_TABLE.length; n += 1) {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[n] = value >>> 0;
}

export interface PngInfo {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly srgbIntent: number | null;
  readonly chunks: readonly string[];
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.allocUnsafe(4);
  const checksum = Buffer.allocUnsafe(4);
  length.writeUInt32BE(data.byteLength);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])));
  return Buffer.concat([length, typeBytes, Buffer.from(data), checksum]);
}

/** Parse every PNG chunk, checking lengths, CRCs, ordering, and resource bounds. */
export function inspectPng(bytes: Uint8Array, options: { readonly output?: boolean; readonly allowExif?: boolean } = {}): PngInfo {
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (input.byteLength < SIGNATURE.byteLength + 25 || !input.subarray(0, 8).equals(SIGNATURE)) throw new Error("invalid png");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let sawIdat = false;
  let endedIdat = false;
  let sawSrgb = false;
  let srgbIntent: number | null = null;
  let sawIend = false;
  let chunks = 0;
  // PNG16 working copies may legitimately contain hundreds of IDAT chunks.
  // Bound input parsing independently from the smaller sanitized output envelope.
  const maxChunks = options.output ? 256 : Math.min(65_536, Math.max(256, Math.floor(input.byteLength / 12)));
  const types: string[] = [];
  while (offset < input.byteLength) {
    if (++chunks > maxChunks || offset + 12 > input.byteLength) throw new Error("invalid png");
    const length = input.readUInt32BE(offset);
    const type = input.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const next = dataEnd + 4;
    if (!/^[A-Za-z]{4}$/.test(type) || !Number.isSafeInteger(next) || next > input.byteLength) throw new Error("invalid png");
    if (crc32(input.subarray(offset + 4, dataEnd)) !== input.readUInt32BE(dataEnd)) throw new Error("invalid png");
    if (type[0] === type[0]?.toUpperCase() && !["IHDR", "PLTE", "IDAT", "IEND"].includes(type)) throw new Error("unsupported png chunk");
    if (sawIend) throw new Error("invalid png");
    if (chunks === 1) {
      if (type !== "IHDR" || length !== 13) throw new Error("invalid png");
      width = input.readUInt32BE(dataStart);
      height = input.readUInt32BE(dataStart + 4);
      bitDepth = input[dataStart + 8]!;
      colorType = input[dataStart + 9]!;
      const compression = input[dataStart + 10]!;
      const filter = input[dataStart + 11]!;
      const interlace = input[dataStart + 12]!;
      if (!width || !height || width * height > PHOTO_LIMITS.browserDirectMaxPixels || ![0, 2, 3, 4, 6].includes(colorType)
        || ![1, 2, 4, 8, 16].includes(bitDepth) || compression !== 0 || filter !== 0 || ![0, 1].includes(interlace)) throw new Error("invalid png");
    } else if (type === "IHDR") {
      throw new Error("invalid png");
    }
    if (type === "IDAT") {
      if (endedIdat) throw new Error("invalid png");
      sawIdat = true;
    } else if (sawIdat && type !== "IEND") {
      endedIdat = true;
    }
    if (type === "acTL" || type === "fcTL" || type === "fdAT" || (type === "eXIf" && !options.allowExif)) throw new Error("unsupported png");
    if (options.output && !["IHDR", "IDAT", "IEND", "sRGB"].includes(type)) throw new Error("unsafe png output");
    if (type === "sRGB") {
      const intent = input[dataStart];
      if (sawSrgb || sawIdat || length !== 1 || intent === undefined || intent > 3 || (options.output && intent !== 0)) throw new Error("invalid png color profile");
      sawSrgb = true;
      srgbIntent = intent;
    }
    if (type === "IEND") {
      if (length !== 0 || !sawIdat || next !== input.byteLength) throw new Error("invalid png");
      sawIend = true;
    }
    types.push(type);
    offset = next;
  }
  if (!sawIend) throw new Error("invalid png");
  return { width, height, bitDepth, colorType, srgbIntent, chunks: types };
}

/** The pinned engine emits sRGB pixel values; make that output profile explicit. */
export function markSrgbPng(bytes: Uint8Array): Buffer {
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const info = inspectPng(input, { output: true });
  if (info.chunks.includes("sRGB")) return Buffer.from(input);
  const srgb = chunk("sRGB", Buffer.from([0]));
  const ihdrEnd = 8 + 12 + 13;
  return Buffer.concat([input.subarray(0, ihdrEnd), srgb, input.subarray(ihdrEnd)]);
}
