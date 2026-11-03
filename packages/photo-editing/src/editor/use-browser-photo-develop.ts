"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
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
import { PHOTO_EDITING_DURABLE_DRAFT_COPY } from "../photo-editing-copy";
import { photoEditingQueryKeys } from "../photo-editing-query-keys";
import type { PhotoLibraryPhoto } from "../library/photo-library";
import type {
  PhotoLibraryDevelopConflictComparison,
  PhotoLibraryDevelopConflictResolution,
  PhotoLibraryDevelopConflictToken,
  PhotoLibraryDevelopDraftSaveResult,
  PhotoLibraryDevelopDraftSnapshot,
  PhotoLibraryDevelopDraftSummary,
  PhotoLibraryDevelopDraftWriter,
} from "../library/photo-library-durable-drafts";
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

type DurableRecoveryState = {
  summaries: readonly PhotoLibraryDevelopDraftSummary[];
  nextCursor: string | null;
  writer: PhotoLibraryDevelopDraftWriter | null;
  snapshot: PhotoLibraryDevelopDraftSnapshot | null;
  comparison: PhotoLibraryDevelopConflictComparison | null;
  comparisonPreview: DurableComparisonPreview | null;
  busy: boolean;
  message: string | null;
};

type PreviousDraftEntry = {
  summary: PhotoLibraryDevelopDraftSummary;
  photoName: string;
};

type PreviousDraftsState = {
  ownerActorId: string | null;
  ownerPort: object | null;
  ownerScopeKey: string | undefined;
  ownerScopeSignal: AbortSignal | undefined;
  open: boolean;
  cursor: string | null;
  items: readonly PreviousDraftEntry[];
  nextCursor: string | null;
  writer: PhotoLibraryDevelopDraftWriter | null;
  snapshot: PhotoLibraryDevelopDraftSnapshot | null;
  comparison: PhotoLibraryDevelopConflictComparison | null;
  comparisonPreview: DurableComparisonPreview | null;
  photoName: string;
  busy: boolean;
  saveUnsupported: boolean;
  message: string | null;
};

export type DurableComparisonPreview = {
  comparison: PhotoLibraryDevelopConflictComparison;
  photoId: string;
  photoName: string;
  loading: boolean;
  candidateFrame: DevelopFrame | null;
  currentFrame: DevelopFrame | null;
  candidateReason: string | null;
  currentReason: string | null;
};

const EMPTY_DURABLE_RECOVERY: DurableRecoveryState = {
  summaries: [],
  nextCursor: null,
  writer: null,
  snapshot: null,
  comparison: null,
  comparisonPreview: null,
  busy: false,
  message: null,
};

