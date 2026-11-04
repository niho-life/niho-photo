// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevelopEngine } from "../develop-engine/develop-engine-client";
import { neutralDevelopSettings } from "../develop-engine/develop-settings";
import type { PhotoLibrary, PhotoLibraryPreset } from "../library/photo-library";
import { PhotoLibraryProvider, type PhotoEditingHost } from "../library/photo-library-context";
import { PHOTO_EDITING_PRESET_ACTIONS_LABEL, PHOTO_EDITING_PRESET_NONE_LABEL, photoEditingPresetRowActionsLabel } from "../photo-editing-copy";
import type { PhotoEditingBuiltinPreset } from "../photo-editing-types";

import {
  PHOTO_EDITING_PRESET_NONE_THUMBNAIL_KEY,
  PhotoEditingPresetThumbnail,
  type PhotoEditingPresetThumbnails,
} from "./photo-editing-preset-thumbnail";
import { PhotoEditingPresetsPanel, type PhotoEditingPresetTarget } from "./photo-editing-presets-panel";
import {
  BROWSER_PRESET_GRID_THUMBNAIL_MAX_DIMENSION,
  BROWSER_PRESET_THUMBNAIL_MAX_DIMENSION,
  useBrowserPresetThumbnails,
} from "./use-browser-preset-thumbnails";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BUILTIN_PRESETS: PhotoEditingBuiltinPreset[] = [
  { id: "niho-bluesky2", name: "bluesky2", xmp: "<x:xmpmeta>bluesky2</x:xmpmeta>" },
  { id: "niho-pastel", name: "pastel", xmp: "<x:xmpmeta>pastel</x:xmpmeta>" },
];

const SPOT_PRESET: PhotoLibraryPreset = {
  id: "spot-1",
  name: "午後の光",
  xmp: "<x:xmpmeta>spot</x:xmpmeta>",
  source: "user",
  createdAt: "2026-10-01T00:00:00.000Z",
};

const host: PhotoEditingHost = {
  notifyPhotosChanged: () => undefined,
  saveFile: async () => "saved",
  nativeFileSaveAvailable: () => false,
  isNativeViewport: () => false,
  isDesktopApp: () => false,
};

function fakeLibrary(spotPresets: PhotoLibraryPreset[], readOnly = false): PhotoLibrary {
  return {
    place: "local",
    errors: { describeNative: () => "" },
    presets: {
      readOnly,
      list: vi.fn(async () => spotPresets),
      create: vi.fn(),
      rename: vi.fn(),
      delete: vi.fn(),
      nameMaxChars: 100,
      xmpMaxBytes: 1024 * 1024,
      describeError: (_error: unknown, fallback: string) => fallback,
      isNameTaken: () => false,
    },
  } as unknown as PhotoLibrary;
}

/** 描く前（skeleton）のままの見本。行・升に渡された要素だけを覚える。 */
function fakeThumbnails() {
  return {
    stateOf: () => ({ frame: null, failed: false }),
    observe: vi.fn<PhotoEditingPresetThumbnails["observe"]>(),
  } satisfies PhotoEditingPresetThumbnails;
}

