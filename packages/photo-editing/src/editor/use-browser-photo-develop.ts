"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { QueryClient } from "@tanstack/react-query";

import {
  createDevelopEngine,
  type DevelopEngine,
  type DevelopFrame,
  type DevelopMaskSurfaceSource,
} from "../develop-engine/develop-engine-client";
import type { DevelopSettings } from "../develop-engine/develop-settings";
import {
  createDevelopSettingsSaver,
  type DevelopSettingsLastSaved,
  type DevelopSettingsSaver,
  type DevelopSettingsSaverState,
} from "../develop-engine/develop-settings-autosave";
import {
  createDevelopSettingsDraftId,
  isDevelopSettingsDraftStorageKey,
  listDevelopSettingsDrafts,
  listDevelopSettingsDraftsForPhotos,
  markDevelopSettingsDraftConflicted,
  removeDevelopSettingsDraft,
  writeDevelopSettingsDraft,
  type DevelopSettingsDraft,
} from "../develop-engine/develop-settings-draft";
import {
  createEditedPreviewUploader,
  libraryCanAttachEditedPreview,
  type EditedPreviewUploader,
} from "../photo-cloud-edited-preview";
import { photoEditingQueryKeys } from "../photo-editing-query-keys";
import type { PhotoLibraryPhoto } from "../library/photo-library";
import { usePhotoEditingHost, usePhotoLibrary } from "../library/photo-library-context";

import {
  DEVELOP_PREVIEW_MAX_DIMENSION,
  DEVELOP_SAVE_DROPPED_FALLBACK,
  type BrowserPhotoAccess,
  type DevelopSession,
  type FooterStatus,
} from "./browser-photo-editing-model";

/** 最後に丁寧に描いた画（写真の key・描いた設定の JSON・画）。 */
type CachedFrame = { key: string; settingsJson: string; frame: DevelopFrame };

/** この送信値より前に明示復元した候補。復元前から送信中の応答では消さない。 */
type ScheduledDraftCleanup = { draft?: DevelopSettingsDraft; recovered: DevelopSettingsDraft[] };

function draftFingerprint(draft: DevelopSettingsDraft): string {
  return `${draft.actorId}\u001f${draft.spotId}\u001f${draft.photoId}\u001f${draft.draftId}\u001f${draft.writeId}\u001f${draft.generation}\u001f${draft.updatedAt}`;
}

/** 覚えている丁寧な画が、この写真のこの設定で描いたものなら返す。 */
function cachedFrameOf(cached: CachedFrame | null, key: string, settings: DevelopSettings): DevelopFrame | null {
  return cached?.key === key && cached.settingsJson === JSON.stringify(settings) ? cached.frame : null;
}

/**
 * 段 2 の wasm（移行元設計）: Worker（engine）と、開いている 1 枚の編集（session）・自動保存・写真を離れるときの保存と、補正後の
 * プレビューを上げること（K3 移行元設計。表示している丁寧な画を縮めて上げる。記事用の画像は描かない＝使うときに描く）。engine と
 * 上げ係は初めて要るときに作る。engine は画面を閉じるとき（離れる処理の途中なら、その後）に止める。上げ係は止めない（上げ始めた分は
 * 画面を閉じても終わりまで上げる）。
 */
