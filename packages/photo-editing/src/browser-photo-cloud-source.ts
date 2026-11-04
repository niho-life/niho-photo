import { NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS } from "./browser-photo-adjustments";
import {
  BrowserPhotoSourceError,
  browserCloudOriginalMaxBytes,
  decodeBrowserPhoto,
  exportBrowserPhotoJpeg,
} from "./browser-photo-source";
import { isNeutralDevelopSettings } from "./develop-engine/develop-settings";
import type {
  PhotoLibrary,
  PhotoLibraryArticleImage,
  PhotoLibraryFlagFilter,
  PhotoLibraryEditedPreview,
  PhotoLibraryItem,
  PhotoLibraryKindFilter,
  PhotoLibraryPhoto,
} from "./library/photo-library";
import { isDevelopWorkTarget } from "./develop-engine/develop-work-target";
import { isPhotoEditingRawExtension, photoEditingFileStem } from "./photo-editing-file-names";

/**
 * ブラウザ版の写真編集が、クラウドの写真を木に分け、1 枚で開くときの入力を決める（移行元設計・移行時の設計文書
 * browser-photo-editing.md「木と一覧」「入力と補正」）。
 */

/**
 * 木の場所（「写真」「お気に入り」「アルバム」「記事の画像」。F5b 移行元設計）。アルバムは API が返す ID を
 * `album:<id>` にし、一覧のサーバー絞り込みと場所の選択を 1 つの state に保つ。場所を足すときは、下の関数と、絞り込みを掛けるか
 * （{@link canFilterBrowserCloudPlace}）に条件を足す。
 *
 * フォルダのある写真の出どころ（この Mac。`PhotoLibrary.folders`。NIHO camera C3 移行元設計）は、選んだフォルダを `folder:<folderId>` に
 * する（一覧は `list` の `folderId` で読む。クラウドの場所は使わない）。
 */
export type BrowserCloudPlace = "photos" | "favorites" | "articleImages" | "selected" | `album:${string}` | `folder:${string}`;

export function browserCloudAlbumPlace(albumId: string): BrowserCloudPlace {
  return `album:${albumId}`;
}

export function browserCloudPlaceAlbumId(place: BrowserCloudPlace): string | null {
  return place.startsWith("album:") ? place.slice("album:".length) || null : null;
}

/** この Mac のフォルダの場所（`folderId` は `PhotoLibraryFolder.folderId`）。 */
export function browserFolderPlace(folderId: string): BrowserCloudPlace {
  return `folder:${folderId}`;
}

/** フォルダの場所なら、そのフォルダの ID（ほかの場所は null）。 */
export function browserPlaceFolderId(place: BrowserCloudPlace): string | null {
  return place.startsWith("folder:") ? place.slice("folder:".length) || null : null;
}

/** ネイティブの選択ダイアログで追加した「選んだ写真」の場所か。 */
export function isBrowserSelectedPhotosPlace(place: BrowserCloudPlace): boolean {
  return place === "selected";
}

/**
 * 写真のもとの場所。「写真」はクラウドにオリジナルのある行。ほか（オリジナルの無い行。記事から取り込んだ画像・過去のコピー保存・
 * Desktop の「オリジナルを置かない」で置いた写真）は「記事の画像」。
 */
export function browserCloudPhotoPlace(photo: Pick<PhotoLibraryItem, "hasOriginal">): BrowserCloudPlace {
  return photo.hasOriginal ? "photos" : "articleImages";
}

/**
 * その場所の一覧をサーバーで絞る条件（`listPhotos` の `hasOriginal`・`favorite`）。「お気に入り」は元の写真のある写真のうち ♥ の
 * 付いたもの（記事の画像はお気に入りに入れない）。フォルダの場所はそのフォルダ（`folderId`）だけで、クラウドの条件
 * （元の写真の有無・お気に入り・アルバム）を付けない。
 */
