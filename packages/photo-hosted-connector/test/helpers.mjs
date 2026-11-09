import { createHostedConnector } from "../src/index.ts";
import { bufferingHasher, sha256Bytes } from "../src/crypto.ts";
import { MemoryReplicaStore } from "../../photo-hosted-library/test-support/memory.ts";
import { FakeNiho, OWNER } from "../test-support/fake-niho.ts";
import { FakeFileSystem, ManualClock, MemoryIndexStore, MemoryPower, MemoryVault } from "../test-support/memory.ts";

export const signal = new AbortController().signal;
export const ROOT = { id: "synthetic-root" };

/** A synthetic preview executor: a few bytes derived from the original, never the original itself. */
export const previewExecutor = {
  renderer: null,
  runs: 0,
  async run({ original }) {
    this.runs++;
    let size = 0;
    for await (const chunk of original.read(signal)) size += chunk.byteLength;
    const bytes = new TextEncoder().encode(`synthetic preview of ${size} bytes`);
    return { request: { kind: "preview", sizeBytes: bytes.byteLength, sha256: await sha256Bytes(bytes), contentType: "image/jpeg", width: 4, height: 3 }, bytes };
  },
};

export function world({ files = {}, executors = {} } = {}) {
  const niho = new FakeNiho();
  const fs = new FakeFileSystem();
  for (const [path, text] of Object.entries(files)) fs.addFile(ROOT.id, path, text);
  const parts = {
    niho, fs, vault: new MemoryVault(), index: new MemoryIndexStore(), replica: new MemoryReplicaStore(),
    power: new MemoryPower(), clock: new ManualClock(),
  };
  const build = (overrides = {}) => createHostedConnector({
    vault: parts.vault, transport: niho.transport, fs, roots: [ROOT], index: parts.index, replica: parts.replica,
    hasher: bufferingHasher, power: parts.power, uploader: niho.uploader, executors, clock: parts.clock, ...overrides,
  });
  return { ...parts, connector: build(), build };
}

/** Pairs the connector with the synthetic owner's new library. */
export async function paired(context) {
  const { userCode } = await context.connector.pair("Synthetic Mac", signal);
  context.niho.approve(userCode, OWNER, { kind: "newLibrary" });
  const answer = await context.connector.poll(signal);
  if (answer.state !== "approved") throw new Error("not approved");
  return context;
}

/** Runs ticks until the scan is complete and nothing is left to hash or report. */
export async function settle(connector, rounds = 10) {
  let last;
  for (let index = 0; index < rounds; index++) {
    last = await connector.tick(signal);
    if (last.scanComplete && last.hashed?.files === 0 && last.reported === 0 && (last.jobs?.claimed ?? 0) === 0) break;
  }
  return last;
}
