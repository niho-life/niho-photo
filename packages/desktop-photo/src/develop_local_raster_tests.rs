//! {@link LocalRaster::Camera}（NIHO camera。C3 #18391）の作業コピーと原寸の書き出しのテスト。偽の sidecar
//! （`test_support::develop`）と、写真を開いたことにする偽の {@link DevelopPhotos} で確かめる。

use super::*;
use crate::saved_settings::content_digest;
use crate::test_support::develop::*;
use std::collections::HashMap;
use std::fs;

/// 開いた写真（`photoId` → ファイル）と、面の置き場（面の id → PNG のバイト列）。
struct FakePhotos {
  photos: HashMap<String, OpenPhoto>,
  has_saved_settings: bool,
  surfaces: HashMap<String, Vec<u8>>,
}

impl FakePhotos {
  fn new(files: &[(&str, &Path)]) -> Self {
    let photos = files
      .iter()
      .map(|(photo_id, path)| {
        let open = OpenPhoto {
          path: path.to_path_buf(),
          file_name: path.file_name().unwrap().to_string_lossy().into_owned(),
          digest: content_digest(path).unwrap(),
        };
        (photo_id.to_string(), open)
      })
      .collect();
    Self {
      photos,
      has_saved_settings: false,
      surfaces: HashMap::new(),
    }
  }

  fn with_saved_settings(mut self) -> Self {
    self.has_saved_settings = true;
    self
  }

  fn with_surface(mut self, id: &str, bytes: &[u8]) -> Self {
    self.surfaces.insert(id.to_string(), bytes.to_vec());
    self
  }
}

impl DevelopPhotos for FakePhotos {
  fn open_photo(&self, photo_id: &str) -> Option<OpenPhoto> {
    self.photos.get(photo_id).cloned()
  }

  fn has_saved_settings(&self, _photo_id: &str) -> bool {
    self.has_saved_settings
  }

  fn mask_surface(&self, _photo_id: &str, surface_id: &str) -> Option<Vec<u8>> {
    self.surfaces.get(surface_id).cloned()
  }
}

fn camera_develop(harness: &SidecarHarness) -> Arc<PhotoDevelop> {
  harness.develop_with(|config| config.local_raster = LocalRaster::Camera)
}

fn photo_file(harness: &SidecarHarness, name: &str, bytes: &[u8]) -> PathBuf {
  let path = harness.dir.join("photos").join(name);
  fs::create_dir_all(path.parent().unwrap()).unwrap();
  let extension = path.extension().and_then(|value| value.to_str()).unwrap_or_default();
  let mut contents = match extension.to_ascii_lowercase().as_str() {
    "jpg" | "jpeg" => b"\xff\xd8\xff".to_vec(),
    "png" => b"\x89PNG\r\n\x1a\n".to_vec(),
    "tif" | "tiff" => b"II*\0".to_vec(),
    "rw2" => b"IIU\0".to_vec(),
    "heic" | "heif" => b"\0\0\0\x14ftypheic\0\0\0\0mif1".to_vec(),
    _ => Vec::new(),
  };
  contents.extend_from_slice(bytes);
  fs::write(&path, contents).unwrap();
  path
}

#[test]
fn camera_input_rules_follow_the_web_and_desktop_keeps_its_own() {
  let camera = LocalRaster::Camera;
  assert_eq!(develop_input_for("P1.RW2", 36 << 20, camera), Some(DevelopInput::Raw));
  // JPEG は 64MiB まで、PNG は 10MiB までオリジナルのまま（web の develop-work-target.ts と同じ）
  for name in ["a.jpg", "a.JPEG"] {
    assert_eq!(
      develop_input_for(name, DIRECT_JPEG_MAX_BYTES, camera),
      Some(DevelopInput::Raster),
      "{name}"
    );
    assert_eq!(
      develop_input_for(name, DIRECT_JPEG_MAX_BYTES + 1, camera),
      Some(DevelopInput::RasterWorkingCopy),
      "{name}"
    );
  }
  assert_eq!(
    develop_input_for("a.png", DIRECT_RASTER_MAX_BYTES, camera),
    Some(DevelopInput::Raster)
  );
  assert_eq!(
    develop_input_for("a.png", DIRECT_RASTER_MAX_BYTES + 1, camera),
    Some(DevelopInput::RasterWorkingCopy)
  );
  for name in ["a.heic", "a.HEIF", "a.tif", "a.tiff"] {
    assert_eq!(
      develop_input_for(name, 1, camera),
      Some(DevelopInput::RasterWorkingCopy),
      "{name}"
    );
  }
  assert_eq!(develop_input_for("a.webp", 1, camera), None);
  // NIHO Desktop は今までどおり JPEG も 10MiB まで
  assert_eq!(
    develop_input("a.jpg", DIRECT_RASTER_MAX_BYTES + 1),
    Some(DevelopInput::RasterWorkingCopy)
  );
  assert_eq!(
    develop_input_for("a.jpg", DIRECT_RASTER_MAX_BYTES + 1, LocalRaster::Desktop),
    Some(DevelopInput::RasterWorkingCopy)
  );

  assert_eq!(export_input_for("P1.RW2", camera), Some(ExportInput::Raw));
  assert_eq!(export_input_for("big.jpg", camera), Some(ExportInput::Raster));
  for name in ["a.heic", "a.HEIF", "a.tif", "a.TIFF"] {
    assert_eq!(
      export_input_for(name, camera),
      Some(ExportInput::RasterFullSize),
      "{name}"
    );
    assert_eq!(
      export_input(name),
      None,
      "Desktop は HEIC / TIFF を原寸で書き出さない: {name}"
    );
  }
}

