"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { Folder, FolderPlus, Trash2 } from "lucide-react";

import { ADMIN_FIELD_CLASS } from "niho-ui/admin-field-classes";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "niho-ui/components/dialog";
import type { PhotoLibraryAlbum } from "../library/photo-library";
import { cn } from "niho-ui/cn";

import { usePhotoEditingImageCors } from "./photo-editing-image-cors";
import {
  PHOTO_EDITING_DANGER_GHOST_BUTTON_CLASS_NAME,
  PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME,
  PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME,
} from "./photo-editing-button-classes";

export const PHOTO_ALBUM_NAME_MAX_LENGTH = 60;

export function validatePhotoAlbumName(value: string): string | null {
  const length = value.trim().length;
  if (length === 0) return "アルバム名を入力してください。";
  if (length > PHOTO_ALBUM_NAME_MAX_LENGTH) return `アルバム名は ${PHOTO_ALBUM_NAME_MAX_LENGTH} 文字以内で入力してください。`;
  return null;
}

export type PhotoAlbumEditorRequest = { kind: "create" } | { kind: "edit"; album: Pick<PhotoLibraryAlbum, "id" | "name"> };

export function BrowserPhotoAlbumEditorDialog(props: {
  request: PhotoAlbumEditorRequest | null;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => Promise<PhotoLibraryAlbum>;
  onCreated?: (album: PhotoLibraryAlbum) => void;
  onRename: (albumId: string, name: string) => Promise<PhotoLibraryAlbum>;
  onDelete: (albumId: string) => Promise<void>;
}) {
  const request = props.request;
  const inputId = useId();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    setName(request?.kind === "edit" ? request.album.name : "");
    setError(null);
    setBusy(false);
    setConfirmingDelete(false);
  }, [request]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!request || busy) return;
    const validation = validatePhotoAlbumName(name);
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (request.kind === "create") {
        const album = await props.onCreate(name.trim());
        props.onCreated?.(album);
      } else {
        await props.onRename(request.album.id, name.trim());
      }
      props.onOpenChange(false);
    } catch {
      setError(request.kind === "create" ? "アルバムを作成できませんでした。" : "アルバム名を変更できませんでした。");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (request?.kind !== "edit" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onDelete(request.album.id);
      props.onOpenChange(false);
    } catch {
      setError("アルバムを削除できませんでした。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !busy && props.onOpenChange(open)}>
      <DialogContent className="w-[calc(100vw-24px)] max-w-sm rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-body font-bold text-niho-text">
            {request?.kind === "create" ? "アルバムを作成" : confirmingDelete ? "アルバムを削除" : "アルバムを編集"}
          </DialogTitle>
          {confirmingDelete ? (
            <DialogDescription className="text-sub text-niho-text-sub">
              「{request?.kind === "edit" ? request.album.name : ""}」だけを削除します。中の写真は削除されません。
            </DialogDescription>
          ) : null}
        </DialogHeader>

        {confirmingDelete ? (
          <>
            {error ? <p role="alert" className="text-sub text-niho-danger">{error}</p> : null}
            <DialogFooter className="gap-2 sm:space-x-0">
              <button type="button" disabled={busy} onClick={() => setConfirmingDelete(false)} className={PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME}>戻る</button>
              <button type="button" disabled={busy} onClick={() => void remove()} className={cn(PHOTO_EDITING_DANGER_GHOST_BUTTON_CLASS_NAME, "justify-center")}>
                <Trash2 className="h-4 w-4" aria-hidden />{busy ? "削除中…" : "アルバムを削除"}
              </button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={(event) => void submit(event)} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor={inputId} className="text-sub font-bold text-niho-text">アルバム名</label>
              <input
                id={inputId}
                value={name}
                disabled={busy}
                autoFocus
                onChange={(event) => { setName(event.target.value); setError(null); }}
                className={ADMIN_FIELD_CLASS}
              />
              <p className="text-right text-xs tabular-nums text-niho-text-muted">{name.trim().length} / {PHOTO_ALBUM_NAME_MAX_LENGTH}</p>
              {error ? <p role="alert" className="text-sub text-niho-danger">{error}</p> : null}
            </div>
            <DialogFooter className="gap-2 sm:space-x-0">
              {request?.kind === "edit" ? (
                <button type="button" disabled={busy} onClick={() => { setError(null); setConfirmingDelete(true); }} className={cn(PHOTO_EDITING_DANGER_GHOST_BUTTON_CLASS_NAME, "sm:mr-auto")}>削除</button>
              ) : null}
              <button type="button" disabled={busy} onClick={() => props.onOpenChange(false)} className={PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME}>キャンセル</button>
              <button type="submit" disabled={busy} className={PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME}>
                {busy ? "保存中…" : request?.kind === "create" ? "作成" : "名前を変更"}
              </button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function BrowserPhotoAlbumAddDialog(props: {
  open: boolean;
  albums: readonly PhotoLibraryAlbum[];
  albumsPending: boolean;
  albumsError: boolean;
  onRetryAlbums: () => void;
  selectedCount: number;
  onOpenChange: (open: boolean) => void;
  onAdd: (albumId: string) => Promise<void>;
  onCreate: (name: string) => Promise<PhotoLibraryAlbum>;
}) {
  const useCorsForPhotos = usePhotoEditingImageCors();
  const inputId = useId();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyAlbumId, setBusyAlbumId] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) {
      setCreating(false);
      setName("");
      setError(null);
      setBusyAlbumId(null);
    }
  }, [props.open]);

  const add = async (albumId: string) => {
    setBusyAlbumId(albumId);
    setError(null);
    try {
      await props.onAdd(albumId);
      props.onOpenChange(false);
    } catch {
      setError("アルバムに追加できませんでした。");
      setBusyAlbumId(null);
    }
  };
  const createAndAdd = async (event: FormEvent) => {
    event.preventDefault();
    const validation = validatePhotoAlbumName(name);
    if (validation) { setError(validation); return; }
    setBusyAlbumId("create");
    setError(null);
    let album: PhotoLibraryAlbum;
    try {
      album = await props.onCreate(name.trim());
    } catch {
      setError("アルバムを作成できませんでした。");
      setBusyAlbumId(null);
      return;
    }
    try {
      await props.onAdd(album.id);
      props.onOpenChange(false);
    } catch {
      setCreating(false);
      setError("アルバムは作成しましたが、写真を追加できませんでした。もう一度追加してください。");
      setBusyAlbumId(null);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => busyAlbumId === null && props.onOpenChange(open)}>
      <DialogContent className="w-[calc(100vw-24px)] max-w-sm rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-body font-bold text-niho-text">アルバムに追加</DialogTitle>
          <DialogDescription className="text-sub text-niho-text-sub">{props.selectedCount} 枚の写真を追加します。</DialogDescription>
        </DialogHeader>
        {creating ? (
          <form onSubmit={(event) => void createAndAdd(event)} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor={inputId} className="text-sub font-bold text-niho-text">アルバム名</label>
              <input id={inputId} value={name} disabled={busyAlbumId !== null} autoFocus onChange={(event) => { setName(event.target.value); setError(null); }} className={ADMIN_FIELD_CLASS} />
              <p className="text-right text-xs tabular-nums text-niho-text-muted">{name.trim().length} / {PHOTO_ALBUM_NAME_MAX_LENGTH}</p>
              {error ? <p role="alert" className="text-sub text-niho-danger">{error}</p> : null}
            </div>
            <DialogFooter className="gap-2 sm:space-x-0">
              <button type="button" disabled={busyAlbumId !== null} onClick={() => { setCreating(false); setError(null); }} className={PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME}>戻る</button>
              <button type="submit" disabled={busyAlbumId !== null} className={PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME}>{busyAlbumId ? "追加中…" : "作成して追加"}</button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-3">
            <div className="max-h-64 divide-y divide-niho-border overflow-y-auto rounded-xl border border-niho-border">
              {!props.albumsPending && !props.albumsError ? props.albums.map((album) => (
                <button key={album.id} type="button" disabled={busyAlbumId !== null} onClick={() => void add(album.id)} className="flex min-h-12 w-full items-center gap-3 px-3 text-left text-sub font-bold text-niho-text hover:bg-niho-pale/60 disabled:opacity-50">
                  {album.cover?.imageUrl ? (
                    // 署名付き URL の装飾的な表紙。名前は隣の文字で読み上げる。
                    <img crossOrigin={useCorsForPhotos ? "anonymous" : undefined} src={album.cover.imageUrl} alt="" className="h-9 w-9 rounded-lg object-cover" />
                  ) : <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-niho-pale/60"><Folder className="h-4 w-4" aria-hidden /></span>}
                  <span className="min-w-0 flex-1 truncate">{album.name}</span>
                  <span className="text-xs tabular-nums text-niho-text-muted">{album.photoCount} 枚</span>
                </button>
              )) : null}
              {props.albumsPending ? <p role="status" className="px-4 py-5 text-center text-sub text-niho-text-muted">アルバムを読み込み中…</p> : null}
              {props.albumsError ? (
                <div role="alert" className="space-y-1 px-4 py-4 text-center text-sub text-niho-danger">
                  <p>アルバムを読み込めませんでした。</p>
                  <button type="button" onClick={props.onRetryAlbums} className="min-h-11 font-bold underline">もう一度読み込む</button>
                </div>
              ) : null}
              {!props.albumsPending && !props.albumsError && props.albums.length === 0 ? <p className="px-4 py-5 text-center text-sub text-niho-text-muted">アルバムはまだありません。</p> : null}
            </div>
            {error ? <p role="alert" className="text-sub text-niho-danger">{error}</p> : null}
            <button type="button" disabled={busyAlbumId !== null} onClick={() => { setCreating(true); setError(null); }} className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "w-full")}>
              <FolderPlus className="h-4 w-4" aria-hidden />新しいアルバム
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
