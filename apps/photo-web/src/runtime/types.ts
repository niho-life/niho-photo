import type { QueryClient } from "@tanstack/react-query";
import type {
  PhotoIdentity,
  PhotoSessionController,
  PhotoSessionHostBridge,
  PhotoSessionSnapshot,
} from "../../../../packages/photo-cloud-session/src/index.ts";
import type { PhotoEditingHost } from "niho-photo-editing/library/photo-library-context";

import type { PhotoWebViewBinding, PhotoWebViewProps } from "../view/types.ts";

export type ScopedPhotoWebEditingHost = PhotoEditingHost & {
  readonly scopeSignal: AbortSignal;
  readonly isScopeCurrent: () => boolean;
};

export interface PhotoWebConnection {
  getSnapshot(): Omit<PhotoWebViewBinding, "host">;
  subscribe(listener: (snapshot: Omit<PhotoWebViewBinding, "host">) => void): () => void;
  dispose(): void;
}

export interface PhotoWebRuntimeGuards {
  canLeave(
    identity: PhotoIdentity | null,
    options: { readonly release: boolean; readonly signal: AbortSignal },
  ): Promise<boolean>;
  hasPending(): boolean;
  onScopeRevoked(
    previous: PhotoIdentity,
    reason: "identity-changed" | "revoked" | "logout-complete" | "expired",
  ): void | Promise<void>;
}

export interface PhotoWebBroadcastChannel extends EventTarget {
  postMessage(message: unknown): void;
  close(): void;
}

export interface PhotoWebRuntimeEnvironment {
  readonly window: EventTarget & {
    readonly navigator?: { readonly onLine?: boolean };
    readonly location?: { readonly origin?: string; reload(): void };
  };
  readonly document: EventTarget & {
    readonly visibilityState: string;
    readonly body: { append(element: unknown): void };
    createElement(name: "a"): {
      href: string;
      download: string;
      click(): void;
      remove(): void;
    };
  };
  readonly urls: {
    createObjectURL(blob: Blob): string;
    revokeObjectURL(url: string): void;
  };
  readonly serviceWorker?: ServiceWorkerContainer;
  readonly createBroadcastChannel?: (name: string) => PhotoWebBroadcastChannel;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

export interface CreatePhotoWebRuntimeOptions {
  readonly enabled: boolean;
  readonly copy: { readonly failed: string };
  /** Browser-held download URLs only; this is not the photo library wire/storage quota. */
  readonly downloadBudget: {
    readonly maxBytes: number;
    readonly maxEntries: number;
  };
  readonly connect: (options: {
    readonly identity: PhotoIdentity;
    readonly signal: AbortSignal;
    readonly host: ScopedPhotoWebEditingHost;
    readonly session: PhotoSessionController;
    /** Notify only a known authentication rejection from the fixed Photo BFF. */
    readonly onAuthenticationRejected: () => void;
  }) => Promise<PhotoWebConnection>;
  readonly guards: PhotoWebRuntimeGuards;
  readonly cancelDialogs: () => void;
  readonly environment?: PhotoWebRuntimeEnvironment;
  readonly queryClient?: QueryClient;
  readonly sessionHost?: PhotoSessionHostBridge;
}

export interface PhotoWebRuntimeSnapshot {
  readonly session: PhotoSessionSnapshot;
  readonly binding: PhotoWebViewBinding | null;
  readonly dialogScopeKey: string;
  readonly online: boolean;
  readonly pwa: PhotoWebViewProps["pwa"];
  readonly queryClient: QueryClient;
}

export interface PhotoWebRuntime {
  getSnapshot(): PhotoWebRuntimeSnapshot;
  subscribe(listener: (snapshot: PhotoWebRuntimeSnapshot) => void): () => void;
  start(): Promise<void>;
  retry(): Promise<void>;
  logout(): Promise<void>;
  canLeave(options?: { readonly release?: boolean }): Promise<boolean>;
  registerRouteLeaveGuard: PhotoWebViewProps["registerRouteLeaveGuard"];
  dispose(): void;
}
