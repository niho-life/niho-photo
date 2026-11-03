import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export interface PhotoWebNodeServerLimits {
  readonly maxActiveRequests?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly requestTimeoutMs?: number;
}

export interface CreatePhotoWebNodeServerOptions {
  readonly enabled: boolean;
  /** Trusted, canonical HTTPS origin. The caller should bind the returned server to loopback by default. */
  readonly origin: string;
  readonly handler: (request: Request) => Promise<Response>;
  readonly limits?: PhotoWebNodeServerLimits;
}

type Limits = {
  readonly maxActiveRequests: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly requestTimeoutMs: number;
};

type Configuration = {
  readonly origin: string;
  readonly host: string;
  readonly handler: (request: Request) => Promise<Response>;
  readonly limits: Limits;
};

type AbortKind = "body_error" | "client" | "deadline" | "request_too_large";
type HandlerOutcome =
  | { readonly kind: "response"; readonly response: Response }
  | { readonly kind: "error" };
type ReadOutcome =
  | { readonly kind: "chunk"; readonly value: ReadableStreamReadResult<Uint8Array> }
  | { readonly kind: "error" };

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_HEADER_COUNT = 64;
const MAX_TARGET_BYTES = 8192;
const SUPPORTED_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const STOPPED_INCOMING = new WeakSet<IncomingMessage>();
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const DEFAULT_LIMITS: Limits = Object.freeze({
  maxActiveRequests: 16,
  maxRequestBytes: 64 * MIB,
  maxResponseBytes: 64 * MIB,
  requestTimeoutMs: 120_000,
});

// These are adapter ceilings only. C08/C02 must provide the real accepted transfer limits;
// accepting bytes here does not promise any format, cloud operation, or downstream capability.
const LIMIT_CEILINGS: Limits = Object.freeze({
  maxActiveRequests: 64,
  maxRequestBytes: 5 * GIB,
  maxResponseBytes: 5 * GIB,
  requestTimeoutMs: 10 * 60_000,
});

const ERROR_DETAILS: Readonly<Record<number, readonly [string, string]>> = Object.freeze({
  400: ["Bad Request", "bad_request"],
  405: ["Method Not Allowed", "method_not_allowed"],
  413: ["Payload Too Large", "payload_too_large"],
  503: ["Service Unavailable", "temporarily_unavailable"],
});

function positiveSafeInteger(value: unknown, fallback: number, maximum: number): number | null {
  const candidate = value === undefined ? fallback : value;
  return Number.isSafeInteger(candidate) && (candidate as number) > 0 && (candidate as number) <= maximum
    ? candidate as number
    : null;
}

function configuration(options: CreatePhotoWebNodeServerOptions): Configuration | null {
  try {
    if (options === null || typeof options !== "object" || options.enabled !== true || typeof options.handler !== "function"
      || typeof options.origin !== "string") return null;
    const parsed = new URL(options.origin);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/"
      || parsed.search !== "" || parsed.hash !== "" || options.origin !== parsed.origin) return null;
    const rawLimits = options.limits;
    if (rawLimits !== undefined && (rawLimits === null || typeof rawLimits !== "object" || Array.isArray(rawLimits))) return null;
    const maxActiveRequests = positiveSafeInteger(rawLimits?.maxActiveRequests, DEFAULT_LIMITS.maxActiveRequests,
      LIMIT_CEILINGS.maxActiveRequests);
    const maxRequestBytes = positiveSafeInteger(rawLimits?.maxRequestBytes, DEFAULT_LIMITS.maxRequestBytes,
      LIMIT_CEILINGS.maxRequestBytes);
    const maxResponseBytes = positiveSafeInteger(rawLimits?.maxResponseBytes, DEFAULT_LIMITS.maxResponseBytes,
      LIMIT_CEILINGS.maxResponseBytes);
    const requestTimeoutMs = positiveSafeInteger(rawLimits?.requestTimeoutMs, DEFAULT_LIMITS.requestTimeoutMs,
      LIMIT_CEILINGS.requestTimeoutMs);
    if (maxActiveRequests === null || maxRequestBytes === null || maxResponseBytes === null || requestTimeoutMs === null) return null;
    return Object.freeze({
      origin: parsed.origin,
      host: parsed.host,
      handler: options.handler,
      limits: Object.freeze({ maxActiveRequests, maxRequestBytes, maxResponseBytes, requestTimeoutMs }),
    });
  } catch {
    return null;
  }
}

