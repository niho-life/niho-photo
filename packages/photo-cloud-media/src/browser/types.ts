import type { CloudRenderInput } from "../types.ts";

export interface MediaReadLimits {
  /** Explicit host budget, checked before allocating; no whole-original fallback. */
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

/** Memory only. Host must release it and dispose its engine on scope invalidation. */
export interface VerifiedMediaBytes {
  readonly bytes: ArrayBuffer;
  /** Idempotent; clear owned bytes/listeners. Abort clears them as well. */
  release(): void;
}

export interface LoadedCloudRenderInput extends VerifiedMediaBytes {
  readonly input: CloudRenderInput;
}
