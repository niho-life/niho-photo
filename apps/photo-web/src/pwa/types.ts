/** C06 static artifact metadata only; never credentials, identity, URLs to photos, or persisted drafts. */
export interface PhotoStaticAsset {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly kind: "script" | "style" | "font" | "icon" | "engine" | "offline";
}
export interface PhotoStaticManifest {
  readonly schemaVersion: 1;
  readonly buildId: string;
  readonly assets: readonly PhotoStaticAsset[];
  /** Exact anonymous static HTML, never an authenticated/SSR response. */
  readonly offlinePath: string;
}
export type PhotoPwaUpdatePhase = "up-to-date" | "available" | "preparing" | "blocked" | "activating" | "failed" | "disposed";
export interface PhotoPwaUpdateSnapshot { readonly phase: PhotoPwaUpdatePhase }
export interface PhotoPwaUpdateOptions {
  readonly registration: ServiceWorkerRegistration;
  readonly serviceWorker: ServiceWorkerContainer;
  /** Actual page origin; only same-origin waiting worker messages are consumed. */
  readonly origin: string;
  /** C03/workbench guard: persist/confirm every pending edit/transfer before allowing activation. */
  readonly canLeave: () => Promise<boolean>;
  readonly reload: () => void;
}
export interface PhotoPwaUpdateController {
  getSnapshot(): PhotoPwaUpdateSnapshot;
  subscribe(listener: (snapshot: PhotoPwaUpdateSnapshot) => void): () => void;
  requestUpdate(): Promise<"applied" | "blocked" | "failed">;
  dispose(): void;
}
