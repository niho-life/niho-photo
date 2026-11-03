import { afterEach, describe, expect, it, vi } from "vitest";

import { appDialog, getAppDialogSnapshot, registerAppDialogHost, subscribeAppDialogRequests } from "./app-dialog";

afterEach(() => appDialog.cancelAll());

describe("appDialog.cancelAll", () => {
  it("全種類の待ち行列を取消し、表示内容も同期的に消す", async () => {
    const unregister = registerAppDialogHost();
    const changed = vi.fn();
    const unsubscribe = subscribeAppDialogRequests(changed);
    try {
      const pending = [
        appDialog.confirm({ title: "old confirm", confirmLabel: "confirm" }),
        appDialog.confirmWithCheckbox({ title: "old checkbox", confirmLabel: "confirm", checkbox: { label: "check" } }),
        appDialog.prompt({ title: "old prompt", inputLabel: "name", confirmLabel: "save" }),
        appDialog.choose({ title: "old choice", choices: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }),
        appDialog.alert({ title: "old alert" }),
      ];
      changed.mockClear();
      appDialog.cancelAll();
      expect(getAppDialogSnapshot()).toEqual({ active: null, shown: null });
      expect(changed).toHaveBeenCalledOnce();
      await expect(Promise.all(pending)).resolves.toEqual([false, null, null, null, undefined]);
    } finally {
      unsubscribe();
      unregister();
    }
  });

  it("空のqueueでも閉じるアニメーション用の古い内容を消す", async () => {
    const unregister = registerAppDialogHost();
    try {
      const result = appDialog.confirm({ title: "old name", confirmLabel: "confirm" });
      const old = getAppDialogSnapshot().active;
      if (old?.kind !== "confirm") throw new Error("missing confirm");
      old.settle(false);
      await expect(result).resolves.toBe(false);
      expect(getAppDialogSnapshot().shown).toBe(old);
      appDialog.cancelAll();
      appDialog.cancelAll();
      expect(getAppDialogSnapshot()).toEqual({ active: null, shown: null });
    } finally {
      unregister();
    }
  });

  it("hostを維持し、古いcallbackが新scopeの依頼へ影響しない", async () => {
    const unregister = registerAppDialogHost();
    try {
      const oldResult = appDialog.confirm({ title: "old", confirmLabel: "confirm" });
      const old = getAppDialogSnapshot().active;
      if (old?.kind !== "confirm") throw new Error("missing old confirm");
      appDialog.cancelAll();
      const newResult = appDialog.confirm({ title: "new", confirmLabel: "confirm" });
      const current = getAppDialogSnapshot().active;
      if (current?.kind !== "confirm") throw new Error("missing new confirm");
      old.settle(true);
      expect(getAppDialogSnapshot().active).toBe(current);
      current.settle(true);
      await expect(oldResult).resolves.toBe(false);
      await expect(newResult).resolves.toBe(true);
    } finally {
      unregister();
    }
  });
});
