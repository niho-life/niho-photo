import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { createPhotoWebRuntime } from "../runtime/runtime.ts";
import type {
  CreatePhotoWebRuntimeOptions,
  PhotoWebRuntime,
  PhotoWebRuntimeSnapshot,
} from "../runtime/types.ts";
import { PhotoWebView } from "../view/PhotoWebView.tsx";
import { holdBrowserPendingInvite } from "@niho/photo-cloud-library/sharing";

import { clearPhotoWebInviteFragment, photoWebHeldInvite, readPhotoWebInviteSecret } from "./shared-albums.ts";
import type { PhotoWebViewCopy } from "../view/types.ts";

export interface MountPhotoWebOptions {
  readonly rootElement: HTMLElement;
  readonly runtimeOptions: CreatePhotoWebRuntimeOptions;
  readonly copy: PhotoWebViewCopy;
  readonly iconUrl: string;
  /** Hands an invite opened while signed out to the BFF (default: `invites.holdPending` on this origin). */
  readonly holdInvite?: (secret: string) => Promise<{ readonly expiresAt: string } | null>;
}

export interface MountedPhotoWeb {
  readonly runtime: PhotoWebRuntime;
  readonly ready: Promise<void>;
  dispose(): void;
}

const mountedRoots = new WeakMap<HTMLElement, object>();
/** The BFF holds an invite for 15 minutes (B00 `PENDING_INVITE_COOKIE`). */
const HELD_INVITE_LIFETIME_MS = 15 * 60 * 1000;

function validateOptions(options: MountPhotoWebOptions): HTMLElement {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Photo Web mount options are required");
  }

  const rootElement = options.rootElement;
  const currentDocument = globalThis.document;
  const ownerDocument = rootElement?.ownerDocument;
  const view = ownerDocument?.defaultView;
  if (typeof currentDocument === "undefined"
    || ownerDocument !== currentDocument
    || view === null
    || view === undefined
    || ownerDocument !== view.document
    || !(rootElement instanceof view.HTMLElement)
    || !rootElement.isConnected) {
    throw new TypeError("Photo Web rootElement must be attached to its current document");
  }
  if (typeof options.runtimeOptions !== "object" || options.runtimeOptions === null) {
    throw new TypeError("Photo Web runtimeOptions are required");
  }
  if (typeof options.copy !== "object" || options.copy === null) {
    throw new TypeError("Photo Web copy is required");
  }
  if (typeof options.iconUrl !== "string" || options.iconUrl.length === 0) {
    throw new TypeError("Photo Web iconUrl is required");
  }
  return rootElement;
}

function ignoreCleanupFailure(cleanup: (() => void) | null): void {
  if (cleanup === null) return;
  try {
    cleanup();
  } catch {
    // A later cleanup and the root ownership release are still authoritative.
  }
}

function sessionStorageOf(view: Window): Storage | null {
  try {
    return view.sessionStorage;
  } catch {
    return null;
  }
}

