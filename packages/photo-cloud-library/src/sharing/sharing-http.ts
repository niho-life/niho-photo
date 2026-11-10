/**
 * Same-origin HTTP core shared by the shared-album clients (B05 membership, B12 albums and items). It reuses the
 * personal v2 transport pieces rather than a second implementation: the verified-session scope fence
 * (`PersonalPhotoScope`, bound to the session only because albums span libraries), the capture headers, the header
 * deadline, the bounded JSON reader and the bounded content stream. Like the v2 client it never retries by itself;
 * the action layers replay with the same key.
 */
import { PersonalPhotoCloudError } from "../errors";
import { linkedAbortController } from "../await";
import { fetchWithHeaderDeadline, parseContentResponse, requestInit } from "../browser/client";
import { PersonalPhotoScope } from "../scope";
import type { PersonalPhotoCloudIdentity } from "../types";
import { JSON_LIMITS, readBoundedJson } from "../wire";

import type { PhotoByteRange, PhotoContent, SharingOperation, SharingSessionScope } from "./contract";
import { isSharingErrorEnvelope, parseSharingError, type EncodedSharingRequest } from "./membership-wire";

/** What one client sends: its operations, how they are encoded, and how answers are checked. */
export interface SharingWire<Op extends string> {
  supports(operation: string): operation is Op;
  encode(operation: Op, request: unknown, idempotencyKey: string | undefined): EncodedSharingRequest<Op>;
  responseLimit(operation: Op): number;
  validate(operation: Op, request: unknown, raw: unknown): unknown;
}

export interface CreateSharingHttpClientOptions {
  /** The verified session (the same identity the personal client uses). */
  readonly identity: PersonalPhotoCloudIdentity;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export interface SharingHttpClient<Op extends string> {
  readonly scope: SharingSessionScope;
  send(operation: Op, request: unknown, signal: AbortSignal, idempotencyKey: string | undefined): Promise<unknown>;
  /** A GET whose answer is a bounded content stream (the scope stays held until the stream ends or is cancelled). */
  stream(encoded: EncodedSharingRequest<SharingOperation>, range: PhotoByteRange | undefined, signal: AbortSignal): Promise<PhotoContent>;
  dispose(): void;
}

export function createSharingHttpClient<Op extends string>(options: CreateSharingHttpClientOptions, wire: SharingWire<Op>): SharingHttpClient<Op> {
  const actor = options.identity.getSnapshot();
  const now = options.now ?? Date.now;
  if (actor === null || actor.transport !== "browser-session" || Date.parse(actor.expiresAt) <= now()) {
    throw new PersonalPhotoCloudError("invalid_identity");
  }
  const fetchFn = options.fetch ?? ((...parameters: Parameters<typeof fetch>) => globalThis.fetch(...parameters));
  const lifecycle = new AbortController();
  let disposed = false;
  let scope: PersonalPhotoScope<null>;

  /** One request under the scope fence; `consume` decides whether the scope is released here or by a stream. */
  async function exchange<T>(
    encoded: EncodedSharingRequest<string>,
    range: string | null,
    signal: AbortSignal,
    consume: (response: Response, scoped: ReturnType<PersonalPhotoScope<null>["begin"]>, link: ReturnType<typeof linkedAbortController>) => Promise<{ readonly value: T; readonly ownsScope: boolean }>,
  ): Promise<T> {
    if (disposed) throw new PersonalPhotoCloudError("disposed");
    const scoped = scope.begin(signal);
    const link = linkedAbortController(scoped.signal, lifecycle.signal);
    let ownsScope = false;
    try {
      const capture = options.identity.getSnapshot();
      if (capture === null) throw new PersonalPhotoCloudError("scope_changed");
      const response = await fetchWithHeaderDeadline(
        fetchFn,
        encoded.path,
        requestInit(capture, encoded.method, encoded.body, range, encoded.idempotencyKey, link.controller.signal),
        scoped.signal,
        link.controller,
      );
      scoped.assertCurrent();
      if (response.status < 200 || response.status >= 300) {
        const { value } = await readBoundedJson(response, JSON_LIMITS.error, scoped.signal);
        throw parseSharingError(value, response.status);
      }
      const result = await consume(response, scoped, link);
      ownsScope = result.ownsScope;
      return result.value;
    } catch (error) {
      // The server no longer accepts this session: fence it so no further request uses the old scope.
      if (isSharingErrorEnvelope(error) && error.error.code === "unauthenticated") scope.invalidateAuthentication();
      throw error;
    } finally {
      if (!ownsScope) {
        link.dispose();
        scoped.release();
      }
    }
  }

  const client: SharingHttpClient<Op> = {
    scope: Object.freeze({ actorId: actor.userId, sessionEpoch: actor.sessionEpoch }),
    async send(operation, request, signal, idempotencyKey) {
      if (!wire.supports(operation)) throw new PersonalPhotoCloudError("unsupported");
      const encoded = wire.encode(operation, request, idempotencyKey);
      return await exchange(encoded, null, signal, async (response, scoped) => {
        if (response.status !== 200) throw new PersonalPhotoCloudError("invalid_response");
        const { value } = await readBoundedJson(response, wire.responseLimit(operation), scoped.signal);
        scoped.assertCurrent();
        return { value: wire.validate(operation, request, value), ownsScope: false };
      });
    },
    async stream(encoded, range, signal) {
      const header = range === undefined ? null : `bytes=${range.start}-${range.endInclusive ?? ""}`;
      return await exchange(encoded, header, signal, async (response, scoped, link) => ({
        value: await parseContentResponse(response, range === undefined ? {} : { range }, scoped as never, link.controller, link.dispose),
        ownsScope: true,
      }));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifecycle.abort(new PersonalPhotoCloudError("disposed"));
      scope.dispose();
    },
  };
  scope = new PersonalPhotoScope<null>(client, options.identity, now);
  return client;
}

/**
 * Where a shared client's requests go when it is not the browser session: e.g. the Mac app's native session, which
 * keeps the credential and upload tickets in native code. One exchange is one route of the table; the transport
 * returns the status and the parsed JSON (at most `limit` bytes) and never retries by itself.
 */
export interface SharingTransport {
  readonly scope: SharingSessionScope;
  exchange(encoded: EncodedSharingRequest<string>, limit: number, signal: AbortSignal): Promise<{ readonly status: number; readonly value: unknown }>;
  /** A GET whose answer is a bounded content stream. */
  stream(encoded: EncodedSharingRequest<SharingOperation>, range: PhotoByteRange | undefined, signal: AbortSignal): Promise<PhotoContent>;
  dispose(): void;
}

/** The same encode/validate as the browser client, on another transport. */
export function createSharingClientOnTransport<Op extends string>(transport: SharingTransport, wire: SharingWire<Op>): SharingHttpClient<Op> {
  let disposed = false;
  return {
    scope: transport.scope,
    async send(operation, request, signal, idempotencyKey) {
      if (disposed) throw new PersonalPhotoCloudError("disposed");
      if (!wire.supports(operation)) throw new PersonalPhotoCloudError("unsupported");
      const encoded = wire.encode(operation, request, idempotencyKey);
      const { status, value } = await transport.exchange(encoded, wire.responseLimit(operation), signal);
      if (status < 200 || status >= 300) throw parseSharingError(value, status);
      if (status !== 200) throw new PersonalPhotoCloudError("invalid_response");
      return wire.validate(operation, request, value);
    },
    async stream(encoded, range, signal) {
      if (disposed) throw new PersonalPhotoCloudError("disposed");
      return await transport.stream(encoded, range, signal);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      transport.dispose();
    },
  };
}
