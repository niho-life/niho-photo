import type { PhotoLibraryItem } from "./library/photo-library";

import { browserCanvasLockedReason, browserCloudLockedReason, isBrowserCloudRawPhoto } from "./browser-photo-cloud-source";
import {
  BROWSER_PHOTO_EXPORT_LARGE_LONG_EDGE,
  BROWSER_PHOTO_EXPORT_LONG_EDGE,
  BROWSER_PHOTO_WORKING_COPY_LONG_EDGE,
} from "./browser-photo-source";
import { isEditableDevelopSettings } from "./develop-engine/develop-settings";
import { isDevelopWorkTarget, type DevelopWorkTargetPhoto } from "./develop-engine/develop-work-target";
import { workExportWaitingText } from "./develop-engine/develop-work-wait";
import {
  PHOTO_EDITING_BATCH_EXPORT_FOLDER_HINT_TEXT,
  PHOTO_EDITING_EXPORT_CAPTURE_EXIF_TEXT,
  PHOTO_EDITING_EXPORT_CUTOUT_DETAIL,
  PHOTO_EDITING_EXPORT_CUTOUT_WHITE_TEXT,
  PHOTO_EDITING_EXPORT_ENGINE_UNAVAILABLE_TEXT,
  PHOTO_EDITING_EXPORT_FULL_SIZE_DETAIL,
  PHOTO_EDITING_EXPORT_FULL_SIZE_TEXT,
  PHOTO_EDITING_EXPORT_FULL_SIZE_UNSUPPORTED_SOURCE_TEXT,
  PHOTO_EDITING_EXPORT_ORIGINAL_TEXT,
  PHOTO_EDITING_EXPORT_PNG_NO_EXIF_TEXT,
  PHOTO_EDITING_EXPORT_PNG_TEXT,
  photoEditingBatchFolderExportText,
  photoEditingExportLargeDetail,
} from "./photo-editing-copy";
import { photoEditingFileStem } from "./photo-editing-file-names";
import { photoEditingNativeExportBlockers, photoEditingNativeExportUnsupportedText } from "./photo-editing-native-export";

/**
 * ブラウザ版の写真編集の「書き出す」（移行元設計・F7b 移行元設計・移行時の設計文書「書き出す」）。下段の主ボタンを
 * 押すと上に出るシートで「大きさ」（長辺 2048px / 幅 1080px。原寸の書き出しに対応した NIHO Desktop の口があれば「原寸」も。K2-3a
 * 移行元設計）と「形式」（JPEG / オリジナル）を選んで書き出す。押せない形式・大きさは薄くして、副文に理由を出す。
 *
 * `png` は NIHO camera で背景除去を重ねている写真だけ（{@link BrowserPhotoExportChoices} の `png`。C4 移行元設計）。複数枚・スマホの
 * シートには出さない。
 */
export type BrowserPhotoExportFormat = "jpeg" | "png" | "original";

export type BrowserPhotoExportChoice = {
  enabled: boolean;
  /** 副文（押せるときは中身、押せないときは理由） */
  detail: string;
};

/**
 * JPEG をどの経路で描くか。`engine` は段 2 の wasm で入力（オリジナルか作業コピー）から描く（1 枚で開いている写真は今の補正、
 * 一覧で選んだだけの写真は保存してある補正。K3 移行元設計「使うときに描く」）、`canvas` は 1 枚で開いた S1 の canvas で描く、
 * `webImage` は記事用の画像をそのまま落とす（最後の手段）。`native` は大きさの「原寸」で、NIHO Desktop の native の段 2 で
 * クラウドのオリジナルから原寸を描き、ネイティブの保存ダイアログでこの Mac に保存する（K2-3a 移行元設計。1 枚のシートでは `jpeg.route`
 * には入らず、シートで原寸を選んだときだけ {@link browserPhotoExportJpegRoute} が返す）。複数枚のフォルダへの書き出し（K2-3b）は
 * 大きさが原寸だけなので `jpeg.route` が `native`（{@link isBrowserPhotoExportFullSizeOnly}）。
 */
export type BrowserPhotoExportJpegRoute = "engine" | "canvas" | "webImage" | "native";

