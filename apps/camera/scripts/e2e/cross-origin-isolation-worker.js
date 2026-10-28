// Research only (#148 の 0): Worker の中で、wasm のスレッド（wasm-bindgen-rayon）が使う形が通るかを見る。
// - role "probe": crossOriginIsolated・共有の WebAssembly.Memory（上限 4GB）・atomics の命令を持つ wasm・入れ子の Worker へ
//   共有メモリを渡して Atomics.wait / notify
// - role "nested": 入れ子の側（起きたことを返し、親が notify するまで Atomics.wait で待ち、印を書いて返す）
// atomics.notify を 1 つ持つ wasm（共有メモリ 1 page を import）
const ATOMICS_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
  0x02, 0x10, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x03, 0x01, 0x01,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x0a, 0x01, 0x06, 0x6e, 0x6f, 0x74, 0x69, 0x66, 0x79, 0x00, 0x00,
  0x0a, 0x0c, 0x01, 0x0a, 0x00, 0x41, 0x00, 0x41, 0x01, 0xfe, 0x00, 0x02, 0x00, 0x0b,
]);

const describe = (error) => String(error?.message ?? error);

// wasm-bindgen-rayon と同じく、入れ子の Worker が起きたのを message で待ってから共有メモリで待ち合わせる
// （起動の前に親が Atomics.wait で止まると、入れ子の script を読めない）
async function nestedCheck(url) {
  const out = {};
  let nested;
  try {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const view = new Int32Array(memory.buffer);
    nested = new Worker(url, { type: "module" });
    const replies = [];
    const waiters = [];
    const next = () =>
      new Promise((resolve, reject) => {
        if (replies.length > 0) resolve(replies.shift());
        else waiters.push({ resolve, reject });
      });
    nested.onmessage = (event) => (waiters.length > 0 ? waiters.shift().resolve(event.data) : replies.push(event.data));
    nested.onerror = (event) => {
      const error = new Error(`nested error: ${event.message ?? ""}`);
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    };
    const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error("nested timeout")), ms));
    nested.postMessage({ role: "nested", buffer: memory.buffer });
    out.ready = await Promise.race([next(), timeout(8000)]);
    out.parentWait = Atomics.wait(view, 3, 0, 10);
    Atomics.store(view, 0, 1);
    Atomics.notify(view, 0);
    out.done = await Promise.race([next(), timeout(8000)]);
    out.value = Atomics.load(view, 2);
  } catch (error) {
    out.error = describe(error);
  }
  nested?.terminate();
  return out;
}

async function probe(nestedUrl) {
  const out = {
    crossOriginIsolated: self.crossOriginIsolated,
    isSecureContext: self.isSecureContext,
    sharedArrayBuffer: typeof SharedArrayBuffer,
    protocol: self.location.protocol,
  };
  try {
    const big = new WebAssembly.Memory({ initial: 17, maximum: 65536, shared: true });
    out.sharedMemory4GB = big.buffer instanceof SharedArrayBuffer;
  } catch (error) {
    out.sharedMemory4GBError = describe(error);
  }
  try {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    out.atomicsModuleValid = WebAssembly.validate(ATOMICS_MODULE);
    const { instance } = await WebAssembly.instantiate(ATOMICS_MODULE, { env: { memory } });
    out.atomicsNotify = instance.exports.notify();
  } catch (error) {
    out.atomicsModuleError = describe(error);
  }
  out.nestedUrl = await nestedCheck(nestedUrl);
  try {
    const source = await (await fetch(nestedUrl)).text();
    out.nestedBlob = await nestedCheck(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
  } catch (error) {
    out.nestedBlob = { error: describe(error) };
  }
  return out;
}

self.onmessage = async (event) => {
  const { role } = event.data ?? {};
  if (role === "nested") {
    const view = new Int32Array(event.data.buffer);
    self.postMessage({ ready: true, crossOriginIsolated: self.crossOriginIsolated });
    const wait = Atomics.wait(view, 0, 0, 5000);
    Atomics.store(view, 2, 42);
    self.postMessage({ wait });
    return;
  }
  try {
    self.postMessage(await probe(event.data.nestedUrl));
  } catch (error) {
    self.postMessage({ error: describe(error) });
  }
};