export function useBrowserPhotoDevelop(params: {
  spotId: string;
  scopeKey?: string;
  /** Worker の論理メモリ予算。画面幅の class を呼び出し側が明示する。 */
  deviceClass: "pc" | "mobile";
  /** 認証済みユーザー。匿名・未確定では端末退避を読まず、書かない。 */
  actorId: string | null;
  queryClient: QueryClient;
  mountedRef: MutableRefObject<boolean>;
  latestAccessRef: MutableRefObject<BrowserPhotoAccess>;
  setStatus: (status: FooterStatus | null) => void;
  /** 一覧の行を今の写真に替える（補正後のプレビューを上げ終えたとき。署名付きの URL ごと引き直した行を渡す） */
  replaceCloudPhoto: (photo: PhotoLibraryPhoto) => void;
  /** 補正保存後、ワーカーが補正後プレビューを描き終えるまで一覧の再取得を始める */
  markEditedPreviewPending: (photoId: string) => void;
}) {
  const {
    spotId,
    scopeKey,
    queryClient,
    mountedRef,
    latestAccessRef,
    setStatus,
    replaceCloudPhoto,
    markEditedPreviewPending,
  } = params;
  // 写真の出どころ（接続口 PhotoLibrary）とアプリの都合（移行元設計）
  const library = usePhotoLibrary();
  const host = usePhotoEditingHost();
  // 段 2 の wasm（移行元設計）。初めて要るときに作る（1024px 以上で写真を開く・一覧から JPEG を書き出すとき。一覧を開いただけでは作らない）
  const engineRef = useRef<DevelopEngine | null>(null);
  const developSessionRef = useRef<DevelopSession | null>(null);
  const actorIdRef = useRef(params.actorId);
  actorIdRef.current = params.actorId;
  const saverDraftIdsRef = useRef(new WeakMap<DevelopSettingsSaver, string>());
  const recoveredCleanupRef = useRef(new WeakMap<DevelopSettingsSaver, DevelopSettingsDraft[]>());
  const hiddenDraftsRef = useRef(new Set<string>());
  const [drafts, setDrafts] = useState<DevelopSettingsDraft[]>([]);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftMessage, setDraftMessage] = useState<string | null>(null);
  const refreshDraftsRef = useRef<() => void>(() => undefined);
  const [saveState, setSaveState] = useState<DevelopSettingsSaverState>("idle");
  // 写真を離れる処理（保存を送り終えて、補正後のプレビューの画を用意する）の途中。二重に走らせず、その間は補正を押せなくする
  const [leaving, setLeaving] = useState(false);
  const leavingRef = useRef<Promise<boolean> | null>(null);
  /** 最後に丁寧に描いた画（同じ設定なら描き直さない。開いたときの 1 枚目もここに入れる。補正後のプレビューもこの画を縮めて上げる） */
  const frameCacheRef = useRef<CachedFrame | null>(null);
  /** 「補正前」の画（切り抜いた枠のまま色だけ補正前。同じ設定なら描き直さない。幾何の無い写真は写真ごとに 1 回だけ描く） */
  const beforeFrameRef = useRef<CachedFrame | null>(null);
  // 段 2 の wasm を用意できなかった（作業コピーで直す写真も開く前から閉じる理由を出す）
  const [developUnavailable, setDevelopUnavailable] = useState(false);
  /**
   * 開いている写真の保存が、別の端末の保存に断られた（409。版の照合 移行元設計）ときに、今の写真で開き直す係
   * （`useBrowserPhotoDevelopReload` が入れる）
   */
  const saveStaleHandlerRef = useRef<((photo: PhotoLibraryPhoto) => void) | null>(null);
  /** 補正後のプレビューを上げる係（K3 移行元設計。この画面〔拠点〕に 1 つ。初めて要るときに作る） */
  const editedPreviewUploaderRef = useRef<EditedPreviewUploader | null>(null);
  /**
   * 補正後のプレビューに送った版（写真 ID → developRevision）。保存係は最後に保存した版を持ち続けるので、タブを隠す → 戻る →
   * 離れると同じ版が何度も来る。同じ版は 1 回だけ送る
   */
  const sentPreviewRevisionsRef = useRef(new Map<string, number>());
  const replaceCloudPhotoRef = useRef(replaceCloudPhoto);
  replaceCloudPhotoRef.current = replaceCloudPhoto;
  const uploadSavedEditedPreviewRef = useRef<
    (session: DevelopSession, saved: DevelopSettingsLastSaved) => Promise<void>
  >(async () => undefined);

  useEffect(
    () => () => {
      // 離れる処理（保存を送り終える・補正後のプレビューの画を描く）の途中なら、終わってから写真と engine を手放す。補正後の
      // プレビューの上げ係は止めない（route 離脱の直後に unmount しても、上げ始めた分は終わりまで上げる。送り終えれば捨てられる）
      const pendingLeave = leavingRef.current;
      const session = developSessionRef.current;
      developSessionRef.current = null;
      const disposeEngine = () => {
        engineRef.current?.dispose();
        engineRef.current = null;
      };
      if (pendingLeave) {
        void pendingLeave.then(
          () => {
            session?.saver?.dispose();
            disposeEngine();
          },
          () => {
            session?.saver?.dispose();
            disposeEngine();
          },
        );
        return;
      }
      // route guard を通らない unmount でも、provisional draft / canonical saver の最後の入力まで待ってから手放す。
      void Promise.resolve()
        .then(() => session?.provisionalDraft?.flush())
        .then(async () => {
          if (!session?.saver) return;
          const result = await session.saver.flush();
          if (result.ok && result.saved) await uploadSavedEditedPreviewRef.current(session, result.saved);
        })
        .catch((error: unknown) => {
          console.warn("[photo-editing] local edit flush failed during unmount", error);
        })
        .finally(() => {
          session?.saver?.dispose();
          disposeEngine();
        });
    },
    [],
  );

  /** 開いている（開こうとしている）写真の ID（面の読み口が読む写真。session ができる前の仮の描画のため、開き始めに入れる） */
  const maskSurfacePhotoIdRef = useRef<string | null>(null);
  /**
   * 開いている写真のマスクの面（ブラシ・被写体・空。M4 #68）の読み口。engine が描く前に、持っていない面をここから読む（写真は
   * 開き始めた写真か、無ければ今の session。面は中身の sha256 で呼ぶので、読み違えても別の面にはならない）。写真の出どころに口が
   * 無ければ読めない。
   */
  const maskSurfaceSource = useCallback<DevelopMaskSurfaceSource>(
    async (surfaceId) => {
      const photoId = maskSurfacePhotoIdRef.current ?? developSessionRef.current?.photoId ?? null;
      if (photoId === null || !library.loadMaskSurface) return null;
      return library.loadMaskSurface(photoId, surfaceId);
    },
    [library],
  );

  /**
   * 段 2 の wasm を使えるなら返す（初めて要るときに作る。使えなければ null）。wasm の manifest の場所は写真の出どころが決める
   * （`engineAssets`。web はこのページの `/develop-engine/…`）。
   */
  const readyDevelopEngine = useCallback(async (): Promise<DevelopEngine | null> => {
    if (!engineRef.current) {
      engineRef.current = createDevelopEngine({
        manifestUrl: library.engineAssets.manifestUrl() ?? undefined,
        preferNative: library.engineAssets.preferNative === true,
        deviceClass: params.deviceClass,
        maskSurfaces: maskSurfaceSource,
      });
    }
    const engine = engineRef.current;
    const ready = await engine.ready();
    if (!ready && mountedRef.current) setDevelopUnavailable(true);
    return ready ? engine : null;
  }, [library, maskSurfaceSource, mountedRef, params.deviceClass]);

  /** 開いた写真の wasm の編集を持つ（保存の状態は何も送っていない状態から）。 */
  const startSession = useCallback((session: DevelopSession) => {
    developSessionRef.current = session;
    setSaveState("idle");
    refreshDraftsRef.current();
  }, []);

  /** wasm で開いた 1 枚目の丁寧な画を覚え、「補正前」の画を捨てる（開いたときの 1 枚目は描き直さない）。 */
  const rememberOpenedFrame = useCallback((key: string, settings: DevelopSettings, frame: DevelopFrame | null) => {
    frameCacheRef.current = frame ? { key, settingsJson: JSON.stringify(settings), frame } : null;
    beforeFrameRef.current = null;
  }, []);

  /** 今の写真の wasm の編集を手放す（保存係を止め、持っている写真を wasm から外す）。保存は送らない。 */
  const releaseDevelopSession = useCallback(() => {
    const session = developSessionRef.current;
    if (!session) return;
    developSessionRef.current = null;
    session.saver?.dispose();
    if (mountedRef.current) setSaveState("idle");
    if (frameCacheRef.current?.key === session.key) frameCacheRef.current = null;
    if (beforeFrameRef.current?.key === session.key) beforeFrameRef.current = null;
    setDrafts([]);
    setDraftBusy(false);
    setDraftMessage(null);
    void engineRef.current?.close().catch(() => undefined);
  }, [mountedRef]);

  const refreshDrafts = useCallback(() => {
    const actorId = actorIdRef.current;
    const session = developSessionRef.current;
    const access = latestAccessRef.current;
    if (!actorId || !session?.saver || !access.canEdit || access.spotId !== session.spotId) {
      if (mountedRef.current) setDrafts([]);
      return;
    }
    const result = listDevelopSettingsDrafts({ actorId, spotId: session.spotId, photoId: session.photoId });
    if (!result.ok) {
      if (mountedRef.current) {
        setDrafts([]);
        setStatus({ kind: "error", text: "未保存の補正をこの端末から確認できません。自動保存は続けます。" });
      }
      return;
    }
    const ownDraftId = saverDraftIdsRef.current.get(session.saver);
    const next = result.drafts.filter(
      (draft) => draft.draftId !== ownDraftId && !hiddenDraftsRef.current.has(draftFingerprint(draft)),
    );
    if (mountedRef.current) setDrafts(next);
  }, [latestAccessRef, mountedRef, setStatus]);
  refreshDraftsRef.current = refreshDrafts;

  useEffect(() => {
    hiddenDraftsRef.current.clear();
    setDraftBusy(false);
    setDraftMessage(null);
    refreshDraftsRef.current();
  }, [params.actorId, params.spotId]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (isDevelopSettingsDraftStorageKey(event.key)) refreshDraftsRef.current();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  /**
   * 補正後のプレビューを上げる係（初めて要るときに作る）。上げ終えた（もう付いていた）写真は、署名付きの URL ごと ID で引き直して
   * 一覧の行に替え（入れ終わりの応答の `editedPreview` は URL を持たないので、そのまま替えると一覧のタイルが補正前に戻る）、
   * 編集面の外（記事制作の画像ライブラリ）へ知らせる（タイルが補正後の画になる）。上げられなかったときは画面に出さない（次に開いた
   * ときに上げ直す）。付けるのは写真の出どころ（`attachEditedPreview`。移行元設計）。
   */
  const editedPreviewUploader = useCallback((): EditedPreviewUploader => {
    if (editedPreviewUploaderRef.current) return editedPreviewUploaderRef.current;
    const uploader = createEditedPreviewUploader({
      attach: (photoId, developRevision, encoded, signal) => {
        if (!library.attachEditedPreview) return Promise.reject(new Error("photo library cannot attach edited previews"));
        return library.attachEditedPreview(photoId, developRevision, encoded, { signal });
      },
      onUploaded: (photoId) => {
        host.notifyPhotosChanged();
        void library.get(photoId).then(
          (photo) => {
            if (photo) {
              replaceCloudPhotoRef.current(photo);
              return;
            }
            // 上げ終えた後に消えていた（ほかのスタッフが消した）。一覧の読み直しに任せる
            console.warn("[photo-editing] edited preview photo reload failed", new Error("photo not found"));
            void queryClient
              .invalidateQueries({ queryKey: photoEditingQueryKeys.cloudPhotos(spotId, scopeKey) })
              .catch(() => undefined);
          },
          (error: unknown) => {
            console.warn("[photo-editing] edited preview photo reload failed", error);
            // upload は成功しているため、現在の一覧行が古い場合に画面復帰後の再取得を促す。
            void queryClient
              .invalidateQueries({ queryKey: photoEditingQueryKeys.cloudPhotos(spotId, scopeKey) })
              .catch(() => undefined);
          },
        );
      },
      onError: (photoId, error) => {
        // 同じ写真を開き直したとき再試行できるよう、失敗した版の抑止を解く。
        sentPreviewRevisionsRef.current.delete(photoId);
        console.warn("[photo-editing] edited preview upload failed", error);
      },
    });
    editedPreviewUploaderRef.current = uploader;
    return uploader;
  }, [host, library, queryClient, scopeKey, spotId]);

  /**
   * 補正後のプレビューを上げてよい写真か（直せる operator の、この画面の拠点の写真だけ。付ける口〔`attachEditedPreview`〕の無い置き場
   * ──この Mac──では上げない。作っても必ず失敗し、JPEG の縮小と余分な描画だけが走って `console.warn` が出る）。
   */
  const canUploadEditedPreview = useCallback(
    (session: DevelopSession): boolean => {
      if (!libraryCanAttachEditedPreview(library)) return false;
      const access = latestAccessRef.current;
      return access.canEdit && access.spotId === session.spotId && session.spotId === spotId;
    },
    [latestAccessRef, library, spotId],
  );

  /** 補正後のプレビューに、この版の画を送る（待たない。縮めて上げるのは上げ係）。 */
  const submitEditedPreview = useCallback(
    (session: DevelopSession, developRevision: number, frame: DevelopFrame) => {
      editedPreviewUploader().submit(session.photoId, { developRevision, frame });
      const sent = sentPreviewRevisionsRef.current;
      sent.set(session.photoId, Math.max(sent.get(session.photoId) ?? -1, developRevision));
    },
    [editedPreviewUploader],
  );

  /**
   * 開いた写真の補正後のプレビューが無い・古い（上げそびれた・別の端末で保存した）なら、開いた 1 枚目の丁寧な画（保存してある
   * `developSettings` で描いた画）を縮めて上げ直す（K3 移行元設計。待たない）。補正を保存したことが無い写真（版 0）・閲覧のみの
   * operator・1 枚目を描けなかった写真では何もしない。`settings` は開いたときの編集内容（1 枚目を描いた設定）。
   */
  const uploadOpenedEditedPreview = useCallback(
    (session: DevelopSession, settings: DevelopSettings, renderedFrame?: DevelopFrame) => {
      const photo = session.photo;
      if (!session.saver || session.settingsSource !== "develop" || photo.developRevision <= 0) return;
      if ((photo.editedPreview?.revision ?? -1) >= photo.developRevision || !canUploadEditedPreview(session)) return;
      if ((sentPreviewRevisionsRef.current.get(photo.id) ?? -1) >= photo.developRevision) return;
      const frame = renderedFrame ?? cachedFrameOf(frameCacheRef.current, session.key, settings);
      if (!frame) return;
      try {
        submitEditedPreview(session, photo.developRevision, frame);
      } catch (error) {
        // 開くのは止めない（次に開いたときに上げ直す）
        console.warn("[photo-editing] edited preview upload deferred", error);
      }
    },
    [canUploadEditedPreview, submitEditedPreview],
  );

  /**
   * 保存した版の画を、補正後のプレビューとして上げ始める（K3 移行元設計。写真を離れるとき。上げ終わりは待たない）。画は、最後に丁寧に
   * 描いた画が保存した設定のものならそれを使い、まだ無ければ（最後の変更の丁寧な画を描き終える前に離れた）写真を手放す前に描く。
   * 描けなければ上げない（次に開いたときに上げ直す）。同じ写真の同じ版は 1 回だけ。版の照合はサーバーに任せる（同じか新しい版の画が
   * もう付いていれば上げない）。
   */
  const uploadSavedEditedPreview = useCallback(
    async (session: DevelopSession, saved: DevelopSettingsLastSaved): Promise<void> => {
      if ((sentPreviewRevisionsRef.current.get(session.photoId) ?? -1) >= saved.developRevision) return;
      if (!canUploadEditedPreview(session)) return;
      let frame = cachedFrameOf(frameCacheRef.current, session.key, saved.settings);
      if (!frame) {
        const engine = engineRef.current;
        if (!engine) return;
        // 描く要求は最初の await より前に出し、描き終えてから写真と engine を手放す（route guard はこの処理が終わってから戻り、
        // その後で写真と engine を解放する）
        frame = await engine
          .render(saved.settings, { maxDimension: DEVELOP_PREVIEW_MAX_DIMENSION, interactive: false })
          .catch(() => null);
        if (!frame) return;
      }
      submitEditedPreview(session, saved.developRevision, frame);
    },
    [canUploadEditedPreview, submitEditedPreview],
  );
  uploadSavedEditedPreviewRef.current = uploadSavedEditedPreview;

  /**
   * 写真を離れる（移行元設計）。wasm で直している写真なら、保存を送り終え、保存した版の画を補正後のプレビューとして上げ始める
   * （上げ終わりは待たない。記事用の画像は描かない＝使うときに描く。K3 移行元設計）。保存できなければ false（離れない。状態欄に失敗と
   * 再試行が出ている）。`release` なら保存係と wasm の写真も手放す（一覧へ戻るだけなら残す）。走っている間に呼ばれたら、その結果を待つ。
   */
  const leaveEditing = useCallback(
    (options: { release: boolean }): Promise<boolean> => {
      const running = leavingRef.current;
      if (running) {
        return options.release ? running.then((left) => (left ? leaveEditingRef.current(options) : false)) : running;
      }
      const session = developSessionRef.current;
      if (!session) return Promise.resolve(true);
      const task = Promise.resolve().then(async (): Promise<boolean> => {
        try {
          if (mountedRef.current) setLeaving(true);
          if (session.provisionalDraft) {
            try {
              await session.provisionalDraft.flush();
            } catch {
              if (mountedRef.current) {
                setStatus({ kind: "error", text: "未保存の補正をこの端末に退避できません。もう一度操作してください。" });
              }
              return false;
            }
          }
          if (session.saver) {
            const result = await session.saver.flush();
            if (!result.ok) return false;
            // この画面で保存していなければ（`saved` が null）上げるものは無い。保存は送り終えているので、上げる用意に失敗しても
            // 離れる（次に開いたときに上げ直す）
            if (result.saved) {
              await uploadSavedEditedPreview(session, result.saved).catch((error: unknown) => {
                console.warn("[photo-editing] edited preview upload deferred", error);
              });
            }
          }
          if (options.release && developSessionRef.current === session) releaseDevelopSession();
          return true;
        } finally {
          leavingRef.current = null;
          if (mountedRef.current) setLeaving(false);
        }
      });
      leavingRef.current = task;
      return task;
    },
    [mountedRef, releaseDevelopSession, uploadSavedEditedPreview],
  );
  const leaveEditingRef = useRef(leaveEditing);
  leaveEditingRef.current = leaveEditing;

  // タブを隠すときも保存を送り終え、補正後のプレビューを上げ始める（上げ終わりは待たない）
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") void leaveEditingRef.current({ release: false });
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  /**
   * wasm で直す写真の保存係（閲覧のみの operator は作らない）。成功は何も出さず、状態欄は失敗だけ。`developRevision` は直し始めた
   * 版（開いた写真の今の行の版）で、保存のたびに `expectedRevision` として送る（別の端末が先に保存していれば 409 で止まり、
   * 開いている写真なら今の写真で開き直す。移行元設計）。
   */
  const createSaver = useCallback(
    (
      spotId: string,
      photoId: string,
      developRevision: number,
      contentSha256?: string,
      provisionalGeneration?: number,
    ): DevelopSettingsSaver => {
      const actorId = actorIdRef.current;
      let draftId: string | null = null;
      if (actorId) {
        try {
          draftId = createDevelopSettingsDraftId();
        } catch {
          draftId = null;
        }
      }
      let previousDraft: DevelopSettingsDraft | undefined;
      const saver: DevelopSettingsSaver = createDevelopSettingsSaver({
        expectedRevision: developRevision,
        isPermanentFailure: (error) => library.errors.isPermanentSaveFailure(error),
        onScheduled: (settings) => {
          const access = latestAccessRef.current;
          if (!actorId || actorIdRef.current !== actorId || !access.canEdit || access.spotId !== spotId) return undefined;
          const cleanup: ScheduledDraftCleanup = { recovered: [...(recoveredCleanupRef.current.get(saver) ?? [])] };
          if (!draftId) {
            if (mountedRef.current && developSessionRef.current?.saver === saver) {
              setStatus({ kind: "error", text: "未保存の補正をこの端末に退避できません。自動保存は続けます。" });
            }
            return cleanup;
          }
          const result = writeDevelopSettingsDraft({
            identity: { actorId, spotId, photoId, draftId },
            startedRevision: developRevision,
            settings,
            previous: previousDraft,
          });
          if (!result.ok) {
            if (mountedRef.current && developSessionRef.current?.saver === saver) {
              setStatus({ kind: "error", text: "未保存の補正をこの端末に退避できません。自動保存は続けます。" });
            }
            // A failed local write leaves the previous generation on disk. If this newer value
            // reaches the server, remove that now-stale generation only after the save succeeds.
            return previousDraft ? { ...cleanup, draft: previousDraft } : cleanup;
          }
          previousDraft = result.draft;
          return { ...cleanup, draft: result.draft };
        },
        onSaved: (_settings, scheduled) => {
          const cleanup = scheduled as ScheduledDraftCleanup | undefined;
          if (cleanup?.draft) removeDevelopSettingsDraft(cleanup.draft);
          const acknowledged = new Set((cleanup?.recovered ?? []).map(draftFingerprint));
          for (const draft of cleanup?.recovered ?? []) {
            if (removeDevelopSettingsDraft(draft)) hiddenDraftsRef.current.delete(draftFingerprint(draft));
          }
          recoveredCleanupRef.current.set(
            saver,
            (recoveredCleanupRef.current.get(saver) ?? []).filter((draft) => !acknowledged.has(draftFingerprint(draft))),
          );
          refreshDraftsRef.current();
          if (contentSha256 && provisionalGeneration !== undefined && library.removeProvisionalDraft) {
            void library.removeProvisionalDraft(photoId, contentSha256, provisionalGeneration).catch(() => undefined);
          }
        },
        save: async (settings, expectedRevision) => {
          const result = await library.saveDevelopSettings(photoId, settings, { expectedRevision });
          // 一覧の cache は編集画面へ入った時点の値を保っている。保存応答は補正後プレビューの pending 状態を返さないため、
          // 先に true を反映して一覧復帰後の polling を始め、サーバーの一覧応答へ引き継ぐ。
          if (result.kind === "saved") markEditedPreviewPending(photoId);
          return result;
        },
        onChange: () => {
          if (mountedRef.current && developSessionRef.current?.saver === saver) setSaveState(saver.getState());
        },
        // 送り直しても通らない失敗（写真が消えた・権限が無いなど）は 1 回だけ理由を出す
        onDropped: (error) => {
          if (!mountedRef.current || developSessionRef.current?.saver !== saver) return;
          setStatus({ kind: "error", text: library.errors.describe(error, DEVELOP_SAVE_DROPPED_FALLBACK) });
        },
        // 別の端末が先に保存していた。その写真をまだ開いていれば、今の写真で開き直す
        onStale: (photo) => {
          if (actorId && draftId) markDevelopSettingsDraftConflicted({ actorId, spotId, photoId, draftId });
          if (!mountedRef.current || developSessionRef.current?.saver !== saver) return;
          saveStaleHandlerRef.current?.(photo);
        },
      });
      if (draftId) saverDraftIdsRef.current.set(saver, draftId);
      recoveredCleanupRef.current.set(saver, []);
      return saver;
    },
    [latestAccessRef, library, markEditedPreviewPending, mountedRef, setStatus],
  );

  const access = latestAccessRef.current;
  const selectedDraft =
    params.actorId &&
    access.canEdit &&
    access.spotId === params.spotId &&
    drafts[0]?.actorId === params.actorId &&
    drafts[0].spotId === params.spotId &&
    drafts[0].photoId === developSessionRef.current?.photoId
      ? drafts[0]
      : null;
  const discardSelectedDraft = useCallback(() => {
    const draft = drafts[0];
    const session = developSessionRef.current;
    const access = latestAccessRef.current;
    if (!draft || actorIdRef.current !== draft.actorId || !access.canEdit ||
        access.spotId !== draft.spotId || session?.spotId !== draft.spotId || session.photoId !== draft.photoId) return;
    if (!removeDevelopSettingsDraft(draft) && mountedRef.current) {
      setStatus({ kind: "error", text: "未保存の補正が別の画面で更新されました。最新の候補を表示します。" });
    }
    hiddenDraftsRef.current.delete(draftFingerprint(draft));
    setDraftMessage(null);
    refreshDraftsRef.current();
  }, [drafts, latestAccessRef, mountedRef, setStatus]);

  const retainDraftUntilSaved = useCallback((saver: DevelopSettingsSaver, draft: DevelopSettingsDraft) => {
    const current = recoveredCleanupRef.current.get(saver) ?? [];
    recoveredCleanupRef.current.set(saver, [...current, draft]);
  }, []);

  const releaseRetainedDraft = useCallback((saver: DevelopSettingsSaver, draft: DevelopSettingsDraft) => {
    const current = recoveredCleanupRef.current.get(saver) ?? [];
    recoveredCleanupRef.current.set(
      saver,
      current.filter((item) => draftFingerprint(item) !== draftFingerprint(draft)),
    );
  }, []);

  const hideRestoredDraft = useCallback((draft: DevelopSettingsDraft) => {
    hiddenDraftsRef.current.add(draftFingerprint(draft));
    refreshDraftsRef.current();
  }, []);

  const checkPhotoDrafts = useCallback((photoIds: readonly string[]) => {
    const actorId = actorIdRef.current;
    const access = latestAccessRef.current;
    if (!actorId || !access.canEdit || access.spotId !== spotId) return { ok: false as const };
    const result = listDevelopSettingsDraftsForPhotos({ actorId, spotId }, photoIds);
    if (!result.ok) {
      if (mountedRef.current) {
        setStatus({ kind: "error", text: "記事に入れる写真の未保存補正を確認できません。写真編集を再読み込みして確認してください。" });
      }
      return { ok: false as const };
    }
    const currentSession = developSessionRef.current;
    const currentPhotoIsTarget =
      currentSession?.spotId === spotId && photoIds.includes(currentSession.photoId) && currentSession.saver !== null && currentSession.saver !== undefined;
    const ownDraftId = currentPhotoIsTarget && currentSession?.saver
      ? saverDraftIdsRef.current.get(currentSession.saver)
      : undefined;
    const recoveredFingerprints = new Set(
      (currentPhotoIsTarget && currentSession?.saver
        ? recoveredCleanupRef.current.get(currentSession.saver) ?? []
        : []
      ).map(draftFingerprint),
    );
    const unresolved = result.drafts.some((draft) => {
      if (currentPhotoIsTarget && draft.draftId === ownDraftId) return false;
      if (currentPhotoIsTarget && recoveredFingerprints.has(draftFingerprint(draft))) return false;
      return true;
    });
    return { ok: true as const, unresolved };
  }, [latestAccessRef, mountedRef, setStatus, spotId]);

  return {
    engineRef,
    developSessionRef,
    saveState,
    leaving,
    leavingRef,
    saveStaleHandlerRef,
    frameCacheRef,
    beforeFrameRef,
    developUnavailable,
    readyDevelopEngine,
    maskSurfaceSource,
    maskSurfacePhotoIdRef,
    startSession,
    rememberOpenedFrame,
    releaseDevelopSession,
    uploadOpenedEditedPreview,
    leaveEditing,
    createSaver,
    draftRecovery: {
      selectedDraft,
      count: selectedDraft ? drafts.length : 0,
      busy: draftBusy,
      message: draftMessage,
      setBusy: setDraftBusy,
      setMessage: setDraftMessage,
      discardSelectedDraft,
      refresh: refreshDrafts,
      retainDraftUntilSaved,
      releaseRetainedDraft,
      hideRestoredDraft,
      checkPhotoDrafts,
      actorIdRef,
    },
  };
}

export type BrowserPhotoDevelop = ReturnType<typeof useBrowserPhotoDevelop>;