export function browserCloudPlaceListFilter(
  place: BrowserCloudPlace,
): { hasOriginal?: boolean; favorite?: boolean; albumId?: string; folderId?: string; localSource?: "selected" } {
  if (isBrowserSelectedPhotosPlace(place)) return { localSource: "selected" };
  const folderId = browserPlaceFolderId(place);
  if (folderId) return { folderId };
  const albumId = browserCloudPlaceAlbumId(place);
  if (albumId) return { hasOriginal: true, albumId };
  switch (place) {
    case "photos":
      return { hasOriginal: true };
    case "favorites":
      return { hasOriginal: true, favorite: true };
    case "articleImages":
      return { hasOriginal: false };
    default:
      return { hasOriginal: true };
  }
}

/**
 * 写真がその場所の一覧に入るか（{@link browserCloudPlaceListFilter} と同じ条件）。サーバーの一覧に載っていない手元の写真
 * （このタブで追加した・URL で開いた）を場所で選り分ける。1 枚の写真は「写真」と「お気に入り」の両方に入る。フォルダの場所は
 * 行だけでは分からないので入れる（一覧に載った写真だけを出すのは `useBrowserPhotoItems`。アルバムと同じ）。
 */
export function isBrowserCloudPhotoInPlace(
  photo: Pick<PhotoLibraryItem, "hasOriginal" | "favorite">,
  place: BrowserCloudPlace,
): boolean {
  if (browserPlaceFolderId(place) || isBrowserSelectedPhotosPlace(place)) return true;
  if (browserCloudPlaceAlbumId(place)) return photo.hasOriginal;
  switch (place) {
    case "photos":
      return photo.hasOriginal;
    case "favorites":
      return photo.hasOriginal && photo.favorite === true;
    case "articleImages":
      return !photo.hasOriginal;
    default:
      return false;
  }
}

/**
 * 元の写真のある写真の場所か（「写真」「お気に入り」「アルバム」。「記事の画像」は含まない）。一覧の並びの切り替え・複数選択（F5a-2 移行元設計）・
 * 選択モードは、この場所だけで使う。
 */
export function isBrowserCloudPhotoPlace(place: BrowserCloudPlace): boolean {
  return place !== "articleImages";
}

/** お気に入り（♥）を付け外しできる写真か（元の写真のある「写真」だけ。記事の画像は入れない。F5b 移行元設計）。 */
export function canFavoriteBrowserCloudPhoto(photo: Pick<PhotoLibraryItem, "hasOriginal">): boolean {
  return photo.hasOriginal;
}

/** タイルの「RAW」の印を付けるか（拡張子で決める。記事から取り込んだ WebP は RAW にしない）。 */
export function isBrowserCloudRawPhoto(photo: Pick<PhotoLibraryItem, "fileExtension">): boolean {
  const extension = photo.fileExtension.trim().toLowerCase();
  return extension !== "webp" && isPhotoEditingRawExtension(extension);
}

/** 一覧の「種類」（サーバーの `kind`。RAW は JPEG / PNG / TIFF / HEIC / HEIF 以外。PNG / TIFF はどれにも入らない）。 */
export type BrowserCloudPhotoKind = PhotoLibraryKindFilter;

/**
 * 一覧の絞り込みの条件（種類・補正済み。F5b 移行元設計 の画面 2 本目。選別〔採用だけ / 却下を隠す〕は niho-photo#47 で、選別のフラグを
 * 持つ写真の出どころだけが選べる）。null・省略は絞らない。端末にも覚えない（ページを閉じたら消える）。
 * 条件を掛けるのは「写真」「お気に入り」だけ（{@link canFilterBrowserCloudPlace}）。
 */
export type BrowserCloudListFilter = {
  kind: BrowserCloudPhotoKind | null;
  edited: boolean | null;
  flag?: PhotoLibraryFlagFilter | null;
};

/** 絞り込まない条件。 */
export const BROWSER_CLOUD_NO_LIST_FILTER: BrowserCloudListFilter = { kind: null, edited: null, flag: null };

/**
 * 絞り込みの条件を掛ける場所か（「写真」「お気に入り」とこの Mac のフォルダ。元の写真の無い「記事の画像」は種類・補正済みを
 * 持たないので掛けない）。
 */