export type BrowserPhotoExportJpegChoice = BrowserPhotoExportChoice & {
  /** 描く経路（押せなければ null）。シートの表示と `runExport` の経路はこれ 1 つで決める */
  route: BrowserPhotoExportJpegRoute | null;
  /** 大きさを選べるか（`engine` だけ。canvas・記事用の画像は長辺 2048px だけ） */
  sizeSelectable: boolean;
  /** 撮影日時の EXIF を付けるか（`engine` で、撮影日時の分かる写真だけ。付けないときはシートの 1 行も出さない） */
  captureExif: boolean;
  /**
   * 大きさの「原寸」（K2-3a 移行元設計）。原寸の書き出しに対応した NIHO Desktop の口があるときだけ持つ（無ければカードを出さない）。
   * 押せるのは大きさを選べる JPEG（`sizeSelectable`）で、Desktop が原寸を描ける写真（クラウドにオリジナルのある RAW・JPEG・PNG）
   * だけ。押せないときは副文に理由（HEIC / TIFF は {@link PHOTO_EDITING_EXPORT_FULL_SIZE_UNSUPPORTED_SOURCE_TEXT}）。
   */
  fullSize?: BrowserPhotoExportChoice;
  /**
   * 大きさの「大きく」（niho-photo#134。長辺 2048px より大きく、JPEG / PNG は元の大きさで最大 4096px、作業コピーで直す写真は
   * 2560px まで）。段 2 の wasm で描く JPEG（`engine`）だけが持ち、スマホで wasm のメモリに収まらない写真は持たない（カードを出さない）
   */
  large?: BrowserPhotoExportChoice;
};

export type BrowserPhotoExportChoices = {
  jpeg: BrowserPhotoExportJpegChoice;
  original: BrowserPhotoExportChoice;
  /**
   * PNG（背景除去を反映。NIHO camera で背景除去を重ねている写真だけ。C4 移行元設計）。無ければ形式に出さない。大きさと経路は JPEG と
   * 同じ（`jpeg.sizeSelectable`・`jpeg.fullSize`・{@link browserPhotoExportJpegRoute}）で、EXIF は付けない
   */
  png?: BrowserPhotoExportChoice;
  /** 書き出しに背景除去を当てる（`png` と一緒に持つ）。`transparent` は背景が透明（JPEG では白にする） */
  cutout?: { transparent: boolean };
};

/** 形式の選択肢（PNG の無いシートでは null）。 */
export function browserPhotoExportChoice(
  choices: Pick<BrowserPhotoExportChoices, "png"> & Record<"jpeg" | "original", BrowserPhotoExportChoice>,
  format: BrowserPhotoExportFormat,
): BrowserPhotoExportChoice | null {
  return format === "png" ? (choices.png ?? null) : choices[format];
}

/** 複数枚の「大きく」のカード（長辺は写真ごとに違うので、JPEG / PNG と RAW の上限を並べる）。 */
export const BROWSER_PHOTO_EXPORT_BATCH_LARGE_CHOICE: BrowserPhotoExportChoice = Object.freeze({
  enabled: true,
  detail: photoEditingExportLargeDetail({
    upTo: BROWSER_PHOTO_EXPORT_LARGE_LONG_EDGE,
    workingCopyUpTo: BROWSER_PHOTO_WORKING_COPY_LONG_EDGE,
  }),
});

/**
 * 一覧で選んだ複数写真を ZIP にまとめるシート。JPEG は記事用画像へ替えず、必ず engine で入力から描く。
 *
 * ZIP を保存できない NIHO Desktop のうち、フォルダへ原寸で書き出せる口（`desktopFolderExport`。原寸の書き出しとフォルダの選択の
 * 両方。K2-3b 移行元設計）があれば、ZIP の代わりに「フォルダへ原寸で書き出す」シートにする: 大きさは「原寸」だけ（経路 `native`。
 * 長辺 2048px・幅 1080px は ZIP でしか書き出せないので出さない）、形式は JPEG（補正を反映）だけで、オリジナルは押せず理由に
 * {@link PHOTO_EDITING_BATCH_EXPORT_FOLDER_HINT_TEXT}。native の段 2 で描くので段 2 の wasm（`engineUsable`）には依らない。
 * ZIP を保存できる環境（ブラウザ）では `desktopFolderExport` を見ない（ZIP のシートは変えない）。
 */
