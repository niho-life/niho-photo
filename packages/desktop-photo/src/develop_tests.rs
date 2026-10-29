//! 現像の土台のテスト（NIHO Desktop の `photo_develop_tests.rs` のうち、写真を開くエンジン（Photo Bench）を使わないもの。
//! C2 #18390 で移した。写真を開いて作業コピー・書き出しを確かめるテストは NIHO Desktop に残る）。

use super::*;
use crate::test_support::develop::*;
use crate::test_support::set_modified;
use std::fs;

// --- ワーカーと同じ規則（baseVersion・meta・入力の分け方） ---

/// ワーカー（TS）と Desktop（Rust）が同じ表で確かめる baseVersion の共通の値（S7c-1）。
const BASE_VERSION_VECTORS: &str = include_str!("../calibration/base-version-vectors.json");

#[test]
fn preview_metadata_removal_preserves_icc_and_compressed_image_bytes() {
  let icc = b"\xff\xe2\x00\x05ICC";
  let mut input = FAKE_RASTER_JPEG[..2].to_vec();
  input.extend_from_slice(b"\xff\xe1\x00\x08Exif\x00\x00");
  input.extend_from_slice(b"\xff\xed\x00\x06IPTC");
  input.extend_from_slice(icc);
  input.extend_from_slice(&FAKE_RASTER_JPEG[2..]);
  let mut expected = FAKE_RASTER_JPEG[..2].to_vec();
  expected.extend_from_slice(icc);
  expected.extend_from_slice(&FAKE_RASTER_JPEG[2..]);
  assert!(!jpeg_has_no_exif_or_gps(&input));
  let clean = strip_jpeg_private_metadata(&input).unwrap();
  assert_eq!(clean, expected);
  assert!(jpeg_has_no_exif_or_gps(&clean));
  assert_eq!(parse_jpeg_frame(&clean), parse_jpeg_frame(FAKE_RASTER_JPEG));
  assert_eq!(strip_jpeg_private_metadata(b"\xff\xd8\xff\xe1\xff\xffbad"), None);
}

#[test]
fn raw_orientation_swaps_dimensions_for_all_transposed_exif_values() {
  for orientation in 1..=8 {
    let dimensions = oriented_dimensions(640, 480, orientation).unwrap();
    assert_eq!(
      dimensions,
      if orientation >= 5 { (480, 640) } else { (640, 480) },
      "orientation {orientation}"
    );
  }
  assert_eq!(oriented_dimensions(0, 480, 1), None);
}

#[test]
fn signed_raw_generation_flag_is_strict_and_non_utf8_is_invalid() {
  use std::ffi::OsString;
  use std::os::unix::ffi::OsStringExt;

  assert_eq!(signed_raw_generation_from_env(None), Some(true));
  assert_eq!(signed_raw_generation_from_env(Some("0")), Some(false));
  assert_eq!(signed_raw_generation_from_env(Some("1")), Some(true));
  for value in ["", "true", "false", "off", "on", " 0", "01"] {
    assert_eq!(signed_raw_generation_from_env(Some(value)), None, "{value:?}");
  }
  assert_eq!(
    signed_raw_generation_from_var(Err(std::env::VarError::NotPresent)),
    Some(true)
  );
  let not_unicode = OsString::from_vec(vec![0x30, 0xff]);
  assert_eq!(
    signed_raw_generation_from_var(Err(std::env::VarError::NotUnicode(not_unicode))),
    None
  );
}

#[test]
fn known_signed_camera_scope_matches_native_reader() {
  assert!(supports_known_signed_raw(
    &json!({"dcpSha256": "apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v4"})
  ));
  assert!(supports_known_signed_raw(
    &json!({"dcpSha256": "apple-ciraw8/linear-prophoto-d50/cal-sony-zv-e10m2-apple-v2"})
  ));
  assert!(!supports_known_signed_raw(
    &json!({"dcpSha256": "apple-ciraw8/linear-prophoto-d50/cal-other-apple-v4"})
  ));
}

