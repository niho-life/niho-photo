import { PHOTO_EDITING_AUTOSAVE_DELAY_MS } from "../photo-editing-settings-autosave";
import type { DevelopSettings } from "./develop-settings";
import type {
  PhotoLibraryDevelopConflictToken,
  PhotoLibraryDevelopDraftSaveResult,
  PhotoLibraryDevelopDraftStage,
} from "../library/photo-library-durable-drafts";
import type { PhotoLibraryPhoto, PhotoLibrarySaveResult } from "../library/photo-library";

/**
 * ブラウザで直している 1 枚の編集内容（`developSettings`）の自動保存（移行元設計。移行時の設計文書
 * 「自動保存と補正後のプレビュー」）。写真ごとに作る。
 *
 * - スライダーを動かしたら 800ms まとめて、最新の値だけを `PUT .../develop-settings` へ送る。同じ写真への保存は直列
 *   （前の応答を待ってから次）。成功応答の `developRevision` と送った値を「保存済み」として持つ（補正後のプレビューは、この値で
 *   描いた画だけをこの版で上げる。K3 移行元設計）
 * - 失敗のうち、写真が無い（404）・形が違う（400）・権限が無い（403。見分けは写真の出どころの `errors.isPermanentSaveFailure`）は
 *   送り直しても通らないので、まだ送っていない値を捨てて
 *   終える（離れるのを止めない）。ほか（通信・5xx・版の照合でない 409・429 など）は値を残して `failed` にし、自動では送り
 *   直さない（次の変更・`flush`・`retry` で送る）
 * - `flush` は待ちを止めて今すぐ送り、送り終わるまで待つ（写真を離れる前）。送り直せる失敗で値が残れば `ok: false`
 * - 版の照合（F1b 移行元設計）: 作るときに直し始めた版（開いた写真の `developRevision`）を渡すと、保存のたびに `expectedRevision` と
 *   して送り、通るたびに応答の版へ進める。別の端末が先に保存していた（保存の結果が `stale`。接続口 `PhotoLibrary` の
 *   `saveDevelopSettings` が 409 `photo_cloud_develop_revision_stale` をこの結果にする。移行元設計）ら、まだ送って
 *   いない値を捨てて止まり（`failed` にしない・自動で送り直さない・以後の変更も送らない）、`onStale`（今の写真）を 1 回呼ぶ。
 *   画面は今の写真で開き直し、保存係をその版で作り直す。止まった後の `flush` は `ok: true`（保存したものは無い）で、離れるのを
 *   止めない。版を渡さずに作れば、今までどおり後の保存が勝つ
 */

export type DevelopSettingsSaverState = "idle" | "waiting" | "saving" | "failed";

export type DevelopSettingsLastSaved = {
  settings: DevelopSettings;
  developRevision: number;
  developSettingsUpdatedAt: string | null;
};

export type DevelopSettingsFlushResult =
  | { ok: true; saved: DevelopSettingsLastSaved | null; dropped?: unknown }
  | { ok: false; error: unknown };

export type DevelopSettingsSaver = {
  /** 変えた値を持ち、まとめる待ちを始め直す */
  schedule: (settings: DevelopSettings) => void;
  /** 待ちを止めて今すぐ送り、送り終わるまで待つ */
  flush: () => Promise<DevelopSettingsFlushResult>;
  /** 失敗した値を送り直す（{@link DevelopSettingsSaver.flush} と同じ） */
  retry: () => Promise<DevelopSettingsFlushResult>;
  getState: () => DevelopSettingsSaverState;
  getLastSaved: () => DevelopSettingsLastSaved | null;
  getLastError: () => unknown;
  /** 送り終えていない値がある（まとめる待ち・送信中・失敗して残っている） */
  hasPendingWork: () => boolean;
  /** 直し始めた版（保存が通るたびに応答の版へ進む）。版を渡さずに作った保存係は undefined */
  getExpectedRevision: () => number | undefined;
  /** durable の結果確認で、その送信値だけを確定する。後発入力は保持する。 */
  acknowledgeDurableInput?: (settings: Readonly<Record<string, unknown>>) => boolean;
  /** まとめる待ちを止める（以後の変更は受けず、まだ送っていない値は flush されない限り送らない。送信中の保存は捨てない） */
  dispose: () => void;
};

