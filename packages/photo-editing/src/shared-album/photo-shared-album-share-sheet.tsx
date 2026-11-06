"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Link2, X } from "lucide-react";

import { appDialog } from "niho-ui/app-dialog";
import { cn } from "niho-ui/cn";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "niho-ui/components/dialog";
import { Spinner } from "niho-ui/components/spinner";

import { PHOTO_SHARED_ALBUM_COPY, PHOTO_SHARED_ALBUM_SHARE_COPY } from "../photo-editing-copy";
import {
  PHOTO_EDITING_DANGER_GHOST_BUTTON_CLASS_NAME,
  PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME,
} from "../editor/photo-editing-button-classes";
import { BrowserPhotoPillRadioGroup, type BrowserPhotoPillOption } from "../editor/browser-photo-editing-grid";

import {
  PHOTO_SHARED_ALBUM_MEMBER_ROLES,
  activePhotoSharedAlbumInviteLink,
  photoSharedAlbumCanManageMembers,
  photoSharedAlbumInviteExpiryLabel,
  photoSharedAlbumRoleLabel,
  type PhotoSharedAlbumInviteLink,
  type PhotoSharedAlbumMember,
  type PhotoSharedAlbumMemberRole,
  type PhotoSharedAlbumRole,
} from "./photo-shared-album-model";

export interface PhotoSharedAlbumShareSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly albumName: string;
  /** 見ている人の役割（オーナーだけが招待・役割の変更・メンバーを外す） */
  readonly role: PhotoSharedAlbumRole;
  readonly members: readonly PhotoSharedAlbumMember[];
  readonly inviteLinks: readonly PhotoSharedAlbumInviteLink[];
  /** 有効期限のラベルの基準時刻（ms） */
  readonly now: number;
  /** その役割のリンクの URL を返す（使えるリンクが無ければ接続側が作る）。失敗は reject */
  readonly onCopyLink: (role: PhotoSharedAlbumMemberRole) => Promise<string>;
  readonly onRevokeLink: (linkId: string) => Promise<void>;
  readonly onChangeRole: (userId: string, role: PhotoSharedAlbumMemberRole) => Promise<void>;
  readonly onRemoveMember: (userId: string) => Promise<void>;
  /** 本人がアルバムから抜ける（オーナー以外）。無ければ出さない */
  readonly onLeave?: () => Promise<void>;
}

type CopyState = "idle" | "copying" | "copied" | "failed";

const INVITE_ROLE_OPTIONS: readonly BrowserPhotoPillOption<PhotoSharedAlbumMemberRole>[] = PHOTO_SHARED_ALBUM_MEMBER_ROLES.map((role) => ({
  value: role,
  label: photoSharedAlbumRoleLabel(role),
}));

/**
 * スマホは下端に付けた高さが中身なりのシート、sm 以上は中央の窓。上下は safe area（ネイティブが注入した値、無ければ env）を避ける。
 */
const SHEET_CLASS_NAME = [
  "flex w-[calc(100vw-1.5rem)] max-w-[440px] flex-col gap-0 overflow-hidden rounded-[24px] border border-niho-border bg-white p-0 shadow-xl focus:outline-none",
  "top-auto bottom-[calc(var(--niho-safe-area-bottom,env(safe-area-inset-bottom,0px))+12px)] translate-y-0",
  "max-h-[calc(100dvh-var(--niho-safe-area-top,env(safe-area-inset-top,0px))-var(--niho-safe-area-bottom,env(safe-area-inset-bottom,0px))-24px)]",
  "sm:top-[50%] sm:bottom-auto sm:max-h-[min(720px,calc(100dvh-3rem))] sm:translate-y-[-50%]",
].join(" ");

/**
 * URL を後から受け取ってコピーする。Safari はユーザーの操作の中でしかクリップボードに書けないので、`ClipboardItem` に
 * Promise を渡して操作の中で書き込みを始める。使えない環境では URL を待ってから文字としてコピーする。
 */
async function copyPendingText(pending: Promise<string>): Promise<void> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard) throw new Error("clipboard unavailable");
  if (typeof ClipboardItem !== "undefined" && typeof clipboard.write === "function") {
    try {
      await clipboard.write([
        new ClipboardItem({ "text/plain": pending.then((text) => new Blob([text], { type: "text/plain" })) }),
      ]);
      return;
    } catch {
      // Promise を受けない実装は文字のコピーへ
    }
  }
  await clipboard.writeText(await pending);
}

