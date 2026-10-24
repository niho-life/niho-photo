import { describe, expect, it } from "vitest";

import {
  BROWSER_PHOTO_EXPORT_SIZE_OPTIONS,
  browserPhotoBatchExportLine,
  browserPhotoExportChoice,
  browserPhotoExportJpegFileName,
  browserPhotoExportPngFileName,
  browserPhotoExportJpegRoute,
  browserPhotoExportLine,
  browserPhotoExportLongEdge,
  defaultBrowserPhotoExportFormat,
  effectiveBrowserPhotoExportSize,
  effectiveBrowserPhotoExportSizeOption,
  formatBrowserPhotoFileSize,
  isBrowserPhotoCutoutFullSizeAvailable,
  isBrowserPhotoExportFullSizeOnly,
  isDesktopFullSizeSource,
  resolveBrowserPhotoExportChoices,
  resolveBrowserPhotoBatchExportChoices,
} from "./browser-photo-export";

type ExportInput = Parameters<typeof resolveBrowserPhotoExportChoices>[0];

function photo(overrides: Partial<ExportInput["photo"]> = {}): ExportInput["photo"] {
  return {
    id: "photo-1",
    developSettings: null,
    fileName: "IMG_0412.JPG",
    fileExtension: "jpg",
    sizeBytes: 3.8 * 1024 * 1024,
    hasOriginal: true,
    hasDevelopSettings: false,
    hasWebImage: true,
    capturedAt: "2026-09-17T02:12:59.000Z",
    ...overrides,
  };
}

function choices(overrides: Partial<Omit<ExportInput, "photo">> & { photo?: ExportInput["photo"] } = {}) {
  return resolveBrowserPhotoExportChoices({
    photo: overrides.photo ?? photo(),
    loupe: overrides.loupe ?? false,
    editing: overrides.editing ?? null,
    locked: overrides.locked ?? false,
    wide: overrides.wide ?? true,
    engineUsable: overrides.engineUsable ?? true,
    desktopFullSize: overrides.desktopFullSize,
    nativeFullSizeUnsupported: overrides.nativeFullSizeUnsupported,
    ...(overrides.desktopFullSizeRaster ? { desktopFullSizeRaster: overrides.desktopFullSizeRaster } : {}),
    ...(overrides.cutout ? { cutout: overrides.cutout } : {}),
  });
}

/** 段 2 の wasm で入力から描く JPEG（大きさを選べて、撮影日時を付ける） */
const ENGINE = { enabled: true, detail: "補正を反映", route: "engine", sizeSelectable: true, captureExif: true };

function webImage(detail: string) {
  return { enabled: true, detail, route: "webImage", sizeSelectable: false, captureExif: false };
}

function disabled(detail: string) {
  return { enabled: false, detail, route: null, sizeSelectable: false, captureExif: false };
}

const RAW = photo({ fileName: "P1570138.RW2", fileExtension: "rw2" });

describe("背景除去の原寸", () => {
  it("現像sidecarが使えないときは、hostに口があっても原寸を公開しない", () => {
    expect(
      isBrowserPhotoCutoutFullSizeAvailable(photo(), { hostExport: true, nativeExport: false, nativeExportRaster: true }),
    ).toBe(false);
  });

  it("nativeExportと形式ごとの描画口が使える写真だけ原寸を公開する", () => {
    expect(isBrowserPhotoCutoutFullSizeAvailable(photo(), { hostExport: true, nativeExport: true })).toBe(true);
    expect(isBrowserPhotoCutoutFullSizeAvailable(photo(), { hostExport: false, nativeExport: true })).toBe(false);
    expect(
      isBrowserPhotoCutoutFullSizeAvailable(photo({ fileExtension: "heic" }), {
        hostExport: true,
        nativeExport: true,
      }),
    ).toBe(false);
    expect(
      isBrowserPhotoCutoutFullSizeAvailable(photo({ fileExtension: "heic" }), {
        hostExport: true,
        nativeExport: true,
        nativeExportRaster: true,
      }),
    ).toBe(true);
    expect(isBrowserPhotoCutoutFullSizeAvailable(photo({ hasOriginal: false }), { hostExport: true, nativeExport: true })).toBe(
      false,
    );
  });
});