export function resolveBrowserPhotoBatchExportChoices(input: {
  engineUsable: boolean;
  zipSaveAvailable: boolean;
  /** フォルダへ原寸で書き出せる NIHO Desktop の口がある（K2-3b 移行元設計。省略 = 無い） */
  desktopFolderExport?: boolean;
}): BrowserPhotoExportChoices {
  if (!input.zipSaveAvailable && input.desktopFolderExport) {
    return {
      jpeg: {
        enabled: true,
        detail: "補正を反映",
        route: "native",
        sizeSelectable: false,
        captureExif: true,
        fullSize: { enabled: true, detail: PHOTO_EDITING_EXPORT_FULL_SIZE_DETAIL },
      },
      original: { enabled: false, detail: PHOTO_EDITING_BATCH_EXPORT_FOLDER_HINT_TEXT },
    };
  }
  if (!input.zipSaveAvailable) {
    const detail = "ZIP は NIHO Desktop と NIHO アプリでは保存できません。ブラウザで開いてください。";
    return {
      jpeg: disabledJpeg(detail),
      original: { enabled: false, detail },
    };
  }

  return {
    jpeg: input.engineUsable
      ? {
          enabled: true,
          detail: "補正を反映して ZIP にまとめます",
          route: "engine",
          sizeSelectable: true,
          captureExif: true,
          // 「大きく」も選べる（1 回の ZIP の合計の上限 500MB はそのまま。niho-photo#134）
          large: BROWSER_PHOTO_EXPORT_BATCH_LARGE_CHOICE,
        }
      : disabledJpeg(PHOTO_EDITING_EXPORT_ENGINE_UNAVAILABLE_TEXT),
    original: { enabled: true, detail: "そのまま ZIP にまとめます" },
  };
}

type ExportPhoto = DevelopWorkTargetPhoto &
  Pick<PhotoLibraryItem, "fileName" | "hasDevelopSettings" | "hasWebImage" | "workStatus" | "capturedAt">;

/**
 * 書き出しの大きさ（`long2048` は長辺 2048px、`width1080` は幅 1080px、`large` は「大きく」〔元の大きさで最大 4096px。
 * niho-photo#134〕）。段 2 の wasm で描く大きさ。
 */
export type BrowserPhotoExportSize = "long2048" | "width1080" | "large";

/**
 * シートの「大きさ」で選べる値（この端末に覚える値も）。`full`（原寸）は原寸の書き出しに対応した NIHO Desktop の口があるときだけ
 * 選べ、wasm ではなく Desktop の native の段 2 で描く（経路 `native`。K2-3a 移行元設計）。
 */
export type BrowserPhotoExportSizeOption = BrowserPhotoExportSize | "full";

/**
 * シートの「大きさ」のいつも出す 2 枚（モック `idea/mock/photo-editing-mobile-v1.html` の書き出すのシート）。「大きく」は写真ごとに
 * 長辺が違うので `jpeg.large` から、「原寸」は `jpeg.fullSize` から足す。
 */
export const BROWSER_PHOTO_EXPORT_SIZE_OPTIONS: readonly {
  size: Exclude<BrowserPhotoExportSize, "large">;
  label: string;
  detail: string;
}[] = [
  { size: "long2048", label: "長辺 2048px", detail: "標準" },
  { size: "width1080", label: "幅 1080px", detail: "Instagram" },
];

/** 「幅 1080px」の幅（Instagram）。 */
export const BROWSER_PHOTO_EXPORT_INSTAGRAM_WIDTH = 1080;

/**
 * 書き出しの EXIF の撮影日時を表示する時差（分）。サーバーは `capturedAt` を UTC で持ち、拠点はすべて日本（夏時間なし）なので
 * +09:00 で書く（API の `PHOTO_CAPTURED_AT_DEFAULT_UTC_OFFSET_MINUTES` と同じ）。
 */
export const BROWSER_PHOTO_EXPORT_CAPTURE_OFFSET_MINUTES = 540;

/**
 * 書き出しの長辺（段 2 の `maxDimension`）。`frame` は長辺 2048px で描いたときの出力の寸法（切り抜き・回転の後。
 * `geometryOutputSize`）。`long2048` は 2048。`width1080` は横長・正方形は 1080、縦長は幅が 1080 になる長辺（長辺 2048px が上限。
 * 4:5 の 1638×2048 は 1350 で 1080×1350、1:3 は 2048 で頭打ち）。`large` は 4096（元・作業コピーの大きさで頭打ち）。小さい写真は
 * 拡大しない（段 2 は縮めるだけ）。
 */
export function browserPhotoExportLongEdge(
  size: BrowserPhotoExportSize,
  frame: { width: number; height: number },
): number {
  if (size === "long2048") return BROWSER_PHOTO_EXPORT_LONG_EDGE;
  if (size === "large") return BROWSER_PHOTO_EXPORT_LARGE_LONG_EDGE;
  if (frame.width >= frame.height) return BROWSER_PHOTO_EXPORT_INSTAGRAM_WIDTH;
  return Math.min(
    BROWSER_PHOTO_EXPORT_LONG_EDGE,
    Math.round((BROWSER_PHOTO_EXPORT_INSTAGRAM_WIDTH * frame.height) / frame.width),
  );
}

const BYTES_PER_MB = 1024 * 1024;