type PanelOptions = {
  layout?: "rows" | "grid";
  thumbnails?: PhotoEditingPresetThumbnails;
  appliedPresetKey?: string | null;
  canApply?: boolean;
  canClear?: boolean;
  spotPresets?: PhotoLibraryPreset[];
  presetsReadOnly?: boolean;
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let onApply: ReturnType<typeof vi.fn<(preset: PhotoEditingPresetTarget) => void>>;
let onPreview: ReturnType<typeof vi.fn<(preset: PhotoEditingPresetTarget | null) => void>>;
let onClear: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  onApply = vi.fn();
  onPreview = vi.fn();
  onClear = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

/** react-query の読み込みが落ち着くまで待つ。 */
async function settle() {
  for (let round = 0; round < 3; round += 1) {
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderPanel(options: PanelOptions = {}) {
  const library = fakeLibrary(options.spotPresets ?? [], options.presetsReadOnly);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PhotoLibraryProvider library={library} host={host}>
          <PhotoEditingPresetsPanel
            spotId="local"
            canEdit
            builtinPresets={{ queryKey: ["test-builtin-presets"], load: async () => BUILTIN_PRESETS }}
            canApply={options.canApply ?? true}
            appliedPresetKey={options.appliedPresetKey ?? null}
            applyingPresetKey={null}
            applyError={null}
            onApply={onApply}
            none={{ canClear: options.canClear ?? false, onClear }}
            readPreset={async () => ({ name: "", unsupported: [] })}
            onPreview={onPreview}
            thumbnails={options.thumbnails}
            layout={options.layout}
          />
        </PhotoLibraryProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
  return library;
}

function presetButton(name: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("li > button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!button) throw new Error(`preset button not found: ${name}`);
  return button;
}

function presetNames(list: Element): string[] {
  return Array.from(list.querySelectorAll(":scope > li > button")).map((button) => button.textContent?.trim() ?? "");
}

function lists(): HTMLUListElement[] {
  return Array.from(container.querySelectorAll("ul"));
}

function pointer(type: string, element: Element, init: PointerEventInit = {}) {
  element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse", ...init }));
}

describe("PhotoEditingPresetsPanel（升の 2 列）", () => {
  it("保存先が読み取り専用でもプリセットを適用でき、管理操作は表示しない", async () => {
    const library = await renderPanel({ presetsReadOnly: true, spotPresets: [SPOT_PRESET] });
    expect(container.querySelector(`button[aria-label="${PHOTO_EDITING_PRESET_ACTIONS_LABEL}"]`)).toBeNull();
    expect(container.querySelector(`button[aria-label="${photoEditingPresetRowActionsLabel(SPOT_PRESET.name)}"]`)).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    await act(async () => presetButton("青空").click());
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ key: "builtin:niho-bluesky2" }));
    await act(async () => presetButton(SPOT_PRESET.name).click());
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ key: "spot:spot-1" }));
    expect(library.presets.create).not.toHaveBeenCalled();
    expect(library.presets.rename).not.toHaveBeenCalled();
    expect(library.presets.delete).not.toHaveBeenCalled();
  });

  it("見本を描けるブラウザ版は、「なし」を先頭にした升の 2 列で、升ごとに上へ見本・下へ名前を置く", async () => {
    const thumbnails = fakeThumbnails();
    await renderPanel({ layout: "grid", thumbnails });

    const [builtinList] = lists();
    expect(builtinList?.className).toContain("grid-cols-2");
    expect(presetNames(builtinList!)).toEqual([PHOTO_EDITING_PRESET_NONE_LABEL, "青空", "パステル"]);

    const tile = presetButton("青空");
    expect(tile.className).toContain("flex-col");
    const thumbnail = tile.querySelector('[data-testid="photo-preset-thumbnail"]');
    expect(thumbnail?.className).toContain("aspect-[3/2]");
    expect(thumbnail?.className).toContain("w-full");
    expect(thumbnail?.className).not.toContain("h-12");
    // 見本は名前より前（上）
    expect(tile.firstElementChild).toBe(thumbnail);
    expect(tile.lastElementChild?.querySelector(".truncate")?.textContent).toBe("青空");
    // 見えている升から描けるよう、升ごとに要素を渡す（「なし」は当てる前の絵）
    expect(thumbnails.observe).toHaveBeenCalledWith(PHOTO_EDITING_PRESET_NONE_THUMBNAIL_KEY, null, expect.any(HTMLElement));
    expect(thumbnails.observe).toHaveBeenCalledWith("builtin:niho-bluesky2", BUILTIN_PRESETS[0]!.xmp, expect.any(HTMLElement));
  });

  it("当てている升は見本の ring と名前の色・太さで見分け、「なし」の升と見分けがつく", async () => {
    await renderPanel({ layout: "grid", thumbnails: fakeThumbnails(), appliedPresetKey: "builtin:niho-bluesky2", canClear: true });

    const applied = presetButton("青空");
    const none = presetButton(PHOTO_EDITING_PRESET_NONE_LABEL);
    expect(applied.getAttribute("aria-current")).toBe("true");
    expect(none.getAttribute("aria-current")).toBeNull();

    const appliedThumbnail = applied.querySelector('[data-testid="photo-preset-thumbnail"]');
    const noneThumbnail = none.querySelector('[data-testid="photo-preset-thumbnail"]');
    expect(appliedThumbnail?.className).toContain("ring-2");
    expect(appliedThumbnail?.className).toContain("ring-niho-accent-ink");
    expect(noneThumbnail?.className).not.toContain("ring-2");

    const appliedName = applied.querySelector(".truncate");
    const noneName = none.querySelector(".truncate");
    expect(appliedName?.className).toContain("font-black");
    expect(appliedName?.className).toContain("text-niho-accent-ink");
    expect(noneName?.className).toContain("font-bold");
    expect(noneName?.className).not.toContain("text-niho-accent-ink");
  });

  it("「なし」が選ばれている間は、「なし」の升が当てている表示のまま押せない（薄くしない）", async () => {
    await renderPanel({ layout: "grid", thumbnails: fakeThumbnails() });

    const none = presetButton(PHOTO_EDITING_PRESET_NONE_LABEL);
    expect(none.disabled).toBe(true);
    expect(none.getAttribute("aria-current")).toBe("true");
    expect(none.className).toContain("disabled:cursor-default");
    expect(none.className).not.toContain("disabled:opacity-50");
    expect(none.querySelector('[data-testid="photo-preset-thumbnail"]')?.className).toContain("ring-2");
  });

  it("升を押すとそのプリセットを当て、「なし」の升で外す", async () => {
    await renderPanel({ layout: "grid", thumbnails: fakeThumbnails(), appliedPresetKey: "builtin:niho-pastel", canClear: true });

    await act(async () => presetButton("青空").click());
    expect(onApply).toHaveBeenCalledWith({ key: "builtin:niho-bluesky2", name: "青空", xmp: BUILTIN_PRESETS[0]!.xmp });

    await act(async () => presetButton(PHOTO_EDITING_PRESET_NONE_LABEL).click());
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("マウスを載せている間とキーボードのフォーカスが来ている間だけ、写真を仮の表示にする", async () => {
    await renderPanel({ layout: "grid", thumbnails: fakeThumbnails() });
    const target = { key: "builtin:niho-pastel", name: "パステル", xmp: BUILTIN_PRESETS[1]!.xmp };
    const tile = presetButton("パステル");

    await act(async () => pointer("pointerover", tile));
    expect(onPreview).toHaveBeenLastCalledWith(target);
    await act(async () => pointer("pointerout", tile, { relatedTarget: document.body }));
    expect(onPreview).toHaveBeenLastCalledWith(null);

    // タッチでは仮の表示を起こさない
    onPreview.mockClear();
    await act(async () => pointer("pointerover", tile, { pointerType: "touch" }));
    expect(onPreview).not.toHaveBeenCalled();

    // キーボードで升を順に移る（フォーカスでも仮の表示）
    await act(async () => presetButton("青空").focus());
    expect(onPreview).toHaveBeenLastCalledWith({ key: "builtin:niho-bluesky2", name: "青空", xmp: BUILTIN_PRESETS[0]!.xmp });
    await act(async () => tile.focus());
    expect(onPreview).toHaveBeenLastCalledWith(target);
    await act(async () => tile.blur());
    expect(onPreview).toHaveBeenLastCalledWith(null);

    // 押して来たフォーカスでは起こさない
    onPreview.mockClear();
    await act(async () => {
      pointer("pointerdown", tile);
      tile.focus();
    });
    expect(onPreview).not.toHaveBeenCalled();
  });

  it("写真を選んでいなければ升を押せない", async () => {
    await renderPanel({ layout: "grid", thumbnails: fakeThumbnails(), canApply: false });

    const tile = presetButton("青空");
    expect(tile.disabled).toBe(true);
    expect(tile.className).toContain("disabled:opacity-50");
  });

  it("拠点のプリセットは小見出しの下の升の 2 列に並べ、「⋯」を升の右上に小さく重ねる", async () => {
    await renderPanel({ layout: "grid", thumbnails: fakeThumbnails(), spotPresets: [SPOT_PRESET] });

    const spotList = container.querySelector<HTMLUListElement>("ul[aria-labelledby]");
    expect(spotList?.className).toContain("grid-cols-2");
    const heading = document.getElementById(spotList!.getAttribute("aria-labelledby")!);
    expect(heading?.textContent).toBe("拠点のプリセット");
    expect(presetNames(spotList!)).toEqual([SPOT_PRESET.name]);

    const more = spotList!.querySelector<HTMLButtonElement>(
      `button[aria-label="${photoEditingPresetRowActionsLabel(SPOT_PRESET.name)}"]`,
    );
    expect(more).not.toBeNull();
    expect(more?.className).toContain("h-7");
    expect(more?.className).toContain("w-7");
    expect(more?.className).not.toContain("h-11");
    expect(more?.parentElement?.className).toContain("absolute");
    // 「⋯」は升のボタンの外（押しても当たらない）
    expect(presetButton(SPOT_PRESET.name).contains(more)).toBe(false);
  });

  it("見本を描けない wasm（見本を渡さない）では、升にせず今の行の一覧のまま", async () => {
    await renderPanel({ layout: "grid", spotPresets: [SPOT_PRESET] });

    const [builtinList] = lists();
    expect(builtinList?.className).not.toContain("grid-cols-2");
    expect(builtinList?.className).toContain("space-y-0.5");
    expect(presetNames(builtinList!)).toEqual([PHOTO_EDITING_PRESET_NONE_LABEL, "青空", "パステル"]);
    expect(container.querySelector('[data-testid="photo-preset-thumbnail"]')).toBeNull();
    expect(presetButton("青空").className).not.toContain("flex-col");
    const more = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${photoEditingPresetRowActionsLabel(SPOT_PRESET.name)}"]`,
    );
    expect(more?.className).toContain("h-11");
  });

  it("`layout` を省く面（NIHO Desktop）は、見本があっても行の左に 48px の見本を置く今の行のまま", async () => {
    await renderPanel({ thumbnails: fakeThumbnails() });

    const [builtinList] = lists();
    expect(builtinList?.className).not.toContain("grid-cols-2");
    const row = presetButton("青空");
    expect(row.className).not.toContain("flex-col");
    const thumbnail = row.querySelector('[data-testid="photo-preset-thumbnail"]');
    expect(thumbnail?.className).toContain("h-12");
    expect(thumbnail?.className).toContain("w-12");
    expect(thumbnail?.className).not.toContain("aspect-[3/2]");
  });
});