#[test]
fn base_version_vectors_match_the_worker() {
  let vectors: Value = serde_json::from_str(BASE_VERSION_VECTORS).unwrap();
  assert_eq!(vectors["schema"], "niho-develop-base-version-vectors/v1");
  let cases = vectors["cases"].as_array().unwrap();
  assert!(cases.len() >= 6, "{cases:?}");
  let mut ok = 0;
  let mut failed = 0;
  for case in cases {
    let name = case["name"].as_str().unwrap();
    let described = describe_working_copy(&case["workingCopyMeta"]);
    match (
      case.get("baseVersion").and_then(Value::as_str),
      case.get("error").and_then(Value::as_str),
    ) {
      (Some(expected), None) => {
        let applied = described.unwrap_or_else(|code| panic!("{name}: {code}"));
        assert_eq!(build_base_version(&applied).as_deref(), Ok(expected), "{name}");
        ok += 1;
      }
      (None, Some(error)) => {
        assert_eq!(described.err(), Some(error), "{name}");
        failed += 1;
      }
      other => panic!("{name}: {other:?}"),
    }
  }
  assert!(ok > 0 && failed > 0);
}
#[test]
fn base_version_rejects_an_empty_decoder_or_an_invalid_name() {
  let applied = |decoder: &str, calibration: Option<&str>| AppliedBase {
    decoder_version: decoder.into(),
    calibration_id: calibration.map(str::to_string),
    lens_mode: "apple".into(),
  };
  assert_eq!(
    build_base_version(&applied("8.dng", None)).as_deref(),
    Ok("raw-apple.d8dng.p2.e1.cal-none.lens-apple")
  );
  assert_eq!(build_base_version(&applied(".", None)), Err("invalidBaseVersion"));
  assert_eq!(
    build_base_version(&applied("8", Some("a/b-apple-v2"))),
    Err("invalidBaseVersion")
  );
  assert_eq!(
    build_base_version(&applied("8", Some(&"x".repeat(120)))),
    Err("invalidBaseVersion")
  );
}

/// ワーカーの unit test（`meta の許可リストは知らないキー・パスを落とす`）と同じ入力・同じ結果。
#[test]
fn artifact_meta_matches_the_worker_allowlist() {
  let meta = artifact_meta(
    &json!({
      "kind": "raw",
      "baselineEV": 0,
      "whiteBalanceTable": { "schema": "niho-develop-wb-table/v1", "status": "mismatch", "check": { "maxDeltaE": 3.1 } },
      "extra": "dropped",
      "_source": {
        "tool": { "name": "apple-raw-linear", "version": "0.4.0", "path": "/usr/local/bin/x" },
        "camera": { "make": "SONY", "model": "ZV-E10M2" },
        "input": { "path": "/tmp/original.arw" },
        "output": "/tmp/work.png",
        "toolMeta": "/tmp/work.tool.json",
        "createdAt": "2026-09-29T00:00:00Z",
        "note": "dropped",
        "clippedAbove2Fraction": 0.01,
        "calibration": {
          "id": "cal-x",
          "path": "/repo/calibration/x.json",
          "registry": { "registry": "/repo/calibration/apple-registry.json", "file": "/abs/x.json" },
        },
      },
    }),
    "arw",
  );
  assert_eq!(
    meta,
    json!({
      "kind": "raw",
      "baselineEV": 0,
      // 白の表（S11 #17108）は中身を選ばずにそのまま写す
      "whiteBalanceTable": { "schema": "niho-develop-wb-table/v1", "status": "mismatch", "check": { "maxDeltaE": 3.1 } },
      "engine": "apple-raw-linear",
      "orientationApplied": true,
      "colorSpace": "linear-prophoto-d50",
      "sourceExtension": "arw",
      "_source": {
        "tool": { "name": "apple-raw-linear", "version": "0.4.0" },
        "calibration": { "id": "cal-x", "registry": { "registry": "apple-registry.json", "file": null } },
      },
    })
  );
  // 校正なし（null）はそのまま、壊れた校正（文字列）は null、registry の無い校正は registry: null
  let uncalibrated = artifact_meta(
    &json!({ "_source": { "calibration": null, "decoderVersion": "8" } }),
    "rw2",
  );
  assert_eq!(
    uncalibrated["_source"],
    json!({ "calibration": null, "decoderVersion": "8" })
  );
  let broken = artifact_meta(&json!({ "_source": { "calibration": "x" } }), "rw2");
  assert_eq!(broken["_source"]["calibration"], Value::Null);
  let relative = artifact_meta(
    &json!({ "_source": { "calibration": { "id": "c", "registry": { "registry": "apple-registry.json", "file": "p/apple-v2.json" } } } }),
    "rw2",
  );
  assert_eq!(
    relative["_source"]["calibration"]["registry"],
    json!({ "registry": "apple-registry.json", "file": "p/apple-v2.json" })
  );
  assert_eq!(
    artifact_meta(&json!({ "_source": { "calibration": { "id": "c" } } }), "rw2")["_source"]["calibration"]["registry"],
    Value::Null
  );
  // 表の無い校正・校正なしの null もそのまま写す（キーを落とさない。API はキーがそろっていることを確かめる）
  assert_eq!(
    artifact_meta(&json!({ "whiteBalanceTable": null }), "rw2")["whiteBalanceTable"],
    Value::Null
  );
  assert!(artifact_meta(&json!({ "whiteBalanceTable": null }), "rw2")
    .as_object()
    .unwrap()
    .contains_key("whiteBalanceTable"));

  let signed = artifact_meta(
    &json!({
      "encoding": { "kind": "signed-gamma18-v1", "ceiling": 2 },
      "_source": {
        "recipe": "signed",
        "requestedLongEdge": "full",
        "calibrationProvenance": { "sha256": "a", "matrix": "owned", "recipe": "signed", "path": "/test-data/hidden/x" }
      }
    }),
    "arw",
  );
  assert_eq!(signed["encoding"], json!({ "kind": "signed-gamma18-v1", "ceiling": 2 }));
  assert_eq!(signed["_source"]["requestedLongEdge"], "full");
  assert_eq!(
    signed["_source"]["calibrationProvenance"],
    json!({ "sha256": "a", "matrix": "owned", "recipe": "signed" })
  );
}