#[test]
fn camera_makes_raster_working_copies_with_apple_raw_linear() {
  let harness = SidecarHarness::new("camera-raster-source");
  let develop = camera_develop(&harness);
  let heic = photo_file(&harness, "IMG_0001.HEIC", b"heic bytes");
  let photos = FakePhotos::new(&[("p1", &heic)]);

  let value = develop.source(&photos, "p1").unwrap();
  assert_eq!(value["kind"], json!("workingCopy"));
  let base_version = value["baseVersion"].as_str().unwrap();
  assert!(
    base_version.starts_with("raster.ci2."),
    "ワーカー・クラウドと同じ raster の作業コピー: {base_version}"
  );
  let calls = harness.work_calls();
  assert!(
    calls
      .iter()
      .any(|call| call.starts_with("apple-raw-linear raster ") && call.contains(" --long-edge 2560")),
    "{calls:?}"
  );
  let bytes = develop
    .source_bytes(&photos, "p1", value["token"].as_str().unwrap())
    .unwrap();
  assert_eq!(bytes, FAKE_RASTER_JPEG);

  // 2 回目はキャッシュから（作り直さない）
  let again = develop.source(&photos, "p1").unwrap();
  assert_eq!(again["baseVersion"], value["baseVersion"]);
  assert_eq!(
    harness
      .work_calls()
      .iter()
      .filter(|call| call.starts_with("apple-raw-linear raster "))
      .count(),
    1
  );
}

#[test]
fn a_jpeg_stays_the_original_unless_a_working_copy_is_forced() {
  let harness = SidecarHarness::new("camera-force-working-copy");
  let develop = camera_develop(&harness);
  let jpeg = photo_file(&harness, "DSC0001.JPG", b"jpeg bytes");
  let photos = FakePhotos::new(&[("p1", &jpeg)]);

  let original = develop.source(&photos, "p1").unwrap();
  assert_eq!(original["kind"], json!("raster"));
  assert_eq!(
    develop
      .source_bytes(&photos, "p1", original["token"].as_str().unwrap())
      .unwrap(),
    b"\xff\xd8\xffjpeg bytes"
  );
  assert!(harness.work_calls().is_empty(), "{:?}", harness.work_calls());

  // 画面が開いて 4,000 万画素を超えると分かった JPEG は作業コピーで開き直す
  let forced = develop.source_with_options(&photos, "p1", None, true).unwrap();
  assert_eq!(forced["kind"], json!("workingCopy"));
  assert!(forced["baseVersion"].as_str().unwrap().starts_with("raster.ci2."));
}

#[test]
fn raw_source_context_generates_only_new_signed_and_restores_exact_drafts() {
  let harness = SidecarHarness::new("camera-signed-source-context");
  harness.mark("tool-version", "0.5.0");
  let develop = harness.develop_with(|config| config.signed_raw_generation = true);
  let legacy_path = photo_file(&harness, "legacy.RW2", b"legacy raw");
  let signed_path = photo_file(&harness, "signed.RW2", b"signed raw");
  let draft_path = photo_file(&harness, "draft.RW2", b"draft raw");
  let photos = FakePhotos::new(&[
    ("legacy", &legacy_path),
    ("signed", &signed_path),
    ("draft", &draft_path),
  ]);

  // flags 欠落は保守的に unsigned。後から新規contextが来ても既存cacheを昇格させない。
  let legacy = develop.source(&photos, "legacy").unwrap();
  assert!(legacy["baseVersion"].as_str().unwrap().contains(".p2.e1."));
  let still_legacy = develop
    .source_with_options_context(
      &photos,
      "legacy",
      Some(DevelopSourceContext {
        has_saved_develop_settings: false,
        has_develop_edits: false,
        base_version: None,
      }),
      false,
    )
    .unwrap();
  assert_eq!(still_legacy["baseVersion"], legacy["baseVersion"]);

  let signed = develop
    .source_with_options_context(
      &photos,
      "signed",
      Some(DevelopSourceContext {
        has_saved_develop_settings: false,
        has_develop_edits: false,
        base_version: None,
      }),
      false,
    )
    .unwrap();
  assert!(signed["baseVersion"].as_str().unwrap().contains(".p3.e4."));

  // producer条件を満たさない編集中draftは、その exact unsigned baseを復元する。
  let old_base = "raw-apple.d8.p2.e1.cal-panasonic-dc-s5-apple-v2.lens-apple";
  let draft = develop
    .source_with_options_context(
      &photos,
      "draft",
      Some(DevelopSourceContext {
        has_saved_develop_settings: false,
        has_develop_edits: true,
        base_version: Some(old_base.into()),
      }),
      false,
    )
    .unwrap();
  assert_eq!(draft["baseVersion"], old_base);

  // 保存ストアが保存ありなら、画面が新規と誤申告してもsignedへ昇格しない。
  let saved_photos =
    FakePhotos::new(&[("saved", &photo_file(&harness, "saved.RW2", b"saved raw"))]).with_saved_settings();
  let saved = develop
    .source_with_options_context(
      &saved_photos,
      "saved",
      Some(DevelopSourceContext {
        has_saved_develop_settings: false,
        has_develop_edits: false,
        base_version: None,
      }),
      false,
    )
    .unwrap();
  assert!(saved["baseVersion"].as_str().unwrap().contains(".p2.e1."));
}

