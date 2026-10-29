// #152 の E2E（native-develop.sh）: Mac アプリの画面（src/e2e.rs が main 窓の読み込みの後に 1 回流す）から probe の Worker を起こし、
// native の sidecar と同梱の wasm で同じ写真を描いた結果（画素の一致・時間）を報告する。__PROBE_CONFIG__ は native-develop.sh が埋める。
(async () => {
  const config = __PROBE_CONFIG__;
  const report = (value) => {
    location.href = `https://niho-e2e.invalid/report?data=${encodeURIComponent(JSON.stringify(value))}`;
  };
  const result = { page: { protocol: location.protocol, cores: navigator.hardwareConcurrency } };
  try {
    const manifestUrl = new URL(config.manifestPath, location.href).href;
    const manifest = await (await fetch(manifestUrl, { cache: "no-store" })).json();
    const pick = (pattern) => new URL(Object.keys(manifest.files).find((name) => pattern.test(name)), manifestUrl).href;
    const worker = new Worker(new URL("/native-develop-probe-worker.js", location.href), { type: "module" });
    result.worker = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ error: "timeout" }), 300000);
      worker.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data);
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        resolve({ error: event.message || "worker error" });
      };
      worker.postMessage({ jsUrl: pick(/\.js$/u), wasmUrl: pick(/\.wasm$/u), engine: config.engine, runs: config.runs });
    });
    worker.terminate();
  } catch (error) {
    result.error = String(error?.message ?? error);
  }
  report(result);
})();
