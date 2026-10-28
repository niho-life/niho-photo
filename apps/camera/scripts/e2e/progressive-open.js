(async () => {
  const config = __BENCH_CONFIG__;
  const events = [];
  // 段2の区間（Worker の処理時間と、メインスレッドから見た描画の枠の待ち・往復）。届いた時刻を区間の終わりとして持つ
  const perf = [];
  const originalInfo = console.info.bind(console);
  console.info = (...args) => {
    if (args[0] === "[photo-develop-ui-perf]" && args[1] && typeof args[1] === "object") {
      events.push({ at: performance.now(), ...args[1] });
    } else if (args[0] === "[photo-develop-perf]" && args[1] && typeof args[1] === "object") {
      perf.push({ at: performance.now(), ...args[1] });
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
  const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const median = (values) => {
    const sorted = values.filter(finite).sort((a, b) => a - b);
    return sorted.length === 0 ? null : sorted[Math.floor((sorted.length - 1) / 2)];
  };
  // プリセットを押してから変わった画が出るまで（from〜to）の内訳。Worker の区間は届いた時刻 − 処理時間から届いた時刻まで
  const presetBreakdown = (from, to) => {
    const overlap = (stages) => perf
      .filter((record) => stages.includes(record.stage) && finite(record.durationMs))
      .reduce((sum, record) => sum + Math.max(0, Math.min(to, record.at) - Math.max(from, record.at - record.durationMs)), 0);
    const inWindow = (record) => record.at >= from && record.at <= to;
    const request = perf.filter((record) => inWindow(record) && record.stage === "renderRequest" &&
      (record.priority === "final" || record.priority === "drag") && record.status === "ok").at(-1);
    const rendered = perf.filter((record) => inWindow(record) && (record.stage === "renderFinal" || record.stage === "renderInteractive") &&
      finite(record.durationMs) && (!request || record.at <= request.at)).at(-1);
    const resolved = events.find((event) => event.stage === "presetResolved" && event.at >= from && event.at <= to);
    const thumbnail = median(perf.filter((record) => record.stage === "presetThumbnail").map((record) => record.durationMs));
    const result = {
      presetResolve: resolved?.durationMs,
      presetRenderQueue: request?.queuedMs,
      presetWorkerWait: request && rendered ? Math.max(0, request.roundTripMs - rendered.durationMs) : undefined,
      presetRender: rendered?.durationMs,
      presetThumbnailBlocked: overlap(["presetThumbnail"]),
      presetThumbnailSession: overlap(["thumbnailSession"]),
      presetDeveloperRebuild: overlap(["open", "openWorkingCopy"]),
      presetThumbnail: thumbnail ?? undefined,
    };
    return Object.fromEntries(Object.entries(result).filter(([, value]) => finite(value)));
  };
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
      perf.length = 0;
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
    let presetInputStartedAt = null;
    stage = "preset-paint";
    await showPresets();
    const presetReadyAt = performance.now();
    for (const button of presetButtons().slice(1, 4)) {
      const before = signature();
      const presetInputAt = performance.now();
      presetInputStartedAt = presetInputAt;
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
    // 丁寧な画に差し替わるまで（先に粗い画を出す #127。粗い画が無ければ最初の変化と同じ）。測れなくても probe は止めない
    let presetFinalPaintMs = null;
    try {
      const finalVisible = await waitFor(() => events.find((event) => event.stage === "finalRenderVisible" && event.at >= presetInputStartedAt), 30000);
      presetFinalPaintMs = finalVisible.at - presetInputStartedAt;
    } catch {
      presetFinalPaintMs = null;
    }
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
      presetBreakdownMs: presetBreakdown(presetInputStartedAt, presetAt), presetFinalPaintMs,
      proxyReadyMs: events.find((event) => event.stage === "proxyReady")?.elapsedMs ?? null,
      canonicalReadyMs: events.find((event) => event.stage === "canonicalReady")?.elapsedMs ??
        (!events.some((event) => event.stage === "proxyReady") ? events.find((event) => event.stage === "finalVisible")?.elapsedMs ?? null : null),
      settingsRetained: retained, presetRetained: selected, nativeMeasurementStartedMs });
  } catch (error) {
    report({ ok: false, case: config.label, mode: config.mode, iteration: config.iteration, stage,
      ...observations, reason: error instanceof Error && ["timeout", "preset-frame-missing", "settings-changed-on-handoff", "preset-selection-lost", "paint-not-presented"].includes(error.message) ? error.message : "ui-probe-failed", uiEventStages: events.map((event) => event.stage) });
  }
})();