#[test]
fn producer_off_still_restores_a_saved_signed_source() {
  let harness = SidecarHarness::new("camera-signed-source-reader-after-rollback");
  harness.mark("tool-version", "0.5.0");
  let develop = harness.develop_with(|config| config.signed_raw_generation = false);
  let raw = photo_file(&harness, "saved.RW2", b"saved signed raw");
  let photos = FakePhotos::new(&[("saved", &raw)]).with_saved_settings();
  let base = "raw-apple.d8.p3.e4.cal-panasonic-dc-s5-apple-v4.lens-apple";
  let source = develop
    .source_with_options_context(
      &photos,
      "saved",
      Some(DevelopSourceContext {
        has_saved_develop_settings: true,
        has_develop_edits: true,
        base_version: Some(base.into()),
      }),
      false,
    )
    .unwrap();
  assert_eq!(source["baseVersion"], base);
  assert!(harness
    .work_calls()
    .iter()
    .any(|call| call.contains("--encoding png16-signed-g18")));
}

#[test]
fn native_signed_export_defaults_follow_render_version_and_known_calibration() {
  let run = |name: &str, render_version: &str, generic: bool| {
    let harness = SidecarHarness::new(name);
    harness.mark("tool-version", "0.5.0");
    harness.mark("render-version", render_version);
    if generic {
      harness.mark(
        "wc-meta.json",
        r#"{"kind":"raw","dcpSha256":"apple-ciraw8/linear-prophoto-d50/cal-other-apple-v1","_source":{"tool":{"name":"apple-raw-linear","version":"0.5.0"},"decoderVersion":"8","camera":{"make":"OTHER","model":"RAW"},"calibration":{"id":"cal-other-apple-v1","cameraId":"other","track":"apple","version":"v1","baseVersion":"p3"},"lensCorrection":{"mode":"apple"}}}"#,
      );
    }
    let develop = harness.develop_with(|config| config.signed_raw_generation = true);
    let raw = photo_file(&harness, "new.RW2", name.as_bytes());
    let photos = FakePhotos::new(&[("new", &raw)]);
    let destination = harness.dir.join("out").join("new.jpg");
    fs::create_dir_all(destination.parent().unwrap()).unwrap();
    develop
      .export_with_saved_state(
        &photos,
        "new",
        &json!({ "v": 1, "engine": "niho-2", "look": "niho-standard-1", "base": null }),
        false,
        false,
        &destination,
        Overwrite::Never,
      )
      .unwrap();
    serde_json::from_slice::<Value>(&fs::read(harness.sidecars.join("last-settings.json")).unwrap()).unwrap()
  };

  let hue_stable = run("export-known-signed-niho11", "0.18.0", false);
  assert_eq!(
    (&hue_stable["engine"], &hue_stable["look"]),
    (&json!("niho-11"), &json!("niho-standard-5"))
  );
  let previous = run("export-known-signed-0-17", "0.17.0", false);
  assert_eq!(
    (&previous["engine"], &previous["look"]),
    (&json!("niho-7"), &json!("niho-standard-5"))
  );
  let current = run("export-known-signed-niho7", "0.16.0", false);
  assert_eq!(
    (&current["engine"], &current["look"]),
    (&json!("niho-7"), &json!("niho-standard-5"))
  );
  let old = run("export-known-signed-old-native", "0.15.9", false);
  assert_eq!(
    (&old["engine"], &old["look"]),
    (&json!("niho-4"), &json!("niho-standard-3"))
  );
  let generic = run("export-generic-signed", "0.16.0", true);
  assert_eq!(
    (&generic["engine"], &generic["look"]),
    (&json!("niho-3"), &json!("niho-standard-2"))
  );
}