#[test]
fn raster_meta_keys_match_the_worker() {
  // RAW の CRATE_META_KEYS とは別の一覧。ワーカーの meta のキーが変わったら Desktop も変える（API の検査 keys で落ちる）
  let meta = raster_artifact_meta(
    &RasterMeta {
      width: 2560,
      height: 1707,
      icc_sha256: None,
      color_space: "kCGColorSpaceSRGB".into(),
      converted: None,
      orientation_applied: false,
    },
    "heic",
  );
  let keys: Vec<&String> = meta.as_object().unwrap().keys().collect();
  let mut expected: Vec<&str> = RASTER_META_KEYS.to_vec();
  expected.sort();
  assert_eq!(keys, expected);
}

#[test]
fn raster_arguments_and_versions_match_the_worker() {
  // 公開ローカルプロトコルの版。非公開ワーカーのソースをビルド入力にしない。
  assert_eq!(WORKING_COPY_LONG_EDGE, 2560);
  assert!(!RASTER_DECODER_VERSION.is_empty());
  assert!(!PROCESSING_VERSION.is_empty());
  assert!(!RASTER_ENCODING_VERSION.is_empty());
  assert!(is_raster_tool_version("0.4.3") && is_raster_tool_version("0.4.12") && is_raster_tool_version("0.5.0"));
  assert!(!is_raster_tool_version("0.4.2") && !is_raster_tool_version("0.3.9") && !is_raster_tool_version("0.4"));
  assert!(is_full_size_raster_export_tool_version("0.5.2") && is_full_size_raster_export_tool_version("0.6.0"));
  // 0.5.1 は登録表の fallback だけ（`--long-edge full` を持たない）
  assert!(!is_full_size_raster_export_tool_version("0.5.1"));
  assert!(!is_full_size_raster_export_tool_version("0.5.0") && !is_full_size_raster_export_tool_version("0.4.3"));
}

/// API の `isPhotoCloudWorkClientUploadSupported` の区分（JPEG は大きさによらず上げない・PNG は 10MiB を超えるときだけ）。
#[test]
fn cloud_work_kind_follows_the_api_rule() {
  assert_eq!(DIRECT_RASTER_MAX_BYTES, 10 * 1024 * 1024);

  assert_eq!(cloud_work_kind("P1.RW2", 36 << 20), Some(CloudWorkKind::Raw));
  assert_eq!(cloud_work_kind("x.dng", 1), Some(CloudWorkKind::Raw));
  for name in ["x.heic", "x.HEIF", "x.tif", "x.TIFF"] {
    assert_eq!(cloud_work_kind(name, 1), Some(CloudWorkKind::Raster), "{name}");
  }
  assert_eq!(
    cloud_work_kind("x.png", DIRECT_RASTER_MAX_BYTES + 1),
    Some(CloudWorkKind::Raster)
  );
  assert_eq!(cloud_work_kind("x.PNG", DIRECT_RASTER_MAX_BYTES), None);
  for name in ["x.jpg", "x.JPEG"] {
    for size in [1, DIRECT_RASTER_MAX_BYTES + 1, 200 << 20] {
      assert_eq!(cloud_work_kind(name, size), None, "{name} {size}");
    }
  }
  assert_eq!(cloud_work_kind("x.webp", 20 << 20), None);
  assert_eq!(cloud_work_kind("noextension", 20 << 20), None);
}

