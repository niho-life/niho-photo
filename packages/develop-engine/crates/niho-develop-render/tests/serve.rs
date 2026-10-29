//! `niho-develop-render serve` (#152) answers the wasm's calls in frames
//! over stdin / stdout: it names its methods (the wasm's exports), gives
//! the results `niho_develop::api` gives (the digests `api_cross_target`
//! pins on both targets), answers bad requests with errors and goes on,
//! answers concurrent requests by id, keeps and lets go of Developers, and
//! ends with its input.

#[path = "../../niho-develop/tests/api_fixture/mod.rs"]
mod api_fixture;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::Instant;

use api_fixture as f;
use niho_develop::api;
use niho_develop_render::serve::METHODS;
use serde_json::{json, Value};

const BIN: &str = env!("CARGO_BIN_EXE_niho-develop-render");

/// A request body: the header (its `blobs` filled in) and the blobs.
fn body(mut header: Value, blobs: &[&[u8]]) -> Vec<u8> {
    header["blobs"] = blobs.iter().map(|b| b.len()).collect::<Vec<_>>().into();
    let text = serde_json::to_vec(&header).unwrap();
    let mut out = (text.len() as u32).to_le_bytes().to_vec();
    out.extend_from_slice(&text);
    for blob in blobs {
        out.extend_from_slice(blob);
    }
    out
}

/// A request frame.
fn frame(id: u32, method: &str, body: &[u8]) -> Vec<u8> {
    let mut out = id.to_le_bytes().to_vec();
    out.extend_from_slice(&(method.len() as u32).to_le_bytes());
    out.extend_from_slice(method.as_bytes());
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(body);
    out
}

struct Response {
    id: u32,
    /// The header's JSON text.
    text: String,
    header: Value,
    blobs: Vec<Vec<u8>>,
}

impl Response {
    fn parse(id: u32, body: &[u8]) -> Self {
        let length = u32::from_le_bytes(body[..4].try_into().unwrap()) as usize;
        let text = String::from_utf8(body[4..4 + length].to_vec()).unwrap();
        let header: Value = serde_json::from_str(&text).unwrap();
        let mut payload = &body[4 + length..];
        let mut blobs = Vec::new();
        for size in header["blobs"].as_array().map_or(&[][..], Vec::as_slice) {
            let (blob, rest) = payload.split_at(size.as_u64().unwrap() as usize);
            blobs.push(blob.to_vec());
            payload = rest;
        }
        assert!(payload.is_empty(), "{text}");
        Self {
            id,
            text,
            header,
            blobs,
        }
    }

    fn result(&self) -> &Value {
        assert_eq!(self.header["ok"], true, "{}", self.text);
        &self.header["result"]
    }

    /// The blob a `{"blob":i}` of the result names.
    fn blob(&self, reference: &Value) -> &[u8] {
        let index = reference["blob"].as_u64().unwrap() as usize;
        &self.blobs[index]
    }

    /// A string result.
    fn string(&self) -> &str {
        self.result().as_str().unwrap()
    }

    /// `(error, code)` of a failed response.
    fn error(&self) -> (&str, Option<&str>) {
        assert_eq!(self.header["ok"], false, "{}", self.text);
        (
            self.header["error"].as_str().unwrap(),
            self.header["code"].as_str(),
        )
    }

    /// A number of the header exactly as written (the JSON text, read with
    /// `str::parse`).
    fn exact(&self, key: &str) -> f64 {
        let start = self.text.find(&format!("\"{key}\":")).unwrap() + key.len() + 3;
        let end = start + self.text[start..].find([',', '}']).unwrap();
        self.text[start..end].parse().unwrap()
    }
}

fn expect_code(response: &Response, code: &str) {
    assert_eq!(response.error().1, Some(code), "{}", response.text);
}

fn size_text_of(value: &Value) -> String {
    f::size_text(
        value["width"].as_u64().unwrap(),
        value["height"].as_u64().unwrap(),
    )
}

struct Serve {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
    next_id: u32,
}

impl Serve {
    fn start() -> Self {
        let mut child = Command::new(BIN)
            .arg("serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        Self {
            child,
            stdin,
            stdout,
            next_id: 1,
        }
    }

