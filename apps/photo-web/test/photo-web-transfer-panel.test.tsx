import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BrowserPersonalPhotoTransferController,
  PersonalPhotoTransferPage,
  PersonalPhotoTransferStatus,
} from "../../../packages/photo-cloud-library/src/browser/index.ts";
import { PhotoWebTransferPanel, type PhotoWebTransferHost } from "../src/view/PhotoWebTransferPanel";
import type { PhotoWebTransferBinding, PhotoWebTransferCopy } from "../src/view/types";

const copy: PhotoWebTransferCopy = {
  toolbar: "写真を追加",
  pendingTitle: "送信の詳細",
  add: "追加する",
  resume: "再開する",
  chooseSameFile: "同じ写真を選ぶ",
  cancel: "取り消す",
  refresh: "更新する",
  next: "次へ",
  first: "先頭へ",
  busy: "処理中です",
  failed: "送信に失敗しました",
  unsupported: "この形式は追加できません",
  refreshFailed: "一覧を更新できません",
  phaseLabels: {
    "start-pending": "準備中",
    uploading: "送信中",
    "complete-pending": "完了確認中",
    verifying: "確認中",
    "pending-recipe": "補正待ち",
    done: "完了",
    "cancel-pending": "取消確認中",
    cancelled: "取消済み",
    expired: "期限切れ",
    rejected: "受付不可",
    purged: "削除済み",
    failed: "失敗",
    "needs-file": "写真の再選択が必要",
  },
};

function status(overrides: Partial<PersonalPhotoTransferStatus> = {}): PersonalPhotoTransferStatus {
  return {
    intentId: "intent-a",
    phase: "uploading",
    fileName: "sample.jpg",
    format: "jpeg",
    sizeBytes: 100,
    sha256: "a".repeat(64),
    uploadedBytes: 25,
    photoId: null,
    hasPendingRecipe: false,
    failure: null,
    ...overrides,
  };
}

