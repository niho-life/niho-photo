import type { ReactNode } from "react";

/**
 * ブラウザ標準の window.confirm / alert / prompt の代わりに使うアプリ内ダイアログ（移行元設計）。
 *
 * NIHO Desktop（Tauri / wry の WKWebView）は標準ダイアログを表示できず、confirm() は表示せずに
 * false、alert() は何もせず、prompt() は null を返す。確認付きの操作が黙って止まるので、web は
 * 標準ダイアログを使わずこの呼び出し口を使う（ESLint で標準ダイアログを禁止している）。
 *
 * 依頼はこのモジュールの待ち行列に積まれ、ルートレイアウトの AppDialogHost が先頭から1件ずつ表示する。
 */

export type AppDialogVariant = "default" | "danger";

export type AppConfirmOptions = {
  /** 問いかけ（例: 「この投稿を削除しますか？」）。 */
  title: ReactNode;
  description?: ReactNode;
  /** 実行後の結果を表す動詞（例: 「削除する」）。 */
  confirmLabel: string;
  cancelLabel?: string;
  /** 削除など取り消せない操作は danger。 */
  variant?: AppDialogVariant;
};

export type AppPromptOptions = {
  title: ReactNode;
  description?: ReactNode;
  /** 入力欄のラベル。 */
  inputLabel: string;
  defaultValue?: string;
  placeholder?: string;
  inputType?: "text" | "url";
  confirmLabel: string;
  cancelLabel?: string;
  variant?: AppDialogVariant;
  /** 入力がこの条件を満たすまで確定ボタンを押せない（例: 完全削除するプラン名の一致）。 */
  canConfirm?: (value: string) => boolean;
};

export type AppAlertOptions = {
  title: ReactNode;
  description?: ReactNode;
  closeLabel?: string;
};

export type AppChooseOptions<T extends string = string> = {
  title: ReactNode;
  description?: ReactNode;
  choices: readonly [
    { value: T; label: string; variant?: AppDialogVariant },
    { value: T; label: string; variant?: AppDialogVariant },
  ];
  cancelLabel?: string;
};

/** 確認に添えるチェックの欄（既定はオフ）。説明はチェックの下に出し、`aria-describedby` で欄に結ぶ。 */
export type AppConfirmCheckbox = {
  label: string;
  description?: string;
};

export type AppConfirmWithCheckboxOptions = AppConfirmOptions & {
  checkbox: AppConfirmCheckbox;
};

/** チェックつきの確認の結果。確定で `{ checked }`、キャンセル・閉じるで null。 */
export type AppConfirmWithCheckboxResult = { checked: boolean } | null;

export type AppDialogRequest =
  | { id: number; kind: "confirm"; options: AppConfirmOptions; settle: (confirmed: boolean) => void }
  | {
      id: number;
      kind: "confirmWithCheckbox";
      options: AppConfirmWithCheckboxOptions;
      settle: (result: AppConfirmWithCheckboxResult) => void;
    }
  | { id: number; kind: "prompt"; options: AppPromptOptions; settle: (value: string | null) => void }
  | { id: number; kind: "choose"; options: AppChooseOptions; settle: (value: string | null) => void }
  | { id: number; kind: "alert"; options: AppAlertOptions; settle: () => void };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type AppDialogSnapshot = {
  /** 表示中の依頼（待ち行列の先頭）。無ければ null。 */
  active: AppDialogRequest | null;
  /** 最後に表示した依頼。閉じたあとも残し、閉じるアニメーションの間の中身に使う。 */
  shown: AppDialogRequest | null;
};

let queue: readonly AppDialogRequest[] = [];
let snapshot: AppDialogSnapshot = { active: null, shown: null };
let nextRequestId = 1;
let mountedHostCount = 0;
const listeners = new Set<() => void>();

function emit() {
  const active = queue[0] ?? null;
  snapshot = { active, shown: active ?? snapshot.shown };
  for (const listener of listeners) listener();
}

function removeRequest(id: number) {
  if (!queue.some((request) => request.id === id)) return;
  queue = queue.filter((request) => request.id !== id);
  emit();
}

function enqueue<T>(build: (settle: (value: T) => void) => DistributiveOmit<AppDialogRequest, "id">): Promise<T> {
  if (mountedHostCount === 0) {
    // 表示先が無いまま待たせると、標準ダイアログと同じく操作が黙って止まる。呼び出し側へ失敗として返す。
    return Promise.reject(new Error("appDialog: AppDialogHost is not mounted"));
  }
  return new Promise<T>((resolve) => {
    const id = nextRequestId++;
    let settled = false;
    const settle = (value: T) => {
      if (settled) return;
      settled = true;
      removeRequest(id);
      resolve(value);
    };
    queue = [...queue, { id, ...build(settle) } as AppDialogRequest];
    emit();
  });
}

function cancelAllRequests(clearShown = false) {
  const pending = queue;
  if (pending.length === 0 && !clearShown) return;
  queue = [];
  if (clearShown) snapshot = { active: null, shown: null };
  for (const request of pending) {
    if (request.kind === "confirm") request.settle(false);
    else if (request.kind === "confirmWithCheckbox") request.settle(null);
    else if (request.kind === "prompt" || request.kind === "choose") request.settle(null);
    else request.settle();
  }
  emit();
}

export const appDialog = {
  /** 本人/接続の失効時に全依頼を取消し、閉じるアニメーション用の内容も同期的に消す。hostは引き続き使える。 */
  cancelAll(): void {
    cancelAllRequests(true);
  },
  /** 確認ダイアログ。確定で true、キャンセル・閉じるで false。 */
  confirm(options: AppConfirmOptions): Promise<boolean> {
    return enqueue<boolean>((settle) => ({ kind: "confirm", options, settle }));
  },
  /**
   * チェックの欄つきの確認ダイアログ（例: ログアウトの確認の「ほかの端末でもログアウトする」）。チェックは既定でオフ。
   * 確定で `{ checked }`、キャンセル・閉じるで null。確定のあとの処理中の二重押し防止は呼び出し側（busy）で行う。
   */
  confirmWithCheckbox(options: AppConfirmWithCheckboxOptions): Promise<AppConfirmWithCheckboxResult> {
    return enqueue<AppConfirmWithCheckboxResult>((settle) => ({ kind: "confirmWithCheckbox", options, settle }));
  },
  /** 入力ダイアログ。確定で入力値、キャンセル・閉じるで null。 */
  prompt(options: AppPromptOptions): Promise<string | null> {
    return enqueue<string | null>((settle) => ({ kind: "prompt", options, settle }));
  },
  /** 2つの結果と「続ける/閉じる」の3択。未保存の移動など、confirm の真偽では足りないときに使う。 */
  choose<T extends string>(options: AppChooseOptions<T>): Promise<T | null> {
    return enqueue<string | null>((settle) => ({ kind: "choose", options, settle })) as Promise<T | null>;
  },
  /** 通知ダイアログ。閉じると解決する。 */
  alert(options: AppAlertOptions): Promise<void> {
    return enqueue<void>((settle) => ({ kind: "alert", options, settle: () => settle(undefined) }));
  },
};

// ---- AppDialogHost 用 ----

export function subscribeAppDialogRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAppDialogSnapshot(): AppDialogSnapshot {
  return snapshot;
}

/** host のマウント中だけ依頼を受け付ける。最後の host が外れたら待っている依頼はキャンセル扱いで返す。 */
export function registerAppDialogHost(): () => void {
  mountedHostCount += 1;
  return () => {
    mountedHostCount -= 1;
    if (mountedHostCount === 0) cancelAllRequests();
  };
}