/** オリジナルの大きさ（例: 「24.1 MB」。1MB 未満は KB）。 */
export function formatBrowserPhotoFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes >= BYTES_PER_MB) return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** JPEG の書き出しの名前（`<元の名前の拡張子なし>.jpg`）。 */
export function browserPhotoExportJpegFileName(fileName: string): string {
  return `${photoEditingFileStem(fileName) || "photo"}.jpg`;
}

/** PNG の書き出しの名前（`<元の名前の拡張子なし>.png`。背景除去。C4 移行元設計）。 */
export function browserPhotoExportPngFileName(fileName: string): string {
  return `${photoEditingFileStem(fileName) || "photo"}.png`;
}

/**
 * 「大きく」のカード（niho-photo#134）。書き出す長辺（`longEdge`。1 枚で開いた写真は切り抜き後の長辺）が分かればそれを、分からなければ
 * 上限（作業コピーで直す写真は 2560px、JPEG / PNG は 4096px）を出す。
 */
export function browserPhotoExportLargeChoice(photo: ExportPhoto, longEdge: number | null): BrowserPhotoExportChoice {
  if (longEdge !== null && longEdge > 0) return { enabled: true, detail: photoEditingExportLargeDetail({ longEdge }) };
  const upTo = isDevelopWorkTarget(photo) ? BROWSER_PHOTO_WORKING_COPY_LONG_EDGE : BROWSER_PHOTO_EXPORT_LARGE_LONG_EDGE;
  return { enabled: true, detail: photoEditingExportLargeDetail({ upTo }) };
}

/**
 * 段 2 の wasm で入力から描く JPEG（大きさを選べる。撮影日時の EXIF は撮影日時の分かる写真だけに付ける）。`large` が null なら
 * 「大きく」を出さない。
 */
function engineJpeg(photo: ExportPhoto, large: BrowserPhotoExportChoice | null): BrowserPhotoExportJpegChoice {
  return {
    enabled: true,
    detail: "補正を反映",
    route: "engine",
    sizeSelectable: true,
    captureExif: typeof photo.capturedAt === "string" && photo.capturedAt.length > 0,
    ...(large ? { large } : {}),
  };
}

function withoutLarge(jpeg: BrowserPhotoExportJpegChoice): BrowserPhotoExportJpegChoice {
  const rest = { ...jpeg };
  delete rest.large;
  return rest;
}

function disabledJpeg(detail: string): BrowserPhotoExportJpegChoice {
  return { enabled: false, detail, route: null, sizeSelectable: false, captureExif: false };
}

/** NIHO Desktop の原寸の書き出しがそのまま描ける JPEG / PNG の拡張子（Desktop の `export_input`。RAW はほかに数える）。 */
const DESKTOP_FULL_SIZE_RASTER_EXTENSIONS: ReadonlySet<string> = new Set(["jpg", "jpeg", "png"]);
/** 原寸の書き出しで HEIC / HEIF・TIFF も描ける口（NIHO camera。`capabilities.nativeExportRaster`）が足して描ける拡張子。 */
const NATIVE_FULL_SIZE_RASTER_EXTENSIONS: ReadonlySet<string> = new Set(["heic", "heif", "tif", "tiff"]);

/**
 * NIHO Desktop の原寸の書き出し（`photo_editing_export_develop`）が描ける形式か。RAW は同じ土台の原寸、JPEG / PNG はオリジナルから
 * 描く。HEIC / HEIF・TIFF は Desktop が `unsupportedSource` で断るので、シートで先に押せなくする（複数枚のフォルダへの書き出し
 * 〔K2-3b〕は、その写真のオリジナルを Desktop へ落とす前に失敗の 1 行にする）。`raster`（`capabilities.nativeExportRaster`。
 * NIHO camera）なら HEIC / HEIF・TIFF も描ける。
 */
export function isDesktopFullSizeSource(
  photo: Pick<ExportPhoto, "fileExtension">,
  options: { raster?: boolean } = {},
): boolean {
  const extension = photo.fileExtension.trim().toLowerCase();
  return (
    isBrowserCloudRawPhoto(photo) ||
    DESKTOP_FULL_SIZE_RASTER_EXTENSIONS.has(extension) ||
    (options.raster === true && NATIVE_FULL_SIZE_RASTER_EXTENSIONS.has(extension))
  );
}

/** 背景除去の原寸は、native の現像口と、この写真を描ける形式の両方が揃ったときだけ公開する。 */
export function isBrowserPhotoCutoutFullSizeAvailable(
  photo: Pick<PhotoLibraryItem, "hasOriginal" | "fileExtension">,
  input: { hostExport: boolean; nativeExport: boolean; nativeExportRaster?: boolean },
): boolean {
  return (
    input.hostExport &&
    input.nativeExport &&
    photo.hasOriginal &&
    isDesktopFullSizeSource(photo, { raster: input.nativeExportRaster === true })
  );
}

