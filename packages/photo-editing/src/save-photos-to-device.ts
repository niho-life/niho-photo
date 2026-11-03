import type { PhotoEditingHost } from "./library/photo-library-context";

/**
 * スマホで書き出した写真を端末に保存する（NIHO Photo 段 1 F6c 移行元設計・F6a 移行元設計 の実測）。
 *
 * - `share`: 共有シート（Web Share の `navigator.share({ files })`）。iPhone の Safari・NIHO アプリと Android の Chrome。
 *   iPhone では「画像を保存」で写真ライブラリの撮影日の位置に並び、Instagram などへ直接送ることもできる。
 * - `device-file`: Android の NIHO アプリ（System WebView に Web Share が無い）。アプリの端末への保存（`PhotoEditingHost.saveFile`。
 *   web は `saveFileToDevice` の native の `file.save`・保存先を選ぶ）で 1 枚ずつ。
 * - `download`: どちらも無いとき（PC のブラウザなど）。アプリの端末への保存（web は `saveFileToDevice` のアンカーでのダウンロード）。
 *
 * 共有シートはユーザーの操作から約 5 秒（WebKit）しか出せない。描くのに時間がかかったら、描き終えてから同じボタンを
 * もう一度押してもらう（`needs-tap`）。`navigator.userActivation` があればそれで判断し、無ければ呼んでみて
 * `NotAllowedError` を `needs-tap` にする。
 */

export type PhotoSaveRoute = "share" | "device-file" | "download";

/** スマホで 1 回に保存できる枚数（共有シートに渡す枚数の上限）。 */
export const PHOTO_SAVE_MAX_FILES = 10;

type ShareNavigator = Pick<Navigator, "userAgent"> & {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data?: ShareData) => boolean;
  userActivation?: { isActive: boolean };
};

/** 保存の経路を決める・保存する環境（共有シートはこのページの `navigator`、端末への保存はアプリの都合 `PhotoEditingHost`）。 */
export type PhotoSaveEnv = {
  navigator: ShareNavigator | null;
  nativeFileSaveAvailable: () => boolean;
  saveFile: PhotoEditingHost["saveFile"];
} & Pick<PhotoEditingHost, "scopeSignal" | "isScopeCurrent">;

function currentNavigator(): ShareNavigator | null {
  return typeof navigator === "undefined" ? null : navigator;
}

/** このページの共有シートと、アプリの端末への保存（`PhotoEditingHost`。移行元設計）。 */
export function photoSaveEnv(host: Pick<PhotoEditingHost, "nativeFileSaveAvailable" | "saveFile" | "scopeSignal" | "isScopeCurrent">): PhotoSaveEnv {
  const { scopeSignal, isScopeCurrent } = host;
  return {
    navigator: currentNavigator(), nativeFileSaveAvailable: host.nativeFileSaveAvailable, saveFile: host.saveFile,
    ...(scopeSignal ? { scopeSignal } : {}),
    ...(isScopeCurrent ? { isScopeCurrent: isScopeCurrent.bind(host) } : {}),
  };
}

function scopeIsCurrent(env: Pick<PhotoSaveEnv, "scopeSignal" | "isScopeCurrent">): boolean {
  try {
    return !env.scopeSignal?.aborted && (env.isScopeCurrent === undefined || env.isScopeCurrent() === true);
  } catch {
    return false;
  }
}

const PROBE_FILE_NAME = "niho-photo.jpg";

/** この端末で写真をどう保存するか。共有シートは JPEG のファイルを渡せるときだけ。 */
export function resolvePhotoSaveRoute(env: Pick<PhotoSaveEnv, "navigator" | "nativeFileSaveAvailable">): PhotoSaveRoute {
  const nav = env.navigator;
  if (nav && typeof nav.share === "function" && typeof nav.canShare === "function") {
    try {
      const probe = new File([new Uint8Array(0)], PROBE_FILE_NAME, { type: "image/jpeg" });
      if (nav.canShare({ files: [probe] })) return "share";
    } catch {
      // canShare が投げる実装は共有シートを使わない
    }
  }
  if (env.nativeFileSaveAvailable()) return "device-file";
  return "download";
}

/** 主ボタンの文言。iPhone は写真ライブラリに入るので「写真に保存」、Android と保存先を選ぶ経路は「端末に保存」。 */
export function photoSaveActionLabel(
  route: PhotoSaveRoute,
  env: Pick<PhotoSaveEnv, "navigator"> = { navigator: currentNavigator() },
): string {
  if (route === "share" && !/Android/i.test(env.navigator?.userAgent ?? "")) return "写真に保存";
  return "端末に保存";
}

export type PhotoSaveOutcome =
  /** 共有シートを閉じた・保存した（どちらを選んだかは web から分からない） */
  | { kind: "shared" }
  /** 共有シートで何も選ばずに閉じた・保存先の選択をやめた */
  | { kind: "cancelled" }
  /** 操作から時間が経って共有シートを出せない。同じボタンをもう一度押してもらう */
  | { kind: "needs-tap" }
  /** 1 枚ずつ保存した（`device-file` / `download`）。`saved` は保存できた枚数 */
  | { kind: "saved"; saved: number };

const SAVE_FAILED_MESSAGE = "写真を保存できませんでした。もう一度お試しください。";

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
}

/**
 * 描き終えた写真を保存する。`share` はユーザーの操作の中で呼ぶ（ボタンの onClick から、描き終えた直後か 2 回目の押下で）。
 * 投げるのは利用者に見せる日本語の Error だけ。
 */
export async function savePhotosToDevice(
  files: File[],
  route: PhotoSaveRoute,
  env: Pick<PhotoSaveEnv, "navigator" | "saveFile" | "scopeSignal" | "isScopeCurrent">,
): Promise<PhotoSaveOutcome> {
  if (!scopeIsCurrent(env)) return { kind: "cancelled" };
  if (files.length === 0) return { kind: "saved", saved: 0 };
  if (files.length > PHOTO_SAVE_MAX_FILES) {
    throw new Error(`一度に保存できるのは ${PHOTO_SAVE_MAX_FILES} 枚までです。`);
  }

  if (route === "share") {
    const nav = env.navigator;
    if (!nav || typeof nav.share !== "function") throw new Error(SAVE_FAILED_MESSAGE);
    if (nav.userActivation && !nav.userActivation.isActive) return { kind: "needs-tap" };
    if (!scopeIsCurrent(env)) return { kind: "cancelled" };
    try {
      await nav.share({ files });
      if (!scopeIsCurrent(env)) return { kind: "cancelled" };
      return { kind: "shared" };
    } catch (error) {
      if (!scopeIsCurrent(env)) return { kind: "cancelled" };
      const name = errorName(error);
      if (name === "AbortError") return { kind: "cancelled" };
      if (name === "NotAllowedError") return { kind: "needs-tap" };
      throw new Error(SAVE_FAILED_MESSAGE);
    }
  }

  let saved = 0;
  for (const file of files) {
    if (!scopeIsCurrent(env)) return { kind: "cancelled" };
    let result: Awaited<ReturnType<PhotoSaveEnv["saveFile"]>>;
    try {
      result = await env.saveFile({ blob: file, fileName: file.name });
    } catch (error) {
      if (!scopeIsCurrent(env)) return { kind: "cancelled" };
      throw error;
    }
    if (!scopeIsCurrent(env)) return { kind: "cancelled" };
    if (result === "cancelled") return saved === 0 ? { kind: "cancelled" } : { kind: "saved", saved };
    saved += 1;
  }
  return { kind: "saved", saved };
}
