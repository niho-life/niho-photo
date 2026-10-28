// Research only (#148 の 0): COOP / COEP を足した Mac アプリの画面で、crossOriginIsolated が立つかを見る E2E の script
// （src/e2e.rs が main 窓の読み込みの後に 1 回流す）。__PROBE_CONFIG__ は cross-origin-isolation.sh が埋める。
(async () => {
  const config = __PROBE_CONFIG__;
  const report = (value) => {
    location.href = `https://niho-e2e.invalid/report?data=${encodeURIComponent(JSON.stringify(value))}`;
  };
  const describe = (error) => String(error?.message ?? error);
  const result = {
    page: {
      crossOriginIsolated: self.crossOriginIsolated,
      isSecureContext: self.isSecureContext,
      sharedArrayBuffer: typeof SharedArrayBuffer,
      protocol: location.protocol,
      cores: navigator.hardwareConcurrency,
      userAgent: navigator.userAgent,
    },
  };
  const ask = (worker, message, done, timeout = 15000) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ error: "timeout" }), timeout);
      worker.onmessage = (event) => {
        if (!done(event.data)) return;
        clearTimeout(timer);
        resolve(event.data);
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        resolve({ error: event.message || "worker error" });
      };
      worker.postMessage(message);
    });
  const probeUrl = new URL("/coi-probe-worker.js", location.href).href;
  // 画面の文書と Worker の script の応答に COOP / COEP が付いているか（Tauri の app.security.headers が届いているか）
  for (const [key, url] of [["documentHeaders", location.href], ["workerScriptHeaders", probeUrl]]) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      result[key] = Object.fromEntries(
        ["cross-origin-opener-policy", "cross-origin-embedder-policy", "content-type"].map((name) => [name, response.headers.get(name)]),
      );
    } catch (error) {
      result[key] = { error: describe(error) };
    }
  }
  try {
    const worker = new Worker(probeUrl, { type: "module" });
    result.urlWorker = await ask(worker, { role: "probe", nestedUrl: probeUrl }, () => true);
    worker.terminate();
  } catch (error) {
    result.urlWorker = { error: describe(error) };
  }
  try {
    const source = await (await fetch(probeUrl)).text();
    const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(blobUrl, { type: "module" });
    result.blobWorker = await ask(worker, { role: "probe", nestedUrl: probeUrl }, () => true);
    worker.terminate();
  } catch (error) {
    result.blobWorker = { error: describe(error) };
  }
  // 今の現像の Worker（同梱の bundle の script）が COEP の下でも glue と wasm を読めるか
  try {
    let workerPath = null;
    for (const script of document.querySelectorAll('script[type="module"][src]')) {
      const text = await (await fetch(script.src)).text();
      const match = /assets\/develop-engine\.worker-[A-Za-z0-9_-]+\.js/.exec(text);
      if (match) {
        workerPath = match[0];
        break;
      }
    }
    if (!workerPath) throw new Error("develop engine worker not found in the bundle");
    const worker = new Worker(new URL(`/${workerPath}`, location.href), { type: "module" });
    const started = performance.now();
    const reply = await ask(
      worker,
      { type: "init", id: 1, manifestUrl: new URL(config.manifestPath, location.href).href },
      (message) => message?.id === 1,
      30000,
    );
    result.developEngineWorker = { type: reply.type, reason: reply.reason, version: reply.version, error: reply.error, ms: Math.round(performance.now() - started) };
    worker.terminate();
  } catch (error) {
    result.developEngineWorker = { error: describe(error) };
  }
  report(result);
})();
