/**
 * Shared-album pieces of the Web host (B08 #249): the invite link format, reading it once from the address bar, the
 * marker of an invite held by the BFF, saving a photo as a download, and the per-actor "originals stay on this device"
 * note.
 *
 * The invite secret travels in the URL fragment: a browser never sends a fragment to the server, so it is absent from
 * requests and server logs. It is read into memory (never storage) and left in the address bar until the join has a
 * definite answer, so a failed attempt or a reload can use the same link again; then it is removed. The join request
 * carries it in its body. Opened while signed out, it is handed to the BFF once (`invites.holdPending`), which keeps it
 * in an encrypted httpOnly cookie; this page keeps only the hold's expiry in session storage so that, back from sign-in,
 * it asks the BFF to join with what it holds.
 */
const INVITE_PREFIX = "#invite=";
const HELD_INVITE_KEY = "niho-photo-web:held-invite:v1";
const MAX_HELD_MS = 15 * 60 * 1000 + 60 * 1000;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{16,512}$/u;
const NOTE_KEY_PREFIX = "niho-photo-web:shared-album-originals-note:v1:";

export function photoWebInviteUrl(origin: string, secret: string): string {
  return `${origin}/${INVITE_PREFIX}${encodeURIComponent(secret)}`;
}

/** The invite secret in the address bar, if any (read only; a malformed one is removed). */
export function readPhotoWebInviteSecret(target: { readonly location: Location; readonly history: History }): string | null {
  const hash = target.location.hash;
  if (!hash.startsWith(INVITE_PREFIX)) return null;
  let secret: string | null = null;
  try {
    secret = decodeURIComponent(hash.slice(INVITE_PREFIX.length));
  } catch {
    secret = null;
  }
  if (secret !== null && SECRET_PATTERN.test(secret)) return secret;
  clearPhotoWebInviteFragment(target);
  return null;
}

/** Removes the invite from the address bar once it has a definite answer. */
export function clearPhotoWebInviteFragment(target: { readonly location: Location; readonly history: History }): void {
  if (!target.location.hash.startsWith(INVITE_PREFIX)) return;
  try {
    target.history.replaceState(target.history.state, "", `${target.location.pathname}${target.location.search}`);
  } catch {
    // Still used once from memory.
  }
}

/**
 * Whether this tab handed an invite to the BFF before signing in. Only the expiry is stored, never the secret; the BFF
 * alone can open what it holds.
 */
export function photoWebHeldInvite(storage: Storage | null = safeSessionStorage(), now: () => number = Date.now) {
  return {
    mark(expiresAt: string): void {
      try {
        storage?.setItem(HELD_INVITE_KEY, expiresAt);
      } catch {
        // Without storage the held invite is not used after sign-in; the link can be opened again.
      }
    },
    present(): boolean {
      let value: string | null = null;
      try {
        value = storage?.getItem(HELD_INVITE_KEY) ?? null;
      } catch {
        return false;
      }
      if (value === null) return false;
      const expiresAt = Date.parse(value);
      if (Number.isFinite(expiresAt) && expiresAt > now() && expiresAt - now() <= MAX_HELD_MS) return true;
      this.clear();
      return false;
    },
    clear(): void {
      try {
        storage?.removeItem(HELD_INVITE_KEY);
      } catch {
        // Expires on its own.
      }
    },
  };
}

/** Saves one photo as a browser download (iPhone Safari offers it to Photos from the download). */
export async function savePhotoWebDownload(name: string, file: Blob): Promise<void> {
  const url = URL.createObjectURL(file);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // The download has started from the click; release the URL after the event loop turns.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Whether the "originals stay on this device" note was shown to this actor on this browser. */
export function photoWebOriginalsNote(actorId: string, storage: Storage | null = safeLocalStorage()) {
  const key = `${NOTE_KEY_PREFIX}${fnv1a(actorId)}`;
  let shown = false;
  return {
    shown(): boolean {
      if (shown) return true;
      try {
        shown = storage?.getItem(key) === "1";
      } catch {
        // Unavailable storage: show it again next time.
      }
      return shown;
    },
    markShown(): void {
      shown = true;
      try {
        storage?.setItem(key, "1");
      } catch {
        // Kept for this page only.
      }
    },
  };
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** A short non-reversible key so the user ID itself is not written to storage. */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
