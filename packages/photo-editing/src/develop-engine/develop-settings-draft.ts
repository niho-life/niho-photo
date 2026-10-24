import {
  DEVELOP_SETTINGS_ENGINE,
  NIHO2_DEVELOP_SETTINGS_ENGINE,
  NIHO6_DEVELOP_SETTINGS_ENGINE,
  NIHO10_DEVELOP_SETTINGS_ENGINE,
  NIHO12_DEVELOP_SETTINGS_ENGINE,
  NIHO13_DEVELOP_SETTINGS_ENGINE,
  NIHO4_DEVELOP_SETTINGS_ENGINE,
  NIHO4_DEVELOP_SETTINGS_LOOK,
  NIHO7_DEVELOP_SETTINGS_ENGINE,
  NIHO7_DEVELOP_SETTINGS_LOOK,
  NIHO11_DEVELOP_SETTINGS_ENGINE,
  SIGNED_DEVELOP_SETTINGS_ENGINE,
  SIGNED_DEVELOP_SETTINGS_LOOK,
  isEditableDevelopSettings,
  readDevelopSettings,
  type DevelopSettings,
} from "./develop-settings";

/** 写真の未保存補正を端末内へ退避する小さいレコード。画像・URL・token・表示名は持たない。 */
export type DevelopSettingsDraft = {
  schema: 1;
  draftId: string;
  /** 古い削除が、別タブで書かれた次の世代を消さないための固有キー。 */
  writeId: string;
  actorId: string;
  spotId: string;
  photoId: string;
  generation: number;
  updatedAt: number;
  startedRevision: number;
  /** revision_stale を受けた編集セッションの値。競合関係を UI で説明するためだけに持つ。 */
  conflicted: boolean;
  settings: DevelopSettings;
};

export type DevelopSettingsDraftScope = Pick<DevelopSettingsDraft, "actorId" | "spotId" | "photoId">;
export type DevelopSettingsDraftPhotoSetScope = Pick<DevelopSettingsDraft, "actorId" | "spotId">;
export type DevelopSettingsDraftIdentity = DevelopSettingsDraftScope & Pick<DevelopSettingsDraft, "draftId">;

export type DevelopSettingsDraftWriteResult =
  | { ok: true; draft: DevelopSettingsDraft }
  | { ok: false; error: unknown };

export type DevelopSettingsDraftReadResult =
  | { ok: true; drafts: DevelopSettingsDraft[] }
  | { ok: false; drafts: []; error: unknown };

const STORAGE_PREFIX = "niho:photo-develop-draft:v1:";
export const DEVELOP_SETTINGS_DRAFT_MAX_BYTES = 32 * 1024;
const MAX_ID_LENGTH = 256;
const MAX_STRING_LENGTH = 4096;
const MAX_KEY_LENGTH = 256;
const MAX_COLLECTION_LENGTH = 2048;
const MAX_DEPTH = 16;

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function validInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validJsonValue(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= MAX_STRING_LENGTH;
  if (Array.isArray(value)) {
    return value.length <= MAX_COLLECTION_LENGTH && value.every((item) => validJsonValue(item, depth + 1));
  }
  if (typeof value !== "object") return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    entries.length <= MAX_COLLECTION_LENGTH &&
    entries.every(([key, item]) => key.length <= MAX_KEY_LENGTH && validJsonValue(item, depth + 1))
  );
}

function storageKey(identity: DevelopSettingsDraftIdentity & { writeId: string }): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(identity.actorId)}:${encodeURIComponent(identity.spotId)}:${encodeURIComponent(identity.photoId)}:${encodeURIComponent(identity.draftId)}:${encodeURIComponent(identity.writeId)}`;
}

function scopePrefix(scope: DevelopSettingsDraftScope): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(scope.actorId)}:${encodeURIComponent(scope.spotId)}:${encodeURIComponent(scope.photoId)}:`;
}