#[test]
fn saved_old_export_pairs_and_exact_bases_are_preserved_on_new_native() {
  let harness = SidecarHarness::new("export-saved-old-pairs-preserved");
  harness.mark("tool-version", "0.5.0");
  harness.mark("render-version", "0.16.0");
  let develop = harness.develop_with(|config| config.signed_raw_generation = true);
  let cases = [
    (
      "saved-2",
      "raw-apple.d8.p2.e1.cal-panasonic-dc-s5-apple-v2.lens-apple",
      "niho-2",
      "niho-standard-1",
    ),
    (
      "saved-3",
      "raw-apple.d8.p3.e4.cal-panasonic-dc-s5-apple-v4.lens-apple",
      "niho-3",
      "niho-standard-2",
    ),
    (
      "saved-4",
      "raw-apple.d8.p3.e4.cal-panasonic-dc-s5-apple-v4.lens-apple",
      "niho-4",
      "niho-standard-3",
    ),
  ];
  for (photo_id, base, engine, look) in cases {
    let raw = photo_file(&harness, &format!("{photo_id}.RW2"), photo_id.as_bytes());
    let photos = FakePhotos::new(&[(photo_id, &raw)]).with_saved_settings();
    let settings = json!({ "v": 1, "engine": engine, "look": look, "base": base, "exposure": 0.4 });
    let destination = harness.dir.join("out").join(format!("{photo_id}.jpg"));
    fs::create_dir_all(destination.parent().unwrap()).unwrap();
    develop
      .export_with_saved_state(&photos, photo_id, &settings, true, true, &destination, Overwrite::Never)
      .unwrap();
    let rendered: Value =
      serde_json::from_slice(&fs::read(harness.sidecars.join("last-settings.json")).unwrap()).unwrap();
    assert_eq!(rendered, settings);
  }
  let calls = harness.work_calls();
  assert!(calls.iter().any(|call| call.contains("--encoding png16-g18")));
  assert!(
    calls
      .iter()
      .filter(|call| call.contains("--encoding png16-signed-g18"))
      .count()
      >= 2
  );
}

#[test]
fn camera_exports_heic_at_full_size_through_raster_then_develop_render() {
  let harness = SidecarHarness::new("camera-heic-export");
  harness.mark("tool-version", "0.5.2");
  let develop = camera_develop(&harness);
  let heic = photo_file(&harness, "IMG_0001.HEIC", b"heic bytes");
  let photos = FakePhotos::new(&[("p1", &heic)]);
  let destination = harness.dir.join("out").join("IMG_0001.jpg");
  fs::create_dir_all(destination.parent().unwrap()).unwrap();

  assert!(develop.check_export(&photos, "p1").is_ok());
  develop
    .export(
      &photos,
      "p1",
      &json!({ "exposure": 0.5 }),
      &destination,
      Overwrite::Never,
    )
    .unwrap();
  assert_eq!(fs::read(&destination).unwrap(), b"JPEG");

  let calls = harness.work_calls();
  let raster = calls
    .iter()
    .position(|call| call.starts_with("apple-raw-linear raster "))
    .expect("raster");
  assert!(calls[raster].contains(" --long-edge full"), "{}", calls[raster]);
  assert!(
    calls[raster].contains(heic.to_str().unwrap()),
    "原本の HEIC から描く: {}",
    calls[raster]
  );
  let render = calls
    .iter()
    .position(|call| call.starts_with("niho-develop-render render "))
    .expect("develop");
  assert!(raster < render, "{calls:?}");
  assert!(
    calls[render].contains(" --raster ") && calls[render].contains("work.jpg"),
    "原寸の raster の JPEG を段 2 へ: {}",
    calls[render]
  );
  assert!(
    !calls[render].contains(heic.to_str().unwrap()),
    "HEIC を直に段 2 へ渡さない: {}",
    calls[render]
  );
  let encode = calls
    .iter()
    .find(|call| call.starts_with("apple-raw-linear encode-jpeg "))
    .expect("encode");
  assert!(
    encode.contains(&format!("--metadata-from {}", heic.display())),
    "撮影日時は原本から: {encode}"
  );
  assert!(
    !calls.iter().any(|call| call.starts_with("apple-raw-linear render ")),
    "RAW 専用の render を使わない: {calls:?}"
  );
}

#[test]
fn heic_is_not_exported_at_full_size_by_desktop_or_an_old_apple_raw_linear() {
  let harness = SidecarHarness::new("camera-heic-export-unsupported");
  let heic = photo_file(&harness, "IMG_0001.HEIC", b"heic bytes");
  let photos = FakePhotos::new(&[("p1", &heic)]);
  let destination = harness.dir.join("IMG_0001.jpg");

  // NIHO Desktop は HEIC / TIFF の原寸書き出し能力を本 Issue では広げない。
  let desktop = harness.develop();
  assert_eq!(
    desktop.check_export(&photos, "p1").unwrap_err().code,
    develop_code::UNSUPPORTED_SOURCE
  );

  // full-size export を持たない apple-raw-linear（0.5.2 より前。0.5.1 は登録表の fallback だけ・0.5.0 は作業コピー用 raster を持つ）
  harness.mark("tool-version", "0.5.1");
  let camera = camera_develop(&harness);
  assert_eq!(
    camera.check_export(&photos, "p1").unwrap_err().code,
    develop_code::UNSUPPORTED_SOURCE
  );
  let err = camera
    .export(&photos, "p1", &json!({}), &destination, Overwrite::Never)
    .unwrap_err();
  assert_eq!(err.code, develop_code::UNSUPPORTED_SOURCE);
  assert!(!destination.exists());
}