export function canFilterBrowserCloudPlace(place: BrowserCloudPlace): boolean {
  return place === "photos" || place === "favorites" || place === "selected" || browserPlaceFolderId(place) !== null;
}

/** その場所で掛ける条件（「記事の画像」では絞らない。選んだ条件はそのまま残り、場所を戻すとまた掛かる）。 */
export function appliedBrowserCloudListFilter(
  place: BrowserCloudPlace,
  filter: BrowserCloudListFilter,
): BrowserCloudListFilter {
  return canFilterBrowserCloudPlace(place) ? filter : BROWSER_CLOUD_NO_LIST_FILTER;
}

/** 有効な条件の数（0〜3）。 */
export function countBrowserCloudListFilter(filter: BrowserCloudListFilter): number {
  return (filter.kind === null ? 0 : 1) + (filter.edited === null ? 0 : 1) + (filter.flag ? 1 : 0);
}

/**
 * 場所と条件で、一覧をサーバーで絞る引数（`usePhotoCloudPhotos` の `hasOriginal`・`favorite`・`kind`・`edited`）。場所の分は
 * {@link browserCloudPlaceListFilter}、条件は掛ける場所だけ（{@link appliedBrowserCloudListFilter}）。手元の写真は
 * {@link isBrowserCloudPhotoInPlace} と {@link isBrowserCloudPhotoInFilter} で同じように選り分ける。
 */
export function browserCloudListParams(
  place: BrowserCloudPlace,
  filter: BrowserCloudListFilter,
): {
  hasOriginal?: boolean;
  favorite?: boolean;
  albumId?: string;
  folderId?: string;
  localSource?: "selected";
  kind?: BrowserCloudPhotoKind;
  edited?: boolean;
  flag?: PhotoLibraryFlagFilter;
} {
  const applied = appliedBrowserCloudListFilter(place, filter);
  return {
    ...browserCloudPlaceListFilter(place),
    ...(applied.kind === null ? {} : { kind: applied.kind }),
    ...(applied.edited === null ? {} : { edited: applied.edited }),
    ...(applied.flag ? { flag: applied.flag } : {}),
  };
}

/** 写真の種類（拡張子で決める。PNG / TIFF・記事から取り込んだ WebP などはどの種類でもない = null）。 */
export function browserCloudPhotoKind(
  photo: Pick<PhotoLibraryItem, "fileExtension">,
): BrowserCloudPhotoKind | null {
  const extension = photo.fileExtension.trim().toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "jpeg";
  if (extension === "heic" || extension === "heif") return "heic";
  return isBrowserCloudRawPhoto(photo) ? "raw" : null;
}

/**
 * 写真が絞り込みの条件に合うか（サーバーと同じ条件。サーバーの一覧に載っていない手元の写真と、一覧を読み直す前にフラグを付け替えた
 * 写真を選り分ける）。補正済みは `hasEdits`（省かれた古い行・保存したことの無い写真は未補正）、選別は `flag`（省かれた行はフラグなし）。
 */
export function isBrowserCloudPhotoInFilter(
  photo: Pick<PhotoLibraryItem, "fileExtension" | "hasEdits" | "flag">,
  filter: BrowserCloudListFilter,
): boolean {
  if (filter.kind !== null && browserCloudPhotoKind(photo) !== filter.kind) return false;
  if (filter.flag === "pick" && photo.flag !== "pick") return false;
  if (filter.flag === "notRejected" && photo.flag === "reject") return false;
  return filter.edited === null || (photo.hasEdits === true) === filter.edited;
}

/** ブラウザで補正の入力にできるオリジナルの形式（JPEG / PNG）。 */
const EDITABLE_ORIGINAL_EXTENSIONS: ReadonlySet<string> = new Set(["jpg", "jpeg", "png"]);

/**
 * オリジナルを補正の入力にできる形か（JPEG は 64MiB 以下・PNG は 10MiB 以下。K5-a 移行元設計）。どちらの補正から始めるか（S1 の
 * canvas では描けるか）は、開いたときに編集内容を読んで決める（{@link loadBrowserCloudPhotoSource}）。4,000 万画素を超えるかは
 * 読むまで分からない（開いて分かった JPEG は作業コピーで開き直す）。
 */