#[test]
fn raster_base_version_and_meta_follow_the_worker() {
  // ワーカーの unit test と同じ: ICC を埋め込まない sRGB 扱いは icc-srgb、埋め込んだら ICC の SHA-256（小文字）
  assert_eq!(
    build_raster_base_version(None).as_deref(),
    Ok("raster.ci2.p2.e2.icc-srgb")
  );
  let sha = "a".repeat(64);
  assert_eq!(
    build_raster_base_version(Some(&sha)),
    Ok(format!("raster.ci2.p2.e2.icc-{sha}"))
  );
  for bad in ["A".repeat(64), "a".repeat(63), "g".repeat(64)] {
    assert_eq!(
      build_raster_base_version(Some(&bad)),
      Err("invalidBaseVersion"),
      "{bad}"
    );
  }

  let tool = json!({
    "kind": "raster",
    "encoding": "jpeg8",
    "width": 2560,
    "height": 1920,
    "iccSha256": "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
    "colorSpace": "kCGColorSpaceDisplayP3",
    "converted": "displayP3",
    "sourceWidth": 4032,
    "sourceHeight": 3024,
    "orientationApplied": true,
    "bytes": 123456,
    "preview": null,
    "tool": { "name": "apple-raw-linear", "version": "0.4.3" },
  });
  let parsed = parse_raster_meta(&tool).unwrap();
  // ワーカーと同じく ICC の SHA-256 は小文字にそろえる
  assert_eq!(
    parsed.icc_sha256.as_deref(),
    Some("abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789")
  );
  assert_eq!((parsed.width, parsed.height), (2560, 1920));
  // API に申告する meta はワーカーの 7 つのキーだけ（大きさ・元の寸法・ツール・パスは入れない）
  assert_eq!(
    raster_artifact_meta(&parsed, "heic"),
    json!({
      "kind": "raster",
      "encoding": "jpeg8",
      "iccSha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      "colorSpace": "kCGColorSpaceDisplayP3",
      "converted": "displayP3",
      "sourceExtension": "heic",
      "orientationApplied": true,
    })
  );
  let srgb = parse_raster_meta(&json!({
    "kind": "raster", "encoding": "jpeg8", "width": 1, "height": 1, "iccSha256": null,
    "colorSpace": "kCGColorSpaceSRGB", "converted": "srgb", "orientationApplied": false,
  }))
  .unwrap();
  assert_eq!((srgb.icc_sha256, srgb.converted.as_deref()), (None, Some("srgb")));

  // ワーカーの parseAppleRawLinearRasterMeta が断る形は invalidResponse
  let broken = |key: &str, value: Value| {
    let mut meta = tool.clone();
    if value.is_null() && key != "iccSha256" && key != "converted" {
      meta.as_object_mut().unwrap().remove(key);
    } else {
      meta[key] = value;
    }
    parse_raster_meta(&meta)
  };
  for (key, value) in [
    ("kind", json!("raw")),
    ("encoding", json!("png16-g18")),
    ("width", json!(0)),
    ("height", Value::Null),
    ("iccSha256", json!("not-a-sha")),
    ("colorSpace", json!("")),
    ("colorSpace", Value::Null),
    ("converted", json!("p3")),
    ("orientationApplied", Value::Null),
  ] {
    assert_eq!(broken(key, value.clone()), Err("invalidResponse"), "{key} {value}");
  }
  let mut no_icc_key = tool.clone();
  no_icc_key.as_object_mut().unwrap().remove("iccSha256");
  assert_eq!(parse_raster_meta(&no_icc_key), Err("invalidResponse"));
  let mut no_converted_key = tool.clone();
  no_converted_key.as_object_mut().unwrap().remove("converted");
  assert_eq!(parse_raster_meta(&no_converted_key), Err("invalidResponse"));
}

