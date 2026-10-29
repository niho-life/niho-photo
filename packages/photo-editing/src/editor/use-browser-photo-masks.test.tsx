// @vitest-environment jsdom

import { act, useRef, useState, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevelopEngine, DevelopMaskCapabilities, DevelopMaskPlane } from "../develop-engine/develop-engine-client";
import { readDevelopMasks, writeDevelopMasks, type DevelopMask } from "../develop-engine/develop-masks";
import { neutralDevelopSettings, readDevelopSettings, type DevelopSettings } from "../develop-engine/develop-settings";
import type { PhotoEditingSettings } from "../photo-editing-types";

import type { DevelopSession } from "./browser-photo-editing-model";
import type { PhotoEditingSettingsUpdate, PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";
import type { PhotoLibraryMaskDetectionResult } from "../library/photo-library";

import {
  createPhotoEditingMaskPlaneLoader,
  fillPhotoEditingMaskOverlay,
  photoEditingMaskDetectKinds,
  photoEditingMaskExportBlocked,
  useBrowserPhotoMasks,
  useBrowserPhotoMasksSupport,
  type BrowserPhotoMaskTool,
  type PhotoEditingMaskDetectKind,
  type PhotoEditingMaskDetectSurface,
  type PhotoEditingMaskPlaneRequest,
} from "./use-browser-photo-masks";

/**
 * マスクの道具の状態（部分補正。M3 #67）。編集は右パネルと同じ `changeSettings(update, phase)` を通るので、小さなテスト用の面が
 * 同じ規則（`readDevelopSettings` で読めない設定は捨てる・`commit` が取り消しの 1 単位）で持つ。
 */

const SOURCE = { width: 3000, height: 2000 };
const PHOTO_KEY = "photo-1";
const SUPPORT: DevelopMaskCapabilities = { kinds: ["linear", "radial"], max: 8, maskPlane: true };

let container: HTMLDivElement;
let root: Root;
let tool: BrowserPhotoMaskTool;
let settingsRef: MutableRefObject<DevelopSettings>;
let phases: PhotoEditingSliderPhase[];
let commits: number;

const engine = { imageSize: async () => SOURCE } as unknown as DevelopEngine;
const session = {
  key: PHOTO_KEY,
  photoId: "photo-id-1",
  input: { kind: "workingCopy" },
  working: null,
  workSize: SOURCE,
} as unknown as DevelopSession;
/** 面を受け渡せて被写体も描ける wasm（niho-photo#135） */
const SURFACE_SUPPORT: DevelopMaskCapabilities = {
  kinds: ["linear", "radial", "brush", "subject", "sky"],
  max: 8,
  maskPlane: true,
  surfaces: true,
};

type HarnessProps = {
  initial: DevelopSettings;
  support?: DevelopMaskCapabilities | null;
  wide?: boolean;
  exportBlocked?: boolean;
  otherToolActive?: boolean;
  disabled?: boolean;
  detect?: PhotoEditingMaskDetectSurface | null;
  detectKinds?: readonly PhotoEditingMaskDetectKind[];
};

function Harness(props: HarnessProps) {
  const mountedRef = useRef(true);
  const engineRef = useRef<DevelopEngine | null>(engine);
  const developSessionRef = useRef<DevelopSession | null>(session);
  const [settings, setSettings] = useState(props.initial);
  const ref = useRef(props.initial);
  settingsRef = ref;
  let seed = 0;
  tool = useBrowserPhotoMasks({
    mountedRef,
    engineRef,
    developSessionRef,
    wide: props.wide ?? true,
    photoKey: PHOTO_KEY,
    support: props.support === undefined ? SUPPORT : props.support,
    exportBlocked: props.exportBlocked ?? false,
    otherToolActive: props.otherToolActive ?? false,
    disabled: props.disabled ?? false,
    settings,
    settingsRef: ref,
    changeSettings: (update: PhotoEditingSettingsUpdate, phase: PhotoEditingSliderPhase) => {
      phases.push(phase);
      const next = readDevelopSettings(update(ref.current as PhotoEditingSettings));
      if (!next) return;
      if (phase === "commit") commits += 1;
      ref.current = next;
      setSettings(next);
    },
    commitEdit: (next) => {
      commits += 1;
      ref.current = next;
      setSettings(next);
      return true;
    },
    random: () => {
      seed += 0.137;
      return seed % 1;
    },
    detectMaskSurface: props.detect ?? null,
    detectKinds: props.detectKinds ?? [],
  });
  return null;
}

/** 答えを後から決める検出（呼ばれた引数を覚える）。 */
function deferredDetect() {
  const calls: Array<{ photoId: string; kind: PhotoEditingMaskDetectKind; developSettings: object; signal: AbortSignal }> = [];
  let settle: { resolve: (result: PhotoLibraryMaskDetectionResult) => void; reject: (error: unknown) => void } | null = null;
  const detect: PhotoEditingMaskDetectSurface = (photoId, kind, options) => {
    calls.push({ photoId, kind, ...options });
    return new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
  };
  return {
    detect,
    calls,
    resolve: async (result: PhotoLibraryMaskDetectionResult) => {
      await act(async () => settle!.resolve(result));
    },
    reject: async (error: unknown) => {
      await act(async () => settle!.reject(error));
    },
  };
}

const SURFACE_ID = "f".repeat(64);

async function render(props: Partial<HarnessProps> = {}) {
  await act(async () => {
    root.render(<Harness initial={neutralDevelopSettings()} {...props} />);
  });
}

async function enter() {
  await act(async () => {
    tool.enter();
  });
  await act(async () => undefined);
  expect(tool.active).toBe(true);
  expect(tool.frame).not.toBeNull();
}

function readable(settings: DevelopSettings): boolean {
  return readDevelopSettings(JSON.parse(JSON.stringify(settings)) as unknown) !== null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  phases = [];
  commits = 0;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useBrowserPhotoMasks", () => {
  it("描ける wasm・PC の幅・1 枚で見ている写真のときだけ道具を出す（描けない wasm・スマホの幅では出さない）", async () => {
    await render();
    expect(tool.available).toBe(true);
    expect(tool.kinds).toEqual(["linear", "radial"]);
    await render({ support: null });
    expect(tool.available).toBe(false);
    await render({ support: { kinds: ["brush"], max: 8, maskPlane: true } });
    expect(tool.available).toBe(false);
    await render({ support: SUPPORT, wide: false });
    expect(tool.available).toBe(false);
  });

  it("入ると座標の基準を読み、足すと既定の形のマスクを 1 単位で足して選ぶ（読める設定・v 5）", async () => {
    await render();
    await enter();
    await act(async () => tool.add("linear"));
    expect(commits).toBe(1);
    expect(phases).toEqual(["commit"]);
    const masks = readDevelopMasks(settingsRef.current);
    expect(masks).toHaveLength(1);
    expect(masks[0]).toMatchObject({ kind: "linear", zero: { x: 0.5, y: 0.55 }, full: { x: 0.5, y: 0.3 } });
    expect(settingsRef.current.v).toBe(5);
    expect(readable(settingsRef.current)).toBe(true);
    expect(tool.selected?.id).toBe(masks[0]!.id);

    await act(async () => tool.add("radial"));
    expect(commits).toBe(2);
    expect(tool.selected?.kind).toBe("radial");
  });

  it("複製・反転・目・削除はそれぞれ取り消しの 1 単位で、いつも読める設定を書く", async () => {
    await render();
    await enter();
    await act(async () => tool.add("radial"));
    const id = tool.selected!.id;
    commits = 0;
    await act(async () => tool.duplicate(id));
    expect(commits).toBe(1);
    const copyId = tool.selected!.id;
    expect(copyId).not.toBe(id);
    expect(readDevelopMasks(settingsRef.current).map((mask) => mask.id)).toEqual([id, copyId]);
    await act(async () => tool.toggleInvert(id));
    await act(async () => tool.toggleEnabled(id));
    expect(commits).toBe(3);
    expect(readDevelopMasks(settingsRef.current)[0]).toMatchObject({ invert: true, enabled: false });
    expect(readable(settingsRef.current)).toBe(true);
    await act(async () => tool.remove(copyId));
    expect(commits).toBe(4);
    expect(tool.selected).toBeNull();
    expect(readDevelopMasks(settingsRef.current).map((mask) => mask.id)).toEqual([id]);
  });

  it("局所のスライダー: drag は履歴に積まず、commit で 1 単位。0 はキーを外す", async () => {
    await render();
    await enter();
    await act(async () => tool.add("linear"));
    const id = tool.selected!.id;
    commits = 0;
    phases = [];
    await act(async () => tool.changeAdjust(id, "exposure", -0.3, "drag"));
    await act(async () => tool.changeAdjust(id, "exposure", -0.71, "drag"));
    await act(async () => tool.changeAdjust(id, "exposure", -0.71, "commit"));
    expect(phases).toEqual(["drag", "drag", "commit"]);
    expect(commits).toBe(1);
    expect(readDevelopMasks(settingsRef.current)[0]!.adjust).toEqual({ exposure: -0.71 });
    await act(async () => tool.changeAdjust(id, "exposure", 0, "commit"));
    expect(readDevelopMasks(settingsRef.current)[0]!.adjust).toEqual({});
  });

  it("局所のカラーミキサー: drag は履歴に積まず commit で 1 単位、正規形（0 の値は書かない）で書く。初期化は hsl だけを外す（niho-photo#93）", async () => {
    await render();
    await enter();
    await act(async () => tool.add("linear"));
    const id = tool.selected!.id;
    await act(async () => tool.changeAdjust(id, "exposure", -0.5, "commit"));
    commits = 0;
    phases = [];
    await act(async () => tool.changeHsl(id, "blue", "saturation", -40, "drag"));
    await act(async () => tool.changeHsl(id, "blue", "saturation", -100, "drag"));
    await act(async () => tool.changeHsl(id, "blue", "saturation", -100, "commit"));
    expect(phases).toEqual(["drag", "drag", "commit"]);
    expect(commits).toBe(1);
    expect(tool.selected?.adjust.hsl).toEqual({ blue: { hue: 0, saturation: -100, luminance: 0 } });
    const stored = (settingsRef.current.masks as Array<{ adjust: Record<string, unknown> }>)[0]!.adjust;
    expect(stored).toEqual({ exposure: -0.5, hsl: ["blue", { saturation: -100 }] });
    expect(readable(settingsRef.current)).toBe(true);
    expect(tool.grayscale).toBe(false);

    await act(async () => tool.resetHsl(id));
    expect(commits).toBe(2);
    expect((settingsRef.current.masks as Array<{ adjust: Record<string, unknown> }>)[0]!.adjust).toEqual({ exposure: -0.5 });
  });

  it("写真の上で動かした形は、補正の差分を変えずに形だけを当てる", async () => {
    await render();
    await enter();
    await act(async () => tool.add("radial"));
    const id = tool.selected!.id;
    await act(async () => tool.changeAdjust(id, "contrast", 30, "commit"));
    const mask = readDevelopMasks(settingsRef.current)[0]!;
    if (mask.kind !== "radial") throw new Error("radial expected");
    await act(async () => tool.changeShape({ ...mask, center: { x: 0.3, y: 0.4 }, adjust: {} }, "drag"));
    expect(readDevelopMasks(settingsRef.current)[0]).toMatchObject({ center: { x: 0.3, y: 0.4 }, adjust: { contrast: 30 } });
  });

  it("8 枚では足さず理由を出す。原寸の書き出しが描けない出どころでも足さない（今あるマスクは編集できる）", async () => {
    const masks: DevelopMask[] = Array.from({ length: 8 }, (_, index) => ({
      id: `mask-${index}`,
      kind: "linear",
      enabled: true,
      invert: false,
      zero: { x: 0.5, y: 0.6 },
      full: { x: 0.5, y: 0.3 },
      adjust: {},
    }));
    await render({ initial: writeDevelopMasks(neutralDevelopSettings(), masks) });
    await enter();
    expect(tool.canAdd).toBe(false);
    expect(tool.addBlockedReason).toBe("マスクは 8 枚までです。使わないマスクを削除すると追加できます。");
    await act(async () => tool.add("linear"));
    await act(async () => tool.duplicate("mask-0"));
    expect(readDevelopMasks(settingsRef.current)).toHaveLength(8);
    expect(commits).toBe(0);

    await render({ exportBlocked: true });
    await enter();
    expect(tool.addBlockedReason).toContain("原寸の書き出しはマスクに対応していません");
    await act(async () => tool.add("linear"));
    expect(readDevelopMasks(settingsRef.current)).toHaveLength(8);
  });

  it("Esc は選択を外し（選んでいなければ扱わない）、⌫ / Delete は選んだマスクを削除する（選んでいなくても写真は消させない）", async () => {
    await render();
    await enter();
    await act(async () => tool.add("linear"));
    const preventDefault = vi.fn();
    let handled = false;
    await act(async () => {
      handled = tool.handleShortcut("escape", { preventDefault });
    });
    expect(handled).toBe(true);
    expect(tool.selected).toBeNull();
    expect(tool.handleShortcut("escape", { preventDefault })).toBe(false);
    // 選んでいないときの Delete も扱う（写真を消す既定の動きに渡さない）
    expect(tool.handleShortcut("delete", { preventDefault })).toBe(true);
    expect(readDevelopMasks(settingsRef.current)).toHaveLength(1);
    await act(async () => tool.select(readDevelopMasks(settingsRef.current)[0]!.id));
    await act(async () => {
      handled = tool.handleShortcut("delete", { preventDefault });
    });
    expect(handled).toBe(true);
    expect(readDevelopMasks(settingsRef.current)).toHaveLength(0);
    expect(tool.handleShortcut("grid", { preventDefault })).toBe(false);
  });

  it("被写体は、面を受け渡せる wasm で出どころが作れる種類のときだけ足せる（niho-photo#135）", async () => {
    const { detect } = deferredDetect();
    await render({ support: SURFACE_SUPPORT, detect, detectKinds: ["subject"] });
    expect(tool.kinds).toEqual(["linear", "radial", "subject"]);
    await render({ support: SURFACE_SUPPORT, detect: null, detectKinds: ["subject"] });
    expect(tool.kinds).toEqual(["linear", "radial"]);
    await render({ support: SURFACE_SUPPORT, detect, detectKinds: [] });
    expect(tool.kinds).toEqual(["linear", "radial"]);
    await render({ support: { ...SURFACE_SUPPORT, surfaces: false }, detect, detectKinds: ["subject"] });
    expect(tool.kinds).toEqual(["linear", "radial"]);
    await render({ support: { ...SURFACE_SUPPORT, kinds: ["linear", "radial", "brush"] }, detect, detectKinds: ["subject"] });
    expect(tool.kinds).toEqual(["linear", "radial"]);
    expect(photoEditingMaskDetectKinds({})).toEqual([]);
    expect(photoEditingMaskDetectKinds({ maskDetection: { subject: true, sky: false } })).toEqual(["subject"]);
  });

  it("被写体を足す: 探している間はほかの追加を止め、できた面のマスクを 1 単位で足して選ぶ", async () => {
    const detection = deferredDetect();
    await render({ support: SURFACE_SUPPORT, detect: detection.detect, detectKinds: ["subject"] });
    await enter();
    await act(async () => tool.add("subject"));
    expect(tool.detecting).toBe("subject");
    expect(tool.canAdd).toBe(false);
    expect(detection.calls).toHaveLength(1);
    expect(detection.calls[0]).toMatchObject({ photoId: "photo-id-1", kind: "subject" });
    expect(detection.calls[0]!.developSettings).toBe(settingsRef.current);
    expect(detection.calls[0]!.signal.aborted).toBe(false);
    // 探している間はほかの種類も足さない
    await act(async () => tool.add("linear"));
    expect(readDevelopMasks(settingsRef.current)).toHaveLength(0);

    await detection.resolve({ kind: "detected", id: SURFACE_ID, width: 1024, height: 683 });
    expect(tool.detecting).toBeNull();
    expect(commits).toBe(1);
    const masks = readDevelopMasks(settingsRef.current);
    expect(masks).toEqual([
      { id: masks[0]!.id, kind: "subject", enabled: true, invert: false, surface: { id: SURFACE_ID, width: 1024, height: 683 }, adjust: {} },
    ]);
    expect(tool.selected?.id).toBe(masks[0]!.id);
    expect(settingsRef.current.v).toBe(5);
    expect(readable(settingsRef.current)).toBe(true);
    expect(tool.canAdd).toBe(true);
  });

  it("被写体が見つからない・探せないときは足さずに理由の 1 行を出す", async () => {
    const missing = deferredDetect();
    await render({ support: SURFACE_SUPPORT, detect: missing.detect, detectKinds: ["subject"] });
    await enter();
    await act(async () => tool.add("subject"));
    await missing.resolve({ kind: "notFound" });
    expect(tool.notice).toBe("被写体が見つかりませんでした。ブラシや円形グラデーションで範囲を選べます。");
    expect(readDevelopMasks(settingsRef.current)).toHaveLength(0);
    expect(commits).toBe(0);

    const failing = deferredDetect();
    await render({ support: SURFACE_SUPPORT, detect: failing.detect, detectKinds: ["subject"] });
    await act(async () => tool.add("subject"));
    expect(tool.notice).toBeNull();
    await failing.reject(new Error("engine_failed"));
    expect(tool.notice).toBe("被写体のマスクを追加できませんでした。もう一度お試しください。");
    expect(readDevelopMasks(settingsRef.current)).toHaveLength(0);
  });

  it("取り消すと検出を止め（signal）、遅れて届いた面は足さない。道具を離れても止める", async () => {
    const detection = deferredDetect();
    await render({ support: SURFACE_SUPPORT, detect: detection.detect, detectKinds: ["subject"] });
    await enter();
    await act(async () => tool.add("subject"));
    await act(async () => tool.cancelDetect());
    expect(detection.calls[0]!.signal.aborted).toBe(true);
    expect(tool.detecting).toBeNull();
    await detection.resolve({ kind: "detected", id: SURFACE_ID, width: 1024, height: 683 });
    expect(readDevelopMasks(settingsRef.current)).toHaveLength(0);
    expect(tool.notice).toBeNull();

    await act(async () => tool.add("subject"));
    expect(tool.detecting).toBe("subject");
    await render({ support: SURFACE_SUPPORT, detect: detection.detect, detectKinds: ["subject"], otherToolActive: true });
    expect(detection.calls[1]!.signal.aborted).toBe(true);
    expect(tool.detecting).toBeNull();
    await detection.resolve({ kind: "detected", id: SURFACE_ID, width: 1024, height: 683 });
    expect(readDevelopMasks(settingsRef.current)).toHaveLength(0);
  });

  it("「初期化」はマスクだけを外す（1 単位）。切り抜き・背景除去の道具に移ると「補正」に戻る", async () => {
    await render();
    await enter();
    await act(async () => tool.add("linear"));
    await act(async () => tool.changeAdjust(tool.selected!.id, "exposure", -1, "commit"));
    const exposure = { ...settingsRef.current };
    expect(tool.canReset).toBe(true);
    commits = 0;
    await act(async () => tool.reset());
    expect(commits).toBe(1);
    expect(settingsRef.current.masks).toBeUndefined();
    expect(settingsRef.current.v).toBe(1);
    expect(exposure.engine).toBe(settingsRef.current.engine);
    await render({ otherToolActive: true });
    expect(tool.active).toBe(false);
  });
});