const EMPTY_PREVIOUS_DRAFTS: PreviousDraftsState = {
  ownerActorId: null,
  ownerPort: null,
  ownerScopeKey: undefined,
  ownerScopeSignal: undefined,
  open: false,
  cursor: null,
  items: [],
  nextCursor: null,
  writer: null,
  snapshot: null,
  comparison: null,
  comparisonPreview: null,
  photoName: PHOTO_EDITING_DURABLE_DRAFT_COPY.photoFallback,
  busy: false,
  saveUnsupported: false,
  message: null,
};

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
  const latestSetStatusRef = useRef(setStatus);
  latestSetStatusRef.current = setStatus;
  const durablePort = library.durableDevelopDrafts;
  const previousPort = durablePort?.previous;
  const [durableRecovery, setDurableRecovery] = useState<DurableRecoveryState>(EMPTY_DURABLE_RECOVERY);
  const durableRecoveryRef = useRef(durableRecovery);
  durableRecoveryRef.current = durableRecovery;
  const durableRefreshGenerationRef = useRef(0);
  const durableComparisonGenerationRef = useRef(0);
  const [previousDrafts, setPreviousDrafts] = useState<PreviousDraftsState>(EMPTY_PREVIOUS_DRAFTS);
  const previousDraftsRef = useRef(previousDrafts);
  previousDraftsRef.current = previousDrafts;
  const previousGenerationRef = useRef(0);
  const previousOwnerActorIdRef = useRef<string | null>(null);
  const previousOwnerPortRef = useRef<object | null>(null);
  const previousOwnerScopeSignalRef = useRef<AbortSignal | undefined>(undefined);
  const previousComparisonGenerationRef = useRef(0);
  const previousPausedSaverRef = useRef<{
    saver: DevelopSettingsSaver;
    resume: () => void;
  } | null>(null);
  const durableSaversRef = useRef(new WeakMap<DevelopSettingsSaver, {
    writer: PhotoLibraryDevelopDraftWriter;
    photoId: string;
    sourceSha256: string;
  }>());
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
  const saveDurableRecoveryHandlerRef = useRef<((photo: PhotoLibraryPhoto) => void) | null>(null);
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
                latestSetStatusRef.current({ kind: "error", text: "未保存の補正をこの端末に退避できません。もう一度操作してください。" });
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

  const isDurableScopeCurrent = useCallback((): boolean => {
    return durablePort !== undefined && !host.scopeSignal?.aborted && durablePort.isCurrent();
  }, [durablePort, host.scopeSignal]);

  const isDurableFileScopeCurrent = useCallback((): boolean => {
    if (!isDurableScopeCurrent()) return false;
    try { return host.isScopeCurrent?.() !== false; } catch { return false; }
  }, [host, isDurableScopeCurrent]);

  const invalidatePreviousDrafts = useCallback((updateState: boolean, resumePaused = true): void => {
    previousGenerationRef.current += 1;
    previousComparisonGenerationRef.current += 1;
    const previous = previousDraftsRef.current;
    previousDraftsRef.current = EMPTY_PREVIOUS_DRAFTS;
    previousOwnerActorIdRef.current = null;
    previousOwnerPortRef.current = null;
    previousOwnerScopeSignalRef.current = undefined;
    previous.writer?.dispose();
    const paused = previousPausedSaverRef.current;
    if (resumePaused) {
      previousPausedSaverRef.current = null;
      paused?.resume();
    }
    if (updateState && mountedRef.current) setPreviousDrafts(EMPTY_PREVIOUS_DRAFTS);
  }, [mountedRef]);

  useEffect(() => {
    invalidatePreviousDrafts(true);
    const abort = () => invalidatePreviousDrafts(true);
    host.scopeSignal?.addEventListener("abort", abort, { once: true });
    return () => {
      host.scopeSignal?.removeEventListener("abort", abort);
      // unmountでは上のsession cleanupがflush→disposeする。ここでresumeしてnetworkを復活させない。
      // dependency切替なら次のeffect本体がowner-boundな旧saverだけをresumeする。
      invalidatePreviousDrafts(false, false);
    };
  }, [durablePort, host.scopeSignal, invalidatePreviousDrafts, params.actorId, scopeKey]);

  const refreshDurableRecovery = useCallback(async (): Promise<void> => {
    if (!durablePort || !isDurableScopeCurrent()) {
      if (mountedRef.current) setDurableRecovery(EMPTY_DURABLE_RECOVERY);
      return;
    }
    const generation = ++durableRefreshGenerationRef.current;
    try {
      const page = await durablePort.list(
        { limit: 16 },
        host.scopeSignal === undefined ? undefined : { signal: host.scopeSignal },
      );
      if (generation !== durableRefreshGenerationRef.current || !mountedRef.current || !isDurableScopeCurrent()) return;
      setDurableRecovery((current) => ({ ...current, summaries: page.items, nextCursor: page.nextCursor, message: null }));
    } catch {
      if (generation !== durableRefreshGenerationRef.current || !mountedRef.current || !isDurableScopeCurrent()) return;
      setDurableRecovery((current) => ({ ...current, message: PHOTO_EDITING_DURABLE_DRAFT_COPY.failed }));
    }
  }, [durablePort, host.scopeSignal, isDurableScopeCurrent, mountedRef]);

  useEffect(() => {
    if (!durablePort) {
      setDurableRecovery(EMPTY_DURABLE_RECOVERY);
      return;
    }
    const refresh = () => void refreshDurableRecovery();
    const unsubscribe = durablePort.subscribe(refresh);
    host.scopeSignal?.addEventListener("abort", refresh, { once: true });
    refresh();
    return () => {
      durableRefreshGenerationRef.current += 1;
      durableComparisonGenerationRef.current += 1;
      unsubscribe();
      host.scopeSignal?.removeEventListener("abort", refresh);
    };
  }, [durablePort, host.scopeSignal, refreshDurableRecovery]);

  const readDurableWriter = useCallback(async (
    writer: PhotoLibraryDevelopDraftWriter,
    comparison: PhotoLibraryDevelopConflictComparison | null = null,
  ): Promise<PhotoLibraryDevelopDraftSnapshot | null> => {
    try {
      const snapshot = await writer.read(host.scopeSignal === undefined ? undefined : { signal: host.scopeSignal });
      if (!mountedRef.current || !isDurableScopeCurrent()) return null;
      setDurableRecovery((current) => ({
        ...current,
        writer,
        snapshot,
        comparison,
        comparisonPreview: comparison === null || current.comparison?.choice !== comparison.choice
          ? null
          : current.comparisonPreview,
        busy: false,
        message: null,
      }));
      return snapshot;
    } catch {
      if (mountedRef.current && isDurableScopeCurrent()) {
        setDurableRecovery((current) => ({ ...current, busy: false, message: PHOTO_EDITING_DURABLE_DRAFT_COPY.failed }));
      }
      return null;
    }
  }, [host.scopeSignal, isDurableScopeCurrent, mountedRef]);

  const prepareDurableComparisonPreview = useCallback(async (
    writer: PhotoLibraryDevelopDraftWriter,
    comparison: PhotoLibraryDevelopConflictComparison,
  ): Promise<void> => {
    const generation = ++durableComparisonGenerationRef.current;
    const session = developSessionRef.current;
    const samePhoto = session?.photoId === writer.photoId &&
      session.photo.contentSha256 === writer.sourceSha256;
    let photoName = samePhoto
      ? session?.photo.fileName ?? PHOTO_EDITING_DURABLE_DRAFT_COPY.photoFallback
      : PHOTO_EDITING_DURABLE_DRAFT_COPY.photoFallback;
    if (!samePhoto) {
      try {
        const photo = await library.get(
          writer.photoId,
          host.scopeSignal === undefined ? undefined : { signal: host.scopeSignal },
        );
        if (generation !== durableComparisonGenerationRef.current || !mountedRef.current || !isDurableScopeCurrent()) return;
        if (photo?.contentSha256 === writer.sourceSha256) photoName = photo.fileName;
      } catch {
        if (generation !== durableComparisonGenerationRef.current || !mountedRef.current || !isDurableScopeCurrent()) return;
      }
      setDurableRecovery((current) => current.comparison?.choice === comparison.choice ? {
        ...current,
        comparisonPreview: {
          comparison,
          photoId: writer.photoId,
          photoName,
          loading: false,
          candidateFrame: null,
          currentFrame: null,
          candidateReason: PHOTO_EDITING_DURABLE_DRAFT_COPY.openPhotoToCompare,
          currentReason: PHOTO_EDITING_DURABLE_DRAFT_COPY.openPhotoToCompare,
        },
      } : current);
      return;
    }
    const engine = engineRef.current;
    const unavailableReason = session?.input?.kind === "provisional"
      ? PHOTO_EDITING_DURABLE_DRAFT_COPY.canonicalPending
      : engine === null
        ? PHOTO_EDITING_DURABLE_DRAFT_COPY.previewUnavailable
        : null;
    if (!session || unavailableReason !== null || engine === null) {
      setDurableRecovery((current) => current.comparison?.choice === comparison.choice ? {
        ...current,
        comparisonPreview: {
          comparison,
          photoId: writer.photoId,
          photoName,
          loading: false,
          candidateFrame: null,
          currentFrame: null,
          candidateReason: unavailableReason ?? PHOTO_EDITING_DURABLE_DRAFT_COPY.previewUnavailable,
          currentReason: unavailableReason ?? PHOTO_EDITING_DURABLE_DRAFT_COPY.previewUnavailable,
        },
      } : current);
      return;
    }
    const isCurrent = () => generation === durableComparisonGenerationRef.current && mountedRef.current &&
      isDurableScopeCurrent() && developSessionRef.current === session && engineRef.current === engine &&
      session.photoId === writer.photoId && session.photo.contentSha256 === writer.sourceSha256;
    setDurableRecovery((current) => current.comparison?.choice === comparison.choice ? {
      ...current,
      comparisonPreview: {
        comparison,
        photoId: writer.photoId,
        photoName,
        loading: true,
        candidateFrame: null,
        currentFrame: null,
        candidateReason: comparison.canAdopt ? null : PHOTO_EDITING_DURABLE_DRAFT_COPY.unsupportedPreview,
        currentReason: null,
      },
    } : current);
    let candidateFrame: DevelopFrame | null = null;
    if (comparison.canAdopt) {
      try {
        candidateFrame = await engine.render(comparison.candidate.settings, {
          maxDimension: 512,
          interactive: false,
          priority: "background",
        });
      } catch {
        candidateFrame = null;
      }
      if (!isCurrent()) return;
    }
    let currentFrame: DevelopFrame | null = null;
    try {
      currentFrame = await engine.render(comparison.current.settings, {
        maxDimension: 512,
        interactive: false,
        priority: "background",
      });
    } catch {
      currentFrame = null;
    }
    if (!isCurrent()) return;
    setDurableRecovery((current) => current.comparison?.choice === comparison.choice ? {
      ...current,
      comparisonPreview: {
        comparison,
        photoId: writer.photoId,
        photoName,
        loading: false,
        candidateFrame,
        currentFrame,
        candidateReason: comparison.canAdopt && candidateFrame === null
          ? PHOTO_EDITING_DURABLE_DRAFT_COPY.previewUnavailable
          : comparison.canAdopt ? null : PHOTO_EDITING_DURABLE_DRAFT_COPY.unsupportedPreview,
        currentReason: currentFrame === null ? PHOTO_EDITING_DURABLE_DRAFT_COPY.previewUnavailable : null,
      },
    } : current);
  }, [host.scopeSignal, isDurableScopeCurrent, library, mountedRef]);

  const compareDurableConflict = useCallback(async (
    writer: PhotoLibraryDevelopDraftWriter,
    conflict: PhotoLibraryDevelopConflictToken,
  ): Promise<void> => {
    if (!isDurableScopeCurrent()) return;
    setDurableRecovery((current) => ({ ...current, writer, busy: true, message: PHOTO_EDITING_DURABLE_DRAFT_COPY.checking }));
    try {
      const comparison = await writer.compare(
        conflict,
        host.scopeSignal === undefined ? undefined : { signal: host.scopeSignal },
      );
      if (!mountedRef.current || !isDurableScopeCurrent()) return;
      const snapshot = await readDurableWriter(writer, comparison);
      if (snapshot) await prepareDurableComparisonPreview(writer, comparison);
    } catch {
      if (mountedRef.current && isDurableScopeCurrent()) {
        setDurableRecovery((current) => ({ ...current, busy: false, message: PHOTO_EDITING_DURABLE_DRAFT_COPY.failed }));
      }
    }
  }, [host.scopeSignal, isDurableScopeCurrent, mountedRef, prepareDurableComparisonPreview, readDurableWriter]);

  const openDurableRecovery = useCallback(async (summary?: PhotoLibraryDevelopDraftSummary): Promise<void> => {
    const target = summary ?? durableRecoveryRef.current.summaries[0];
    if (!durablePort || !target || !isDurableScopeCurrent()) return;
    setDurableRecovery((current) => ({ ...current, busy: true, message: PHOTO_EDITING_DURABLE_DRAFT_COPY.checking }));
    try {
      const session = developSessionRef.current;
      const active = session?.saver ? durableSaversRef.current.get(session.saver) : undefined;
      const reusableWriter = active && session && active.writer.token === target.token &&
        active.photoId === target.photoId && session.photoId === target.photoId &&
        active.sourceSha256 === session.photo.contentSha256
        ? active.writer
        : null;
      const writer = reusableWriter ?? await durablePort.reopen(
        target.token,
        host.scopeSignal === undefined ? undefined : { signal: host.scopeSignal },
      );
      const snapshot = await readDurableWriter(writer);
      const conflict = snapshot?.conflicts[0];
      if (conflict) await compareDurableConflict(writer, conflict);
    } catch {
      if (mountedRef.current && isDurableScopeCurrent()) {
        setDurableRecovery((current) => ({ ...current, busy: false, message: PHOTO_EDITING_DURABLE_DRAFT_COPY.failed }));
      }
    }
  }, [compareDurableConflict, durablePort, host.scopeSignal, isDurableScopeCurrent, mountedRef, readDurableWriter]);

  const handleDurableSaveResult = useCallback(async (
    writer: PhotoLibraryDevelopDraftWriter,
    result: PhotoLibraryDevelopDraftSaveResult | PhotoLibraryDevelopConflictResolution,
    settledSettings: Readonly<Record<string, unknown>> | null,
  ): Promise<void> => {
    if (!isDurableScopeCurrent()) return;
    if (result.kind === "conflict") {
      await compareDurableConflict(writer, result.conflict);
      return;
    }
    const knownSettlement = result.kind === "saved" || result.kind === "resolved";
    const session = developSessionRef.current;
    const active = session?.saver ? durableSaversRef.current.get(session.saver) : undefined;
    if (
      knownSettlement && settledSettings !== null && session?.saver && active?.writer === writer &&
      active.photoId === writer.photoId && active.sourceSha256 === writer.sourceSha256 &&
      session.photoId === writer.photoId && session.photo.contentSha256 === writer.sourceSha256
    ) {
      session.saver.acknowledgeDurableInput?.(settledSettings);
    }
    const snapshot = await readDurableWriter(writer);
    if (!snapshot || !isDurableScopeCurrent()) return;
    const empty = snapshot.latest === null && snapshot.attempted === null && snapshot.conflicts.length === 0 &&
      !snapshot.hasUnknownAttempt && !snapshot.hasPendingResolution && snapshot.terminalReason === null;
    if (empty) {
      const keepWriterOpen = active?.writer === writer;
      if (!keepWriterOpen) writer.dispose();
      setDurableRecovery((current) => current.writer === writer
        ? { ...current, writer: null, snapshot: null, comparison: null, comparisonPreview: null, busy: false, message: null }
        : current);
    }
    await refreshDurableRecovery();
    // 復旧保存・競合の選択が確定した後は採用版で開き直し、保存係も現行版で作り直す。
    // 遅着の読取で、その後の入力を上書きしない。
    if ((result.kind === "saved" || result.kind === "resolved") && empty) {
      const selected = developSessionRef.current;
      const saver = selected?.saver;
      const mayReload = () => selected !== null && selected !== undefined &&
        developSessionRef.current === selected && selected.saver === saver &&
        selected.photoId === writer.photoId && selected.photo.contentSha256 === writer.sourceSha256 &&
        saver?.hasPendingWork() !== true && isDurableScopeCurrent();
      if (!mayReload()) return;
      try {
        const photo = await library.get(writer.photoId,
          host.scopeSignal === undefined ? undefined : { signal: host.scopeSignal });
        if (!mayReload()) return;
        if (photo === null || photo.id !== writer.photoId || photo.contentSha256 !== writer.sourceSha256 ||
            photo.developRevision < result.revision) {
          releaseDevelopSession();
          latestSetStatusRef.current({ kind: "error", text: PHOTO_EDITING_DURABLE_DRAFT_COPY.failed });
          return;
        }
        if (result.kind === "saved") saveDurableRecoveryHandlerRef.current?.(photo);
        else saveStaleHandlerRef.current?.(photo);
      } catch {
        if (!mayReload()) return;
        releaseDevelopSession();
        latestSetStatusRef.current({ kind: "error", text: PHOTO_EDITING_DURABLE_DRAFT_COPY.failed });
      }
    }
  }, [compareDurableConflict, host.scopeSignal, isDurableScopeCurrent, library, readDurableWriter,
    refreshDurableRecovery, releaseDevelopSession]);

  const retryDurableRecovery = useCallback(async (): Promise<void> => {
    const { writer, snapshot, comparison } = durableRecoveryRef.current;
    if (!writer || !snapshot || !isDurableScopeCurrent()) return;
    setDurableRecovery((current) => ({ ...current, busy: true, message: PHOTO_EDITING_DURABLE_DRAFT_COPY.checking }));
    const requestOptions = host.scopeSignal === undefined ? undefined : { signal: host.scopeSignal };
    const result = snapshot.hasPendingResolution ? await writer.retryResolution(requestOptions) : await writer.retry(requestOptions);
    if (!isDurableScopeCurrent()) return;
    const settled = snapshot.hasPendingResolution
      ? comparison?.candidate ?? snapshot.attempted ?? snapshot.latest
      : snapshot.attempted ?? snapshot.latest;
    await handleDurableSaveResult(writer, result, settled?.settings ?? null);
  }, [handleDurableSaveResult, host.scopeSignal, isDurableScopeCurrent]);

  const resolveDurableConflict = useCallback(async (decision: "adopt" | "keep-current"): Promise<void> => {
    const { writer, comparison, comparisonPreview } = durableRecoveryRef.current;
    const displayedChoice = comparisonPreview?.comparison.choice;
    if (!writer || !comparison || !comparisonPreview || displayedChoice !== comparison.choice || !isDurableScopeCurrent()) return;
    if (decision === "adopt" && (
      !comparison.canAdopt || comparisonPreview.candidateFrame === null || comparisonPreview.currentFrame === null
    )) return;
    setDurableRecovery((current) => ({ ...current, busy: true, message: PHOTO_EDITING_DURABLE_DRAFT_COPY.checking }));
    const result = await writer.resolve(
      comparison.choice,
      decision,
      host.scopeSignal === undefined ? undefined : { signal: host.scopeSignal },
    );
    if (!isDurableScopeCurrent()) return;
    await handleDurableSaveResult(writer, result, comparison.candidate.settings);
  }, [handleDurableSaveResult, host.scopeSignal, isDurableScopeCurrent]);

  const closeDurableComparison = useCallback(() => {
    durableComparisonGenerationRef.current += 1;
    setDurableRecovery((current) => ({
      ...current,
      comparison: null,
      comparisonPreview: null,
      message: null,
    }));
  }, []);

  const discardDurableRecovery = useCallback(async (): Promise<void> => {
    const { writer, snapshot } = durableRecoveryRef.current;
    if (!writer || !snapshot || snapshot.hasUnknownAttempt || snapshot.hasPendingResolution || !isDurableScopeCurrent()) return;
    setDurableRecovery((current) => ({ ...current, busy: true }));
    try {
      await writer.discard(host.scopeSignal === undefined ? undefined : { signal: host.scopeSignal });
      if (!isDurableScopeCurrent()) return;
      const session = developSessionRef.current;
      const active = session?.saver ? durableSaversRef.current.get(session.saver) : undefined;
      if (session?.saver && active?.writer === writer && session.photoId === writer.photoId &&
          session.photo.contentSha256 === writer.sourceSha256) {
        if (snapshot.attempted) session.saver.acknowledgeDurableInput?.(snapshot.attempted.settings);
        if (snapshot.latest) session.saver.acknowledgeDurableInput?.(snapshot.latest.settings);
      } else {
        writer.dispose();
      }
      durableComparisonGenerationRef.current += 1;
      setDurableRecovery((current) => ({ ...current, writer: null, snapshot: null, comparison: null, comparisonPreview: null, busy: false }));
      await refreshDurableRecovery();
    } catch {
      if (mountedRef.current && isDurableScopeCurrent()) {
        setDurableRecovery((current) => ({ ...current, busy: false, message: PHOTO_EDITING_DURABLE_DRAFT_COPY.failed }));
      }
    }
  }, [host.scopeSignal, isDurableScopeCurrent, mountedRef, refreshDurableRecovery]);

  const saveDurableRecoveryData = useCallback(async (): Promise<void> => {
    const { writer, snapshot, comparison } = durableRecoveryRef.current;
    if (!writer || !snapshot || snapshot.latest === null && snapshot.attempted === null || !isDurableFileScopeCurrent()) return;
    const envelope = {
      format: "niho-photo-develop-recovery",
      version: 1,
      photo: { id: writer.photoId, sourceSha256: writer.sourceSha256 },
      latest: snapshot.latest,
      attempted: snapshot.attempted,
      comparison: comparison === null ? null : {
        candidate: comparison.candidate,
        current: comparison.current,
        historicalCurrent: comparison.historicalCurrent,
        expectedRevision: comparison.expectedRevision,
      },
    } as const;
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" });
    try {
      await host.saveFile({ blob, fileName: PHOTO_EDITING_DURABLE_DRAFT_COPY.saveDataFileName });
      if (!isDurableFileScopeCurrent()) return;
    } catch {
      if (mountedRef.current && isDurableFileScopeCurrent()) {
        setDurableRecovery((current) => ({ ...current, message: PHOTO_EDITING_DURABLE_DRAFT_COPY.failed }));
      }
    }
  }, [host, isDurableFileScopeCurrent, mountedRef]);

  const previousRequestOptions = useMemo(
    () => host.scopeSignal === undefined ? undefined : { signal: host.scopeSignal },
    [host.scopeSignal],
  );
  const isPreviousGenerationCurrent = useCallback((generation: number): boolean =>
    generation === previousGenerationRef.current && mountedRef.current && previousPort !== undefined &&
    previousOwnerActorIdRef.current !== null && previousOwnerActorIdRef.current === actorIdRef.current &&
    previousOwnerPortRef.current === previousPort && previousOwnerScopeSignalRef.current === host.scopeSignal &&
    isDurableScopeCurrent(), [host.scopeSignal, isDurableScopeCurrent, mountedRef, previousPort]);

  const releasePreviousSelection = useCallback((keepDialogOpen: boolean): void => {
    previousGenerationRef.current += 1;
    previousComparisonGenerationRef.current += 1;
    const previous = previousDraftsRef.current;
    previous.writer?.dispose();
    const paused = previousPausedSaverRef.current;
    previousPausedSaverRef.current = null;
    paused?.resume();
    setPreviousDrafts((current) => ({
      ...current,
      open: keepDialogOpen,
      writer: null,
      snapshot: null,
      comparison: null,
      comparisonPreview: null,
      photoName: PHOTO_EDITING_DURABLE_DRAFT_COPY.photoFallback,
      busy: false,
      saveUnsupported: false,
      message: null,
    }));
  }, []);

  const loadPreviousDraftPage = useCallback(async (cursor: string | null): Promise<void> => {
    const ownerActorId = actorIdRef.current;
    if (!previousPort || !ownerActorId || !isDurableScopeCurrent()) return;
    const generation = ++previousGenerationRef.current;
    previousOwnerActorIdRef.current = ownerActorId;
    previousOwnerPortRef.current = previousPort;
    previousOwnerScopeSignalRef.current = host.scopeSignal;
    previousComparisonGenerationRef.current += 1;
    const previous = previousDraftsRef.current;
    previous.writer?.dispose();
    const paused = previousPausedSaverRef.current;
    previousPausedSaverRef.current = null;
    paused?.resume();
    setPreviousDrafts((current) => ({
      ...current,
      ownerActorId,
      ownerPort: previousPort,
      ownerScopeKey: scopeKey,
      ownerScopeSignal: host.scopeSignal,
      open: true,
      cursor,
      items: [],
      nextCursor: null,
      writer: null,
      snapshot: null,
      comparison: null,
      comparisonPreview: null,
      photoName: PHOTO_EDITING_DURABLE_DRAFT_COPY.photoFallback,
      busy: true,
      saveUnsupported: false,
      message: PHOTO_EDITING_DURABLE_DRAFT_COPY.previousChecking,
    }));
    try {
      const page = await previousPort.list(
        cursor === null ? { limit: 16 } : { cursor, limit: 16 },
        previousRequestOptions,
      );
      if (!isPreviousGenerationCurrent(generation)) return;
      const items: PreviousDraftEntry[] = [];
      for (const summary of page.items) {
        let photoName: string = PHOTO_EDITING_DURABLE_DRAFT_COPY.photoFallback;
        try {
          const photo = await library.get(summary.photoId, previousRequestOptions);
          if (!isPreviousGenerationCurrent(generation)) return;
          if (photo?.fileName?.trim()) photoName = photo.fileName;
        } catch {
          if (!isPreviousGenerationCurrent(generation)) return;
        }
        items.push({ summary, photoName });
      }
      if (!isPreviousGenerationCurrent(generation)) return;
      setPreviousDrafts((current) => ({
        ...current,
        ownerActorId,
        ownerPort: previousPort,
        ownerScopeKey: scopeKey,
        ownerScopeSignal: host.scopeSignal,
        open: true,
        cursor,
        items,
        nextCursor: page.nextCursor,
        busy: false,
        message: null,
      }));
    } catch {
      if (!isPreviousGenerationCurrent(generation)) return;
      setPreviousDrafts((current) => ({
        ...current,
        ownerActorId,
        ownerPort: previousPort,
        ownerScopeKey: scopeKey,
        ownerScopeSignal: host.scopeSignal,
        open: true,
        cursor,
        items: [],
        nextCursor: null,
        busy: false,
        message: PHOTO_EDITING_DURABLE_DRAFT_COPY.failed,
      }));
    }
  }, [host.scopeSignal, isDurableScopeCurrent, isPreviousGenerationCurrent, library, previousPort,
    previousRequestOptions, scopeKey]);

  const openPreviousDraft = useCallback(async (entry: PreviousDraftEntry): Promise<void> => {
    if (!previousPort || !isDurableScopeCurrent() || previousDraftsRef.current.busy) return;
    const generation = ++previousGenerationRef.current;
    previousComparisonGenerationRef.current += 1;
    const session = developSessionRef.current;
    if (session?.photoId === entry.summary.photoId && session.saver?.pauseDurable) {
      previousPausedSaverRef.current = { saver: session.saver, resume: session.saver.pauseDurable() };
    }
    setPreviousDrafts((current) => ({
      ...current,
      busy: true,
      saveUnsupported: false,
      message: PHOTO_EDITING_DURABLE_DRAFT_COPY.previousChecking,
      photoName: entry.photoName,
    }));
    let writer: PhotoLibraryDevelopDraftWriter | null = null;
    try {
      writer = await previousPort.reopen(entry.summary.token, previousRequestOptions);
      if (!isPreviousGenerationCurrent(generation)) {
        writer.dispose();
        return;
      }
      const snapshot = await writer.read(previousRequestOptions);
      if (!isPreviousGenerationCurrent(generation)) {
        writer.dispose();
        return;
      }
      setPreviousDrafts((current) => ({
        ...current,
        writer,
        snapshot,
        comparison: null,
        comparisonPreview: null,
        busy: false,
        message: null,
      }));
    } catch {
      writer?.dispose();
      if (!isPreviousGenerationCurrent(generation)) return;
      const paused = previousPausedSaverRef.current;
      previousPausedSaverRef.current = null;
      paused?.resume();
      setPreviousDrafts((current) => ({
        ...current,
        writer: null,
        snapshot: null,
        busy: false,
        message: PHOTO_EDITING_DURABLE_DRAFT_COPY.failed,
      }));
    }
  }, [isDurableScopeCurrent, isPreviousGenerationCurrent, previousPort, previousRequestOptions]);

  const savePreviousDraftData = useCallback(async (): Promise<void> => {
    const { writer, snapshot, comparison } = previousDraftsRef.current;
    if (!writer || !snapshot || snapshot.latest === null && snapshot.attempted === null || !isDurableFileScopeCurrent()) return;
    const envelope = {
      format: "niho-photo-develop-recovery",
      version: 1,
      photo: { id: writer.photoId, sourceSha256: writer.sourceSha256 },
      latest: snapshot.latest,
      attempted: snapshot.attempted,
      comparison: comparison === null ? null : {
        candidate: comparison.candidate,
        current: comparison.current,
        historicalCurrent: comparison.historicalCurrent,
        expectedRevision: comparison.expectedRevision,
      },
    } as const;
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" });
    try {
      await host.saveFile({ blob, fileName: PHOTO_EDITING_DURABLE_DRAFT_COPY.saveDataFileName });
      if (!isDurableFileScopeCurrent()) return;
    } catch {
      if (mountedRef.current && isDurableFileScopeCurrent()) {
        setPreviousDrafts((current) => ({ ...current, message: PHOTO_EDITING_DURABLE_DRAFT_COPY.failed }));
      }
    }
  }, [host, isDurableFileScopeCurrent, mountedRef]);

  const preparePreviousComparisonPreview = useCallback(async (
    writer: PhotoLibraryDevelopDraftWriter,
    comparison: PhotoLibraryDevelopConflictComparison,
  ): Promise<void> => {
    const generation = ++previousComparisonGenerationRef.current;
    const previousGeneration = previousGenerationRef.current;
    const session = developSessionRef.current;
    const samePhoto = session?.photoId === writer.photoId && session.photo.contentSha256 === writer.sourceSha256;
    const photoName = previousDraftsRef.current.photoName || PHOTO_EDITING_DURABLE_DRAFT_COPY.photoFallback;
    const publish = (preview: DurableComparisonPreview) => {
      if (generation !== previousComparisonGenerationRef.current ||
          !isPreviousGenerationCurrent(previousGeneration)) return;
      setPreviousDrafts((current) => current.comparison?.choice === comparison.choice
        ? { ...current, comparisonPreview: preview }
        : current);
    };
    if (!samePhoto) {
      publish({
        comparison, photoId: writer.photoId, photoName, loading: false,
        candidateFrame: null, currentFrame: null,
        candidateReason: PHOTO_EDITING_DURABLE_DRAFT_COPY.openPhotoToCompare,
        currentReason: PHOTO_EDITING_DURABLE_DRAFT_COPY.openPhotoToCompare,
      });
      return;
    }
    const engine = engineRef.current;
    const unavailableReason = session?.input?.kind === "provisional"
      ? PHOTO_EDITING_DURABLE_DRAFT_COPY.canonicalPending
      : engine === null ? PHOTO_EDITING_DURABLE_DRAFT_COPY.previewUnavailable : null;
    if (!session || unavailableReason !== null || engine === null) {
      publish({
        comparison, photoId: writer.photoId, photoName, loading: false,
        candidateFrame: null, currentFrame: null,
        candidateReason: unavailableReason ?? PHOTO_EDITING_DURABLE_DRAFT_COPY.previewUnavailable,
        currentReason: unavailableReason ?? PHOTO_EDITING_DURABLE_DRAFT_COPY.previewUnavailable,
      });
      return;
    }
    const isCurrent = () => generation === previousComparisonGenerationRef.current &&
      isPreviousGenerationCurrent(previousGeneration) && developSessionRef.current === session &&
      engineRef.current === engine && session.photoId === writer.photoId &&
      session.photo.contentSha256 === writer.sourceSha256;
    publish({
      comparison, photoId: writer.photoId, photoName, loading: true,
      candidateFrame: null, currentFrame: null,
      candidateReason: comparison.canAdopt ? null : PHOTO_EDITING_DURABLE_DRAFT_COPY.unsupportedPreview,
      currentReason: null,
    });
    let candidateFrame: DevelopFrame | null = null;
    if (comparison.canAdopt) {
      try {
        candidateFrame = await engine.render(comparison.candidate.settings, {
          maxDimension: 512, interactive: false, priority: "background",
        });
      } catch { candidateFrame = null; }
      if (!isCurrent()) return;
    }
    let currentFrame: DevelopFrame | null = null;
    try {
      currentFrame = await engine.render(comparison.current.settings, {
        maxDimension: 512, interactive: false, priority: "background",
      });
    } catch { currentFrame = null; }
    if (!isCurrent()) return;
    publish({
      comparison, photoId: writer.photoId, photoName, loading: false,
      candidateFrame, currentFrame,
      candidateReason: comparison.canAdopt && candidateFrame === null
        ? PHOTO_EDITING_DURABLE_DRAFT_COPY.previewUnavailable
        : comparison.canAdopt ? null : PHOTO_EDITING_DURABLE_DRAFT_COPY.unsupportedPreview,
      currentReason: currentFrame === null ? PHOTO_EDITING_DURABLE_DRAFT_COPY.previewUnavailable : null,
    });
  }, [isPreviousGenerationCurrent]);

  const comparePreviousDraft = useCallback(async (): Promise<void> => {
    const { writer, snapshot } = previousDraftsRef.current;
    const conflict = snapshot?.conflicts[0];
    if (!writer || !conflict || !isDurableScopeCurrent()) return;
    const generation = previousGenerationRef.current;
    setPreviousDrafts((current) => ({
      ...current, busy: true, message: PHOTO_EDITING_DURABLE_DRAFT_COPY.checking,
    }));
    try {
      const comparison = await writer.compare(conflict, previousRequestOptions);
      if (!isPreviousGenerationCurrent(generation)) return;
      const nextSnapshot = await writer.read(previousRequestOptions);
      if (!isPreviousGenerationCurrent(generation)) return;
      setPreviousDrafts((current) => ({
        ...current, snapshot: nextSnapshot, comparison, comparisonPreview: null, busy: false, message: null,
      }));
      await preparePreviousComparisonPreview(writer, comparison);
    } catch {
      if (!isPreviousGenerationCurrent(generation)) return;
      setPreviousDrafts((current) => ({
        ...current, busy: false, message: PHOTO_EDITING_DURABLE_DRAFT_COPY.failed,
      }));
    }
  }, [isDurableScopeCurrent, isPreviousGenerationCurrent, preparePreviousComparisonPreview, previousRequestOptions]);

  const finishPreviousKnownSettlement = useCallback(async (
    writer: PhotoLibraryDevelopDraftWriter,
    revision: number,
    kind: "saved" | "resolved",
  ): Promise<void> => {
    const session = developSessionRef.current;
    const paused = previousPausedSaverRef.current;
    const sameSession = session?.saver !== null && session?.saver !== undefined && paused?.saver === session.saver &&
      session.photoId === writer.photoId && session.photo.contentSha256 === writer.sourceSha256;
    const mayReload = (): boolean => sameSession && session !== null && paused !== null &&
      paused.saver === session.saver && paused.saver.hasPendingWork() !== true &&
      developSessionRef.current === session && isDurableScopeCurrent();
    const shouldReload = mayReload();
    releasePreviousSelection(true);
    if (!shouldReload || !isDurableScopeCurrent()) return;
    try {
      const photo = await library.get(writer.photoId, previousRequestOptions);
      if (!mountedRef.current || !mayReload()) return;
      if (photo === null || photo.id !== writer.photoId || photo.contentSha256 !== writer.sourceSha256 ||
          photo.developRevision < revision) {
        releaseDevelopSession();
        latestSetStatusRef.current({ kind: "error", text: PHOTO_EDITING_DURABLE_DRAFT_COPY.failed });
        return;
      }
      if (kind === "saved") saveDurableRecoveryHandlerRef.current?.(photo);
      else saveStaleHandlerRef.current?.(photo);
    } catch {
      if (!mountedRef.current || !mayReload()) return;
      releaseDevelopSession();
      latestSetStatusRef.current({ kind: "error", text: PHOTO_EDITING_DURABLE_DRAFT_COPY.failed });
    }
  }, [isDurableScopeCurrent, library, mountedRef, previousRequestOptions, releaseDevelopSession,
    releasePreviousSelection]);

  const handlePreviousSaveResult = useCallback(async (
    writer: PhotoLibraryDevelopDraftWriter,
    result: PhotoLibraryDevelopDraftSaveResult | PhotoLibraryDevelopConflictResolution,
  ): Promise<void> => {
    const generation = previousGenerationRef.current;
    if (!isPreviousGenerationCurrent(generation)) return;
    if (result.kind === "conflict") {
      const snapshot = await writer.read(previousRequestOptions);
      if (!isPreviousGenerationCurrent(generation)) return;
      setPreviousDrafts((current) => ({ ...current, snapshot, busy: false, saveUnsupported: false, message: null }));
      return;
    }
    const unsupported = result.kind === "unsupported";
    if (unsupported) {
      setPreviousDrafts((current) => ({
        ...current,
        saveUnsupported: true,
        message: PHOTO_EDITING_DURABLE_DRAFT_COPY.previousUnsupported,
      }));
    }
    const snapshot = await writer.read(previousRequestOptions);
    if (!isPreviousGenerationCurrent(generation)) return;
    const empty = snapshot.latest === null && snapshot.attempted === null && snapshot.conflicts.length === 0 &&
      !snapshot.hasUnknownAttempt && !snapshot.hasPendingResolution && snapshot.terminalReason === null;
    setPreviousDrafts((current) => ({
      ...current,
      snapshot,
      comparison: snapshot.hasPendingResolution ? current.comparison : null,
      comparisonPreview: snapshot.hasPendingResolution ? current.comparisonPreview : null,
      busy: false,
      saveUnsupported: unsupported,
      message: unsupported ? PHOTO_EDITING_DURABLE_DRAFT_COPY.previousUnsupported : null,
    }));
    if (empty && (result.kind === "saved" || result.kind === "resolved")) {
      await finishPreviousKnownSettlement(writer, result.revision, result.kind);
    }
  }, [finishPreviousKnownSettlement, isPreviousGenerationCurrent, previousRequestOptions]);

  const savePreviousDraft = useCallback(async (): Promise<void> => {
    const { writer, snapshot } = previousDraftsRef.current;
    if (!writer || !snapshot || previousDraftsRef.current.busy || previousDraftsRef.current.saveUnsupported ||
        !isDurableScopeCurrent()) return;
    const generation = previousGenerationRef.current;
    setPreviousDrafts((current) => ({
      ...current, busy: true, message: PHOTO_EDITING_DURABLE_DRAFT_COPY.previousChecking,
    }));
    try {
      const result = snapshot.hasPendingResolution
        ? await writer.retryResolution(previousRequestOptions)
        : snapshot.hasUnknownAttempt
          ? await writer.retry(previousRequestOptions)
          : snapshot.latestStage
            ? await writer.save(snapshot.latestStage, previousRequestOptions)
            : await writer.retry(previousRequestOptions);
      if (!isPreviousGenerationCurrent(generation)) return;
      await handlePreviousSaveResult(writer, result);
    } catch {
      if (!isPreviousGenerationCurrent(generation)) return;
      setPreviousDrafts((current) => ({
        ...current,
        busy: false,
        message: current.saveUnsupported
          ? PHOTO_EDITING_DURABLE_DRAFT_COPY.previousUnsupported
          : PHOTO_EDITING_DURABLE_DRAFT_COPY.failed,
      }));
    }
  }, [handlePreviousSaveResult, isDurableScopeCurrent, isPreviousGenerationCurrent, previousRequestOptions]);

  const resolvePreviousConflict = useCallback(async (decision: "adopt" | "keep-current"): Promise<void> => {
    const { writer, comparison, comparisonPreview } = previousDraftsRef.current;
    if (!writer || !comparison || !comparisonPreview || comparisonPreview.comparison.choice !== comparison.choice ||
        previousDraftsRef.current.busy || !isDurableScopeCurrent()) return;
    if (decision === "adopt" && (!comparison.canAdopt || comparisonPreview.candidateFrame === null ||
        comparisonPreview.currentFrame === null)) return;
    const generation = previousGenerationRef.current;
    setPreviousDrafts((current) => ({
      ...current, busy: true, message: PHOTO_EDITING_DURABLE_DRAFT_COPY.checking,
    }));
    try {
      const result = await writer.resolve(comparison.choice, decision, previousRequestOptions);
      if (!isPreviousGenerationCurrent(generation)) return;
      await handlePreviousSaveResult(writer, result);
    } catch {
      if (!isPreviousGenerationCurrent(generation)) return;
      setPreviousDrafts((current) => ({
        ...current, busy: false, message: PHOTO_EDITING_DURABLE_DRAFT_COPY.failed,
      }));
    }
  }, [handlePreviousSaveResult, isDurableScopeCurrent, isPreviousGenerationCurrent, previousRequestOptions]);

  const closePreviousComparison = useCallback(() => {
    if (previousDraftsRef.current.busy) return;
    previousComparisonGenerationRef.current += 1;
    setPreviousDrafts((current) => ({
      ...current, comparison: null, comparisonPreview: null, message: null,
    }));
  }, []);

  const discardPreviousDraft = useCallback(async (): Promise<void> => {
    const { writer, snapshot } = previousDraftsRef.current;
    if (!writer || !snapshot || snapshot.hasUnknownAttempt || snapshot.hasPendingResolution ||
        previousDraftsRef.current.busy || !isDurableScopeCurrent()) return;
    const generation = previousGenerationRef.current;
    setPreviousDrafts((current) => ({ ...current, busy: true }));
    try {
      await writer.discard(previousRequestOptions);
      if (!isPreviousGenerationCurrent(generation)) return;
      releasePreviousSelection(true);
    } catch {
      if (!isPreviousGenerationCurrent(generation)) return;
      setPreviousDrafts((current) => ({
        ...current, busy: false, message: PHOTO_EDITING_DURABLE_DRAFT_COPY.failed,
      }));
    }
  }, [isDurableScopeCurrent, isPreviousGenerationCurrent, previousRequestOptions, releasePreviousSelection]);

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
    ): DevelopSettingsSaver | null => {
      if (durablePort) {
        if (!contentSha256 || !isDurableScopeCurrent()) return null;
        // 同じ写真の既存writerを新しいkeyへ移さない。本人が復旧面で明示操作するまで編集を止める。
        if (durableRecoveryRef.current.summaries.some((summary) => summary.photoId === photoId)) return null;
        const writer = durablePort.open({ photoId, sourceSha256: contentSha256, expectedRevision: developRevision });
        let durableSaver!: DevelopSettingsSaver;
        const inner = createDevelopSettingsSaver({
          expectedRevision: developRevision,
          save: async () => { throw new Error("durable save must use its staged writer"); },
          isPermanentFailure: () => false,
          durable: {
            stage: (settings) => {
              if (!isDurableScopeCurrent()) throw new Error("photo scope changed");
              return writer.stage(settings);
            },
            save: async (_settings, stage) => {
              if (!isDurableScopeCurrent()) return { kind: "unsaved" };
              const result = await writer.save(
                stage,
                host.scopeSignal === undefined ? undefined : { signal: host.scopeSignal },
              );
              if (!isDurableScopeCurrent()) return { kind: "unsaved" };
              if (result.kind === "saved") markEditedPreviewPending(photoId);
              return result;
            },
            onConflict: (conflict) => void compareDurableConflict(writer, conflict),
            onBlocked: () => void readDurableWriter(writer),
          },
          onSaved: () => {
            if (!isDurableScopeCurrent()) return;
            if (provisionalGeneration !== undefined && library.removeProvisionalDraft) {
              void library.removeProvisionalDraft(photoId, contentSha256, provisionalGeneration).catch(() => undefined);
            }
            void refreshDurableRecovery();
          },
          onChange: () => {
            if (mountedRef.current && isDurableScopeCurrent() && developSessionRef.current?.saver === durableSaver) {
              setSaveState(durableSaver.getState());
            }
          },
        });
        durableSaver = {
          ...inner,
          dispose() {
            inner.dispose();
            writer.dispose();
          },
        };
        durableSaversRef.current.set(durableSaver, { writer, photoId, sourceSha256: contentSha256 });
        return durableSaver;
      }
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
    [compareDurableConflict, durablePort, host.scopeSignal, isDurableScopeCurrent, latestAccessRef, library, markEditedPreviewPending, mountedRef, readDurableWriter, refreshDurableRecovery, setStatus],
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

  const durableSnapshot = durableRecovery.snapshot;
  const durableComparison = durableRecovery.comparison;
  const durableComparisonPreview = durableRecovery.comparisonPreview;
  const durableCurrentPhotoId = developSessionRef.current?.photoId;
  const durableCurrentSaver = developSessionRef.current?.saver ?? null;
  const durableCurrentSaverBinding = durableCurrentSaver ? durableSaversRef.current.get(durableCurrentSaver) : undefined;
  const durableCurrentSaverPending = durableCurrentSaverBinding !== undefined && durableCurrentSaver?.hasPendingWork() === true;
  const durableCurrentSaverToken = durableCurrentSaverBinding?.writer.token;
  const durableRecoveryPending = durableRecovery.summaries.length > 0 || durableRecovery.writer !== null || durableCurrentSaverPending;
  const durableRecoveryMessage = durableRecovery.message ?? (
    durableComparison
      ? durableComparison.canAdopt
        ? PHOTO_EDITING_DURABLE_DRAFT_COPY.conflict
        : PHOTO_EDITING_DURABLE_DRAFT_COPY.unsupported
      : durableSnapshot?.hasUnknownAttempt || durableSnapshot?.hasPendingResolution
        ? PHOTO_EDITING_DURABLE_DRAFT_COPY.unknown
        : durableSnapshot?.terminalReason
          ? PHOTO_EDITING_DURABLE_DRAFT_COPY.terminal
          : durableRecoveryPending
            ? PHOTO_EDITING_DURABLE_DRAFT_COPY.pending
            : null
  );
  const durableRecoveryActions = durableComparison
    ? [
        {
          label: PHOTO_EDITING_DURABLE_DRAFT_COPY.back,
          onClick: closeDurableComparison,
        },
      ]
    : durableRecovery.writer === null
      ? durableRecovery.summaries.length > 0
        ? [{ label: PHOTO_EDITING_DURABLE_DRAFT_COPY.check, onClick: () => void openDurableRecovery() }]
        : durableCurrentSaverPending && durableCurrentSaver
          ? [{ label: PHOTO_EDITING_DURABLE_DRAFT_COPY.save, onClick: () => void durableCurrentSaver.retry() }]
          : []
      : [
          ...(durableSnapshot?.conflicts[0] ? [{
            label: PHOTO_EDITING_DURABLE_DRAFT_COPY.compare,
            onClick: () => void compareDurableConflict(durableRecovery.writer as PhotoLibraryDevelopDraftWriter, durableSnapshot.conflicts[0]!),
          }] : []),
          ...(!durableSnapshot?.terminalReason ? [{
            label: durableSnapshot?.hasUnknownAttempt || durableSnapshot?.hasPendingResolution
              ? PHOTO_EDITING_DURABLE_DRAFT_COPY.confirmSave
              : PHOTO_EDITING_DURABLE_DRAFT_COPY.save,
            onClick: () => void retryDurableRecovery(),
          }] : []),
          ...((durableSnapshot?.latest ?? durableSnapshot?.attempted) ? [{
            label: PHOTO_EDITING_DURABLE_DRAFT_COPY.saveData,
            onClick: () => void saveDurableRecoveryData(),
          }] : []),
          ...(!durableSnapshot?.hasUnknownAttempt && !durableSnapshot?.hasPendingResolution ? [{
            label: PHOTO_EDITING_DURABLE_DRAFT_COPY.discard,
            onClick: () => void discardDurableRecovery(),
          }] : []),
        ];

  const previousSnapshot = previousDrafts.snapshot;
  const previousComparison = previousDrafts.comparison;
  const previousComparisonPreview = previousDrafts.comparisonPreview;
  const previousOwnerVisible = params.actorId !== null && previousDrafts.ownerActorId === params.actorId &&
    previousDrafts.ownerPort === previousPort && previousDrafts.ownerScopeKey === scopeKey &&
    previousDrafts.ownerScopeSignal === host.scopeSignal;
  const previousSelectedMessage = previousDrafts.message ?? (
    previousComparison
      ? previousComparison.canAdopt
        ? PHOTO_EDITING_DURABLE_DRAFT_COPY.conflict
        : PHOTO_EDITING_DURABLE_DRAFT_COPY.unsupported
      : previousSnapshot?.hasUnknownAttempt || previousSnapshot?.hasPendingResolution
        ? PHOTO_EDITING_DURABLE_DRAFT_COPY.unknown
        : previousSnapshot?.terminalReason
          ? PHOTO_EDITING_DURABLE_DRAFT_COPY.terminal
          : PHOTO_EDITING_DURABLE_DRAFT_COPY.previousDescription
  );
  const previousSelectedActions = previousDrafts.writer === null ? [] : [
    ...(previousSnapshot?.conflicts[0] ? [{
      label: PHOTO_EDITING_DURABLE_DRAFT_COPY.compare,
      onClick: () => void comparePreviousDraft(),
    }] : []),
    ...(!previousSnapshot?.terminalReason && !previousDrafts.saveUnsupported ? [{
      label: PHOTO_EDITING_DURABLE_DRAFT_COPY.previousSave,
      onClick: () => void savePreviousDraft(),
    }] : []),
    ...((previousSnapshot?.latest ?? previousSnapshot?.attempted) ? [{
      label: PHOTO_EDITING_DURABLE_DRAFT_COPY.saveData,
      onClick: () => void savePreviousDraftData(),
    }] : []),
    ...(!previousSnapshot?.hasUnknownAttempt && !previousSnapshot?.hasPendingResolution ? [{
      label: PHOTO_EDITING_DURABLE_DRAFT_COPY.discard,
      onClick: () => void discardPreviousDraft(),
    }] : []),
  ];
  const previousBlocksCurrentPhoto = previousOwnerVisible && previousDrafts.open && previousDrafts.writer !== null &&
    previousDrafts.writer.photoId === durableCurrentPhotoId;

  return {
    engineRef,
    developSessionRef,
    saveState,
    leaving,
    leavingRef,
    saveStaleHandlerRef,
    saveDurableRecoveryHandlerRef,
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
    durableRecovery: {
      pending: durableRecoveryPending,
      blocksCurrentPhoto: durableCurrentPhotoId !== undefined && (
        durableRecovery.writer?.photoId === durableCurrentPhotoId ||
        durableRecovery.summaries.some((summary) => summary.photoId === durableCurrentPhotoId &&
          summary.token !== durableCurrentSaverToken)
      ),
      count: durableRecovery.summaries.length,
      busy: durableRecovery.busy,
      message: durableRecoveryMessage,
      actions: durableRecoveryActions,
      comparison: durableComparisonPreview ? {
        photoName: durableComparisonPreview.photoName,
        loading: durableComparisonPreview.loading,
        candidateFrame: durableComparisonPreview.candidateFrame,
        currentFrame: durableComparisonPreview.currentFrame,
        candidateReason: durableComparisonPreview.candidateReason,
        currentReason: durableComparisonPreview.currentReason,
        canAdopt: durableComparison !== null && durableComparisonPreview.comparison.choice === durableComparison.choice &&
          durableComparisonPreview.candidateFrame !== null && durableComparisonPreview.currentFrame !== null &&
          durableComparison.canAdopt,
        busy: durableRecovery.busy,
        onAdopt: () => void resolveDurableConflict("adopt"),
        onKeepCurrent: () => void resolveDurableConflict("keep-current"),
        onSaveData: durableSnapshot?.latest || durableSnapshot?.attempted
          ? () => void saveDurableRecoveryData()
          : null,
        onClose: closeDurableComparison,
      } : null,
      refresh: refreshDurableRecovery,
    },
    previousDrafts: {
      entryAction: previousPort && params.actorId ? {
        label: PHOTO_EDITING_DURABLE_DRAFT_COPY.previousEntry,
        disabled: previousDrafts.open || durableRecovery.busy || durableRecovery.comparison !== null,
        onClick: () => void loadPreviousDraftPage(null),
      } : null,
      blocksCurrentPhoto: previousBlocksCurrentPhoto,
      dialog: previousOwnerVisible && previousDrafts.open && previousDrafts.comparison === null ? {
        busy: previousDrafts.busy,
        message: previousDrafts.writer ? previousSelectedMessage : previousDrafts.message,
        items: previousDrafts.items.map((entry) => ({
          photoName: entry.photoName,
          onOpen: () => void openPreviousDraft(entry),
        })),
        selected: previousDrafts.writer ? {
          photoName: previousDrafts.photoName,
          actions: previousSelectedActions,
        } : null,
        hasNext: previousDrafts.nextCursor !== null,
        isFirst: previousDrafts.cursor === null,
        onNext: () => {
          const cursor = previousDraftsRef.current.nextCursor;
          if (cursor !== null) void loadPreviousDraftPage(cursor);
        },
        onFirst: () => void loadPreviousDraftPage(null),
        onBack: () => releasePreviousSelection(true),
        onClose: () => releasePreviousSelection(false),
      } : null,
      comparison: previousOwnerVisible && previousComparisonPreview ? {
        photoName: previousComparisonPreview.photoName,
        loading: previousComparisonPreview.loading,
        candidateFrame: previousComparisonPreview.candidateFrame,
        currentFrame: previousComparisonPreview.currentFrame,
        candidateReason: previousComparisonPreview.candidateReason,
        currentReason: previousComparisonPreview.currentReason,
        canAdopt: previousComparison !== null &&
          previousComparisonPreview.comparison.choice === previousComparison.choice &&
          previousComparisonPreview.candidateFrame !== null && previousComparisonPreview.currentFrame !== null &&
          previousComparison.canAdopt,
        busy: previousDrafts.busy,
        onAdopt: () => void resolvePreviousConflict("adopt"),
        onKeepCurrent: () => void resolvePreviousConflict("keep-current"),
        onSaveData: previousSnapshot?.latest || previousSnapshot?.attempted
          ? () => void savePreviousDraftData()
          : null,
        onClose: closePreviousComparison,
      } : null,
    },
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
