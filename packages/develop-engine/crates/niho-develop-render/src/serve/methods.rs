//! The methods `serve` answers: the wasm's exports by their JS names
//! (`niho-develop-wasm`), each one call of `niho_develop::api`, plus
//! `hello` and `releaseClient`. The live Developers are kept by handle.

use std::collections::HashMap;
use std::panic::{self, AssertUnwindSafe};
use std::sync::{Arc, Mutex, MutexGuard};

use niho_develop::api;
use serde_json::{json, Value};

use super::request::{
    Fail, Reply, Request, INTERNAL, TOO_MANY_DEVELOPERS, UNKNOWN_HANDLE, UNKNOWN_METHOD,
};
use super::{panic_text, MAX_DEVELOPERS, PROTOCOL};

/// Every method `serve` answers (`hello`'s `methods`): the wasm's exports
/// by their JS names (a `Developer` method as `Developer.<name>`, its
/// constructor as `Developer.new`, without the `width` / `height` getters,
/// which the opening reply carries), then `hello` and `releaseClient`.
pub const METHODS: [&str; 30] = [
    "version",
    "capabilities",
    "render",
    "exportJpeg",
    "exportPng",
    "withCaptureExif",
    "beforeSettings",
    "imageSize",
    "rasterDecodeSize",
    "geometryOutputSize",
    "neutralSettings",
    "validateSettings",
    "builtinPresets",
    "presetSettings",
    "applyPreset",
    "settingsToXmp",
    "asShotWhiteFromMeta",
    "convertEditSettings",
    "Developer.new",
    "Developer.openWorkingCopy",
    "Developer.asShotWhite",
    "Developer.thumbnail",
    "Developer.render",
    "Developer.maskPlane",
    "Developer.sampleColor",
    "Developer.autoSettings",
    "Developer.estimateUpright",
    "Developer.free",
    "hello",
    "releaseClient",
];

type Shared = Arc<Mutex<api::Developer>>;

struct Entry {
    client: Option<String>,
    developer: Shared,
}

#[derive(Default)]
struct Registry {
    /// The last handle given (0 is never one).
    last: u32,
    entries: HashMap<u32, Entry>,
}

/// What `serve` keeps between requests: the live Developers.
#[derive(Default)]
pub struct State {
    registry: Mutex<Registry>,
}

impl State {
    fn registry(&self) -> MutexGuard<'_, Registry> {
        // Nothing panics while it is held; a poisoned lock is still whole.
        self.registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Fails when [`MAX_DEVELOPERS`] are open (checked before decoding).
    fn room(&self) -> Result<(), Fail> {
        if self.registry().entries.len() >= MAX_DEVELOPERS {
            return Err(too_many_developers());
        }
        Ok(())
    }

    /// Keeps `developer` and replies `{"handle","width","height"}`.
    fn open(&self, client: Option<String>, developer: api::Developer) -> Result<Reply, Fail> {
        let (width, height) = (developer.width(), developer.height());
        let mut registry = self.registry();
        if registry.entries.len() >= MAX_DEVELOPERS {
            return Err(too_many_developers());
        }
        let mut handle = registry.last;
        loop {
            handle = handle.wrapping_add(1).max(1);
            if !registry.entries.contains_key(&handle) {
                break;
            }
        }
        registry.last = handle;
        registry.entries.insert(
            handle,
            Entry {
                client,
                developer: Arc::new(Mutex::new(developer)),
            },
        );
        Ok(Reply::ok(
            json!({"handle": handle, "width": width, "height": height}),
        ))
    }

    fn entry(&self, method: &str, handle: Option<u32>) -> Result<(Shared, Option<String>), Fail> {
        let handle = needs_handle(method, handle)?;
        self.registry()
            .entries
            .get(&handle)
            .map(|entry| (Arc::clone(&entry.developer), entry.client.clone()))
            .ok_or_else(|| unknown_handle(handle))
    }

    fn developer(&self, method: &str, handle: Option<u32>) -> Result<Shared, Fail> {
        self.entry(method, handle).map(|(developer, _)| developer)
    }

    /// Lets go of a Developer (one being used finishes first).
    pub fn release(&self, handle: u32) -> bool {
        self.registry().entries.remove(&handle).is_some()
    }

