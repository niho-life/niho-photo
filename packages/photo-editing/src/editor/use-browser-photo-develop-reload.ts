"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";

import { readBrowserCloudPhotoRow, type BrowserCloudPhotoRow } from "../browser-photo-cloud-source";
import { hasDevelopGeometry, type DevelopSettings } from "../develop-engine/develop-settings";
import { BROWSER_PHOTO_EDITING_DEVELOP_RELOADED_TEXT } from "../photo-editing-copy";
import type { PhotoLibraryPhoto } from "../library/photo-library";
import { usePhotoLibrary } from "../library/photo-library-context";

import type {
  BrowserPhotoAccess,
  BrowserPhotoOperationKind,
  BrowserViewMode,
  DevelopSession,
  FooterStatus,
  OpenedSource,
} from "./browser-photo-editing-model";
import { resolveReloadSettings } from "./browser-photo-editing-open-flow";
import type { BrowserPhotoDevelop } from "./use-browser-photo-develop";

/** 読み直すきっかけ（保存の競合・復旧保存・画面に戻った）。 */
type ReloadReason = "saveStale" | "durableRecovery" | "refresh";

/**
 * 別の端末で直した補正を黙って上書きしない（版の照合。NIHO Photo 段 1 F1 移行元設計・API 移行元設計）の画面側。wasm で直している 1 枚を
 * 今の写真の補正で開き直す: 補正は開くときと同じ決め方（今の写真の `developSettings` だけ。旧エンジンの `settings` は読まない。
 * K1c 移行元設計）で、入力（オリジナル / 作業コピー）と wasm の写真はそのまま使い、取り消しの履歴を捨ててその補正から始め直す（丁寧に
 * 描き直す）。保存係は今の写真の版で作り直し、一覧の行も替え、状態欄に 1 行（情報）。閲覧だけになる（新しい版の NIHO で保存
 * された）写真は、今の開き直しの経路に任せる。
 * 読み直した補正に切り抜きがあり、wasm の作業サイズが足りなければ、同じオリジナルを要る大きさで開き直してから入れる（F3 移行元設計）。
 *
 * - 保存が 409 `photo_cloud_develop_revision_stale` で断られた（保存係の `onStale`）: 断られた写真をまだ開いていれば読み直す。
 *   写真を離れる処理の途中なら、終わってから（まだ同じ写真を開いていれば）
 * - 画面に戻った（`visibilitychange` で visible・窓の focus）: 1 枚で直していて、送り終えていない保存が無く、書き出し・消す・
 *   離れる途中でなければ、その写真の今の行を読み、版が保存係より進んでいれば読み直す（続けて来ても 1 回。読んでいる間に写真が
 *   変わった・直し始めたら捨てる。読めなければ何もしない）
 */
