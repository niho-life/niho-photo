"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";

import {
  DevelopMaskSurfaceError,
  type DevelopEngine,
  type DevelopMaskCapabilities,
  type DevelopMaskPlane,
} from "../develop-engine/develop-engine-client";
import { readDevelopGeometry, type DevelopSize } from "../develop-engine/develop-geometry";
import {
  MAX_DEVELOP_MASKS,
  readDevelopMasks,
  writeDevelopMasks,
  type DevelopMask,
  type DevelopMaskAdjustKey,
  type DevelopMaskHslBand,
  type DevelopMaskSurface,
} from "../develop-engine/develop-masks";
import type { DevelopSettings } from "../develop-engine/develop-settings";
import type { PhotoLibraryMaskDetectionKind, PhotoLibraryMaskDetectionResult } from "../library/photo-library";
import {
  PHOTO_EDITING_MASK_BRUSH_ADD_FAILED_TEXT,
  PHOTO_EDITING_MASK_DETECT_FAILED_TEXTS,
  PHOTO_EDITING_MASK_DETECT_NOT_FOUND_TEXTS,
  PHOTO_EDITING_MASK_EXPORT_UNSUPPORTED_TEXT,
  photoEditingMaskLabel,
  photoEditingMaskLimitText,
  photoEditingMaskSurfaceUnreadableText,
} from "../photo-editing-copy";
import {
  filledPhotoEditingMaskSurface,
  photoEditingMaskSurfaceSize,
  type PhotoEditingMaskSurfaceData,
} from "../photo-editing-mask-brush";
import {
  PHOTO_EDITING_MASK_SHAPE_KINDS,
  addPhotoEditingMask,
  createPhotoEditingMask,
  createPhotoEditingMaskId,
  duplicatePhotoEditingMask,
  isPhotoEditingMaskFrameValid,
  isPhotoEditingWhiteBalanceAbsolute,
  removePhotoEditingMask,
  resetPhotoEditingMaskHsl,
  setPhotoEditingMaskAdjust,
  setPhotoEditingMaskFeather,
  setPhotoEditingMaskHsl,
  togglePhotoEditingMaskEnabled,
  togglePhotoEditingMaskInvert,
  updatePhotoEditingMask,
  withPhotoEditingMaskShape,
  type PhotoEditingMaskFrame,
  type PhotoEditingMaskShapeKind,
} from "../photo-editing-masks";
import type { PhotoEditingHslAxis } from "../photo-editing-hsl";
import type { PhotoEditingShortcut } from "../use-photo-editing-shortcuts";

