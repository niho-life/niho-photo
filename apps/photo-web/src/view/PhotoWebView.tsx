import { useCallback, useEffect, useRef, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";

import { BrowserPhotoEditingWorkbench } from "niho-photo-editing/editor/browser-photo-editing-workbench";
import { PhotoLibraryProvider } from "niho-photo-editing/library/photo-library-context";
import { AppDialogHost } from "niho-ui/components/app-dialog-host";

import type { PhotoWebViewBinding, PhotoWebViewProps } from "./types";
import "./PhotoWebView.css";

type ActionState = {
  readonly scope: string;
  readonly pending: boolean;
  readonly message: string | null;
};

function useScopedAction<Result>(options: {
  readonly scope: string;
  readonly action: () => Promise<Result>;
  readonly failureMessage: string;
  readonly resultMessage?: (result: Result) => string | null;
}) {
  const mountedRef = useRef(false);
  const scopeRef = useRef(options.scope);
  const actionRef = useRef(options.action);
  const failureMessageRef = useRef(options.failureMessage);
  const resultMessageRef = useRef(options.resultMessage);
  const activeRef = useRef<{ readonly scope: string; readonly token: object } | null>(null);
  const [state, setState] = useState<ActionState | null>(null);

  scopeRef.current = options.scope;
  actionRef.current = options.action;
  failureMessageRef.current = options.failureMessage;
  resultMessageRef.current = options.resultMessage;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRef.current = null;
    };
  }, []);

  const run = useCallback(() => {
    const scope = scopeRef.current;
    if (activeRef.current?.scope === scope) return;

    const token = {};
    activeRef.current = { scope, token };
    setState({ scope, pending: true, message: null });

    const settle = (message: string | null) => {
      if (activeRef.current?.token !== token) return;
      activeRef.current = null;
      if (!mountedRef.current || scopeRef.current !== scope) return;
      setState({ scope, pending: false, message });
    };

    let promise: Promise<Result>;
    try {
      promise = actionRef.current();
    } catch {
      settle(failureMessageRef.current);
      return;
    }

    void promise.then(
      (result) => settle(resultMessageRef.current?.(result) ?? null),
      () => settle(failureMessageRef.current),
    );
  }, []);

  return {
    run,
    pending: state?.scope === options.scope && state.pending,
    message: state?.scope === options.scope ? state.message : null,
  };
}

function acceptedBinding(props: PhotoWebViewProps): PhotoWebViewBinding | null {
  const { binding, session } = props;
  if (session.phase !== "ready" && session.phase !== "verifying") return null;
  if (binding === null || session.identity === null) return null;
  if (binding.key.trim().length === 0 || binding.scopeKey.trim().length === 0) return null;
  if (session.identity.userId !== binding.actorId || binding.library.place !== "cloud") return null;
  return binding;
}

function actionScope(props: PhotoWebViewProps): string {
  return JSON.stringify([
    props.session.identity?.userId ?? null,
    props.session.identity?.sessionId ?? null,
    props.session.identity?.sessionEpoch ?? null,
    props.session.identity?.transport ?? null,
    props.binding?.key ?? null,
    props.binding?.scopeKey ?? null,
    props.binding?.actorId ?? null,
  ]);
}

function pwaMessage(props: PhotoWebViewProps): string | null {
  const phase = props.pwa?.snapshot.phase;
  switch (phase) {
    case "available":
      return props.copy.pwaAvailable;
    case "preparing":
    case "activating":
      return props.copy.pwaPreparing;
    case "blocked":
      return props.copy.pwaBlocked;
    case "failed":
      return props.copy.pwaFailed;
    default:
      return null;
  }
}

function EmptySession(props: {
  readonly view: PhotoWebViewProps;
  readonly retryPending: boolean;
  readonly onRetry: () => void;
}) {
  const { copy, session } = props.view;
  const login = session.phase === "signed-out" || session.phase === "expired";
  const waiting = session.phase === "verifying" || session.phase === "logging-out" || session.phase === "cancelling";
  const canRetry = session.phase === "unavailable" || session.phase === "ready";

  return (
    <main className="photo-web-empty">
      <section className="photo-web-empty-card" aria-labelledby="photo-web-title">
        <h1 id="photo-web-title">{copy.title}</h1>
        <p>{copy.subtitle}</p>
        {login ? (
          <form method="post" action="/auth/start">
            <button className="photo-web-primary-button" type="submit">{copy.login}</button>
          </form>
        ) : (
          <div className="photo-web-empty-action">
            <p role="status">{waiting ? copy.verifying : copy.unavailable}</p>
            {canRetry ? (
              <button type="button" disabled={props.retryPending} onClick={props.onRetry}>
                {copy.retry}
              </button>
            ) : null}
          </div>
        )}
      </section>
    </main>
  );
}