export function useBrowserPhotoDevelopReload(params: {
  mountedRef: MutableRefObject<boolean>;
  latestAccessRef: MutableRefObject<BrowserPhotoAccess>;
  develop: Pick<
    BrowserPhotoDevelop,
    "engineRef" | "developSessionRef" | "leavingRef" | "saveStaleHandlerRef" | "saveDurableRecoveryHandlerRef" | "startSession" | "createSaver"
  >;
  openedRef: MutableRefObject<OpenedSource | null>;
  setOpened: (opened: OpenedSource) => void;
  loadSettings: (settings: DevelopSettings, options: { history: boolean }) => void;
  viewModeRef: MutableRefObject<BrowserViewMode>;
  operationRef: MutableRefObject<BrowserPhotoOperationKind | null>;
  openingKeyRef: MutableRefObject<string | null>;
  /** 閲覧だけになる写真を、今の開き直しの経路（`openItem(item, { reload: true })`）で開き直す */
  reopen: (key: string) => void;
  /**
   * 開いている写真の wasm の作業サイズを、この編集内容の切り抜きに合わせる（`useBrowserPhotoWorkingSize`）。false なら入れない
   * （別の写真に替わった・開き直しの経路に任せた）
   */
  ensureDevelopWorkingSize: (settings: DevelopSettings) => Promise<boolean>;
  replaceCloudPhoto: (photo: PhotoLibraryPhoto) => void;
  setStatus: (status: FooterStatus | null) => void;
}): boolean {
  const {
    mountedRef,
    latestAccessRef,
    openedRef,
    setOpened,
    loadSettings,
    viewModeRef,
    operationRef,
    openingKeyRef,
    reopen,
    ensureDevelopWorkingSize,
    replaceCloudPhoto,
    setStatus,
  } = params;
  const { engineRef, developSessionRef, leavingRef, saveStaleHandlerRef, saveDurableRecoveryHandlerRef, startSession, createSaver } = params.develop;
  /** 画面に戻ったときの今の行を読んでいる（visibilitychange と focus が続けて来ても重ねない） */
  // 写真の出どころ（今の行を中身で探す。移行元設計）
  const library = usePhotoLibrary();
  const checkingRef = useRef(false);
  /**
   * 409 の後の読み直しの間は入力を止める。K1c 移行元設計 から、読み直しは 409 が返した今の写真だけで決まり待ちが無い（旧エンジンの補正を
   * 読み足さない）ので、今は画面に出るほどの間は無い
   */
  const [staleReloading, setStaleReloading] = useState(false);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const refreshAfterLeavingRef = useRef<Promise<boolean> | null>(null);

  /** 読み直した補正を状態に入れる（保存係を今の版で作り直し、取り消しの履歴を捨てる）。 */
  const apply = (
    session: DevelopSession,
    photo: PhotoLibraryPhoto,
    resolved: { settings: DevelopSettings; settingsSource: DevelopSession["settingsSource"] },
    announceReload: boolean,
  ) => {
    const previousSaver = session.saver;
    const next: DevelopSession = {
      ...session,
      photo,
      settingsSource: resolved.settingsSource,
      saver: latestAccessRef.current.canEdit
        ? createSaver(session.spotId, session.photoId, photo.developRevision, photo.contentSha256)
        : null,
    };
    // 止まった（か、送るものの無い）前の保存係は手放す
    previousSaver?.dispose();
    startSession(next);
    const opened = openedRef.current;
    if (opened) {
      const nextOpened: OpenedSource = { ...opened, photo };
      openedRef.current = nextOpened;
      setOpened(nextOpened);
    }
    // 取り消しの履歴は捨て、読み込んだ補正から始め直す（一覧に戻っている間は、1 枚に戻ったときに始める）
    loadSettings(resolved.settings, { history: viewModeRef.current === "loupe" });
    replaceCloudPhoto(photo);
    if (announceReload) setStatus({ kind: "notice", text: BROWSER_PHOTO_EDITING_DEVELOP_RELOADED_TEXT });
  };

  /**
   * 今の写真（`photo`。409 が返した行か、画面に戻って読んだ行）の補正で開き直す。`refresh` は直し始めた・離れ始めた・書き出し /
   * 消し始めた・もう進んでいないなら捨てる。
   */
  const reload = async (session: DevelopSession, photo: PhotoLibraryPhoto, reason: ReloadReason): Promise<void> => {
    // 写真を離れる処理（保存を送り終えて補正後のプレビューを上げ始める）は前の編集のまま終え、その後にまだ開いていれば読み直す
    const leaving = leavingRef.current;
    if (leaving && reason !== "refresh") {
      void leaving.then(
        () => reloadRef.current(session, photo, reason),
        () => undefined,
      );
      return;
    }
    const isStale = () => {
      const opened = openedRef.current;
      if (
        !mountedRef.current ||
        developSessionRef.current !== session ||
        latestAccessRef.current.spotId !== session.spotId ||
        opened?.key !== session.key ||
        opened.mode !== "wasm"
      ) {
        return true;
      }
      if (reason !== "refresh") return false;
      const revision = session.saver?.getExpectedRevision();
      return (
        leavingRef.current !== null ||
        operationRef.current !== null ||
        session.saver?.hasPendingWork() !== false ||
        revision === undefined ||
        photo.developRevision <= revision
      );
    };
    if (!engineRef.current || isStale()) return;
    const blocksEditing = reason !== "refresh";
    if (blocksEditing) setStaleReloading(true);
    try {
      const resolved = resolveReloadSettings(photo, session.input);
      if (resolved.kind === "locked") {
        replaceCloudPhoto(photo);
        reopen(session.key);
        return;
      }
      if (hasDevelopGeometry(resolved.settings)) {
        // 切り抜いてもプレビューの大きさに届く作業サイズで描く（足りなければ、同じオリジナルを開き直してから入れる）
        if (!(await ensureDevelopWorkingSize(resolved.settings)) || isStale()) return;
        const leavingAfterResize = leavingRef.current;
        if (leavingAfterResize && reason !== "refresh") {
          void leavingAfterResize.then(
            () => reloadRef.current(session, photo, reason),
            () => undefined,
          );
          return;
        }
      }
      apply(session, photo, resolved, reason !== "durableRecovery");
    } finally {
      if (blocksEditing && mountedRef.current) setStaleReloading(false);
    }
  };
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  // 保存係が別の端末の保存に断られた（その写真を開いている保存係のときだけ呼ばれる）
  const scheduleReload = (photo: PhotoLibraryPhoto, reason: ReloadReason) => {
    const session = developSessionRef.current;
    if (!session || session.photoId !== photo.id) return;
    void reloadRef.current(session, photo, reason);
  };
  saveStaleHandlerRef.current = (photo) => scheduleReload(photo, "saveStale");
  saveDurableRecoveryHandlerRef.current = (photo) => scheduleReload(photo, "durableRecovery");

  const deferRefreshUntilLeavingFinishes = (leaving: Promise<boolean>) => {
    if (refreshAfterLeavingRef.current === leaving) return;
    refreshAfterLeavingRef.current = leaving;
    const retry = () => {
      if (refreshAfterLeavingRef.current !== leaving) return;
      refreshAfterLeavingRef.current = null;
      void refreshRef.current();
    };
    void leaving.then(retry, retry);
  };

  /** 画面に戻った。1 枚で直している写真の今の行を読み、版が保存係より進んでいれば読み直す。 */
  const refresh = async () => {
    const leaving = leavingRef.current;
    if (leaving) {
      // visible/focus が離脱処理に重なっても捨てず、保存・補正後のプレビューの画の用意が終わってから同じ条件を再確認する
      deferRefreshUntilLeavingFinishes(leaving);
      return;
    }
    if (checkingRef.current) return;
    const session = developSessionRef.current;
    const saver = session?.saver ?? null;
    const opened = openedRef.current;
    const revision = saver?.getExpectedRevision();
    if (
      !mountedRef.current ||
      !session ||
      !saver ||
      revision === undefined ||
      viewModeRef.current !== "loupe" ||
      opened?.key !== session.key ||
      opened.mode !== "wasm" ||
      saver.hasPendingWork() ||
      operationRef.current !== null ||
      openingKeyRef.current !== null
    ) {
      return;
    }
    checkingRef.current = true;
    try {
      let latest: BrowserCloudPhotoRow | null;
      try {
        latest = await readBrowserCloudPhotoRow(library, session.photo);
      } catch {
        // 読めなければ何もしない（次の保存が版を照合する）
        return;
      }
      if (!latest || latest.photo.developRevision <= revision) return;
      await reloadRef.current(session, latest.photo, "refresh");
    } finally {
      checkingRef.current = false;
    }
  };
  refreshRef.current = refresh;

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshRef.current();
    };
    const onFocus = () => {
      void refreshRef.current();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return staleReloading;
}
