"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AlertCircle, Check, ChevronLeft, CloudUpload, Ellipsis, FolderOpen, ImageUp, Images, Moon, Plus, RefreshCw, Users, X } from "lucide-react";

import { appDialog } from "niho-ui/app-dialog";
import { cn } from "niho-ui/cn";
import { Popover, PopoverContent, PopoverTrigger } from "niho-ui/components/popover";
import { Skeleton } from "niho-ui/components/skeleton";
import { Spinner } from "niho-ui/components/spinner";

import { PHOTO_SHARED_ALBUM_COPY } from "../photo-editing-copy";
import { usePhotoFileDropZone, type PhotoFileDropZoneState } from "../use-photo-file-drop-zone";
import {
  PHOTO_EDITING_DANGER_GHOST_BUTTON_CLASS_NAME,
  PHOTO_EDITING_EMPTY_STATE_BUTTON_CLASS_NAME,
  PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME,
} from "../editor/photo-editing-button-classes";
import { PhotoEditingTileImage } from "../editor/photo-editing-grid";

import {
  photoSharedAlbumCanAdd,
  photoSharedAlbumCanRemoveItem,
  photoSharedAlbumItemLabel,
  photoSharedAlbumItemReplaceable,
  photoSharedAlbumItemSavable,
  photoSharedAlbumItemPause,
  photoSharedAlbumItemStatus,
  photoSharedAlbumNotice,
  photoSharedAlbumPersonLabel,
  photoSharedAlbumRoleLabel,
  visiblePhotoSharedAlbumItems,
  type PhotoSharedAlbumRole,
  type PhotoSharedAlbum,
  type PhotoSharedAlbumItem,
  type PhotoSharedAlbumNotice,
  type PhotoSharedAlbumUpload,
} from "./photo-shared-album-model";
import { PhotoSharedAlbumUploadPanel } from "./photo-shared-album-upload-panel";

/** 見出しの行の主ボタン（追加・保存）。見た目は 36px、押せる範囲は 44px。 */
const HEADER_PRIMARY_BUTTON_CLASS_NAME =
  "niho-primary-surface relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-sub font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']";
/** 見出しの行のアイコンだけのボタン（戻る・共有・選択を終了）。44px の正方形。 */
const HEADER_ICON_BUTTON_CLASS_NAME =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-niho-text transition hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink";
/** 見出しの行の字だけのボタン（選択）。 */
const HEADER_TEXT_BUTTON_CLASS_NAME =
  "inline-flex h-11 shrink-0 items-center rounded-full px-3 text-sub font-bold text-niho-accent-ink transition hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink";
/** 写真の上に載せる札（明るい写真・暗い写真のどちらでも読めるよう、黒の半透明の地に白字）。 */
const ON_PHOTO_BADGE_CLASS_NAME =
  "inline-flex max-w-full items-center gap-1 rounded-full bg-black/65 px-2 py-0.5 text-xs font-bold leading-5 text-white shadow-sm";
const LOADING_TILE_COUNT = 12;
/** 見出しのメニューの 1 行（44px）。 */
const MENU_ITEM_CLASS_NAME =
  "flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sub font-bold text-niho-text transition hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink";

export interface PhotoSharedAlbumViewProps {
  readonly album: PhotoSharedAlbum;
  readonly items: readonly PhotoSharedAlbumItem[];
  /** 項目ごとの追加の進捗（無ければ出さない） */
  readonly uploads: readonly PhotoSharedAlbumUpload[];
  /** 初めて追加するときだけ「元データはこの端末に残ります」を出す（出したことは接続側が覚える） */
  readonly showOriginalsNote: boolean;
  /** 最初の一覧を読んでいる */
  readonly loading?: boolean;
  /** 「保存」の文言（iPhone で写真ライブラリに入るときは「写真に保存」など。既定は「保存」） */
  readonly saveLabel?: string;
  /** 一覧（共有アルバム）へ戻る。無ければ戻るボタンを出さない */
  readonly onBack?: () => void;
  /** 「共有」シートを開く */
  readonly onOpenShare: () => void;
  /** 選んだ・落としたファイルをそのまま足す（確認画面を挟まない） */
  readonly onAddFiles: (files: readonly File[]) => void;
  /** 本人の「写真」から選んで足す（Mac アプリなど。無ければ「追加」はファイルを選ぶだけにする） */
  readonly onAddFromLibrary?: () => void;
  /** 選んだ完成写真を端末に保存する */
  readonly onSave: (itemIds: readonly string[]) => void;
  /** 選んだ項目をアルバムから外す（外せる項目だけを選んでいるときに出す）。失敗は reject */
  readonly onRemove?: (itemIds: readonly string[]) => Promise<void>;
  /** 自分が足した完成写真を、選び直した JPEG に差し替える。無ければ選択中の「その他」を出さない */
  readonly onReplace?: (itemId: string, file: File) => void;
  /** 1 枚を大きく見る。無ければ、タイルを押すと選択を始める */
  readonly onOpenItem?: (itemId: string) => void;
  readonly onRetryUpload: (uploadId: string) => void;
  readonly onDismissUploads: () => void;
  /** 容量不足のときのオーナーの次の操作（保存先の設定などを開く） */
  readonly onOpenStorage?: () => void;
}

