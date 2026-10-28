#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const ALLOWED_STAGES = new Set([
  "nativeHash",
  "cacheLookup",
  "cacheStore",
  "info",
  "decode",
  "lens",
  "whiteBalance",
  "color",
  "downsample",
  "encode",
  "nativePreview",
  "proxyReady",
  "canonicalReady",
  "inputAccepted",
  "renderUpdated",
  "presetRenderUpdated",
  // プリセット更新の内訳（#126）
  "presetResolve",
  "presetRenderQueue",
  "presetWorkerWait",
  "presetRender",
  "presetThumbnailBlocked",
  "presetThumbnailSession",
  "presetDeveloperRebuild",
  "presetThumbnail",
  "editable",
]);

function usage() {
  throw new Error(
    "usage: node apps/camera/scripts/measure-progressive-open.mjs " +
      "--case <label>=<input-path> [--case ...] --probe <executable> " +
      "--probe-arg <arg-with-{input|cache|condition|iteration}> [--runs 20]",
  );
}

function parseArguments(argv) {
  const cases = [];
  const probeArgs = [];
  let probe = null;
  let runs = 20;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--case" && value) {
      const separator = value.indexOf("=");
      if (separator <= 0) usage();
      const label = value.slice(0, separator);
      const input = value.slice(separator + 1);
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/u.test(label) || !input) usage();
      cases.push({ label, input });
      index += 1;
    } else if (key === "--probe" && value) {
      probe = value;
      index += 1;
    } else if (key === "--probe-arg" && value) {
      probeArgs.push(value);
      index += 1;
    } else if (key === "--runs" && value && /^[0-9]+$/u.test(value)) {
      runs = Number(value);
      index += 1;
    } else {
      usage();
    }
  }
  if (cases.length === 0 || !probe || runs < 1 || runs > 100) usage();
  return { cases, probe, probeArgs, runs };
}

function substitute(argument, values) {
  return argument.replaceAll(/\{(input|cache|condition|iteration)\}/gu, (_, key) => String(values[key]));
}

function runProbe(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length <= 1024 * 1024) stdout += chunk;
    });
    child.once("error", () => reject(new Error("probe could not be started")));
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error("probe failed"));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("probe returned invalid JSON"));
      }
    });
  });
}

function sanitizeResult(result) {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("probe returned an invalid result");
  }
  const stagesMs = {};
  const source = result.stagesMs;
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new Error("probe omitted stagesMs");
  }
  for (const [stage, elapsed] of Object.entries(source)) {
    if (ALLOWED_STAGES.has(stage) && typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed >= 0) {
      stagesMs[stage] = elapsed;
    }
  }
  return { stagesMs };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(samples) {
  const stages = new Set(samples.flatMap((sample) => Object.keys(sample.stagesMs)));
  return Object.fromEntries(
    [...stages].sort().map((stage) => {
      const values = samples.map((sample) => sample.stagesMs[stage]).filter((value) => value !== undefined);
      return [stage, { count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) }];
    }),
  );
}

const options = parseArguments(process.argv.slice(2));
const root = await mkdtemp(join(tmpdir(), "niho-progressive-open-"));
// UIの実paintを測る間だけ画面を起こしておく。設定は変更せず、親process終了でも解除する。
const awake = process.platform === "darwin"
  ? spawn("/usr/bin/caffeinate", ["-d", "-i", "-u", "-t", "3600", "-w", String(process.pid)], { stdio: "ignore" })
  : null;
awake?.on("error", () => undefined);
const measurements = [];
let completed = false;
try {
  for (const testCase of options.cases) {
    for (const condition of ["cold", "warm"]) {
      const warmCache = join(root, `${testCase.label}-warm`);
      const samples = [];
      for (let iteration = 1; iteration <= options.runs; iteration += 1) {
        // cold はアプリcacheだけを反復ごとに空へ替える。OS file cacheは意図的に落とさない。
        const cache = condition === "cold" ? join(root, `${testCase.label}-cold-${iteration}`) : warmCache;
        const args = options.probeArgs.map((argument) =>
          substitute(argument, { input: testCase.input, cache, condition, iteration }),
        );
        const sample = sanitizeResult(await runProbe(options.probe, args));
        samples.push(sample);
        measurements.push({ label: testCase.label, condition, iteration, ...sample });
      }
      measurements.push({
        label: testCase.label,
        condition,
        runs: options.runs,
        cacheReset: condition === "cold" ? "application-cache-per-run" : "application-cache-retained",
        osFileCache: "retained",
        summary: summarize(samples),
      });
    }
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, measurements }, null, 2)}\n`);
  completed = true;
} finally {
  awake?.kill("SIGTERM");
  if (completed) await rm(root, { recursive: true, force: true });
}
