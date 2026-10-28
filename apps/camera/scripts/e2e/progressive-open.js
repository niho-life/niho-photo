(async () => {
  const config = __BENCH_CONFIG__;
  const events = [];
  const originalInfo = console.info.bind(console);
  console.info = (...args) => {
    if (args[0] === "[photo-develop-ui-perf]" && args[1] && typeof args[1] === "object") {
      events.push({ at: performance.now(), ...args[1] });
    }
    originalInfo(...args);
  };
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (read, timeout = 20000) => {
    const started = performance.now();
    while (performance.now() - started < timeout) {
      const value = read();
      if (value) return value;
      await delay(10);
    }
    throw new Error("timeout");
  };
  const labelOf = (element) => {
    const direct = element.getAttribute("aria-label");
    if (direct) return direct;
    const ids = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/u);
    return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
  };
  const afterPaint = async () => {
    let timer;
    await Promise.race([
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("paint-not-presented")), 5000); }),
    ]).finally(() => clearTimeout(timer));
  };
  const exposure = () => [...document.querySelectorAll('input[type="range"]')]
    .find((element) => /露光/u.test(labelOf(element)) && !element.disabled);
  const presetButtons = () => {
    const group = [...document.querySelectorAll('[role="group"]')].find((element) => /プリセット/u.test(labelOf(element)));
    return group ? [...group.querySelectorAll('li > button')].filter((element) => !element.disabled) : [];
  };
  const presetEntry = () => document.querySelector('button[aria-label="プリセットの一覧"]:not([disabled])');
  const showPresets = async () => {
    if (presetButtons().length > 1) return;
    const entry = await waitFor(presetEntry);
    entry.click();
    await waitFor(() => presetButtons().length > 1);
  };
  const showAdjustments = async () => {
    const entry = document.querySelector('nav[aria-label="道具"] button[aria-label="補正"]:not([disabled])');
    if (!entry || entry.getAttribute("aria-pressed") === "true") return;
    entry.click();
    await waitFor(exposure);
  };
  const mainCanvas = () => [...document.querySelectorAll("canvas")]
    .filter((canvas) => canvas.width >= 512 && canvas.height >= 256 && canvas.getBoundingClientRect().width > 0)
    .sort((left, right) => right.width * right.height - left.width * left.height)[0];
  const signature = () => {
    const canvas = mainCanvas();
    if (!canvas) return null;
    const context = canvas.getContext("2d");
    let hash = 2166136261;
    let alpha = 0;
    for (const [nx, ny] of [[0.2, 0.2], [0.5, 0.5], [0.8, 0.8]]) {
      const pixels = context.getImageData(Math.floor(canvas.width * nx), Math.floor(canvas.height * ny), 32, 32).data;
      for (let i = 0; i < pixels.length; i++) {
        hash = Math.imul(hash ^ pixels[i], 16777619) >>> 0;
        if (i % 4 === 3) alpha += pixels[i];
      }
    }
    return alpha > 0 ? hash : null;
  };
  const sliderValues = () => [...document.querySelectorAll('input[type="range"]')]
    .filter((element) => !element.disabled)
    .map((element) => [labelOf(element), element.value]);
  const report = (value) => { location.href = `https://niho-e2e.invalid/report?data=${encodeURIComponent(JSON.stringify(value))}`; };
  let stage = "boot";
  const observations = {};
  setInterval(() => { location.href = `https://niho-e2e.invalid/trace?step=${encodeURIComponent(stage)}`; }, 2000);
  try {
    history.replaceState(null, "", "?photoDevelopPerf=1");
    localStorage.clear();
    stage = "add-folder";
    const addMenu = await waitFor(() => [...document.querySelectorAll("button")].find((element) => element.textContent.trim() === "フォルダや写真を追加" && !element.disabled));
    addMenu.click();
    const add = await waitFor(() => [...document.querySelectorAll('button, [role="menuitem"]') ]
      .find((element) => element.textContent.trim() === (config.addPhotos ? "写真を選ぶ" : "フォルダを追加") && !element.disabled));
    add.click();
    stage = "grid";
    const findTile = () => [...document.querySelectorAll("button[title]")]
      .find((element) => element.title === config.fileName && !element.disabled);
    let tile = await waitFor(findTile);
    await delay(3000);
    if (config.mode === "warm") {
      // 再表示は同じアプリ・同じsessionで測る。アプリを再起動してnative cacheだけ残す条件とは分ける。
      stage = "warm-prime";
      tile.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      await waitFor(() => exposure() && (events.some((event) => event.stage === "canonicalReady") ||
        (!events.some((event) => event.stage === "proxyReady") && events.some((event) => event.stage === "finalVisible"))), 30000);
      const grid = await waitFor(() => document.querySelector('button[aria-label="一覧"]:not([disabled])'));
      grid.click();
      await waitFor(() => grid.getAttribute("aria-pressed") === "true" && findTile());
      await delay(100);
      // 一覧で間を置いてから戻る条件（#129。静かな間に H/S の解析を先に作る。既定 0 は今までと同じ）
      if (Number.isInteger(config.idleMs) && config.idleMs > 0) await delay(config.idleMs);
      tile = await waitFor(findTile);
      events.length = 0;
    }
    stage = "open";
    const nativeMeasurementStartedMs = Date.now();
    const t0 = performance.now();
    tile.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await waitFor(() => exposure() && (presetButtons().length > 1 || presetEntry()) && signature() !== null);
    const initial = signature();
    const slider = exposure();
    const valueBefore = slider.value;
    stage = "exposure-state";
    const inputAt = performance.now();
    slider.focus();
    slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true }));
    await waitFor(() => exposure()?.value !== valueBefore, 3000);
    const acceptedMs = performance.now() - inputAt;
    stage = "exposure-paint";
    await waitFor(() => signature() !== null && signature() !== initial, 30000);
    await afterPaint();
    const exposurePaintMs = performance.now() - inputAt;
    const exposureAt = performance.now();
    let presetAt = null;
    let presetPaintMs = null;
    stage = "preset-paint";
    await showPresets();
    const presetReadyAt = performance.now();
    for (const button of presetButtons().slice(1, 4)) {
      const before = signature();
      const presetInputAt = performance.now();
      button.click();
      await waitFor(() => button.getAttribute("aria-current") === "true", 3000);
      try {
        await waitFor(() => signature() !== null && signature() !== before, 30000);
        await afterPaint();
        presetAt = performance.now();
        presetPaintMs = presetAt - presetInputAt;
        break;
      } catch (error) {
        if (error instanceof Error && error.message === "paint-not-presented") throw error;
      }
    }
    if (presetAt === null) throw new Error("preset-frame-missing");
    observations.timeToEditableMs = Math.max(exposureAt, presetReadyAt) - t0;
    observations.inputAcceptedMs = acceptedMs;
    observations.exposurePaintMs = exposurePaintMs;
    const chosenPreset = presetButtons().find((button, index) => index > 0 && button.getAttribute("aria-current") === "true")?.textContent;
    await showAdjustments();
    const values = sliderValues();
    stage = "canonical";
    await waitFor(() => events.some((event) => event.stage === "canonicalReady") ||
      (!events.some((event) => event.stage === "proxyReady") && events.some((event) => event.stage === "finalVisible")), 30000);
    await delay(100);
    const retained = JSON.stringify(values) === JSON.stringify(sliderValues());
    if (!retained) throw new Error("settings-changed-on-handoff");
    await showPresets();
    const selected = presetButtons().some((button, index) => index > 0 && button.getAttribute("aria-current") === "true" && button.textContent === chosenPreset);
    if (!selected) throw new Error("preset-selection-lost");
    report({ ok: true, case: config.label, mode: config.mode, iteration: config.iteration,
      timeToEditableMs: Math.max(exposureAt, presetReadyAt) - t0,
      inputAcceptedMs: acceptedMs, exposurePaintMs, presetPaintMs,
      proxyReadyMs: events.find((event) => event.stage === "proxyReady")?.elapsedMs ?? null,
      canonicalReadyMs: events.find((event) => event.stage === "canonicalReady")?.elapsedMs ??
        (!events.some((event) => event.stage === "proxyReady") ? events.find((event) => event.stage === "finalVisible")?.elapsedMs ?? null : null),
      settingsRetained: retained, presetRetained: selected, nativeMeasurementStartedMs });
  } catch (error) {
    report({ ok: false, case: config.label, mode: config.mode, iteration: config.iteration, stage,
      ...observations, reason: error instanceof Error && ["timeout", "preset-frame-missing", "settings-changed-on-handoff", "preset-selection-lost", "paint-not-presented"].includes(error.message) ? error.message : "ui-probe-failed", uiEventStages: events.map((event) => event.stage) });
  }
})();