/**
 * 大きさの「原寸」（K2-3a 移行元設計）。オリジナルが無ければオリジナルの理由、Desktop が描けない形式は「HEIC・TIFF は対応していません」。
 * それ以外は、ほかの大きさと同じく段 2 で描く JPEG（`sizeSelectable`）のときだけ押せる（記事用の画像・canvas の間は大きさの
 * カードごと押せない）。
 */
function fullSizeChoice(
  photo: ExportPhoto,
  jpeg: BrowserPhotoExportJpegChoice,
  original: BrowserPhotoExportChoice,
  raster: boolean,
): BrowserPhotoExportChoice {
  if (!photo.hasOriginal) return { enabled: false, detail: original.detail };
  if (!isDesktopFullSizeSource(photo, { raster })) {
    return { enabled: false, detail: PHOTO_EDITING_EXPORT_FULL_SIZE_UNSUPPORTED_SOURCE_TEXT };
  }
  return { enabled: jpeg.sizeSelectable, detail: PHOTO_EDITING_EXPORT_FULL_SIZE_DETAIL };
}

/**
 * 一覧で選んだだけの写真を、段 2 の wasm で入力から描けるか（1 枚で開かなくてよい）。保存してある補正がこの画面の版で読め、
 * オリジナルから描く写真（JPEG / PNG。`isDevelopWorkTarget` でない）はオリジナルがブラウザで読める形、作業コピーから描く写真
 * （RAW など）は作業コピーができている。1 枚で開いてブラウザでは直せないと分かった写真（`locked`）は描かない。
 */
function isListRenderable(photo: ExportPhoto, locked: boolean): boolean {
  if (locked || !isEditableDevelopSettings(photo.developSettings)) return false;
  return isDevelopWorkTarget(photo) ? photo.workStatus === "ready" : browserCloudLockedReason(photo) === null;
}

/**
 * 選んでいる写真の書き出しの形式（シートの表示と `runExport` の経路をここで決める）。
 *
 * - JPEG（使うときに描く。K3 移行元設計・Epic 決まりごと 1「記事用の画像を縮めて代わりに使わない」）。優先順:
 *   1. 1 枚で補正の入力を読めている: 段 2 の wasm なら `engine`、S1 の canvas なら `canvas`（今の補正を反映。副文「補正を反映」）
 *   2. 段 2 の wasm を使え（まだ試していないときも使える扱い）、一覧から描ける写真（{@link isListRenderable}）: `engine`
 *      （保存してある補正を反映。狭い幅でも同じ）
 *   3. 元の写真の無い行（「記事の画像」）で記事用の画像がある: `webImage`（その画像そのもの。補正のある行は「補正を反映・長辺
 *      2048px」、ほかは「長辺 2048px」。補正はブラウザと NIHO Desktop で区別しない。owner 決定 2026-09-29）。写真（元の写真のある行）は
 *      記事用の画像を書き出さない（入力から描くか、押せない。写真の面は記事用の画像の列を読まない。K4 移行元設計）
 *   4. それ以外は押せない。オリジナルも記事用の画像も無い写真は「書き出せる画像がありません」、1 枚で開いてブラウザでは直せないと
 *      分かった写真は「ページを読み込み直すと書き出せます」（NIHO Desktop へ送らない。移行元設計）。wasm を使えないときは、S1 の canvas で
 *      描ける写真（補正の無い JPEG / PNG）だけ「1 枚で開くと書き出せます」（1 枚で開けない幅は「PC で開くと書き出せます」、開いても
 *      読めなかった写真は「写真を読み込めませんでした」）で、ほかは「ページを読み込み直すと書き出せます」。wasm を使えるときは、作業
 *      コピーがまだの写真は「RAW の現像の準備ができると書き出せます」（RAW 以外は「編集の準備ができると書き出せます」。W1 移行元設計）、
 *      ほか（新しい版の NIHO で補正された写真など）は「ページを読み込み直すと書き出せます」
 *
 *   一覧から wasm で描けるようになったので、「1 枚で開くと書き出せます」「PC で開くと書き出せます」は wasm を使えない（canvas しか
 *   無い）ときだけに残す（canvas は 1 枚で開いた写真しか描けない）。大きさを選べて撮影日時の EXIF を付けるのは `engine` だけ
 *   （canvas・記事用の画像は長辺 2048px・EXIF 無し）
 * - オリジナル: クラウドにオリジナルがあれば「<ファイル名>・<大きさ>」。無ければ、補正（`developSettings`）を保存してある写真
 *   （Desktop の「オリジナルを置かない」写真で補正したもの）は「クラウドにオリジナルがありません」、ほか（記事から取り込んだ画像
 *   など）は「オリジナルはありません」。補正があるかは `hasDevelopSettings` で見る（K1c 移行元設計。旧エンジンの `hasSettings` は無い）
 * - 原寸（`desktopFullSize` のときだけ `jpeg.fullSize`。K2-3a 移行元設計）: {@link fullSizeChoice}。ブラウザ・原寸の書き出しの無い
 *   Desktop（v20 未満）では持たない（シートは今までどおり 2 枚）
 * - 背景除去（`cutout`。NIHO camera で背景除去を重ねている、1 枚で wasm で開いた写真だけ。C4 移行元設計）: JPEG の副文を「背景除去を
 *   反映」にし、同じ副文の PNG を足す（大きさは JPEG と同じ）。原寸は camera の口（`cutout.fullSize`）があるときだけで、NIHO Desktop
 *   の原寸（`desktopFullSize`）は出さない。wasm で開いていない（`editing` が `wasm` でない）ときは何も変えない
 */