/// API の `readPhotoCloudWorkJpegFrameHeader` と同じ読み方（最初の SOF。SOF0〜SOF2 だけ受ける）。
#[test]
fn the_jpeg_frame_is_read_like_the_api() {
  let frame = parse_jpeg_frame(FAKE_RASTER_JPEG).unwrap();
  assert_eq!(
    frame,
    JpegFrame {
      width: 2560,
      height: 1707,
      precision: 8,
      components: 3
    }
  );
  assert!(frame.is_rgb8());
  // APP0・APP2（ICC）・DHT・フィルの FF を読み飛ばす
  let mut with_segments = b"\xff\xd8".to_vec();
  with_segments.extend_from_slice(b"\xff\xe0\x00\x06JFIF");
  with_segments.extend_from_slice(b"\xff\xe2\x00\x0eICC_PROFILE\x00");
  with_segments.extend_from_slice(b"\xff\xc4\x00\x03\x00");
  with_segments.extend_from_slice(b"\xff\xff");
  with_segments.extend_from_slice(&FAKE_RASTER_JPEG[2..]);
  assert_eq!(parse_jpeg_frame(&with_segments), Some(frame));
  // progressive（SOF2）も受ける。8bit でない・3 成分でないものは読めるが is_rgb8 でない
  let mut progressive = FAKE_RASTER_JPEG.to_vec();
  progressive[3] = 0xc2;
  assert_eq!(parse_jpeg_frame(&progressive).map(|frame| frame.width), Some(2560));
  let mut twelve_bit = FAKE_RASTER_JPEG.to_vec();
  twelve_bit[6] = 12;
  assert!(!parse_jpeg_frame(&twelve_bit).unwrap().is_rgb8());
  // JPEG でない・SOF3（lossless）・SOS / EOI が先・長さが壊れている・途中で切れている
  assert_eq!(parse_jpeg_frame(FAKE_PNG), None);
  let mut lossless = FAKE_RASTER_JPEG.to_vec();
  lossless[3] = 0xc3;
  assert_eq!(parse_jpeg_frame(&lossless), None);
  assert_eq!(parse_jpeg_frame(b"\xff\xd8\xff\xda\x00\x02\xff\xd9"), None);
  assert_eq!(parse_jpeg_frame(b"\xff\xd8\xff\xd9"), None);
  let mut bad_length = FAKE_RASTER_JPEG.to_vec();
  bad_length[5] = 0x12;
  assert_eq!(parse_jpeg_frame(&bad_length), None);
  assert_eq!(parse_jpeg_frame(&FAKE_RASTER_JPEG[..12]), None);
  assert_eq!(parse_jpeg_frame(b"\xff\xd8junk"), None);
}

/// ワーカーの unit test（`白の行列の表（whiteBalanceTable・S11 #17108）は作業コピーの meta のまま写す`）と同じ決まり:
/// 点検が通った表も、通らなかった `mismatch` も、表の無い校正の null も、中身を選ばずにそのまま写す。
#[test]
fn artifact_meta_keeps_the_white_balance_table() {
  let table = json!({
    "schema": "niho-develop-wb-table/v1",
    "inverseMatrices": [[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]],
    "calibrationMatrix": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
    "check": { "status": "ok", "residual": 0.0001 },
  });
  assert_eq!(
    artifact_meta(&json!({ "kind": "raw", "whiteBalanceTable": table }), "rw2")["whiteBalanceTable"],
    table
  );
  let mismatch = json!({
    "schema": "niho-develop-wb-table/v1",
    "status": "mismatch",
    "check": { "status": "mismatch", "reason": "residual" },
  });
  assert_eq!(
    artifact_meta(&json!({ "kind": "raw", "whiteBalanceTable": mismatch }), "rw2")["whiteBalanceTable"],
    mismatch
  );
  let plain = artifact_meta(&json!({ "kind": "raw", "whiteBalanceTable": null }), "rw2");
  assert_eq!(plain.get("whiteBalanceTable"), Some(&Value::Null));
}

#[test]
fn develop_input_follows_the_web_rule() {
  assert_eq!(develop_input("P1.RW2", 36 << 20), Some(DevelopInput::Raw));
  assert_eq!(develop_input("x.dng", 1), Some(DevelopInput::Raw));
  assert_eq!(develop_input("x.gpr", 1), Some(DevelopInput::Raw));
  for name in ["x.jpg", "x.JPEG", "x.png"] {
    assert_eq!(
      develop_input(name, DIRECT_RASTER_MAX_BYTES),
      Some(DevelopInput::Raster),
      "{name}"
    );
    assert_eq!(
      develop_input(name, DIRECT_RASTER_MAX_BYTES + 1),
      Some(DevelopInput::RasterWorkingCopy),
      "{name}"
    );
  }
  for name in ["x.heic", "x.HEIF", "x.tif", "x.tiff"] {
    assert_eq!(develop_input(name, 1), Some(DevelopInput::RasterWorkingCopy), "{name}");
  }
  assert_eq!(develop_input("x.webp", 1), None);
  assert_eq!(develop_input("noextension", 1), None);

  assert_eq!(export_input("P1.RW2"), Some(ExportInput::Raw));
  assert_eq!(export_input("big.jpg"), Some(ExportInput::Raster));
  assert_eq!(export_input("x.PNG"), Some(ExportInput::Raster));
  for name in ["x.heic", "x.heif", "x.tif", "x.TIFF", "x.webp"] {
    assert_eq!(export_input(name), None, "{name}");
  }
}