describe("resolveBrowserPhotoExportChoices: JPEG の経路の優先順", () => {
  it("1 枚で補正の入力を読めていれば今の補正を反映して描く（wasm は engine、S1 の canvas は長辺 2048px だけ・EXIF 無し）", () => {
    expect(choices({ loupe: true, editing: "wasm", photo: photo({ hasWebImage: false }) })).toEqual({
      jpeg: ENGINE,
      original: { enabled: true, detail: "IMG_0412.JPG・3.8 MB" },
    });
    // 1 枚で wasm で描けていれば、作業コピーを待つ一覧の行・wasm の可否によらず engine
    expect(choices({ loupe: true, editing: "wasm", photo: RAW, engineUsable: false }).jpeg).toEqual(ENGINE);
    expect(choices({ loupe: true, editing: "canvas", engineUsable: false }).jpeg).toEqual({
      enabled: true,
      detail: "補正を反映",
      route: "canvas",
      sizeSelectable: false,
      captureExif: false,
    });
  });

  it("一覧で選んだだけの写真も、wasm を使えれば入力から描く（オリジナルから描く JPEG / PNG・作業コピーのできた RAW。狭い幅でも同じ）", () => {
    expect(choices().jpeg).toEqual(ENGINE);
    expect(choices({ wide: false }).jpeg).toEqual(ENGINE);
    // wasm をまだ試していないときも使える扱い（engineUsable の既定）。記事用の画像が無くても描ける
    expect(choices({ photo: photo({ hasWebImage: false }) }).jpeg).toEqual(ENGINE);
    expect(choices({ photo: photo({ fileName: "A.png", fileExtension: "png", sizeBytes: 3 * 1024 * 1024 }) }).jpeg).toEqual(ENGINE);
    expect(choices({ photo: { ...RAW, workStatus: "ready" } }).jpeg).toEqual(ENGINE);
    // 1 枚で作業コピーを待っている間も、一覧の行で作業コピーができていれば描ける
    expect(choices({ photo: { ...RAW, workStatus: "ready", hasWebImage: false }, loupe: true }).jpeg).toEqual(ENGINE);
    // 保存してある補正（この版で読める）も描く
    expect(
      choices({ photo: photo({ hasDevelopSettings: true, developSettings: { v: 1, engine: "niho-1", exposure: 0.5 } }) }).jpeg,
    ).toEqual(ENGINE);
  });

  it("元の写真の無い「記事の画像」だけ、記事用の画像をそのまま落とす（長辺 2048px だけ）。写真（元の写真のある行）は記事用の画像を書き出さない（K4 #17150）", () => {
    // 元の写真の無い行。補正はブラウザと NIHO Desktop で区別しない。補正があるかは developSettings で見る（K1c 移行元設計）
    expect(choices({ engineUsable: false, photo: photo({ hasOriginal: false, hasDevelopSettings: true }) }).jpeg).toEqual(
      webImage("補正を反映・長辺 2048px"),
    );
    // オリジナルの無い記事の画像は長辺だけ
    expect(choices({ photo: photo({ hasOriginal: false }) }).jpeg).toEqual(webImage("長辺 2048px"));
    // 記事用の画像の無い「記事の画像」は押せない
    expect(choices({ photo: photo({ hasOriginal: false, hasWebImage: false }) }).jpeg).toEqual(
      disabled("書き出せる画像がありません"),
    );

    // 写真は、記事用の画像が付いていても代わりにしない: 作業コピー待ちの RAW は待ちの文言
    expect(choices({ photo: RAW }).jpeg).toEqual(disabled("RAW の現像の準備ができると書き出せます"));
    expect(choices({ photo: { ...RAW, workStatus: "queued" } }).jpeg).toEqual(disabled("RAW の現像の準備ができると書き出せます"));
    // wasm を使えない写真は S1 の canvas で描けるときだけ（1 枚で開くと書き出せる）
    expect(choices({ engineUsable: false }).jpeg).toEqual(disabled("1 枚で開くと書き出せます"));
    // 新しい版の NIHO で補正された写真・1 枚で開いて直せないと分かった写真は wasm で描かない（押せない）
    expect(choices({ photo: photo({ hasDevelopSettings: true, developSettings: { v: 1, engine: "niho-15" } }) }).jpeg).toEqual(
      disabled("ページを読み込み直すと書き出せます"),
    );
    expect(choices({ loupe: true, locked: true }).jpeg).toEqual(disabled("ページを読み込み直すと書き出せます"));
  });

  it("記事用の画像が無く wasm で描けない写真は押せない: 作業コピー待ちは待ちの文言（RAW だけ「現像」。W1 #17131）", () => {
    const raw = { ...RAW, hasWebImage: false };
    expect(choices({ photo: raw }).jpeg).toEqual(disabled("RAW の現像の準備ができると書き出せます"));
    expect(choices({ photo: { ...raw, workStatus: "queued" }, loupe: true }).jpeg).toEqual(
      disabled("RAW の現像の準備ができると書き出せます"),
    );
    expect(
      choices({ photo: photo({ fileName: "A.HEIC", fileExtension: "heic", hasWebImage: false, workStatus: "failed" }) }).jpeg,
    ).toEqual(disabled("編集の準備ができると書き出せます"));
    const largePng = photo({ fileName: "SCAN.PNG", fileExtension: "png", sizeBytes: 12 * 1024 * 1024, hasWebImage: false });
    expect(choices({ photo: largePng }).jpeg).toEqual(disabled("編集の準備ができると書き出せます"));
    // JPEG は大きさによらずオリジナルから描く（K5-a 移行元設計）。作業コピーの上で直した JPEG は作業コピーを待つ
    const largeJpeg = photo({ sizeBytes: 12 * 1024 * 1024, hasWebImage: false });
    expect(choices({ photo: largeJpeg }).jpeg).toEqual(ENGINE);
    expect(
      choices({ photo: { ...largeJpeg, developSettings: { v: 1, engine: "niho-1", base: "raster.apple.d1.p1.e1" } } }).jpeg,
    ).toEqual(disabled("編集の準備ができると書き出せます"));
  });

  it("wasm を使えないとき、記事用の画像の無い写真は S1 の canvas で描ける写真だけ「1 枚で開くと書き出せます」（狭い幅は PC で）", () => {
    const withoutWeb = photo({ hasWebImage: false });
    expect(choices({ photo: withoutWeb, engineUsable: false }).jpeg).toEqual(disabled("1 枚で開くと書き出せます"));
    expect(choices({ photo: withoutWeb, engineUsable: false, wide: false }).jpeg).toEqual(disabled("PC で開くと書き出せます"));
    expect(choices({ photo: withoutWeb, engineUsable: false, loupe: true }).jpeg).toEqual(disabled("写真を読み込めませんでした"));
    // canvas は補正を描けない・作業コピーを読めないので、読み込み直してもらう
    expect(
      choices({
        photo: photo({ hasWebImage: false, hasDevelopSettings: true, developSettings: { v: 1, engine: "niho-1", exposure: 1 } }),
        engineUsable: false,
      }).jpeg,
    ).toEqual(disabled("ページを読み込み直すと書き出せます"));
    expect(choices({ photo: { ...RAW, hasWebImage: false, workStatus: "ready" }, engineUsable: false }).jpeg).toEqual(
      disabled("ページを読み込み直すと書き出せます"),
    );
  });

  it("ブラウザで直せない写真（1 枚で閉じた・新しい版の NIHO の補正）で記事用の画像が無ければ押せない（NIHO Desktop へ送らない。#17147）", () => {
    const reason = disabled("ページを読み込み直すと書き出せます");
    expect(choices({ photo: { ...RAW, hasWebImage: false, workStatus: "ready" }, loupe: true, locked: true }).jpeg).toEqual(reason);
    expect(choices({ photo: photo({ hasDevelopSettings: true, hasWebImage: false }), loupe: true, locked: true }).jpeg).toEqual(reason);
    expect(
      choices({ photo: photo({ hasDevelopSettings: true, hasWebImage: false, developSettings: { v: 1, engine: "niho-15" } }) }).jpeg,
    ).toEqual(reason);
    // オリジナルも記事用の画像も無い写真
    expect(choices({ photo: photo({ hasOriginal: false, hasWebImage: false }) }).jpeg).toEqual(disabled("書き出せる画像がありません"));
  });
});

