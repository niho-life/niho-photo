import { afterEach, describe, expect, it, vi } from "vitest";

import type { PhotoLibraryDevelopDraftStage } from "../library/photo-library-durable-drafts";
import { createDevelopSettingsSaver } from "./develop-settings-autosave";
import type { DevelopSettings } from "./develop-settings";

const settings = (exposure: number): DevelopSettings => ({ v: 1, engine: "niho-1", exposure });
const stage = (committed: PhotoLibraryDevelopDraftStage["committed"] = Promise.resolve("committed")) => ({ committed });

afterEach(() => vi.useRealTimers());

describe("createDevelopSettingsSaver durable mode", () => {
  it("pauses dispatch after an already-running stage barrier and keeps latest B for resume", async () => {
    vi.useFakeTimers();
    let commitA!: (value: "committed") => void;
    const capturedA = stage(new Promise((resolve) => { commitA = resolve; }));
    const stageDraft = vi.fn((value: DevelopSettings) => value.exposure === 0.1 ? capturedA : stage());
    const save = vi.fn(async (_value: DevelopSettings) => ({ kind: "saved" as const, revision: 1, updatedAt: null }));
    const saver = createDevelopSettingsSaver({
      save: vi.fn(), isPermanentFailure: () => false, delayMs: 10,
      durable: { stage: stageDraft, save },
    });
    saver.schedule(settings(0.1));
    await vi.advanceTimersByTimeAsync(20);
    expect(save).not.toHaveBeenCalled();
    const resume = saver.pauseDurable?.();
    saver.schedule(settings(0.2));
    commitA("committed");
    await vi.advanceTimersByTimeAsync(0);
    expect(save).not.toHaveBeenCalled();
    await expect(saver.flush()).resolves.toMatchObject({ ok: false });
    resume?.();
    await vi.runAllTimersAsync();
    await expect(saver.flush()).resolves.toMatchObject({ ok: true });
    expect(save.mock.calls.map(([value]) => value.exposure)).toEqual([0.2]);
    saver.dispose();
  });

  it("pauses network while preserving the staged latest input and resumes it once", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_settings: DevelopSettings) => ({ kind: "saved" as const, revision: 1, updatedAt: null }));
    const saver = createDevelopSettingsSaver({
      save: vi.fn(), isPermanentFailure: () => false, delayMs: 10,
      durable: { stage: vi.fn(() => stage()), save },
    });

    const resume = saver.pauseDurable?.();
    expect(resume).toBeTypeOf("function");
    saver.schedule(settings(0.2));
    await vi.advanceTimersByTimeAsync(20);
    expect(save).not.toHaveBeenCalled();
    await expect(saver.flush()).resolves.toMatchObject({ ok: false });
    expect(save).not.toHaveBeenCalled();

    resume?.();
    resume?.();
    await vi.runAllTimersAsync();
    await expect(saver.flush()).resolves.toMatchObject({ ok: true });
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0]).toMatchObject({ exposure: 0.2 });
  });

  it("keeps later B paused while sent A settles, then resumes B without clearing it", async () => {
    let settleA!: () => void;
    const save = vi.fn(async (value: DevelopSettings) => {
      if (value.exposure === 0.1) await new Promise<void>((resolve) => { settleA = resolve; });
      return { kind: "saved" as const, revision: value.exposure === 0.1 ? 1 : 2, updatedAt: null };
    });
    const saver = createDevelopSettingsSaver({
      save: vi.fn(), isPermanentFailure: () => false, delayMs: 0,
      durable: { stage: () => stage(), save },
    });

    saver.schedule(settings(0.1));
    const flushingA = saver.flush();
    while (save.mock.calls.length === 0) await Promise.resolve();
    const resume = saver.pauseDurable?.();
    saver.schedule(settings(0.2));
    settleA();
    await flushingA;
    expect(save.mock.calls.map(([value]) => value.exposure)).toEqual([0.1]);
    expect(saver.hasPendingWork()).toBe(true);

    resume?.();
    await expect(saver.flush()).resolves.toMatchObject({ ok: true, saved: { developRevision: 2 } });
    expect(save.mock.calls.map(([value]) => value.exposure)).toEqual([0.1, 0.2]);
  });

  it("does not thaw a failed freeze on resume and cannot restart after dispose", async () => {
    const save = vi.fn(async () => ({ kind: "unknown" as const }));
    const saver = createDevelopSettingsSaver({
      save: vi.fn(), isPermanentFailure: () => false, delayMs: 0,
      durable: { stage: () => stage(), save },
    });
    const resume = saver.pauseDurable?.();
    saver.schedule(settings(0.3));
    resume?.();
    await expect(saver.flush()).resolves.toMatchObject({ ok: false });
    expect(save).toHaveBeenCalledOnce();

    const resumeFrozen = saver.pauseDurable?.();
    resumeFrozen?.();
    await expect(saver.flush()).resolves.toMatchObject({ ok: false });
    expect(save).toHaveBeenCalledOnce();

    const disposedSaver = createDevelopSettingsSaver({
      save: vi.fn(), isPermanentFailure: () => false, delayMs: 0,
      durable: { stage: () => stage(), save },
    });
    const resumeDisposed = disposedSaver.pauseDurable?.();
    disposedSaver.schedule(settings(0.4));
    disposedSaver.dispose();
    resumeDisposed?.();
    for (let n = 0; n < 10; n++) await Promise.resolve();
    expect(save).toHaveBeenCalledOnce();
  });

  it("keeps the legacy saver surface unchanged", () => {
    const saver = createDevelopSettingsSaver({
      save: vi.fn(async () => ({ kind: "saved" as const, revision: 1, updatedAt: null })),
      isPermanentFailure: () => false,
    });
    expect(saver.pauseDurable).toBeUndefined();
  });

  it("starts strict staging before debounce and performs no network until commit", async () => {
    vi.useFakeTimers();
    let commit!: (value: "committed") => void;
    const staged = stage(new Promise((resolve) => { commit = resolve; }));
    const stageDraft = vi.fn(() => staged);
    const save = vi.fn(async () => ({ kind: "saved" as const, revision: 1, updatedAt: null }));
    const saver = createDevelopSettingsSaver({
      save: vi.fn(),
      isPermanentFailure: () => false,
      delayMs: 10,
      durable: { stage: stageDraft, save },
    });

    saver.schedule(settings(0.2));
    expect(stageDraft).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10);
    expect(save).not.toHaveBeenCalled();
    commit("committed");
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(save).toHaveBeenCalledOnce();
  });

  it.each(["throw", "reject", "unsaved"] as const)("keeps pending and flush=false when stage is %s", async (kind) => {
    const durableStage = () => {
      if (kind === "throw") throw new Error("stage failed");
      if (kind === "reject") return stage(Promise.reject(new Error("commit failed")));
      return stage(Promise.resolve("unsaved"));
    };
    const save = vi.fn();
    const saver = createDevelopSettingsSaver({
      save: vi.fn(),
      isPermanentFailure: () => false,
      delayMs: 0,
      durable: { stage: durableStage, save },
    });
    saver.schedule(settings(0.3));
    await expect(saver.flush()).resolves.toMatchObject({ ok: false });
    expect(save).not.toHaveBeenCalled();
    expect(saver.hasPendingWork()).toBe(true);
  });

  it("uses one synchronous clone for stage, save, onSaved, and lastSaved", async () => {
    const input = settings(0.4);
    const seen: DevelopSettings[] = [];
    const saver = createDevelopSettingsSaver({
      save: vi.fn(),
      isPermanentFailure: () => false,
      delayMs: 0,
      durable: {
        stage(value) { seen.push(value); return stage(); },
        async save(value) { seen.push(value); return { kind: "saved", revision: 2, updatedAt: "2026-11-03T00:00:00.000Z" }; },
      },
      onSaved(value) { seen.push(value); },
    });
    saver.schedule(input);
    input.exposure = 4;
    await expect(saver.flush()).resolves.toMatchObject({ ok: true });
    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[1]).toBe(seen[2]);
    expect(seen[0]?.exposure).toBe(0.4);
    expect(saver.getLastSaved()?.settings).toBe(seen[0]);
  });

  it("does not erase later B when A ACK arrives late", async () => {
    let ackA!: () => void;
    const save = vi.fn(async (value: DevelopSettings) => {
      if (value.exposure === 0.1) await new Promise<void>((resolve) => { ackA = resolve; });
      return { kind: "saved" as const, revision: value.exposure === 0.1 ? 1 : 2, updatedAt: null };
    });
    const saver = createDevelopSettingsSaver({
      save: vi.fn(), isPermanentFailure: () => false, delayMs: 0,
      durable: { stage: () => stage(), save },
    });
    saver.schedule(settings(0.1));
    const flushed = saver.flush();
    while (save.mock.calls.length === 0) await Promise.resolve();
    saver.schedule(settings(0.2));
    ackA();
    await expect(flushed).resolves.toMatchObject({ ok: true, saved: { developRevision: 2 } });
    expect(save.mock.calls.map(([value]) => value.exposure)).toEqual([0.1, 0.2]);
  });

  it("freezes on conflict, preserves later B, and never calls legacy stale reload", async () => {
    let answerA!: (value: { kind: "conflict"; conflict: { kind: "develop-conflict" } }) => void;
    const conflict = Object.freeze({ kind: "develop-conflict" as const });
    const onConflict = vi.fn();
    const onStale = vi.fn();
    const save = vi.fn(async (value: DevelopSettings) => {
      if (value.exposure === 0.1) return await new Promise<{ kind: "conflict"; conflict: typeof conflict }>((resolve) => { answerA = resolve; });
      return { kind: "saved" as const, revision: 2, updatedAt: null };
    });
    const saver = createDevelopSettingsSaver({
      save: vi.fn(), isPermanentFailure: () => false, delayMs: 0, onStale,
      durable: { stage: () => stage(), save, onConflict },
    });
    saver.schedule(settings(0.1));
    const flushed = saver.flush();
    while (save.mock.calls.length === 0) await Promise.resolve();
    saver.schedule(settings(0.2));
    answerA({ kind: "conflict", conflict });
    await expect(flushed).resolves.toMatchObject({ ok: false });
    saver.schedule(settings(0.3));
    await expect(saver.flush()).resolves.toMatchObject({ ok: false });
    expect(save.mock.calls.map(([value]) => value.exposure)).toEqual([0.1]);
    expect(onConflict).toHaveBeenCalledWith(conflict);
    expect(onStale).not.toHaveBeenCalled();
    expect(saver.hasPendingWork()).toBe(true);
  });
});
