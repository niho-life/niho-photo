import { describe, expect, it, vi } from "vitest";

import {
  createDevelopAnalysisWorkerHandler,
  type DevelopAnalysisHelperRequest,
  type DevelopAnalysisHelperResponse,
} from "./develop-engine-analysis-worker-core";
import { DEVELOP_ENGINE_CRATE_VERSION, DEVELOP_ENGINE_VERSION, developEngineManifestPath } from "./develop-engine-manifest";

/**
 * 補助の worker の中身（#155）: 描画の worker と同じ manifest・glue で wasm を起こし、渡された作業コピーを開いて、設定ごとに
 * `Developer.exportAnalysis` の bytes を返す（transfer）。起こせない・開けない・作れない・版が違うときは error。
 */

const MANIFEST_URL = `https://photo.example.test${developEngineManifestPath()}`;
const MANIFEST = {
  engine: DEVELOP_ENGINE_VERSION,
  version: DEVELOP_ENGINE_CRATE_VERSION,
  files: {
    [`niho_develop_wasm_bg-${DEVELOP_ENGINE_CRATE_VERSION}.wasm`]: { sha256: "c1", bytes: 1 },
    [`niho_develop_wasm-${DEVELOP_ENGINE_CRATE_VERSION}.js`]: { sha256: "08", bytes: 1 },
  },
};
const VERSION = "0.26.0+test";
const META = '{"kind":"raw"}';

function analysisModule(options: { exportAnalysis?: boolean; result?: (settingsJson: string) => unknown } = {}) {
  const opened: { png: number[]; metaJson: string }[] = [];
  const exported: string[] = [];
  class Developer {
    static openWorkingCopy(png: Uint8Array, metaJson: string) {
      opened.push({ png: [...png], metaJson });
      return new Developer();
    }
  }
  if (options.exportAnalysis !== false) {
    Object.assign(Developer.prototype, {
      exportAnalysis(settingsJson: string) {
        exported.push(settingsJson);
        if (options.result) return options.result(settingsJson);
        return new Uint8Array([1, 2, settingsJson.length]);
      },
    });
  }
  const module = { default: vi.fn(async () => ({})), version: () => VERSION, Developer };
  return { module, opened, exported };
}

function setup(glue = analysisModule()) {
  const posted: { message: DevelopAnalysisHelperResponse; transfer: Transferable[] | undefined }[] = [];
  const fetch = vi.fn(async () => new Response(JSON.stringify(MANIFEST), { status: 200 }));
  const importModule = vi.fn(async () => glue.module);
  const handler = createDevelopAnalysisWorkerHandler({ fetch, importModule, post: (message, transfer) => posted.push({ message, transfer }) });
  return { handler, posted, glue, fetch, importModule };
}

const start = (version = VERSION): DevelopAnalysisHelperRequest => ({
  type: "start",
  manifestUrl: MANIFEST_URL,
  version,
  png: new Uint8Array([5, 6]).buffer,
  metaJson: META,
});

describe("先回りの解析を作る補助の worker（#155）", () => {
  it("同じ manifest の glue で作業コピーを開き、設定ごとに解析の bytes を返す（transfer）", async () => {
    const { handler, posted, glue, fetch, importModule } = setup();
    await handler(start());
    await handler({ type: "analysis", id: 1, settingsJson: "{}" });
    await handler({ type: "analysis", id: 2, settingsJson: '{"colorNoiseReduction":25}' });

    expect(fetch).toHaveBeenCalledWith(MANIFEST_URL, { cache: "no-cache" });
    expect(importModule).toHaveBeenCalledWith(new URL(`niho_develop_wasm-${DEVELOP_ENGINE_CRATE_VERSION}.js`, MANIFEST_URL).href);
    expect(glue.module.default).toHaveBeenCalledWith({
      module_or_path: new URL(`niho_develop_wasm_bg-${DEVELOP_ENGINE_CRATE_VERSION}.wasm`, MANIFEST_URL).href,
    });
    // 写真は 1 回だけ開く
    expect(glue.opened).toEqual([{ png: [5, 6], metaJson: META }]);
    expect(glue.exported).toEqual(["{}", '{"colorNoiseReduction":25}']);
    expect(posted.map((entry) => entry.message.type)).toEqual(["analysis", "analysis"]);
    const [first] = posted;
    const bytes = first?.message.type === "analysis" ? first.message.bytes : null;
    expect(first?.message.id).toBe(1);
    expect([...new Uint8Array(bytes ?? new ArrayBuffer(0))]).toEqual([1, 2, 2]);
    expect(first?.transfer).toEqual([bytes]);
  });

  it("作るものが無い（undefined）なら null を返す", async () => {
    const { handler, posted } = setup(analysisModule({ result: () => undefined }));
    await handler(start());
    await handler({ type: "analysis", id: 3, settingsJson: "{}" });
    expect(posted).toEqual([{ message: { type: "analysis", id: 3, bytes: null }, transfer: undefined }]);
  });

  it("口の無い glue・版の違う glue・開く前の要求は error。作れなかった後も次の要求は処理する", async () => {
    const missing = setup(analysisModule({ exportAnalysis: false }));
    await missing.handler(start());
    await missing.handler({ type: "analysis", id: 1, settingsJson: "{}" });
    expect(missing.posted[0]?.message).toMatchObject({ type: "error", id: 1 });

    const other = setup();
    await other.handler(start("0.25.0"));
    await other.handler({ type: "analysis", id: 2, settingsJson: "{}" });
    expect(other.posted[0]?.message).toMatchObject({ type: "error", id: 2 });
    expect(other.glue.opened).toEqual([]);

    const early = setup();
    await early.handler({ type: "analysis", id: 3, settingsJson: "{}" });
    expect(early.posted[0]?.message).toMatchObject({ type: "error", id: 3, message: "no photo is open" });

    let calls = 0;
    const throwing = setup(
      analysisModule({
        result: () => {
          calls += 1;
          if (calls === 1) throw new Error("niho4_prepare_failed: H/S response");
          return new Uint8Array([4]);
        },
      }),
    );
    await throwing.handler(start());
    await throwing.handler({ type: "analysis", id: 4, settingsJson: "{}" });
    await throwing.handler({ type: "analysis", id: 5, settingsJson: "{}" });
    expect(throwing.posted.map((entry) => entry.message)).toMatchObject([
      { type: "error", id: 4, message: "niho4_prepare_failed: H/S response" },
      { type: "analysis", id: 5 },
    ]);
  });
});