describe("resolveBrowserPhotoExportChoices: オリジナル", () => {
  it("オリジナルの無い写真: 記事から取り込んだ画像は「オリジナルはありません」、補正（developSettings）のある写真（Desktop の「オリジナルを置かない」写真）は「クラウドにオリジナルがありません」", () => {
    expect(choices({ photo: photo({ hasOriginal: false }) }).original).toEqual({ enabled: false, detail: "オリジナルはありません" });
    expect(choices({ photo: photo({ hasOriginal: false, hasDevelopSettings: true }) }).original).toEqual({
      enabled: false,
      detail: "クラウドにオリジナルがありません",
    });
  });

  it("シートを開いたときは押せる形式を選んでおく（JPEG を優先）", () => {
    expect(defaultBrowserPhotoExportFormat(choices())).toBe("jpeg");
    expect(defaultBrowserPhotoExportFormat(choices({ photo: { ...RAW, hasWebImage: false } }))).toBe("original");
    expect(
      defaultBrowserPhotoExportFormat({
        jpeg: { enabled: false, detail: "" },
        original: { enabled: false, detail: "" },
      }),
    ).toBeNull();
  });
});

describe("resolveBrowserPhotoBatchExportChoices（F7b #17127）", () => {
  it("ZIP 保存に対応しない NIHO Desktop・アプリでは両形式を無効にしてブラウザ利用を案内する", () => {
    const result = resolveBrowserPhotoBatchExportChoices({ engineUsable: true, zipSaveAvailable: false });
    expect(result.jpeg).toEqual({
      enabled: false,
      detail: "ZIP は NIHO Desktop と NIHO アプリでは保存できません。ブラウザで開いてください。",
      route: null,
      sizeSelectable: false,
      captureExif: false,
    });
    expect(result.original).toEqual({
      enabled: false,
      detail: "ZIP は NIHO Desktop と NIHO アプリでは保存できません。ブラウザで開いてください。",
    });
    expect(defaultBrowserPhotoExportFormat(result)).toBeNull();
  });

  it("現像エンジンが使えないときは JPEG だけ無効にし、オリジナル ZIP は選べる", () => {
    const result = resolveBrowserPhotoBatchExportChoices({ engineUsable: false, zipSaveAvailable: true });
    expect(result.jpeg).toEqual({
      enabled: false,
      detail: "JPEG を書き出す準備ができませんでした。もう一度お試しください。",
      route: null,
      sizeSelectable: false,
      captureExif: false,
    });
    expect(result.original).toEqual({ enabled: true, detail: "そのまま ZIP にまとめます" });
    expect(defaultBrowserPhotoExportFormat(result)).toBe("original");
  });
});