export function isBrowserEditableOriginal(
  photo: Pick<PhotoLibraryItem, "hasOriginal" | "fileExtension" | "sizeBytes">,
): boolean {
  return (
    photo.hasOriginal &&
    EDITABLE_ORIGINAL_EXTENSIONS.has(photo.fileExtension.trim().toLowerCase()) &&
    Number.isFinite(photo.sizeBytes) &&
    photo.sizeBytes <= browserCloudOriginalMaxBytes(photo.fileExtension)
  );
}

/**
 * 直せない写真の、状態と次の一歩（1 行。右パネルの代わりに出す）。補正に関わる閲覧のみの理由は、新しい版の NIHO で補正された
 * （{@link DEVELOP_ENGINE_NEWER_LOCKED_MESSAGE}）と、準備ができなかった（{@link DEVELOP_ENGINE_UNAVAILABLE_LOCKED_MESSAGE}）の
 * 2 つだけ（移行元設計。NIHO Desktop へ送らない。変換で写せない補正は捨てて補正なしで開く）。元の写真が無い行（「記事の画像」。写真編集は
 * 元の写真のある行だけを直す）は次の一歩を添えない 1 行（K4 移行元設計）。
 */
export const BROWSER_NO_ORIGINAL_LOCKED_MESSAGE = "元の写真が無いため編集できません";
/** 新しい版の NIHO（段 2 の数式）で保存した編集内容の写真（この画面の版では続きを直さない。移行元設計）。 */
export const DEVELOP_ENGINE_NEWER_LOCKED_MESSAGE = "新しい版の NIHO で補正された写真です。ページを読み込み直すと補正できます。";
export const DEVELOP_ENGINE_BASE_MISMATCH_LOCKED_MESSAGE =
  "保存した編集元と写真の内容が一致しません。写真を読み込み直してから、もう一度お試しください。";
/**
 * 段 2 の wasm を用意できなかった・wasm で開けなかった・補正を変換できなかった（canvas で描くと補正が外れて見える。wasm で描けない
 * 形式・作業コピーを作らない写真も同じ）。
 */
export const DEVELOP_ENGINE_UNAVAILABLE_LOCKED_MESSAGE = "補正の準備ができませんでした。ページを読み込み直してください。";

/**
 * 開かずに分かる、オリジナルから直接は直せない理由（記事の画像・RAW・TIFF / HEIC・10MiB 超の PNG・64MiB 超の JPEG）。直せる
 * 見込みなら null（補正済みかは開くまで分からない）。RAW・TIFF / HEIC・大きな PNG / JPEG は S5（移行元設計）から作業コピーで直すので、
 * この理由を出すのは段 2 の wasm を使えないとき・作業コピーを作らない写真だけ（画面が決める）。オリジナルの無い写真は {@link BROWSER_NO_ORIGINAL_LOCKED_MESSAGE}。
 */
export function browserCloudLockedReason(
  photo: Pick<PhotoLibraryItem, "hasOriginal" | "fileExtension" | "sizeBytes">,
): string | null {
  if (!photo.hasOriginal) return BROWSER_NO_ORIGINAL_LOCKED_MESSAGE;
  if (!isBrowserEditableOriginal(photo)) return DEVELOP_ENGINE_UNAVAILABLE_LOCKED_MESSAGE;
  return null;
}

/**
 * S1 の canvas（段 2 の wasm を使えない・wasm で開けなかった）で開けない理由。canvas は補正を描けないので、保存してある補正
 * （`developSettings`）が neutral でなければ閉じる。neutral（か、保存したことが無い）なら null（canvas で直せる）。
 */
export function browserCanvasLockedReason(photo: { developSettings?: unknown }): string | null {
  return isNeutralDevelopSettings(photo.developSettings) ? null : DEVELOP_ENGINE_UNAVAILABLE_LOCKED_MESSAGE;
}