function errorBody(status: number): Buffer {
  const error = ERROR_DETAILS[status]?.[1] ?? "temporarily_unavailable";
  return Buffer.from(`${JSON.stringify({ error })}\n`, "utf8");
}

function sendFailure(response: ServerResponse, status: number, head: boolean, close = false): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    destroyOutgoing(response);
    return;
  }
  const body = errorBody(status);
  if (close) response.shouldKeepAlive = false;
  try {
    response.writeHead(status, ERROR_DETAILS[status]?.[0] ?? "Service Unavailable", {
      "Cache-Control": "no-store",
      "Content-Length": String(body.byteLength),
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(head ? undefined : body);
  } catch {
    destroyOutgoing(response);
  }
}

function writeSocketFailure(socket: Duplex, status = 400): void {
  if (!socket.writable || socket.destroyed) {
    socket.destroy();
    return;
  }
  const body = errorBody(status);
  const reason = ERROR_DETAILS[status]?.[0] ?? "Bad Request";
  const headers = `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: ${body.byteLength}\r\nContent-Type: application/json; charset=utf-8\r\nX-Content-Type-Options: nosniff\r\n\r\n`;
  socket.end(Buffer.concat([Buffer.from(headers, "ascii"), body]));
}

function connectionTokens(value: string | null): Set<string> | null {
  const tokens = new Set<string>();
  if (value === null) return tokens;
  for (const item of value.split(",")) {
    const token = item.trim().toLowerCase();
    if (token.length === 0 || !TOKEN.test(token)) return null;
    tokens.add(token);
  }
  return tokens;
}

function decimalValue(value: string): number | null {
  if (!DECIMAL.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

function isForwardingHeader(name: string): boolean {
  return name === "forwarded" || name.startsWith("x-forwarded-");
}

function destroyOutgoing(response: ServerResponse): void {
  try {
    response.destroy();
  } catch {
    // A transport teardown must not escape into the process event loop.
  }
}

function validTarget(target: string): boolean {
  if (target.length === 0 || Buffer.byteLength(target, "utf8") > MAX_TARGET_BYTES || !target.startsWith("/")
    || target.includes("\\") || target.includes("#")
    || /[^\x20-\x7e]/u.test(target) || /%(?![0-9A-Fa-f]{2})/u.test(target)
    || /%(?:0[0-9A-Fa-f]|1[0-9A-Fa-f]|7[Ff])/u.test(target)) return false;
  const pathname = target.split("?", 1)[0] as string;
  if (pathname.includes("//")) return false;
  for (const segment of pathname.split("/")) {
    const dots = segment.replace(/%2e/giu, ".");
    if (dots === "." || dots === "..") return false;
  }
  return true;
}

type RequestMetadata = {
  readonly headers: Headers;
  readonly contentLength: number | null;
  readonly hasTransferEncoding: boolean;
};

function requestMetadata(request: IncomingMessage, expectedHost: string): RequestMetadata | null {
  const raw = request.rawHeaders;
  if (raw.length % 2 !== 0 || raw.length / 2 > MAX_HEADER_COUNT) return null;
  let bytes = 0;
  let host: string | null = null;
  let hostCount = 0;
  let contentLengthRaw: string | null = null;
  let contentLengthCount = 0;
  let transferEncodingCount = 0;
  let transferEncodingValue: string | null = null;
  const pairs: [string, string][] = [];
  const connectionValues: string[] = [];
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index];
    const value = raw[index + 1];
    if (name === undefined || value === undefined) return null;
    bytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") + 4;
    if (bytes > MAX_HEADER_BYTES) return null;
    const lower = name.toLowerCase();
    if (lower === "host") {
      hostCount += 1;
      host = value;
    } else if (lower === "content-length") {
      contentLengthCount += 1;
      contentLengthRaw = value;
    } else if (lower === "transfer-encoding") {
      transferEncodingCount += 1;
      transferEncodingValue = value;
    } else if (lower === "connection") {
      connectionValues.push(value);
    }
    pairs.push([name, value]);
  }
  if (hostCount !== 1 || host === null || host.toLowerCase() !== expectedHost.toLowerCase()
    || contentLengthCount > 1 || transferEncodingCount > 1 || (contentLengthCount > 0 && transferEncodingCount > 0)) return null;
  const contentLength = contentLengthRaw === null ? null : decimalValue(contentLengthRaw);
  if (contentLengthRaw !== null && contentLength === null) return null;
  const named = connectionTokens(connectionValues.length === 0 ? null : connectionValues.join(","));
  if (named === null || (transferEncodingValue !== null && transferEncodingValue.toLowerCase() !== "chunked")
    || named.has("host") || named.has("content-length") || named.has("origin") || named.has("cookie")) return null;
  const headers = new Headers();
  try {
    for (const [name, value] of pairs) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || isForwardingHeader(lower) || named.has(lower)) continue;
      headers.append(name, value);
    }
  } catch {
    return null;
  }
  return { headers, contentLength, hasTransferEncoding: transferEncodingCount > 0 };
}