function page(items: readonly PersonalPhotoTransferStatus[] = [], nextCursor: string | null = null): PersonalPhotoTransferPage {
  return { items, nextCursor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function fakeController(overrides: Partial<BrowserPersonalPhotoTransferController> = {}) {
  return {
    checkCapability: vi.fn(async () => true),
    start: vi.fn(async () => status({ phase: "done", uploadedBytes: 100, photoId: "photo-a" })),
    resume: vi.fn(async () => status()),
    cancel: vi.fn(async () => status({ phase: "cancelled" })),
    list: vi.fn(async () => page()),
    readPendingRecipe: vi.fn(async () => null),
    dispose: vi.fn(),
    ...overrides,
  } as BrowserPersonalPhotoTransferController & {
    checkCapability: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    readPendingRecipe: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
}

function binding(
  controller: BrowserPersonalPhotoTransferController,
  overrides: Partial<PhotoWebTransferBinding> = {},
): PhotoWebTransferBinding {
  return {
    controller,
    formats: [
      { format: "jpeg", extensions: ["jpg", "jpeg"], ingest: true, workingCopy: true },
      { format: "png", extensions: ["png"], ingest: true, workingCopy: true },
    ],
    copy,
    describeError: () => "説明済みの失敗",
    onSettled: vi.fn(),
    ...overrides,
  };
}

function host(): PhotoWebTransferHost & { readonly controller: AbortController; current: boolean } {
  const controller = new AbortController();
  return {
    controller,
    current: true,
    scopeSignal: controller.signal,
    isScopeCurrent() { return this.current; },
  };
}

function byText(container: HTMLElement, selector: string, text: string): HTMLElement {
  const element = Array.from(container.querySelectorAll<HTMLElement>(selector))
    .find((candidate) => candidate.textContent === text);
  if (!element) throw new Error(`missing ${selector}: ${text}`);
  return element;
}

function inputByLabel(container: HTMLElement, label: string): HTMLInputElement {
  const input = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'))
    .find((candidate) => candidate.getAttribute("aria-label") === label);
  if (!input) throw new Error(`missing input: ${label}`);
  return input;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function choose(input: HTMLInputElement, file: File, initialValue = "selected") {
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  Object.defineProperty(input, "value", { configurable: true, writable: true, value: initialValue });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("PhotoWebTransferPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function render(transfer: PhotoWebTransferBinding, transferHost: PhotoWebTransferHost, mutationEnabled = true) {
    await act(async () => {
      root.render(<PhotoWebTransferPanel transfer={transfer} host={transferHost} mutationEnabled={mutationEnabled} />);
    });
  }

  it("mountではpage16を読むだけでmutationやcapability確認を始めない", async () => {
    const controller = fakeController();
    await render(binding(controller), host());
    await flush();

    expect(controller.list).toHaveBeenCalledTimes(1);
    expect(controller.list).toHaveBeenCalledWith({ limit: 16 });
    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.resume).not.toHaveBeenCalled();
    expect(controller.cancel).not.toHaveBeenCalled();
    expect(controller.checkCapability).not.toHaveBeenCalled();
  });

  it("選択ごとに入力を即時clearし、一つのintentとactive gateだけでstartする", async () => {
    const pending = deferred<PersonalPhotoTransferStatus>();
    const controller = fakeController({ start: vi.fn(() => pending.promise) });
    const transfer = binding(controller);
    const randomUUID = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("intent-new");
    await render(transfer, host());
    await flush();
    const input = inputByLabel(container, copy.add);

    act(() => {
      choose(input, new File(["one"], "one.jpg", { type: "image/jpeg" }));
      expect(input.value).toBe("");
      choose(input, new File(["two"], "two.jpg", { type: "image/jpeg" }));
      expect(input.value).toBe("");
    });

    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(controller.start).toHaveBeenCalledTimes(1);
    expect(controller.start.mock.calls[0]?.[0]).toMatchObject({
      intentId: "intent-new",
      format: "jpeg",
      fullRecipeCandidate: null,
    });
    expect(controller.start.mock.calls[0]?.[0].file.name).toBe("one.jpg");
    await act(async () => pending.resolve(status({ intentId: "intent-new", phase: "done", fileName: "one.jpg" })));
  });

  it.each([
    ["formatsなし", []],
    ["全形式ingest=false", [{ format: "png", extensions: ["png"], ingest: false, workingCopy: true }]],
  ] as const)("%sでは追加入口を閉じ、実イベントもstart前に止める", async (_name, formats) => {
    const controller = fakeController();
    const transfer = binding(controller, { formats });
    await render(transfer, host());
    await flush();
    const input = inputByLabel(container, copy.add);
    const addButton = byText(container, "button", copy.add);

    expect(input.disabled).toBe(true);
    expect(addButton.hasAttribute("disabled")).toBe(true);
    expect(input.getAttribute("accept")).toBeNull();
    act(() => choose(input, new File(["unknown"], "unknown.png", { type: "image/png" })));

    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.checkCapability).not.toHaveBeenCalled();
    expect(container.textContent).toContain(copy.unsupported);
  });

  it("offline/verifyingへ変わってpickerから戻ってもmutationしない", async () => {
    const controller = fakeController();
    const transfer = binding(controller);
    const transferHost = host();
    await render(transfer, transferHost, true);
    await flush();
    act(() => byText(container, "button", copy.add).click());

    await render(transfer, transferHost, false);
    const input = inputByLabel(container, copy.add);
    act(() => choose(input, new File(["late"], "late.jpg", { type: "image/jpeg" })));
    expect(input.value).toBe("");
    expect(controller.start).not.toHaveBeenCalled();

    transferHost.current = false;
    await render(transfer, transferHost, true);
    act(() => choose(inputByLabel(container, copy.add), new File(["verify"], "verify.jpg", { type: "image/jpeg" })));
    expect(controller.start).not.toHaveBeenCalled();
  });

  it("needs-file後のchooserは同じintentへFileを渡して毎回clearする", async () => {
    const initial = status({ intentId: "intent-resume", fileName: "resume.jpg" });
    const needsFile = status({ ...initial, phase: "needs-file" });
    const done = status({ ...initial, phase: "done", uploadedBytes: 100, photoId: "any-photo" });
    const controller = fakeController();
    controller.list
      .mockResolvedValueOnce(page([initial]))
      .mockResolvedValueOnce(page([initial]))
      .mockResolvedValueOnce(page([initial]))
      .mockResolvedValueOnce(page([done]));
    controller.resume.mockResolvedValueOnce(needsFile).mockResolvedValueOnce(done);
    await render(binding(controller), host());
    await flush();

    act(() => byText(container, "button", copy.resume).click());
    await flush();
    expect(controller.resume).toHaveBeenNthCalledWith(1, { intentId: "intent-resume" }, expect.any(AbortSignal));

    act(() => byText(container, "button", copy.refresh).click());
    await flush();

    const input = inputByLabel(container, copy.chooseSameFile);
    act(() => choose(input, new File(["same"], "resume.jpg", { type: "image/jpeg" })));
    expect(input.value).toBe("");
    await flush();
    expect(controller.resume).toHaveBeenNthCalledWith(2, {
      intentId: "intent-resume",
      file: expect.objectContaining({ name: "resume.jpg" }),
    }, expect.any(AbortSignal));
  });

  it("cancelは現在intentへだけ渡し、terminal行にはmutation controlを出さない", async () => {
    const active = status({ intentId: "intent-cancel" });
    const cancelled = status({ ...active, phase: "cancelled" });
    const controller = fakeController();
    controller.list.mockResolvedValueOnce(page([active])).mockResolvedValueOnce(page([cancelled]));
    controller.cancel.mockResolvedValue(cancelled);
    await render(binding(controller), host());
    await flush();

    act(() => byText(container, "button", copy.cancel).click());
    await flush();
    expect(controller.cancel).toHaveBeenCalledWith("intent-cancel", expect.any(AbortSignal));
    expect(container.textContent).toContain(copy.phaseLabels.cancelled);
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === copy.resume)).toBe(false);
    expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === copy.cancel)).toBe(false);
  });

  it("全terminal phaseを表示したままretry/cancelを提供しない", async () => {
    const terminal = ["done", "pending-recipe", "cancelled", "expired", "rejected", "purged", "failed"] as const;
    const controller = fakeController({
      list: vi.fn(async () => page(terminal.map((phase, index) => status({
        intentId: `terminal-${index}`,
        phase,
        fileName: `terminal-${index}.jpg`,
      })))),
    });
    await render(binding(controller), host());
    await flush();

    for (const phase of terminal) expect(container.textContent).toContain(copy.phaseLabels[phase]);
    for (const action of [copy.resume, copy.chooseSameFile, copy.cancel]) {
      expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === action)).toBe(false);
    }
  });

  it("current pageを16件に限定しnextで置換、firstで先頭へ戻る", async () => {
    const firstItems = Array.from({ length: 20 }, (_, index) => status({
      intentId: `first-${index}`,
      fileName: `first-${index}.jpg`,
    }));
    const nextItems = [status({ intentId: "next-a", fileName: "next-a.jpg" })];
    const controller = fakeController();
    controller.list
      .mockResolvedValueOnce(page(firstItems, "cursor-next"))
      .mockResolvedValueOnce(page(nextItems))
      .mockResolvedValueOnce(page(firstItems, "cursor-next"));
    await render(binding(controller), host());
    await flush();
    expect(container.querySelectorAll(".photo-web-transfer-row")).toHaveLength(16);

    act(() => byText(container, "button", copy.next).click());
    await flush();
    expect(controller.list).toHaveBeenNthCalledWith(2, { cursor: "cursor-next", limit: 16 });
    expect(container.querySelectorAll(".photo-web-transfer-row")).toHaveLength(1);
    expect(container.textContent).toContain("next-a.jpg");
    expect(container.textContent).not.toContain("first-0.jpg");

    act(() => byText(container, "button", copy.first).click());
    await flush();
    expect(controller.list).toHaveBeenNthCalledWith(3, { limit: 16 });
    expect(container.querySelectorAll(".photo-web-transfer-row")).toHaveLength(16);
  });

  it("failed+storedと任意photoIdもonSettledへ渡す", async () => {
    const initial = status({ intentId: "stored-intent" });
    const stored = status({ ...initial, phase: "failed", failure: "stored", photoId: "opaque-photo" });
    const onSettled = vi.fn();
    const controller = fakeController();
    controller.list.mockResolvedValueOnce(page([initial])).mockResolvedValueOnce(page([stored]));
    controller.resume.mockResolvedValue(stored);
    await render(binding(controller, { onSettled }), host());
    await flush();
    act(() => byText(container, "button", copy.resume).click());
    await flush();

    expect(onSettled).toHaveBeenCalledWith(stored);
    expect(container.textContent).toContain(copy.phaseLabels.done);
    expect(container.textContent).not.toContain(copy.phaseLabels.failed);
    expect(Array.from(container.querySelectorAll("button")).some((button) => (
      button.textContent === copy.resume || button.textContent === copy.cancel
    ))).toBe(false);
    expect(container.textContent).not.toContain("opaque-photo");
    expect(container.textContent).not.toContain(stored.sha256);
  });

  it("mount一覧のfailed+storedを保存済みとして表示しmutation controlを出さない", async () => {
    const stored = status({ phase: "failed", failure: "stored", photoId: "opaque-photo" });
    const controller = fakeController({ list: vi.fn(async () => page([stored])) });
    await render(binding(controller), host());
    await flush();

    expect(container.textContent).toContain(copy.phaseLabels.done);
    expect(container.textContent).not.toContain(copy.phaseLabels.failed);
    for (const action of [copy.resume, copy.chooseSameFile, copy.cancel]) {
      expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === action)).toBe(false);
    }
  });

  it("onSettled失敗でaccepted doneをtransfer failedへ変えない", async () => {
    const initial = status({ intentId: "done-intent" });
    const done = status({ ...initial, phase: "done", uploadedBytes: 100, photoId: "photo-done" });
    const controller = fakeController();
    controller.list.mockResolvedValueOnce(page([initial])).mockResolvedValueOnce(page([done]));
    controller.resume.mockResolvedValue(done);
    await render(binding(controller, { onSettled: vi.fn(async () => { throw new Error("callback failed"); }) }), host());
    await flush();
    act(() => byText(container, "button", copy.resume).click());
    await flush();

    expect(container.textContent).toContain(copy.phaseLabels.done);
    expect(container.textContent).not.toContain(copy.failed);
    expect(container.textContent).not.toContain("callback failed");
  });

  it("scope abortとunmountはoperation signalだけをabortしcontrollerをdisposeしない", async () => {
    const first = deferred<PersonalPhotoTransferStatus>();
    let operationSignal: AbortSignal | undefined;
    const controller = fakeController({
      start: vi.fn((_, signal) => { operationSignal = signal; return first.promise; }),
    });
    const transferHost = host();
    await render(binding(controller), transferHost);
    await flush();
    act(() => choose(inputByLabel(container, copy.add), new File(["x"], "x.jpg", { type: "image/jpeg" })));
    expect(operationSignal?.aborted).toBe(false);
    act(() => transferHost.controller.abort());
    expect(operationSignal?.aborted).toBe(true);
    expect(container.querySelectorAll(".photo-web-transfer-row")).toHaveLength(0);
    expect(controller.dispose).not.toHaveBeenCalled();

    const secondController = fakeController({ start: vi.fn(() => new Promise(() => undefined)) });
    const secondHost = host();
    await render(binding(secondController), secondHost);
    await flush();
    act(() => choose(inputByLabel(container, copy.add), new File(["y"], "y.jpg", { type: "image/jpeg" })));
    const secondSignal = secondController.start.mock.calls[0]?.[1] as AbortSignal;
    act(() => root.unmount());
    expect(secondSignal.aborted).toBe(true);
    expect(secondController.dispose).not.toHaveBeenCalled();
    root = createRoot(container);
  });

  it("置換済みscopeの遅着完了はrender/onSettled/listを再開しない", async () => {
    const late = deferred<PersonalPhotoTransferStatus>();
    const oldSettled = vi.fn();
    const oldController = fakeController({ start: vi.fn(() => late.promise) });
    const oldTransfer = binding(oldController, { onSettled: oldSettled });
    const oldHost = host();
    await render(oldTransfer, oldHost);
    await flush();
    act(() => choose(inputByLabel(container, copy.add), new File(["old"], "old.jpg", { type: "image/jpeg" })));

    const nextController = fakeController();
    const nextTransfer = binding(nextController);
    await render(nextTransfer, host());
    await flush();
    await act(async () => late.resolve(status({ intentId: "old", phase: "done", fileName: "old.jpg" })));

    expect(oldSettled).not.toHaveBeenCalled();
    expect(oldController.list).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("old.jpg");
    expect(nextController.list).toHaveBeenCalledTimes(1);
  });
});
