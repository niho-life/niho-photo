// Synthetic measurement of the hosted Mac connector (B03 #244). No real photos: a tree of random bytes is generated in
// a temporary folder, indexed read-only with the connector core and the node adapters, then removed.
//
//   node packages/photo-hosted-connector/bench/scan-hash.mjs --files 256 --size 16777216 --tiny 20000 --preview 262144
//
// Reports scan rate, hash throughput, the cost of an unchanged rescan, and what would be sent to NIHO, and
// extrapolates to a 1 TiB library. Hash reads come from the page cache when the tree is fresh; disk-bound rates of
// the owner's drive are lower and are printed for typical drives as well.
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createNodeRootFileSystem, nodeHasher } from "../node/index.ts";
import { createHostedConnector } from "../src/index.ts";
import { createIndexer } from "../src/indexer.ts";
import { sha256Bytes } from "../src/crypto.ts";
import { MemoryReplicaStore } from "../../photo-hosted-library/test-support/memory.ts";
import { FakeNiho, OWNER } from "../test-support/fake-niho.ts";
import { ManualClock, MemoryIndexStore, MemoryPower, MemoryVault } from "../test-support/memory.ts";

const { values } = parseArgs({
  options: {
    files: { type: "string", default: "64" },
    size: { type: "string", default: String(8 * 1024 * 1024) },
    tiny: { type: "string", default: "2000" },
    preview: { type: "string", default: String(256 * 1024) },
    average: { type: "string", default: String(25 * 1024 * 1024) },
  },
});
const FILES = Number(values.files);
const SIZE = Number(values.size);
const TINY = Number(values.tiny);
const PREVIEW = Number(values.preview);
const AVERAGE = Number(values.average);
const TIB = 1024 ** 4;
const signal = new AbortController().signal;
const realClock = { now: () => performance.now() };
const seconds = (ms) => Math.round(ms) / 1000;

async function generate(base) {
  const big = path.join(base, "originals");
  const small = path.join(base, "catalog");
  const block = randomBytes(SIZE);
  for (let index = 0; index < FILES; index++) {
    const dir = path.join(big, `set-${String(Math.floor(index / 50)).padStart(3, "0")}`);
    await mkdir(dir, { recursive: true });
    const header = Buffer.from(`synthetic-${index}`.padEnd(32, "-"));
    await writeFile(path.join(dir, `P${String(index).padStart(6, "0")}.RW2`), Buffer.concat([header, block.subarray(header.length)]));
  }
  for (let index = 0; index < TINY; index++) {
    const dir = path.join(small, `day-${String(Math.floor(index / 500)).padStart(3, "0")}`);
    if (index % 500 === 0) await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `IMG_${String(index).padStart(6, "0")}.JPG`), `synthetic small ${index}`);
  }
  return { big, small };
}

async function indexOnly(roots) {
  const fs = createNodeRootFileSystem(new Map(roots.map((root) => [root.id, root.folder])));
  const store = new MemoryIndexStore();
  const indexer = createIndexer({ fs, roots: roots.map(({ id }) => ({ id })), store, hasher: nodeHasher, installSalt: async () => "synthetic-bench-salt", clock: realClock });
  const scanStarted = performance.now();
  await indexer.beginScan(signal);
  while (!(await indexer.scanStep(signal, 1000)).complete);
  const scanMs = performance.now() - scanStarted;
  const hashStarted = performance.now();
  const hashed = await indexer.hashStep(signal, { maxBytes: Number.MAX_SAFE_INTEGER, maxFiles: Number.MAX_SAFE_INTEGER });
  const hashMs = performance.now() - hashStarted;
  const readBefore = fs.bytesRead();
  const rescanStarted = performance.now();
  await indexer.beginScan(signal);
  while (!(await indexer.scanStep(signal, 1000)).complete);
  const rescan = await indexer.hashStep(signal, { maxBytes: Number.MAX_SAFE_INTEGER, maxFiles: Number.MAX_SAFE_INTEGER });
  return {
    entries: store.all().length,
    scanMs,
    hashMs,
    hashedFiles: hashed.files,
    hashedBytes: hashed.bytes,
    rescanMs: performance.now() - rescanStarted,
    rescanBytesRead: fs.bytesRead() - readBefore,
    rescanHashedFiles: rescan.files,
  };
}

