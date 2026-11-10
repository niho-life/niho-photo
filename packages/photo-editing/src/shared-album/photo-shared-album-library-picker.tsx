"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "niho-ui/components/dialog";
import { Spinner } from "niho-ui/components/spinner";
import { cn } from "niho-ui/cn";

import { PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME } from "../editor/photo-editing-button-classes";
import { PhotoEditingTileImage } from "../editor/photo-editing-grid";
import { PHOTO_SHARED_ALBUM_COPY, PHOTO_SHARED_ALBUM_UPLOAD_COPY } from "../photo-editing-copy";

import type { PhotoSharedAlbumLibraryPage } from "./photo-shared-album-port";

const DIALOG_CLASS_NAME = [
  "flex w-[calc(100vw-1.5rem)] max-w-[720px] flex-col gap-0 overflow-hidden rounded-[24px] border border-niho-border bg-white p-0 shadow-xl focus:outline-none",
  "h-[calc(100dvh-var(--niho-safe-area-top,env(safe-area-inset-top,0px))-var(--niho-safe-area-bottom,env(safe-area-inset-bottom,0px))-24px)] max-h-[880px]",
].join(" ");
const PRIMARY_BUTTON_CLASS_NAME =
  "niho-primary-surface inline-flex h-11 shrink-0 items-center justify-center rounded-full px-5 text-sub font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * 「写真から選ぶ」（B08 #249）。本人の写真を複数選んでアルバムに足す。確認の画面は挟まず、「n枚を追加」で閉じて足す。選んだ写真は
 * 元データのある端末が描くので、アルバムでは準備中から始まる。開くたびに最初のページから読み、選択は持ち越さない。
 */
export function PhotoSharedAlbumLibraryPicker(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly loadPage: (cursor: string | null, signal: AbortSignal) => Promise<PhotoSharedAlbumLibraryPage>;
  readonly onAdd: (photoIds: readonly string[]) => void;
}) {
  const [photos, setPhotos] = useState<PhotoSharedAlbumLibraryPage["items"]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const contentRef = useRef<HTMLDivElement>(null);
  const loadRef = useRef(props.loadPage);
  loadRef.current = props.loadPage;
  // The open dialog's reads; closing (or reopening) aborts them so a late page never lands in a newer list.
  const readsRef = useRef<AbortController | null>(null);

  const load = useCallback((cursor: string | null) => {
    const controller = readsRef.current;
    if (controller === null || controller.signal.aborted) return;
    setLoading(true);
    setFailed(false);
    loadRef.current(cursor, controller.signal).then(
      (page) => {
        if (controller.signal.aborted || readsRef.current !== controller) return;
        setPhotos((current) => {
          const seen = new Set(current.map((photo) => photo.photoId));
          return [...current, ...page.items.filter((photo) => !seen.has(photo.photoId))];
        });
        setNext(page.next);
        setLoading(false);
      },
      () => {
        if (controller.signal.aborted || readsRef.current !== controller) return;
        setFailed(true);
        setLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    if (!props.open) return;
    const controller = new AbortController();
    readsRef.current = controller;
    setPhotos([]);
    setNext(null);
    setSelected([]);
    load(null);
    return () => {
      controller.abort();
      if (readsRef.current === controller) readsRef.current = null;
    };
  }, [props.open, load]);

  const toggle = (photoId: string) => {
    setSelected((current) => (current.includes(photoId) ? current.filter((id) => id !== photoId) : [...current, photoId]));
  };
  const add = () => {
    if (selected.length === 0) return;
    const photoIds = selected;
    props.onOpenChange(false);
    props.onAdd(photoIds);
  };
  const firstLoad = loading && photos.length === 0;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        ref={contentRef}
        hideClose
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        className={DIALOG_CLASS_NAME}
      >
        <DialogHeader className="flex shrink-0 flex-row items-center gap-2 space-y-0 border-b border-niho-border px-5 pb-3 pt-4 text-left">
          <DialogTitle className="min-w-0 flex-1 text-lg font-bold text-niho-text">{PHOTO_SHARED_ALBUM_COPY.addFromLibrary}</DialogTitle>
          <DialogDescription className="sr-only">{PHOTO_SHARED_ALBUM_COPY.selectPrompt}</DialogDescription>
          <button
            type="button"
            aria-label={PHOTO_SHARED_ALBUM_COPY.close}
            onClick={() => props.onOpenChange(false)}
            className="-mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-niho-text-sub transition hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {firstLoad ? (
            <div role="status" className="flex h-full min-h-40 items-center justify-center">
              <Spinner className="h-5 w-5" aria-hidden />
              <span className="sr-only">{PHOTO_SHARED_ALBUM_COPY.addFromLibrary}</span>
            </div>
          ) : photos.length === 0 && !failed ? (
            <p className="flex h-full min-h-40 items-center justify-center px-6 text-center text-body font-bold text-niho-text-sub">
              {PHOTO_SHARED_ALBUM_COPY.pickerEmpty}
            </p>
          ) : (
            <ul aria-label={PHOTO_SHARED_ALBUM_COPY.addFromLibrary} className="grid grid-cols-3 gap-0.5 sm:grid-cols-4 md:grid-cols-5">
              {photos.map((photo) => {
                const isSelected = selected.includes(photo.photoId);
                return (
                  <li key={photo.photoId} className="relative min-w-0">
                    <button
                      type="button"
                      aria-label={photo.label}
                      aria-pressed={isSelected}
                      onClick={() => toggle(photo.photoId)}
                      className={cn(
                        "relative block aspect-square w-full overflow-hidden bg-niho-surface-warm focus-visible:outline-none",
                        "after:pointer-events-none after:absolute after:inset-0 after:content-[''] focus-visible:after:shadow-[inset_0_0_0_3px_var(--niho-accent-ink)]",
                      )}
                    >
                      {photo.thumbnailUrl ? <PhotoEditingTileImage key={photo.thumbnailUrl} url={photo.thumbnailUrl} geometry={null} cellAspect={1} /> : null}
                      {isSelected ? (
                        <>
                          <span aria-hidden className="absolute inset-0 bg-white/25 ring-4 ring-inset ring-niho-accent-ink" />
                          <span aria-hidden className="niho-primary-surface absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full shadow">
                            <Check className="h-4 w-4" strokeWidth={3} />
                          </span>
                        </>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {failed ? (
            <div role="alert" className="mx-4 my-3 flex items-center gap-3 rounded-xl border border-niho-border bg-white px-4 py-2 text-sub font-bold text-niho-text-sub">
              <p className="min-w-0 flex-1">{PHOTO_SHARED_ALBUM_COPY.pickerFailed}</p>
              <button type="button" onClick={() => load(photos.length === 0 ? null : next)} className={`${PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME} h-11 px-4`}>
                {PHOTO_SHARED_ALBUM_UPLOAD_COPY.retry}
              </button>
            </div>
          ) : next !== null && photos.length > 0 ? (
            <div className="flex justify-center py-3">
              <button type="button" disabled={loading} onClick={() => load(next)} className={`${PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME} h-11 px-5`}>
                {loading ? <Spinner className="h-4 w-4" aria-hidden /> : null}
                {PHOTO_SHARED_ALBUM_COPY.pickerMore}
              </button>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-niho-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]">
          <button type="button" disabled={selected.length === 0} onClick={add} className={PRIMARY_BUTTON_CLASS_NAME}>
            {selected.length === 0 ? PHOTO_SHARED_ALBUM_COPY.add : PHOTO_SHARED_ALBUM_COPY.addSelected(selected.length)}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