    /// Lets go of every Developer opened with `client`.
    fn release_client(&self, client: &str) -> usize {
        let mut registry = self.registry();
        let before = registry.entries.len();
        registry
            .entries
            .retain(|_, entry| entry.client.as_deref() != Some(client));
        before - registry.entries.len()
    }

    /// The live Developers.
    #[cfg(test)]
    pub fn developers(&self) -> usize {
        self.registry().entries.len()
    }
}

fn too_many_developers() -> Fail {
    Fail::coded(
        TOO_MANY_DEVELOPERS,
        format!("{MAX_DEVELOPERS} Developers are open; free one first"),
    )
}

fn needs_handle(method: &str, handle: Option<u32>) -> Result<u32, Fail> {
    handle.ok_or_else(|| Fail::bad_request(format!("{method} needs a handle")))
}

fn unknown_handle(handle: u32) -> Fail {
    Fail::coded(UNKNOWN_HANDLE, format!("no Developer {handle}"))
}

fn lock(developer: &Shared) -> Result<MutexGuard<'_, api::Developer>, Fail> {
    developer.lock().map_err(|_| {
        Fail::coded(
            INTERNAL,
            "this Developer failed in an earlier call and was let go",
        )
    })
}

/// `hello`'s result.
pub fn hello() -> Value {
    json!({
        "protocol": PROTOCOL,
        "tool": crate::version_line(),
        "crateVersion": niho_develop::CRATE_VERSION,
        "engine": niho_develop::ENGINE_VERSION,
        // #148: the rayon pool's thread count once niho-develop has its
        // `threads` feature (1 without it).
        "threads": 1,
        "methods": METHODS,
    })
}

/// Answers one request body for `method`.
pub fn respond(state: &State, method: &str, body: &[u8]) -> Reply {
    if !METHODS.contains(&method) {
        return Fail::coded(UNKNOWN_METHOD, format!("unknown method '{method}'")).into();
    }
    let request = match Request::parse(body) {
        Ok(request) => request,
        Err(fail) => return fail.into(),
    };
    let handle = if method.starts_with("Developer.")
        && !matches!(method, "Developer.new" | "Developer.openWorkingCopy")
    {
        request.handle
    } else {
        None
    };
    guarded(state, handle, || call(state, method, &request))
}

/// Runs a call; a panic is an `internal` reply and lets go of the
/// Developer `handle` (its state may be half updated).
pub fn guarded(
    state: &State,
    handle: Option<u32>,
    f: impl FnOnce() -> Result<Reply, Fail>,
) -> Reply {
    match panic::catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(reply)) => reply,
        Ok(Err(fail)) => fail.into(),
        Err(payload) => {
            if let Some(handle) = handle {
                state.release(handle);
            }
            Fail::coded(INTERNAL, format!("panic: {}", panic_text(&*payload))).into()
        }
    }
}

