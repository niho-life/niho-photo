import { describe, expect, it } from "vitest";

import type { PhotoLibraryPhotoInfo } from "./library/photo-library";
import {
  formatPhotoInfoAperture,
  formatPhotoInfoCamera,
  formatPhotoInfoCapturedAt,
  formatPhotoInfoDimensions,
  formatPhotoInfoFileSize,
  formatPhotoInfoFocalLength,
  formatPhotoInfoFormat,
  formatPhotoInfoIso,
  formatPhotoInfoLocation,
  formatPhotoInfoShutter,
  NBSP,
  photoEditingInfoGroups,
  photoInfoEv100,
  type PhotoEditingInfoPhoto,
} from "./photo-editing-info";

/**
 * 右パネルの「情報」（niho-photo#43）の値の整え方と群の組み立て。値の無い行は行ごと出さず、行の無い群は見出しも出さない。
 */

/** 改行しない空白（数と単位の間）をふつうの空白にして比べる */
const plain = (value: string | null) => (value === null ? null : value.replaceAll(NBSP, " "));

const NOT_NUMBERS = [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1];

describe("formatPhotoInfoIso", () => {
  it("整数にして出す（ラベル「ISO」と並べて「ISO 400」と読む）", () => {
    expect(formatPhotoInfoIso(400)).toBe("400");
    expect(formatPhotoInfoIso(12800)).toBe("12800");
    expect(formatPhotoInfoIso(99.6)).toBe("100");
  });

  it("無い・非有限・0 以下は出さない", () => {
    for (const value of NOT_NUMBERS) expect(formatPhotoInfoIso(value)).toBeNull();
  });
});

describe("formatPhotoInfoShutter", () => {
  it("1 秒未満は逆数が整数に近ければ「1/n 秒」", () => {
    expect(plain(formatPhotoInfoShutter(1 / 250))).toBe("1/250 秒");
    expect(plain(formatPhotoInfoShutter(0.004))).toBe("1/250 秒");
    expect(plain(formatPhotoInfoShutter(1 / 3))).toBe("1/3 秒");
    expect(plain(formatPhotoInfoShutter(0.333))).toBe("1/3 秒");
    expect(plain(formatPhotoInfoShutter(0.5))).toBe("1/2 秒");
    expect(plain(formatPhotoInfoShutter(1 / 8000))).toBe("1/8000 秒");
  });

  it("1 秒未満で逆数が整数に近くなければ小数、1 に丸まる値は「1 秒」", () => {
    expect(plain(formatPhotoInfoShutter(0.4))).toBe("0.4 秒");
    expect(plain(formatPhotoInfoShutter(0.625))).toBe("0.6 秒");
    expect(plain(formatPhotoInfoShutter(0.97))).toBe("1 秒");
  });

  it("1 秒以上は秒（小数 1 桁まで）", () => {
    expect(plain(formatPhotoInfoShutter(1))).toBe("1 秒");
    expect(plain(formatPhotoInfoShutter(2.5))).toBe("2.5 秒");
    expect(plain(formatPhotoInfoShutter(1.3))).toBe("1.3 秒");
    expect(plain(formatPhotoInfoShutter(30))).toBe("30 秒");
  });

  it("無い・非有限・0 以下は出さない", () => {
    for (const value of NOT_NUMBERS) expect(plain(formatPhotoInfoShutter(value))).toBeNull();
  });
});

describe("formatPhotoInfoAperture / formatPhotoInfoFocalLength", () => {
  it("絞りは「f/2.8」、整数は「f/4」", () => {
    expect(formatPhotoInfoAperture(1.4)).toBe("f/1.4");
    expect(formatPhotoInfoAperture(2.8000001)).toBe("f/2.8");
    expect(formatPhotoInfoAperture(4)).toBe("f/4");
    expect(formatPhotoInfoAperture(11)).toBe("f/11");
  });

  it("焦点距離は「35 mm」（小数は 1 桁まで）", () => {
    expect(plain(formatPhotoInfoFocalLength(35))).toBe("35 mm");
    expect(plain(formatPhotoInfoFocalLength(4.25))).toBe("4.3 mm");
    expect(plain(formatPhotoInfoFocalLength(6.86))).toBe("6.9 mm");
  });

  it("無い・非有限・0 以下は出さない", () => {
    for (const value of NOT_NUMBERS) {
      expect(formatPhotoInfoAperture(value)).toBeNull();
      expect(plain(formatPhotoInfoFocalLength(value))).toBeNull();
    }
  });
});