export type DevelopSettingsDurableMode = {
  /** 同期clone済みの完全設定を、debounce・通信より前に永続化し始める。 */
  stage(settings: DevelopSettings): PhotoLibraryDevelopDraftStage;
  /** stage と同じsnapshotだけを送る。 */
  save(settings: DevelopSettings, stage: PhotoLibraryDevelopDraftStage): Promise<PhotoLibraryDevelopDraftSaveResult>;
  onConflict?: (conflict: PhotoLibraryDevelopConflictToken) => void;
  onBlocked?: (result: Exclude<PhotoLibraryDevelopDraftSaveResult, { kind: "saved" | "conflict" | "superseded" }>) => void;
  /** 外部portの strict commit を待つ上限。超過後のlate完了はUIを開かない。 */
  stageTimeoutMs?: number;
};

export function createDevelopSettingsSaver(options: {
  /**
   * 1 回の保存（接続口 `PhotoLibrary` の `saveDevelopSettings`）。`expectedRevision` は直し始めた版（版を渡さずに作った保存係は
   * undefined）。別の端末が先に保存していたら `stale`、ほかの失敗は投げる
   */
  save: (settings: DevelopSettings, expectedRevision: number | undefined) => Promise<PhotoLibrarySaveResult>;
  /**
   * 送り直しても通らない失敗か（写真が無い・形が違う・権限が無い。接続口 `PhotoLibrary` の `errors.isPermanentSaveFailure`。移行元設計）
   */
  isPermanentFailure: (error: unknown) => boolean;
  /** 直し始めた版（開いた写真の `developRevision`）。省けば版を送らない（後の保存が勝つ） */
  expectedRevision?: number;
  delayMs?: number;
  onChange?: () => void;
  /** schedule の値を debounce / 通信より前に同期退避する。返した印は、その値の保存成功時にだけ onSaved へ返す。 */
  onScheduled?: (settings: DevelopSettings) => unknown;
  /** 送った値の保存が成功したとき。送信中に schedule された新しい値の印とは混ぜない。 */
  onSaved?: (settings: DevelopSettings, scheduled: unknown) => void;
  /** 送り直しても通らない失敗で、まだ送っていない値を捨てたとき（画面に 1 回出す） */
  onDropped?: (error: unknown) => void;
  /** 別の端末が先に保存していたので断られ、まだ送っていない値を捨てて止まったとき（今の写真。1 回だけ） */
  onStale?: (photo: PhotoLibraryPhoto) => void;
  /** cloud の strict durable 経路。指定時は legacy save / stale破棄 / onScheduled を使わない。 */
  durable?: DevelopSettingsDurableMode;
}): DevelopSettingsSaver {
  if (options.durable !== undefined) return createDurableDevelopSettingsSaver(options, options.durable);
  const delayMs = options.delayMs ?? PHOTO_EDITING_AUTOSAVE_DELAY_MS;
  /** 直し始めた版（保存が通るたびに応答の版へ進む） */
  let expectedRevision = options.expectedRevision;
  /** 別の端末が先に保存していたので止まった（以後は送らない） */
  let stale = false;
  /** まだ送っていない最新の値と、schedule 時に同期退避したその世代の印。 */
  let pending: { settings: DevelopSettings; scheduled: unknown } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sending = false;
  /** 送り直せる失敗で値が残っている（次の変更・flush・retry まで送らない） */
  let failed = false;
  let lastSaved: DevelopSettingsLastSaved | null = null;
  let lastError: unknown = null;
  /** 送り直しても通らない失敗で捨てた（次の flush の結果に添える） */
  let dropped: unknown = undefined;
  let disposed = false;
  let flushWaiters: Array<(result: DevelopSettingsFlushResult) => void> = [];
  let notifiedState: DevelopSettingsSaverState = "idle";
  let notifiedLastSaved: DevelopSettingsLastSaved | null = null;

  const currentState = (): DevelopSettingsSaverState => {
    if (sending) return "saving";
    if (failed) return "failed";
    if (timer !== null || pending !== null) return "waiting";
    return "idle";
  };

  const notify = () => {
    const state = currentState();
    if (state === notifiedState && lastSaved === notifiedLastSaved) return;
    notifiedState = state;
    notifiedLastSaved = lastSaved;
    try {
      options.onChange?.();
    } catch {
      // 知らせる側の失敗で、保存を止めない
    }
  };

  const stopTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  /** flush を待っている人に、送り終えた結果を返す（送信中・送る値がある間は返さない）。 */
  const settleWaiters = () => {
    if (flushWaiters.length === 0 || sending || timer !== null) return;
    if (pending !== null && !failed) return;
    const result: DevelopSettingsFlushResult = failed
      ? { ok: false, error: lastError }
      : stale
        ? { ok: true, saved: null }
        : dropped !== undefined
        ? { ok: true, saved: lastSaved, dropped }
        : { ok: true, saved: lastSaved };
    if (result.ok) dropped = undefined;
    const waiters = flushWaiters;
    flushWaiters = [];
    for (const resolve of waiters) resolve(result);
  };

  /** 送る値があり、待ち・送信中・失敗で止めていなければ送る（止めた後は、flush を待っているときだけ送る）。 */
  function pump(): void {
    if (sending || timer !== null || failed || stale || pending === null || (disposed && flushWaiters.length === 0)) {
      settleWaiters();
      notify();
      return;
    }
    const scheduled = pending;
    const settings = scheduled.settings;
    pending = null;
    sending = true;
    notify();
    let request: Promise<PhotoLibrarySaveResult>;
    try {
      request = options.save(settings, expectedRevision);
    } catch (error) {
      request = Promise.reject(error);
    }
    void request
      .then(
        (result) => {
          if (result.kind === "stale") {
            // 別の端末が先に保存していた。まだ送っていない値も捨てて止まる（送り直しても同じ版では通らない）
            pending = null;
            stopTimer();
            stale = true;
            try {
              options.onStale?.(result.photo);
            } catch {
              // 知らせる側の失敗で、後始末を止めない
            }
            return;
          }
          const photo = result.photo;
          lastSaved = {
            settings,
            developRevision: photo.developRevision,
            developSettingsUpdatedAt: photo.developSettingsUpdatedAt ?? null,
          };
          if (expectedRevision !== undefined) expectedRevision = photo.developRevision;
          lastError = null;
          try {
            options.onSaved?.(settings, scheduled.scheduled);
          } catch {
            // 端末退避の後始末の失敗で、サーバー保存を失敗扱いにしない
          }
        },
        (error: unknown) => {
          lastError = error;
          if (options.isPermanentFailure(error)) {
            // 送り直しても通らない。まだ送っていない値も捨てて終える
            pending = null;
            stopTimer();
            dropped = error;
            try {
              options.onDropped?.(error);
            } catch {
              // 知らせる側の失敗で、後始末を止めない
            }
            return;
          }
          // 送り直せる。送っている間に新しい値が来ていればそちらを残す。新しい値のまとめる待ちが続いていれば、その時間が
          // 来たら送る
          if (pending === null) pending = scheduled;
          if (timer === null) failed = true;
        },
      )
      .finally(() => {
        sending = false;
        pump();
      });
  }

  const flush = (): Promise<DevelopSettingsFlushResult> =>
    new Promise<DevelopSettingsFlushResult>((resolve) => {
      flushWaiters.push(resolve);
      stopTimer();
      // 失敗して残っている値も送り直す
      failed = false;
      pump();
    });

  return {
    schedule(settings) {
      // 止まった後の変更は送らない（画面が今の写真で開き直し、保存係を作り直す）
      if (disposed || stale) return;
      let scheduled: unknown;
      try {
        scheduled = options.onScheduled?.(settings);
      } catch {
        // 端末退避の失敗で、既存のサーバー保存を止めない
      }
      pending = { settings, scheduled };
      failed = false;
      dropped = undefined;
      stopTimer();
      // 離れる前の flush を待っている間の変更は、待たずに続けて送る
      if (flushWaiters.length === 0) {
        timer = setTimeout(() => {
          timer = null;
          pump();
        }, delayMs);
      }
      pump();
    },
    flush,
    retry: flush,
    getState: currentState,
    getLastSaved: () => lastSaved,
    getLastError: () => lastError,
    hasPendingWork: () => currentState() !== "idle",
    getExpectedRevision: () => expectedRevision,
    acknowledgeDurableInput: () => false,
    dispose() {
      disposed = true;
      stopTimer();
      notify();
    },
  };
}

