"use client";

import { useEffect, useRef, useState } from "react";
import { Settings, X } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "niho-ui/components/dialog";

import { PHOTO_SHARED_ALBUM_COPY, PHOTO_STORAGE_LOCATION_COPY } from "../photo-editing-copy";

import type { PhotoStorageLocation } from "./photo-shared-album-model";
import { PhotoStorageLocationSettings } from "./photo-storage-location-settings";

const DIALOG_CLASS_NAME = [
  "flex w-[calc(100vw-1.5rem)] max-w-[440px] flex-col gap-0 overflow-hidden rounded-[24px] border border-niho-border bg-white p-0 shadow-xl focus:outline-none",
  "max-h-[calc(100dvh-var(--niho-safe-area-top,env(safe-area-inset-top,0px))-var(--niho-safe-area-bottom,env(safe-area-inset-bottom,0px))-24px)]",
].join(" ");

/** 見出しの行の「設定」ボタン（44px の正方形、アイコンだけ）。 */
export function PhotoSettingsButton(props: { readonly onClick: () => void; readonly className?: string }) {
  return (
    <button
      type="button"
      aria-label={PHOTO_STORAGE_LOCATION_COPY.settings}
      title={PHOTO_STORAGE_LOCATION_COPY.settings}
      onClick={props.onClick}
      className={props.className ?? "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-niho-text-sub transition hover:bg-niho-pale/60 hover:text-niho-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink"}
    >
      <Settings className="h-[18px] w-[18px]" aria-hidden />
    </button>
  );
}

/**
 * 設定（いまは「保存先」だけ。B08 #249）。開いたときに保存先を読み直す。自前サーバーの登録の入口は `onAddHostedMac`（登録の流れは
 * 常設 Mac 側の画面。無ければ出さない）。
 */
export function PhotoStorageSettingsDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly loadLocations: (signal: AbortSignal) => Promise<readonly PhotoStorageLocation[]>;
  readonly onAddHostedMac?: () => void;
}) {
  const [locations, setLocations] = useState<readonly PhotoStorageLocation[] | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const loadRef = useRef(props.loadLocations);
  loadRef.current = props.loadLocations;
  useEffect(() => {
    if (!props.open) return;
    const controller = new AbortController();
    loadRef.current(controller.signal).then(
      (next) => {
        if (!controller.signal.aborted) setLocations(next);
      },
      () => {
        if (!controller.signal.aborted) setLocations([]);
      },
    );
    return () => controller.abort();
  }, [props.open]);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        ref={contentRef}
        hideClose
        // Like the share sheet: focus the dialog itself on open (reading starts at the title), not the close button.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        className={DIALOG_CLASS_NAME}
      >
        <DialogHeader className="flex shrink-0 flex-row items-center gap-2 space-y-0 border-b border-niho-border px-5 pb-3 pt-4 text-left">
          <DialogTitle className="min-w-0 flex-1 text-lg font-bold text-niho-text">{PHOTO_STORAGE_LOCATION_COPY.settings}</DialogTitle>
          <DialogDescription className="sr-only">{PHOTO_STORAGE_LOCATION_COPY.heading}</DialogDescription>
          <button
            type="button"
            aria-label={PHOTO_SHARED_ALBUM_COPY.close}
            onClick={() => props.onOpenChange(false)}
            className="-mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-niho-text-sub transition hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-4 pb-5 pt-4">
          <PhotoStorageLocationSettings locations={locations ?? []} {...(props.onAddHostedMac ? { onAddHostedMac: props.onAddHostedMac } : {})} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