#[test]
fn decoder_and_tool_versions_follow_the_worker() {
  let versions = |list: &[&str]| list.iter().map(|version| version.to_string()).collect::<Vec<_>>();
  assert_eq!(select_decoder_version(&versions(&["7", "8"])), Some("8"));
  assert_eq!(select_decoder_version(&versions(&["8.dng", "7.dng"])), Some("8.dng"));
  assert_eq!(select_decoder_version(&versions(&["8.dng", "8"])), Some("8"));
  assert_eq!(select_decoder_version(&versions(&["7"])), None);
  assert!(is_compatible_tool_version("0.4.1"));
  assert!(is_compatible_tool_version("0.4.12"));
  assert!(is_compatible_tool_version("0.5.0"));
  assert!(is_compatible_tool_version("0.5.12"));
  assert!(!is_compatible_tool_version("0.6.0"));
  assert!(!is_compatible_tool_version("1.0.0"));
  assert!(!is_compatible_tool_version("0.40.0"));
  assert!(!is_compatible_tool_version("0.4"));
  assert!(!is_compatible_tool_version("0.4.1-dev"));
  assert_eq!(
    parse_version_line("apple-raw-linear", "apple-raw-linear 0.4.1\n").as_deref(),
    Some("0.4.1")
  );
  assert_eq!(
    parse_version_line(
      "niho-develop-render",
      "niho-develop-render 0.2.0 (niho-develop 0.2.0, engine niho-1)\n"
    )
    .as_deref(),
    Some("0.2.0")
  );
  assert_eq!(parse_version_line("apple-raw-linear", "apple-raw-linearx 0.4.1"), None);
  assert_eq!(parse_version_line("apple-raw-linear", "apple-raw-linear dev"), None);
}

// --- sidecar の確かめ・キャッシュ・待ち行列（写真を開かない） ---