export function PhotoWebView(props: PhotoWebViewProps) {
  const [treeHidden, setTreeHidden] = useState(false);
  const binding = acceptedBinding(props);
  const scope = actionScope(props);
  const retry = useScopedAction({
    scope,
    action: props.onRetry,
    failureMessage: props.copy.failed,
  });
  const logout = useScopedAction({
    scope,
    action: props.onLogout,
    failureMessage: props.copy.failed,
  });
  const update = useScopedAction({
    scope,
    action: async () => props.pwa?.requestUpdate() ?? "failed",
    failureMessage: props.copy.pwaFailed,
    resultMessage: (result) => {
      if (result === "blocked") return props.copy.pwaBlocked;
      if (result === "failed") return props.copy.pwaFailed;
      return null;
    },
  });
  const updatePhase = props.pwa?.snapshot.phase;
  const showUpdate = updatePhase === "available"
    || updatePhase === "preparing"
    || updatePhase === "activating"
    || updatePhase === "blocked"
    || updatePhase === "failed";
  const updateProgress = updatePhase === "preparing" || updatePhase === "activating";
  const canLogout = props.session.identity !== null
    && props.session.phase !== "logging-out"
    && props.session.phase !== "cancelling"
    && props.session.phase !== "disposed";
  const statusMessages = [
    props.online ? null : props.copy.offline,
    binding !== null && props.session.phase === "verifying" ? props.copy.verifying : null,
    retry.message,
    logout.message,
  ].filter((message): message is string => message !== null);
  const updateStatus = update.message ?? pwaMessage(props);

  return (
    <QueryClientProvider client={props.queryClient}>
      <AppDialogHost key={props.dialogScopeKey} />
      <div className="photo-web-root">
        <header className="photo-web-header">
          <div className="photo-web-brand">
            <img src={props.iconUrl} alt="" draggable={false} />
            <strong>{props.copy.brand}</strong>
          </div>
          <div className="photo-web-header-actions">
            <span className="photo-web-cloud">{props.copy.cloud}</span>
            {binding?.usage ? <span className="photo-web-usage">{props.copy.usage(binding.usage)}</span> : null}
            {binding ? (
              <button
                type="button"
                aria-pressed={treeHidden}
                onClick={() => setTreeHidden((hidden) => !hidden)}
              >
                {props.copy.toggleTree}
              </button>
            ) : null}
            {canLogout ? (
              <button type="button" disabled={logout.pending} onClick={logout.run}>
                {props.copy.logout}
              </button>
            ) : null}
          </div>
        </header>

        {statusMessages.length > 0 || showUpdate ? (
          <div className="photo-web-notices" aria-live="polite">
            {statusMessages.map((message, index) => <p key={`${index}:${message}`}>{message}</p>)}
            {showUpdate ? (
              <div className="photo-web-update-notice">
                <p>{updateStatus}</p>
                <button type="button" disabled={update.pending || updateProgress} onClick={update.run}>
                  {props.copy.pwaApply}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {binding ? (
          <main className="photo-web-workspace">
            <PhotoLibraryProvider key={binding.key} library={binding.library} host={binding.host}>
              <BrowserPhotoEditingWorkbench
                key={binding.key}
                spotId={binding.key}
                scopeKey={binding.scopeKey}
                actorId={binding.actorId}
                canEdit={binding.canEdit}
                cloudOriginalsAllowed={binding.cloudOriginalsAllowed}
                mobileEditingAllowed={binding.mobileEditingAllowed}
                disableCloudDelete={binding.disableCloudDelete}
                appearance="fill"
                active
                openCloudPhotoId={null}
                onOpenCloudPhotoHandled={() => undefined}
                registerRouteLeaveGuard={props.registerRouteLeaveGuard}
                treeHidden={treeHidden}
                treeFooter={<span>{props.copy.version}</span>}
              />
            </PhotoLibraryProvider>
          </main>
        ) : (
          <EmptySession view={props} retryPending={retry.pending} onRetry={retry.run} />
        )}
      </div>
    </QueryClientProvider>
  );
}