    fn send_raw(&mut self, bytes: &[u8]) {
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(bytes).unwrap();
        stdin.flush().unwrap();
    }

    fn send(&mut self, id: u32, method: &str, body: &[u8]) {
        self.send_raw(&frame(id, method, body));
    }

    fn read_u32(&mut self) -> u32 {
        let mut bytes = [0u8; 4];
        self.stdout.read_exact(&mut bytes).unwrap();
        u32::from_le_bytes(bytes)
    }

    fn receive(&mut self) -> Response {
        let id = self.read_u32();
        let length = self.read_u32() as usize;
        let mut body = vec![0u8; length];
        self.stdout.read_exact(&mut body).unwrap();
        Response::parse(id, &body)
    }

    fn call_body(&mut self, method: &str, body: &[u8]) -> Response {
        let id = self.next_id;
        self.next_id += 1;
        self.send(id, method, body);
        let response = self.receive();
        assert_eq!(response.id, id);
        response
    }

    fn call(&mut self, method: &str, header: Value, blobs: &[&[u8]]) -> Response {
        self.call_body(method, &body(header, blobs))
    }

    fn hello(&mut self) -> Value {
        self.call("hello", json!({}), &[]).result().clone()
    }

    /// Opens a Developer of `bytes` at its own size; its handle.
    fn open(&mut self, bytes: &[u8], client: &str) -> u64 {
        let opened = self.call(
            "Developer.new",
            json!({"args": [{"blob": 0}, 0], "client": client}),
            &[bytes],
        );
        opened.result()["handle"].as_u64().unwrap()
    }

    /// Closes stdin and waits: the exit code.
    fn finish(mut self) -> i32 {
        drop(self.stdin.take());
        self.child.wait().unwrap().code().unwrap_or(-1)
    }
}

impl Drop for Serve {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn hello_names_the_protocol_the_versions_and_the_methods() {
    let mut serve = Serve::start();
    let hello = serve.hello();
    assert_eq!(hello["protocol"], 1);
    assert_eq!(hello["tool"], niho_develop_render::version_line());
    assert_eq!(hello["crateVersion"], niho_develop::CRATE_VERSION);
    assert_eq!(hello["engine"], niho_develop::ENGINE_VERSION);
    assert_eq!(hello["threads"], niho_develop::api::thread_count());
    let methods: Vec<&str> = hello["methods"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m.as_str().unwrap())
        .collect();
    assert_eq!(methods, METHODS);
    assert_eq!(serve.finish(), 0);
}

/// The exports of `niho-develop-wasm` by their JS names, read from its
/// source: `#[wasm_bindgen]` functions (`js_name` or the Rust name) and the
/// methods of its `impl Developer` (`Developer.new` for the constructor,
/// the getters left out).
fn wasm_exports() -> Vec<String> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../niho-develop-wasm/src/lib.rs"
    );
    let source = std::fs::read_to_string(path).unwrap();
    let mut exports = Vec::new();
    let mut attributes: Vec<&str> = Vec::new();
    let mut in_developer = false;
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("#[") {
            attributes.push(trimmed);
            continue;
        }
        if trimmed.starts_with("//") {
            continue;
        }
        let bound = attributes.iter().any(|a| a.starts_with("#[wasm_bindgen"));
        let js_name = attributes
            .iter()
            .find_map(|a| a.split("js_name = ").nth(1))
            .map(|name| name.trim_end_matches(")]"));
        if line == "}" {
            in_developer = false;
        } else if trimmed.starts_with("impl Developer") && bound {
            in_developer = true;
        } else if let Some(rest) = trimmed.strip_prefix("pub fn ") {
            let name = rest.split('(').next().unwrap();
            if in_developer {
                if attributes.iter().any(|a| a.contains("constructor")) {
                    exports.push("Developer.new".to_string());
                } else if !attributes.iter().any(|a| a.contains("getter")) {
                    exports.push(format!("Developer.{}", js_name.unwrap_or(name)));
                }
            } else if bound {
                exports.push(js_name.unwrap_or(name).to_string());
            }
        }
        attributes.clear();
    }
    exports
}

