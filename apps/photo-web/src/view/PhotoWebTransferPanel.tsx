import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import type { PersonalPhotoTransferStatus } from "../../../../packages/photo-cloud-library/src/browser/index.ts";
import type { PhotoWebTransferBinding } from "./types";

const PAGE_LIMIT = 16;
const TERMINAL_PHASES = new Set<PersonalPhotoTransferStatus["phase"]>([
  "done",
  "pending-recipe",
  "cancelled",
  "expired",
  "rejected",
  "purged",
  "failed",
]);

export type PhotoWebTransferHost = {
  readonly scopeSignal: AbortSignal;
  readonly isScopeCurrent: () => boolean;
};

type TransferRow = Pick<
  PersonalPhotoTransferStatus,
  "intentId" | "phase" | "fileName" | "format" | "sizeBytes" | "uploadedBytes" | "failure"
>;

type PageState = {
  readonly owner: PhotoWebTransferBinding;
  readonly items: readonly TransferRow[];
  readonly cursor: string | null;
  readonly nextCursor: string | null;
  readonly loading: boolean;
};

type Lifecycle = {
  readonly owner: PhotoWebTransferBinding;
  readonly controller: AbortController;
};

export interface PhotoWebTransferPanelProps {
  readonly transfer: PhotoWebTransferBinding;
  readonly host: PhotoWebTransferHost;
  readonly mutationEnabled: boolean;
}

function rowFromStatus(status: PersonalPhotoTransferStatus): TransferRow {
  return {
    intentId: status.intentId,
    phase: status.phase,
    fileName: status.fileName,
    format: status.format,
    sizeBytes: status.sizeBytes,
    uploadedBytes: status.uploadedBytes,
    failure: status.failure,
  };
}

function fileExtension(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  return index <= 0 || index === fileName.length - 1 ? "" : fileName.slice(index + 1).toLowerCase();
}

function safeScopeCurrent(lifecycle: Lifecycle, host: PhotoWebTransferHost): boolean {
  if (lifecycle.controller.signal.aborted || host.scopeSignal.aborted) return false;
  try {
    return host.isScopeCurrent() === true;
  } catch {
    return false;
  }
}

