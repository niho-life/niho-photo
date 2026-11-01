import { formatBrowserPhotoFileSize } from "./browser-photo-export";
import type { PhotoLibraryPhoto, PhotoLibraryPhotoInfo } from "./library/photo-library";
import { PHOTO_EDITING_INFO_GROUP_TITLES, PHOTO_EDITING_INFO_ROW_LABELS } from "./photo-editing-copy";

/**
 * 右パネルの「情報」（niho-photo#43。Lightroom の「情報」）の行を、写真の行（ファイル名・形式・大きさ・撮影日時）と写真の情報
 * （{@link PhotoLibraryPhotoInfo}。撮影条件・カメラ・レンズ・寸法・場所）から組み立てる。
 *
 * - 群は 撮影条件 → カメラ・レンズ → ファイル の順。値の無い行（無い・非有限・0 以下）は行ごと出さず、行の無い群は見出しも出さない
 * - 値は表示の単位まで整える（「1/250 秒」「f/2.8」「35 mm」「6000 × 4000（24 MP）」「24.3 MB」）。読み上げはラベルと値を続けて
 *   読む（「ISO 400」）ので、値にラベルの語を繰り返さない
 * - 数と単位の間は改行しない空白（{@link NBSP}）にする（狭い右パネルで「33」と「MP」が別の行に分かれないように）
 */

/** 数と単位の間の、改行しない空白（読み上げ・見た目はふつうの空白）。 */
export const NBSP = "\u00a0";

export type PhotoEditingInfoRowKey = keyof typeof PHOTO_EDITING_INFO_ROW_LABELS;

export type PhotoEditingInfoRow = { key: PhotoEditingInfoRowKey; label: string; value: string };

export type PhotoEditingInfoGroupKey = keyof typeof PHOTO_EDITING_INFO_GROUP_TITLES;

export type PhotoEditingInfoGroup = { key: PhotoEditingInfoGroupKey; title: string; rows: PhotoEditingInfoRow[] };

/** 情報の「ファイル」の群に使う写真の行の項目。 */
export type PhotoEditingInfoPhoto = Pick<PhotoLibraryPhoto, "fileName" | "fileExtension" | "sizeBytes" | "capturedAt">;

function positiveNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** 小数を `digits` 桁までにし、末尾の 0 を落とす（`2.80` → `2.8`、`4.0` → `4`）。 */
function trimDecimal(value: number, digits: number): string {
  return String(Number(value.toFixed(digits)));
}

/** ISO 感度（ラベル「ISO」と並べて「ISO 400」と読む）。 */
export function formatPhotoInfoIso(iso: number | null | undefined): string | null {
  const value = positiveNumber(iso);
  return value === null ? null : String(Math.round(value));
}

/**
 * シャッター速度。1 秒未満は逆数が整数に近ければ「1/250 秒」、近くなければ小数（「0.4 秒」）。1 秒以上は「1 秒」「2.5 秒」「30 秒」
 * （小数は 1 桁まで）。
 */
export function formatPhotoInfoShutter(seconds: number | null | undefined): string | null {
  const value = positiveNumber(seconds);
  if (value === null) return null;
  if (value < 1) {
    const reciprocal = 1 / value;
    const rounded = Math.round(reciprocal);
    // 逆数の丸めの誤差（1/3 = 0.333… など）は許す。1 に丸まる値（0.97 秒など）は 1 秒
    if (Math.abs(reciprocal - rounded) <= Math.max(0.05, reciprocal * 0.01)) {
      return rounded <= 1 ? `1${NBSP}秒` : `1/${rounded}${NBSP}秒`;
    }
    return `${trimDecimal(value, value < 0.1 ? 2 : 1)}${NBSP}秒`;
  }
  return `${trimDecimal(value, 1)}${NBSP}秒`;
}

/** 絞り（「f/2.8」。整数は「f/4」）。 */
export function formatPhotoInfoAperture(fNumber: number | null | undefined): string | null {
  const value = positiveNumber(fNumber);
  return value === null ? null : `f/${trimDecimal(value, 1)}`;
}