function photoSetPrefix(scope: DevelopSettingsDraftPhotoSetScope): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(scope.actorId)}:${encodeURIComponent(scope.spotId)}:`;
}

function readRecord(raw: string, expectedKey?: string): DevelopSettingsDraft | null {
  if (raw.length > DEVELOP_SETTINGS_DRAFT_MAX_BYTES || new TextEncoder().encode(raw).byteLength > DEVELOP_SETTINGS_DRAFT_MAX_BYTES) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schema !== 1 ||
    !validId(record.draftId) ||
    !validId(record.writeId) ||
    !validId(record.actorId) ||
    !validId(record.spotId) ||
    !validId(record.photoId) ||
    !validInteger(record.generation) ||
    record.generation < 1 ||
    !validInteger(record.updatedAt) ||
    !validInteger(record.startedRevision) ||
    (record.conflicted !== undefined && typeof record.conflicted !== "boolean") ||
    !validJsonValue(record.settings)
  ) {
    return null;
  }
  const settings = readDevelopSettings(record.settings);
  if (!settings || !isEditableDevelopSettings(settings)) return null;
  const draft: DevelopSettingsDraft = {
    schema: 1,
    draftId: record.draftId,
    writeId: record.writeId,
    actorId: record.actorId,
    spotId: record.spotId,
    photoId: record.photoId,
    generation: record.generation,
    updatedAt: record.updatedAt,
    startedRevision: record.startedRevision,
    conflicted: record.conflicted === true,
    settings,
  };
  return expectedKey === undefined || storageKey(draft) === expectedKey ? draft : null;
}

function browserStorage(): Storage {
  if (typeof window === "undefined") throw new Error("develop draft storage is unavailable");
  return window.localStorage;
}

export function createDevelopSettingsDraftId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("secure random draft id is unavailable");
}

export function writeDevelopSettingsDraft(params: {
  identity: DevelopSettingsDraftIdentity;
  startedRevision: number;
  settings: DevelopSettings;
  now?: number;
  /** 同じwriterの直前の値。スライダー操作ごとの全storage走査を避ける。 */
  previous?: DevelopSettingsDraft;
}): DevelopSettingsDraftWriteResult {
  try {
    if (
      !validId(params.identity.actorId) ||
      !validId(params.identity.spotId) ||
      !validId(params.identity.photoId) ||
      !validId(params.identity.draftId) ||
      !validInteger(params.startedRevision) ||
      !validJsonValue(params.settings) ||
      !isEditableDevelopSettings(params.settings)
    ) {
      throw new Error("invalid develop draft");
    }
    const storage = browserStorage();
    const previous = params.previous ?? listDevelopSettingsDrafts(params.identity).drafts.find(
      (draft) => draft.draftId === params.identity.draftId,
    );
    if (previous && (previous.actorId !== params.identity.actorId || previous.spotId !== params.identity.spotId ||
        previous.photoId !== params.identity.photoId || previous.draftId !== params.identity.draftId)) {
      throw new Error("develop draft writer scope changed");
    }
    const now = params.now ?? Date.now();
    if (!validInteger(now)) throw new Error("invalid develop draft timestamp");
    const draft: DevelopSettingsDraft = {
      schema: 1,
      ...params.identity,
      writeId: createDevelopSettingsDraftId(),
      generation: (previous?.generation ?? 0) + 1,
      updatedAt: now,
      startedRevision: params.startedRevision,
      conflicted: previous?.conflicted ?? false,
      settings: params.settings,
    };
    const raw = JSON.stringify(draft);
    if (new TextEncoder().encode(raw).byteLength > DEVELOP_SETTINGS_DRAFT_MAX_BYTES) {
      throw new Error("develop draft is too large");
    }
    storage.setItem(storageKey(draft), raw);
    // 新しい世代を先に永続化してから、自分が置き換えた世代だけを片付ける。
    if (previous) removeDevelopSettingsDraft(previous);
    return { ok: true, draft };
  } catch (error) {
    return { ok: false, error };
  }
}

/** 壊れた・未知の値は候補にせず、そのまま残す。期限による削除もしない。 */
export function listDevelopSettingsDrafts(scope: DevelopSettingsDraftScope): DevelopSettingsDraftReadResult {
  try {
    if (!validId(scope.actorId) || !validId(scope.spotId) || !validId(scope.photoId)) {
      throw new Error("invalid develop draft scope");
    }
    const storage = browserStorage();
    const prefix = scopePrefix(scope);
    const drafts: DevelopSettingsDraft[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const raw = storage.getItem(key);
      if (raw === null) continue;
      const draft = readRecord(raw, key);
      if (
        draft &&
        draft.actorId === scope.actorId &&
        draft.spotId === scope.spotId &&
        draft.photoId === scope.photoId
      ) {
        drafts.push(draft);
      }
    }
    drafts.sort((a, b) => b.updatedAt - a.updatedAt || b.generation - a.generation || b.draftId.localeCompare(a.draftId));
    return { ok: true, drafts };
  } catch (error) {
    return { ok: false, drafts: [], error };
  }
}

/** 記事へ入れる写真群など、複数写真の未解決draftを1回のstorage走査で確認する。 */
export function listDevelopSettingsDraftsForPhotos(
  scope: DevelopSettingsDraftPhotoSetScope,
  photoIds: readonly string[],
): DevelopSettingsDraftReadResult {
  try {
    if (!validId(scope.actorId) || !validId(scope.spotId) || photoIds.some((photoId) => !validId(photoId))) {
      throw new Error("invalid develop draft photo set scope");
    }
    const wantedPhotoIds = new Set(photoIds);
    if (wantedPhotoIds.size === 0) return { ok: true, drafts: [] };
    const storage = browserStorage();
    const prefix = photoSetPrefix(scope);
    const drafts: DevelopSettingsDraft[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const raw = storage.getItem(key);
      if (raw === null) continue;
      const draft = readRecord(raw, key);
      if (
        draft &&
        draft.actorId === scope.actorId &&
        draft.spotId === scope.spotId &&
        wantedPhotoIds.has(draft.photoId)
      ) {
        drafts.push(draft);
      }
    }
    drafts.sort((a, b) => b.updatedAt - a.updatedAt || b.generation - a.generation || b.draftId.localeCompare(a.draftId));
    return { ok: true, drafts };
  } catch (error) {
    return { ok: false, drafts: [], error };
  }
}

/** 選んだ draft が読み取った世代のままのときだけ消す。別タブが更新済みなら何もしない。 */
export function removeDevelopSettingsDraft(draft: DevelopSettingsDraft): boolean {
  try {
    const storage = browserStorage();
    const key = storageKey(draft);
    const currentRaw = storage.getItem(key);
    if (currentRaw === null) return true;
    const current = readRecord(currentRaw, key);
    if (!current || current.generation !== draft.generation || current.updatedAt !== draft.updatedAt) return false;
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** この編集セッションが revision_stale になった印を、現在の自分の draft にだけ付ける。 */
export function markDevelopSettingsDraftConflicted(identity: DevelopSettingsDraftIdentity): boolean {
  try {
    const storage = browserStorage();
    const current = listDevelopSettingsDrafts(identity).drafts.find((draft) => draft.draftId === identity.draftId);
    if (!current) return false;
    const key = storageKey(current);
    if (!current || current.conflicted) return current?.conflicted === true;
    const next: DevelopSettingsDraft = { ...current, conflicted: true };
    storage.setItem(key, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/**
 * 未保存の補正（draft の `settings`）を今開いている写真へ戻せるか。draft が直せる形で、土台の版（`base`）が今の入力の版と、数式・
 * ルックが今の編集内容と同じときだけ戻す（違う土台・数式で作った補正を読み替えない）。ただし保存したことの無い写真で、新規編集の
 * 既定を niho-2 / niho-6 / niho-10 / niho-12 / niho-13 → niho-14 に変える前に作った draft（土台とルックは同じ）は、draft の旧数式のまま戻す。
 * 同様に、対応校正 signed RAW の既定を niho-4/3/7 → niho-11 に変える前の正しい旧pairも、未保存かつ同じ土台に限って旧pairのまま戻す
 * （既定が変わっただけで未保存の補正を失わない。移行元設計、移行元設計）。
 */
export function canRestoreDevelopSettingsDraft(params: {
  draftSettings: DevelopSettings;
  /** 今の編集内容（開いたときの土台に、それから直した分を重ねたもの） */
  currentSettings: DevelopSettings;
  /** 今の入力の土台の版（オリジナルから直接描く写真は null） */
  inputBase: string | null;
  /** 今の写真の行に補正（`developSettings`）を保存してあるか */
  hasSavedSettings: boolean;
}): boolean {
  const { draftSettings, currentSettings } = params;
  if (!isEditableDevelopSettings(draftSettings)) return false;
  const draftBase = Object.hasOwn(draftSettings, "base") ? draftSettings.base : null;
  if (draftBase !== params.inputBase) return false;
  const currentLook = Object.hasOwn(currentSettings, "look") ? currentSettings.look : undefined;
  const draftLook = Object.hasOwn(draftSettings, "look") ? draftSettings.look : undefined;
  const legacySignedDefaultDraft =
    !params.hasSavedSettings &&
    currentSettings.engine === NIHO11_DEVELOP_SETTINGS_ENGINE &&
    currentLook === NIHO7_DEVELOP_SETTINGS_LOOK &&
    ((draftSettings.engine === NIHO7_DEVELOP_SETTINGS_ENGINE && draftLook === NIHO7_DEVELOP_SETTINGS_LOOK) ||
      (draftSettings.engine === NIHO4_DEVELOP_SETTINGS_ENGINE && draftLook === NIHO4_DEVELOP_SETTINGS_LOOK) ||
      (draftSettings.engine === SIGNED_DEVELOP_SETTINGS_ENGINE && draftLook === SIGNED_DEVELOP_SETTINGS_LOOK));
  // 既定の切替前に作った未保存 signed RAW draft は、旧数式・旧ルックの対を保ったまま戻す。
  if (draftLook !== currentLook && !legacySignedDefaultDraft) return false;
  if (draftSettings.engine === currentSettings.engine) return true;
  return (
    legacySignedDefaultDraft ||
    (!params.hasSavedSettings &&
      (draftSettings.engine === NIHO2_DEVELOP_SETTINGS_ENGINE ||
        draftSettings.engine === NIHO6_DEVELOP_SETTINGS_ENGINE ||
        draftSettings.engine === NIHO10_DEVELOP_SETTINGS_ENGINE ||
        draftSettings.engine === NIHO12_DEVELOP_SETTINGS_ENGINE ||
        draftSettings.engine === NIHO13_DEVELOP_SETTINGS_ENGINE) &&
      currentSettings.engine === DEVELOP_SETTINGS_ENGINE)
  );
}

export function isDevelopSettingsDraftStorageKey(key: string | null): boolean {
  return typeof key === "string" && key.startsWith(STORAGE_PREFIX);
}