function cancelRequestBody(request: Request): void {
  try {
    const pending = request.body?.cancel();
    if (pending !== undefined) void pending.catch(() => undefined);
  } catch {
    // A locked or already-failed body must not block transport cleanup.
  }
}

function cancelResponseBody(response: Response): void {
  try {
    const pending = response.body?.cancel();
    if (pending !== undefined) void pending.catch(() => undefined);
  } catch {
    // A hostile cleanup hook never controls the adapter.
  }
}

function stopIncoming(incoming: IncomingMessage): void {
  if (STOPPED_INCOMING.has(incoming)) return;
  STOPPED_INCOMING.add(incoming);
  incoming.pause();
  if (incoming.destroyed) return;
  const ignoreError = (): void => {};
  const closed = (): void => { incoming.removeListener("error", ignoreError); };
  incoming.once("error", ignoreError);
  incoming.once("close", closed);
}

type RequestBodySource = {
  readonly stream: ReadableStream<Uint8Array>;
  stop(): void;
};

function requestBodyStream(
  incoming: IncomingMessage,
  expectedLength: number | null,
  maximum: number,
  fail: (kind: AbortKind) => void,
): RequestBodySource {
  const iterator = incoming.iterator({ destroyOnReturn: false });
  let total = 0;
  let finished = false;
  let stopped = false;
  let failBody: (() => void) | null = null;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    finished = true;
    const fail = failBody;
    failBody = null;
    fail?.();
    stopIncoming(incoming);
    try {
      const pending = iterator.return?.();
      if (pending !== undefined) void pending.catch(() => undefined);
    } catch {
      // The non-destructive iterator cleanup is best effort and never awaited.
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      failBody = () => controller.error(new Error("request body cancelled"));
    },
    async pull(controller) {
      if (finished) return;
      try {
        const item = await iterator.next();
        if (item.done === true) {
          finished = true;
          failBody = null;
          if (expectedLength !== null && total !== expectedLength) {
            fail("body_error");
            controller.error(new Error("invalid request body"));
            return;
          }
          controller.close();
          return;
        }
        const chunk = item.value;
        if (!(chunk instanceof Uint8Array)) throw new Error("invalid request chunk");
        total += chunk.byteLength;
        if (total > maximum || (expectedLength !== null && total > expectedLength)) {
          finished = true;
          fail("request_too_large");
          stop();
          return;
        }
        controller.enqueue(chunk);
      } catch {
        if (!finished) {
          finished = true;
          failBody = null;
          fail("body_error");
          controller.error(new Error("invalid request body"));
        }
      }
    },
    cancel() {
      stop();
    },
  }, { highWaterMark: 0 });
  return { stream, stop };
}

type ResponseMetadata = {
  readonly headers: readonly (readonly [string, string])[];
  readonly contentLength: number | null;
};