describe("書き出しの大きさ（F7b #17127）", () => {
  it("2 択は長辺 2048px（標準）と幅 1080px（Instagram）", () => {
    expect(BROWSER_PHOTO_EXPORT_SIZE_OPTIONS).toEqual([
      { size: "long2048", label: "長辺 2048px", detail: "標準" },
      { size: "width1080", label: "幅 1080px", detail: "Instagram" },
    ]);
  });

  it("長辺 2048px は 2048。幅 1080px は横長・正方形なら 1080、縦長は幅が 1080 になる長辺（2048 で頭打ち）", () => {
    expect(browserPhotoExportLongEdge("long2048", { width: 2048, height: 1365 })).toBe(2048);
    expect(browserPhotoExportLongEdge("long2048", { width: 1638, height: 2048 })).toBe(2048);
    // 横長・正方形
    expect(browserPhotoExportLongEdge("width1080", { width: 2048, height: 1365 })).toBe(1080);
    expect(browserPhotoExportLongEdge("width1080", { width: 2048, height: 2048 })).toBe(1080);
    // 4:5 の縦は 1080×1350
    expect(browserPhotoExportLongEdge("width1080", { width: 1638, height: 2048 })).toBe(1350);
    // 2:3 の縦
    expect(browserPhotoExportLongEdge("width1080", { width: 1365, height: 2048 })).toBe(1620);
    // 1:3 の縦は長辺 2048px で頭打ち（幅は 1080 に届かない）
    expect(browserPhotoExportLongEdge("width1080", { width: 683, height: 2048 })).toBe(2048);
    // 小さい写真でも比で決める（拡大はしない。段 2 は縮めるだけ）
    expect(browserPhotoExportLongEdge("width1080", { width: 800, height: 1000 })).toBe(1350);
  });
});

describe("シートの大きさと 1 行（F7b #17127）", () => {
  it("段 2 で描く JPEG は覚えた大きさ、描かない JPEG（記事用の画像・canvas）は長辺 2048px", () => {
    expect(effectiveBrowserPhotoExportSize(choices(), "width1080")).toBe("width1080");
    expect(effectiveBrowserPhotoExportSize(choices({ engineUsable: false }), "width1080")).toBe("long2048");
    expect(effectiveBrowserPhotoExportSize(choices({ editing: "canvas" }), "width1080")).toBe("long2048");
  });

  it("JPEG は撮影日時を付けるときだけ、オリジナルは常に 1 行を出す", () => {
    expect(browserPhotoExportLine(choices(), "jpeg")).toBe("撮影日時を付けます。位置情報は付けません。");
    expect(browserPhotoExportLine(choices({ engineUsable: false }), "jpeg")).toBeNull();
    expect(browserPhotoExportLine(choices(), "original")).toBe("オリジナルをそのまま保存します。");
    expect(browserPhotoExportLine(choices(), null)).toBeNull();
  });
});

describe("書き出しの名前と大きさ", () => {
  it("JPEG は元の名前の拡張子を .jpg に替える（-edited を付けない）", () => {
    expect(browserPhotoExportJpegFileName("P1570138.RW2")).toBe("P1570138.jpg");
    expect(browserPhotoExportJpegFileName("IMG_0412.JPG")).toBe("IMG_0412.jpg");
    expect(browserPhotoExportJpegFileName("")).toBe("photo.jpg");
  });

  it("大きさは MB（1MB 未満は KB）", () => {
    expect(formatBrowserPhotoFileSize(24.1 * 1024 * 1024)).toBe("24.1 MB");
    expect(formatBrowserPhotoFileSize(512 * 1024)).toBe("512 KB");
    expect(formatBrowserPhotoFileSize(0)).toBe("0 KB");
  });
});