describe("photoInfoEv100（空の検出の露出。niho-photo#141）", () => {
  it("log2(N² / t) − log2(ISO / 100)", () => {
    // 晴天の 16 の法則: f/16・1/100 秒・ISO 100 は EV 約 14.6
    expect(photoInfoEv100({ fNumber: 16, exposureTimeSeconds: 1 / 100, iso: 100 })).toBeCloseTo(Math.log2(25_600), 9);
    expect(photoInfoEv100({ fNumber: 1, exposureTimeSeconds: 1, iso: 100 })).toBe(0);
    // ISO が 2 倍で 1 段下がる（ISO 400 は 2 段）
    expect(photoInfoEv100({ fNumber: 2.8, exposureTimeSeconds: 1 / 60, iso: 400 })).toBeCloseTo(Math.log2((2.8 * 2.8) / (1 / 60)) - 2, 9);
  });

  it("どれかが無い・非有限・0 以下なら null", () => {
    expect(photoInfoEv100(null)).toBeNull();
    expect(photoInfoEv100(undefined)).toBeNull();
    expect(photoInfoEv100({})).toBeNull();
    for (const value of NOT_NUMBERS) {
      expect(photoInfoEv100({ fNumber: value, exposureTimeSeconds: 1 / 100, iso: 100 })).toBeNull();
      expect(photoInfoEv100({ fNumber: 8, exposureTimeSeconds: value, iso: 100 })).toBeNull();
      expect(photoInfoEv100({ fNumber: 8, exposureTimeSeconds: 1 / 100, iso: value })).toBeNull();
    }
  });
});

describe("formatPhotoInfoDimensions / formatPhotoInfoFileSize / formatPhotoInfoFormat", () => {
  it("寸法は「幅 × 高さ（MP）」。10 MP 以上は整数、未満は小数 1 桁、0.1 MP 未満は MP を付けない", () => {
    expect(plain(formatPhotoInfoDimensions(6000, 4000))).toBe("6000 × 4000（24 MP）");
    expect(plain(formatPhotoInfoDimensions(4032, 3024))).toBe("4032 × 3024（12 MP）");
    expect(plain(formatPhotoInfoDimensions(1920, 1080))).toBe("1920 × 1080（2.1 MP）");
    expect(plain(formatPhotoInfoDimensions(32, 24))).toBe("32 × 24");
    expect(plain(formatPhotoInfoDimensions(6000, null))).toBeNull();
    expect(plain(formatPhotoInfoDimensions(0, 4000))).toBeNull();
    expect(plain(formatPhotoInfoDimensions(Number.NaN, 4000))).toBeNull();
  });

  it("ファイルの大きさは書き出しの 1 行と同じ（1024 基準。1 MB 未満は KB）。0 以下は出さない", () => {
    expect(plain(formatPhotoInfoFileSize(24.3 * 1024 * 1024))).toBe("24.3 MB");
    expect(plain(formatPhotoInfoFileSize(512 * 1024))).toBe("512 KB");
    expect(plain(formatPhotoInfoFileSize(0))).toBeNull();
    expect(plain(formatPhotoInfoFileSize(Number.NaN))).toBeNull();
  });

  it("形式は拡張子の大文字（JPEG・TIFF は名前にそろえる）", () => {
    expect(formatPhotoInfoFormat("rw2")).toBe("RW2");
    expect(formatPhotoInfoFormat("ARW")).toBe("ARW");
    expect(formatPhotoInfoFormat("jpg")).toBe("JPEG");
    expect(formatPhotoInfoFormat("JPEG")).toBe("JPEG");
    expect(formatPhotoInfoFormat("png")).toBe("PNG");
    expect(formatPhotoInfoFormat("heic")).toBe("HEIC");
    expect(formatPhotoInfoFormat("tif")).toBe("TIFF");
    expect(formatPhotoInfoFormat("")).toBeNull();
    expect(formatPhotoInfoFormat(null)).toBeNull();
  });
});

describe("数と単位の間の空白", () => {
  it("改行しない空白にする（狭い右パネルで「33」と「MP」が別の行に分かれない）", () => {
    expect(formatPhotoInfoShutter(1 / 250)).toBe(`1/250${NBSP}秒`);
    expect(formatPhotoInfoFocalLength(35)).toBe(`35${NBSP}mm`);
    expect(formatPhotoInfoDimensions(6000, 4000)).toBe(`6000 × 4000（24${NBSP}MP）`);
    expect(formatPhotoInfoFileSize(24.3 * 1024 * 1024)).toBe(`24.3${NBSP}MB`);
    expect(formatPhotoInfoLocation({ latitude: 35.31923, longitude: 139.54671 })).toBe(`35.3192°${NBSP}N, 139.5467°${NBSP}E`);
  });
});

