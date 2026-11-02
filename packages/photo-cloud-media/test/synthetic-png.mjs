import { deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < CRC_TABLE.length; n += 1) {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[n] = value >>> 0;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.allocUnsafe(4);
  const checksum = Buffer.allocUnsafe(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

export function withSyntheticTextMetadata(bytes) {
  const text = chunk("tEXt", Buffer.from("Comment\0synthetic", "latin1"));
  const ihdrEnd = 8 + 12 + 13;
  return Buffer.concat([bytes.subarray(0, ihdrEnd), text, bytes.subarray(ihdrEnd)]);
}

export function withSrgbIntent(bytes, intent) {
  if (!Number.isSafeInteger(intent) || intent < 0 || intent > 3) throw new RangeError("invalid sRGB intent");
  const srgb = chunk("sRGB", Buffer.from([intent]));
  const ihdrEnd = 8 + 12 + 13;
  return Buffer.concat([bytes.subarray(0, ihdrEnd), srgb, bytes.subarray(ihdrEnd)]);
}

/** Deterministic RGBA image with valid PNG CRCs and no personal or embedded metadata. */
export function syntheticPng(width = 2, height = 1) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 64) throw new RangeError("invalid synthetic PNG dimensions");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x += 1) {
      const at = 1 + x * 4;
      row[at] = (x * 127 + y * 31) & 0xff;
      row[at + 1] = (y * 127 + x * 17) & 0xff;
      row[at + 2] = 255 - ((x * 71 + y * 19) & 0xff);
      row[at + 3] = 255;
    }
    rows.push(row);
  }
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}