describe("useBrowserPhotoMasksSupport・原寸の書き出し", () => {
  function SupportHarness(props: { engine: DevelopEngine; onValue: (value: DevelopMaskCapabilities | null) => void }) {
    const mountedRef = useRef(true);
    const engineRef = useRef<DevelopEngine | null>(props.engine);
    props.onValue(useBrowserPhotoMasksSupport({ mountedRef, engineRef, photoKey: PHOTO_KEY }));
    return null;
  }

  it("wasm の capabilities() の結果を覚え、口の無い engine・失敗は null", async () => {
    const values: Array<DevelopMaskCapabilities | null> = [];
    const supportsMasks = vi.fn(async () => SUPPORT);
    await act(async () => {
      root.render(<SupportHarness engine={{ supportsMasks } as unknown as DevelopEngine} onValue={(value) => values.push(value)} />);
    });
    await act(async () => undefined);
    expect(values.at(-1)).toEqual(SUPPORT);
    expect(supportsMasks).toHaveBeenCalledOnce();

    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(<SupportHarness engine={{} as DevelopEngine} onValue={(value) => values.push(value)} />);
    });
    expect(values.at(-1)).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(
        <SupportHarness
          engine={{ supportsMasks: async () => Promise.reject(new Error("x")) } as unknown as DevelopEngine}
          onValue={(value) => values.push(value)}
        />,
      );
    });
    await act(async () => undefined);
    expect(values.at(-1)).toBeNull();
  });

  it("原寸の書き出しのある出どころは、マスクを描けると言うときだけ足せる（省略は描けない）。書き出しの無い出どころは足せる", () => {
    expect(photoEditingMaskExportBlocked({ nativeExport: false, nativeExportUpdateRequired: false })).toBe(false);
    expect(photoEditingMaskExportBlocked({ nativeExport: true, nativeExportUpdateRequired: false })).toBe(true);
    expect(photoEditingMaskExportBlocked({ nativeExport: true, nativeExportUpdateRequired: false, nativeExportMasks: false })).toBe(true);
    expect(photoEditingMaskExportBlocked({ nativeExport: true, nativeExportUpdateRequired: false, nativeExportMasks: true })).toBe(false);
    expect(photoEditingMaskExportBlocked({ nativeExport: false, nativeExportUpdateRequired: true, nativeExportMasks: false })).toBe(true);
  });
});