describe("formatPhotoInfoCamera", () => {
  it("機種の名前がメーカーの名前で始まれば機種だけ、違えばメーカーと機種", () => {
    expect(formatPhotoInfoCamera({ make: "Canon", model: "Canon EOS R5" })).toBe("Canon EOS R5");
    expect(formatPhotoInfoCamera({ make: "NIKON CORPORATION", model: "NIKON Z 6_2" })).toBe("NIKON Z 6_2");
    expect(formatPhotoInfoCamera({ make: "SONY", model: "ILCE-7M4" })).toBe("SONY ILCE-7M4");
    expect(formatPhotoInfoCamera({ make: "Apple", model: "iPhone 15 Pro" })).toBe("Apple iPhone 15 Pro");
  });

  it("片方だけならその名前、どちらも無ければ出さない", () => {
    expect(formatPhotoInfoCamera({ make: null, model: "ILCE-7M4" })).toBe("ILCE-7M4");
    expect(formatPhotoInfoCamera({ make: "SONY", model: " " })).toBe("SONY");
    expect(formatPhotoInfoCamera({ make: null, model: null })).toBeNull();
    expect(formatPhotoInfoCamera(null)).toBeNull();
    expect(formatPhotoInfoCamera(undefined)).toBeNull();
  });
});

describe("formatPhotoInfoCapturedAt", () => {
  it("時差の無い日時（EXIF の撮影日時）は撮影した場所の時計のまま出す", () => {
    expect(formatPhotoInfoCapturedAt("2024-05-01T10:30:15")).toBe("2024年5月1日 10:30:15");
    expect(formatPhotoInfoCapturedAt("2024-12-31T23:59:59")).toBe("2024年12月31日 23:59:59");
    expect(formatPhotoInfoCapturedAt("2024-05-01T09:05")).toBe("2024年5月1日 9:05:00");
  });

  it("時差・Z の付いた日時（クラウドの行）は日本時間で出す", () => {
    expect(formatPhotoInfoCapturedAt("2024-05-01T01:30:15.000Z")).toBe("2024年5月1日 10:30:15");
    expect(formatPhotoInfoCapturedAt("2024-05-01T10:30:15+09:00")).toBe("2024年5月1日 10:30:15");
    expect(formatPhotoInfoCapturedAt("2024-04-30T20:30:15-05:00")).toBe("2024年5月1日 10:30:15");
  });

  it("形の違う値・ありえない日時・無い値は出さない（繰り上げない）", () => {
    for (const value of ["", "  ", null, undefined, "2024-02-30T10:00:00", "2024-05-01T25:00:00", "2024-05-01", "2024:05:01 10:30:15", "not a date"]) {
      expect(formatPhotoInfoCapturedAt(value)).toBeNull();
    }
  });
});

describe("formatPhotoInfoLocation", () => {
  it("緯度・経度を小数 4 桁と N / S・E / W で出す（南緯・西経は負の値）", () => {
    expect(plain(formatPhotoInfoLocation({ latitude: 35.31923, longitude: 139.54671 }))).toBe("35.3192° N, 139.5467° E");
    expect(plain(formatPhotoInfoLocation({ latitude: -12.5, longitude: -45.26 }))).toBe("12.5000° S, 45.2600° W");
    expect(plain(formatPhotoInfoLocation({ latitude: 0, longitude: -0.5 }))).toBe("0.0000° N, 0.5000° W");
  });

  it("範囲の外・非有限・測位できていない 0, 0・無い値は出さない", () => {
    expect(plain(formatPhotoInfoLocation({ latitude: 91, longitude: 0.5 }))).toBeNull();
    expect(plain(formatPhotoInfoLocation({ latitude: 35, longitude: 181 }))).toBeNull();
    expect(plain(formatPhotoInfoLocation({ latitude: Number.NaN, longitude: 139 }))).toBeNull();
    expect(plain(formatPhotoInfoLocation({ latitude: 0, longitude: 0 }))).toBeNull();
    expect(plain(formatPhotoInfoLocation(null))).toBeNull();
  });
});