export type BrowserCloudPhotoSource = {
  /** 補正の入力（オリジナル。直せない写真・狭い幅では null） */
  file: File | null;
  /** 入力が無いときに見せる画像（記事用の画像・プレビュー。無ければ null） */
  viewUrl: string | null;
  /** 直せない理由と次の一歩（1 行）。直せる写真では null */
  lockedReason: string | null;
  /**
   * 補正の入力を返したときの、開いた時点の写真（`openOriginal` の `photo`。最新の `developSettings`・`developRevision`・
   * `webRenderedRevision`・`hasWebImage`）。ほかは null
   */
  photo: PhotoLibraryPhoto | null;
};

const WEB_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function webImageFileName(
  photo: Pick<PhotoLibraryItem, "fileName">,
  contentType: string | null | undefined,
): string {
  const stem = photoEditingFileStem(photo.fileName) || "photo";
  return `${stem}.${WEB_IMAGE_EXTENSIONS[contentType ?? ""] ?? "jpg"}`;
}

/**
 * 閲覧だけに見せる画像。写真（元の写真のある行）はプレビュー。元の写真の無い行（「記事の画像」。画像そのものが記事用の画像）だけ、
 * 記事用の画像（無ければプレビュー）。写真の面は記事用の画像の列を読まない（写真ライブラリは汎用で、記事は反映先の 1 つ。K4 移行元設計）。
 */
export async function findBrowserCloudViewUrl(
  library: Pick<PhotoLibrary, "readArticleImage">,
  photo: Pick<PhotoLibraryItem, "id" | "hasOriginal" | "hasWebImage" | "previewUrl" | "editedPreview">,
  signal: AbortSignal,
): Promise<string | null> {
  const image = photo.hasOriginal ? null : await readArticleImage(library, photo, signal);
  const editedPreviewUrl = photo.hasOriginal ? photo.editedPreview?.url : null;
  return editedPreviewUrl ?? image?.url ?? photo.previewUrl ?? null;
}

/**
 * 記事の画像（元の写真の無い行の中身）を写真の出どころから読む（表示用の URL と形式。写真の出どころが記事の画像を持たない・
 * 記事用の画像の無い行は null）。
 */
function readArticleImage(
  library: Pick<PhotoLibrary, "readArticleImage">,
  photo: Pick<PhotoLibraryItem, "id" | "hasOriginal" | "hasWebImage">,
  signal: AbortSignal,
): Promise<PhotoLibraryArticleImage | null> {
  return library.readArticleImage ? library.readArticleImage(photo, { signal }) : Promise.resolve(null);
}

/**
 * 1 枚で開くときの入力。ブラウザで補正できるのは、オリジナルが JPEG（64MiB 以下）/ PNG（10MiB 以下）の写真（オリジナルを入力に
 * する。4,000 万画素を超える JPEG は、段 2 の wasm を使えるなら画面が作業コピーで開き直す。K5-a 移行元設計）。
 * ほか（記事の画像・RAW・TIFF / HEIC など）は補正せず、記事用の画像（無ければプレビュー）を見せて、直せない理由を 1 行返す
 * （作業コピーで直す RAW などは、段 2 の wasm を使えるなら画面が作業コピーを開く。移行元設計）。狭い幅（`allowEditing: false`）は
 * プレビューだけを見せる。選択済み cloud photo の現行行を読む場合も、オリジナルや記事用画像のバイト列は読まない（作業コピーで直す写真も、
 * 直せる JPEG / PNG と同じく理由を出さない。補正は PC で）。
 *
 * 補正は写真に 1 つで、置き場は `developSettings` の 1 つ（K1c 移行元設計）。段 2 の wasm を使える（`canDevelop`）なら補正を描けるので、
 * オリジナルと最新の写真（`photo.developSettings`）を返す。使えない（S1 の canvas）なら補正が neutral（か、保存したことが無い）の
 * ときだけオリジナルを返し、ほかは補正を外して見せないよう閉じる。オリジナルは写真の出どころ（`openOriginal` の参照を
 * `loadOriginal`）から読む。
 */
