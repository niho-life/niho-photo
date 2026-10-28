use super::*;

fn request(kind: &str, settings: Value) -> DetectSurfaceRequest {
  DetectSurfaceRequest {
    photo_id: "photo-1".to_string(),
    kind: kind.to_string(),
    operation_id: "detect-1".to_string(),
    develop_settings: settings,
  }
}

#[test]
fn the_request_names_an_open_photo_a_known_kind_and_small_settings() {
  let settings = json!({ "v": 1, "engine": "niho-14" });
  assert!(validate_request(&request("subject", settings.clone())).is_ok());
  assert!(validate_request(&request("sky", settings.clone())).is_ok());
  for kind in ["person", "", "Subject"] {
    assert_eq!(
      validate_request(&request(kind, settings.clone())).unwrap_err().code,
      "invalidRequest"
    );
  }
  assert_eq!(
    validate_request(&request("subject", json!(null))).unwrap_err().code,
    "invalidRequest"
  );
  assert_eq!(
    validate_request(&request("subject", json!([1]))).unwrap_err().code,
    "invalidRequest"
  );
  let large = json!({ "engine": "niho-14", "note": "x".repeat(MAX_SETTINGS_BYTES) });
  assert_eq!(
    validate_request(&request("subject", large)).unwrap_err().code,
    "invalidRequest"
  );
  let mut bad_operation = request("subject", settings.clone());
  bad_operation.operation_id = "../x".to_string();
  assert_eq!(validate_request(&bad_operation).unwrap_err().code, "invalidRequest");
  let mut bad_photo = request("subject", settings);
  bad_photo.photo_id = String::new();
  assert!(validate_request(&bad_photo).is_err());
}

#[test]
fn unknown_request_fields_are_refused() {
  let parsed: Result<DetectSurfaceRequest, _> = parse_request(Some(json!({
    "photoId": "photo-1", "kind": "subject", "operationId": "detect-1", "developSettings": {}, "path": "/tmp/x.jpg"
  })));
  assert_eq!(parsed.unwrap_err().code, "invalidRequest");
  let parsed: DetectSurfaceRequest = parse_request(Some(json!({
    "photoId": "photo-1", "kind": "subject", "operationId": "detect-1", "developSettings": { "engine": "niho-2" }
  })))
  .unwrap();
  assert_eq!(parsed.kind, "subject");
}

#[test]
fn the_working_image_is_drawn_with_the_formula_and_base_only() {
  let settings = json!({
    "v": 9, "engine": "niho-11", "look": "niho-standard-5", "base": "raw-apple.old", "exposure": 1.5,
    "geometry": { "rotate": 90 }, "lens": { "distortion": 30 },
    "masks": [{ "id": "m", "kind": "linear" }]
  });
  assert_eq!(
    working_image_settings(&settings, "raw-apple.d8.p3.e4.cal-x.lens-apple").unwrap(),
    json!({ "v": 1, "engine": "niho-11", "look": "niho-standard-5", "base": "raw-apple.d8.p3.e4.cal-x.lens-apple" })
  );
  assert_eq!(
    working_image_settings(&json!({ "engine": "niho-2" }), "b").unwrap(),
    json!({ "v": 1, "engine": "niho-2", "base": "b" })
  );
  assert_eq!(
    working_image_settings(&json!({ "look": "niho-standard-1" }), "b")
      .unwrap_err()
      .code,
    "invalidRequest"
  );
}

#[test]
fn detections_are_remembered_per_photo_kind_and_working_image() {
  let key = detection_key(&"a".repeat(64), "subject", "original");
  assert_eq!(key, format!("{}/subject/original", "a".repeat(64)));
  assert_ne!(key, detection_key(&"a".repeat(64), "subject", "raw-apple.base"));
  assert_ne!(key, detection_key(&"a".repeat(64), "sky", "original"));

  let detections = MaskDetections::default();
  assert!(detections.get(&key).is_none());
  detections.remember(key.clone(), json!({ "id": "s", "width": 4, "height": 2 }));
  assert_eq!(detections.get(&key).unwrap()["id"], json!("s"));
  // 上限を超えたら忘れる（置き場の面は残る）
  for index in 0..MAX_REMEMBERED {
    detections.remember(format!("other-{index}"), json!({}));
  }
  assert!(detections.get(&key).is_none());
  assert!(lock(&detections.0).len() <= MAX_REMEMBERED);
}