describe("useBrowserPresetThumbnails の見本の大きさ", () => {
  function Harness(props: { engine: DevelopEngine; maxDimension?: number }) {
    const mountedRef = useRef(true);
    const engineRef = useRef<DevelopEngine | null>(props.engine);
    const thumbnails = useBrowserPresetThumbnails({
      mountedRef,
      engineRef,
      supported: true,
      photoKey: "photo-1",
      base: neutralDevelopSettings(),
      paused: false,
      maxDimension: props.maxDimension,
      resolvePreset: async () => {
        throw new Error("not used");
      },
    });
    return thumbnails ? (
      <PhotoEditingPresetThumbnail thumbnailKey={PHOTO_EDITING_PRESET_NONE_THUMBNAIL_KEY} xmp={null} thumbnails={thumbnails} />
    ) : null;
  }

  async function renderedDimension(maxDimension?: number): Promise<number | undefined> {
    // 描き終えない見本（呼ばれた大きさだけを見る）
    const renderPresetThumbnail = vi.fn(() => new Promise<null>(() => undefined));
    const engine = { renderPresetThumbnail } as unknown as DevelopEngine;
    await act(async () => root.render(<Harness engine={engine} maxDimension={maxDimension} />));
    await settle();
    return (renderPresetThumbnail.mock.calls[0] as unknown[] | undefined)?.[1] as number | undefined;
  }

  it("升の 2 列（ブラウザ版の右パネル）は長辺 192px で描く", async () => {
    expect(BROWSER_PRESET_GRID_THUMBNAIL_MAX_DIMENSION).toBe(192);
    expect(await renderedDimension(BROWSER_PRESET_GRID_THUMBNAIL_MAX_DIMENSION)).toBe(192);
  });

  it("大きさを省く面（スマホの段）は今の長辺 96px のまま", async () => {
    expect(BROWSER_PRESET_THUMBNAIL_MAX_DIMENSION).toBe(96);
    expect(await renderedDimension()).toBe(96);
  });
});