export function mountPhotoWeb(options: MountPhotoWebOptions): MountedPhotoWeb {
  const rootElement = validateOptions(options);
  if (mountedRoots.has(rootElement)) {
    throw new Error("Photo Web is already mounted on this rootElement");
  }

  const ownership = Object.freeze({});
  mountedRoots.set(rootElement, ownership);

  let runtime: PhotoWebRuntime | null = null;
  let root: Root | null = null;
  // Held in memory (never storage) and left in the address bar until the join has a definite answer.
  const view = rootElement.ownerDocument.defaultView;
  let inviteSecret = view ? readPhotoWebInviteSecret(view) : null;
  // Signed out, the secret goes to the BFF once; this tab keeps only the hold's expiry for after sign-in.
  const heldInvites = photoWebHeldInvite(view ? sessionStorageOf(view) : null);
  let inviteHeld = heldInvites.present();
  let holdStarted = false;
  // While the secret is on its way to the BFF it is not used for a direct join as well.
  let holdInFlight = false;
  const holdInvite = options.holdInvite ?? ((secret: string) => holdBrowserPendingInvite(secret));
  let unsubscribe: (() => void) | null = null;
  let disposed = false;

  const releaseOwnership = (): void => {
    if (mountedRoots.get(rootElement) === ownership) mountedRoots.delete(rootElement);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;

    const currentUnsubscribe = unsubscribe;
    unsubscribe = null;
    ignoreCleanupFailure(currentUnsubscribe);
    ignoreCleanupFailure(runtime === null ? null : () => runtime?.dispose());
    ignoreCleanupFailure(root === null ? null : () => root?.unmount());
    releaseOwnership();
  };

  try {
    runtime = createPhotoWebRuntime(options.runtimeOptions);
    root = createRoot(rootElement);

    const holdWhileSignedOut = (snapshot: PhotoWebRuntimeSnapshot): void => {
      const signedOut = snapshot.session.phase === "signed-out" || snapshot.session.phase === "expired";
      if (!signedOut || inviteSecret === null || holdStarted) return;
      // One attempt per page: a refused hold leaves the link in the address bar to open again after sign-in.
      holdStarted = true;
      holdInFlight = true;
      const secret = inviteSecret;
      // Written before sending: if the page leaves for sign-in before the answer, the hold may still reach the BFF.
      const provisional = !inviteHeld;
      if (provisional) heldInvites.mark(new Date(Date.now() + HELD_INVITE_LIFETIME_MS).toISOString());
      let holding: Promise<{ readonly expiresAt: string } | null>;
      try {
        holding = holdInvite(secret);
      } catch {
        holding = Promise.resolve(null);
      }
      void Promise.resolve(holding)
        .catch(() => null)
        .then((held) => {
          // Leaving the page (for sign-in): the provisional marker stays for the page that comes back.
          if (disposed) return;
          holdInFlight = false;
          if (held === null || inviteSecret !== secret) {
            if (provisional) heldInvites.clear();
            if (runtime !== null) render(runtime.getSnapshot());
            return;
          }
          heldInvites.mark(held.expiresAt);
          inviteHeld = true;
          inviteSecret = null;
          if (view) clearPhotoWebInviteFragment(view);
          if (runtime !== null) render(runtime.getSnapshot());
        });
    };

    const render = (snapshot: PhotoWebRuntimeSnapshot): void => {
      if (disposed || runtime === null || root === null) return;
      holdWhileSignedOut(snapshot);
      flushSync(() => {
        if (disposed || runtime === null || root === null) return;
        root.render(
          <PhotoWebView
            {...snapshot}
            copy={options.copy}
            iconUrl={options.iconUrl}
            invite={holdInFlight ? null : inviteSecret !== null ? { kind: "link", secret: inviteSecret } : inviteHeld ? { kind: "held" } : null}
            onInviteHandled={() => {
              // The link in the address bar is used first; a held invite after it.
              if (inviteSecret !== null) {
                inviteSecret = null;
                if (view) clearPhotoWebInviteFragment(view);
              } else if (inviteHeld) {
                inviteHeld = false;
                heldInvites.clear();
              } else return;
              if (runtime !== null) render(runtime.getSnapshot());
            }}
            onRetry={() => runtime?.retry() ?? Promise.resolve()}
            onLogout={() => runtime?.logout() ?? Promise.resolve()}
            registerRouteLeaveGuard={runtime.registerRouteLeaveGuard}
          />,
        );
      });
    };

    unsubscribe = runtime.subscribe(render);
    render(runtime.getSnapshot());

    let startResult: Promise<void>;
    try {
      startResult = Promise.resolve(runtime.start());
    } catch (error) {
      startResult = Promise.reject(error);
    }
    const ready = startResult.catch((error: unknown) => {
      dispose();
      throw error;
    });
    void ready.catch(() => undefined);

    return Object.freeze({ runtime, ready, dispose });
  } catch (error) {
    dispose();
    throw error;
  }
}