import { DEVELOP_COLOR_POINT_DRAG_MAX_DIMENSION, DEVELOP_PREVIEW_MAX_DIMENSION, type DevelopSession } from "./browser-photo-editing-model";
import type { PhotoEditingSettingsUpdate, PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";
import { readCropSource } from "./use-browser-photo-crop";
import { useBrowserPhotoMaskBrush } from "./use-browser-photo-mask-brush";

/** 写真から作る種類（被写体・空。写真の出どころの `detectMaskSurface`。niho-photo#135）。 */
export type PhotoEditingMaskDetectKind = PhotoLibraryMaskDetectionKind;

/**
 * 画面で足せる種類（線形・円形と、面を保存できる写真の出どころのブラシ〔M4 #68〕、面を写真から作れる出どころの被写体・空
 * 〔niho-photo#135〕）。
 */
export type PhotoEditingMaskAddKind = PhotoEditingMaskShapeKind | "brush" | PhotoEditingMaskDetectKind;

/** 写真から面を作る口（写真の出どころの `detectMaskSurface` を開いている写真に結んだもの）。 */
export type PhotoEditingMaskDetectSurface = (
  photoId: string,
  kind: PhotoEditingMaskDetectKind,
  options: { developSettings: object; signal: AbortSignal },
) => Promise<PhotoLibraryMaskDetectionResult>;

const PHOTO_EDITING_MASK_DETECT_KINDS: readonly PhotoEditingMaskDetectKind[] = ["subject", "sky"];

function isDetectKind(kind: PhotoEditingMaskAddKind): kind is PhotoEditingMaskDetectKind {
  return (PHOTO_EDITING_MASK_DETECT_KINDS as readonly string[]).includes(kind);
}

/** 写真の出どころが面を作れる種類（`capabilities.maskDetection` の true の種類。省略 = 無し）。 */
export function photoEditingMaskDetectKinds(capabilities: {
  maskDetection?: Partial<Record<PhotoEditingMaskDetectKind, boolean>>;
}): PhotoEditingMaskDetectKind[] {
  return PHOTO_EDITING_MASK_DETECT_KINDS.filter((kind) => capabilities.maskDetection?.[kind] === true);
}

/** 写真の描画が面を読めなかったマスク（`useBrowserPhotoOpen` が描画の失敗から知らせる）。 */
export type PhotoEditingMaskSurfaceIssue = { photoKey: string; maskIds: string[] };

/**
 * 部分補正（マスク）を描ける wasm か（`engine.supportsMasks()`。wasm の `capabilities()`）。wasm で開いた写真を 1 枚で見ているときに
 * 1 回だけ確かめ、結果は画面を開いている間覚える（色ミキサーの `useBrowserPhotoColorPointsSupport` と同じ）。確かめている間・
 * 口の無い古い wasm・wasm を使えないときは null（道具を出さない）。
 */
export function useBrowserPhotoMasksSupport(params: {
  mountedRef: MutableRefObject<boolean>;
  engineRef: MutableRefObject<DevelopEngine | null>;
  photoKey: string | null;
}): DevelopMaskCapabilities | null {
  const { mountedRef, engineRef, photoKey } = params;
  const [supported, setSupported] = useState<DevelopMaskCapabilities | null | undefined>(undefined);
  const wanted = photoKey !== null;
  useEffect(() => {
    if (!wanted || supported !== undefined) return;
    const engine = engineRef.current;
    if (!engine) return;
    if (!engine.supportsMasks) {
      setSupported(null);
      return;
    }
    let cancelled = false;
    engine.supportsMasks().then(
      (value) => {
        if (!cancelled && mountedRef.current) setSupported(value ?? null);
      },
      () => {
        if (!cancelled && mountedRef.current) setSupported(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [engineRef, mountedRef, photoKey, supported, wanted]);
  return supported ?? null;
}

/**
 * 原寸の書き出しの描画がマスクを描けないか（足すのを止めて理由を出す）。この Mac の原寸の書き出し（`nativeExport`・更新が要る
 * `nativeExportUpdateRequired`）があるのに `nativeExportMasks` が true でない（`PhotoLibraryCapabilities` の「省略 = 描けない」）
 * とき。原寸の書き出しの無い出どころ（ブラウザのクラウド）は wasm が描くので止めない。
 */
export function photoEditingMaskExportBlocked(capabilities: {
  nativeExport: boolean;
  nativeExportUpdateRequired: boolean;
  nativeExportMasks?: boolean;
}): boolean {
  return (capabilities.nativeExport || capabilities.nativeExportUpdateRequired) && capabilities.nativeExportMasks !== true;
}

/**
 * 足せる種類（wasm が描ける種類のうち、画面で作れるもの）。ブラシは面を受け渡せる wasm（`surfaces`）で、写真の出どころが面を保存
 * できる（`canSaveSurfaces`）ときだけ。被写体・空は面を受け渡せる wasm で、写真の出どころがその種類の面を作れる（`detectKinds`）
 * ときだけ。空は、出どころが作れなくても、wasm が空を探せて（`engineSky`。niho-photo#141）面を保存できれば足せる。
 */
function addKinds(
  support: DevelopMaskCapabilities | null,
  canSaveSurfaces: boolean,
  detectKinds: readonly PhotoEditingMaskDetectKind[],
  engineSky: boolean,
): PhotoEditingMaskAddKind[] {
  if (!support) return [];
  const kinds: PhotoEditingMaskAddKind[] = PHOTO_EDITING_MASK_SHAPE_KINDS.filter((kind) => support.kinds.includes(kind));
  if (canSaveSurfaces && support.surfaces === true && support.kinds.includes("brush")) kinds.push("brush");
  if (support.surfaces === true) {
    const made = (kind: PhotoEditingMaskDetectKind) =>
      detectKinds.includes(kind) || (kind === "sky" && engineSky && canSaveSurfaces);
    kinds.push(...PHOTO_EDITING_MASK_DETECT_KINDS.filter((kind) => made(kind) && support.kinds.includes(kind)));
  }
  return kinds;
}

/**
 * ブラウザ版の右パネルのマスクの道具（部分補正。Epic #31 M3 #67。契約は `docs/local-adjustments.md`）の状態。
 *
 * - 出す条件（`available`）: 直せる幅（PC の幅か、スマホの全画面の編集の層。niho-photo#93）・wasm で開いて 1 枚で見ている写真・
 *   描ける種類のある wasm（`useBrowserPhotoMasksSupport`）
 * - 入るとき（`enter`）に座標の基準（作業画像の大きさ。切り抜きと同じ `readCropSource`）を読む。読めるまで足すボタンは押せない
 * - 編集はすべて `changeSettings(update, phase)` を通す（`drag` は速い描き方で履歴に積まず、`commit` が取り消しの 1 単位。自動保存・
 *   下書きの退避・取り消しはそのまま効く）。`update` は呼ばれた時点の最新の設定のマスクに当てる
 * - 選んでいるマスクは id で覚える（取り消しで無くなれば選んでいない扱い）。写真を替える・出す条件を満たさなくなる・切り抜き /
 *   背景除去の道具に移ると「補正」に戻す
 */
export function useBrowserPhotoMasks(params: {
  mountedRef: MutableRefObject<boolean>;
  engineRef: MutableRefObject<DevelopEngine | null>;
  developSessionRef: MutableRefObject<DevelopSession | null>;
  /** 直せる幅（PC の幅か、スマホの全画面の編集の層。どちらでもない狭い幅には出さない） */
  wide: boolean;
  /** wasm で開いて 1 枚で見ている写真の key（ほかは null） */
  photoKey: string | null;
  support: DevelopMaskCapabilities | null;
  /** 原寸の書き出しがマスクを描けない（{@link photoEditingMaskExportBlocked}） */
  exportBlocked: boolean;
  /** 切り抜き・背景除去の道具を使っている（道具は 1 つずつ） */
  otherToolActive: boolean;
  /** 押せない（閲覧のみ・操作の途中など。右パネルの `controlsDisabled`） */
  disabled: boolean;
  settings: DevelopSettings;
  settingsRef: MutableRefObject<DevelopSettings>;
  changeSettings: (update: PhotoEditingSettingsUpdate, phase: PhotoEditingSliderPhase) => void;
  /** 取り消しの 1 単位として確定する（「初期化」で使う） */
  commitEdit: (next: DevelopSettings, options?: { resetDone?: boolean }) => boolean;
  /**
   * マスクの面を写真に保存する口（写真の出どころの `saveMaskSurface`。`capabilities.maskSurfaces` のときだけ渡す。無ければブラシを
   * 出さない）。写真は開いている session の `photoId`
   */
  saveMaskSurface?: ((photoId: string, png: Uint8Array) => Promise<{ id: string }>) | null;
  /**
   * 被写体・空の面を写真から作る口（写真の出どころの `detectMaskSurface`。`capabilities.maskDetection` で作れる種類を `detectKinds`
   * に渡す。無ければ「被写体」を出さない。空は wasm が探せれば出す）。写真は開いている session の `photoId`
   */
  detectMaskSurface?: PhotoEditingMaskDetectSurface | null;
  detectKinds?: readonly PhotoEditingMaskDetectKind[];
  /**
   * 空を wasm で探すとき（niho-photo#141）の撮影時の露出（ISO 100 の EV。写真の情報の ExposureTime・FNumber・ISO から）。読めない・
   * 分からなければ null（写真の中の相対の明るさで探す）。無ければ露出なしで探す。写真は開いている session の `photoId`
   */
  readEv100?: ((photoId: string) => Promise<number | null>) | null;
  /** 写真の描画が面を読めなかったマスク（無ければ null） */
  surfaceIssue?: PhotoEditingMaskSurfaceIssue | null;
  /** 面を読み直して描き直す */
  onRetrySurfaces?: () => void;
  /** id の乱数（テスト用） */
  random?: () => number;
  /** 面の PNG を値に戻す（テスト用） */
  decodeMaskSurface?: (png: Uint8Array) => Promise<PhotoEditingMaskSurfaceData>;
}) {
  const { mountedRef, engineRef, developSessionRef, wide, photoKey, support, settings, settingsRef, changeSettings, commitEdit } =
    params;
  const random = params.random ?? Math.random;
  const saveMaskSurface = params.saveMaskSurface ?? null;
  const detectMaskSurface = params.detectMaskSurface ?? null;
  const detectKinds = detectMaskSurface ? (params.detectKinds ?? []) : [];
  /** wasm が空を探せるか（`engine.supportsSkyDetection()`。描ける種類を読んだ後〔wasm を起こした後〕に確かめる。niho-photo#141） */
  const [engineSky, setEngineSky] = useState(false);
  useEffect(() => {
    setEngineSky(support?.surfaces === true && engineRef.current?.supportsSkyDetection?.() === true);
  }, [engineRef, support]);
  const kinds = addKinds(support, saveMaskSurface !== null, detectKinds, engineSky);
  const available = wide && photoKey !== null && kinds.length > 0;
  const [active, setActive] = useState(false);
  const [source, setSource] = useState<{ key: string; size: DevelopSize } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 選んでいるマスクの範囲を赤く重ねる（O。写真を替えても保つ） */
  const [overlayVisible, setOverlayVisible] = useState(false);
  /** 写真の上のつまみを動かしている間（範囲を重ねて見せる） */
  const [shapeDragging, setShapeDragging] = useState(false);
  const generationRef = useRef(0);
  /** 写真から範囲を探している種類（探している間はほかの追加も止める。取り消せる） */
  const [detecting, setDetecting] = useState<PhotoEditingMaskDetectKind | null>(null);
  const detectControllerRef = useRef<AbortController | null>(null);

  /** 写真から範囲を探しているのをやめる（native の検出も止める）。 */
  const cancelDetect = useCallback(() => {
    detectControllerRef.current?.abort();
    detectControllerRef.current = null;
    setDetecting(null);
  }, []);

  const leave = useCallback(() => {
    generationRef.current += 1;
    cancelDetect();
    setActive(false);
    setShapeDragging(false);
  }, [cancelDetect]);
  // 画面を閉じたら探しているのをやめる
  useEffect(() => cancelDetect, [cancelDetect]);

  // 写真を替えた・出す条件を満たさなくなった・ほかの道具に移ったら「補正」に戻す（選択も捨てる）
  useEffect(() => {
    leave();
    setSelectedId(null);
    setSource(null);
  }, [leave, photoKey]);
  useEffect(() => {
    if (!available || params.otherToolActive) leave();
  }, [available, leave, params.otherToolActive]);

  const enter = useCallback(() => {
    if (!available || photoKey === null) return;
    setActive(true);
    if (source?.key === photoKey) return;
    const generation = ++generationRef.current;
    const engine = engineRef.current;
    const session = developSessionRef.current;
    if (!engine || !session) return;
    void readCropSource(engine, session).then(
      (read) => {
        if (!mountedRef.current || generation !== generationRef.current || !read) return;
        setSource({ key: photoKey, size: read.source });
      },
      () => undefined,
    );
  }, [available, developSessionRef, engineRef, mountedRef, photoKey, source?.key]);

  const masks = useMemo(() => readDevelopMasks(settings), [settings]);
  const geometry = useMemo(() => readDevelopGeometry(settings), [settings]);
  const sourceSize = source && source.key === photoKey ? source.size : null;
  const frame = useMemo<PhotoEditingMaskFrame | null>(
    () => (sourceSize ? { geometry, source: sourceSize } : null),
    [geometry, sourceSize],
  );
  const frameValid = isPhotoEditingMaskFrameValid(frame);
  const selected = masks.find((mask) => mask.id === selectedId) ?? null;
  const selectedIndex = selected ? masks.indexOf(selected) : -1;
  const max = Math.min(support?.max ?? MAX_DEVELOP_MASKS, MAX_DEVELOP_MASKS);
  const whiteBalanceAbsolute = isPhotoEditingWhiteBalanceAbsolute(settings);
  const addBlockedReason = params.exportBlocked
    ? PHOTO_EDITING_MASK_EXPORT_UNSUPPORTED_TEXT
    : masks.length >= max
      ? photoEditingMaskLimitText(max)
      : null;
  /** ブラシのマスクを足している途中（空の面を作って保存している間。ほかの追加も止める） */
  const [addingBrush, setAddingBrush] = useState(false);
  const [addNotice, setAddNotice] = useState<string | null>(null);
  useEffect(() => {
    setAddingBrush(false);
    setAddNotice(null);
  }, [photoKey]);
  const canAdd = active && !params.disabled && addBlockedReason === null && frameValid && !addingBrush && detecting === null;
  /** 面を写真に保存する口（開いている session の写真に結ぶ） */
  const saveSurface = useMemo(
    () =>
      saveMaskSurface
        ? (png: Uint8Array) => {
            const session = developSessionRef.current;
            if (!session) return Promise.reject(new Error("no photo is open"));
            return saveMaskSurface(session.photoId, png);
          }
        : null,
    [developSessionRef, saveMaskSurface],
  );

  /** 最新の設定のマスクを書き換える（壊れる・変わらない書き換えは設定を返したまま）。 */
  const changeMasks = useCallback(
    (update: (masks: DevelopMask[], current: DevelopSettings) => DevelopMask[], phase: PhotoEditingSliderPhase) => {
      changeSettings((current) => {
        const develop = current as DevelopSettings;
        try {
          return writeDevelopMasks(develop, update(readDevelopMasks(develop), develop));
        } catch {
          return current;
        }
      }, phase);
    },
    [changeSettings],
  );

  const brush = useBrowserPhotoMaskBrush({
    mountedRef,
    engineRef,
    photoKey,
    active,
    disabled: params.disabled,
    mask: selected,
    maskName: selected ? photoEditingMaskLabel(selected.kind, selectedIndex) : null,
    frame: frameValid ? frame : null,
    saveSurface,
    settingsRef,
    changeMasks,
    decode: params.decodeMaskSurface,
  });

  /**
   * ブラシのマスクを足す: 作業画像の縦横比の空の面（長辺 1024・全部 0）を PNG にして写真に保存し、`{ kind: "brush", surface }` を
   * 1 単位で足して選ぶ（選ぶと塗る）。作っている間は足すボタンを押せない。写真を替えたら足さない。
   */
  const addBrush = () => {
    const engine = engineRef.current;
    if (!frame || !saveSurface || !engine?.encodeMaskSurface) return;
    const size = photoEditingMaskSurfaceSize(frame.source);
    const generation = generationRef.current;
    setAddingBrush(true);
    setAddNotice(null);
    void (async () => {
      const encoded = await engine.encodeMaskSurface!(size.width, size.height, filledPhotoEditingMaskSurface(size.width, size.height, 0));
      const saved = await saveSurface(encoded.png);
      if (saved.id !== encoded.id) throw new Error("saved mask surface has another id");
      return encoded.id;
    })().then(
      (surfaceId) => {
        if (!mountedRef.current) return;
        setAddingBrush(false);
        // 写真を替えた・道具を離れたら足さない（保存した空の面は使われないだけ）
        if (generation !== generationRef.current) return;
        const id = createPhotoEditingMaskId(readDevelopMasks(settingsRef.current), random);
        let added = false;
        changeMasks((current) => {
          if (current.length >= max) return current;
          added = true;
          return addPhotoEditingMask(current, {
            id,
            kind: "brush",
            enabled: true,
            invert: false,
            surface: { id: surfaceId, ...size },
            adjust: {},
          });
        }, "commit");
        if (added) setSelectedId(id);
      },
      () => {
        if (!mountedRef.current) return;
        setAddingBrush(false);
        if (generation === generationRef.current) setAddNotice(PHOTO_EDITING_MASK_BRUSH_ADD_FAILED_TEXT);
      },
    );
  };

  /**
   * 写真から範囲を探して面のマスクを足す（被写体・空）: `find` が面を作って写真に保存し（数秒。取り消せる）、`{ kind, surface }` を
   * 1 単位で足して選ぶ。範囲が無ければ（null）理由の 1 行、失敗も理由の 1 行。写真を替えた・道具を離れた・取り消したら足さない。
   */
  const detectAndAdd = (
    kind: PhotoEditingMaskDetectKind,
    find: (signal: AbortSignal) => Promise<DevelopMaskSurface | null>,
  ) => {
    const generation = generationRef.current;
    const controller = new AbortController();
    detectControllerRef.current?.abort();
    detectControllerRef.current = controller;
    setDetecting(kind);
    setAddNotice(null);
    const settle = (run: () => void) => {
      if (detectControllerRef.current !== controller) return;
      detectControllerRef.current = null;
      if (!mountedRef.current) return;
      setDetecting(null);
      if (generation !== generationRef.current) return;
      run();
    };
    void Promise.resolve()
      .then(() => find(controller.signal))
      .then(
        (surface) =>
          settle(() => {
            if (!surface) {
              setAddNotice(PHOTO_EDITING_MASK_DETECT_NOT_FOUND_TEXTS[kind]);
              return;
            }
            const id = createPhotoEditingMaskId(readDevelopMasks(settingsRef.current), random);
            let added = false;
            changeMasks((current) => {
              if (current.length >= max) return current;
              added = true;
              return addPhotoEditingMask(current, { id, kind, enabled: true, invert: false, surface, adjust: {} });
            }, "commit");
            if (added) setSelectedId(id);
          }),
        () => settle(() => setAddNotice(PHOTO_EDITING_MASK_DETECT_FAILED_TEXTS[kind])),
      );
  };

  /** 被写体・空のマスクを、写真の出どころが作業画像から作る面で足す（niho-photo#135）。 */
  const addDetected = (kind: PhotoEditingMaskDetectKind) => {
    const session = developSessionRef.current;
    if (!session || !detectMaskSurface) return;
    detectAndAdd(kind, async (signal) => {
      const result = await detectMaskSurface(session.photoId, kind, { developSettings: settingsRef.current, signal });
      return result.kind === "notFound" ? null : { id: result.id, width: result.width, height: result.height };
    });
  };

  /**
   * 空のマスクを、wasm が開いている写真の作業画像から探した面で足す（niho-photo#141。出どころが空を作れないとき）: 撮影時の露出を
   * 読み（読めなければ相対の明るさ）、`engine.detectSky` の面をブラシと同じ口で写真に保存し（id を照らす。作った PNG はエンジンが
   * 覚えて次の描画で渡す）、足して選ぶ。wasm の検出は途中で止められないので、取り消した・写真を替えたら結果を捨てて保存しない。
   */
  const addEngineSky = () => {
    const engine = engineRef.current;
    const session = developSessionRef.current;
    if (!engine?.detectSky || !session || !saveMaskSurface) return;
    const developSettings = settingsRef.current;
    const readEv100 = params.readEv100 ?? null;
    detectAndAdd("sky", async (signal) => {
      const ev100 = readEv100 ? await readEv100(session.photoId).catch(() => null) : null;
      if (signal.aborted) return null;
      const detected = await engine.detectSky?.(developSettings, ev100);
      if (!detected || signal.aborted) return null;
      // 探した写真に保存する（写真を替えたら取り消し済み）
      const saved = await saveMaskSurface(session.photoId, detected.png);
      if (saved.id !== detected.id) throw new Error("saved mask surface has another id");
      return { id: detected.id, width: detected.width, height: detected.height };
    });
  };

  const add = (kind: PhotoEditingMaskAddKind) => {
    if (!canAdd || !kinds.includes(kind) || !frame) return;
    if (kind === "brush") {
      addBrush();
      return;
    }
    if (kind === "sky" && !detectKinds.includes("sky")) {
      addEngineSky();
      return;
    }
    if (isDetectKind(kind)) {
      addDetected(kind);
      return;
    }
    const id = createPhotoEditingMaskId(readDevelopMasks(settingsRef.current), random);
    changeMasks((current, develop) => {
      if (current.length >= max) return current;
      const mask = createPhotoEditingMask(kind, { geometry: readDevelopGeometry(develop), source: frame.source }, id);
      return mask ? addPhotoEditingMask(current, mask) : current;
    }, "commit");
    setSelectedId(id);
  };

  const duplicate = (id: string) => {
    if (params.disabled || addBlockedReason !== null) return;
    const newId = createPhotoEditingMaskId(readDevelopMasks(settingsRef.current), random);
    changeMasks(
      (current, develop) =>
        current.length >= max
          ? current
          : duplicatePhotoEditingMask(current, id, frame ? { geometry: readDevelopGeometry(develop), source: frame.source } : null, newId),
      "commit",
    );
    setSelectedId(newId);
  };

  const remove = (id: string) => {
    if (params.disabled) return;
    changeMasks((current) => removePhotoEditingMask(current, id), "commit");
    setSelectedId((current) => (current === id ? null : current));
  };

  const toggleEnabled = (id: string) => {
    if (params.disabled) return;
    changeMasks((current) => updatePhotoEditingMask(current, id, togglePhotoEditingMaskEnabled), "commit");
  };

  const toggleInvert = (id: string) => {
    if (params.disabled) return;
    changeMasks((current) => updatePhotoEditingMask(current, id, togglePhotoEditingMaskInvert), "commit");
  };

  const changeAdjust = (id: string, key: DevelopMaskAdjustKey, value: number, phase: PhotoEditingSliderPhase) => {
    changeMasks(
      (current, develop) =>
        updatePhotoEditingMask(current, id, (mask) =>
          setPhotoEditingMaskAdjust(mask, key, value, { whiteBalanceAbsolute: isPhotoEditingWhiteBalanceAbsolute(develop) }),
        ),
      phase,
    );
  };

  /** 局所のカラーミキサー（niho-photo#93。`drag` は途中、`commit` が取り消しの 1 単位） */
  const changeHsl = (
    id: string,
    band: DevelopMaskHslBand,
    axis: PhotoEditingHslAxis,
    value: number,
    phase: PhotoEditingSliderPhase,
  ) => {
    changeMasks((current) => updatePhotoEditingMask(current, id, (mask) => setPhotoEditingMaskHsl(mask, band, axis, value)), phase);
  };

  /** 局所のカラーミキサーの「初期化」（24 の値を 0 に戻す。取り消しの 1 単位） */
  const resetHsl = (id: string) => {
    if (params.disabled) return;
    changeMasks((current) => updatePhotoEditingMask(current, id, resetPhotoEditingMaskHsl), "commit");
  };

  const changeFeather = (id: string, value: number, phase: PhotoEditingSliderPhase) => {
    changeMasks((current) => updatePhotoEditingMask(current, id, (mask) => setPhotoEditingMaskFeather(mask, value)), phase);
  };

  /** 写真の上で動かした形（`drag` は途中、`commit` は離した・キーを離した＝取り消しの 1 単位）。 */
  const changeShape = (mask: DevelopMask, phase: "drag" | "commit") => {
    changeMasks((current) => updatePhotoEditingMask(current, mask.id, (previous) => withPhotoEditingMaskShape(previous, mask)), phase);
  };

  /** 「初期化」（マスクの道具の間はマスクだけを外す。取り消しの 1 単位で「初期化しました」を出す）。 */
  const canReset = masks.length > 0;
  const reset = () => {
    if (params.disabled) return;
    setSelectedId(null);
    try {
      commitEdit(writeDevelopMasks(settingsRef.current, []), { resetDone: true });
    } catch {
      // 書けない設定は変えない
    }
  };

  /**
   * 写真の編集のキー（`usePhotoEditingShortcuts`）のうち、マスクの道具の間に先に扱うもの。Esc は選択を外す（選んでいなければ
   * 扱わない＝「補正」に戻る）、⌫ / Delete は選んでいるマスクを削除する（選んでいなくても写真は消さない）。扱ったら true。
   */
  const handleShortcut = (shortcut: PhotoEditingShortcut, event: Pick<KeyboardEvent, "preventDefault">): boolean => {
    if (!active) return false;
    if (shortcut === "escape") {
      if (selectedId === null) return false;
      event.preventDefault();
      // ブラシで塗っている間は、塗るのをやめるだけ（マスクは選んだまま。もう一度で選択を外す）
      if (brush.layerVisible) brush.leavePaint();
      else setSelectedId(null);
      return true;
    }
    if (shortcut === "delete") {
      event.preventDefault();
      if (selected) remove(selected.id);
      return true;
    }
    // E: 塗っている間は消しゴムの切り替え（1 枚の表示へ移るキーとしては使わない）
    if (shortcut === "loupe" && brush.layerVisible) {
      event.preventDefault();
      brush.toggleErase();
      return true;
    }
    return false;
  };

  // 面を読めないマスク（描画・重ね表示が面を読めなかった）の理由の 1 行
  const [planeIssue, setPlaneIssue] = useState<{ photoKey: string; maskId: string } | null>(null);
  /** 重ね表示の面を読めた・読めなかった（面の失敗だけを理由にする） */
  const reportPlane = useCallback(
    (maskId: string, error: unknown) => {
      if (photoKey === null) return;
      if (error === null) {
        setPlaneIssue((current) => (current?.maskId === maskId ? null : current));
        return;
      }
      if (error instanceof DevelopMaskSurfaceError) setPlaneIssue({ photoKey, maskId });
    },
    [photoKey],
  );
  const issueMaskIds = new Set<string>([
    ...(params.surfaceIssue?.photoKey === photoKey ? params.surfaceIssue.maskIds : []),
    ...(planeIssue?.photoKey === photoKey ? [planeIssue.maskId] : []),
  ]);
  const issueNames = masks
    .map((mask, index) => (issueMaskIds.has(mask.id) ? photoEditingMaskLabel(mask.kind, index) : null))
    .filter((name): name is string => name !== null);
  const surfaceNotice = issueNames.length > 0 ? photoEditingMaskSurfaceUnreadableText(issueNames.join("・")) : null;
  /** 右パネルのマスクの面の理由の 1 行（足せなかった・塗った範囲を保存できなかった・面を読めない） */
  const notice = addNotice ?? brush.notice ?? surfaceNotice;
  /** 面を読み直す（読めなかった面を忘れて描き直し、重ね表示とブラシの面も読み直す） */
  const retrySurfaces = () => {
    engineRef.current?.retryMaskSurfaces?.();
    setPlaneIssue(null);
    setAddNotice(null);
    params.onRetrySurfaces?.();
    brush.retry();
  };

  return {
    available,
    active,
    enter,
    leave,
    engineRef,
    photoKey,
    disabled: params.disabled,
    frame: frameValid ? frame : null,
    masks,
    selected,
    select: setSelectedId,
    kinds,
    max,
    canAdd,
    addBlockedReason,
    whiteBalanceAbsolute,
    /** 全体が白黒（局所のカラーミキサーも全体と同じく押せない） */
    grayscale: (settings as Record<string, unknown>).grayscale === true,
    overlayVisible,
    setOverlayVisible,
    shapeDragging,
    setShapeDragging,
    settings,
    add,
    duplicate,
    remove,
    toggleEnabled,
    toggleInvert,
    changeAdjust,
    changeHsl,
    resetHsl,
    changeFeather,
    changeShape,
    canReset,
    reset,
    handleShortcut,
    /** ブラシ（塗る状態。M4 #68） */
    brush,
    addingBrush,
    /** 写真から範囲を探している種類（無ければ null）と、やめる口（niho-photo#135） */
    detecting,
    cancelDetect,
    notice,
    /** 理由の 1 行が面を読めないこと（読み直せる）か */
    canRetrySurfaces: addNotice === null && (brush.status === "unreadable" || surfaceNotice !== null),
    retrySurfaces,
    reportPlane,
  };
}

export type BrowserPhotoMaskTool = ReturnType<typeof useBrowserPhotoMasks>;

// ---------------------------------------------------------------------------
// マスクの範囲の重ね表示（赤い面）

/** 面を求める要求（`key` が同じなら同じ面。`target` は写真とマスク。別の target の遅れた応答は捨てる）。 */
export type PhotoEditingMaskPlaneRequest = {
  key: string;
  target: string;
  settings: object;
  maskId: string;
  maxDimension: number;
};

/**
 * 重ね表示の面を取りに行く係（React に依らない）。欲しい面が変わったら次の描画の前（`schedule`。rAF）に 1 回だけ取りに行き、
 * 取りに行っている間に変わったら、終わってから最新の 1 つだけを取りに行く（同時に 1 つ）。応答は、今欲しい面と同じ写真・マスク
 * のもので、出した中で一番新しいものだけを `onPlane` に渡す（古い応答・別のマスクの応答は捨てる。形を動かしている間は、少し前の
 * 面を見せ続ける）。`want(null)` で消す。
 */
export function createPhotoEditingMaskPlaneLoader(deps: {
  request: (request: PhotoEditingMaskPlaneRequest) => Promise<DevelopMaskPlane | null>;
  schedule: (callback: () => void) => () => void;
  onPlane: (plane: DevelopMaskPlane | null) => void;
}) {
  let wanted: PhotoEditingMaskPlaneRequest | null = null;
  let requestedKey: string | null = null;
  let inFlight = false;
  let cancelScheduled: (() => void) | null = null;
  let sequence = 0;
  let shownSequence = 0;
  let shownTarget: string | null = null;
  let disposed = false;

  const flush = () => {
    cancelScheduled = null;
    if (disposed || inFlight || !wanted || wanted.key === requestedKey) return;
    const request = wanted;
    const mine = ++sequence;
    requestedKey = request.key;
    inFlight = true;
    const done = (plane: DevelopMaskPlane | null | undefined) => {
      inFlight = false;
      if (disposed) return;
      // 今欲しい写真・マスクの、出した中で一番新しい応答だけを見せる
      if (plane && wanted && wanted.target === request.target && mine > shownSequence) {
        shownSequence = mine;
        shownTarget = request.target;
        deps.onPlane(plane);
      }
      if (wanted && wanted.key !== requestedKey) schedule();
    };
    deps.request(request).then(done, () => done(null));
  };

  const schedule = () => {
    if (cancelScheduled || disposed) return;
    cancelScheduled = deps.schedule(flush);
  };

  return {
    want(next: PhotoEditingMaskPlaneRequest | null) {
      if (disposed) return;
      if (!next) {
        wanted = null;
        requestedKey = null;
        cancelScheduled?.();
        cancelScheduled = null;
        shownTarget = null;
        shownSequence = sequence;
        deps.onPlane(null);
        return;
      }
      if (shownTarget !== null && shownTarget !== next.target) {
        // 別の写真・マスクに移った: 前の面は見せない
        shownTarget = null;
        shownSequence = sequence;
        deps.onPlane(null);
      }
      wanted = next;
      if (next.key === requestedKey) return;
      schedule();
    },
    dispose() {
      disposed = true;
      cancelScheduled?.();
      cancelScheduled = null;
    },
  };
}

/** 面の値（0〜255）を、赤の半透明の重ね（`alpha = data / 255 · 0.5`）の RGBA にする。 */
export function fillPhotoEditingMaskOverlay(rgba: Uint8ClampedArray, data: Uint8Array): void {
  for (let index = 0; index < data.length; index += 1) {
    const offset = index * 4;
    rgba[offset] = 255;
    rgba[offset + 1] = 48;
    rgba[offset + 2] = 48;
    rgba[offset + 3] = Math.round(data[index]! * 0.5);
  }
}

/** 面の寸法・形を決める値（補正の差分・`enabled` は面を変えないので入れない）。 */
function planeShapeKey(mask: DevelopMask): string {
  const { adjust: _adjust, enabled: _enabled, ...shape } = mask;
  return JSON.stringify(shape);
}

/**
 * 選んでいるマスクの面（重ね表示）。`enabled` の間、選んでいるマスクの形・幾何・寸法が変わるたびに取りに行く（rAF でまとめ、
 * 同時に 1 つ。{@link createPhotoEditingMaskPlaneLoader}）。形を動かしている間は 640px（drag の画と同じ）、離したら画と同じ長辺で
 * 取り直す。面の口の無い wasm では null。面のマスクは `surface`（面の id）が替わるたびに取り直す（塗った後の赤い面）。
 */
export function useBrowserPhotoMaskPlane(params: {
  engineRef: MutableRefObject<DevelopEngine | null>;
  photoKey: string | null;
  settings: DevelopSettings;
  mask: DevelopMask | null;
  enabled: boolean;
  dragging: boolean;
  /** 面を取れた（`error` は null）・取れなかった（面のマスクの面を読めないなど）ことを知らせる */
  onResult?: (maskId: string, error: unknown) => void;
}): DevelopMaskPlane | null {
  const { engineRef, photoKey, settings, mask, enabled, dragging } = params;
  const [plane, setPlane] = useState<DevelopMaskPlane | null>(null);
  const loaderRef = useRef<ReturnType<typeof createPhotoEditingMaskPlaneLoader> | null>(null);
  const onResultRef = useRef(params.onResult);
  onResultRef.current = params.onResult;

  useEffect(() => {
    const loader = createPhotoEditingMaskPlaneLoader({
      request: async (request) => {
        const engine = engineRef.current;
        if (!engine?.maskPlane) return null;
        try {
          const plane = await engine.maskPlane(request.settings, request.maskId, { maxDimension: request.maxDimension });
          if (plane) onResultRef.current?.(request.maskId, null);
          return plane;
        } catch (error) {
          onResultRef.current?.(request.maskId, error);
          throw error;
        }
      },
      schedule: (callback) => {
        if (typeof requestAnimationFrame !== "function") {
          const timer = setTimeout(callback, 0);
          return () => clearTimeout(timer);
        }
        const frame = requestAnimationFrame(callback);
        return () => cancelAnimationFrame(frame);
      },
      onPlane: setPlane,
    });
    loaderRef.current = loader;
    return () => {
      loader.dispose();
      loaderRef.current = null;
    };
  }, [engineRef]);

  const shapeKey = mask ? planeShapeKey(mask) : null;
  const geometryKey = JSON.stringify(settings.geometry ?? null);
  const maxDimension = dragging ? DEVELOP_COLOR_POINT_DRAG_MAX_DIMENSION : DEVELOP_PREVIEW_MAX_DIMENSION;
  const latestSettingsRef = useRef(settings);
  latestSettingsRef.current = settings;
  useEffect(() => {
    const loader = loaderRef.current;
    if (!loader) return;
    // 面のマスク（ブラシ・被写体・空。M4 #68）も、エンジンが面を持てば同じ口で取れる
    if (!enabled || !mask || photoKey === null || shapeKey === null) {
      loader.want(null);
      return;
    }
    loader.want({
      key: `${photoKey}\n${shapeKey}\n${geometryKey}\n${maxDimension}`,
      target: `${photoKey}\n${mask.id}`,
      settings: latestSettingsRef.current,
      maskId: mask.id,
      maxDimension,
    });
    // 面を変えるのは形・幾何・寸法だけ（補正の差分では取り直さない）
  }, [enabled, geometryKey, mask, maxDimension, photoKey, shapeKey]);

  return enabled ? plane : null;
}