#[test]
fn local_masks_are_exported_only_by_a_render_sidecar_that_draws_them() {
  let masked = json!({
    "v": 5, "engine": "niho-10", "look": "niho-standard-1", "base": null,
    "masks": [{
      "id": "m1", "kind": "linear", "zero": { "x": 0.5, "y": 0.2 }, "full": { "x": 0.5, "y": 0.5 },
      "adjust": { "exposure": -0.7 }
    }]
  });
  for (version, draws) in [("0.18.0", false), (MASKS_MIN_RENDER_VERSION, true), ("0.19.1", true)] {
    let harness = SidecarHarness::new(&format!("export-masks-{version}"));
    harness.mark("render-version", version);
    let develop = camera_develop(&harness);
    let jpeg = photo_file(&harness, "IMG_0002.jpg", b"jpeg bytes");
    let photos = FakePhotos::new(&[("p1", &jpeg)]);
    let destination = harness.dir.join("out").join("IMG_0002.jpg");
    fs::create_dir_all(destination.parent().unwrap()).unwrap();
    let result = develop.export(&photos, "p1", &masked, &destination, Overwrite::Never);
    let rendered = harness
      .work_calls()
      .iter()
      .any(|call| call.starts_with("niho-develop-render render "));
    assert_eq!(develop.is_masks_export_available_cached(), draws, "{version}");
    if draws {
      result.unwrap();
      assert!(rendered, "{version}");
      let sent: Value =
        serde_json::from_slice(&fs::read(harness.sidecars.join("last-settings.json")).unwrap()).unwrap();
      assert_eq!(sent["masks"], masked["masks"], "the masks reach the sidecar as saved");
    } else {
      let error = result.unwrap_err();
      assert_eq!(error.code, develop_code::UNSUPPORTED_SETTINGS);
      assert!(error.detail.contains(MASKS_MIN_RENDER_VERSION), "{}", error.detail);
      assert!(!rendered, "an old sidecar never gets the masks");
      assert!(!destination.exists());
      // Without masks (or with an empty list) the same sidecar still exports.
      for settings in [json!({ "exposure": 0.5 }), json!({ "v": 5, "masks": [] })] {
        develop
          .export(&photos, "p1", &settings, &destination, Overwrite::Allowed)
          .unwrap();
      }
    }
  }
}

/// `niho-develop-render capabilities` の 1 行（0.26.0 と同じ形）。`versions` は読める `v`。
fn render_capabilities_line(versions: &[u32], features: &[&str]) -> String {
  json!({
    "tool": "niho-develop-render",
    "version": "0.26.0",
    "settingsVersions": versions,
    "engines": ["niho-1", "niho-2", "niho-10", "niho-14"],
    "features": features,
    "maskKinds": ["linear", "radial", "brush", "subject", "sky"],
    "maxMasks": 8,
    "maxPixels": 40_000_000,
  })
  .to_string()
}

