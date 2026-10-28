// Research only (#130): the editor's Final 1280 steps in a Web Worker (as the
// app's develop engine worker), single threaded or with wasm threads.
const params = new URL(self.location.href).searchParams;
const pkg = params.get("pkg");
const threads = Number(params.get("threads") ?? "0");
const steps = [];
try {
  const glue = await import(`./${pkg}/niho_develop_wasm.js`);
  let t = performance.now();
  const wasm = await glue.default({ module_or_path: `./${pkg}/niho_develop_wasm_bg.wasm` });
  if (threads > 0) await glue.initThreadPool(threads);
  steps.push({ step: "init", ms: performance.now() - t });
  const [png, meta] = await Promise.all([
    fetch("/data/signed.png").then((r) => r.arrayBuffer()),
    fetch("/data/signed.json").then((r) => r.text()),
  ]);
  const hash = async (frame) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", frame.rgba.slice())), (b) => b.toString(16).padStart(2, "0")).join("");
  const record = async (step, ms, frame) =>
    steps.push({ step, ms, memory: wasm.memory.buffer.byteLength, ...(frame && { rgbaSha256: await hash(frame) }) });
  t = performance.now();
  const developer = glue.Developer.openWorkingCopy(new Uint8Array(png), meta);
  await record("open", performance.now() - t);
  const base = { ...JSON.parse(glue.neutralSettings()), engine: "niho-11", look: "niho-standard-5" };
  const asShot = developer.asShotWhite();
  const presets = JSON.parse(glue.builtinPresets());
  const preset = (id, on) =>
    JSON.parse(glue.applyPreset(presets.find((p) => p.id === id).xmp, JSON.stringify(on), 1, asShot)).settings;
  const render = async (step, settings) => {
    const start = performance.now();
    const frame = developer.render(JSON.stringify(settings), 1280, false);
    await record(step, performance.now() - start, frame);
  };
  await render("first", base);
  const exposed = { ...base, exposure: 0.3 };
  await render("exposure", exposed);
  for (const id of ["niho-bluesky2", "niho-pastel", "niho-colorful"]) await render(`preset:${id}`, preset(id, exposed));
  const pastel = preset("niho-pastel", exposed);
  await render("pastelAgain", pastel);
  await render("pastelVibrance", { ...pastel, vibrance: pastel.vibrance + 20 });
  self.postMessage({ steps, threads, crossOriginIsolated: self.crossOriginIsolated, cores: navigator.hardwareConcurrency, ua: navigator.userAgent });
} catch (error) {
  self.postMessage({ error: String(error?.stack ?? error), steps });
}