export function PhotoWebTransferPanel(props: PhotoWebTransferPanelProps) {
  const { transfer, host } = props;
  const [page, setPage] = useState<PageState>(() => ({
    owner: transfer,
    items: [],
    cursor: null,
    nextCursor: null,
    loading: false,
  }));
  const [activeOwner, setActiveOwner] = useState<PhotoWebTransferBinding | null>(null);
  const [message, setMessage] = useState<{ readonly owner: PhotoWebTransferBinding; readonly value: string } | null>(null);
  const [scopeRevoked, setScopeRevoked] = useState(false);
  const lifecycleRef = useRef<Lifecycle | null>(null);
  const mutationEnabledRef = useRef(props.mutationEnabled);
  const pageCursorRef = useRef<string | null>(null);
  const pageRequestRef = useRef<object | null>(null);
  const needsFileRowsRef = useRef(new Map<string, TransferRow>());
  const waitingForAuthorityRef = useRef(false);
  const activeRef = useRef<{ readonly owner: PhotoWebTransferBinding; readonly token: object } | null>(null);
  const addInputRef = useRef<HTMLInputElement | null>(null);
  const resumeInputRefs = useRef(new Map<string, HTMLInputElement>());

  mutationEnabledRef.current = props.mutationEnabled;

  const extensionDetails = useMemo(() => {
    const formats = new Map<string, PersonalPhotoTransferStatus["format"]>();
    const entries: string[] = [];
    for (const capability of transfer.formats) {
      if (!capability.ingest) continue;
      for (const extension of capability.extensions) {
        const normalized = extension.toLowerCase();
        if (!formats.has(normalized)) formats.set(normalized, capability.format);
        const acceptEntry = `.${normalized}`;
        if (!entries.includes(acceptEntry)) entries.push(acceptEntry);
      }
    }
    return { formats, accept: entries.join(",") };
  }, [transfer]);

  const isCurrent = useCallback((lifecycle: Lifecycle): boolean => (
    lifecycleRef.current === lifecycle
    && lifecycle.owner === transfer
    && safeScopeCurrent(lifecycle, host)
  ), [host, transfer]);

  const loadPage = useCallback(async (
    lifecycle: Lifecycle,
    cursor: string | null,
    showFailure: boolean,
  ): Promise<void> => {
    if (!isCurrent(lifecycle)) return;
    if (cursor !== pageCursorRef.current) needsFileRowsRef.current.clear();
    const request = {};
    pageRequestRef.current = request;
    setPage((current) => ({
      owner: transfer,
      items: current.owner === transfer ? current.items : [],
      cursor: current.owner === transfer ? current.cursor : cursor,
      nextCursor: current.owner === transfer ? current.nextCursor : null,
      loading: true,
    }));
    try {
      const result = await transfer.controller.list(cursor === null ? { limit: PAGE_LIMIT } : { cursor, limit: PAGE_LIMIT });
      if (!isCurrent(lifecycle) || pageRequestRef.current !== request) return;
      const listed = result.items.slice(0, PAGE_LIMIT).map(rowFromStatus);
      const listedIntents = new Set(listed.map((item) => item.intentId));
      for (const intentId of needsFileRowsRef.current.keys()) {
        if (!listedIntents.has(intentId)) needsFileRowsRef.current.delete(intentId);
      }
      const items = listed.map((item) => needsFileRowsRef.current.get(item.intentId) ?? item);
      pageCursorRef.current = cursor;
      setPage({ owner: transfer, items, cursor, nextCursor: result.nextCursor, loading: false });
    } catch {
      if (!isCurrent(lifecycle) || pageRequestRef.current !== request) return;
      setPage((current) => ({
        owner: transfer,
        items: current.owner === transfer ? current.items : [],
        cursor: current.owner === transfer ? current.cursor : cursor,
        nextCursor: current.owner === transfer ? current.nextCursor : null,
        loading: false,
      }));
      if (showFailure) setMessage({ owner: transfer, value: transfer.copy.refreshFailed });
    } finally {
      if (pageRequestRef.current === request) pageRequestRef.current = null;
    }
  }, [isCurrent, transfer]);

  useEffect(() => {
    const lifecycle: Lifecycle = { owner: transfer, controller: new AbortController() };
    lifecycleRef.current = lifecycle;
    pageCursorRef.current = null;
    pageRequestRef.current = null;
    needsFileRowsRef.current.clear();
    activeRef.current = null;
    setPage({ owner: transfer, items: [], cursor: null, nextCursor: null, loading: false });
    setActiveOwner(null);
    setMessage(null);
    setScopeRevoked(false);

    const revoke = () => {
      lifecycle.controller.abort(host.scopeSignal.reason);
      if (lifecycleRef.current !== lifecycle) return;
      pageRequestRef.current = null;
      needsFileRowsRef.current.clear();
      activeRef.current = null;
      setPage({ owner: transfer, items: [], cursor: null, nextCursor: null, loading: false });
      setActiveOwner(null);
      setMessage(null);
      setScopeRevoked(true);
    };
    if (host.scopeSignal.aborted) revoke();
    else host.scopeSignal.addEventListener("abort", revoke, { once: true });
    if (safeScopeCurrent(lifecycle, host)) {
      waitingForAuthorityRef.current = false;
      void loadPage(lifecycle, null, true);
    } else {
      waitingForAuthorityRef.current = true;
    }

    return () => {
      host.scopeSignal.removeEventListener("abort", revoke);
      lifecycle.controller.abort();
      if (lifecycleRef.current === lifecycle) lifecycleRef.current = null;
      if (activeRef.current?.owner === transfer) activeRef.current = null;
    };
  }, [host, loadPage, transfer]);

  useEffect(() => {
    const lifecycle = lifecycleRef.current;
    if (!waitingForAuthorityRef.current || lifecycle === null || lifecycle.owner !== transfer
      || pageRequestRef.current !== null || !safeScopeCurrent(lifecycle, host)) return;
    waitingForAuthorityRef.current = false;
    void loadPage(lifecycle, null, true);
  });

  const mutationAllowed = (): Lifecycle | null => {
    const lifecycle = lifecycleRef.current;
    if (!mutationEnabledRef.current || lifecycle === null || lifecycle.owner !== transfer
      || activeRef.current !== null || !isCurrent(lifecycle)) return null;
    return lifecycle;
  };

  const updateAcceptedStatus = (status: PersonalPhotoTransferStatus) => {
    const row = rowFromStatus(status);
    setPage((current) => {
      const existing = current.owner === transfer ? current.items : [];
      const index = existing.findIndex((item) => item.intentId === row.intentId);
      const items = index < 0
        ? [row, ...existing].slice(0, PAGE_LIMIT)
        : existing.map((item, itemIndex) => itemIndex === index ? row : item);
      return {
        owner: transfer,
        items,
        cursor: current.owner === transfer ? current.cursor : pageCursorRef.current,
        nextCursor: current.owner === transfer ? current.nextCursor : null,
        loading: false,
      };
    });
  };

  const runOperation = (
    invoke: (signal: AbortSignal) => Promise<PersonalPhotoTransferStatus>,
  ): void => {
    const lifecycle = mutationAllowed();
    if (lifecycle === null) return;
    const token = {};
    activeRef.current = { owner: transfer, token };
    pageRequestRef.current = null;
    setPage((current) => current.owner === transfer ? { ...current, loading: false } : current);
    setActiveOwner(transfer);
    setMessage(null);

    void (async () => {
      let accepted = false;
      try {
        if (!isCurrent(lifecycle)) return;
        const status = await invoke(lifecycle.controller.signal);
        if (!isCurrent(lifecycle) || activeRef.current?.token !== token) return;
        accepted = true;
        if (status.phase === "needs-file") needsFileRowsRef.current.set(status.intentId, rowFromStatus(status));
        else needsFileRowsRef.current.delete(status.intentId);
        updateAcceptedStatus(status);
        try {
          await transfer.onSettled(status);
        } catch {
          // The accepted controller result remains authoritative even if host invalidation fails.
        }
        if (!isCurrent(lifecycle) || activeRef.current?.token !== token) return;
      } catch (error) {
        if (!isCurrent(lifecycle) || activeRef.current?.token !== token) return;
        let described = transfer.copy.failed;
        try {
          const candidate = transfer.describeError(error);
          if (typeof candidate === "string" && candidate.length > 0) described = candidate;
        } catch {
          // Use only the injected generic copy when the trusted formatter fails.
        }
        setMessage({ owner: transfer, value: described });
      }
      if (!isCurrent(lifecycle) || activeRef.current?.token !== token) return;
      await loadPage(lifecycle, pageCursorRef.current, accepted);
      if (!isCurrent(lifecycle) || activeRef.current?.token !== token) return;
    })().finally(() => {
      if (lifecycleRef.current !== lifecycle || activeRef.current?.token !== token) return;
      activeRef.current = null;
      setActiveOwner(null);
    });
  };

  const onAddFile = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0] ?? null;
    input.value = "";
    if (file === null || mutationAllowed() === null) return;
    const format = extensionDetails.formats.get(fileExtension(file.name));
    if (format === undefined) {
      setMessage({ owner: transfer, value: transfer.copy.unsupported });
      return;
    }
    let intentId: string;
    try {
      intentId = globalThis.crypto.randomUUID();
    } catch {
      setMessage({ owner: transfer, value: transfer.copy.failed });
      return;
    }
    runOperation((signal) => transfer.controller.start({
      intentId,
      file,
      format,
      fullRecipeCandidate: null,
    }, signal));
  };

  const onResumeFile = (intentId: string, event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0] ?? null;
    input.value = "";
    if (file === null || mutationAllowed() === null) return;
    runOperation((signal) => transfer.controller.resume({ intentId, file }, signal));
  };

  const visiblePage = page.owner === transfer ? page : {
    owner: transfer,
    items: [] as readonly TransferRow[],
    cursor: null,
    nextCursor: null,
    loading: false,
  };
  const active = activeOwner === transfer;
  const live = !scopeRevoked && host.scopeSignal.aborted === false && (() => {
    try {
      return host.isScopeCurrent() === true;
    } catch {
      return false;
    }
  })();
  const canMutate = props.mutationEnabled && live && !active;
  const canAdd = canMutate && extensionDetails.formats.size > 0;
  const canNavigate = live && !active && !visiblePage.loading;
  const visibleMessage = message?.owner === transfer ? message.value : null;
  const requestPage = (cursor: string | null) => {
    if (!canNavigate || activeRef.current !== null) return;
    const lifecycle = lifecycleRef.current;
    if (lifecycle !== null) void loadPage(lifecycle, cursor, true);
  };

  return (
    <section className="photo-web-transfer" aria-label={transfer.copy.toolbar}>
      <div className="photo-web-transfer-toolbar">
        <strong>{transfer.copy.toolbar}</strong>
        <div className="photo-web-transfer-toolbar-actions">
          <input
            ref={addInputRef}
            className="photo-web-transfer-file-input"
            type="file"
            accept={extensionDetails.accept || undefined}
            aria-label={transfer.copy.add}
            disabled={!canAdd}
            onChange={onAddFile}
          />
          <button type="button" disabled={!canAdd} onClick={() => addInputRef.current?.click()}>
            {transfer.copy.add}
          </button>
          <button
            type="button"
            disabled={!canNavigate}
            onClick={() => requestPage(pageCursorRef.current)}
          >
            {transfer.copy.refresh}
          </button>
        </div>
      </div>

      {active ? (
        <div className="photo-web-transfer-status" role="status">
          <span>{transfer.copy.busy}</span>
          <progress className="photo-web-transfer-busy-progress" aria-label={transfer.copy.busy} />
        </div>
      ) : null}
      {visibleMessage !== null ? <p className="photo-web-transfer-status" role="status">{visibleMessage}</p> : null}

      <details className="photo-web-transfer-details">
        <summary>{transfer.copy.pendingTitle}</summary>
        <div className="photo-web-transfer-list">
          {visiblePage.items.map((item) => {
            const terminal = TERMINAL_PHASES.has(item.phase);
            const phaseLabel = item.phase === "failed" && item.failure === "stored"
              ? transfer.copy.phaseLabels.done
              : transfer.copy.phaseLabels[item.phase];
            const sameFormat = transfer.formats.find((format) => format.format === item.format && format.ingest);
            const resumeAccept = sameFormat?.extensions.map((extension) => `.${extension.toLowerCase()}`).join(",") ?? "";
            const progressValue = Number.isSafeInteger(item.sizeBytes) && item.sizeBytes > 0
              && Number.isSafeInteger(item.uploadedBytes) && item.uploadedBytes >= 0
              ? Math.min(item.uploadedBytes, item.sizeBytes)
              : null;
            return (
              <article className="photo-web-transfer-row" key={item.intentId}>
                <div className="photo-web-transfer-row-heading">
                  <strong>{item.fileName}</strong>
                  <span>{phaseLabel}</span>
                </div>
                <progress
                  aria-label={`${item.fileName} ${phaseLabel}`}
                  max={item.sizeBytes > 0 ? item.sizeBytes : undefined}
                  {...(progressValue === null ? {} : { value: progressValue })}
                />
                {!terminal ? (
                  <div className="photo-web-transfer-row-actions">
                    {item.phase === "needs-file" ? (
                      <>
                        <input
                          ref={(element) => {
                            if (element === null) resumeInputRefs.current.delete(item.intentId);
                            else resumeInputRefs.current.set(item.intentId, element);
                          }}
                          className="photo-web-transfer-file-input"
                          type="file"
                          accept={resumeAccept}
                          aria-label={transfer.copy.chooseSameFile}
                          disabled={!canMutate}
                          onChange={(event) => onResumeFile(item.intentId, event)}
                        />
                        <button
                          type="button"
                          disabled={!canMutate}
                          onClick={() => resumeInputRefs.current.get(item.intentId)?.click()}
                        >
                          {transfer.copy.chooseSameFile}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={!canMutate}
                        onClick={() => runOperation((signal) => transfer.controller.resume({ intentId: item.intentId }, signal))}
                      >
                        {transfer.copy.resume}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={!canMutate}
                      onClick={() => runOperation((signal) => transfer.controller.cancel(item.intentId, signal))}
                    >
                      {transfer.copy.cancel}
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
        <div className="photo-web-transfer-pages">
          {visiblePage.cursor !== null ? (
            <button
              type="button"
              disabled={!canNavigate}
              onClick={() => requestPage(null)}
            >
              {transfer.copy.first}
            </button>
          ) : null}
          {visiblePage.nextCursor !== null ? (
            <button
              type="button"
              disabled={!canNavigate}
              onClick={() => requestPage(visiblePage.nextCursor)}
            >
              {transfer.copy.next}
            </button>
          ) : null}
        </div>
      </details>
    </section>
  );
}