function createDurableDevelopSettingsSaver(
  options: Parameters<typeof createDevelopSettingsSaver>[0],
  durable: DevelopSettingsDurableMode,
): DevelopSettingsSaver {
  const delayMs = options.delayMs ?? PHOTO_EDITING_AUTOSAVE_DELAY_MS;
  const stageTimeoutMs = durable.stageTimeoutMs ?? 15_000;
  type Scheduled = {
    settings: DevelopSettings;
    stage: PhotoLibraryDevelopDraftStage | null;
    stageError: unknown;
    stageStatus: "new" | "committed" | "superseded" | "unsaved" | "failed";
  };
  let expectedRevision = options.expectedRevision;
  let pending: Scheduled | null = null;
  let blockedRequest: Scheduled | null = null;
  let pendingConflict: PhotoLibraryDevelopConflictToken | null = null;
  let blockedInput = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sending = false;
  let failure: "stage" | "save" | null = null;
  let frozen = false;
  let holdPending = false;
  let disposed = false;
  let lastSaved: DevelopSettingsLastSaved | null = null;
  let lastError: unknown = null;
  let flushWaiters: Array<(result: DevelopSettingsFlushResult) => void> = [];
  let notifiedState: DevelopSettingsSaverState = "idle";
  let notifiedLastSaved: DevelopSettingsLastSaved | null = null;

  const currentState = (): DevelopSettingsSaverState => {
    if (sending) return "saving";
    if (failure !== null || frozen || blockedInput || holdPending) return "failed";
    if (timer !== null || pending !== null) return "waiting";
    return "idle";
  };
  const notify = () => {
    const state = currentState();
    if (state === notifiedState && lastSaved === notifiedLastSaved) return;
    notifiedState = state;
    notifiedLastSaved = lastSaved;
    try { options.onChange?.(); } catch { /* observers do not change durable state */ }
  };
  const stopTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const settleWaiters = () => {
    if (flushWaiters.length === 0 || sending || timer !== null) return;
    if (pending !== null && failure === null && !frozen && !holdPending) return;
    const result: DevelopSettingsFlushResult = failure !== null || frozen || blockedInput || holdPending || pending !== null
      ? { ok: false, error: lastError ?? new Error("補正をまだ保存できていません") }
      : { ok: true, saved: lastSaved };
    const waiters = flushWaiters;
    flushWaiters = [];
    for (const resolve of waiters) resolve(result);
  };

  const reportBlocked = (
    scheduled: Scheduled,
    error: unknown,
    result?: Exclude<PhotoLibraryDevelopDraftSaveResult, { kind: "saved" | "conflict" | "superseded" }>,
  ) => {
    lastError = error;
    failure = result?.kind === "unsaved" ? "stage" : "save";
    if (result !== undefined && result.kind !== "unsaved") {
      frozen = true;
      blockedRequest = scheduled;
    }
    if (pending === null) pending = scheduled;
    if (result !== undefined) {
      try { durable.onBlocked?.(result); } catch { /* observers do not change durable state */ }
    }
  };

  const waitForStage = async (scheduled: Scheduled): Promise<"committed" | "superseded" | "unsaved"> => {
    if (scheduled.stageStatus === "committed") return "committed";
    if (scheduled.stageStatus === "superseded") return "superseded";
    if (scheduled.stageStatus === "unsaved") return "unsaved";
    if (scheduled.stageStatus === "failed") throw scheduled.stageError;
    if (scheduled.stage === null) throw scheduled.stageError;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const outcome = await Promise.race([
        scheduled.stage.committed,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("補正の端末保存を確認できませんでした")), stageTimeoutMs);
        }),
      ]);
      scheduled.stageStatus = outcome;
      return outcome;
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  };

  const observeStage = (scheduled: Scheduled): void => {
    const stage = scheduled.stage;
    if (stage === null) return;
    void stage.committed.then(
      (outcome) => {
        if (scheduled.stage !== stage) return;
        scheduled.stageStatus = outcome;
        if (pending === scheduled && outcome === "unsaved") {
          failure = "stage";
          lastError = new Error("補正をこの端末に保存できていません");
          notify();
          settleWaiters();
        }
      },
      (error: unknown) => {
        if (scheduled.stage !== stage) return;
        scheduled.stageStatus = "failed";
        scheduled.stageError = error;
        if (pending === scheduled) {
          failure = "stage";
          lastError = error;
          notify();
          settleWaiters();
        }
      },
    );
  };

  const revealConflictAfterLatestCommit = async (
    sent: Scheduled,
    conflict: PhotoLibraryDevelopConflictToken,
  ): Promise<void> => {
    blockedRequest = sent;
    pendingConflict = conflict;
    for (;;) {
      const latest = pending;
      if (latest === null) break;
      let outcome: "committed" | "superseded" | "unsaved";
      try {
        outcome = await waitForStage(latest);
      } catch (error) {
        failure = "stage";
        lastError = error;
        return;
      }
      if (outcome === "unsaved") {
        failure = "stage";
        lastError = new Error("後の補正をこの端末に保存できていません");
        try { durable.onBlocked?.({ kind: "unsaved" }); } catch { /* observers do not change durable state */ }
        return;
      }
      // superseded と、待っている間にさらに新しい入力が来た場合は、常に最新を追う。
      if (outcome === "superseded" || pending !== latest) continue;
      break;
    }
    if (pendingConflict !== conflict || blockedRequest !== sent) return;
    failure = null;
    frozen = true;
    holdPending = pending !== null;
    lastError = new Error("別の端末の補正と競合しています");
    try { durable.onConflict?.(conflict); } catch { /* durable state remains frozen */ }
  };

  function pump(): void {
    if (sending || timer !== null || failure !== null || frozen || holdPending || blockedInput || pending === null || (disposed && flushWaiters.length === 0)) {
      settleWaiters();
      notify();
      return;
    }
    const scheduled = pending;
    pending = null;
    sending = true;
    notify();
    void Promise.resolve()
      .then(async () => {
        const stage = scheduled.stage;
        if (stage === null) throw scheduled.stageError;
        const committed = await waitForStage(scheduled);
        if (committed === "superseded") return { kind: "superseded" } as const;
        if (committed === "unsaved") return { kind: "unsaved" } as const;
        if (pendingConflict !== null) {
          // A 競合後に保存できなかった B を再stageした。Bは送らず比較用に保持する。
          pending = scheduled;
          await revealConflictAfterLatestCommit(blockedRequest ?? scheduled, pendingConflict);
          return { kind: "conflict-ready" } as const;
        }
        return await durable.save(scheduled.settings, stage);
      })
      .then(
        async (result) => {
          if (result.kind === "conflict-ready") return;
          if (result.kind === "superseded") return;
          if (result.kind === "saved") {
            lastSaved = {
              settings: scheduled.settings,
              developRevision: result.revision,
              developSettingsUpdatedAt: result.updatedAt,
            };
            expectedRevision = result.revision;
            lastError = null;
            failure = null;
            try { options.onSaved?.(scheduled.settings, scheduled.stage); } catch { /* ACK remains authoritative */ }
            return;
          }
          if (result.kind === "conflict") {
            await revealConflictAfterLatestCommit(scheduled, result.conflict);
            return;
          }
          reportBlocked(scheduled, new Error(`補正をまだ保存できていません (${result.kind})`), result);
        },
        (error: unknown) => {
          lastError = error;
          failure = scheduled.stageStatus === "committed" ? "save" : "stage";
          if (pending === null) pending = scheduled;
        },
      )
      .finally(() => {
        sending = false;
        // A が superseded のときだけ、後発 B をそのまま進める。blocked/frozen は B を保持して止める。
        pump();
      });
  }

  const flush = (): Promise<DevelopSettingsFlushResult> => new Promise((resolve) => {
    flushWaiters.push(resolve);
    stopTimer();
    // durable の失敗・競合・unknown は、同じ内容を legacy retry のように作り直さない。
    if (failure === null && !frozen && !holdPending && !blockedInput) pump();
    else settleWaiters();
  });

  const retry = (): Promise<DevelopSettingsFlushResult> => new Promise((resolve) => {
    flushWaiters.push(resolve);
    stopTimer();
    if (frozen || blockedInput) {
      settleWaiters();
      return;
    }
    if (pending !== null && failure === "stage") {
      try {
        pending.stage = durable.stage(pending.settings);
        pending.stageError = null;
        pending.stageStatus = "new";
        observeStage(pending);
        failure = null;
      } catch (error) {
        pending.stage = null;
        pending.stageError = error;
        lastError = error;
        settleWaiters();
        notify();
        return;
      }
    } else if (failure === "save") {
      failure = null;
    }
    holdPending = false;
    pump();
  });

  return {
    schedule(input) {
      if (disposed) return;
      const keepFrozen = frozen;
      let settings: DevelopSettings;
      try {
        settings = structuredClone(input);
      } catch (error) {
        blockedInput = true;
        lastError = error;
        stopTimer();
        notify();
        settleWaiters();
        return;
      }
      let stage: PhotoLibraryDevelopDraftStage | null = null;
      let stageError: unknown = null;
      try {
        stage = durable.stage(settings);
      } catch (error) {
        stageError = error;
      }
      pending = { settings, stage, stageError, stageStatus: stage === null ? "failed" : "new" };
      observeStage(pending);
      blockedInput = false;
      failure = stage === null ? "stage" : null;
      frozen = keepFrozen;
      holdPending = false;
      lastError = stageError;
      stopTimer();
      if (flushWaiters.length === 0 && failure === null && !frozen) {
        timer = setTimeout(() => {
          timer = null;
          pump();
        }, delayMs);
      }
      pump();
    },
    flush,
    retry,
    getState: currentState,
    getLastSaved: () => lastSaved,
    getLastError: () => lastError,
    hasPendingWork: () => currentState() !== "idle",
    getExpectedRevision: () => expectedRevision,
    acknowledgeDurableInput(settings) {
      const blocked = blockedRequest;
      if (blocked !== null && sameJsonValue(blocked.settings, settings)) {
        blockedRequest = null;
        pendingConflict = null;
        frozen = false;
        failure = pending !== null && (pending.stageStatus === "unsaved" || pending.stageStatus === "failed") ? "stage" : null;
        if (pending === blocked) pending = null;
        holdPending = pending !== null && failure === null;
        lastError = holdPending ? new Error("後の補正がまだ保存されていません") : null;
        notify();
        settleWaiters();
        return true;
      }
      if (pending !== null && sameJsonValue(pending.settings, settings)) {
        pending = null;
        failure = null;
        holdPending = false;
        lastError = null;
        notify();
        settleWaiters();
        return true;
      }
      return false;
    },
    dispose() {
      disposed = true;
      stopTimer();
      notify();
    },
  };
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(rightRecord, key) && sameJsonValue(leftRecord[key], rightRecord[key]),
  );
}