function responseMetadata(response: Response, maximum: number, ignoreBody: boolean): ResponseMetadata | null {
  const pairs: [string, string][] = [];
  let count = 0;
  let bytes = 0;
  let contentLength: number | null = null;
  try {
    const connection = response.headers.get("connection");
    const named = connectionTokens(connection);
    if (named === null) return null;
    for (const [name, value] of response.headers) {
      const lower = name.toLowerCase();
      if (lower === "set-cookie") continue;
      if (lower === "content-length") {
        contentLength = decimalValue(value);
        if (contentLength === null || contentLength > maximum) return null;
        if (ignoreBody && response.status === 204) continue;
      }
      if (HOP_BY_HOP.has(lower) || named.has(lower) || lower.startsWith("access-control-")) continue;
      count += 1;
      bytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") + 4;
      if (count > MAX_HEADER_COUNT || bytes > MAX_HEADER_BYTES) return null;
      pairs.push([name, value]);
    }
    for (const cookie of response.headers.getSetCookie()) {
      count += 1;
      bytes += Buffer.byteLength("set-cookie", "ascii") + Buffer.byteLength(cookie, "utf8") + 4;
      if (count > MAX_HEADER_COUNT || bytes > MAX_HEADER_BYTES || /[\r\n\u0000]/u.test(cookie)) return null;
      pairs.push(["set-cookie", cookie]);
    }
  } catch {
    return null;
  }
  return { headers: pairs, contentLength };
}

function waitForDrain(response: ServerResponse, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      response.removeListener("drain", drained);
      response.removeListener("close", closed);
      response.removeListener("error", closed);
      signal.removeEventListener("abort", aborted);
      resolve(result);
    };
    const drained = (): void => { finish(true); };
    const closed = (): void => { finish(false); };
    const aborted = (): void => { finish(false); };
    response.once("drain", drained);
    response.once("close", closed);
    response.once("error", closed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function endResponse(response: ServerResponse, signal: AbortSignal): Promise<boolean> {
  if (response.writableFinished) return Promise.resolve(true);
  if (response.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      response.removeListener("finish", finished);
      response.removeListener("close", closed);
      response.removeListener("error", closed);
      signal.removeEventListener("abort", aborted);
      resolve(result);
    };
    const finished = (): void => { finish(true); };
    const closed = (): void => { finish(false); };
    const aborted = (): void => {
      destroyOutgoing(response);
      finish(false);
    };
    response.once("finish", finished);
    response.once("close", closed);
    response.once("error", closed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) {
      aborted();
      return;
    }
    if (!response.writableEnded) response.end();
  });
}

async function sendFailureAndWait(response: ServerResponse, status: number, head: boolean, signal: AbortSignal): Promise<void> {
  sendFailure(response, status, head);
  await endResponse(response, signal);
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    const pending = reader.cancel();
    void pending.catch(() => undefined);
  } catch {
    // Cancellation is bounded by the transport, never by the producer.
  }
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    // A failed/pending read may already have released the lock.
  }
}