describe("撮影日時の分からない写真（F7b #17127）", () => {
  it("段 2 で描いても撮影日時の EXIF は付けず、シートの JPEG の 1 行も出さない", () => {
    for (const capturedAt of [null, undefined]) {
      const resolved = choices({ photo: photo({ capturedAt }) });
      expect(resolved.jpeg).toMatchObject({ route: "engine", sizeSelectable: true, captureExif: false });
      expect(browserPhotoExportLine(resolved, "jpeg")).toBeNull();
      expect(browserPhotoExportLine(resolved, "original")).toBe("オリジナルをそのまま保存します。");
    }
  });
});

describe("大きさの「原寸」（NIHO Desktop の口。K2-3a #17148）", () => {
  const FULL = { enabled: true, detail: "この Mac に保存" };
  const HEIC = photo({ fileName: "A.HEIC", fileExtension: "heic", workStatus: "ready" });

  it("ブラウザ・原寸の書き出しの無い Desktop（v20 未満）は持たない（シートは今までどおり 2 枚）", () => {
    expect(choices().jpeg.fullSize).toBeUndefined();
    expect(choices({ desktopFullSize: false }).jpeg.fullSize).toBeUndefined();
    expect(Object.keys(choices().jpeg)).not.toContain("fullSize");
  });

  it("段 2 で描く JPEG で、Desktop が描ける写真（JPEG / PNG・RAW のオリジナル）だけ押せる。副文は「この Mac に保存」", () => {
    expect(choices({ desktopFullSize: true }).jpeg).toEqual({ ...ENGINE, fullSize: FULL });
    expect(
      choices({ desktopFullSize: true, photo: photo({ fileName: "A.png", fileExtension: "png", sizeBytes: 3 * 1024 * 1024 }) })
        .jpeg.fullSize,
    ).toEqual(FULL);
    expect(choices({ desktopFullSize: true, photo: { ...RAW, workStatus: "ready" } }).jpeg.fullSize).toEqual(FULL);
    // 1 枚で wasm で開いている写真（今の補正）
    expect(choices({ desktopFullSize: true, loupe: true, editing: "wasm" }).jpeg.fullSize).toEqual(FULL);
  });

  it("HEIC / TIFF は押せず理由を出す（Desktop の unsupportedSource を先に）。オリジナルの無い写真はオリジナルの理由", () => {
    expect(choices({ desktopFullSize: true, photo: HEIC }).jpeg).toEqual({
      ...ENGINE,
      fullSize: { enabled: false, detail: "HEIC・TIFF は対応していません" },
    });
    expect(
      choices({ desktopFullSize: true, photo: photo({ fileName: "S.TIF", fileExtension: "tif", workStatus: "ready" }) }).jpeg
        .fullSize,
    ).toEqual({ enabled: false, detail: "HEIC・TIFF は対応していません" });
    expect(choices({ desktopFullSize: true, photo: photo({ hasOriginal: false }) }).jpeg.fullSize).toEqual({
      enabled: false,
      detail: "オリジナルはありません",
    });
  });

  it("HEIC / HEIF・TIFF も描ける口（NIHO camera の nativeExportRaster）なら、HEIC / TIFF も押せる", () => {
    expect(choices({ desktopFullSize: true, desktopFullSizeRaster: true, photo: HEIC }).jpeg.fullSize).toEqual(FULL);
    expect(
      choices({
        desktopFullSize: true,
        desktopFullSizeRaster: true,
        photo: photo({ fileName: "S.TIFF", fileExtension: "tiff", workStatus: "ready" }),
      }).jpeg.fullSize,
    ).toEqual(FULL);
    expect(browserPhotoExportJpegRoute(choices({ desktopFullSize: true, desktopFullSizeRaster: true, photo: HEIC }), "full")).toBe(
      "native",
    );
    // 原寸の口が無ければ、描ける口の印だけでは原寸を出さない
    expect(choices({ desktopFullSizeRaster: true, photo: HEIC }).jpeg.fullSize).toBeUndefined();
    expect(isDesktopFullSizeSource({ fileExtension: "heic" })).toBe(false);
    expect(isDesktopFullSizeSource({ fileExtension: "HEIF" }, { raster: true })).toBe(true);
    expect(isDesktopFullSizeSource({ fileExtension: "webp" }, { raster: true })).toBe(false);
  });

  it("保存した signed RAW（p3/e4 の base を固定）もほかの RAW と同じく押せる（Desktop v23 が保存した base を原寸で作り直す。#17944）", () => {
    const signedRaw = photo({
      fileName: "P1570138.RW2",
      fileExtension: "rw2",
      hasDevelopSettings: true,
      developSettings: {
        v: 1,
        engine: "niho-3",
        look: "niho-standard-2",
        base: "raw-apple.d8.p3.e4.cal-signed",
      },
      workStatus: "ready",
    });
    expect(choices({ desktopFullSize: true, photo: signedRaw }).jpeg.fullSize).toEqual(FULL);
    expect(browserPhotoExportJpegRoute(choices({ desktopFullSize: true, photo: signedRaw }), "full")).toBe("native");
  });

  it("段 2 で描かない JPEG（記事用の画像・canvas）・押せない JPEG の間は、ほかの大きさと同じく押せない", () => {
    const sizeLocked = { enabled: false, detail: "この Mac に保存" };
    expect(choices({ desktopFullSize: true, photo: RAW }).jpeg.fullSize).toEqual(sizeLocked);
    expect(choices({ desktopFullSize: true, loupe: true, editing: "canvas", engineUsable: false }).jpeg.fullSize).toEqual(sizeLocked);
    expect(choices({ desktopFullSize: true, photo: { ...RAW, hasWebImage: false } }).jpeg.fullSize).toEqual(sizeLocked);
  });

  it("経路: 原寸は押せるときだけ native、ほかの大きさは jpeg.route", () => {
    const resolved = choices({ desktopFullSize: true });
    expect(browserPhotoExportJpegRoute(resolved, "full")).toBe("native");
    expect(browserPhotoExportJpegRoute(resolved, "long2048")).toBe("engine");
    expect(browserPhotoExportJpegRoute(resolved, "width1080")).toBe("engine");
    expect(browserPhotoExportJpegRoute(choices({ desktopFullSize: true, photo: HEIC }), "full")).toBeNull();
    expect(browserPhotoExportJpegRoute(choices(), "full")).toBeNull();
    expect(browserPhotoExportJpegRoute(choices({ desktopFullSize: true, photo: RAW }), "full")).toBeNull();
  });

  it("覚えた原寸は押せるときだけ選んだまま。押せない写真・原寸の無いシート（スマホ）は長辺 2048px", () => {
    expect(effectiveBrowserPhotoExportSizeOption(choices({ desktopFullSize: true }), "full")).toBe("full");
    expect(effectiveBrowserPhotoExportSizeOption(choices({ desktopFullSize: true, photo: HEIC }), "full")).toBe("long2048");
    expect(effectiveBrowserPhotoExportSizeOption(choices(), "full")).toBe("long2048");
    expect(effectiveBrowserPhotoExportSizeOption(choices({ desktopFullSize: true }), "width1080")).toBe("width1080");
    expect(effectiveBrowserPhotoExportSizeOption(choices({ desktopFullSize: true, engineUsable: false }), "width1080")).toBe(
      "long2048",
    );
    expect(effectiveBrowserPhotoExportSize(choices({ desktopFullSize: true }), "full")).toBe("long2048");
  });

  it("原寸の JPEG の 1 行は、保存先を選んでから描くこととかかる時間（撮影日時の分かる写真はその 1 行も）", () => {
    expect(browserPhotoExportLine(choices({ desktopFullSize: true }), "jpeg", "full")).toBe(
      "保存先を選ぶと原寸で描きます（24MP で 10 秒ほど）。撮影日時を付けます。位置情報は付けません。",
    );
    expect(browserPhotoExportLine(choices({ desktopFullSize: true, photo: photo({ capturedAt: null }) }), "jpeg", "full")).toBe(
      "保存先を選ぶと原寸で描きます（24MP で 10 秒ほど）。",
    );
    expect(browserPhotoExportLine(choices({ desktopFullSize: true }), "original", "full")).toBe("オリジナルをそのまま保存します。");
    expect(browserPhotoExportLine(choices({ desktopFullSize: true }), "jpeg", "long2048")).toBe(
      "撮影日時を付けます。位置情報は付けません。",
    );
  });

  it("中間調・全体の輝度を使う間は、保存済み・編集中どちらの原寸カードも押せない", () => {
    expect(
      choices({
        desktopFullSize: true,
        photo: photo({ developSettings: { v: 1, engine: "niho-1", colorGrading: { midtone: { luminance: 25 } } } }),
      }).jpeg.fullSize,
    ).toEqual({ enabled: false, detail: "原寸は中間調・全体の輝度に未対応です" });
    expect(choices({ desktopFullSize: true, nativeFullSizeUnsupported: true }).jpeg.fullSize).toEqual({
      enabled: false,
      detail: "原寸は中間調・全体の輝度に未対応です",
    });
    // 中間調・全体以外のゾーンの輝度は native renderer で描ける。
    expect(
      choices({
        desktopFullSize: true,
        photo: photo({ developSettings: { v: 1, engine: "niho-1", colorGrading: { shadow: { luminance: 25 } } } }),
      }).jpeg.fullSize,
    ).toEqual(FULL);
  });
});

