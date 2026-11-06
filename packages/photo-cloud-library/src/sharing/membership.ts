/**
 * Membership and invite actions for the shared-album UI (B05 #246) on top of a membership client.
 *
 * - One idempotency key per user action. A lost response (network, header timeout, 503, short rate limit) is replayed
 *   with the same key and payload, so a join or an invite is never applied twice and the owner is notified once.
 * - Invite secrets are returned once by the server. They stay in this object's memory only (never storage, logs or
 *   URLs it builds) so "copy link" can reuse a usable link. A replayed create has no secret; that link is revoked and a
 *   new one created, as the contract prescribes.
 * - Anything else surfaces unchanged; `sharingRecoveryOf` maps it to the contract's next step for the UI.
 */
import { PersonalPhotoCloudError } from "../errors";

import {
  SHARING_ERROR_RECOVERY,
  inviteLinkStatus,
  type AlbumId,
  type InviteJoinResult,
  type InviteLink,
  type InviteLinkCreated,
  type InviteLinkId,
  type InviteSecret,
  type MemberRole,
  type Membership,
  type MembershipId,
  type MembershipPage,
  type SharingOperationMap,
  type SharingRecovery,
  type SharingRequestOptions,
} from "./contract";
import { isSharingErrorEnvelope, type SharedAlbumMembershipOperation } from "./membership-wire";

export type SharedAlbumMembershipTransport = {
  request<K extends SharedAlbumMembershipOperation>(
    operation: K,
    request: SharingOperationMap[K]["request"],
    options: SharingRequestOptions<K>,
  ): Promise<SharingOperationMap[K]["response"]>;
};