/// `serve`'s methods are the wasm's exports (the class's `free` too), plus
/// `hello` and `releaseClient`.
#[test]
fn the_methods_are_the_wasm_exports() {
    let exports = wasm_exports();
    assert_eq!(exports.len(), 39, "{exports:?}");
    let mut expected: Vec<String> = exports;
    expected.extend(["Developer.free", "hello", "releaseClient"].map(String::from));
    expected.sort_unstable();
    let mut methods: Vec<String> = METHODS.iter().map(|m| m.to_string()).collect();
    methods.sort_unstable();
    assert_eq!(methods, expected);
}

/// The same calls as `api_cross_target`, through `serve`: the same
/// digests.
#[test]
fn serve_gives_the_pinned_api_results() {
    let mut serve = Serve::start();
    let photo = f::photo_png();
    let (settings, max) = (f::SETTINGS, f::MAX_DIMENSION);
    let mut actual: Vec<(&str, String)> = Vec::new();

    let rendered = serve.call(
        "render",
        json!({"args": [{"blob": 0}, settings, max]}),
        &[&photo],
    );
    let frame = rendered.result();
    actual.push(("render", f::sha256(rendered.blob(&frame["rgba"]))));
    actual.push(("render.size", size_text_of(frame)));
    let approximations: Vec<&str> = frame["approximations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a.as_str().unwrap())
        .collect();
    actual.push(("render.approximations", approximations.join(",")));
    let exported = serve.call(
        "exportJpeg",
        json!({"args": [{"blob": 0}, settings, max, f::JPEG_QUALITY, null]}),
        &[&photo],
    );
    let jpeg = exported.blob(exported.result()).to_vec();
    actual.push(("exportJpeg", f::sha256(&jpeg)));
    let png = serve.call(
        "exportPng",
        json!({"args": [{"blob": 0}, settings, max]}),
        &[&photo],
    );
    actual.push(("exportPng", f::sha256(png.blob(png.result()))));
    let dated = serve.call(
        "withCaptureExif",
        json!({"args": [{"blob": 0}, f::CAPTURED_AT, f::OFFSET_MINUTES]}),
        &[&jpeg],
    );
    actual.push(("withCaptureExif", f::sha256(dated.blob(dated.result()))));
    let size = serve.call("imageSize", json!({"args": [{"blob": 0}]}), &[&photo]);
    actual.push(("imageSize", size_text_of(size.result())));

    let opened = serve.call(
        "Developer.new",
        json!({"args": [{"blob": 0}, 0], "client": "glue"}),
        &[&photo],
    );
    let handle = opened.result()["handle"].as_u64().unwrap();
    actual.push(("Developer.new.size", size_text_of(opened.result())));
    let on = |args: Value| json!({"args": args, "handle": handle});
    let drag = serve.call("Developer.render", on(json!([settings, max, true])), &[]);
    let drag_frame = drag.result();
    actual.push((
        "Developer.render.interactive",
        f::sha256(drag.blob(&drag_frame["rgba"])),
    ));
    let released = serve.call("Developer.render", on(json!([settings, max, false])), &[]);
    let released_frame = released.result();
    actual.push((
        "Developer.render.final",
        f::sha256(released.blob(&released_frame["rgba"])),
    ));
    actual.push(("Developer.render.size", size_text_of(released_frame)));
    let plane = serve.call(
        "Developer.maskPlane",
        on(json!([settings, f::MASK_ID, max])),
        &[],
    );
    let plane_result = plane.result();
    actual.push((
        "Developer.maskPlane",
        f::sha256(plane.blob(&plane_result["data"])),
    ));
    actual.push(("Developer.maskPlane.size", size_text_of(plane_result)));
    let color = serve.call(
        "Developer.sampleColor",
        on(json!([settings, max, f::SAMPLE_X, f::SAMPLE_Y])),
        &[],
    );
    actual.push((
        "Developer.sampleColor",
        f::color_digest(
            color.exact("lightness"),
            color.exact("chroma"),
            color.exact("hue"),
        ),
    ));
    let auto = serve.call("Developer.autoSettings", on(json!([settings])), &[]);
    actual.push((
        "Developer.autoSettings",
        f::sha256(auto.string().as_bytes()),
    ));
    let upright = serve.call(
        "Developer.estimateUpright",
        on(json!([settings, f::UPRIGHT_MODE])),
        &[],
    );
    actual.push((
        "Developer.estimateUpright",
        f::sha256(upright.string().as_bytes()),
    ));
    let thumbnail = serve.call(
        "Developer.thumbnail",
        json!({"args": [f::THUMBNAIL_MAX_DIMENSION], "handle": handle, "client": "glue"}),
        &[],
    );
    let small_handle = thumbnail.result()["handle"].as_u64().unwrap();
    let small = serve.call(
        "Developer.render",
        json!({"args": [settings, 0, false], "handle": small_handle}),
        &[],
    );
    actual.push((
        "Developer.thumbnail.render",
        f::sha256(small.blob(&small.result()["rgba"])),
    ));

    let working_copy = f::working_copy();
    let working = serve.call(
        "Developer.openWorkingCopy",
        json!({"args": [{"blob": 0}, f::WORKING_COPY_META], "client": "glue"}),
        &[&working_copy],
    );
    let working_handle = working.result()["handle"].as_u64().unwrap();
    let on_working = |args: Value| json!({"args": args, "handle": working_handle});
    let white = serve.call("Developer.asShotWhite", on_working(json!([])), &[]);
    let as_shot = white.string().to_string();
    let from_meta = serve.call(
        "asShotWhiteFromMeta",
        json!({"args": [f::WORKING_COPY_META]}),
        &[],
    );
    assert_eq!(from_meta.string(), as_shot);
    actual.push(("Developer.asShotWhite", as_shot.clone()));
    let developed = serve.call(
        "Developer.render",
        on_working(json!([f::WORKING_COPY_SETTINGS, 0, false])),
        &[],
    );
    actual.push((
        "Developer.openWorkingCopy.render",
        f::sha256(developed.blob(&developed.result()["rgba"])),
    ));

    let xmp = f::preset_xmp();
    let preset = serve.call("presetSettings", json!({"args": [xmp, null]}), &[]);
    actual.push(("presetSettings", f::sha256(preset.string().as_bytes())));
    let applied = serve.call(
        "applyPreset",
        json!({"args": [xmp, f::WORKING_COPY_SETTINGS, f::PRESET_AMOUNT, as_shot]}),
        &[],
    );
    actual.push(("applyPreset", f::sha256(applied.string().as_bytes())));
    let written = serve.call(
        "settingsToXmp",
        json!({"args": [settings, f::XMP_OPTIONS]}),
        &[],
    );
    actual.push(("settingsToXmp", f::sha256(written.string().as_bytes())));
    let issues = serve.call(
        "validateSettings",
        json!({"args": [f::INVALID_SETTINGS]}),
        &[],
    );
    actual.push(("validateSettings", f::sha256(issues.string().as_bytes())));
    let converted = serve.call(
        "convertEditSettings",
        json!({"args": [f::EDIT_SETTINGS, f::CONVERT_BASE]}),
        &[],
    );
    actual.push((
        "convertEditSettings",
        f::sha256(converted.string().as_bytes()),
    ));

    f::assert_expected(&actual);
    assert_eq!(serve.finish(), 0);
}

/// The calls that only shape their answers give what `api` gives.
#[test]
fn the_other_methods_answer_like_the_api() {
    let mut serve = Serve::start();
    let photo = f::photo_png();
    let none = json!({});
    assert_eq!(
        serve.call("version", none.clone(), &[]).string(),
        api::version()
    );
    assert_eq!(
        serve.call("capabilities", none.clone(), &[]).string(),
        api::capabilities()
    );
    assert_eq!(
        serve.call("neutralSettings", none.clone(), &[]).string(),
        api::neutral_settings()
    );
    assert_eq!(
        serve.call("builtinPresets", none, &[]).string(),
        api::builtin_presets()
    );
    assert_eq!(
        serve
            .call("beforeSettings", json!({"args": [f::SETTINGS]}), &[])
            .string(),
        api::before_settings(f::SETTINGS).unwrap()
    );
    let decode = serve.call(
        "rasterDecodeSize",
        json!({"args": [f::SETTINGS, 160, 120, f::MAX_DIMENSION, 0]}),
        &[],
    );
    assert_eq!(
        decode.result(),
        api::raster_decode_size(f::SETTINGS, 160, 120, f::MAX_DIMENSION, 0).unwrap()
    );
    let output = serve.call(
        "geometryOutputSize",
        json!({"args": [f::SETTINGS, 160, 120, f::MAX_DIMENSION]}),
        &[],
    );
    let size = api::geometry_output_size(f::SETTINGS, 160, 120, f::MAX_DIMENSION).unwrap();
    assert_eq!(
        output.result(),
        &json!({"width": size.width, "height": size.height})
    );
    let preset = serve.call("presetSettings", json!({"args": [f::preset_xmp()]}), &[]);
    assert_eq!(
        preset.string(),
        api::preset_settings(f::preset_xmp(), None).unwrap()
    );
    // A JPEG without a capture time, and the decode cap given.
    let jpeg = api::export_jpeg(&photo, f::SETTINGS, f::MAX_DIMENSION, 70, Some(0)).unwrap();
    let exported = serve.call(
        "exportJpeg",
        json!({"args": [{"blob": 0}, f::SETTINGS, f::MAX_DIMENSION, 70, 0]}),
        &[&photo],
    );
    assert_eq!(exported.blob(exported.result()), &jpeg[..]);
    let undated = serve.call(
        "withCaptureExif",
        json!({"args": [{"blob": 0}, null, 0]}),
        &[&jpeg],
    );
    assert_eq!(
        undated.blob(undated.result()),
        &api::with_capture_exif(&jpeg, None, 0).unwrap()[..]
    );
    assert_eq!(serve.finish(), 0);
}

/// Bad requests get error answers (the engine's own message without a
/// `code`, else a code) and `serve` goes on answering.
#[test]
fn bad_requests_get_error_answers_and_serve_goes_on() {
    let mut serve = Serve::start();
    let photo = f::photo_png();
    let still_answers = |serve: &mut Serve| assert_eq!(serve.hello()["protocol"], 1);

    let mut not_json = 3u32.to_le_bytes().to_vec();
    not_json.extend_from_slice(b"{x}");
    expect_code(&serve.call_body("version", &not_json), "badRequest");
    still_answers(&mut serve);
    expect_code(&serve.call_body("version", &[1, 0]), "badRequest");
    still_answers(&mut serve);
    expect_code(
        &serve.call("render", json!({"args": [1, 2]}), &[]),
        "badRequest",
    );
    still_answers(&mut serve);
    expect_code(
        &serve.call(
            "render",
            json!({"args": [{"blob": 3}, f::SETTINGS, 96]}),
            &[&photo],
        ),
        "badRequest",
    );
    still_answers(&mut serve);
    let mut extra = body(json!({"args": []}), &[]);
    extra.extend_from_slice(b"xyz");
    expect_code(&serve.call_body("version", &extra), "badRequest");
    still_answers(&mut serve);
    expect_code(
        &serve.call(
            "Developer.render",
            json!({"args": [f::SETTINGS, 96, false]}),
            &[],
        ),
        "badRequest",
    );
    still_answers(&mut serve);
    expect_code(&serve.call("nope", json!({}), &[]), "unknownMethod");
    expect_code(
        &serve.call("Developer.width", json!({"handle": 1}), &[]),
        "unknownMethod",
    );
    still_answers(&mut serve);
    expect_code(
        &serve.call(
            "Developer.render",
            json!({"args": [f::SETTINGS, 96, false], "handle": 4242}),
            &[],
        ),
        "unknownHandle",
    );
    still_answers(&mut serve);

    // The engine's refusals: the wasm's messages, without a code.
    for settings in ["{", r#"{"v":99}"#, f::INVALID_SETTINGS] {
        let refused = serve.call(
            "render",
            json!({"args": [{"blob": 0}, settings, 96]}),
            &[&photo],
        );
        let expected = api::render(&photo, settings, 96, None).err().unwrap();
        assert_eq!(refused.error(), (expected.as_str(), None));
        still_answers(&mut serve);
    }
    let not_an_image = serve.call(
        "Developer.new",
        json!({"args": [{"blob": 0}, 0]}),
        &[b"not an image"],
    );
    let expected = api::Developer::new(b"not an image", 0).err().unwrap();
    assert_eq!(not_an_image.error(), (expected.as_str(), None));
    let handle = serve.open(&photo, "bad");
    let upright = serve.call(
        "Developer.estimateUpright",
        json!({"args": [f::SETTINGS, 9], "handle": handle}),
        &[],
    );
    assert_eq!(
        upright.error(),
        (
            "mode must be 1 (auto), 2 (level), 3 (vertical) or 4 (full)",
            None
        )
    );
    let missing = serve.call(
        "Developer.maskPlane",
        json!({"args": [f::SETTINGS, "nope", 96], "handle": handle}),
        &[],
    );
    assert!(
        missing.error().0.starts_with("maskNotFound"),
        "{}",
        missing.text
    );
    still_answers(&mut serve);
    assert_eq!(serve.finish(), 0);
}

/// Requests are answered by id, whatever their order.
#[test]
fn requests_in_a_row_are_answered_by_id() {
    let mut serve = Serve::start();
    let photo = f::photo_png();
    let handle = serve.open(&photo, "row");
    serve.send(
        100,
        "Developer.render",
        &body(
            json!({"args": [f::SETTINGS, f::MAX_DIMENSION, false], "handle": handle}),
            &[],
        ),
    );
    serve.send(101, "version", &body(json!({}), &[]));
    let mut replies: HashMap<u32, Response> = HashMap::new();
    for _ in 0..2 {
        let reply = serve.receive();
        replies.insert(reply.id, reply);
    }
    assert_eq!(replies[&101].string(), api::version());
    let rendered = &replies[&100];
    let mut direct = api::Developer::new(&photo, 0).unwrap();
    let expected = direct.render(f::SETTINGS, f::MAX_DIMENSION, false).unwrap();
    assert_eq!(
        rendered.blob(&rendered.result()["rgba"]),
        &expected.rgba[..]
    );
    assert_eq!(serve.finish(), 0);
}

/// `Developer.free` lets go of one Developer, `releaseClient` of a
/// client's, and at most 64 are alive.
#[test]
fn developers_are_freed_and_released_by_client() {
    let mut serve = Serve::start();
    let tiny = niho_develop::encode::encode_png(&[60u8, 90, 120, 255].repeat(4 * 3), 4, 3).unwrap();
    let a = serve.open(&tiny, "a");
    let b = serve.open(&tiny, "a");
    let c = serve.open(&tiny, "b");
    let thumbnail = serve.call(
        "Developer.thumbnail",
        json!({"args": [0], "handle": c, "client": "a"}),
        &[],
    );
    let t = thumbnail.result()["handle"].as_u64().unwrap();
    assert_eq!(size_text_of(thumbnail.result()), "4x3");
    let white = |serve: &mut Serve, handle: u64| {
        serve.call("Developer.asShotWhite", json!({"handle": handle}), &[])
    };

    let freed = serve.call("Developer.free", json!({"handle": a}), &[]);
    assert_eq!(freed.result(), &Value::Null);
    expect_code(&white(&mut serve, a), "unknownHandle");
    expect_code(
        &serve.call("Developer.free", json!({"handle": a}), &[]),
        "unknownHandle",
    );
    assert_eq!(white(&mut serve, b).string(), "null");
    let released = serve.call("releaseClient", json!({"client": "a"}), &[]);
    assert_eq!(released.result(), 2);
    for handle in [b, t] {
        expect_code(&white(&mut serve, handle), "unknownHandle");
    }
    assert_eq!(white(&mut serve, c).string(), "null");
    let released = serve.call("releaseClient", json!({"client": "b"}), &[]);
    assert_eq!(released.result(), 1);
    expect_code(&white(&mut serve, c), "unknownHandle");
    let none = serve.call("releaseClient", json!({"client": "nobody"}), &[]);
    assert_eq!(none.result(), 0);
    expect_code(&serve.call("releaseClient", json!({}), &[]), "badRequest");

    let many: Vec<u64> = (0..64).map(|_| serve.open(&tiny, "many")).collect();
    expect_code(
        &serve.call(
            "Developer.new",
            json!({"args": [{"blob": 0}, 0], "client": "many"}),
            &[&tiny],
        ),
        "tooManyDevelopers",
    );
    expect_code(
        &serve.call(
            "Developer.thumbnail",
            json!({"args": [0], "handle": many[0], "client": "many"}),
            &[],
        ),
        "tooManyDevelopers",
    );
    let released = serve.call("releaseClient", json!({"client": "many"}), &[]);
    assert_eq!(released.result(), 64);
    serve.open(&tiny, "again");
    assert_eq!(serve.finish(), 0);
}

/// `serve` ends with exit 0 when its input ends (after the requests being
/// answered) and with exit 1 on a broken frame.
#[test]
fn serve_ends_with_its_input() {
    assert_eq!(Serve::start().finish(), 0);

    let mut serve = Serve::start();
    serve.send(5, "version", &body(json!({}), &[]));
    drop(serve.stdin.take());
    let reply = serve.receive();
    assert_eq!((reply.id, reply.string()), (5, api::version().as_str()));
    assert_eq!(serve.finish(), 0);

    let mut serve = Serve::start();
    serve.hello();
    let mut long_method = 1u32.to_le_bytes().to_vec();
    long_method.extend_from_slice(&200u32.to_le_bytes());
    serve.send_raw(&long_method);
    assert_eq!(serve.finish(), 1);

    let mut serve = Serve::start();
    serve.send_raw(&frame(1, "hello", b"")[..6]);
    assert_eq!(serve.finish(), 1);
}

/// What a request costs: final renders at 1280 of a 1600 x 1200 photo
/// through `serve` and with `api` directly (`cargo test --release -p
/// niho-develop-render --test serve -- --ignored --nocapture`).
#[test]
#[ignore = "timing, run by hand"]
fn the_cost_of_a_1280_render_through_serve() {
    let (w, h) = (1600usize, 1200usize);
    let mut rgba = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            let r = (x * 255 / w) as u8;
            let g = (y * 255 / h) as u8;
            let b = ((x / 7 + y / 5) % 256) as u8;
            rgba.extend_from_slice(&[r, g, b, 255]);
        }
    }
    let photo = niho_develop::encode::encode_png(&rgba, w, h).unwrap();
    let settings = |i: usize| {
        format!(
            r#"{{"v":1,"engine":"niho-14","look":"niho-standard-1","exposure":{},"shadows":30,"vibrance":10}}"#,
            0.1 + 0.05 * i as f64
        )
    };
    let runs = 6;

    let mut direct = api::Developer::new(&photo, 0).unwrap();
    direct.render(&settings(0), 1280, false).unwrap();
    let started = Instant::now();
    for i in 1..=runs {
        direct.render(&settings(i), 1280, false).unwrap();
    }
    let api_ms = started.elapsed().as_secs_f64() * 1000.0 / runs as f64;

    let mut serve = Serve::start();
    let handle = serve.open(&photo, "timing");
    let render = |serve: &mut Serve, i: usize| {
        let reply = serve.call(
            "Developer.render",
            json!({"args": [settings(i), 1280, false], "handle": handle}),
            &[],
        );
        assert_eq!(reply.result()["width"], 1280);
    };
    render(&mut serve, 0);
    let started = Instant::now();
    for i in 1..=runs {
        render(&mut serve, i);
    }
    let serve_ms = started.elapsed().as_secs_f64() * 1000.0 / runs as f64;
    eprintln!(
        "final render at 1280: api {api_ms:.1} ms, serve {serve_ms:.1} ms ({:+.1} ms a request)",
        serve_ms - api_ms
    );
    assert_eq!(serve.finish(), 0);
}
