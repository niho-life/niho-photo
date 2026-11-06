/**
 * Shared-album pieces of the Web host (B08 #249): the invite link format, reading it once from the address bar, saving
 * a photo as a download, and the per-actor "originals stay on this device" note.
 *
 * The invite secret travels in the URL fragment: a browser never sends a fragment to the server, so it is absent from
 * requests and server logs. It is read once, removed from the address bar and kept in memory only; the join request
 * carries it in its body.
 */
const INVITE_PREFIX = "#invite=";
const SECRET_PATTERN = /^[A-Za-z0-9_-]{16,512}$/u;
const NOTE_KEY_PREFIX = "niho-photo-web:shared-album-originals-note:v1:";

export function photoWebInviteUrl(origin: string, secret: string): string {
  return `${origin}/${INVITE_PREFIX}${encodeURIComponent(secret)}`;
}

/** The invite secret in the address bar, if any. The fragment is removed either way. */
export function takePhotoWebInviteSecret(target: { readonly location: Location; readonly history: History }): string | null {
  const hash = target.location.hash;
  if (!hash.startsWith(INVITE_PREFIX)) return null;
  try {
    target.history.replaceState(target.history.state, "", `${target.location.pathname}${target.location.search}`);
  } catch {
    // The secret is still used once and never stored.
  }
  let secret: string;
  try {
    secret = decodeURIComponent(hash.slice(INVITE_PREFIX.length));
  } catch {
    return null;
  }
  return SECRET_PATTERN.test(secret) ? secret : null;
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