export interface CreateSharedAlbumMembershipOptions {
  readonly client: SharedAlbumMembershipTransport;
  /** Fresh key per user action. Default: `crypto.randomUUID()`. */
  readonly newIdempotencyKey?: () => string;
  /** Attempts per action including the first (default 3). */
  readonly maxAttempts?: number;
  /** Longest server-requested wait that is retried automatically; longer waits surface as rate_limited (default 5 s). */
  readonly maxAutomaticRetryAfterSeconds?: number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

export interface SharedAlbumInvite {
  readonly link: InviteLink;
  readonly secret: InviteSecret;
}

export interface SharedAlbumMembership {
  listInvites(albumId: AlbumId, signal: AbortSignal): Promise<SharingOperationMap["invites.list"]["response"]>;
  /** Creates a link and returns its secret (revoking and recreating when a replay withheld it). */
  createInvite(albumId: AlbumId, role: MemberRole, signal: AbortSignal): Promise<SharedAlbumInvite>;
  /** A usable link of that role whose secret this session still holds, or a new one. For "リンクをコピー". */
  ensureInvite(albumId: AlbumId, role: MemberRole, signal: AbortSignal): Promise<SharedAlbumInvite>;
  /** The secret of a link created in this session, while it is held. */
  heldSecret(linkId: InviteLinkId): InviteSecret | null;
  revokeInvite(albumId: AlbumId, inviteLinkId: InviteLinkId, signal: AbortSignal): Promise<InviteLink>;
  /** Requires a signed-in session. `joined: false` means already a member; the role is unchanged. */
  join(secret: InviteSecret, signal: AbortSignal): Promise<InviteJoinResult>;
  listMembers(albumId: AlbumId, page: { readonly cursor?: string; readonly limit?: number }, signal: AbortSignal): Promise<MembershipPage>;
  changeRole(albumId: AlbumId, membershipId: MembershipId, expectedRevision: number, role: MemberRole, signal: AbortSignal): Promise<Membership>;
  removeMember(albumId: AlbumId, membershipId: MembershipId, signal: AbortSignal): Promise<Membership>;
  leave(albumId: AlbumId, signal: AbortSignal): Promise<Membership>;
  /** Drops held secrets (sign-out, scope change, album closed). */
  forgetSecrets(): void;
}

const DEFAULT_ATTEMPTS = 3;
/** Creations tried when every answer carrying the secret was lost; each secretless link is revoked. */
const MAX_INVITE_CREATIONS = 3;
const RETRY_BASE_MS = 300;

export function createSharedAlbumMembership(options: CreateSharedAlbumMembershipOptions): SharedAlbumMembership {
  const newKey = options.newIdempotencyKey ?? (() => globalThis.crypto.randomUUID());
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_ATTEMPTS));
  const maxRetryAfter = options.maxAutomaticRetryAfterSeconds ?? 5;
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  const secrets = new Map<InviteLinkId, { readonly albumId: AlbumId; readonly secret: InviteSecret; readonly expiresAtMs: number }>();
  /** A held secret, dropped as soon as its link has expired (revocations elsewhere are dropped on the next listing). */
  const held = (linkId: InviteLinkId): { readonly albumId: AlbumId; readonly secret: InviteSecret } | null => {
    const entry = secrets.get(linkId);
    if (!entry) return null;
    if (!(now() < entry.expiresAtMs)) {
      secrets.delete(linkId);
      return null;
    }
    return entry;
  };

  /** Replays the same request (and key) while the failure only means "the answer was lost or delayed". */
  async function send<K extends SharedAlbumMembershipOperation>(
    operation: K,
    request: SharingOperationMap[K]["request"],
    signal: AbortSignal,
    mutation: boolean,
  ): Promise<SharingOperationMap[K]["response"]> {
    const key = mutation ? newKey() : null;
    for (let attempt = 1; ; attempt += 1) {
      const requestOptions = (key === null ? { signal } : { signal, idempotencyKey: key }) as unknown as SharingRequestOptions<K>;
      try {
        return await options.client.request(operation, request, requestOptions);
      } catch (error) {
        if (signal.aborted || attempt >= maxAttempts) throw error;
        const wait = replayDelay(error, attempt, maxRetryAfter);
        if (wait === null) throw error;
        await sleep(wait, signal);
      }
    }
  }

  async function createInvite(albumId: AlbumId, role: MemberRole, signal: AbortSignal): Promise<SharedAlbumInvite> {
    for (let creation = 1; ; creation += 1) {
      const value: InviteLinkCreated = (await send("invites.create", { albumId, role }, signal, true)).value;
      if (value.secret !== null) {
        secrets.set(value.link.id, { albumId, secret: value.secret, expiresAtMs: Date.parse(value.link.expiresAt) });
        return { link: value.link, secret: value.secret };
      }
      // The answer with the secret was lost and the replay withholds it: nobody can ever use that link, so it is
      // revoked every time (never left usable), and a new one is created with a fresh key.
      await send("invites.revoke", { albumId, inviteLinkId: value.link.id }, signal, true);
      if (creation >= MAX_INVITE_CREATIONS) throw new PersonalPhotoCloudError("unavailable");
    }
  }

  return {
    listInvites: (albumId, signal) => send("invites.list", { albumId }, signal, false),
    createInvite,
    async ensureInvite(albumId, role, signal) {
      const { links } = await send("invites.list", { albumId }, signal, false);
      const instant = new Date(now()).toISOString();
      const usable = links
        .filter((link) => link.role === role && inviteLinkStatus(link, instant) === "usable" && secrets.get(link.id)?.albumId === albumId)
        .sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt))[0];
      // Forget secrets of links the server no longer lists as usable (revoked elsewhere, expired).
      for (const [linkId, entry] of secrets) {
        if (entry.albumId !== albumId) continue;
        const listed = links.find((link) => link.id === linkId);
        if (!listed || inviteLinkStatus(listed, instant) !== "usable") secrets.delete(linkId);
      }
      const entry = usable ? held(usable.id) : null;
      if (usable && entry) return { link: usable, secret: entry.secret };
      return await createInvite(albumId, role, signal);
    },
    heldSecret: (linkId) => held(linkId)?.secret ?? null,
    async revokeInvite(albumId, inviteLinkId, signal) {
      const receipt = await send("invites.revoke", { albumId, inviteLinkId }, signal, true);
      secrets.delete(inviteLinkId);
      return receipt.value;
    },
    async join(secret, signal) {
      return (await send("invites.join", { secret }, signal, true)).value;
    },
    listMembers(albumId, page, signal) {
      const request: SharingOperationMap["members.list"]["request"] = {
        albumId,
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
        ...(page.limit === undefined ? {} : { limit: page.limit }),
      };
      return send("members.list", request, signal, false);
    },
    async changeRole(albumId, membershipId, expectedRevision, role, signal) {
      return (await send("members.changeRole", { albumId, membershipId, expectedRevision, role }, signal, true)).value;
    },
    async removeMember(albumId, membershipId, signal) {
      return (await send("members.remove", { albumId, membershipId }, signal, true)).value;
    },
    async leave(albumId, signal) {
      const membership = (await send("members.leave", { albumId }, signal, true)).value;
      for (const [linkId, held] of secrets) if (held.albumId === albumId) secrets.delete(linkId);
      return membership;
    },
    forgetSecrets: () => secrets.clear(),
  };
}

/**
 * The contract's next step for a failure (`SHARING_ERROR_RECOVERY`). Local session failures mean signing in again;
 * a transport loss means replaying with the same key. null for aborts and unknown errors.
 */
export function sharingRecoveryOf(error: unknown): SharingRecovery | null {
  if (isSharingErrorEnvelope(error)) return SHARING_ERROR_RECOVERY[error.error.code];
  if (error instanceof PersonalPhotoCloudError) {
    if (error.code === "scope_changed" || error.code === "invalid_identity") return "reauthenticate";
    if (error.code === "unavailable") return "retrySameKey";
    if (error.code === "invalid_response") return "stop";
  }
  return null;
}

/** ms to wait before replaying with the same key, or null when the failure is not a lost/delayed answer. */
export function replayDelay(error: unknown, attempt: number, maxRetryAfterSeconds: number): number | null {
  if (isSharingErrorEnvelope(error)) {
    const { code, retryable, retryAfterSeconds } = error.error;
    if (!retryable || SHARING_ERROR_RECOVERY[code] !== "retrySameKey") return null;
    if (retryAfterSeconds !== undefined) return retryAfterSeconds <= maxRetryAfterSeconds ? retryAfterSeconds * 1000 : null;
    return RETRY_BASE_MS * attempt;
  }
  // fetch() rejects with TypeError on a network failure; the transport times out with `unavailable`.
  if (error instanceof PersonalPhotoCloudError) return error.code === "unavailable" ? RETRY_BASE_MS * attempt : null;
  if (error instanceof TypeError) return RETRY_BASE_MS * attempt;
  return null;
}

export async function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