/** Full connector against the synthetic NIHO: everything that leaves the Mac is counted. */
async function endToEnd(root) {
  const niho = new FakeNiho();
  const fs = createNodeRootFileSystem(new Map([[root.id, root.folder]]));
  const previewBytes = randomBytes(PREVIEW);
  const executor = {
    renderer: null,
    async run({ original }) {
      // A real decoder reads the original; the synthetic one reads the first chunk and returns a fixed-size preview.
      for await (const chunk of original.read(signal)) { void chunk; break; }
      const bytes = new Uint8Array(previewBytes);
      return { request: { kind: "preview", sizeBytes: bytes.byteLength, sha256: await sha256Bytes(bytes), contentType: "image/jpeg", width: 1280, height: 853 }, bytes };
    },
  };
  const vault = new MemoryVault();
  const index = new MemoryIndexStore();
  const connector = createHostedConnector({
    vault, transport: niho.transport, fs, roots: [{ id: root.id }], index, replica: new MemoryReplicaStore(), hasher: nodeHasher,
    power: new MemoryPower(), uploader: niho.uploader, executors: { preview: executor }, clock: new ManualClock(),
    budget: { maxDirectories: 1000, maxHashBytes: Number.MAX_SAFE_INTEGER, maxHashFiles: Number.MAX_SAFE_INTEGER, maxJobs: 1000 },
  });
  const { userCode } = await connector.pair("Synthetic bench Mac", signal);
  niho.approve(userCode, OWNER, { kind: "newLibrary" });
  await connector.poll(signal);
  const started = performance.now();
  for (let round = 0; round < 5; round++) await connector.tick(signal);
  for (const entry of index.all()) niho.enqueue("preview", entry.photoId);
  for (let round = 0; round < 5; round++) await connector.tick(signal);
  const requestBytes = niho.requests.reduce((sum, request) => sum + JSON.stringify(request.body).length, 0);
  const uploadBytes = [...niho.uploads.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
  return {
    ms: performance.now() - started,
    photos: index.all().length,
    previews: niho.committedOutputs.size,
    uploadBytes,
    requestBytes,
    largestUpload: Math.max(0, ...[...niho.uploads.values()].map((bytes) => bytes.byteLength)),
  };
}

const base = await mkdtemp(path.join(tmpdir(), "niho-connector-bench-"));
try {
  const generatedStarted = performance.now();
  const { big, small } = await generate(base);
  const generateMs = performance.now() - generatedStarted;
  const originalsBytes = FILES * SIZE + TINY * 20;
  const local = await indexOnly([{ id: "originals", folder: big }, { id: "catalog", folder: small }]);
  const e2e = await endToEnd({ id: "originals", folder: big });
  const filesPerSecond = local.entries / (local.scanMs / 1000);
  const hashBytesPerSecond = local.hashedBytes / (local.hashMs / 1000);
  const filesAt1TiB = Math.round(TIB / AVERAGE);
  const result = {
    synthetic: { files: FILES, sizeBytes: SIZE, tinyFiles: TINY, originalsBytes, generateSeconds: seconds(generateMs) },
    scan: { entries: local.entries, seconds: seconds(local.scanMs), filesPerSecond: Math.round(filesPerSecond) },
    hash: { files: local.hashedFiles, bytes: local.hashedBytes, seconds: seconds(local.hashMs), mibPerSecond: Math.round(hashBytesPerSecond / 1024 ** 2) },
    rescanUnchanged: { seconds: seconds(local.rescanMs), bytesRead: local.rescanBytesRead, hashedFiles: local.rescanHashedFiles },
    sentToNiho: {
      photos: e2e.photos, previews: e2e.previews, uploadBytes: e2e.uploadBytes, requestBytes: e2e.requestBytes,
      largestUploadBytes: e2e.largestUpload, originalBytesSent: 0, uploadToOriginalRatio: Number((e2e.uploadBytes / (FILES * SIZE)).toFixed(5)),
    },
    extrapolated1TiB: {
      averageFileBytes: AVERAGE,
      files: filesAt1TiB,
      metadataScanMinutes: Number((filesAt1TiB / filesPerSecond / 60).toFixed(2)),
      hashHoursAtMeasuredRate: Number((TIB / hashBytesPerSecond / 3600).toFixed(2)),
      hashHoursAt400MiBps: Number((TIB / (400 * 1024 ** 2) / 3600).toFixed(2)),
      hashHoursAt150MiBps: Number((TIB / (150 * 1024 ** 2) / 3600).toFixed(2)),
      previewUploadGiB: Number(((filesAt1TiB * PREVIEW) / 1024 ** 3).toFixed(2)),
    },
  };
  if (e2e.largestUpload > PREVIEW) throw new Error("an upload larger than a preview left the Mac");
  if (local.rescanBytesRead !== 0) throw new Error("an unchanged rescan read original bytes");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await rm(base, { recursive: true, force: true });
}