/**
 * 共有アルバムを開いた画面（B08 #249）。写真のグリッドが主役で、主操作は「追加」、選択すると「保存」。新しく足された写真には追加者の
 * 名前を載せる。見るだけのメンバーには「追加」を出さず、ドロップも受けない。状態はできないときだけ 1 行で出す（Epic §12）。
 * 通信は持たず、操作は callback で接続側へ渡す。
 */
export function PhotoSharedAlbumView(props: PhotoSharedAlbumViewProps) {
  const { album } = props;
  const items = useMemo(() => visiblePhotoSharedAlbumItems(props.items, album.role), [props.items, album.role]);
  const canAdd = photoSharedAlbumCanAdd(album);
  const full = album.capacity.state === "full";
  const notice = photoSharedAlbumNotice(album, items);
  const uploading = props.uploads.some((upload) => upload.phase === "waiting" || upload.phase === "sending" || upload.phase === "checking");

  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  // 差し替えのファイルを選んでいる項目（選択画面が閉じてから届くので、選んだ時点の項目を覚える）
  const replaceTargetRef = useRef<{ readonly albumId: string; readonly itemId: string } | null>(null);
  const selectButtonRef = useRef<HTMLButtonElement | null>(null);
  const endSelectionButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusAfterModeChangeRef = useRef(false);
  // 外す処理の世代。アルバムが替わった・画面を閉じたら null にし、前のアルバムの結果を今のアルバムへ反映しない
  const removeTokenRef = useRef<object | null>(null);
  const albumIdRef = useRef(album.albumId);
  albumIdRef.current = album.albumId;

  // アルバムが替わったら選択・知らせ・外す途中の状態を捨てる（別のアルバムの選択で保存・削除しない）
  useEffect(() => {
    removeTokenRef.current = null;
    setSelecting(false);
    setSelected(new Set());
    setMessage(null);
    setRemoving(false);
  }, [album.albumId]);

  useEffect(() => () => {
    removeTokenRef.current = null;
  }, []);

  // 見えなくなった・保存できなくなった項目は選択から外す
  useEffect(() => {
    setSelected((current) => {
      const allowed = new Set(items.filter(photoSharedAlbumItemSavable).map((item) => item.itemId));
      const next = new Set([...current].filter((itemId) => allowed.has(itemId)));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  // 解除後は選択を終える
  useEffect(() => {
    if (album.accessEnded) setSelecting(false);
  }, [album.accessEnded]);

  // 選択の始め・終わりでボタンが入れ替わるので、入れ替わった先へフォーカスを送る
  useEffect(() => {
    if (!focusAfterModeChangeRef.current) return;
    focusAfterModeChangeRef.current = false;
    (selecting ? endSelectionButtonRef.current : selectButtonRef.current)?.focus();
  }, [selecting]);

  const startSelection = (itemId?: string) => {
    focusAfterModeChangeRef.current = itemId === undefined;
    setSelecting(true);
    setMessage(null);
    if (itemId !== undefined) setSelected(new Set([itemId]));
  };
  const endSelection = () => {
    focusAfterModeChangeRef.current = true;
    setSelecting(false);
    setSelected(new Set());
  };
  const toggle = (itemId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const selectedItems = items.filter((item) => selected.has(item.itemId));
  const replaceable = props.onReplace !== undefined && selectedItems.length === 1 && photoSharedAlbumItemReplaceable(selectedItems[0] as PhotoSharedAlbumItem, album)
    ? (selectedItems[0] as PhotoSharedAlbumItem)
    : null;
  const chooseReplacement = () => {
    if (replaceable === null) return;
    replaceTargetRef.current = { albumId: album.albumId, itemId: replaceable.itemId };
    replaceInputRef.current?.click();
  };
  const onReplacementChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    const target = replaceTargetRef.current;
    replaceTargetRef.current = null;
    // 選んでいる間に別のアルバムを開いたら、前のアルバムの項目を差し替えない
    if (file === null || target === null || target.albumId !== albumIdRef.current || !props.onReplace) return;
    props.onReplace(target.itemId, file);
    setSelecting(false);
    setSelected(new Set());
  };
  const canRemoveSelection = props.onRemove !== undefined
    && selectedItems.length > 0
    && selectedItems.every((item) => photoSharedAlbumCanRemoveItem(album.role, item));

  const remove = async () => {
    const onRemove = props.onRemove;
    if (!onRemove || removing || selectedItems.length === 0) return;
    const albumId = album.albumId;
    const itemIds = selectedItems.map((item) => item.itemId);
    const confirmed = await appDialog.confirm({
      title: PHOTO_SHARED_ALBUM_COPY.removeTitle(itemIds.length),
      description: PHOTO_SHARED_ALBUM_COPY.removeDescription,
      confirmLabel: PHOTO_SHARED_ALBUM_COPY.removeConfirm,
      variant: "danger",
    });
    // 確かめている間にアルバムが替わったら、前のアルバムの項目を外さない
    if (!confirmed || albumIdRef.current !== albumId) return;
    const token = {};
    removeTokenRef.current = token;
    setRemoving(true);
    setMessage(null);
    let failed = false;
    try {
      await onRemove(itemIds);
    } catch {
      failed = true;
    }
    if (removeTokenRef.current !== token) return;
    removeTokenRef.current = null;
    setRemoving(false);
    if (failed) {
      setMessage(PHOTO_SHARED_ALBUM_COPY.actionFailed);
      return;
    }
    setSelecting(false);
    setSelected(new Set());
  };

  const chooseFiles = () => fileInputRef.current?.click();
  const onFilesChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    // 同じファイルをもう一度選べるように空にする
    event.currentTarget.value = "";
    if (files.length > 0) props.onAddFiles(files);
  };

  // 見るだけ・解除後・選択中（保存の操作と混ぜない）はドロップを受けない（ページを離れないようにだけする）
  const dropZone: PhotoFileDropZoneState | null = !canAdd || selecting
    ? null
    : full
      ? { kind: "reject", reason: PHOTO_SHARED_ALBUM_COPY.albumFull }
      : { kind: "accept", queued: uploading };
  const { overlay, zoneProps } = usePhotoFileDropZone({
    enabled: true,
    zone: dropZone,
    captureDropContext: () => albumIdRef.current,
    onDropFiles: (dropped, droppedAlbumId) => {
      // Directory enumeration is async. Discard a drop if the user opened a different album while it was being read.
      if (droppedAlbumId !== albumIdRef.current) return;
      if (dropped.photos.length > 0) props.onAddFiles(dropped.photos);
    },
  });

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && selecting && !event.defaultPrevented) {
      event.preventDefault();
      endSelection();
    }
  };

  const addAvailable = canAdd && !full && !selecting;

  if (notice?.kind === "accessEnded") {
    // 解除後はアルバム名・手元に残った縮小画像・追加の進捗も出さず、理由と戻り先だけにする（追加中の写真は確定しない）
    return (
      <section
        aria-labelledby={`photo-shared-album-title-${album.albumId}`}
        {...zoneProps}
        className="relative flex h-full min-h-0 min-w-0 flex-col bg-[var(--photo-editing-surface,white)] text-niho-text"
      >
        <header className="flex min-h-14 shrink-0 items-center px-1.5 py-1.5 sm:px-3">
          {props.onBack ? (
            <button type="button" aria-label={PHOTO_SHARED_ALBUM_COPY.back} onClick={props.onBack} className={HEADER_ICON_BUTTON_CLASS_NAME}>
              <ChevronLeft className="h-6 w-6" aria-hidden />
            </button>
          ) : null}
        </header>
        <div role="alert" className="flex min-h-[240px] flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          <h1 id={`photo-shared-album-title-${album.albumId}`} className="text-body font-bold text-niho-text">
            {notice.text}
          </h1>
          {props.onBack ? (
            <button type="button" onClick={props.onBack} className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "h-11 px-5")}>
              {notice.actionLabel}
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section
      aria-labelledby={`photo-shared-album-title-${album.albumId}`}
      onKeyDown={onKeyDown}
      {...zoneProps}
      className="relative flex h-full min-h-0 min-w-0 flex-col bg-[var(--photo-editing-surface,white)] text-niho-text"
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        tabIndex={-1}
        aria-hidden
        onChange={onFilesChosen}
      />
      <input
        ref={replaceInputRef}
        type="file"
        accept="image/jpeg"
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={onReplacementChosen}
      />
      <header className="sticky top-0 z-10 flex min-h-14 shrink-0 flex-wrap items-center gap-1 border-b border-niho-border bg-[var(--photo-editing-surface,white)] px-1.5 py-1.5 sm:px-3">
        {selecting ? (
          <>
            <button
              ref={endSelectionButtonRef}
              type="button"
              aria-label={PHOTO_SHARED_ALBUM_COPY.endSelection}
              onClick={endSelection}
              className={HEADER_ICON_BUTTON_CLASS_NAME}
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
            {/* With every selection action in the row, 400px 未満 puts the count on its own line (like the album name) */}
            {replaceable ? <span aria-hidden className="flex-1 min-[400px]:hidden" /> : null}
            <h1
              id={`photo-shared-album-title-${album.albumId}`}
              className={cn(
                "min-w-0 truncate px-1 text-body font-bold",
                replaceable ? "order-last w-full px-3 pb-1 min-[400px]:order-none min-[400px]:w-auto min-[400px]:flex-1 min-[400px]:px-1 min-[400px]:pb-0" : "flex-1",
              )}
            >
              <span className="sr-only">{album.name}、</span>
              <span aria-live="polite">
                {selected.size > 0 ? PHOTO_SHARED_ALBUM_COPY.selectedCount(selected.size) : PHOTO_SHARED_ALBUM_COPY.selectPrompt}
              </span>
            </h1>
            {replaceable ? <PhotoSharedAlbumMoreButton disabled={removing} onReplace={chooseReplacement} /> : null}
            {canRemoveSelection ? (
              <button
                type="button"
                disabled={removing}
                onClick={() => void remove()}
                className={cn(PHOTO_EDITING_DANGER_GHOST_BUTTON_CLASS_NAME, "h-11")}
              >
                {PHOTO_SHARED_ALBUM_COPY.remove}
              </button>
            ) : null}
            <button
              type="button"
              disabled={selectedItems.length === 0 || removing}
              onClick={() => props.onSave(selectedItems.map((item) => item.itemId))}
              className={HEADER_PRIMARY_BUTTON_CLASS_NAME}
            >
              {props.saveLabel ?? PHOTO_SHARED_ALBUM_COPY.save}
            </button>
          </>
        ) : (
          <>
            {props.onBack ? (
              <button
                type="button"
                aria-label={PHOTO_SHARED_ALBUM_COPY.back}
                onClick={props.onBack}
                className={HEADER_ICON_BUTTON_CLASS_NAME}
              >
                <ChevronLeft className="h-6 w-6" aria-hidden />
              </button>
            ) : (
              <span aria-hidden className="w-2 shrink-0" />
            )}
            {/* 400px 未満は名前を操作の下の行に置き、長い日本語の名前にも幅を使う */}
            <span aria-hidden className="flex-1 min-[400px]:hidden" />
            <div className="order-last w-full min-w-0 px-3 pb-1 min-[400px]:order-none min-[400px]:w-auto min-[400px]:flex-1 min-[400px]:px-1 min-[400px]:pb-0">
              <h1
                id={`photo-shared-album-title-${album.albumId}`}
                title={album.name}
                className="line-clamp-2 break-words text-body font-bold leading-snug"
              >
                {album.name}
              </h1>
              {album.role !== "owner" ? (
                <p className="truncate text-xs font-bold text-niho-text-muted">{photoSharedAlbumRoleLabel(album.role)}</p>
              ) : null}
            </div>
            {items.some(photoSharedAlbumItemSavable) ? (
              <button ref={selectButtonRef} type="button" onClick={() => startSelection()} className={HEADER_TEXT_BUTTON_CLASS_NAME}>
                {PHOTO_SHARED_ALBUM_COPY.select}
              </button>
            ) : null}
            <button
              type="button"
              aria-label={album.role === "owner" ? PHOTO_SHARED_ALBUM_COPY.share : PHOTO_SHARED_ALBUM_COPY.members}
              title={album.role === "owner" ? PHOTO_SHARED_ALBUM_COPY.share : PHOTO_SHARED_ALBUM_COPY.members}
              onClick={props.onOpenShare}
              className={HEADER_ICON_BUTTON_CLASS_NAME}
            >
              <Users className="h-5 w-5" aria-hidden />
            </button>
            {canAdd ? (
              <PhotoSharedAlbumAddButton
                disabled={!addAvailable}
                onChooseFiles={chooseFiles}
                onAddFromLibrary={props.onAddFromLibrary}
              />
            ) : null}
          </>
        )}
      </header>

      {notice ? <PhotoSharedAlbumNoticeBar notice={notice} onAction={notice.kind === "full" ? props.onOpenStorage : undefined} /> : null}
      {message ? (
        <p role="alert" className="shrink-0 px-4 py-2 text-sub font-bold text-niho-danger">
          {message}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
        {props.loading ? (
          <ul aria-hidden className="grid grid-cols-3 gap-0.5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
            {Array.from({ length: LOADING_TILE_COUNT }, (_, index) => (
              <li key={index}>
                <Skeleton className="aspect-square rounded-none" />
              </li>
            ))}
          </ul>
        ) : items.length === 0 ? (
          <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-4 p-6 text-center">
            {canAdd && !full ? (
              <button type="button" onClick={props.onAddFromLibrary ?? chooseFiles} className={PHOTO_EDITING_EMPTY_STATE_BUTTON_CLASS_NAME}>
                <Plus className="h-4 w-4" aria-hidden />
                {props.onAddFromLibrary ? PHOTO_SHARED_ALBUM_COPY.addFromLibrary : PHOTO_SHARED_ALBUM_COPY.add}
              </button>
            ) : (
              <p className="text-sub font-bold text-niho-text-muted">{PHOTO_SHARED_ALBUM_COPY.empty}</p>
            )}
            {canAdd && !full && props.onAddFromLibrary ? (
              <button type="button" onClick={chooseFiles} className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "h-11 px-4")}>
                {PHOTO_SHARED_ALBUM_COPY.addFromFiles}
              </button>
            ) : null}
          </div>
        ) : (
          <ul
            aria-label={album.name}
            className="grid select-none grid-cols-3 gap-0.5 pb-[env(safe-area-inset-bottom,0px)] sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6"
          >
            {items.map((item, index) => (
              <PhotoSharedAlbumTile
                key={item.itemId}
                item={item}
                label={photoSharedAlbumItemLabel(item, { index, total: items.length }, album.role)}
                role={album.role}
                selecting={selecting}
                selected={selected.has(item.itemId)}
                onPress={() => {
                  const savable = photoSharedAlbumItemSavable(item);
                  if (selecting) {
                    if (savable) toggle(item.itemId);
                    return;
                  }
                  if (props.onOpenItem && savable) props.onOpenItem(item.itemId);
                  else if (savable) startSelection(item.itemId);
                }}
              />
            ))}
          </ul>
        )}
      </div>

      {props.uploads.length > 0 ? (
        <PhotoSharedAlbumUploadPanel
          uploads={props.uploads}
          showOriginalsNote={props.showOriginalsNote}
          onRetry={props.onRetryUpload}
          onDismiss={props.onDismissUploads}
        />
      ) : null}

      {overlay ? <PhotoSharedAlbumDropOverlay state={overlay} /> : null}
    </section>
  );
}

/** 選択中の「その他」。今は 1 枚の自分の完成写真の「差し替え」だけ（出せる操作が無いときはボタンごと出さない）。 */
function PhotoSharedAlbumMoreButton(props: { disabled: boolean; onReplace: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" disabled={props.disabled} aria-haspopup="menu" aria-label={PHOTO_SHARED_ALBUM_COPY.more} className={HEADER_ICON_BUTTON_CLASS_NAME}>
          <Ellipsis className="h-5 w-5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1.5">
        <div role="menu" aria-label={PHOTO_SHARED_ALBUM_COPY.more} className="flex flex-col">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              // iPhone Safari はユーザーの操作の中でしか選択の画面を開かないので、閉じる前に開く
              props.onReplace();
              setOpen(false);
            }}
            className={MENU_ITEM_CLASS_NAME}
          >
            <ImageUp className="h-4 w-4 shrink-0 text-niho-text-sub" aria-hidden />
            {PHOTO_SHARED_ALBUM_COPY.replace}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** 「追加」。本人の「写真」から選べるときだけ 2 つの出どころのメニューにし、そうでなければファイルを選ぶだけにする。 */
function PhotoSharedAlbumAddButton(props: {
  disabled: boolean;
  onChooseFiles: () => void;
  onAddFromLibrary?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const label = (
    <>
      <Plus className="h-4 w-4" aria-hidden />
      {PHOTO_SHARED_ALBUM_COPY.add}
    </>
  );
  if (!props.onAddFromLibrary) {
    return (
      <button type="button" disabled={props.disabled} onClick={props.onChooseFiles} className={HEADER_PRIMARY_BUTTON_CLASS_NAME}>
        {label}
      </button>
    );
  }
  const onAddFromLibrary = props.onAddFromLibrary;
  const itemClassName = MENU_ITEM_CLASS_NAME;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" disabled={props.disabled} aria-haspopup="menu" className={HEADER_PRIMARY_BUTTON_CLASS_NAME}>
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1.5">
        <div role="menu" aria-label={PHOTO_SHARED_ALBUM_COPY.add} className="flex flex-col">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onAddFromLibrary();
            }}
            className={itemClassName}
          >
            <Images className="h-4 w-4 shrink-0 text-niho-text-sub" aria-hidden />
            {PHOTO_SHARED_ALBUM_COPY.addFromLibrary}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              // iPhone Safari はユーザーの操作の中でしか選択の画面を開かないので、閉じる前に開く
              props.onChooseFiles();
              setOpen(false);
            }}
            className={itemClassName}
          >
            <FolderOpen className="h-4 w-4 shrink-0 text-niho-text-sub" aria-hidden />
            {PHOTO_SHARED_ALBUM_COPY.addFromFiles}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PhotoSharedAlbumTile(props: {
  item: PhotoSharedAlbumItem;
  label: string;
  role: PhotoSharedAlbumRole;
  selecting: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  const { item } = props;
  const savable = photoSharedAlbumItemSavable(item);
  // タイルの字は短く（準備中・更新待ち）し、起動を待っているときは月、容量不足で止めたときは注意の印で示す（全文は読み上げ名と
  // アルバムの 1 行にある）。準備中のまま止めた項目だけは「準備中」と誤らないよう理由を出す
  const pause = photoSharedAlbumItemPause(item);
  const shortStatus = item.state === "preparing" || item.state === "updatePending" ? PHOTO_SHARED_ALBUM_COPY.itemStates[item.state] : null;
  const preparing = item.state === "preparing";
  const preparingText = pause === "quota" ? photoSharedAlbumItemStatus(item, props.role) : shortStatus;
  const PauseIcon = pause === "waiting" ? Moon : pause === "quota" ? AlertCircle : null;
  // 自分が足した写真には追加者の札を付けない（新着の印は他の人が足した写真を見分けるため）
  const showAdder = item.isNew && !preparing && !item.addedBy.isSelf;
  return (
    <li className="relative min-w-0">
      <button
        type="button"
        aria-label={props.label}
        aria-pressed={props.selecting && savable ? props.selected : undefined}
        aria-disabled={props.selecting && !savable ? true : undefined}
        onClick={props.onPress}
        className={cn(
          "group relative block aspect-square w-full overflow-hidden bg-niho-surface-warm focus-visible:outline-none",
          "after:pointer-events-none after:absolute after:inset-0 after:content-[''] focus-visible:after:shadow-[inset_0_0_0_3px_var(--niho-accent-ink)]",
          props.selecting && !savable && "cursor-not-allowed",
        )}
      >
        {item.thumbnailUrl ? (
          <PhotoEditingTileImage key={item.thumbnailUrl} url={item.thumbnailUrl} geometry={null} cellAspect={1} />
        ) : null}
        {props.selected ? <span aria-hidden className="absolute inset-0 bg-white/25 ring-4 ring-inset ring-niho-accent-ink" /> : null}
        {preparing ? (
          <span aria-hidden className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/45 px-2 text-center">
            {PauseIcon ? <PauseIcon className="h-5 w-5 text-white" strokeWidth={1.75} /> : <Spinner size="sm" tone="onColor" />}
            <span className="text-xs font-bold leading-tight text-white">{preparingText}</span>
          </span>
        ) : null}
        {item.state === "updatePending" && !props.selecting ? (
          <span aria-hidden className={cn(ON_PHOTO_BADGE_CLASS_NAME, "absolute left-1.5 top-1.5 max-w-[calc(100%-0.75rem)]")}>
            {PauseIcon ? (
              <PauseIcon className="h-3 w-3 shrink-0" strokeWidth={2.5} />
            ) : (
              <RefreshCw className="h-3 w-3 shrink-0" strokeWidth={2.5} />
            )}
            <span className="truncate">{shortStatus}</span>
          </span>
        ) : null}
        {showAdder ? (
          <span aria-hidden className={cn(ON_PHOTO_BADGE_CLASS_NAME, "absolute bottom-1.5 left-1.5 max-w-[calc(100%-0.75rem)]")}>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-niho" />
            <span className="truncate">{photoSharedAlbumPersonLabel(item.addedBy)}</span>
          </span>
        ) : null}
        {props.selecting && savable ? (
          <span
            aria-hidden
            className={cn(
              "absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full shadow-sm",
              props.selected ? "niho-accent-surface" : "border-2 border-white bg-black/25",
            )}
          >
            {props.selected ? <Check className="h-4 w-4" strokeWidth={3} /> : null}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function PhotoSharedAlbumNoticeBar(props: { notice: Exclude<PhotoSharedAlbumNotice, { kind: "accessEnded" }>; onAction?: () => void }) {
  const { notice } = props;
  const problem = notice.kind === "full";
  const actionLabel = notice.kind === "full" ? notice.actionLabel : null;
  return (
    <div
      role={problem ? "alert" : "status"}
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-niho-border px-4 py-2",
        problem ? "bg-niho-orange-pale" : "bg-niho-surface-subtle",
      )}
    >
      {notice.kind === "waiting" ? <Moon className="h-4 w-4 shrink-0 text-niho-text-sub" aria-hidden /> : null}
      <p className={cn("min-w-0 flex-1 text-sub font-bold", problem ? "text-niho-text" : "text-niho-text-sub")}>{notice.text}</p>
      {notice.kind === "preparing" ? (
        <span aria-hidden className="block h-1 w-full overflow-hidden rounded-full bg-niho-border">
          <span
            className="block h-full rounded-full bg-niho-accent-ink motion-safe:transition-[width]"
            style={{ width: `${Math.round(notice.fraction * 100)}%` }}
          />
        </span>
      ) : null}
      {actionLabel && props.onAction ? (
        <button type="button" onClick={props.onAction} className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "h-9")}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

/** 写真をドラッグしている間の幕（押せるものは置かず、読み上げない。落とした結果は進捗が伝える）。 */
function PhotoSharedAlbumDropOverlay(props: { state: PhotoFileDropZoneState }) {
  const accept = props.state.kind === "accept";
  return (
    <div aria-hidden data-testid="photo-shared-album-drop-overlay" className="pointer-events-none absolute inset-0 z-20 flex p-3">
      <div
        className={cn(
          "flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 text-center",
          accept
            ? "border-niho-accent-ink bg-niho-accent-soft/90 text-niho-accent-ink"
            : "border-niho-text-muted/60 bg-white/85 text-niho-text-muted",
        )}
      >
        <CloudUpload className="h-10 w-10" strokeWidth={1.5} />
        <p className="text-body font-bold">{props.state.kind === "accept" ? PHOTO_SHARED_ALBUM_COPY.dropHeadline : props.state.reason}</p>
      </div>
    </div>
  );
}
