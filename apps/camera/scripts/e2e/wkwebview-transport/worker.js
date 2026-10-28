// Research only (#148 B): Worker から独自の scheme へ、同期の XHR・非同期の fetch で画素の大きさ（1280 の RGBA ≒ 6.5MB）を受け渡す速さ。
const out = {};
const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
const time = (label, runs, run) => {
  const ms = [];
  try {
    for (let i = 0; i < runs; i += 1) {
      const start = performance.now();
      const check = run();
      ms.push(performance.now() - start);
      if (!check) throw new Error("bad response");
    }
    out[label] = { median: Math.round(median(ms) * 10) / 10, max: Math.round(Math.max(...ms) * 10) / 10 };
  } catch (error) {
    out[label] = { error: String(error?.message ?? error) };
  }
};
const syncGet = (bytes) => {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", `nihoprobe://localhost/blob?bytes=${bytes}`, false);
  xhr.responseType = "arraybuffer";
  xhr.send();
  return xhr.status === 200 && xhr.response.byteLength === bytes;
};
const syncPost = (bytes) => {
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "nihoprobe://localhost/echo", false);
  xhr.responseType = "arraybuffer";
  xhr.send(new Uint8Array(bytes));
  return xhr.status === 200 && new DataView(xhr.response).getUint32(0, true) === bytes;
};
time("syncGetSmall", 50, () => syncGet(64));
time("syncGet6.5MB", 20, () => syncGet(1280 * 1280 * 4));
time("syncPost1MB", 10, () => syncPost(1 << 20));
time("syncPost40MB", 3, () => syncPost(40 << 20));
const asyncTimes = [];
(async () => {
  try {
    for (let i = 0; i < 20; i += 1) {
      const start = performance.now();
      const response = await fetch(`nihoprobe://localhost/blob?bytes=${1280 * 1280 * 4}`);
      const buffer = await response.arrayBuffer();
      asyncTimes.push(performance.now() - start);
      if (buffer.byteLength !== 1280 * 1280 * 4) throw new Error("bad response");
    }
    out["asyncFetch6.5MB"] = { median: Math.round(median(asyncTimes) * 10) / 10 };
  } catch (error) {
    out["asyncFetch6.5MB"] = { error: String(error?.message ?? error) };
  }
  self.postMessage(out);
})();