export function resolveBrowserPhotoExportChoices(input: {
  photo: ExportPhoto;
  /** 1 枚で開いている */
  loupe: boolean;
  /** 1 枚で補正の入力を読めている（今の補正を反映して描ける）描き方。`wasm` は段 2、`canvas` は S1。読めていなければ null */
  editing: "wasm" | "canvas" | null;
  /** 1 枚で開いて、ブラウザでは直せないと分かった（このブラウザで補正を描けない写真など） */
  locked: boolean;
  /** 1 枚で開くと補正の入力を読む幅（1024px 以上か、スマホの編集を使える） */
  wide: boolean;
  /** 段 2 の wasm を使える（用意できなかったと分かるまでは true） */
  engineUsable: boolean;
  /** 原寸の書き出しに対応した NIHO Desktop の口がある（K2-3a 移行元設計。省略 = ブラウザ） */
  desktopFullSize?: boolean;
  /** 原寸の書き出しで HEIC / HEIF・TIFF も描ける（`capabilities.nativeExportRaster`。NIHO camera。省略 = 描けない） */
  desktopFullSizeRaster?: boolean;
  /** 現在の補正に native renderer が描けない補正〔中間調・全体の輝度・遠近・修復・レンズ補正〕がある（省略時は保存済み設定から判定） */
  nativeFullSizeUnsupported?: boolean;
  /** 上の理由の 1 行（原寸のカードの副文。省略時は保存済み設定から作る） */
  nativeFullSizeUnsupportedText?: string;
  /**
   * 「大きく」（niho-photo#134）を出すか（省略 = 出す）。スマホで wasm のメモリに収まらない写真は false
   * （{@link isBrowserPhotoExportLargeWithinMobileMemory}）
   */
  large?: boolean;
  /** 「大きく」で書き出す長辺（1 枚で開いた写真の切り抜き後の長辺。分からなければ省略 = 上限を出す） */
  largeLongEdge?: number | null;
  /**
   * 書き出す写真に背景除去を重ねている（NIHO camera だけ。C4 移行元設計。省略 = 無い）。`transparent` は背景が透明、`fullSize` は
   * camera の原寸の書き出しの口がある
   */
  cutout?: { transparent: boolean; fullSize: boolean };
}): BrowserPhotoExportChoices {
  const { photo, locked } = input;
  const large = input.large === false ? null : browserPhotoExportLargeChoice(photo, input.largeLongEdge ?? null);
  const savedNativeBlockers = photoEditingNativeExportBlockers(photo.developSettings ?? {});
  const nativeFullSizeUnsupported = input.nativeFullSizeUnsupported ?? savedNativeBlockers.length > 0;
  const nativeFullSizeUnsupportedText =
    input.nativeFullSizeUnsupportedText ?? photoEditingNativeExportUnsupportedText(savedNativeBlockers);

  let jpeg: BrowserPhotoExportJpegChoice;
  if (input.editing === "wasm") {
    jpeg = engineJpeg(photo, large);
  } else if (input.editing === "canvas") {
    jpeg = { enabled: true, detail: "補正を反映", route: "canvas", sizeSelectable: false, captureExif: false };
  } else if (input.engineUsable && isListRenderable(photo, locked)) {
    jpeg = engineJpeg(photo, large);
  } else if (!photo.hasOriginal && photo.hasWebImage !== false) {
    jpeg = {
      enabled: true,
      detail: photo.hasDevelopSettings ? "補正を反映・長辺 2048px" : "長辺 2048px",
      route: "webImage",
      sizeSelectable: false,
      captureExif: false,
    };
  } else if (!photo.hasOriginal) {
    jpeg = disabledJpeg("書き出せる画像がありません");
  } else if (locked) {
    jpeg = disabledJpeg("ページを読み込み直すと書き出せます");
  } else if (!input.engineUsable) {
    // S1 の canvas は 1 枚で開いた、補正の無い JPEG / PNG だけを描ける
    const canvasDrawable =
      !isDevelopWorkTarget(photo) && browserCloudLockedReason(photo) === null && browserCanvasLockedReason(photo) === null;
    jpeg = disabledJpeg(
      !canvasDrawable
        ? "ページを読み込み直すと書き出せます"
        : !input.wide
          ? "PC で開くと書き出せます"
          : input.loupe
            ? "写真を読み込めませんでした"
            : "1 枚で開くと書き出せます",
    );
  } else if (isDevelopWorkTarget(photo) && photo.workStatus !== "ready") {
    jpeg = disabledJpeg(workExportWaitingText(isBrowserCloudRawPhoto(photo)));
  } else {
    jpeg = disabledJpeg("ページを読み込み直すと書き出せます");
  }

  const original: BrowserPhotoExportChoice = photo.hasOriginal
    ? { enabled: true, detail: `${photo.fileName}・${formatBrowserPhotoFileSize(photo.sizeBytes)}` }
    : {
        enabled: false,
        detail: photo.hasDevelopSettings ? "クラウドにオリジナルがありません" : "オリジナルはありません",
      };

  if (input.cutout && input.editing === "wasm") {
    const fullSize: BrowserPhotoExportChoice | undefined = input.cutout.fullSize
      ? nativeFullSizeUnsupported
        ? { enabled: false, detail: nativeFullSizeUnsupportedText }
        : { enabled: true, detail: PHOTO_EDITING_EXPORT_FULL_SIZE_DETAIL }
      : undefined;
    return {
      // 背景除去を重ねた書き出しは「大きく」を出さない（長辺 4096px の画への背景の合成は niho-photo#134 では確かめていない）
      jpeg: { ...withoutLarge(jpeg), detail: PHOTO_EDITING_EXPORT_CUTOUT_DETAIL, ...(fullSize ? { fullSize } : {}) },
      png: { enabled: true, detail: PHOTO_EDITING_EXPORT_CUTOUT_DETAIL },
      original,
      cutout: { transparent: input.cutout.transparent },
    };
  }

  if (input.desktopFullSize) {
    jpeg = {
      ...jpeg,
      fullSize: nativeFullSizeUnsupported
        ? { enabled: false, detail: nativeFullSizeUnsupportedText }
        : fullSizeChoice(photo, jpeg, original, input.desktopFullSizeRaster === true),
    };
  }

  return { jpeg, original };
}