#[test]
fn cache_sweep_removes_the_least_recently_used_over_the_limit() {
  let harness = SidecarHarness::new("sweep");
  let dir = harness.cache_dir();
  let cache = DevelopCache::new(dir.clone(), CACHE_MAX_BYTES);
  let now = SystemTime::now();
  let work = cache.work_dir().unwrap();
  let mut stored = Vec::new();
  for (index, key) in ["a", "b", "c"].iter().enumerate() {
    let made = work.path.join(format!("{key}.png"));
    fs::write(&made, vec![0u8; 40]).unwrap();
    let cached = cache
      .store(
        cache.generation(),
        &CacheEntry {
          key: &key.repeat(64),
          recipe: "recipe",
          renderer: "apple-raw-linear",
          base_version: "raw-apple.d8.p2.e1.cal-none.lens-apple",
          meta: &json!({}),
          format: WorkCopyFormat::Png,
        },
        &made,
      )
      .unwrap();
    set_modified(&cached.file, now - Duration::from_secs(300 - index as u64 * 100));
    stored.push(cached);
  }
  drop(work);
  // 片方だけ残った古い作業コピー・古い一時フォルダ・古い書きかけの記録・キャッシュでないファイル
  let orphan = dir.join(format!("{}-raster.ci1.p1.e1.icc-srgb.png", "d".repeat(64)));
  fs::write(&orphan, b"x").unwrap();
  set_modified(&orphan, now - Duration::from_secs(2 * 60 * 60));
  let fresh_orphan = dir.join(format!("{}-raster.ci1.p1.e1.icc-srgb.png", "e".repeat(64)));
  fs::write(&fresh_orphan, b"x").unwrap();
  let fresh_work = dir.join("work-purge-now");
  fs::create_dir_all(&fresh_work).unwrap();
  fs::write(fresh_work.join("full.png"), b"recent photo data").unwrap();
  let stale_work = dir.join("work-stale");
  fs::create_dir_all(&stale_work).unwrap();
  // フォルダの更新日時は読み取りで開いて変える（持ち主なら futimens できる）
  fs::File::open(&stale_work)
    .unwrap()
    .set_modified(now - Duration::from_secs(2 * 60 * 60))
    .unwrap();
  let stale_tmp = dir.join(format!(
    "{}-raw-apple.d8.p2.e1.cal-none.lens-apple.json.tmp",
    "f".repeat(64)
  ));
  fs::write(&stale_tmp, b"{").unwrap();
  set_modified(&stale_tmp, now - Duration::from_secs(2 * 60 * 60));
  fs::write(dir.join("notes.txt"), b"keep").unwrap();

  // 上限の内なら古い片割れ・一時フォルダ・書きかけだけを消す
  let swept = cache.sweep(&[], now);
  assert_eq!(swept.removed, 1, "{swept:?}");
  assert!(!orphan.exists() && fresh_orphan.exists());
  assert!(fresh_work.exists(), "regular sweep keeps a recent work directory");
  assert!(!stale_work.exists() && !stale_tmp.exists());
  assert!(stored
    .iter()
    .all(|cached| cached.file.exists() && cached.record.exists()));
  // 3 組の合計を上限にすると（新しい片割れの 1 バイトの分だけ超える）、最終利用の古い順に 1 組消す。keep の「a」は残して「b」
  let pair = |cached: &CachedWorkingCopy| {
    fs::metadata(&cached.file).unwrap().len() + fs::metadata(&cached.record).unwrap().len()
  };
  let limit: u64 = stored.iter().map(pair).sum();
  let limited = DevelopCache::new(dir.clone(), limit);
  let swept = limited.sweep(&[stored[0].file.clone()], now);
  assert_eq!(swept.removed, 1, "{swept:?}");
  assert!(swept.total_bytes <= limit);
  assert!(stored[0].file.exists() && !stored[1].file.exists() && !stored[1].record.exists() && stored[2].file.exists());
  assert!(fresh_orphan.exists());
  assert!(dir.join("notes.txt").exists());
  // 見つけるときは記録と大きさを照らす（作り方が違う・PNG が欠けたものは返さない）
  assert!(cache.find(&"c".repeat(64), "recipe", None).is_some());
  assert!(cache
    .find(
      &"c".repeat(64),
      "recipe",
      Some("raw-apple.d8.p2.e1.cal-none.lens-apple"),
    )
    .is_some());
  assert!(cache
    .find(
      &"c".repeat(64),
      "recipe",
      Some("raw-apple.d8.p3.e4.cal-none.lens-apple"),
    )
    .is_none());
  assert!(cache.find(&"c".repeat(64), "other recipe", None).is_none());
  fs::write(&stored[2].file, b"short").unwrap();
  assert!(cache.find(&"c".repeat(64), "recipe", None).is_none());
  let analysis = dir.join(format!("{}{}", "a".repeat(64), ANALYSIS_CACHE_SUFFIX));
  fs::write(&analysis, b"derived analysis").unwrap();
  // cache_purge は作業コピーと写真から作った解析を消す
  let purged = cache.purge();
  assert!(purged.removed >= 2, "{purged:?}");
  assert!(!stored[0].file.exists() && !fresh_orphan.exists() && !analysis.exists());
  assert!(
    !fresh_work.exists(),
    "explicit purge removes a recent work directory too"
  );
  assert!(dir.join("notes.txt").exists());
}

#[test]
fn a_failed_probe_is_retried_once_and_a_success_is_kept() {
  let harness = SidecarHarness::new("probe-retry");
  // 起動直後の確かめが失敗しても、次（handshake）で 1 回だけやり直す
  harness.mark("registry-exit", "");
  let develop = harness.develop();
  assert!(!develop.is_available());
  harness.unmark("registry-exit");
  assert!(develop.is_available());
  let probes = harness.lines("calls.txt").len();
  assert!(develop.is_available());
  assert_eq!(harness.lines("calls.txt").len(), probes, "a success is kept");
  assert!(harness.has_log("\"attempt\":2"));

  // 2 回とも失敗したら、アプリを閉じるまで確かめ直さない（handshake のたびに sidecar を動かさない）
  harness.mark("registry-exit", "");
  let failing = harness.develop();
  assert!(!failing.is_available());
  assert!(!failing.is_available());
  let probes = harness.lines("calls.txt").len();
  harness.unmark("registry-exit");
  assert!(!failing.is_available());
  assert_eq!(harness.lines("calls.txt").len(), probes);
  // 確かめの時間の上限は 10 秒（handshake が待つので info の 30 秒より短い）
  assert_eq!(DevelopTimeouts::default().probe, Duration::from_secs(10));
}

#[test]
fn cached_capability_query_does_not_wait_for_a_running_probe() {
  let harness = SidecarHarness::new("probe-handshake-snapshot");
  let develop = harness.develop();
  let probe_lock = lock(&develop.probe);
  let (tx, rx) = mpsc::channel();
  let worker_develop = develop.clone();
  let worker = std::thread::spawn(move || tx.send(worker_develop.is_available_cached()).unwrap());
  let result = rx.recv_timeout(Duration::from_millis(250));
  drop(probe_lock);
  worker.join().unwrap();
  assert!(
    matches!(result, Ok(false)),
    "a cached capability query returns false without waiting for the probe: {result:?}"
  );
}

