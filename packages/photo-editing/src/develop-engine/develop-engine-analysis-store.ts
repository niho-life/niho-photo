/**
 * 再起動後の解析の再利用（#155）。保存するのは写真の SHA-256 と engine / 解析設定で識別した compact 解析 bytes だけ。
 * 写真本体、ファイル名、パス、補正設定の JSON は保存しない。使えない・容量不足なら呼び出し側が通常の再計算へ戻す。
 */

import { NATIVE_DEVELOP_BASE_URL } from "./develop-engine-native-glue";

export type DevelopAnalysisStore = {
  get: (id: string) => Promise<ArrayBuffer | null>;
  put: (id: string, bytes: ArrayBuffer) => Promise<void>;
};

const DATABASE_NAME = "niho-photo-develop-analysis";
const STORE_NAME = "entries";
const MAX_ENTRIES = 4;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;

type StoredAnalysis = { id: string; bytes: ArrayBuffer; savedAt: number };

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("analysis storage failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("analysis storage failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("analysis storage aborted"));
  });
}

/** Worker の IndexedDB を開く。作れない環境では null を返す。 */
export function createBrowserDevelopAnalysisStore(): DevelopAnalysisStore | null {
  if (typeof indexedDB === "undefined") return null;
  let database: Promise<IDBDatabase> | null = null;
  const open = () => {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
          store.createIndex("savedAt", "savedAt");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("analysis storage unavailable"));
      request.onblocked = () => reject(new Error("analysis storage blocked"));
    }).catch((error: unknown) => {
      database = null;
      throw error;
    });
    return database;
  };

  return {
    async get(id) {
      const db = await open();
      const record: unknown = await requestResult(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id));
      if (typeof record !== "object" || record === null || !("bytes" in record)) return null;
      const bytes = (record as StoredAnalysis).bytes;
      return bytes instanceof ArrayBuffer && bytes.byteLength > 0 && bytes.byteLength <= MAX_ENTRY_BYTES ? bytes : null;
    },
    async put(id, bytes) {
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ENTRY_BYTES) return;
      const db = await open();
      const write = db.transaction(STORE_NAME, "readwrite");
      write.objectStore(STORE_NAME).put({ id, bytes, savedAt: Date.now() } satisfies StoredAnalysis);
      await transactionDone(write);

      // 件数で上限を決める。1 件は最大 16 MiB なので、永続領域は最大 64 MiB。
      const prune = db.transaction(STORE_NAME, "readwrite");
      const store = prune.objectStore(STORE_NAME);
      let excess = (await requestResult(store.count())) - MAX_ENTRIES;
      if (excess > 0) {
        const cursor = store.index("savedAt").openKeyCursor();
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (!current || excess <= 0) return;
          store.delete(current.primaryKey);
          excess -= 1;
          current.continue();
        };
      }
      await transactionDone(prune);
    },
  };
}

/** Mac アプリでは WebKit storage の初期化後も残る作業コピーの native cache を使う。Worker 内の同期 XHR は現像 glue と同じ口。 */
export function createNativeDevelopAnalysisStore(): DevelopAnalysisStore | null {
  if (typeof XMLHttpRequest === "undefined" || !globalThis.crypto?.getRandomValues) return null;
  const token = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const idBytes = (id: string) => {
    if (!/^[0-9a-f]{64}$/u.test(id)) throw new Error("invalid analysis cache key");
    return new TextEncoder().encode(id);
  };
  const request = (method: "Analysis.get" | "Analysis.put", body: Uint8Array): { status: number; bytes: ArrayBuffer | null } => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${NATIVE_DEVELOP_BASE_URL}${method}`, false);
    xhr.responseType = "arraybuffer";
    xhr.setRequestHeader("X-Niho-Develop-Client", token);
    xhr.send(body);
    return { status: xhr.status, bytes: xhr.response instanceof ArrayBuffer ? xhr.response : null };
  };
  return {
    async get(id) {
      const response = request("Analysis.get", idBytes(id));
      if (response.status === 404) return null;
      if (response.status !== 200 || !response.bytes) throw new Error("analysis cache unavailable");
      return response.bytes.byteLength > 0 && response.bytes.byteLength <= MAX_ENTRY_BYTES ? response.bytes : null;
    },
    async put(id, bytes) {
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ENTRY_BYTES) return;
      const key = idBytes(id);
      const body = new Uint8Array(key.byteLength + bytes.byteLength);
      body.set(key);
      body.set(new Uint8Array(bytes), key.byteLength);
      if (request("Analysis.put", body).status !== 200) throw new Error("analysis cache unavailable");
    },
  };
}
