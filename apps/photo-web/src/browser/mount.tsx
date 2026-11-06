import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { createPhotoWebRuntime } from "../runtime/runtime.ts";
import type {
  CreatePhotoWebRuntimeOptions,
  PhotoWebRuntime,
  PhotoWebRuntimeSnapshot,
} from "../runtime/types.ts";
import { PhotoWebView } from "../view/PhotoWebView.tsx";
import { takePhotoWebInviteSecret } from "./shared-albums.ts";
import type { PhotoWebViewCopy } from "../view/types.ts";

export interface MountPhotoWebOptions {
  readonly rootElement: HTMLElement;
  readonly runtimeOptions: CreatePhotoWebRuntimeOptions;
  readonly copy: PhotoWebViewCopy;
  readonly iconUrl: string;
}

export interface MountedPhotoWeb {
  readonly runtime: PhotoWebRuntime;
  readonly ready: Promise<void>;
  dispose(): void;
}

const mountedRoots = new WeakMap<HTMLElement, object>();

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

export function mountPhotoWeb(options: MountPhotoWebOptions): MountedPhotoWeb {
  const rootElement = validateOptions(options);
  if (mountedRoots.has(rootElement)) {
    throw new Error("Photo Web is already mounted on this rootElement");
  }

  const ownership = Object.freeze({});
  mountedRoots.set(rootElement, ownership);

  let runtime: PhotoWebRuntime | null = null;
  let root: Root | null = null;
  // Read once and removed from the address bar; held in memory until a shared-album session uses it.
  let inviteSecret = rootElement.ownerDocument.defaultView ? takePhotoWebInviteSecret(rootElement.ownerDocument.defaultView) : null;
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

    const render = (snapshot: PhotoWebRuntimeSnapshot): void => {
      if (disposed || runtime === null || root === null) return;
      flushSync(() => {
        if (disposed || runtime === null || root === null) return;
        root.render(
          <PhotoWebView
            {...snapshot}
            copy={options.copy}
            iconUrl={options.iconUrl}
            inviteSecret={inviteSecret}
            onInviteHandled={() => {
              if (inviteSecret === null) return;
              inviteSecret = null;
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
