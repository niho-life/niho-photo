"use client";

import { Images, Plus } from "lucide-react";

import { cn } from "niho-ui/cn";
import { Skeleton } from "niho-ui/components/skeleton";

import { PHOTO_SHARED_ALBUM_COPY } from "../photo-editing-copy";
import {
  PHOTO_EDITING_EMPTY_STATE_BUTTON_CLASS_NAME,
  PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME,
} from "../editor/photo-editing-button-classes";
import { PhotoEditingTileImage } from "../editor/photo-editing-grid";

import { photoSharedAlbumRoleLabel, type PhotoSharedAlbumSummary } from "./photo-shared-album-model";

export type PhotoLibraryScreen = "photos" | "sharedAlbums";

const LOADING_CARD_COUNT = 6;

/**
 * 「写真」と「共有アルバム」の切り替え（B08 #249。主な画面はこの 2 つと、アルバムの「共有」シートだけ）。画面を切り替えるので
 * 今の画面に `aria-current="page"` を付ける。
 */
export function PhotoLibraryScreenTabs(props: { current: PhotoLibraryScreen; onChange: (screen: PhotoLibraryScreen) => void }) {
  const screens: { key: PhotoLibraryScreen; label: string }[] = [
    { key: "photos", label: PHOTO_SHARED_ALBUM_COPY.photos },
    { key: "sharedAlbums", label: PHOTO_SHARED_ALBUM_COPY.sharedAlbums },
  ];
  return (
    <nav aria-label={PHOTO_SHARED_ALBUM_COPY.screensLabel} className="inline-flex rounded-full bg-niho-surface-subtle p-1">
      {screens.map((screen) => {
        const current = screen.key === props.current;
        return (
          <button
            key={screen.key}
            type="button"
            aria-current={current ? "page" : undefined}
            onClick={() => {
              if (!current) props.onChange(screen.key);
            }}
            className={cn(
              "min-h-9 whitespace-nowrap rounded-full px-4 text-sub font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink",
              current ? "bg-white text-niho-text shadow-sm" : "text-niho-text-sub hover:text-niho-text",
            )}
          >
            {screen.label}
          </button>
        );
      })}
    </nav>
  );
}

/**
 * 「共有アルバム」の一覧（B08 #249）。自分のアルバムと共有されたアルバムを同じ並びで出す。自分のアルバムは枚数と人数、
 * 共有されたアルバムはオーナーと自分の役割を出す（見るだけのアルバムだと開く前に分かる）。共有が解除されたアルバムは
 * 接続側が一覧から外す。
 */
export function PhotoSharedAlbumList(props: {
  albums: readonly PhotoSharedAlbumSummary[];
  loading?: boolean;
  onOpenAlbum: (albumId: string) => void;
  /** 新しいアルバムを作る。無ければ出さない */
  onCreateAlbum?: () => void;
}) {
  const empty = !props.loading && props.albums.length === 0;
  return (
    <section aria-labelledby="photo-shared-album-list-title" className="flex h-full min-h-0 flex-col bg-[var(--photo-editing-surface,white)]">
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 px-4 py-2">
        <h1 id="photo-shared-album-list-title" className="text-lg font-bold text-niho-text">
          {PHOTO_SHARED_ALBUM_COPY.sharedAlbums}
        </h1>
        {props.onCreateAlbum && !empty ? (
          <button type="button" onClick={props.onCreateAlbum} className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "h-11 px-4")}>
            <Plus className="h-4 w-4" aria-hidden />
            {PHOTO_SHARED_ALBUM_COPY.newAlbum}
          </button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[max(1rem,env(safe-area-inset-bottom,0px))] sm:px-4">
        {props.loading ? (
          <ul aria-hidden className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: LOADING_CARD_COUNT }, (_, index) => (
              <li key={index}>
                <Skeleton className="aspect-square rounded-2xl" />
                <Skeleton className="mt-2 h-4 w-3/4" />
              </li>
            ))}
          </ul>
        ) : empty ? (
          <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-4 p-6 text-center">
            <p className="text-sub font-bold text-niho-text-muted">{PHOTO_SHARED_ALBUM_COPY.listEmpty}</p>
            {props.onCreateAlbum ? (
              <button type="button" onClick={props.onCreateAlbum} className={PHOTO_EDITING_EMPTY_STATE_BUTTON_CLASS_NAME}>
                <Plus className="h-4 w-4" aria-hidden />
                {PHOTO_SHARED_ALBUM_COPY.newAlbum}
              </button>
            ) : null}
          </div>
        ) : (
          <ul className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
            {props.albums.map((album) => (
              <li key={album.albumId} className="min-w-0">
                <PhotoSharedAlbumCard album={album} onOpen={() => props.onOpenAlbum(album.albumId)} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function PhotoSharedAlbumCard(props: { album: PhotoSharedAlbumSummary; onOpen: () => void }) {
  const { album } = props;
  const meta = album.role === "owner"
    ? [PHOTO_SHARED_ALBUM_COPY.itemCount(album.itemCount), PHOTO_SHARED_ALBUM_COPY.memberCount(album.memberCount)]
    : [`${album.owner.displayName}さん`, photoSharedAlbumRoleLabel(album.role)];
  const preparing = album.preparing && album.preparing.done < album.preparing.total ? album.preparing : null;
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="group flex w-full min-w-0 flex-col gap-2 rounded-2xl text-left focus-visible:outline-none"
    >
      <span className="relative block aspect-square w-full overflow-hidden rounded-2xl bg-niho-surface-warm ring-offset-2 group-focus-visible:ring-2 group-focus-visible:ring-niho-accent-ink">
        {album.coverUrl ? (
          <PhotoEditingTileImage key={album.coverUrl} url={album.coverUrl} geometry={null} cellAspect={1} />
        ) : (
          <span aria-hidden className="flex h-full w-full items-center justify-center text-niho-text-muted">
            <Images className="h-8 w-8" strokeWidth={1.5} />
          </span>
        )}
        {preparing ? (
          <span className="absolute bottom-2 left-2 max-w-[calc(100%-1rem)] truncate rounded-full bg-black/65 px-2 py-0.5 text-xs font-bold leading-5 text-white">
            {PHOTO_SHARED_ALBUM_COPY.preparingProgress(preparing.done, preparing.total)}
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 px-0.5">
        <span className="line-clamp-2 break-words text-sub font-bold leading-snug text-niho-text">{album.name}</span>
        <span className="truncate text-xs font-bold text-niho-text-muted">{meta.join("・")}</span>
      </span>
    </button>
  );
}
