import { REQUEST_TIMEOUT_MS, RESPONSE_MAX_BYTES } from "./protocol.ts";

export class ProducerRequestError extends Error {
  override readonly name = "ProducerRequestError";
  readonly kind: "unavailable" | "rejected";
  readonly status: number;

  constructor(kind: "unavailable" | "rejected", status: number) {
    super("photo authentication producer request failed");
    this.kind = kind;
    this.status = status;
  }
}

export interface ProducerTransportOptions {
  readonly fetch: typeof fetch;
  readonly origin: string;
  readonly setTimer?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

function rejectedStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403 || status === 409;
}

function cancelBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Cleanup failure must not replace the sanitized producer error.
  }
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.trim())) {
    cancelBody(response);
    throw new ProducerRequestError("unavailable", 502);
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > RESPONSE_MAX_BYTES)) {
    cancelBody(response);
    throw new ProducerRequestError("unavailable", 502);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new ProducerRequestError("unavailable", 502);
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  let rejectAbort: (() => void) | undefined;
  const abortGate = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new ProducerRequestError("unavailable", 503));
  });
  const abort = () => rejectAbort?.();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), abortGate]);
      if (chunk.done) {
        completed = true;
        break;
      }
      total += chunk.value.byteLength;
      if (total > RESPONSE_MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new ProducerRequestError("unavailable", 502);
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof ProducerRequestError) throw error;
    throw new ProducerRequestError("unavailable", 502);
  } finally {
    signal.removeEventListener("abort", abort);
    if (completed) reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProducerRequestError("unavailable", 502);
  }
}

export class ProducerTransport {
  readonly #fetch: typeof fetch;
  readonly #origin: string;
  readonly #setTimer: (callback: () => void, milliseconds: number) => unknown;
  readonly #clearTimer: (timer: unknown) => void;

  constructor(options: ProducerTransportOptions) {
    this.#fetch = options.fetch;
    this.#origin = options.origin;
    this.#setTimer = options.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  async post(path: string, body: unknown, callerSignal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    callerSignal?.addEventListener("abort", abort, { once: true });
    if (callerSignal?.aborted) controller.abort();
    const timer = this.#setTimer(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let rejectAbort: (() => void) | undefined;
    const abortGate = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new ProducerRequestError("unavailable", 503));
    });
    const rejectOnAbort = () => rejectAbort?.();
    controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
    if (controller.signal.aborted) rejectOnAbort();
    try {
      let response: Response;
      try {
        if (controller.signal.aborted) await abortGate;
        const fetchRequest = this.#fetch(`${this.#origin}${path}`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(body),
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        });
        response = await Promise.race([fetchRequest, abortGate]);
      } catch {
        throw new ProducerRequestError("unavailable", 503);
      }
      if (!response.ok) {
        cancelBody(response);
        throw new ProducerRequestError(rejectedStatus(response.status) ? "rejected" : "unavailable", response.status);
      }
      if (response.status === 204) {
        cancelBody(response);
        return null;
      }
      return await readBoundedJson(response, controller.signal);
    } finally {
      this.#clearTimer(timer);
      controller.signal.removeEventListener("abort", rejectOnAbort);
      callerSignal?.removeEventListener("abort", abort);
    }
  }
}
