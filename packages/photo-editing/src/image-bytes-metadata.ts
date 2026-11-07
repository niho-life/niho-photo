/**
 * アップロード前の画像をデコードせずにバイト列だけで扱う小さな道具（NIHO camera C1 移行元設計 で web の `lib/v2/uploads-image-metadata` から
 * 移した。写真編集の寸法の読み取りと web のアップロードが同じ関数を使い、web は元の場所から再 export する）。
 *
 * - 寸法の読み取り（JPEG の SOF / PNG の IHDR）: 縮小が要らない画像はデコードせずに済ませる。
 * - JPEG の EXIF から GPS だけを消す: 画素を再エンコードせず（無劣化）、向き（Orientation）も残す。
 */

export type ImagePixelSize = { width: number; height: number };

export type JpegGpsScrubResult =
  /** EXIF / XMP に位置情報が無い。バイト列はそのまま使ってよい。 */
  | { status: "no-gps" }
  /** EXIF の GPS を消した。長さは元と同じで、GPS 以外の EXIF（向きを含む）は残る。 */
  | { status: "scrubbed"; bytes: Uint8Array }
  /** 位置情報がある（または判定できない）が、バイト列のままでは安全に消せない。再エンコードで落とす。 */
  | { status: "unscrubbable" };

const JPEG_SOI = 0xd8;
const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;
const JPEG_APP1 = 0xe1;

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const TIFF_TAG_GPS_IFD_POINTER = 0x8825;
const IFD_ENTRY_BYTES = 12;

// TIFF の型ごとの 1 要素のバイト数。未知の型は値の置き場所の長さが分からないので扱わない。
const TIFF_TYPE_BYTES: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
  13: 4, // IFD
};

const XMP_GPS_MARKERS = ["GPSLatitude", "GPSLongitude"];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** One JPEG header segment up to and including SOS (`dataStart`..`end` is the payload after the length). */
export type JpegSegment = {
  marker: number;
  /** セグメント本体（長さ 2 バイトの直後）の開始位置。 */
  dataStart: number;
  /** セグメントの終端（排他的）。 */
  end: number;
};

function readU16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function startsWithAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset + expected.length > bytes.length) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

function isJpegSofMarker(marker: number): boolean {
  // SOF0–SOF15 のうち DHT(C4) / JPG(C8) / DAC(CC) を除いたものがフレームヘッダ。
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * SOI から SOS（圧縮データの開始）までのメタデータセグメントを並べる。
 * JPEG でない・途中で壊れている場合は null。
 */
/** Header segments from SOI through SOS (null for non-JPEG or truncated input). Shared with the render-output scrub. */
export function readJpegHeaderSegments(bytes: Uint8Array): JpegSegment[] | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== JPEG_SOI) return null;

  const segments: JpegSegment[] = [];
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    // マーカー前の 0xFF の詰め物は読み飛ばす。
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset];
    offset += 1;

    if (marker === JPEG_EOI) return segments;
    // RST0–7 / TEM は長さを持たない。
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;

    if (offset + 2 > bytes.length) return null;
    const length = readU16BE(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return null;
    segments.push({ marker, dataStart: offset + 2, end: offset + length });
    if (marker === JPEG_SOS) return segments;
    offset += length;
  }
  return null;
}