/**
 * シートで選んだ大きさで JPEG を描く経路（`runExport` へ渡す値）。原寸は押せるときだけ `native`、ほかの大きさは `jpeg.route`。
 */
export function browserPhotoExportJpegRoute(
  choices: BrowserPhotoExportChoices,
  size: BrowserPhotoExportSizeOption,
): BrowserPhotoExportJpegRoute | null {
  if (size === "full") return choices.jpeg.fullSize?.enabled ? "native" : null;
  return choices.jpeg.route;
}

/** シートを開いたときに選んでおく形式（JPEG → PNG → オリジナルの順に押せるもの。どれも押せなければ null）。 */
export function defaultBrowserPhotoExportFormat(
  choices: Pick<BrowserPhotoExportChoices, "png"> & Record<"jpeg" | "original", BrowserPhotoExportChoice>,
): BrowserPhotoExportFormat | null {
  if (choices.jpeg.enabled) return "jpeg";
  if (choices.png?.enabled) return "png";
  if (choices.original.enabled) return "original";
  return null;
}

/**
 * シートの「大きさ」で選んでいる大きさ（書き出しに渡す値。原寸の無いシート用）。JPEG を段 2 で描かない（canvas・記事用の画像。
 * `sizeSelectable` が false）なら長辺 2048px（実際に書き出す大きさ）、ほかはこの端末で選んだ大きさ（オリジナルを選んでいる間も、
 * 押せないまま見せる）。原寸を覚えていても、原寸の無いシート（スマホ）では長辺 2048px。「大きく」を覚えていても、「大きく」を出さない
 * 写真（スマホで wasm のメモリに収まらない写真など）では長辺 2048px。
 */
