"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { appDialog } from "niho-ui/app-dialog";
import { Spinner } from "niho-ui/components/spinner";

import { PHOTO_SHARED_ALBUM_COPY, PHOTO_SHARED_ALBUM_INVITE_COPY, PHOTO_SHARED_ALBUM_UPLOAD_COPY } from "../photo-editing-copy";
import { PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME } from "../editor/photo-editing-button-classes";

import { PhotoSharedAlbumInvite } from "./photo-shared-album-invite";
import { PhotoSharedAlbumLibraryPicker } from "./photo-shared-album-library-picker";
import { PhotoSharedAlbumList } from "./photo-shared-album-list";
import type {
  PhotoSharedAlbum,
  PhotoSharedAlbumMemberRole,
  PhotoSharedAlbumSummary,
  PhotoSharedAlbumUpload,
} from "./photo-shared-album-model";
import type {
  PhotoSharedAlbumJoinResult,
  PhotoSharedAlbumOpened,
  PhotoSharedAlbumOpenedInvite,
  PhotoSharedAlbumPeople,
  PhotoSharedAlbumPort,
} from "./photo-shared-album-port";
import { PhotoSharedAlbumShareSheet } from "./photo-shared-album-share-sheet";
import { PhotoSharedAlbumView } from "./photo-shared-album-view";

const ALBUM_NAME_MAX_CODE_POINTS = 100;

export interface PhotoSharedAlbumWorkspaceProps {
  /** 本人・scope ごとの口。変わったら親が `key` で作り直す */
  readonly port: PhotoSharedAlbumPort;
  /** 開いた招待（リンクの secret はメモリだけ）。1 回だけ参加に使う */
  readonly invite?: PhotoSharedAlbumOpenedInvite | null;
  /** 招待を使い終えた（親は secret・預かりの印を捨てる） */
  readonly onInviteHandled?: () => void;
  /** 「保存」の文言（iPhone は「写真に保存」など） */
  readonly saveLabel?: string;
  /** 容量不足のときのオーナーの次の操作（設定の「保存先」を開く） */
  readonly onOpenStorage?: () => void;
  /** 有効期限のラベルの基準（テストで固定する） */
  readonly now?: () => number;
}

type Screen =
  | { readonly kind: "list" }
  | { readonly kind: "album"; readonly albumId: string }
  | { readonly kind: "joining" }
  | { readonly kind: "inviteUnavailable" }
  /** The join could not be completed now (lost answer, rate limit); the same link can be tried again. */
  | { readonly kind: "joinFailed" };

/**
 * The held invite's one request per port, kept outside any one mount: the BFF deletes what it holds on the first
 * attempt, so a re-render or an unmount and mount before the answer must not ask again. Dropped once handled.
 */
const heldJoins = new WeakMap<PhotoSharedAlbumPort, Promise<PhotoSharedAlbumJoinResult | null>>();
const PREPARATION_REFRESH_MS = 10_000;

function hasPendingPreparation(opened: PhotoSharedAlbumOpened): boolean {
  const progress = opened.album.preparing;
  return (progress !== null && progress.done < progress.total)
    || opened.items.some((item) => item.state === "preparing" || item.state === "updatePending");
}

/** An addition belongs to the album it was started in: it is shown and retried there only. */
type Pending = {
  readonly albumId: string;
  readonly upload: PhotoSharedAlbumUpload;
  readonly file: File;
  /** A replacement of this own item instead of a new addition. */
  readonly replaceItemId: string | null;
};

/**
 * 「共有アルバム」の画面（一覧・アルバム・共有シート・招待）を口につなぐ（B08 #249）。部品は通信を持たないので、読み込み・追加の
 * 進捗・再読み込み・招待の参加はここで行う。読み込み・操作の結果は、要求したときのアルバムがまだ開いているときだけ反映する。
 */