export async function loadBrowserCloudPhotoSource(
  library: Pick<PhotoLibrary, "openOriginal" | "loadOriginal" | "readArticleImage">,
  photo: PhotoLibraryItem,
  signal: AbortSignal,
  options: { allowEditing?: boolean; canDevelop?: boolean; selectedEditedPreview?: PhotoLibraryEditedPreview | null } = {},
): Promise<BrowserCloudPhotoSource> {
  const previewUrl = photo.previewUrl ?? null;
  const knownLock = browserCloudLockedReason(photo);
  if (options.allowEditing === false) {
    const lockedReason = isDevelopWorkTarget(photo) ? null : knownLock;
    return { file: null, viewUrl: options.selectedEditedPreview?.url ?? previewUrl, lockedReason, photo: null };
  }
  if (knownLock) {
    const image = await readArticleImage(library, photo, signal);
    return { file: null, viewUrl: image?.url ?? previewUrl, lockedReason: knownLock, photo: null };
  }

  const original = await library.openOriginal(photo.id, { signal });
  if (!options.canDevelop) {
    // canvas は補正を描けないので、補正が neutral でなければ原画像を見せない
    const lockedReason = browserCanvasLockedReason(original.photo);
    if (lockedReason) {
      const image = await readArticleImage(library, { ...photo, hasWebImage: original.photo.hasWebImage }, signal);
      return { file: null, viewUrl: image?.url ?? previewUrl, lockedReason, photo: null };
    }
  }
  const file = await library.loadOriginal(photo.id, original.source, {
    signal,
    fileName: original.photo.fileName || photo.fileName || "photo.jpg",
    maxBytes: browserCloudOriginalMaxBytes(photo.fileExtension),
  });
  return { file, viewUrl: previewUrl, lockedReason: null, photo: original.photo };
}

/**
 * 一覧で選んだ元の写真の無い行（「記事の画像」）の「書き出す」の JPEG（長辺 2048px の記事用の画像をそのまま。PNG / WebP の記事用の
 * 画像は JPEG に書き直す）。記事用の画像が無い・写真（元の写真のある行）なら `fetch_failed`（写真の書き出しは入力から描く。K4 移行元設計）。
 * 中身は写真の出どころ（`loadArticleImage`）から読む。
 */
export async function fetchBrowserCloudWebImageJpeg(
  library: Pick<PhotoLibrary, "readArticleImage" | "loadArticleImage">,
  photo: PhotoLibraryItem,
  signal: AbortSignal,
): Promise<Blob> {
  const image = await readArticleImage(library, photo, signal);
  if (!image || !library.loadArticleImage) throw new BrowserPhotoSourceError("fetch_failed");
  const file = await library.loadArticleImage(photo.id, image, { signal, fileName: webImageFileName(photo, image.contentType) });
  if (image.contentType === "image/jpeg") return file;
  const decoded = await decodeBrowserPhoto(file);
  try {
    return await exportBrowserPhotoJpeg(decoded, NEUTRAL_BROWSER_PHOTO_ADJUSTMENTS);
  } finally {
    decoded.cleanup();
  }
}

/** 開いている写真の今の行（補正は `photo.developSettings`・版は `photo.developRevision`。旧エンジンの `settings` は読まない。K1c 移行元設計）。 */
export type BrowserCloudPhotoRow = { photo: PhotoLibraryPhoto };

/**
 * 開いている写真の今の行（補正と版）を読む（別の端末の補正の読み直し。移行元設計）。中身で探す（`lookup`）は読むだけでオリジナルを
 * 出さないので、画面に戻るたびに呼んでよい（`openOriginal` はオリジナルの参照を発行して記録に残すので、この用途には使わない）。
 * 消えていた・別の写真に替わっていたら null。
 */
export async function readBrowserCloudPhotoRow(
  library: Pick<PhotoLibrary, "lookup">,
  photo: Pick<PhotoLibraryPhoto, "id" | "contentSha256">,
): Promise<BrowserCloudPhotoRow | null> {
  const matches = await library.lookup([photo.contentSha256]);
  const match = matches.find((candidate) => candidate.photo.id === photo.id);
  return match ? { photo: match.photo } : null;
}