#[test]
fn render_capabilities_are_read_only_from_their_own_shape() {
  let line = render_capabilities_line(&[1, 2, 3, 4, 5, 6, 7, 8, 9], &["colorGradingLuminance"]);
  let capabilities = RenderCapabilities::parse(&format!("{line}\n")).unwrap();
  assert_eq!(capabilities.settings_versions, vec![1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert_eq!(capabilities.engines, vec!["niho-1", "niho-2", "niho-10", "niho-14"]);
  assert_eq!(capabilities.features, vec!["colorGradingLuminance"]);
  assert_eq!(capabilities.max_pixels, 40_000_000);
  assert_eq!(
    capabilities.to_json(),
    json!({
      "settingsVersions": [1, 2, 3, 4, 5, 6, 7, 8, 9],
      "engines": ["niho-1", "niho-2", "niho-10", "niho-14"],
      "features": ["colorGradingLuminance"],
      "maskKinds": ["linear", "radial", "brush", "subject", "sky"],
      "maxPixels": 40_000_000,
    })
  );
  let base: Value = serde_json::from_str(&line).unwrap();
  let broken = |key: &str, value: Value| {
    let mut broken = base.clone();
    broken[key] = value;
    RenderCapabilities::parse(&broken.to_string())
  };
  assert!(RenderCapabilities::parse("").is_none());
  assert!(RenderCapabilities::parse(r#"{"error":"invalid_arguments","message":"x"}"#).is_none());
  assert!(broken("tool", json!("apple-raw-linear")).is_none());
  assert!(broken("settingsVersions", json!([])).is_none());
  assert!(broken("settingsVersions", json!([1, "2"])).is_none());
  assert!(broken("settingsVersions", json!([0])).is_none());
  assert!(broken("engines", json!([])).is_none());
  assert!(broken("engines", json!(["niho-1", 2])).is_none());
  assert!(broken("features", json!("colorGradingLuminance")).is_none());
  assert!(broken("maskKinds", Value::Null).is_none());
  assert!(broken("maxPixels", json!(0)).is_none());
  assert!(broken("maxPixels", json!(-1)).is_none());
  assert!(broken("engines", json!(vec!["niho-1"; 65])).is_none());
}

#[test]
fn render_capabilities_decide_which_settings_reach_the_full_size_render() {
  let lens = json!({
    "v": 9, "engine": "niho-14", "look": "niho-standard-1", "base": null,
    "lens": { "vignetting": -10 },
    "colorGrading": { "midtone": { "luminance": 12 } }
  });
  let new_engine = json!({ "v": 1, "engine": "niho-15", "look": "niho-standard-1", "base": null });
  let luminance = json!({
    "v": 1, "engine": "niho-14", "look": "niho-standard-1", "base": null,
    "colorGrading": { "global": { "luminance": -5 } }
  });

  // 0.16.0 相当（答えない）: 描ける設定は分からない。遮断は画面の側（ここでは渡したものをそのまま描かせる）
  let old = SidecarHarness::new("render-capabilities-old");
  old.mark("render-version", "0.16.0");
  let develop = camera_develop(&old);
  assert!(develop.is_available());
  assert_eq!(develop.render_capabilities_cached(), None);
  assert!(old
    .lines("calls.txt")
    .contains(&"niho-develop-render capabilities".to_string()));

  // 答える renderer: 読める設定は描き、読めない `v`・engine・輝度は作業コピーを作る前に断る
  const ALL: &[u32] = &[1, 2, 3, 4, 5, 6, 7, 8, 9];
  const LUMINANCE: &[&str] = &["colorGradingLuminance"];
  let cases = [
    ("all", ALL, LUMINANCE, &lens, true),
    ("no-v9", &ALL[..8], LUMINANCE, &lens, false),
    ("engine", ALL, LUMINANCE, &new_engine, false),
    ("luminance", ALL, &[] as &[&str], &luminance, false),
    ("luminance-drawn", ALL, LUMINANCE, &luminance, true),
  ];
  for (name, versions, features, settings, draws) in cases {
    let harness = SidecarHarness::new(&format!("render-capabilities-{name}"));
    harness.mark("render-version", "0.26.0");
    harness.mark("render-capabilities", &render_capabilities_line(versions, features));
    let develop = camera_develop(&harness);
    let jpeg = photo_file(&harness, "IMG_0002.jpg", b"jpeg bytes");
    let photos = FakePhotos::new(&[("p1", &jpeg)]);
    let destination = harness.dir.join("out").join("IMG_0002.jpg");
    fs::create_dir_all(destination.parent().unwrap()).unwrap();
    let result = develop.export(&photos, "p1", settings, &destination, Overwrite::Never);
    assert_eq!(
      develop
        .render_capabilities_cached()
        .map(|capabilities| capabilities.settings_versions),
      Some(versions.to_vec()),
      "{name}"
    );
    let rendered = harness
      .work_calls()
      .iter()
      .any(|call| call.starts_with("niho-develop-render render "));
    if draws {
      result.unwrap();
      assert!(rendered, "{name}");
      let sent: Value =
        serde_json::from_slice(&fs::read(harness.sidecars.join("last-settings.json")).unwrap()).unwrap();
      for key in ["v", "engine", "lens", "colorGrading"] {
        assert_eq!(sent[key], settings[key], "{name}: {key} reaches the sidecar as saved");
      }
    } else {
      let error = result.unwrap_err();
      assert_eq!(error.code, develop_code::UNSUPPORTED_SETTINGS, "{name}");
      assert!(!rendered, "{name}");
      assert!(!destination.exists(), "{name}");
    }
  }
}

/// 補正を全部使う設定（原寸の大きさの見積もりは、補正の有無と数だけを見る）。
fn every_correction() -> Value {
  json!({
    "v": 9, "masks": [{"id": "a"}, {"id": "b"}, {"id": "c"}], "detail": {"sharpening": {"amount": 40}},
    "geometry": {"perspective": {"vertical": -10}}, "heal": [{"id": "h"}], "lens": {"distortion": 5}
  })
}

#[test]
fn full_size_peak_grows_with_the_pixels_and_the_corrections() {
  let plain = json!({ "v": 1, "exposure": 0.3 });
  let all = every_correction();
  for input in [ExportInput::Raw, ExportInput::Raster, ExportInput::RasterFullSize] {
    let small = full_size_peak_bytes(24_000_000, input, &plain);
    let large = full_size_peak_bytes(48_000_000, input, &plain);
    assert!(small > 0);
    assert!(
      large.abs_diff(2 * small) <= 1,
      "{input:?}: the estimate is proportional to the pixels"
    );
    assert!(full_size_peak_bytes(24_000_000, input, &all) > small, "{input:?}");
  }
  // JPEG / PNG は元を原寸にする段（apple-raw-linear）を通らない
  assert!(
    full_size_peak_bytes(24_000_000, ExportInput::Raster, &plain)
      <= full_size_peak_bytes(24_000_000, ExportInput::Raw, &plain)
  );
  // マスクは 8 枚まで数える
  let many = json!({ "masks": vec![json!({}); 12] });
  let eight = json!({ "masks": vec![json!({}); 8] });
  assert_eq!(
    full_size_peak_bytes(10_000_000, ExportInput::Raster, &many),
    full_size_peak_bytes(10_000_000, ExportInput::Raster, &eight)
  );
}

/// 見積もりは Studio の実測（renderer の段・61MP 9566×6377 の合成の作業コピー・peak memory footprint）を下回らない。
#[test]
fn full_size_peak_is_at_least_the_measured_render() {
  let pixels = 9566 * 6377;
  let mib = 1_u64 << 20;
  for (settings, measured_mib) in [
    (json!({}), 2348),
    (json!({ "masks": [{}, {}, {}] }), 4482),
    (json!({ "detail": { "sharpening": { "amount": 40 } } }), 4347),
    (json!({ "geometry": { "perspective": { "vertical": -15 } } }), 3482),
    (json!({ "heal": [{}] }), 3091),
    (json!({ "lens": { "distortion": 8 } }), 3523),
    (every_correction(), 10547),
  ] {
    let estimate = full_size_peak_bytes(pixels, ExportInput::Raster, &settings);
    assert!(
      estimate >= measured_mib * mib,
      "{settings}: {estimate} < {measured_mib} MiB"
    );
  }
}

#[test]
fn full_size_is_refused_beyond_the_renderer_bound_or_the_memory() {
  let gib = 1_u64 << 30;
  let plain = json!({ "v": 1 });
  let all = every_correction();
  // 61MP（9504×6336）: 1 億画素まで読む renderer と大きなメモリなら書き出す
  assert_eq!(
    full_size_too_large(9504, 6336, ExportInput::Raw, &plain, 100_000_000, Some(64 * gib)),
    None
  );
  // 4,000 万画素までの古い renderer は断り、収まる長辺を出す
  let old = full_size_too_large(
    9504,
    6336,
    ExportInput::Raw,
    &plain,
    LEGACY_RENDER_MAX_PIXELS,
    Some(64 * gib),
  )
  .unwrap();
  let expected = (9504.0 * (40_000_000.0_f64 / (9504.0 * 6336.0)).sqrt()).floor() as u64;
  assert_eq!(old.max_long_edge, expected);
  assert!(old.max_long_edge * (old.max_long_edge * 6336 / 9504) <= LEGACY_RENDER_MAX_PIXELS);
  // メモリの小さい Mac（8 GiB）で補正を全部使う 61MP は断り、出した長辺は見積もりがメモリに収まる
  let air = full_size_too_large(9504, 6336, ExportInput::Raw, &all, 100_000_000, Some(8 * gib)).unwrap();
  assert!(air.max_long_edge < 9504);
  let long = air.max_long_edge as f64;
  let pixels = (long * long * 6336.0 / 9504.0) as u64;
  assert!(
    full_size_peak_bytes(pixels, ExportInput::Raw, &all) as f64 <= 8.0 * gib as f64 * FULL_SIZE_MEMORY_SHARE * 1.001
  );
  // メモリが分からなければ画素数だけで決める・24MP は 8 GiB でも書き出す
  assert_eq!(
    full_size_too_large(9504, 6336, ExportInput::Raw, &all, 100_000_000, None),
    None
  );
  assert_eq!(
    full_size_too_large(6000, 4000, ExportInput::Raw, &all, 100_000_000, Some(8 * gib)),
    None
  );
  // 寸法の無い写真は断らない
  assert_eq!(full_size_too_large(0, 4000, ExportInput::Raw, &all, 1, Some(1)), None);
  assert_eq!(
    FullSizeTooLarge { max_long_edge: 7745 }.message(),
    "この写真は原寸では大きすぎます（長辺 7,745 px まで）。"
  );
  assert_eq!(
    FullSizeTooLarge { max_long_edge: 512 }.message(),
    "この写真は原寸では大きすぎます（長辺 512 px まで）。"
  );
}

#[test]
fn full_size_too_large_reads_the_photo_size_and_the_bundled_renderer() {
  let settings = json!({ "v": 1, "engine": "niho-14", "exposure": 0.2 });
  // 1 億画素を超える JPEG（12000×9000）は、答える renderer（1 億画素まで）でも断る（メモリによらない）
  for (name, size, capabilities, refused) in [
    ("old-24mp", "6000 4000", false, false),
    ("old-61mp", "9504 6336", false, true),
    ("new-108mp", "12000 9000", true, true),
  ] {
    let harness = SidecarHarness::new(&format!("full-size-{name}"));
    harness.mark("render-version", "0.26.0");
    if capabilities {
      let line = render_capabilities_line(&[1, 2, 3, 4, 5, 6, 7, 8, 9], &["colorGradingLuminance"]);
      let mut value: Value = serde_json::from_str(&line).unwrap();
      value["maxPixels"] = json!(100_000_000);
      harness.mark("render-capabilities", &value.to_string());
    }
    harness.mark("image-size", size);
    let develop = camera_develop(&harness);
    let jpeg = photo_file(&harness, "IMG_0002.jpg", b"jpeg bytes");
    let photos = FakePhotos::new(&[("p1", &jpeg)]);
    let too_large = develop.full_size_too_large(&photos, "p1", &settings);
    assert_eq!(too_large.is_some(), refused, "{name}: {too_large:?}");
    if let Some(too_large) = too_large {
      let (width, height): (f64, f64) = {
        let mut parts = size.split(' ').map(|part| part.parse::<f64>().unwrap());
        (parts.next().unwrap(), parts.next().unwrap())
      };
      let bound = if capabilities {
        100_000_000.0
      } else {
        LEGACY_RENDER_MAX_PIXELS as f64
      };
      assert!(
        too_large.max_long_edge as f64 <= width.max(height) * (bound / (width * height)).sqrt(),
        "{name}"
      );
    }
    assert!(
      !harness
        .work_calls()
        .iter()
        .any(|call| call.starts_with("niho-develop-render render ")),
      "{name}: the check renders nothing"
    );
  }
  // 開いていない写真は断らない（書き出しの中で今までどおり失敗を返す）
  let harness = SidecarHarness::new("full-size-not-open");
  let develop = camera_develop(&harness);
  assert_eq!(
    develop.full_size_too_large(&FakePhotos::new(&[]), "p1", &settings),
    None
  );
}

#[test]
fn surface_masks_hand_only_their_drawn_surfaces_to_the_render_sidecar() {
  use crate::mask_surfaces::mask_surface_id;
  let painted = b"\x89PNG painted surface".to_vec();
  let unused = b"\x89PNG surface of a disabled mask".to_vec();
  let (a, b) = (mask_surface_id(&painted), mask_surface_id(&unused));
  let missing = "0".repeat(64);
  let brush = |id: &str, surface: &str, enabled: bool| {
    json!({
      "id": id, "kind": "brush", "enabled": enabled,
      "surface": { "id": surface, "width": 64, "height": 48 },
      "adjust": { "exposure": -0.7 }
    })
  };
  let settings =
    |masks: Value| json!({ "v": 5, "engine": "niho-10", "look": "niho-standard-1", "base": null, "masks": masks });
  let harness = SidecarHarness::new("export-mask-surfaces");
  harness.mark("render-version", MASKS_MIN_RENDER_VERSION);
  let develop = camera_develop(&harness);
  let jpeg = photo_file(&harness, "IMG_0003.jpg", b"jpeg bytes");
  let photos = FakePhotos::new(&[("p1", &jpeg)])
    .with_surface(&a, &painted)
    .with_surface(&b, &unused);
  let out = harness.dir.join("out");
  fs::create_dir_all(&out).unwrap();
  // Drawn: the brush (twice, one surface) and not the disabled sky (whose
  // surface would be missing anyway) nor an empty one.
  let drawn = settings(json!([
    brush("m1", &a, true),
    brush("m2", &a, true),
    brush("m3", &missing, false),
    { "id": "m4", "kind": "sky", "surface": { "id": missing, "width": 8, "height": 8 }, "adjust": {} }
  ]));
  let destination = out.join("drawn.jpg");
  develop
    .export(&photos, "p1", &drawn, &destination, Overwrite::Never)
    .unwrap();
  let render = harness
    .work_calls()
    .into_iter()
    .find(|call| call.starts_with("niho-develop-render render "))
    .expect("rendered");
  assert_eq!(render.matches("--mask-surface").count(), 1, "{render}");
  assert!(render.contains(&format!("--mask-surface {a}=")), "{render}");
  assert!(!render.contains(&missing) && !render.contains(&b), "{render}");
  assert_eq!(
    fs::read(harness.sidecars.join(format!("last-surface-{a}.png"))).unwrap(),
    painted
  );
  let sent: Value = serde_json::from_slice(&fs::read(harness.sidecars.join("last-settings.json")).unwrap()).unwrap();
  assert_eq!(sent["masks"], drawn["masks"], "the masks reach the sidecar as saved");
  assert!(destination.exists());
  // The surface copies went with the job's folder.
  let surface_copies = |dir: &Path| -> usize {
    fn walk(dir: &Path, count: &mut usize) {
      for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
          walk(&path, count);
        } else if entry.file_name().to_string_lossy().starts_with("surface-") {
          *count += 1;
        }
      }
    }
    let mut count = 0;
    walk(dir, &mut count);
    count
  };
  assert_eq!(surface_copies(&harness.cache_dir()), 0);

  // A drawn mask whose surface this Mac does not have (or has with other
  // bytes): refused before any working copy or render.
  let wrong = FakePhotos::new(&[("p1", &jpeg)]).with_surface(&missing, b"other bytes");
  for (photos, name) in [(&photos, "missing"), (&wrong, "mismatch")] {
    let calls = harness.work_calls().len();
    let destination = out.join(format!("{name}.jpg"));
    let error = develop
      .export(
        photos,
        "p1",
        &settings(json!([brush("m1", &missing, true)])),
        &destination,
        Overwrite::Never,
      )
      .unwrap_err();
    assert_eq!(error.code, develop_code::MASK_SURFACE_MISSING, "{name}");
    assert_eq!(error.message, MASK_SURFACE_MISSING_MESSAGE);
    assert!(error.detail.contains(&missing), "{}", error.detail);
    assert_eq!(harness.work_calls().len(), calls, "{name}: nothing ran");
    assert!(!destination.exists());
  }

  // An old sidecar is refused first, surfaces or not.
  let old = SidecarHarness::new("export-mask-surfaces-old");
  old.mark("render-version", "0.18.0");
  let error = camera_develop(&old)
    .export(&photos, "p1", &drawn, &out.join("old.jpg"), Overwrite::Never)
    .unwrap_err();
  assert_eq!(error.code, develop_code::UNSUPPORTED_SETTINGS);
}