describe("複数枚のフォルダへの書き出し（NIHO Desktop の口。K2-3b #17148）", () => {
  const FOLDER = { engineUsable: true, zipSaveAvailable: false, desktopFolderExport: true };

  it("ZIP を保存できない Desktop でフォルダへ書き出せれば、大きさは原寸だけ（経路 native）・形式は JPEG だけで、ZIP の案内はフォルダへの案内に替える", () => {
    const result = resolveBrowserPhotoBatchExportChoices(FOLDER);
    expect(result.jpeg).toEqual({
      enabled: true,
      detail: "補正を反映",
      route: "native",
      sizeSelectable: false,
      captureExif: true,
      fullSize: { enabled: true, detail: "この Mac に保存" },
    });
    expect(result.original).toEqual({
      enabled: false,
      detail: "ZIP はブラウザで保存できます。フォルダへは原寸の JPEG で書き出せます",
    });
    expect(defaultBrowserPhotoExportFormat(result)).toBe("jpeg");
    expect(isBrowserPhotoExportFullSizeOnly(result)).toBe(true);
    // native の段 2 で描くので、段 2 の wasm を使えなくても同じ
    expect(resolveBrowserPhotoBatchExportChoices({ ...FOLDER, engineUsable: false })).toEqual(result);
  });

  it("ブラウザ（ZIP を保存できる）は口があっても ZIP のまま。口の無い Desktop（v10 未満など）は今までどおりブラウザの案内", () => {
    expect(resolveBrowserPhotoBatchExportChoices({ ...FOLDER, zipSaveAvailable: true })).toEqual(
      resolveBrowserPhotoBatchExportChoices({ engineUsable: true, zipSaveAvailable: true }),
    );
    const zip = resolveBrowserPhotoBatchExportChoices({ engineUsable: true, zipSaveAvailable: true });
    expect(isBrowserPhotoExportFullSizeOnly(zip)).toBe(false);
    expect(resolveBrowserPhotoBatchExportChoices({ ...FOLDER, desktopFolderExport: false }).original.detail).toBe(
      "ZIP は NIHO Desktop と NIHO アプリでは保存できません。ブラウザで開いてください。",
    );
  });

  it("原寸だけのシートは覚えた大きさによらず原寸で、経路は native", () => {
    const result = resolveBrowserPhotoBatchExportChoices(FOLDER);
    for (const stored of ["long2048", "width1080", "full"] as const) {
      expect(effectiveBrowserPhotoExportSizeOption(result, stored)).toBe("full");
    }
    expect(browserPhotoExportJpegRoute(result, "full")).toBe("native");
  });

  it("形式の下の 1 行: フォルダへは選んだ枚数と原寸の時間の目安。ZIP の 1 行は今までどおり", () => {
    const folder = resolveBrowserPhotoBatchExportChoices(FOLDER);
    expect(browserPhotoBatchExportLine(folder, "jpeg", 3)).toBe(
      "選んだ 3 枚を、選ぶフォルダへ原寸で書き出します（24MP で 1 枚 10 秒ほど）。撮影日時を付けます。位置情報は付けません。",
    );
    const zip = resolveBrowserPhotoBatchExportChoices({ engineUsable: true, zipSaveAvailable: true });
    expect(browserPhotoBatchExportLine(zip, "jpeg", 2)).toBe("選んだ 2 枚を ZIP にまとめます。撮影日時を付けます。位置情報は付けません。");
    expect(browserPhotoBatchExportLine(zip, "original", 2)).toBe("選んだ 2 枚のオリジナルを、そのまま ZIP にまとめます。");
    const unavailable = resolveBrowserPhotoBatchExportChoices({ engineUsable: true, zipSaveAvailable: false });
    expect(browserPhotoBatchExportLine(unavailable, null, 2)).toBe(
      "ZIP は NIHO Desktop と NIHO アプリでは保存できません。ブラウザで開いてください。",
    );
  });
});