export function readJpegPixelSize(bytes: Uint8Array): ImagePixelSize | null {
  const segments = readJpegHeaderSegments(bytes);
  if (!segments) return null;
  const frame = segments.find((segment) => isJpegSofMarker(segment.marker));
  if (!frame || frame.end - frame.dataStart < 5) return null;
  const height = readU16BE(bytes, frame.dataStart + 1);
  const width = readU16BE(bytes, frame.dataStart + 3);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

export function readPngPixelSize(bytes: Uint8Array): ImagePixelSize | null {
  // シグネチャ(8) + IHDR の長さ(4) + "IHDR"(4) + 幅(4) + 高さ(4)
  if (bytes.length < 24 || !startsWithAt(bytes, 0, PNG_SIGNATURE)) return null;
  if (!startsWithAt(bytes, 12, [0x49, 0x48, 0x44, 0x52])) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

type Range = { start: number; end: number };

function overlaps(a: Range, b: Range): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * 1 つの EXIF(APP1) セグメントの中で GPS IFD を消す。
 * - GPS IFD 本体と、その値の置き場所（4 バイトを超える値）をゼロで塗る。
 * - IFD0 から GPS IFD へのポインタ項目を取り除き、後ろの項目と「次の IFD」オフセットを 12 バイト詰める。
 * バイト列の長さもオフセットも変えないので、他の EXIF（向き・サムネイル）は壊れない。
 * 戻り値: "none"=GPS なし / "scrubbed"=消した / "unsafe"=構造が想定外で消せない
 */
function scrubExifSegmentGps(bytes: Uint8Array, segment: JpegSegment): "none" | "scrubbed" | "unsafe" {
  const tiffStart = segment.dataStart + EXIF_HEADER.length;
  const tiffEnd = segment.end;
  if (tiffStart + 8 > tiffEnd) return "unsafe";

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const byteOrder = readU16BE(bytes, tiffStart);
  let littleEndian: boolean;
  if (byteOrder === 0x4949) littleEndian = true;
  else if (byteOrder === 0x4d4d) littleEndian = false;
  else return "unsafe";

  const u16 = (absolute: number) => view.getUint16(absolute, littleEndian);
  const u32 = (absolute: number) => view.getUint32(absolute, littleEndian);
  const inTiff = (range: Range) => range.start >= tiffStart && range.end <= tiffEnd && range.start <= range.end;

  if (u16(tiffStart + 2) !== 42) return "unsafe";

  const ifd0Start = tiffStart + u32(tiffStart + 4);
  if (!inTiff({ start: ifd0Start, end: ifd0Start + 2 })) return "unsafe";
  const ifd0Count = u16(ifd0Start);
  const ifd0 = { start: ifd0Start, end: ifd0Start + 2 + ifd0Count * IFD_ENTRY_BYTES + 4 };
  if (!inTiff(ifd0)) return "unsafe";

  let gpsEntryIndex = -1;
  for (let index = 0; index < ifd0Count; index += 1) {
    if (u16(ifd0Start + 2 + index * IFD_ENTRY_BYTES) === TIFF_TAG_GPS_IFD_POINTER) {
      gpsEntryIndex = index;
      break;
    }
  }
  if (gpsEntryIndex === -1) return "none";

  const gpsEntry = ifd0Start + 2 + gpsEntryIndex * IFD_ENTRY_BYTES;
  const gpsIfdStart = tiffStart + u32(gpsEntry + 8);
  if (!inTiff({ start: gpsIfdStart, end: gpsIfdStart + 2 })) return "unsafe";
  const gpsCount = u16(gpsIfdStart);
  const gpsIfd = { start: gpsIfdStart, end: gpsIfdStart + 2 + gpsCount * IFD_ENTRY_BYTES + 4 };
  if (!inTiff(gpsIfd) || overlaps(gpsIfd, ifd0)) return "unsafe";

  // 先に塗る範囲をすべて検証してから書き換える（途中で失敗して半端に壊さない）。
  const rangesToZero: Range[] = [gpsIfd];
  for (let index = 0; index < gpsCount; index += 1) {
    const entry = gpsIfdStart + 2 + index * IFD_ENTRY_BYTES;
    const typeBytes = TIFF_TYPE_BYTES[u16(entry + 2)];
    if (typeBytes === undefined) return "unsafe";
    const valueBytes = typeBytes * u32(entry + 4);
    if (valueBytes <= 4) continue; // 値は項目の中にあり、項目ごと塗られる
    const valueStart = tiffStart + u32(entry + 8);
    const valueRange = { start: valueStart, end: valueStart + valueBytes };
    if (!inTiff(valueRange) || overlaps(valueRange, ifd0)) return "unsafe";
    rangesToZero.push(valueRange);
  }

  for (const range of rangesToZero) bytes.fill(0, range.start, range.end);

  // IFD0 から GPS ポインタ項目を抜き、後続の項目と次 IFD オフセット(4 バイト)を前へ詰める。
  bytes.copyWithin(gpsEntry, gpsEntry + IFD_ENTRY_BYTES, ifd0.end);
  bytes.fill(0, ifd0.end - IFD_ENTRY_BYTES, ifd0.end);
  view.setUint16(ifd0Start, ifd0Count - 1, littleEndian);
  return "scrubbed";
}

function segmentContainsAscii(bytes: Uint8Array, segment: JpegSegment, needle: string): boolean {
  const pattern = Array.from(needle, (char) => char.charCodeAt(0));
  const last = segment.end - pattern.length;
  for (let offset = segment.dataStart; offset <= last; offset += 1) {
    if (bytes[offset] === pattern[0] && startsWithAt(bytes, offset, pattern)) return true;
  }
  return false;
}

/**
 * JPEG の位置情報（EXIF の GPS IFD）を無劣化で消す。元の配列は書き換えず、必要なときだけ複製を返す。
 *
 * EXIF(APP1) を丸ごと消すと Orientation も消えて縦横が崩れるため、GPS IFD だけを消す方式にしている。
 * XMP 側に GPS がある（編集ソフト経由の写真など）場合や、EXIF が壊れていて判定できない場合は
 * "unscrubbable" を返し、呼び出し側が再エンコードで全メタデータを落とす。
 */
export function scrubJpegGpsMetadata(source: Uint8Array): JpegGpsScrubResult {
  const segments = readJpegHeaderSegments(source);
  if (!segments) return { status: "unscrubbable" };

  const app1Segments = segments.filter((segment) => segment.marker === JPEG_APP1);
  const exifSegments = app1Segments.filter((segment) => startsWithAt(source, segment.dataStart, EXIF_HEADER));
  const otherApp1Segments = app1Segments.filter((segment) => !exifSegments.includes(segment));
  if (otherApp1Segments.some((segment) => XMP_GPS_MARKERS.some((marker) => segmentContainsAscii(source, segment, marker)))) {
    return { status: "unscrubbable" };
  }
  if (exifSegments.length === 0) return { status: "no-gps" };

  let bytes: Uint8Array | null = null;
  for (const segment of exifSegments) {
    const working: Uint8Array = bytes ?? source.slice();
    const outcome = scrubExifSegmentGps(working, segment);
    if (outcome === "unsafe") return { status: "unscrubbable" };
    if (outcome === "scrubbed") bytes = working;
  }
  return bytes ? { status: "scrubbed", bytes } : { status: "no-gps" };
}