/**
 * 撮影時の露出（ISO 100 の EV。空の検出の「明るい」の基準。niho-photo#141）: `log2(N² / t) − log2(ISO / 100)`。絞り・シャッター
 * 速度・ISO のどれかが無い・非有限・0 以下なら null（写真の中の相対の明るさで探す）。
 */
export function photoInfoEv100(
  info: Pick<PhotoLibraryPhotoInfo, "iso" | "exposureTimeSeconds" | "fNumber"> | null | undefined,
): number | null {
  const fNumber = positiveNumber(info?.fNumber);
  const seconds = positiveNumber(info?.exposureTimeSeconds);
  const iso = positiveNumber(info?.iso);
  if (fNumber === null || seconds === null || iso === null) return null;
  const ev100 = Math.log2((fNumber * fNumber) / seconds) - Math.log2(iso / 100);
  return Number.isFinite(ev100) ? ev100 : null;
}

/** 焦点距離（「35 mm」。小数は 1 桁まで）。 */
export function formatPhotoInfoFocalLength(millimeters: number | null | undefined): string | null {
  const value = positiveNumber(millimeters);
  return value === null ? null : `${trimDecimal(value, 1)}${NBSP}mm`;
}

/** 寸法（「6000 × 4000（24 MP）」。10 MP 未満は小数 1 桁、0.1 MP に満たない画は MP を付けない）。 */
export function formatPhotoInfoDimensions(width: number | null | undefined, height: number | null | undefined): string | null {
  const w = positiveNumber(width);
  const h = positiveNumber(height);
  if (w === null || h === null) return null;
  const pixels = `${Math.round(w)} × ${Math.round(h)}`;
  const megapixels = (Math.round(w) * Math.round(h)) / 1_000_000;
  if (megapixels < 0.1) return pixels;
  return `${pixels}（${megapixels >= 10 ? Math.round(megapixels) : trimDecimal(megapixels, 1)}${NBSP}MP）`;
}

/** ファイルの大きさ（「24.3 MB」。書き出しの 1 行と同じ 1024 基準。0 以下は出さない）。 */
export function formatPhotoInfoFileSize(bytes: number | null | undefined): string | null {
  return positiveNumber(bytes) === null ? null : formatBrowserPhotoFileSize(bytes as number).replace(" ", NBSP);
}

/** 形式（拡張子の大文字。JPEG・TIFF は名前にそろえる: `jpg` → 「JPEG」、`RW2` → 「RW2」）。 */
export function formatPhotoInfoFormat(fileExtension: string | null | undefined): string | null {
  const extension = (fileExtension ?? "").trim().replace(/^\./, "").toLowerCase();
  if (!extension) return null;
  if (extension === "jpg" || extension === "jpeg" || extension === "jpe") return "JPEG";
  if (extension === "tif" || extension === "tiff") return "TIFF";
  return extension.toUpperCase();
}

/** カメラ（メーカーと機種。機種の名前がメーカーの名前で始まっていれば機種だけ: 「Canon」「Canon EOS R5」→「Canon EOS R5」）。 */
export function formatPhotoInfoCamera(camera: PhotoLibraryPhotoInfo["camera"]): string | null {
  const make = camera?.make?.trim() ?? "";
  const model = camera?.model?.trim() ?? "";
  if (!model) return make || null;
  if (!make) return model;
  const brand = make.split(/\s+/)[0]?.toLowerCase() ?? "";
  return model.toLowerCase().startsWith(brand) ? model : `${make} ${model}`;
}

const WALL_CLOCK_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
const ZONED_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const CAPTURED_AT_OPTIONS: Intl.DateTimeFormatOptions = { dateStyle: "long", timeStyle: "medium" };
/** 時差の無い日時（撮影した場所の時計）をそのまま出す */
const WALL_CLOCK_FORMAT = new Intl.DateTimeFormat("ja-JP", { ...CAPTURED_AT_OPTIONS, timeZone: "UTC" });
/** 時差の付いた日時は日本時間で出す（一覧の日付の見出しと同じ） */
const TOKYO_FORMAT = new Intl.DateTimeFormat("ja-JP", { ...CAPTURED_AT_OPTIONS, timeZone: "Asia/Tokyo" });