describe("背景除去を反映した書き出し（NIHO camera。C4 #18392）", () => {
  const TRANSPARENT = { transparent: true, fullSize: false };
  const LOUPE = { loupe: true, editing: "wasm" as const };

  it("1 枚で wasm で開いた写真に背景除去を重ねていれば、JPEG の副文を「背景除去を反映」にして同じ副文の PNG を足す", () => {
    const result = choices({ ...LOUPE, cutout: TRANSPARENT });
    expect(result).toEqual({
      jpeg: { ...ENGINE, detail: "背景除去を反映" },
      png: { enabled: true, detail: "背景除去を反映" },
      original: { enabled: true, detail: "IMG_0412.JPG・3.8 MB" },
      cutout: { transparent: true },
    });
    // 大きさと経路は JPEG と同じ（原寸は camera の口が無ければ出さない）
    expect(browserPhotoExportJpegRoute(result, "long2048")).toBe("engine");
    expect(browserPhotoExportJpegRoute(result, "full")).toBeNull();
    expect(effectiveBrowserPhotoExportSizeOption(result, "width1080")).toBe("width1080");
    expect(defaultBrowserPhotoExportFormat(result)).toBe("jpeg");
    expect(browserPhotoExportChoice(result, "png")).toEqual({ enabled: true, detail: "背景除去を反映" });
  });

  it("背景除去の原寸も中間調・全体の輝度が native 未対応なら押せない", () => {
    const result = choices({ ...LOUPE, cutout: { ...TRANSPARENT, fullSize: true }, nativeFullSizeUnsupported: true });
    expect(result.jpeg.fullSize).toEqual({ enabled: false, detail: "原寸は中間調・全体の輝度に未対応です" });
  });

  it("原寸は camera の口（fullSize）があるときだけ。NIHO Desktop の原寸は出さない", () => {
    const withHost = choices({ ...LOUPE, desktopFullSize: true, cutout: { transparent: false, fullSize: true } });
    expect(withHost.jpeg.fullSize).toEqual({ enabled: true, detail: "この Mac に保存" });
    expect(browserPhotoExportJpegRoute(withHost, "full")).toBe("native");
    expect(effectiveBrowserPhotoExportSizeOption(withHost, "full")).toBe("full");
    // HEIC でも camera の口が描く（Desktop の「HEIC・TIFF は対応していません」を出さない）
    expect(choices({ ...LOUPE, photo: photo({ fileExtension: "heic" }), cutout: { transparent: false, fullSize: true } }).jpeg.fullSize).toEqual({
      enabled: true,
      detail: "この Mac に保存",
    });
    const withoutHost = choices({ ...LOUPE, desktopFullSize: true, cutout: TRANSPARENT });
    expect(withoutHost.jpeg.fullSize).toBeUndefined();
    expect(browserPhotoExportJpegRoute(withoutHost, "full")).toBeNull();
    expect(effectiveBrowserPhotoExportSizeOption(withoutHost, "full")).toBe("long2048");
  });

  it("背景除去が無い・wasm で開いていない写真は今までどおり（PNG を足さない）", () => {
    for (const overrides of [{}, { loupe: true, editing: "canvas" as const }, { loupe: true, editing: null }, { desktopFullSize: true }]) {
      const plain = choices(overrides);
      expect(choices({ ...overrides, cutout: TRANSPARENT })).toEqual(plain);
      expect(plain.png).toBeUndefined();
      expect(plain.cutout).toBeUndefined();
      expect(browserPhotoExportChoice(plain, "png")).toBeNull();
    }
    expect(choices(LOUPE)).toEqual({ jpeg: ENGINE, original: { enabled: true, detail: "IMG_0412.JPG・3.8 MB" } });
  });

  it("形式の下の 1 行: PNG は撮影日時を付けない（透明ならそのまま保存）。JPEG の透明の背景は白にする", () => {
    const transparent = choices({ ...LOUPE, cutout: { transparent: true, fullSize: true } });
    expect(browserPhotoExportLine(transparent, "png")).toBe("背景の透明をそのまま保存します。撮影日時は付けません。");
    expect(browserPhotoExportLine(transparent, "png", "full")).toBe(
      "保存先を選ぶと原寸で描きます（24MP で 10 秒ほど）。背景の透明をそのまま保存します。撮影日時は付けません。",
    );
    expect(browserPhotoExportLine(transparent, "jpeg")).toBe("撮影日時を付けます。位置情報は付けません。透明の背景は白にします。");
    expect(browserPhotoExportLine(transparent, "jpeg", "full")).toBe(
      "保存先を選ぶと原寸で描きます（24MP で 10 秒ほど）。撮影日時を付けます。位置情報は付けません。透明の背景は白にします。",
    );
    expect(browserPhotoExportLine(choices({ ...LOUPE, photo: photo({ capturedAt: null }), cutout: TRANSPARENT }), "jpeg")).toBe(
      "透明の背景は白にします。",
    );
    expect(browserPhotoExportLine(transparent, "original")).toBe("オリジナルをそのまま保存します。");
    // 白・色の背景は「透明」を言わない
    const opaque = choices({ ...LOUPE, cutout: { transparent: false, fullSize: false } });
    expect(browserPhotoExportLine(opaque, "png")).toBe("撮影日時は付けません。");
    expect(browserPhotoExportLine(opaque, "jpeg")).toBe("撮影日時を付けます。位置情報は付けません。");
  });

  it("JPEG を押せず PNG だけ押せるシートは PNG を選んでおく。PNG の名前は <元の名前の拡張子なし>.png", () => {
    expect(
      defaultBrowserPhotoExportFormat({
        jpeg: { enabled: false, detail: "" },
        png: { enabled: true, detail: "" },
        original: { enabled: true, detail: "" },
      }),
    ).toBe("png");
    expect(browserPhotoExportPngFileName("IMG_0412.JPG")).toBe("IMG_0412.png");
    expect(browserPhotoExportPngFileName("")).toBe("photo.png");
  });
});