function defaultInviteRole(links: readonly PhotoSharedAlbumInviteLink[], now: number): PhotoSharedAlbumMemberRole {
  const contributor = activePhotoSharedAlbumInviteLink(links, "contributor", now);
  const viewer = activePhotoSharedAlbumInviteLink(links, "viewer", now);
  // 使えるリンクが一方だけならその役割、無ければ「見るだけ」（広く渡っても写真は足されない）
  if (contributor && !viewer) return "contributor";
  return "viewer";
}

/**
 * アルバムの「共有」シート（B08 #249）。メンバーの一覧と役割、主操作「リンクをコピー」、有効期限の短いラベルだけを置く。
 * オーナー以外は一覧を見るだけで、本人は「アルバムから抜ける」ができる。外す・無効にするは確認してから行う。
 * 接続側はアルバムごとに `key={albumId}` で描き、別のアルバムの招待の役割・結果を持ち越さない。
 */
export function PhotoSharedAlbumShareSheet(props: PhotoSharedAlbumShareSheetProps) {
  const manage = photoSharedAlbumCanManageMembers(props.role);
  const [inviteRole, setInviteRole] = useState<PhotoSharedAlbumMemberRole>(() => defaultInviteRole(props.inviteLinks, props.now));
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const roleGroupId = useId();
  const contentRef = useRef<HTMLDivElement | null>(null);

  // 開いている 1 回分の世代。閉じた・開き直した・画面を離れたあとに届いた結果は、今のシートへ反映しない
  const sessionRef = useRef<object | null>(null);

  // 開き直したら前の結果を消す
  useEffect(() => {
    if (!props.open) {
      sessionRef.current = null;
      return;
    }
    sessionRef.current = {};
    setCopyState("idle");
    setPendingAction(null);
    setError(null);
  }, [props.open]);

  useEffect(() => () => {
    sessionRef.current = null;
  }, []);

  const activeLink = activePhotoSharedAlbumInviteLink(props.inviteLinks, inviteRole, props.now);
  const expiryLabel = activeLink ? photoSharedAlbumInviteExpiryLabel(activeLink, props.now) : null;
  const busy = pendingAction !== null || copyState === "copying";

  const run = async (key: string, action: () => Promise<void>) => {
    if (busy) return;
    const session = sessionRef.current;
    setPendingAction(key);
    setError(null);
    let failed = false;
    try {
      await action();
    } catch {
      failed = true;
    }
    if (session === null || sessionRef.current !== session) return;
    setPendingAction(null);
    if (failed) setError(PHOTO_SHARED_ALBUM_COPY.actionFailed);
  };

  const copyLink = () => {
    if (busy) return;
    const session = sessionRef.current;
    setCopyState("copying");
    setError(null);
    let pending: Promise<string>;
    try {
      pending = props.onCopyLink(inviteRole);
    } catch (cause) {
      pending = Promise.reject(cause);
    }
    const settle = (state: CopyState) => {
      if (session !== null && sessionRef.current === session) setCopyState(state);
    };
    copyPendingText(pending).then(
      () => settle("copied"),
      () => settle("failed"),
    );
  };

  const revoke = async () => {
    if (!activeLink) return;
    const confirmed = await appDialog.confirm({
      title: PHOTO_SHARED_ALBUM_SHARE_COPY.revokeTitle,
      description: PHOTO_SHARED_ALBUM_SHARE_COPY.revokeDescription,
      confirmLabel: PHOTO_SHARED_ALBUM_SHARE_COPY.revokeConfirm,
      variant: "danger",
    });
    if (!confirmed) return;
    await run(`revoke:${activeLink.linkId}`, () => props.onRevokeLink(activeLink.linkId));
    if (sessionRef.current !== null) setCopyState("idle");
  };

  const removeMember = async (member: PhotoSharedAlbumMember) => {
    const confirmed = await appDialog.confirm({
      title: PHOTO_SHARED_ALBUM_SHARE_COPY.removeMemberTitle(member.displayName),
      description: PHOTO_SHARED_ALBUM_SHARE_COPY.removeMemberDescription,
      confirmLabel: PHOTO_SHARED_ALBUM_SHARE_COPY.removeMemberConfirm,
      variant: "danger",
    });
    if (!confirmed) return;
    await run(`remove:${member.userId}`, () => props.onRemoveMember(member.userId));
  };

  const leave = async () => {
    const onLeave = props.onLeave;
    if (!onLeave) return;
    const confirmed = await appDialog.confirm({
      title: PHOTO_SHARED_ALBUM_SHARE_COPY.leaveTitle,
      description: PHOTO_SHARED_ALBUM_SHARE_COPY.leaveDescription,
      confirmLabel: PHOTO_SHARED_ALBUM_SHARE_COPY.leaveConfirm,
      variant: "danger",
    });
    if (!confirmed) return;
    await run("leave", onLeave);
  };

  const members = [...props.members].sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner"));

  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!busy || open) props.onOpenChange(open); }}>
      <DialogContent
        ref={contentRef}
        hideClose
        // 開いた直後は枠を出さずにシート自体へフォーカスを置く（読み上げは見出しから始まる）
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        className={SHEET_CLASS_NAME}
      >
        <DialogHeader className="flex shrink-0 flex-row items-start gap-2 space-y-0 border-b border-niho-border px-5 pb-3 pt-4 text-left">
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-lg font-bold text-niho-text">{PHOTO_SHARED_ALBUM_SHARE_COPY.title}</DialogTitle>
            <DialogDescription className="mt-0.5 line-clamp-2 break-words text-sub text-niho-text-sub">{props.albumName}</DialogDescription>
          </div>
          <button
            type="button"
            aria-label={PHOTO_SHARED_ALBUM_COPY.close}
            disabled={busy}
            onClick={() => props.onOpenChange(false)}
            className="-mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-niho-text-sub transition hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:opacity-50"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4">
          {error ? (
            <p role="alert" className="mb-3 rounded-xl bg-niho-danger/10 px-3 py-2 text-sub font-bold text-niho-danger">
              {error}
            </p>
          ) : null}

          {manage ? (
            <section aria-labelledby={`${roleGroupId}-heading`} className="mb-5">
              <h3 id={`${roleGroupId}-heading`} className="text-sub font-bold text-niho-text-sub">
                {PHOTO_SHARED_ALBUM_SHARE_COPY.inviteHeading}
              </h3>
              {/* 一覧の絞り込みと同じピルの選択（radio と同じく矢印キーで選び直し、Tab では選んでいる方にだけ止まる） */}
              <BrowserPhotoPillRadioGroup
                label={PHOTO_SHARED_ALBUM_SHARE_COPY.inviteRoleLabel}
                options={INVITE_ROLE_OPTIONS}
                value={inviteRole}
                onChange={(role) => {
                  // コピーの途中は役割を変えない（作っているリンクと表示の役割をずらさない）
                  if (busy) return;
                  setInviteRole(role);
                  setCopyState("idle");
                }}
                className="-ml-1 mt-2 flex-wrap"
              />
              <button
                type="button"
                disabled={busy}
                onClick={copyLink}
                className="niho-primary-surface mt-3 inline-flex h-12 w-full items-center justify-center gap-2 rounded-full px-5 text-body font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {copyState === "copying" ? <Spinner size="sm" tone="onColor" /> : <Link2 className="h-4 w-4" aria-hidden />}
                {copyState === "copying" ? PHOTO_SHARED_ALBUM_SHARE_COPY.copying : PHOTO_SHARED_ALBUM_SHARE_COPY.copyLink}
              </button>
              <div className="mt-2 flex min-h-11 flex-wrap items-center justify-between gap-x-3">
                <p role="status" className={cn("text-sub font-bold", copyState === "failed" ? "text-niho-danger" : "text-niho-text-sub")}>
                  {copyState === "copied"
                    ? [PHOTO_SHARED_ALBUM_SHARE_COPY.copied, expiryLabel].filter(Boolean).join("・")
                    : copyState === "failed"
                      ? PHOTO_SHARED_ALBUM_SHARE_COPY.copyFailed
                      : expiryLabel}
                </p>
                {activeLink ? (
                  <button type="button" disabled={busy} onClick={() => void revoke()} className={cn(PHOTO_EDITING_DANGER_GHOST_BUTTON_CLASS_NAME, "-mr-3 h-11")}>
                    {PHOTO_SHARED_ALBUM_SHARE_COPY.revokeLink}
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          <section aria-labelledby={`${roleGroupId}-members`}>
            <h3 id={`${roleGroupId}-members`} className="text-sub font-bold text-niho-text-sub">
              {PHOTO_SHARED_ALBUM_COPY.members}
              <span className="ml-2 font-bold tabular-nums text-niho-text-muted">{PHOTO_SHARED_ALBUM_COPY.memberCount(members.length)}</span>
            </h3>
            <ul className="mt-1 divide-y divide-niho-border">
              {members.map((member) => (
                <PhotoSharedAlbumMemberRow
                  key={member.userId}
                  member={member}
                  manage={manage}
                  busy={busy}
                  pending={pendingAction === `role:${member.userId}` || pendingAction === `remove:${member.userId}`}
                  onChangeRole={(role) => void run(`role:${member.userId}`, () => props.onChangeRole(member.userId, role))}
                  onRemove={() => void removeMember(member)}
                />
              ))}
            </ul>
          </section>

          {!manage && props.onLeave ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void leave()}
              className={cn(PHOTO_EDITING_DANGER_GHOST_BUTTON_CLASS_NAME, "-ml-3 mt-3 h-11")}
            >
              {PHOTO_SHARED_ALBUM_SHARE_COPY.leave}
            </button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PhotoSharedAlbumMemberRow(props: {
  member: PhotoSharedAlbumMember;
  manage: boolean;
  busy: boolean;
  pending: boolean;
  onChangeRole: (role: PhotoSharedAlbumMemberRole) => void;
  onRemove: () => void;
}) {
  const { member } = props;
  const selectId = useId();
  const editable = props.manage && member.role !== "owner" && !member.isSelf;
  const initial = Array.from(member.displayName.trim())[0] ?? "";
  return (
    <li className="flex min-h-16 items-center gap-3 py-2">
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-niho-accent-soft text-sub font-bold text-niho-accent-ink"
      >
        {initial}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="break-words text-body font-bold leading-snug text-niho-text">
          {member.displayName}
          {member.isSelf ? <span className="ml-1 text-sub font-bold text-niho-text-muted">（{PHOTO_SHARED_ALBUM_COPY.you}）</span> : null}
        </span>
        {editable ? (
          // 見た目は今の役割の字と ▾ だけにし、押すと OS の選択肢を出す（透明な select を重ねる。幅は今の役割の字に合う）
          <span
            className={cn(
              "relative -ml-1 mt-0.5 inline-flex h-9 w-fit max-w-full items-center gap-1 rounded-lg px-1 text-sub font-bold text-niho-accent-ink transition hover:bg-niho-pale/60",
              "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-niho-accent-ink",
              props.busy && "opacity-50",
            )}
          >
            <span aria-hidden className="truncate">{photoSharedAlbumRoleLabel(member.role)}</span>
            <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0" />
            <label htmlFor={selectId} className="sr-only">
              {PHOTO_SHARED_ALBUM_SHARE_COPY.memberRoleLabel(member.displayName)}
            </label>
            <select
              id={selectId}
              value={member.role}
              disabled={props.busy}
              onChange={(event) => props.onChangeRole(event.currentTarget.value as PhotoSharedAlbumMemberRole)}
              // 見た目は 36px のまま、押せる範囲は上下に 4px ずつ広げて 44px にする
              className="absolute inset-x-0 -inset-y-1 h-[calc(100%+0.5rem)] w-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
            >
              {PHOTO_SHARED_ALBUM_MEMBER_ROLES.map((role) => (
                <option key={role} value={role}>
                  {photoSharedAlbumRoleLabel(role)}
                </option>
              ))}
            </select>
          </span>
        ) : (
          <span className="text-sub font-bold text-niho-text-muted">{photoSharedAlbumRoleLabel(member.role)}</span>
        )}
      </span>
      {props.pending ? <Spinner size="sm" className="shrink-0" /> : null}
      {editable ? (
        <button
          type="button"
          aria-label={PHOTO_SHARED_ALBUM_SHARE_COPY.removeMember(member.displayName)}
          disabled={props.busy}
          onClick={props.onRemove}
          className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "h-11 w-11 border-transparent bg-transparent px-0 text-niho-text-sub")}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      ) : null}
    </li>
  );
}