describe("photoEditingInfoGroups", () => {
  const RAW: PhotoEditingInfoPhoto = {
    fileName: "DSC02072.ARW",
    fileExtension: "arw",
    sizeBytes: 24.3 * 1024 * 1024,
    capturedAt: null,
  };
  const FULL_INFO: PhotoLibraryPhotoInfo = {
    camera: { make: "SONY", model: "ILCE-7M4" },
    lens: "FE 35mm F1.8",
    iso: 400,
    exposureTimeSeconds: 1 / 250,
    fNumber: 2.8,
    focalLengthMm: 35,
    capturedAt: "2024-05-01T10:30:15",
    width: 7008,
    height: 4672,
    gps: { latitude: 35.31923, longitude: 139.54671 },
  };

  const shape = (groups: ReturnType<typeof photoEditingInfoGroups>) =>
    groups.map((group) => [group.title, group.rows.map((row) => `${row.label} ${plain(row.value)}`)]);

  it("撮影条件 → カメラ・レンズ → ファイル の順に、ラベルと値を並べる（RAW）", () => {
    expect(shape(photoEditingInfoGroups(RAW, FULL_INFO))).toEqual([
      ["撮影条件", ["ISO 400", "シャッター速度 1/250 秒", "絞り f/2.8", "焦点距離 35 mm"]],
      ["カメラ・レンズ", ["カメラ SONY ILCE-7M4", "レンズ FE 35mm F1.8"]],
      [
        "ファイル",
        [
          "ファイル名 DSC02072.ARW",
          "形式 ARW",
          "大きさ 7008 × 4672（33 MP）",
          "ファイルの大きさ 24.3 MB",
          "撮影日時 2024年5月1日 10:30:15",
          "場所 35.3192° N, 139.5467° E",
        ],
      ],
    ]);
  });

  it("JPEG も同じ。無い項目は行ごと出さない（空欄や「—」を並べない）", () => {
    const groups = photoEditingInfoGroups(
      { fileName: "IMG_0001.JPG", fileExtension: "jpg", sizeBytes: 3 * 1024 * 1024, capturedAt: null },
      { camera: { make: "Apple", model: "iPhone 15 Pro" }, iso: 50, fNumber: 1.78, lens: null, focalLengthMm: Number.NaN },
    );
    expect(shape(groups)).toEqual([
      ["撮影条件", ["ISO 50", "絞り f/1.8"]],
      ["カメラ・レンズ", ["カメラ Apple iPhone 15 Pro"]],
      ["ファイル", ["ファイル名 IMG_0001.JPG", "形式 JPEG", "ファイルの大きさ 3.0 MB"]],
    ]);
    const values = groups.flatMap((group) => group.rows.map((row) => row.value));
    expect(values.every((value) => value.trim() !== "" && value !== "—")).toBe(true);
  });

  it("撮影条件もカメラも無い写真（PNG・HEIC に多い）は、ファイルの群だけ（ほかの群は見出しも出さない）", () => {
    const groups = photoEditingInfoGroups(
      { fileName: "scan.png", fileExtension: "png", sizeBytes: 2048, capturedAt: null },
      { width: 32, height: 24, camera: null, gps: null },
    );
    expect(shape(groups)).toEqual([["ファイル", ["ファイル名 scan.png", "形式 PNG", "大きさ 32 × 24", "ファイルの大きさ 2 KB"]]]);
  });

  it("写真の情報を読めない置き場・読めなかったときは、写真の行のファイルの項目だけ（撮影日時は写真の行のもの）", () => {
    const groups = photoEditingInfoGroups({ ...RAW, capturedAt: "2024-05-01T01:30:15.000Z" }, null);
    expect(shape(groups)).toEqual([
      [
        "ファイル",
        ["ファイル名 DSC02072.ARW", "形式 ARW", "ファイルの大きさ 24.3 MB", "撮影日時 2024年5月1日 10:30:15"],
      ],
    ]);
  });

  it("撮影日時はファイルの EXIF を先に使い、無ければ写真の行のもの", () => {
    const capturedAt = (info: PhotoLibraryPhotoInfo | null) =>
      photoEditingInfoGroups({ ...RAW, capturedAt: "2023-01-02T03:04:05Z" }, info)
        .flatMap((group) => group.rows)
        .find((row) => row.key === "capturedAt")?.value;
    expect(capturedAt({ capturedAt: "2024-05-01T10:30:15" })).toBe("2024年5月1日 10:30:15");
    expect(capturedAt({ capturedAt: null })).toBe("2023年1月2日 12:04:05");
  });

  it("行の無い群は 1 つも返さない", () => {
    expect(photoEditingInfoGroups({ fileName: " ", fileExtension: "", sizeBytes: 0, capturedAt: null }, null)).toEqual([]);
  });
});