#[test]
fn cache_purge_refuses_active_work_and_rejects_new_work_until_complete() {
  let harness = SidecarHarness::new("purge-active");
  let develop = harness.develop();
  let active = develop.begin().unwrap();
  let mut other_cache_purged = false;
  let err = develop
    .with_cache_purge(|| {
      other_cache_purged = true;
      Ok::<(), PageError>(())
    })
    .unwrap_err();
  assert_eq!(err.code, "cache_purge_failed");
  assert!(
    !other_cache_purged,
    "the overall purge is rejected before deleting other cache data"
  );
  drop(active);

  let (entered_tx, entered_rx) = mpsc::channel();
  let (continue_tx, continue_rx) = mpsc::channel();
  let purge_develop = develop.clone();
  let purge = std::thread::spawn(move || {
    purge_develop.with_cache_purge(|| {
      entered_tx.send(()).unwrap();
      continue_rx.recv().unwrap();
      Ok::<(), PageError>(())
    })
  });
  entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
  assert!(
    *lock(&develop.activity_gate),
    "the gate stays closed for the whole purge"
  );
  assert!(develop.has_work_in_flight(), "restart guards include a cache purge");
  let err = match develop.begin() {
    Ok(_) => panic!("new work must be rejected during purge"),
    Err(err) => err,
  };
  assert_eq!(err.message, CACHE_PURGING_MESSAGE);
  continue_tx.send(()).unwrap();
  purge.join().unwrap().unwrap();
  assert!(!*lock(&develop.activity_gate), "the gate reopens when purge completes");
  assert!(!develop.has_work_in_flight());
  let after_purge = develop.begin();
  assert!(after_purge.is_ok());
  drop(after_purge);
}

#[cfg(target_os = "macos")]
#[test]
fn exclusive_rename_does_not_replace_an_existing_destination() {
  let harness = SidecarHarness::new("exclusive-rename");
  let pending = harness.dir.join("pending.jpg");
  let destination = harness.dir.join("destination.jpg");
  fs::write(&pending, b"new photo").unwrap();
  fs::write(&destination, b"keep existing photo").unwrap();
  let err = rename_exclusive(&pending, &destination).unwrap_err();
  assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
  assert_eq!(fs::read(&destination).unwrap(), b"keep existing photo");
  assert_eq!(fs::read(&pending).unwrap(), b"new photo");
}

#[test]
fn a_working_copy_made_across_a_cache_purge_is_not_kept() {
  let harness = SidecarHarness::new("purge-generation");
  let cache = DevelopCache::new(harness.cache_dir(), CACHE_MAX_BYTES);
  let work = cache.work_dir().unwrap();
  let made = work.path.join("work.png");
  fs::write(&made, b"pixels").unwrap();
  let generation = cache.generation();
  cache.purge();
  let err = cache
    .store(
      generation,
      &CacheEntry {
        key: &"a".repeat(64),
        recipe: "recipe",
        renderer: "apple-raw-linear",
        base_version: "raw-apple.d8.p2.e1.cal-none.lens-apple",
        meta: &json!({}),
        format: WorkCopyFormat::Png,
      },
      &made,
    )
    .unwrap_err();
  assert_eq!(err.kind(), io::ErrorKind::Interrupted);
  assert!(!made.exists());
  drop(work);
  assert!(harness.cache_names().is_empty(), "{:?}", harness.cache_names());
  // 世代が合えば置ける
  let work = cache.work_dir().unwrap();
  let made = work.path.join("work.png");
  fs::write(&made, b"pixels").unwrap();
  assert!(cache
    .store(
      cache.generation(),
      &CacheEntry {
        key: &"a".repeat(64),
        recipe: "recipe",
        renderer: "apple-raw-linear",
        base_version: "raw-apple.d8.p2.e1.cal-none.lens-apple",
        meta: &json!({}),
        format: WorkCopyFormat::Png
      },
      &made
    )
    .is_ok());
}

#[test]
fn raw_stage_diagnostics_only_exposes_finite_allowlisted_times() {
  let value = serde_json::json!({
    "input": { "path": "fixture-input.rw2" },
    "timingMs": { "decodeRender": 21.5, "encode": 3, "lens": -1,
      "color": "not-a-time", "path": "fixture-input.rw2", "serialNumber": 99 }
  });
  assert_eq!(raw_stage_timings(&value), vec![("decode", 21.5), ("encode", 3.0)]);
}