async function pumpResponse(
  source: Response,
  outgoing: ServerResponse,
  requestMethod: string,
  maximum: number,
  signal: AbortSignal,
): Promise<void> {
  let status: number;
  let body: ReadableStream<Uint8Array> | null;
  let bodyUsed: boolean;
  let type: ResponseType;
  try {
    status = source.status;
    body = source.body;
    bodyUsed = source.bodyUsed;
    type = source.type;
  } catch {
    await sendFailureAndWait(outgoing, 503, requestMethod === "HEAD", signal);
    return;
  }
  if (type === "error" || status < 200 || status > 599 || bodyUsed) {
    cancelResponseBody(source);
    await sendFailureAndWait(outgoing, 503, requestMethod === "HEAD", signal);
    return;
  }
  const ignoreBody = requestMethod === "HEAD" || status === 204 || status === 304;
  const metadata = responseMetadata(source, maximum, ignoreBody);
  if (metadata === null) {
    cancelResponseBody(source);
    await sendFailureAndWait(outgoing, 503, requestMethod === "HEAD", signal);
    return;
  }
  if (ignoreBody) {
    cancelResponseBody(source);
    try {
      outgoing.writeHead(status, metadata.headers.flat());
    } catch {
      await sendFailureAndWait(outgoing, 503, requestMethod === "HEAD", signal);
      return;
    }
    await endResponse(outgoing, signal);
    return;
  }
  if (body === null) {
    if (metadata.contentLength !== null && metadata.contentLength !== 0) {
      await sendFailureAndWait(outgoing, 503, false, signal);
      return;
    }
    try {
      outgoing.writeHead(status, metadata.headers.flat());
    } catch {
      await sendFailureAndWait(outgoing, 503, false, signal);
      return;
    }
    await endResponse(outgoing, signal);
    return;
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch {
    cancelResponseBody(source);
    await sendFailureAndWait(outgoing, 503, false, signal);
    return;
  }
  try {
    outgoing.writeHead(status, metadata.headers.flat());
    let total = 0;
    while (!signal.aborted) {
      const pendingRead: Promise<ReadOutcome> = reader.read().then(
        (value) => ({ kind: "chunk", value }),
        () => ({ kind: "error" }),
      );
      const outcome = await Promise.race([
        pendingRead,
        new Promise<ReadOutcome>((resolve) => {
          const aborted = (): void => { resolve({ kind: "error" }); };
          signal.addEventListener("abort", aborted, { once: true });
          void pendingRead.finally(() => { signal.removeEventListener("abort", aborted); });
        }),
      ]);
      if (signal.aborted) {
        cancelReader(reader);
        destroyOutgoing(outgoing);
        void pendingRead.then(() => undefined, () => undefined);
        return;
      }
      if (outcome.kind === "error") {
        cancelReader(reader);
        destroyOutgoing(outgoing);
        return;
      }
      if (outcome.value.done) {
        if (metadata.contentLength !== null && total !== metadata.contentLength) {
          destroyOutgoing(outgoing);
          return;
        }
        await endResponse(outgoing, signal);
        return;
      }
      const chunk = outcome.value.value;
      if (!(chunk instanceof Uint8Array)) {
        cancelReader(reader);
        destroyOutgoing(outgoing);
        return;
      }
      total += chunk.byteLength;
      if (total > maximum || (metadata.contentLength !== null && total > metadata.contentLength)) {
        cancelReader(reader);
        destroyOutgoing(outgoing);
        return;
      }
      if (chunk.byteLength > 0 && !outgoing.write(chunk) && !await waitForDrain(outgoing, signal)) {
        cancelReader(reader);
        destroyOutgoing(outgoing);
        return;
      }
    }
    cancelReader(reader);
    destroyOutgoing(outgoing);
  } catch {
    cancelReader(reader);
    if (signal.aborted) destroyOutgoing(outgoing);
    else await sendFailureAndWait(outgoing, 503, false, signal);
  } finally {
    releaseReader(reader);
  }
}

export function createPhotoWebNodeServer(options: CreatePhotoWebNodeServerOptions): Server {
  const config = configuration(options);
  let active = 0;
  const requestTimeout = config?.limits.requestTimeoutMs ?? DEFAULT_LIMITS.requestTimeoutMs;
  const server = createServer({
    headersTimeout: requestTimeout,
    maxHeaderSize: MAX_HEADER_BYTES,
    requestTimeout,
    requireHostHeader: true,
  });
  // Keep every raw field available for the stricter manual count/duplicate checks above.
  server.maxHeadersCount = 0;
  // Bound sockets that have not yet supplied complete request headers, too.
  server.maxConnections = Math.max(8, (config?.limits.maxActiveRequests ?? DEFAULT_LIMITS.maxActiveRequests) * 4);
  server.maxRequestsPerSocket = 100;

  server.on("request", (incoming, outgoing) => {
    let transportAbort: (() => void) | null = null;
    const onOutgoingError = (): void => { transportAbort?.(); };
    const removeOutgoingError = (): void => { outgoing.removeListener("error", onOutgoingError); };
    outgoing.on("error", onOutgoingError);
    outgoing.once("close", removeOutgoingError);
    const method = incoming.method ?? "";
    const head = method === "HEAD";
    if (config === null) {
      sendFailure(outgoing, 503, head, true);
      stopIncoming(incoming);
      return;
    }
    if (!SUPPORTED_METHODS.has(method)) {
      outgoing.setHeader("Allow", [...SUPPORTED_METHODS].join(", "));
      sendFailure(outgoing, 405, head, true);
      stopIncoming(incoming);
      return;
    }
    const target = incoming.url;
    if (target === undefined || !validTarget(target)) {
      sendFailure(outgoing, 400, head, true);
      stopIncoming(incoming);
      return;
    }
    const metadata = requestMetadata(incoming, config.host);
    if (metadata === null) {
      sendFailure(outgoing, 400, head, true);
      stopIncoming(incoming);
      return;
    }
    if ((method === "GET" || method === "HEAD")
      && (metadata.hasTransferEncoding || (metadata.contentLength !== null && metadata.contentLength > 0))) {
      sendFailure(outgoing, 400, head, true);
      stopIncoming(incoming);
      return;
    }
    if (metadata.contentLength !== null && metadata.contentLength > config.limits.maxRequestBytes) {
      sendFailure(outgoing, 413, head, true);
      stopIncoming(incoming);
      return;
    }
    if (active >= config.limits.maxActiveRequests) {
      sendFailure(outgoing, 503, head, true);
      stopIncoming(incoming);
      return;
    }

    active += 1;
    const controller = new AbortController();
    let abortKind: AbortKind | null = null;
    let cleaned = false;
    const abort = (kind: AbortKind): void => {
      if (abortKind !== null) return;
      abortKind = kind;
      controller.abort();
    };
    transportAbort = (): void => { abort("client"); };
    const onAborted = (): void => { abort("client"); };
    const onRequestError = (): void => { abort("body_error"); };
    const onRequestClose = (): void => { if (!incoming.complete) abort("client"); };
    const onResponseClose = (): void => { if (!outgoing.writableFinished) abort("client"); };
    const timer = setTimeout(() => { abort("deadline"); }, config.limits.requestTimeoutMs);
    timer.unref();
    incoming.once("aborted", onAborted);
    incoming.once("error", onRequestError);
    incoming.once("close", onRequestClose);
    outgoing.once("close", onResponseClose);

    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      incoming.removeListener("aborted", onAborted);
      incoming.removeListener("error", onRequestError);
      incoming.removeListener("close", onRequestClose);
      outgoing.removeListener("close", onResponseClose);
      transportAbort = null;
    };

    let request: Request;
    let requestBody: RequestBodySource | null = null;
    try {
      const hasBody = method !== "GET" && method !== "HEAD"
        && (metadata.hasTransferEncoding || (metadata.contentLength !== null && metadata.contentLength > 0));
      if (hasBody) requestBody = requestBodyStream(incoming, metadata.contentLength, config.limits.maxRequestBytes, abort);
      const init: RequestInit & { duplex?: "half" } = { method, headers: metadata.headers, signal: controller.signal };
      if (requestBody !== null) {
        init.body = requestBody.stream;
        init.duplex = "half";
      }
      request = new Request(`${config.origin}${target}`, init);
    } catch {
      requestBody?.stop();
      cleanup();
      active -= 1;
      sendFailure(outgoing, 400, head, true);
      stopIncoming(incoming);
      return;
    }

    const handlerOutcome: Promise<HandlerOutcome> = Promise.resolve().then(() => config.handler(request)).then(
      (response) => response instanceof Response ? { kind: "response", response } : { kind: "error" },
      () => ({ kind: "error" }),
    );
    const aborted = new Promise<HandlerOutcome>((resolve) => {
      const finish = (): void => { resolve({ kind: "error" }); };
      controller.signal.addEventListener("abort", finish, { once: true });
      void handlerOutcome.finally(() => { controller.signal.removeEventListener("abort", finish); });
      if (controller.signal.aborted) finish();
    });

    void (async () => {
      try {
        const outcome = await Promise.race([handlerOutcome, aborted]);
        if (controller.signal.aborted) {
          requestBody?.stop();
          cleanup();
          if (abortKind === "deadline") sendFailure(outgoing, 503, head, true);
          else if (abortKind === "request_too_large") sendFailure(outgoing, 413, head, true);
          else if (abortKind === "body_error") sendFailure(outgoing, 400, head, true);
          else destroyOutgoing(outgoing);
          const late = await handlerOutcome;
          if (late.kind === "response") cancelResponseBody(late.response);
          return;
        }
        if (outcome.kind === "error") {
          await sendFailureAndWait(outgoing, 503, head, controller.signal);
          return;
        }
        if (!incoming.readableEnded && request.body !== null) {
          outgoing.shouldKeepAlive = false;
          requestBody?.stop();
          cancelRequestBody(request);
        }
        await pumpResponse(outcome.response, outgoing, method, config.limits.maxResponseBytes, controller.signal);
      } catch {
        if (controller.signal.aborted) destroyOutgoing(outgoing);
        else await sendFailureAndWait(outgoing, 503, head, controller.signal);
      } finally {
        cleanup();
        active -= 1;
      }
    })().catch(() => { destroyOutgoing(outgoing); });
  });

  server.on("clientError", (_error, socket) => { writeSocketFailure(socket); });
  server.on("connect", (_request, socket) => { writeSocketFailure(socket, 405); });
  server.on("upgrade", (_request, socket) => { writeSocketFailure(socket); });
  return server;
}