export function PhotoSharedAlbumWorkspace(props: PhotoSharedAlbumWorkspaceProps) {
  const { port } = props;
  const now = props.now ?? Date.now;
  const [screen, setScreen] = useState<Screen>(() => (props.invite ? { kind: "joining" } : { kind: "list" }));
  const [albums, setAlbums] = useState<readonly PhotoSharedAlbumSummary[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [listToken, setListToken] = useState(0);
  const [opened, setOpened] = useState<PhotoSharedAlbumOpened | null>(null);
  const [albumFailed, setAlbumFailed] = useState(false);
  const [albumToken, setAlbumToken] = useState(0);
  const [shareOpen, setShareOpen] = useState(false);
  const [people, setPeople] = useState<PhotoSharedAlbumPeople | null>(null);
  const [peopleToken, setPeopleToken] = useState(0);
  const [uploads, setUploads] = useState<readonly Pending[]>([]);
  const [saveFailure, setSaveFailure] = useState<{ readonly albumId: string; readonly itemIds: readonly string[] } | null>(null);
  const [pickerAlbum, setPickerAlbum] = useState<string | null>(null);
  const [libraryAddFailure, setLibraryAddFailure] = useState<{ readonly albumId: string; readonly photoIds: readonly string[] } | null>(null);
  const [joinAttempt, setJoinAttempt] = useState(0);
  const [originalsNote, setOriginalsNote] = useState(() => !port.originalsNoteShown());
  const lifetime = useRef(new AbortController());
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const albumId = screen.kind === "album" ? screen.albumId : null;
  const albumIdRef = useRef(albumId);
  albumIdRef.current = albumId;

  useEffect(() => {
    // Created here (not only in the ref) so a development remount does not leave an aborted lifetime behind.
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  // 招待: 開いたら参加し、そのアルバムを開く（secret はこの呼び出しの中だけで使う）
  const inviteSecret = props.invite?.kind === "link" ? props.invite.secret : null;
  const inviteHeld = props.invite?.kind === "held";
  const onInviteHandledRef = useRef(props.onInviteHandled);
  onInviteHandledRef.current = props.onInviteHandled;
  const settledSecretRef = useRef<string | null>(null);
  useEffect(() => {
    if (!inviteHeld) return;
    let pending = heldJoins.get(port);
    if (pending === undefined) {
      // Never aborted by a re-render or a remount: asking twice would find the held invite already gone.
      pending = port.joinHeld(new AbortController().signal).catch(() => null);
      heldJoins.set(port, pending);
    }
    let current = true;
    setScreen({ kind: "joining" });
    void pending.then((result) => {
      if (!current) return;
      heldJoins.delete(port);
      if (result === null) {
        // The answer was lost and the cookie is gone either way: read the albums again.
        setScreen({ kind: "list" });
        setListToken((token) => token + 1);
      } else {
        setScreen(result.kind === "joined" ? { kind: "album", albumId: result.albumId } : { kind: "inviteUnavailable" });
      }
      onInviteHandledRef.current?.();
    });
    return () => {
      current = false;
    };
  }, [inviteHeld, port]);
  useEffect(() => {
    // One settled join per secret. An effect that is cleaned up before its answer (a re-render or a development
    // remount) aborts and the next run joins again; the secret is handed back only after a definite answer.
    if (!inviteSecret || settledSecretRef.current === inviteSecret) return;
    const controller = new AbortController();
    setScreen({ kind: "joining" });
    port.join(inviteSecret, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        settledSecretRef.current = inviteSecret;
        setScreen(result.kind === "joined" ? { kind: "album", albumId: result.albumId } : { kind: "inviteUnavailable" });
        onInviteHandledRef.current?.();
      },
      () => {
        // Not definite: keep the secret so the same link can be tried again.
        if (!controller.signal.aborted) setScreen({ kind: "joinFailed" });
      },
    );
    return () => controller.abort();
  }, [inviteSecret, port, joinAttempt]);

  // 一覧
  useEffect(() => {
    if (screen.kind !== "list") return;
    const controller = new AbortController();
    setListFailed(false);
    port.listAlbums(controller.signal).then(
      (next) => {
        if (!controller.signal.aborted) setAlbums(next);
      },
      () => {
        if (!controller.signal.aborted) setListFailed(true);
      },
    );
    return () => controller.abort();
  }, [port, screen.kind, listToken]);

  // 開いているアルバム
  const openedRef = useRef(opened);
  openedRef.current = opened;
  useEffect(() => {
    if (albumId === null) return;
    const controller = new AbortController();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setAlbumFailed(false);
    const load = async (): Promise<void> => {
      try {
        const next = await port.openAlbum(albumId, controller.signal);
        if (controller.signal.aborted) return;
        if (next) {
          setOpened(next);
          if (hasPendingPreparation(next)) {
            refreshTimer = setTimeout(() => { void load(); }, PREPARATION_REFRESH_MS);
          }
          return;
        }
        // 見られなくなった: 直前の表示に解除を載せる（追加中の写真は確定しない）
        setOpened((previous) => (previous && previous.album.albumId === albumId
          ? { ...previous, album: { ...previous.album, accessEnded: true }, items: [] }
          : null));
        setShareOpen(false);
        if (!openedRef.current || openedRef.current.album.albumId !== albumId) setScreen({ kind: "list" });
      } catch {
        if (!controller.signal.aborted) setAlbumFailed(true);
      }
    };
    void load();
    return () => {
      controller.abort();
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    };
  }, [port, albumId, albumToken]);

  // 共有シートのメンバーとリンク
  useEffect(() => {
    if (!shareOpen || albumId === null) return;
    const controller = new AbortController();
    port.people(albumId, controller.signal).then(
      (next) => {
        if (!controller.signal.aborted) setPeople(next);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [port, albumId, shareOpen, peopleToken]);

  // 追加の進捗の縮小画像（object URL）は、閉じたとき・画面を離れたときに解放する
  const uploadsRef = useRef(uploads);
  uploadsRef.current = uploads;
  useEffect(() => () => {
    for (const pending of uploadsRef.current) if (pending.upload.previewUrl) URL.revokeObjectURL(pending.upload.previewUrl);
  }, []);

  const openAlbum = useCallback((next: string) => {
    setOpened(null);
    setPeople(null);
    setShareOpen(false);
    setScreen({ kind: "album", albumId: next });
  }, []);
  const backToList = useCallback(() => {
    setOpened(null);
    setPeople(null);
    setShareOpen(false);
    setScreen({ kind: "list" });
  }, []);

  const createAlbum = useCallback(async () => {
    const name = await appDialog.prompt({
      title: PHOTO_SHARED_ALBUM_COPY.newAlbum,
      inputLabel: PHOTO_SHARED_ALBUM_COPY.albumName,
      confirmLabel: PHOTO_SHARED_ALBUM_COPY.create,
      canConfirm: (value) => value.trim().length > 0 && [...value.trim()].length <= ALBUM_NAME_MAX_CODE_POINTS,
    });
    if (name === null) return;
    try {
      openAlbum(await port.createAlbum(name.trim(), lifetime.current.signal));
    } catch {
      await appDialog.alert({ title: PHOTO_SHARED_ALBUM_COPY.actionFailed });
    }
  }, [openAlbum, port]);

  const runSave = useCallback((target: string, itemIds: readonly string[]) => {
    setSaveFailure(null);
    port.save(target, itemIds, lifetime.current.signal).then(
      (result) => {
        if (result.failed > 0 && !lifetime.current.signal.aborted) setSaveFailure({ albumId: target, itemIds });
      },
      () => {
        if (!lifetime.current.signal.aborted) setSaveFailure({ albumId: target, itemIds });
      },
    );
  }, [port]);

  /** The picked library photos become preparing items (rendered by the device that holds them); the album is read again. */
  const runLibraryAdd = useCallback((target: string, photoIds: readonly string[]) => {
    const addLibraryPhotos = port.addLibraryPhotos;
    if (!addLibraryPhotos || photoIds.length === 0) return;
    setLibraryAddFailure(null);
    const signal = lifetime.current.signal;
    addLibraryPhotos.call(port, target, photoIds, signal).then(
      (result) => {
        if (signal.aborted) return;
        // Only the photos that were not added are offered again: the others are in the album already.
        if (result.failedPhotoIds.length > 0) setLibraryAddFailure({ albumId: target, photoIds: result.failedPhotoIds });
        if (albumIdRef.current === target) setAlbumToken((token) => token + 1);
      },
      () => {
        // Not knowing which were added, nothing is sent again; the album shows what arrived.
        if (!signal.aborted && albumIdRef.current === target) setAlbumToken((token) => token + 1);
      },
    );
  }, [port]);

  const setUpload = useCallback((uploadId: string, change: Partial<PhotoSharedAlbumUpload>) => {
    setUploads((current) => current.map((pending) => (pending.upload.uploadId === uploadId ? { ...pending, upload: { ...pending.upload, ...change } } : pending)));
  }, []);

  /** 1 枚ずつ順に足す（同じアルバムへの追加の順序を保ち、端末の帯域を分け合わない）。 */
  const runUpload = useCallback((pending: Pending) => {
    const target = pending.albumId;
    queueRef.current = queueRef.current.then(async () => {
      const signal = lifetime.current.signal;
      if (signal.aborted) return;
      setUpload(pending.upload.uploadId, { phase: "sending", fraction: null, reason: null });
      try {
        const result = pending.replaceItemId === null
          ? await port.addFile(target, pending.file, signal)
          : await port.replaceFile(target, pending.replaceItemId, pending.file, signal);
        if (result.ok) {
          setUpload(pending.upload.uploadId, { phase: "added" });
          port.markOriginalsNoteShown();
        } else {
          setUpload(pending.upload.uploadId, result.reason ? { phase: "notAdded", reason: result.reason } : { phase: "failed" });
        }
      } catch {
        if (!signal.aborted) setUpload(pending.upload.uploadId, { phase: "failed" });
      }
      if (albumIdRef.current === target) setAlbumToken((token) => token + 1);
    });
  }, [port, setUpload]);

  const queueFiles = useCallback((files: readonly File[], replaceItemId: string | null) => {
    const target = albumIdRef.current;
    if (target === null || files.length === 0) return;
    const added = files.map((file, index): Pending => ({
      albumId: target,
      file,
      replaceItemId,
      upload: {
        uploadId: `upload-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
        name: file.name,
        previewUrl: file.type.startsWith("image/") && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null,
        phase: "waiting",
        fraction: null,
        reason: null,
      },
    }));
    setUploads((current) => [...current, ...added]);
    for (const pending of added) runUpload(pending);
  }, [runUpload]);
  const addFiles = useCallback((files: readonly File[]) => queueFiles(files, null), [queueFiles]);
  const replaceFile = useCallback((itemId: string, file: File) => queueFiles([file], itemId), [queueFiles]);

  const retryUpload = useCallback((uploadId: string) => {
    // Retried in the album it was started in, whichever album is open now.
    const pending = uploadsRef.current.find((entry) => entry.upload.uploadId === uploadId && entry.albumId === albumIdRef.current);
    if (!pending) return;
    setUpload(uploadId, { phase: "waiting", reason: null });
    runUpload(pending);
  }, [runUpload, setUpload]);

  const dismissUploads = useCallback(() => {
    const target = albumIdRef.current;
    setUploads((current) => {
      const keep = current.filter((pending) => pending.albumId !== target
        || pending.upload.phase === "waiting" || pending.upload.phase === "sending" || pending.upload.phase === "checking");
      for (const pending of current) if (!keep.includes(pending) && pending.upload.previewUrl) URL.revokeObjectURL(pending.upload.previewUrl);
      return keep;
    });
    if (port.originalsNoteShown()) setOriginalsNote(false);
  }, [port]);

  const album: PhotoSharedAlbum | null = opened && albumId !== null && opened.album.albumId === albumId ? opened.album : null;
  const permissions = album ? opened?.permissions ?? null : null;
  const reloadPeople = () => setPeopleToken((token) => token + 1);
  const signal = () => lifetime.current.signal;

  if (screen.kind === "joining") {
    return (
      <section className="flex h-full min-h-0 items-center justify-center gap-2 text-body font-bold text-niho-text-sub" role="status">
        <Spinner className="h-4 w-4" aria-hidden />
        {PHOTO_SHARED_ALBUM_INVITE_COPY.joining}
      </section>
    );
  }
  if (screen.kind === "inviteUnavailable") {
    return <PhotoSharedAlbumInvite phase="unavailable" onGoToAlbums={backToList} />;
  }
  if (screen.kind === "joinFailed") {
    return (
      <section className="flex h-full min-h-0 flex-col items-center justify-center gap-4 p-6 text-center">
        <p role="alert" className="text-body font-bold text-niho-text">{PHOTO_SHARED_ALBUM_INVITE_COPY.joinFailed}</p>
        <button type="button" onClick={() => setJoinAttempt((attempt) => attempt + 1)} className={`${PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME} h-11 px-5`}>
          {PHOTO_SHARED_ALBUM_INVITE_COPY.join}
        </button>
      </section>
    );
  }
  if (screen.kind === "list") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {listFailed ? <RetryLine onRetry={() => setListToken((token) => token + 1)} /> : null}
        <PhotoSharedAlbumList albums={albums ?? []} loading={albums === null && !listFailed} onOpenAlbum={openAlbum} onCreateAlbum={() => void createAlbum()} />
      </div>
    );
  }
  if (!album || !permissions) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {albumFailed ? <RetryLine onRetry={() => setAlbumToken((token) => token + 1)} /> : null}
        <PhotoSharedAlbumList albums={[]} loading={!albumFailed} onOpenAlbum={openAlbum} />
      </div>
    );
  }
  const canRemove = !album.accessEnded && (permissions.removeOwnItem || permissions.removeOthersItem);
  const target = album.albumId;
  const sheetRole = album.role;
  const failedSave = saveFailure && saveFailure.albumId === target ? saveFailure : null;
  const failedLibraryAdd = libraryAddFailure && libraryAddFailure.albumId === target ? libraryAddFailure : null;
  const canPickFromLibrary = permissions.addItem && !album.accessEnded && typeof port.libraryPhotos === "function" && typeof port.addLibraryPhotos === "function";
  return (
    <div className="flex h-full min-h-0 flex-col">
      {albumFailed ? <RetryLine onRetry={() => setAlbumToken((token) => token + 1)} /> : null}
      {failedSave ? <RetryLine onRetry={() => runSave(failedSave.albumId, failedSave.itemIds)} /> : null}
      {failedLibraryAdd ? <RetryLine onRetry={() => runLibraryAdd(failedLibraryAdd.albumId, failedLibraryAdd.photoIds)} /> : null}
      <div className="min-h-0 flex-1">
        <PhotoSharedAlbumView
          album={album}
          items={opened?.items ?? []}
          uploads={uploads.filter((pending) => pending.albumId === target).map((pending) => pending.upload)}
          showOriginalsNote={originalsNote}
          {...(props.saveLabel ? { saveLabel: props.saveLabel } : {})}
          onBack={backToList}
          onOpenShare={() => setShareOpen(true)}
          onAddFiles={permissions.addItem && !album.accessEnded ? addFiles : () => undefined}
          onSave={(itemIds) => {
            if (permissions.download) runSave(target, itemIds);
          }}
          {...(canRemove
            ? {
                onRemove: async (itemIds: readonly string[]) => {
                  const result = await port.remove(target, itemIds, signal());
                  setAlbumToken((token) => token + 1);
                  if (result.failed > 0) throw new Error("not removed");
                },
              }
            : {})}
          {...(permissions.addItem && !album.accessEnded ? { onReplace: replaceFile } : {})}
          {...(canPickFromLibrary ? { onAddFromLibrary: () => setPickerAlbum(target) } : {})}
          onRetryUpload={retryUpload}
          onDismissUploads={dismissUploads}
          {...(props.onOpenStorage ? { onOpenStorage: props.onOpenStorage } : {})}
        />
      </div>
      {canPickFromLibrary ? (
        <PhotoSharedAlbumLibraryPicker
          open={pickerAlbum === target}
          onOpenChange={(open) => setPickerAlbum(open ? target : null)}
          loadPage={(cursor, pageSignal) => (port.libraryPhotos as NonNullable<typeof port.libraryPhotos>).call(port, cursor, pageSignal)}
          onAdd={(photoIds) => runLibraryAdd(target, photoIds)}
        />
      ) : null}
      <PhotoSharedAlbumShareSheet
        key={target}
        open={shareOpen && !album.accessEnded}
        onOpenChange={setShareOpen}
        albumName={album.name}
        role={sheetRole}
        members={people?.members ?? []}
        inviteLinks={people?.inviteLinks ?? []}
        now={now()}
        onCopyLink={async (role: PhotoSharedAlbumMemberRole) => {
          const url = await port.copyInviteLink(target, role, signal());
          reloadPeople();
          return url;
        }}
        onRevokeLink={async (linkId) => {
          await port.revokeInviteLink(target, linkId, signal());
          reloadPeople();
        }}
        onChangeRole={async (memberId, role) => {
          await port.changeRole(target, memberId, role, signal());
          reloadPeople();
        }}
        onRemoveMember={async (memberId) => {
          await port.removeMember(target, memberId, signal());
          reloadPeople();
        }}
        {...(permissions.leave
          ? {
              onLeave: async () => {
                await port.leave(target, signal());
                backToList();
              },
            }
          : {})}
      />
    </div>
  );
}

function RetryLine(props: { readonly onRetry: () => void }) {
  return (
    <div role="alert" className="mx-4 mt-3 flex items-center gap-3 rounded-xl border border-niho-border bg-white px-4 py-2 text-sub font-bold text-niho-text-sub">
      <p className="min-w-0 flex-1">{PHOTO_SHARED_ALBUM_COPY.actionFailed}</p>
      <button type="button" onClick={props.onRetry} className={`${PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME} h-11 px-4`}>
        {PHOTO_SHARED_ALBUM_UPLOAD_COPY.retry}
      </button>
    </div>
  );
}
