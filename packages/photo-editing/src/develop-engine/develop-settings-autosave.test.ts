import { afterEach, describe, expect, it, vi } from "vitest";

import type { PhotoLibraryDevelopDraftStage } from "../library/photo-library-durable-drafts";
import { createDevelopSettingsSaver } from "./develop-settings-autosave";
import type { DevelopSettings } from "./develop-settings";

const settings = (exposure: number): DevelopSettings => ({ v: 1, engine: "niho-1", exposure });
const stage = (committed: PhotoLibraryDevelopDraftStage["committed"] = Promise.resolve("committed")) => ({ committed });

afterEach(() => vi.useRealTimers());

describe("createDevelopSettingsSaver durable mode", () => {
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
