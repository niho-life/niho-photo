import { describe, expect, it, vi } from "vitest";
import { createDevelopSettingsSaver } from "./develop-settings-autosave";
import type { PhotoLibraryDevelopDraftStage } from "../library/photo-library-durable-drafts";

const settings = (exposure: number) => ({ v: 1 as const, engine: "niho-1", exposure });

describe("durable autosaver completion boundaries", () => {
  it.each(["committed", "unsaved"] as const)("waits for latest B strict result (%s) before exposing A conflict", async (outcome) => {
    let answerA!: (value: { kind: "conflict"; conflict: { kind: "develop-conflict" } }) => void;
    let commitB!: (value: "committed" | "unsaved") => void;
    const bCommitted = new Promise<"committed" | "unsaved">((resolve) => { commitB = resolve; });
    const conflict = { kind: "develop-conflict" as const };
    const onConflict = vi.fn();
    const save = vi.fn(async () => await new Promise<{ kind: "conflict"; conflict: typeof conflict }>((resolve) => { answerA = resolve; }));
    const saver = createDevelopSettingsSaver({
      save: vi.fn(), isPermanentFailure: () => false, delayMs: 0,
      durable: {
        stage: (value): PhotoLibraryDevelopDraftStage => ({ committed: value.exposure === 0.1 ? Promise.resolve("committed") : bCommitted }),
        save, onConflict,
      },
    });
    saver.schedule(settings(0.1));
    const flushed = saver.flush();
    for (let index = 0; index < 30 && save.mock.calls.length === 0; index += 1) await Promise.resolve();
    expect(save).toHaveBeenCalledOnce();
    saver.schedule(settings(0.2));
    answerA({ kind: "conflict", conflict });
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    try { expect(onConflict).not.toHaveBeenCalled(); }
    finally { commitB(outcome); await flushed; saver.dispose(); }
    expect(onConflict).toHaveBeenCalledTimes(outcome === "committed" ? 1 : 0);
    expect(save).toHaveBeenCalledOnce();
    expect(saver.hasPendingWork()).toBe(true);
  });

  it("retries the same unsaved input after storage becomes available, before any dispatch", async () => {
    let stages = 0;
    const save = vi.fn(async () => ({ kind: "saved" as const, revision: 1, updatedAt: null }));
    const saver = createDevelopSettingsSaver({
      save: vi.fn(), isPermanentFailure: () => false, delayMs: 0,
      durable: { stage: () => ({ committed: Promise.resolve(++stages === 1 ? "unsaved" as const : "committed" as const) }), save },
    });
    try {
      saver.schedule(settings(0.7));
      await expect(saver.flush()).resolves.toMatchObject({ ok: false });
      expect(save).not.toHaveBeenCalled();
      await expect(saver.retry()).resolves.toMatchObject({ ok: true, saved: { settings: settings(0.7), developRevision: 1 } });
      expect(stages).toBe(2);
      expect(save).toHaveBeenCalledOnce();
    } finally { saver.dispose(); }
  });

  it("follows superseded B to the latest C before exposing the fixed A conflict", async () => {
    let answerA!: (value: { kind: "conflict"; conflict: { kind: "develop-conflict" } }) => void;
    let commitB!: (value: "superseded") => void;
    let commitC!: (value: "committed") => void;
    const conflict = { kind: "develop-conflict" as const };
    const onConflict = vi.fn();
    const saver = createDevelopSettingsSaver({
      save: vi.fn(), isPermanentFailure: () => false, delayMs: 0,
      durable: {
        stage: (value) => ({ committed: value.exposure === 0.1
          ? Promise.resolve("committed")
          : value.exposure === 0.2
            ? new Promise<"superseded">((resolve) => { commitB = resolve; })
            : new Promise<"committed">((resolve) => { commitC = resolve; }) }),
        save: async () => await new Promise((resolve) => { answerA = resolve; }),
        onConflict,
      },
    });
    saver.schedule(settings(0.1));
    const flushed = saver.flush();
    for (let index = 0; index < 20 && !answerA; index += 1) await Promise.resolve();
    saver.schedule(settings(0.2));
    answerA({ kind: "conflict", conflict });
    saver.schedule(settings(0.3));
    commitB("superseded");
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect(onConflict).not.toHaveBeenCalled();
    commitC("committed");
    await flushed;
    expect(onConflict).toHaveBeenCalledOnce();
    expect(saver.hasPendingWork()).toBe(true);
    saver.dispose();
  });

  it("bounds an unsettled latest stage and ignores its late commit", async () => {
    vi.useFakeTimers();
    let answerA!: (value: { kind: "conflict"; conflict: { kind: "develop-conflict" } }) => void;
    let commitB!: (value: "committed") => void;
    const conflict = { kind: "develop-conflict" as const };
    const onConflict = vi.fn();
    const saver = createDevelopSettingsSaver({
      save: vi.fn(), isPermanentFailure: () => false, delayMs: 0,
      durable: {
        stage: (value) => ({ committed: value.exposure === 0.1
          ? Promise.resolve("committed")
          : new Promise<"committed">((resolve) => { commitB = resolve; }) }),
        save: async () => await new Promise((resolve) => { answerA = resolve; }),
        onConflict,
        stageTimeoutMs: 5,
      },
    });
    try {
      saver.schedule(settings(0.1));
      const flushed = saver.flush();
      await vi.advanceTimersByTimeAsync(0);
      for (let index = 0; index < 20 && !answerA; index += 1) await Promise.resolve();
      saver.schedule(settings(0.2));
      answerA({ kind: "conflict", conflict });
      await vi.advanceTimersByTimeAsync(5);
      await expect(flushed).resolves.toMatchObject({ ok: false });
      expect(onConflict).not.toHaveBeenCalled();
      commitB("committed");
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
      expect(onConflict).not.toHaveBeenCalled();
    } finally {
      saver.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["unknown", "conflict"] as const)("does not restage or replace a fixed %s request from saver retry", async (kind) => {
    const stageDraft = vi.fn((): PhotoLibraryDevelopDraftStage => ({ committed: Promise.resolve("committed") }));
    const conflict = { kind: "develop-conflict" as const };
    const save = vi.fn(async () => kind === "unknown"
      ? { kind: "unknown" as const }
      : { kind: "conflict" as const, conflict });
    const saver = createDevelopSettingsSaver({
      save: vi.fn(), isPermanentFailure: () => false, delayMs: 0,
      durable: { stage: stageDraft, save },
    });
    try {
      saver.schedule(settings(0.9));
      await expect(saver.flush()).resolves.toMatchObject({ ok: false });
      await expect(saver.retry()).resolves.toMatchObject({ ok: false });
      expect(stageDraft).toHaveBeenCalledOnce();
      expect(save).toHaveBeenCalledOnce();
      expect(saver.hasPendingWork()).toBe(true);
    } finally { saver.dispose(); }
  });

  it("settles resolved A only and leaves committed B held until a later explicit retry", async () => {
    let answerA!: (value: { kind: "conflict"; conflict: { kind: "develop-conflict" } }) => void;
    const conflict = { kind: "develop-conflict" as const };
    const save = vi.fn(async (value: ReturnType<typeof settings>) => value.exposure === 0.1
      ? await new Promise<{ kind: "conflict"; conflict: typeof conflict }>((resolve) => { answerA = resolve; })
      : { kind: "saved" as const, revision: 2, updatedAt: null });
    const saver = createDevelopSettingsSaver({
      save: vi.fn(), isPermanentFailure: () => false, delayMs: 0,
      durable: { stage: () => ({ committed: Promise.resolve("committed") }), save },
    });
    try {
      saver.schedule(settings(0.1));
      const first = saver.flush();
      for (let index = 0; index < 20 && !answerA; index += 1) await Promise.resolve();
      saver.schedule(settings(0.2));
      answerA({ kind: "conflict", conflict });
      await expect(first).resolves.toMatchObject({ ok: false });
      expect(saver.acknowledgeDurableInput?.(settings(0.1))).toBe(true);
      expect(save.mock.calls.map(([value]) => value.exposure)).toEqual([0.1]);
      expect(saver.hasPendingWork()).toBe(true);
      await expect(saver.retry()).resolves.toMatchObject({ ok: true, saved: { settings: settings(0.2) } });
      expect(save.mock.calls.map(([value]) => value.exposure)).toEqual([0.1, 0.2]);
    } finally { saver.dispose(); }
  });
});
