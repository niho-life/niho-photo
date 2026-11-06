"use client";

import { useId, useState } from "react";
import { AlertCircle, Check, ChevronDown, Info } from "lucide-react";

import { cn } from "niho-ui/cn";
import { Spinner } from "niho-ui/components/spinner";

import { PHOTO_SHARED_ALBUM_COPY, PHOTO_SHARED_ALBUM_UPLOAD_COPY } from "../photo-editing-copy";
import { PHOTO_EDITING_TEXT_BUTTON_CLASS_NAME } from "../editor/photo-editing-button-classes";

import {
  photoSharedAlbumUploadHeadline,
  photoSharedAlbumUploadPhaseLabel,
  summarizePhotoSharedAlbumUploads,
  type PhotoSharedAlbumUpload,
} from "./photo-shared-album-model";

/**
 * 写真の追加の進捗（アルバムの下端。B08 #249）。見出しは「追加中 2/5」、開くと項目ごとの段階を出す。結果が分からない項目は
 * 「確認中」のまま接続側が同じ追加を照合し、ここからは送り直さない。失敗した項目だけ「再試行」を出す（接続側は同じ operation で
 * 送る）。初めて追加するときだけ「元データはこの端末に残ります」を 1 行出す。
 */
export function PhotoSharedAlbumUploadPanel(props: {
  uploads: readonly PhotoSharedAlbumUpload[];
  showOriginalsNote: boolean;
  onRetry: (uploadId: string) => void;
  onDismiss: () => void;
}) {
  const summary = summarizePhotoSharedAlbumUploads(props.uploads);
  const hasProblem = summary.notAdded > 0;
  // 問題が無い間は畳み、項目は開いて見る。追加できなかった項目があれば最初から開く
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const open = expanded ?? hasProblem;
  const listId = useId();
  const overall = summary.total > 0 ? summary.settled / summary.total : 0;
  const headline = photoSharedAlbumUploadHeadline(summary);

  return (
    <section
      aria-label={PHOTO_SHARED_ALBUM_UPLOAD_COPY.regionLabel}
      // スマホは下端の帯（グリッドを押し上げる）、md 以上は右下に浮かべた小さな面（グリッドの幅を使い切らない）
      className={cn(
        "shrink-0 overflow-hidden border-t border-niho-border bg-white pb-[env(safe-area-inset-bottom,0px)] shadow-[0_-4px_16px_rgba(0,0,0,0.06)]",
        "md:absolute md:bottom-4 md:right-4 md:z-10 md:w-[24rem] md:rounded-2xl md:border md:pb-0 md:shadow-xl",
      )}
    >
      {props.showOriginalsNote ? (
        <p className="flex items-center gap-2 border-b border-niho-border bg-niho-surface-subtle px-4 py-2 text-sub font-bold text-niho-text-sub">
          <Info className="h-4 w-4 shrink-0" aria-hidden />
          {PHOTO_SHARED_ALBUM_COPY.originalsStayHere}
        </p>
      ) : null}
      <p role="status" className="sr-only">
        {headline}
      </p>
      <div className="flex min-h-12 items-center gap-2 px-2 sm:px-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setExpanded(!open)}
          className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink"
        >
          {summary.active ? (
            <Spinner size="sm" />
          ) : hasProblem ? (
            <AlertCircle className="h-4 w-4 shrink-0 text-niho-danger" aria-hidden />
          ) : (
            <Check className="h-4 w-4 shrink-0 text-niho-accent-ink" strokeWidth={3} aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate text-sub font-bold tabular-nums text-niho-text">{headline}</span>
          <span className="sr-only">{open ? PHOTO_SHARED_ALBUM_UPLOAD_COPY.hideDetails : PHOTO_SHARED_ALBUM_UPLOAD_COPY.showDetails}</span>
          <ChevronDown
            className={cn("h-4 w-4 shrink-0 text-niho-text-sub motion-safe:transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </button>
        {!summary.active ? (
          <button type="button" onClick={props.onDismiss} className={PHOTO_EDITING_TEXT_BUTTON_CLASS_NAME}>
            {PHOTO_SHARED_ALBUM_UPLOAD_COPY.dismiss}
          </button>
        ) : null}
      </div>
      {summary.active ? (
        <span aria-hidden className="mx-4 mb-2 block h-1 overflow-hidden rounded-full bg-niho-border">
          <span
            className="block h-full rounded-full bg-niho-accent-ink motion-safe:transition-[width]"
            style={{ width: `${Math.round(overall * 100)}%` }}
          />
        </span>
      ) : null}
      <ul id={listId} hidden={!open} className="max-h-[min(35dvh,16rem)] overflow-y-auto border-t border-niho-border px-2 py-1 sm:px-3">
        {props.uploads.map((upload) => (
          <PhotoSharedAlbumUploadRow key={upload.uploadId} upload={upload} onRetry={() => props.onRetry(upload.uploadId)} />
        ))}
      </ul>
    </section>
  );
}

function PhotoSharedAlbumUploadRow(props: { upload: PhotoSharedAlbumUpload; onRetry: () => void }) {
  const { upload } = props;
  const problem = upload.phase === "failed" || upload.phase === "notAdded";
  const label = photoSharedAlbumUploadPhaseLabel(upload);
  const fraction = upload.phase === "sending" && upload.fraction !== null ? Math.min(1, Math.max(0, upload.fraction)) : null;
  return (
    <li className="flex min-h-14 items-center gap-3 py-1.5">
      <span className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-niho-surface-warm">
        {upload.previewUrl ? <img src={upload.previewUrl} alt="" draggable={false} className="h-full w-full object-cover" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sub font-bold text-niho-text" title={upload.name}>
          {upload.name}
        </span>
        {fraction !== null ? (
          <span
            role="progressbar"
            aria-label={`${upload.name}、${label}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
            className="block h-1 overflow-hidden rounded-full bg-niho-border"
          >
            <span className="block h-full rounded-full bg-niho-accent-ink motion-safe:transition-[width]" style={{ width: `${Math.round(fraction * 100)}%` }} />
          </span>
        ) : (
          <span className={cn("text-xs font-bold", problem ? "text-niho-danger" : "text-niho-text-muted")}>{label}</span>
        )}
      </span>
      {upload.phase === "added" ? <Check className="h-4 w-4 shrink-0 text-niho-accent-ink" strokeWidth={3} aria-hidden /> : null}
      {upload.phase === "checking" || (upload.phase === "sending" && fraction === null) ? <Spinner size="sm" className="shrink-0" /> : null}
      {upload.phase === "failed" ? (
        <button
          type="button"
          aria-label={`${upload.name}、${PHOTO_SHARED_ALBUM_UPLOAD_COPY.retry}`}
          onClick={props.onRetry}
          className={PHOTO_EDITING_TEXT_BUTTON_CLASS_NAME}
        >
          {PHOTO_SHARED_ALBUM_UPLOAD_COPY.retry}
        </button>
      ) : null}
    </li>
  );
}