describe("範囲の重ね表示（赤い面）", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function plane(value: number): DevelopMaskPlane {
    return { width: 1, height: 1, data: new Uint8Array([value]) };
  }

  function request(key: string, target = "photo-1\nmask-a"): PhotoEditingMaskPlaneRequest {
    return { key, target, settings: {}, maskId: target.split("\n")[1]!, maxDimension: 1280 };
  }

  function setup() {
    const pending: Array<{ request: PhotoEditingMaskPlaneRequest; reply: ReturnType<typeof deferred<DevelopMaskPlane | null>> }> = [];
    const scheduled: Array<() => void> = [];
    const shown: Array<DevelopMaskPlane | null> = [];
    const loader = createPhotoEditingMaskPlaneLoader({
      request: (next) => {
        const reply = deferred<DevelopMaskPlane | null>();
        pending.push({ request: next, reply });
        return reply.promise;
      },
      schedule: (callback) => {
        scheduled.push(callback);
        return () => {
          const index = scheduled.indexOf(callback);
          if (index >= 0) scheduled.splice(index, 1);
        };
      },
      onPlane: (value) => shown.push(value),
    });
    const flushFrame = () => {
      const callbacks = scheduled.splice(0);
      for (const callback of callbacks) callback();
    };
    return { loader, pending, scheduled, shown, flushFrame };
  }

  it("次の描画の前に 1 回だけ取りに行き、取りに行っている間の変化は最新の 1 つにまとめる", async () => {
    const { loader, pending, shown, flushFrame } = setup();
    loader.want(request("a"));
    loader.want(request("b"));
    expect(pending).toHaveLength(0);
    flushFrame();
    expect(pending.map((entry) => entry.request.key)).toEqual(["b"]);
    loader.want(request("c"));
    loader.want(request("d"));
    flushFrame();
    // 同時に 1 つ
    expect(pending).toHaveLength(1);
    pending[0]!.reply.resolve(plane(10));
    await Promise.resolve();
    expect(shown.at(-1)?.data[0]).toBe(10);
    flushFrame();
    expect(pending.map((entry) => entry.request.key)).toEqual(["b", "d"]);
    pending[1]!.reply.resolve(plane(20));
    await Promise.resolve();
    expect(shown.at(-1)?.data[0]).toBe(20);
    // 同じ形は取り直さない
    loader.want(request("d"));
    flushFrame();
    expect(pending).toHaveLength(2);
  });

  it("別のマスク・写真に移ったら前の面は消し、遅れて来た前の応答は捨てる", async () => {
    const { loader, pending, shown, flushFrame } = setup();
    loader.want(request("a"));
    flushFrame();
    pending[0]!.reply.resolve(plane(1));
    await Promise.resolve();
    loader.want(request("b"));
    flushFrame();
    loader.want(request("x", "photo-1\nmask-b"));
    // 別のマスク: 前の面を消す
    expect(shown.at(-1)).toBeNull();
    pending[1]!.reply.resolve(plane(2));
    await Promise.resolve();
    // mask-a の遅れた応答は見せない
    expect(shown.at(-1)).toBeNull();
    flushFrame();
    expect(pending.at(-1)?.request.key).toBe("x");
    pending.at(-1)!.reply.resolve(plane(3));
    await Promise.resolve();
    expect(shown.at(-1)?.data[0]).toBe(3);
  });

  it("want(null) で消し、取りに行っていた応答も見せない。失敗は見せずに次へ進む", async () => {
    const { loader, pending, shown, flushFrame } = setup();
    loader.want(request("a"));
    flushFrame();
    loader.want(null);
    expect(shown.at(-1)).toBeNull();
    pending[0]!.reply.resolve(plane(9));
    await Promise.resolve();
    expect(shown.at(-1)).toBeNull();
    loader.want(request("b"));
    flushFrame();
    pending[1]!.reply.resolve(null);
    await Promise.resolve();
    expect(shown.at(-1)).toBeNull();
  });

  it("面の値を赤の半透明（alpha = 値 / 255 · 0.5）にする", () => {
    const rgba = new Uint8ClampedArray(3 * 4);
    fillPhotoEditingMaskOverlay(rgba, new Uint8Array([0, 128, 255]));
    expect(Array.from(rgba)).toEqual([255, 48, 48, 0, 255, 48, 48, 64, 255, 48, 48, 128]);
  });
});
