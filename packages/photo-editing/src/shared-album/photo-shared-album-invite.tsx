"use client";

import { Images, Link2Off } from "lucide-react";

import { cn } from "niho-ui/cn";
import { Spinner } from "niho-ui/components/spinner";

import { PHOTO_SHARED_ALBUM_COPY, PHOTO_SHARED_ALBUM_INVITE_COPY } from "../photo-editing-copy";
import { PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME } from "../editor/photo-editing-button-classes";

import { photoSharedAlbumRoleLabel, type PhotoSharedAlbumMemberRole } from "./photo-shared-album-model";

/**
 * 招待リンクの段階。`ready` は参加の前（ログイン済み）、`joining` は参加の途中、`failed` は参加できなかった（もう一度押せる）、
 * `unavailable` は期限切れ・無効化・見つからないリンク（どれかは区別して見せない）。
 */
export type PhotoSharedAlbumInvitePhase = "ready" | "joining" | "failed" | "unavailable";

export type PhotoSharedAlbumInviteProps =
  | {
      readonly phase: "ready" | "joining" | "failed";
      readonly albumName: string;
      readonly ownerName: string;
      readonly role: PhotoSharedAlbumMemberRole;
      readonly onJoin: () => void;
    }
  | {
      readonly phase: "unavailable";
      /** 「共有アルバム」へ。無ければ出さない */
      readonly onGoToAlbums?: () => void;
    };

/**
 * 招待リンクを開いた画面（B08 #249）。参加の前はアルバム名・オーナー・参加後の役割と「参加する」だけを出す。使えないリンクは
 * 「このリンクは使えません」と、オーナーに頼むことだけを伝える。VPN・保存先の鍵・アプリの追加は求めない。
 */
export function PhotoSharedAlbumInvite(props: PhotoSharedAlbumInviteProps) {
  return (
    <main className="flex min-h-full items-center justify-center bg-[var(--photo-editing-surface,white)] px-4 py-10 text-niho-text">
      <section
        aria-labelledby="photo-shared-album-invite-title"
        className="flex w-full max-w-sm flex-col items-center gap-3 rounded-[28px] border border-niho-border bg-white px-6 py-8 text-center shadow-sm"
      >
        {props.phase === "unavailable" ? (
          <>
            <span aria-hidden className="flex h-14 w-14 items-center justify-center rounded-full bg-niho-surface-subtle text-niho-text-sub">
              <Link2Off className="h-6 w-6" strokeWidth={1.75} />
            </span>
            <h1 id="photo-shared-album-invite-title" className="text-lg font-bold">
              {PHOTO_SHARED_ALBUM_INVITE_COPY.unavailable}
            </h1>
            <p className="text-sub text-niho-text-sub">{PHOTO_SHARED_ALBUM_INVITE_COPY.unavailableNext}</p>
            {props.onGoToAlbums ? (
              <button type="button" onClick={props.onGoToAlbums} className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "mt-2 h-11 px-5")}>
                {PHOTO_SHARED_ALBUM_INVITE_COPY.goToAlbums}
              </button>
            ) : null}
          </>
        ) : (
          <>
            <span aria-hidden className="flex h-14 w-14 items-center justify-center rounded-full bg-niho-accent-soft text-niho-accent-ink">
              <Images className="h-6 w-6" strokeWidth={1.75} />
            </span>
            <h1 id="photo-shared-album-invite-title" className="break-words text-lg font-bold leading-snug">
              {props.albumName}
            </h1>
            <p className="break-words text-sub text-niho-text-sub">{PHOTO_SHARED_ALBUM_COPY.ownerAlbum(props.ownerName)}</p>
            <p className="rounded-full bg-niho-surface-subtle px-3 py-1 text-xs font-bold text-niho-text-sub">
              {photoSharedAlbumRoleLabel(props.role)}
            </p>
            <button
              type="button"
              disabled={props.phase === "joining"}
              onClick={props.onJoin}
              className="niho-primary-surface mt-3 inline-flex h-12 w-full items-center justify-center gap-2 rounded-full px-5 text-body font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {props.phase === "joining" ? <Spinner size="sm" tone="onColor" /> : null}
              {props.phase === "joining" ? PHOTO_SHARED_ALBUM_INVITE_COPY.joining : PHOTO_SHARED_ALBUM_INVITE_COPY.join}
            </button>
            {props.phase === "failed" ? (
              <p role="alert" className="text-sub font-bold text-niho-danger">
                {PHOTO_SHARED_ALBUM_INVITE_COPY.joinFailed}
              </p>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
