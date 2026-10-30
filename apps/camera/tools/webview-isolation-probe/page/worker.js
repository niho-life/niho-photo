// Research only (#173): classic / module / blob: のどの Worker でも動く形。Worker の中の分離と共有メモリ、
// niho-develop: と同じ同期の XHR、入れ子の Worker へ共有メモリを渡して Atomics.wait / notify が通るか
// （wasm-bindgen-rayon の pool と同じ形）を返す。
"use strict";

function describe(scope) {
  const out = {
    href: scope.location.href,
    origin: scope.origin,
    isSecureContext: scope.isSecureContext,
    crossOriginIsolated: scope.crossOriginIsolated,
    sharedArrayBuffer: typeof scope.SharedArrayBuffer,
  };
  try {
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

function syncXhr(url) {
  try {
    const request = new XMLHttpRequest();
    request.open("POST", url, false);
    request.setRequestHeader("x-probe-client", "probe");
    request.send("ping");
    return { status: request.status, body: request.responseText };
  } catch (error) {
    return { error: String(error) };
  }
}

async function nestedAtomics() {
  let buffer;
  try {
    buffer = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true })
      .buffer;
  } catch (error) {
    return { error: `shared memory: ${error}` };
  }
  const source =
    "self.onmessage = (event) => { const view = new Int32Array(event.data); Atomics.store(view, 0, 1); Atomics.notify(view, 0); };" +
    " self.postMessage('ready');";
  let nested;
  try {
    nested = new Worker(
      URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
    );
    // pool と同じく、入れ子の Worker が起きてから止まって待つ（起動前に Atomics.wait で塞がない）
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5000);
      nested.onmessage = () => {
        clearTimeout(timer);
        resolve();
      };
      nested.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(event.message || "error"));
      };
    });
  } catch (error) {
    nested?.terminate();
    return { error: `nested worker: ${error}` };
  }
  try {
    nested.postMessage(buffer);
  } catch (error) {
    nested.terminate();
    return { error: `postMessage: ${error}` };
  }
  const view = new Int32Array(buffer);
  let wait;
  try {
    wait = Atomics.wait(view, 0, 0, 5000);
  } catch (error) {
    wait = `error: ${error}`;
  }
  nested.terminate();
  return { wait, value: Atomics.load(view, 0) };
}

self.onmessage = async (event) => {
  const out = describe(self);
  out.syncXhr = syncXhr(event.data.developUrl);
  out.nestedAtomics = await nestedAtomics();
  self.postMessage(out);
};
