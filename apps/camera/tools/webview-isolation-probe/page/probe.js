// Research only (#173): この文書と Worker が cross-origin isolated か、共有メモリが使えるか、各資源の応答の header と
// 読み込みの結果を集め、https://probe-report.invalid/?r=<JSON> への遷移で外（Tauri の on_navigation・WKWebView の
// navigation delegate）へ渡す。外は 1 回目の後に ?stage=2 で開き直す。
"use strict";

const DEVELOP_URL = "probe-develop://localhost/hello";

function describe(scope) {
  const out = {
    href: scope.location.href,
    origin: scope.origin,
    isSecureContext: scope.isSecureContext,
    crossOriginIsolated: scope.crossOriginIsolated,
    sharedArrayBuffer: typeof scope.SharedArrayBuffer,
  };
  try {
    // wasm-bindgen-rayon のスレッド版と同じ上限（4GB）の共有メモリ
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 65536,
      shared: true,
    });
    out.sharedMemory = Object.prototype.toString.call(memory.buffer);
  } catch (error) {
    out.sharedMemory = `error: ${error}`;
  }
  return out;
}

async function headersOf(url) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    const pick = (name) => response.headers.get(name);
    return {
      status: response.status,
      contentType: pick("content-type"),
      coop: pick("cross-origin-opener-policy"),
      coep: pick("cross-origin-embedder-policy"),
      corp: pick("cross-origin-resource-policy"),
      csp: pick("content-security-policy") === null ? null : "present",
    };
  } catch (error) {
    return { error: String(error) };
  }
}

function imageLoad(url) {
  return new Promise((resolve) => {
    const image = new Image();
    const timer = setTimeout(() => resolve("timeout"), 5000);
    image.onload = () => {
      clearTimeout(timer);
      resolve("loaded");
    };
    image.onerror = () => {
      clearTimeout(timer);
      resolve("error");
    };
    image.src = url;
  });
}

async function developPost() {
  try {
    const response = await fetch(DEVELOP_URL, {
      method: "POST",
      headers: { "x-probe-client": "probe" },
      body: "ping",
    });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    return { error: String(error) };
  }
}

function workerRun(create) {
  return new Promise((resolve) => {
    let worker;
    const timer = setTimeout(() => {
      worker?.terminate();
      resolve({ error: "timeout" });
    }, 10000);
    try {
      worker = create();
    } catch (error) {
      clearTimeout(timer);
      resolve({ error: String(error) });
      return;
    }
    worker.onmessage = (event) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      resolve({ error: event.message || "worker error" });
    };
    worker.postMessage({ developUrl: DEVELOP_URL });
  });
}

function send(report) {
  location.href = `https://probe-report.invalid/?r=${encodeURIComponent(JSON.stringify(report))}`;
}

(async () => {
  const stage =
    new URLSearchParams(location.search).get("stage") === "2" ? 2 : 1;
  const report = { stage, last: stage === 2 };
  try {
    report.page = {
      ...describe(self),
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
    };
    report.headers = {
      document: await headersOf(location.href),
      script: await headersOf(new URL("probe.js", location.href).href),
      worker: await headersOf(new URL("worker.js", location.href).href),
    };
    report.loads = {
      thumbnailWithCorp: await imageLoad("probe-thumb://localhost/corp.png"),
      thumbnailWithoutCorp: await imageLoad(
        "probe-thumb://localhost/plain.png",
      ),
      developPost: await developPost(),
    };
    const source = await (
      await fetch("worker.js", { cache: "no-store" })
    ).text();
    const blobUrl = () =>
      URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    report.workers = {
      blobClassic: await workerRun(() => new Worker(blobUrl())),
      blobModule: await workerRun(
        () => new Worker(blobUrl(), { type: "module" }),
      ),
      // 現像の Worker（develop-engine.worker.ts）と同じ、同じ origin の URL の module Worker
      urlModule: await workerRun(
        () => new Worker("worker.js", { type: "module" }),
      ),
    };
  } catch (error) {
    report.error = String(error);
  }
  send(report);
})();