export function effectiveBrowserPhotoExportSize(
  choices: BrowserPhotoExportChoices,
  stored: BrowserPhotoExportSizeOption,
): BrowserPhotoExportSize {
  if (!choices.jpeg.sizeSelectable || stored === "full") return "long2048";
  if (stored === "large" && choices.jpeg.large?.enabled !== true) return "long2048";
  return stored;
}

/**
 * 大きさが「原寸」だけのシートか（複数枚のフォルダへの書き出し。K2-3b 移行元設計）。長辺 2048px・幅 1080px のカードを出さず、
 * 覚えた大きさによらず原寸で書き出す。
 */
export function isBrowserPhotoExportFullSizeOnly(choices: BrowserPhotoExportChoices): boolean {
  return choices.jpeg.route === "native";
}

/**
 * {@link effectiveBrowserPhotoExportSize} の、原寸を出すシート（PC）用。覚えた原寸は、原寸を押せる（`jpeg.fullSize.enabled`）ときだけ
 * そのまま、押せない写真（HEIC など）・原寸の無い環境では長辺 2048px。原寸だけのシート（{@link isBrowserPhotoExportFullSizeOnly}）は
 * 覚えた大きさによらず原寸。
 */
export function effectiveBrowserPhotoExportSizeOption(
  choices: BrowserPhotoExportChoices,
  stored: BrowserPhotoExportSizeOption,
): BrowserPhotoExportSizeOption {
  if (isBrowserPhotoExportFullSizeOnly(choices)) return "full";
  if (stored === "full") return choices.jpeg.fullSize?.enabled ? "full" : "long2048";
  return effectiveBrowserPhotoExportSize(choices, stored);
}

/**
 * 複数枚のシートの形式の下の 1 行。形式を選べない（押せる形式が無い）ときは JPEG の理由、ZIP の JPEG は「選んだ N 枚を ZIP に
 * まとめます。」、ZIP のオリジナルは「選んだ N 枚のオリジナルを、そのまま ZIP にまとめます。」。フォルダへの書き出し（原寸だけ。
 * K2-3b 移行元設計）の JPEG は {@link photoEditingBatchFolderExportText}。JPEG は続けて撮影日時の 1 文。
 */
export function browserPhotoBatchExportLine(
  choices: BrowserPhotoExportChoices,
  format: BrowserPhotoExportFormat | null,
  count: number,
): string {
  if (format === null) return choices.jpeg.detail;
  if (format === "original") return `選んだ ${count} 枚のオリジナルを、そのまま ZIP にまとめます。`;
  const lead = isBrowserPhotoExportFullSizeOnly(choices)
    ? photoEditingBatchFolderExportText(count)
    : `選んだ ${count} 枚を ZIP にまとめます。`;
  return `${lead}${PHOTO_EDITING_EXPORT_CAPTURE_EXIF_TEXT}`;
}

/**
 * シートの形式の下の 1 行。JPEG は撮影日時の EXIF を付けるとき（段 2 で描くとき）だけ「撮影日時を付けます。位置情報は付けません。」、
 * 原寸（K2-3a 移行元設計）はその前に「保存先を選ぶと原寸で描きます（24MP で 10 秒ほど）。」（NIHO Desktop の native の段 2 も撮影日時
 * だけを付ける）、オリジナルは「オリジナルをそのまま保存します。」。出さないときは null。
 *
 * 背景除去を重ねている写真（`choices.cutout`。C4 移行元設計）: PNG は「撮影日時は付けません。」（背景が透明なら、その前に「背景の透明を
 * そのまま保存します。」）、JPEG は背景が透明なら最後に「透明の背景は白にします。」。どちらも原寸ならその前に原寸の 1 文。
 */
export function browserPhotoExportLine(
  choices: BrowserPhotoExportChoices,
  format: BrowserPhotoExportFormat | null,
  size: BrowserPhotoExportSizeOption = "long2048",
): string | null {
  if (format === "original") return PHOTO_EDITING_EXPORT_ORIGINAL_TEXT;
  if (format === null) return null;
  const lead = size === "full" ? PHOTO_EDITING_EXPORT_FULL_SIZE_TEXT : "";
  const transparent = choices.cutout?.transparent === true;
  if (format === "png") return `${lead}${transparent ? PHOTO_EDITING_EXPORT_PNG_TEXT : PHOTO_EDITING_EXPORT_PNG_NO_EXIF_TEXT}`;
  const captureExif = choices.jpeg.captureExif ? PHOTO_EDITING_EXPORT_CAPTURE_EXIF_TEXT : "";
  const white = transparent ? PHOTO_EDITING_EXPORT_CUTOUT_WHITE_TEXT : "";
  return `${lead}${captureExif}${white}` || null;
}