/**
 * 撮影日時（「2024年5月1日 10:30:15」）。時差の無い ISO 8601（EXIF の撮影日時）は撮影した場所の時計のまま、時差・`Z` の付いた値
 * （クラウドの行）は日本時間で出す。読めない値は出さない。
 */
export function formatPhotoInfoCapturedAt(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  const wallClock = WALL_CLOCK_DATE_TIME.exec(text);
  if (wallClock) {
    const [year, month, day, hour, minute, second] = wallClock.slice(1).map((part) => Number(part ?? 0)) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const time = Date.UTC(year, month - 1, day, hour, minute, second);
    const date = new Date(time);
    // 2 月 30 日・25 時のような値は繰り上げずに捨てる
    if (
      !Number.isFinite(time) ||
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day ||
      date.getUTCHours() !== hour ||
      date.getUTCMinutes() !== minute
    ) {
      return null;
    }
    return WALL_CLOCK_FORMAT.format(time);
  }
  if (!ZONED_DATE_TIME.test(text)) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? TOKYO_FORMAT.format(time) : null;
}

/**
 * 撮影した場所（「35.3192° N, 139.5467° E」。小数 4 桁まで。地図は出さない）。範囲の外・非有限、測位できていない印の 0, 0 は出さない。
 */
export function formatPhotoInfoLocation(gps: PhotoLibraryPhotoInfo["gps"]): string | null {
  if (!gps) return null;
  const { latitude, longitude } = gps;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  if (latitude === 0 && longitude === 0) return null;
  const degrees = (value: number) => `${Math.abs(value).toFixed(4)}°`;
  return `${degrees(latitude)}${NBSP}${latitude < 0 ? "S" : "N"}, ${degrees(longitude)}${NBSP}${longitude < 0 ? "W" : "E"}`;
}

function textValue(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text ? text : null;
}

/**
 * 情報の群（撮影条件 → カメラ・レンズ → ファイル）。`info` が null（読めない置き場・読めなかった）でも、写真の行のファイルの項目
 * （名前・形式・大きさ・撮影日時）は出す。撮影日時は写真の情報（ファイルの EXIF）を先に、無ければ写真の行のものを使う。
 */
export function photoEditingInfoGroups(photo: PhotoEditingInfoPhoto, info: PhotoLibraryPhotoInfo | null): PhotoEditingInfoGroup[] {
  const row = (key: PhotoEditingInfoRowKey, value: string | null): PhotoEditingInfoRow[] =>
    value === null ? [] : [{ key, label: PHOTO_EDITING_INFO_ROW_LABELS[key], value }];
  const groups: PhotoEditingInfoGroup[] = [
    {
      key: "exposure",
      title: PHOTO_EDITING_INFO_GROUP_TITLES.exposure,
      rows: [
        ...row("iso", formatPhotoInfoIso(info?.iso)),
        ...row("shutter", formatPhotoInfoShutter(info?.exposureTimeSeconds)),
        ...row("aperture", formatPhotoInfoAperture(info?.fNumber)),
        ...row("focalLength", formatPhotoInfoFocalLength(info?.focalLengthMm)),
      ],
    },
    {
      key: "camera",
      title: PHOTO_EDITING_INFO_GROUP_TITLES.camera,
      rows: [...row("camera", formatPhotoInfoCamera(info?.camera)), ...row("lens", textValue(info?.lens))],
    },
    {
      key: "file",
      title: PHOTO_EDITING_INFO_GROUP_TITLES.file,
      rows: [
        ...row("fileName", textValue(photo.fileName)),
        ...row("format", formatPhotoInfoFormat(photo.fileExtension)),
        ...row("dimensions", formatPhotoInfoDimensions(info?.width, info?.height)),
        ...row("fileSize", formatPhotoInfoFileSize(photo.sizeBytes)),
        ...row(
          "capturedAt",
          formatPhotoInfoCapturedAt(info?.capturedAt) ?? formatPhotoInfoCapturedAt(photo.capturedAt),
        ),
        ...row("location", formatPhotoInfoLocation(info?.gps)),
      ],
    },
  ];
  return groups.filter((group) => group.rows.length > 0);
}