fn call(state: &State, method: &str, request: &Request<'_>) -> Result<Reply, Fail> {
    let args = &request.args;
    let client = || request.client.clone();
    Ok(match method {
        "hello" => {
            args.expect(0, 0)?;
            Reply::ok(hello())
        }
        "version" => {
            args.expect(0, 0)?;
            Reply::text(api::version())
        }
        "capabilities" => {
            args.expect(0, 0)?;
            Reply::text(api::capabilities())
        }
        "render" => {
            args.expect(3, 4)?;
            let frame = api::render(args.blob(0)?, args.str(1)?, args.u32(2)?, args.opt_u32(3)?)
                .map_err(Fail::call)?;
            Reply::frame(frame)
        }
        "exportJpeg" => {
            args.expect(4, 5)?;
            let jpeg = api::export_jpeg(
                args.blob(0)?,
                args.str(1)?,
                args.u32(2)?,
                args.u8(3)?,
                args.opt_u32(4)?,
            )
            .map_err(Fail::call)?;
            Reply::bytes(jpeg)
        }
        "exportPng" => {
            args.expect(3, 4)?;
            let png = api::export_png(args.blob(0)?, args.str(1)?, args.u32(2)?, args.opt_u32(3)?)
                .map_err(Fail::call)?;
            Reply::bytes(png)
        }
        "withCaptureExif" => {
            args.expect(3, 3)?;
            let jpeg = api::with_capture_exif(args.blob(0)?, args.opt_str(1)?, args.i32(2)?)
                .map_err(Fail::call)?;
            Reply::bytes(jpeg)
        }
        "beforeSettings" => {
            args.expect(1, 1)?;
            Reply::text(api::before_settings(args.str(0)?).map_err(Fail::call)?)
        }
        "imageSize" => {
            args.expect(1, 1)?;
            let size = api::image_size(args.blob(0)?).map_err(Fail::call)?;
            Reply::size(size.width, size.height)
        }
        "rasterDecodeSize" => {
            args.expect(5, 5)?;
            let size = api::raster_decode_size(
                args.str(0)?,
                args.u32(1)?,
                args.u32(2)?,
                args.u32(3)?,
                args.u32(4)?,
            )
            .map_err(Fail::call)?;
            Reply::ok(json!(size))
        }
        "geometryOutputSize" => {
            args.expect(4, 4)?;
            let size =
                api::geometry_output_size(args.str(0)?, args.u32(1)?, args.u32(2)?, args.u32(3)?)
                    .map_err(Fail::call)?;
            Reply::size(size.width, size.height)
        }
        "neutralSettings" => {
            args.expect(0, 0)?;
            Reply::text(api::neutral_settings())
        }
        "validateSettings" => {
            args.expect(1, 1)?;
            Reply::text(api::validate_settings(args.str(0)?))
        }
        "builtinPresets" => {
            args.expect(0, 0)?;
            Reply::text(api::builtin_presets())
        }
        "presetSettings" => {
            args.expect(1, 2)?;
            Reply::text(api::preset_settings(args.str(0)?, args.opt_str(1)?).map_err(Fail::call)?)
        }
        "applyPreset" => {
            args.expect(3, 4)?;
            let result =
                api::apply_preset(args.str(0)?, args.str(1)?, args.f64(2)?, args.opt_str(3)?)
                    .map_err(Fail::call)?;
            Reply::text(result)
        }
        "settingsToXmp" => {
            args.expect(1, 2)?;
            Reply::text(api::settings_to_xmp(args.str(0)?, args.opt_str(1)?).map_err(Fail::call)?)
        }
        "asShotWhiteFromMeta" => {
            args.expect(1, 1)?;
            Reply::text(api::as_shot_white_from_meta(args.str(0)?).map_err(Fail::call)?)
        }
        "convertEditSettings" => {
            args.expect(1, 2)?;
            let result = api::convert_edit_settings(args.str(0)?, args.opt_str(1)?)
                .map_err(Fail::call)?;
            Reply::text(result)
        }
        "Developer.new" => {
            args.expect(2, 2)?;
            let (input, working_max_dimension) = (args.blob(0)?, args.u32(1)?);
            state.room()?;
            let developer =
                api::Developer::new(input, working_max_dimension).map_err(Fail::call)?;
            state.open(client(), developer)?
        }
        "Developer.openWorkingCopy" => {
            args.expect(2, 2)?;
            let (png, meta_json) = (args.blob(0)?, args.str(1)?);
            state.room()?;
            let developer =
                api::Developer::open_working_copy(png, meta_json).map_err(Fail::call)?;
            state.open(client(), developer)?
        }
        "Developer.asShotWhite" => {
            args.expect(0, 0)?;
            let developer = state.developer(method, request.handle)?;
            let white = lock(&developer)?.as_shot_white();
            Reply::text(white)
        }
        "Developer.thumbnail" => {
            args.expect(1, 1)?;
            let max_dimension = args.u32(0)?;
            let (developer, parent_client) = state.entry(method, request.handle)?;
            state.room()?;
            let thumbnail = lock(&developer)?.thumbnail(max_dimension);
            state.open(client().or(parent_client), thumbnail)?
        }
        "Developer.render" => {
            args.expect(3, 3)?;
            let (settings, max_dimension, interactive) =
                (args.str(0)?, args.u32(1)?, args.bool(2)?);
            let developer = state.developer(method, request.handle)?;
            let frame = lock(&developer)?
                .render(settings, max_dimension, interactive)
                .map_err(Fail::call)?;
            Reply::frame(frame)
        }
        "Developer.maskPlane" => {
            args.expect(3, 3)?;
            let (settings, mask_id, max_dimension) = (args.str(0)?, args.str(1)?, args.u32(2)?);
            let developer = state.developer(method, request.handle)?;
            let plane = lock(&developer)?
                .mask_plane(settings, mask_id, max_dimension)
                .map_err(Fail::call)?;
            Reply::ok_with(
                json!({"width": plane.width, "height": plane.height, "data": {"blob": 0}}),
                vec![plane.data],
            )
        }
        "Developer.sampleColor" => {
            args.expect(4, 4)?;
            let (settings, max_dimension, x, y) =
                (args.str(0)?, args.u32(1)?, args.f64(2)?, args.f64(3)?);
            let developer = state.developer(method, request.handle)?;
            let color = lock(&developer)?
                .sample_color(settings, max_dimension, x, y)
                .map_err(Fail::call)?;
            Reply::ok(json!({
                "lightness": color.lightness,
                "chroma": color.chroma,
                "hue": color.hue,
            }))
        }
        "Developer.autoSettings" => {
            args.expect(1, 1)?;
            let settings = args.str(0)?;
            let developer = state.developer(method, request.handle)?;
            let result = lock(&developer)?
                .auto_settings(settings)
                .map_err(Fail::call)?;
            Reply::text(result)
        }
        "Developer.estimateUpright" => {
            args.expect(2, 2)?;
            let (settings, mode) = (args.str(0)?, args.u32(1)?);
            let developer = state.developer(method, request.handle)?;
            let result = lock(&developer)?
                .estimate_upright(settings, mode)
                .map_err(Fail::call)?;
            Reply::text(result)
        }
        "Developer.free" => {
            args.expect(0, 0)?;
            let handle = needs_handle(method, request.handle)?;
            if !state.release(handle) {
                return Err(unknown_handle(handle));
            }
            Reply::ok(Value::Null)
        }
        "releaseClient" => {
            args.expect(0, 0)?;
            let client = request
                .client
                .as_deref()
                .ok_or_else(|| Fail::bad_request("releaseClient needs a client"))?;
            Reply::ok(json!(state.release_client(client)))
        }
        _ => {
            return Err(Fail::coded(
                UNKNOWN_METHOD,
                format!("unknown method '{method}'"),
            ))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{guarded, respond, State, METHODS};
    use crate::serve::request::{BAD_REQUEST, INTERNAL, UNKNOWN_METHOD};

    fn photo() -> Vec<u8> {
        niho_develop::encode::encode_png(&[90u8, 120, 150, 255].repeat(8 * 6), 8, 6).unwrap()
    }

    fn body(header: &serde_json::Value, blobs: &[&[u8]]) -> Vec<u8> {
        let mut header = header.clone();
        header["blobs"] = blobs.iter().map(|b| b.len()).collect::<Vec<_>>().into();
        let text = serde_json::to_vec(&header).unwrap();
        let mut out = (text.len() as u32).to_le_bytes().to_vec();
        out.extend_from_slice(&text);
        for blob in blobs {
            out.extend_from_slice(blob);
        }
        out
    }

    /// Every listed method is answered (here without its arguments), and
    /// nothing else is.
    #[test]
    fn every_listed_method_is_dispatched() {
        let state = State::default();
        for method in METHODS {
            let reply = respond(&state, method, &[]);
            assert_ne!(reply.code(), Some(UNKNOWN_METHOD), "{method}");
        }
        assert_eq!(
            respond(&state, "Developer.width", &[]).code(),
            Some(UNKNOWN_METHOD)
        );
        assert_eq!(
            respond(&state, "Developer.render", &[]).code(),
            Some(BAD_REQUEST)
        );
        let mut sorted = METHODS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), METHODS.len());
    }

    /// A panic is an `internal` reply and lets go of the Developer it used.
    #[test]
    fn a_panic_lets_go_of_its_developer() {
        let state = State::default();
        let photo = photo();
        let opened = respond(
            &state,
            "Developer.new",
            &body(&serde_json::json!({"args": [{"blob": 0}, 0]}), &[&photo]),
        );
        let handle = opened.header()["result"]["handle"].as_u64().unwrap() as u32;
        assert_eq!(opened.header()["result"]["width"], 8);
        assert_eq!(state.developers(), 1);
        let reply = guarded(&state, Some(handle), || panic!("boom"));
        assert_eq!(reply.code(), Some(INTERNAL));
        assert_eq!(reply.header()["error"], "panic: boom");
        assert_eq!(state.developers(), 0);
    }
}
