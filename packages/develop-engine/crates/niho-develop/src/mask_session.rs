//! The layered render of local masks in a [`Session`] (`docs/local-adjustments.md`
//! "描画と混ぜ方", Epic #31 M2 = #66): `R0` from the global settings, one
//! `R_k` per drawn mask from its local settings ([`local_render::local_settings`])
//! at the same size and quality, blended with each mask's plane
//! ([`local_render::blend`]).
//!
//! A Session keeps single-slot caches for its next frame (cubes, the local
//! pass, the point plane, the `niho-6` / NIHO 3 master, the reduction, the
//! window, the statistics). Rendering `R0` and the `R_k` in turn would make
//! each frame evict the previous one's, so every layer keeps its own:
//!
//! - **Settings caches** ([`LayerCaches`]: cubes, local pass, point plane,
//!   the `niho-6` analysis of its last frame) are always the layer's own;
//!   they are swapped into the Session around the layer's render. A layer
//!   drawing from `R0`'s image reads `R0`'s local pass when it is the one
//!   it would compute (a delta outside Highlights / Shadows / Texture /
//!   Clarity: the same input and adaptive parameters), instead of keeping
//!   a copy.
//! - **Source caches** (the master, the parked master, the per-size
//!   reduction, the geometry window and the adaptive statistics) depend on
//!   the image the layer draws from, not on the settings around it. A layer
//!   whose image is `R0`'s (no master on either, or the same master key:
//!   its delta leaves the master's inputs as they are) uses `R0`'s in place,
//!   so memory does not grow with the layers. A layer whose delta changes
//!   the master's inputs (exposure, white balance, Highlights / Shadows,
//!   Texture or the noise reduction of a signed RAW; Exposure, Highlights <
//!   0 or Shadows > 0 of `niho-6`) keeps its own, made from `R0`'s analysis
//!   — for drag frames: a released frame's full-source master is dropped
//!   after the layer's frame (the Session keeps one full master, `R0`'s; the
//!   layer's released frame is kept instead). When `R0`'s frame is kept from
//!   an earlier one and a layer that draws from `R0`'s image of this frame
//!   renders, `R0`'s master is first made this frame's (its parked full
//!   master taken back, or a display-size one made for a drag), as `R0`'s
//!   own render would, so that layer shares it.
//! - **Frames.** `R0` and each `R_k` are kept per quality with the settings
//!   they were drawn from, so dragging one mask's slider renders that layer
//!   only, and releasing a mask's slider (Final) renders only that layer
//!   when the other layers' Final frames are still those settings'. A Final
//!   render invalidates all Interactive frames because it can refresh the
//!   frozen `niho-6` analysis used by drag renders. A plane is kept per
//!   layer while the mask's shape (a surface mask's: its surface's id, which
//!   names the surface's bytes, and size), the geometry and the size stay;
//!   dropping a surface drops the planes made from it.
//! - **A drag of a global slider** (#92) reuses the layers' differences: an
//!   Interactive frame that draws the layers keeps their blend terms
//!   `S = sum_k ((R_k - R0) * w_k + 32768) >> 16` ([`DragAnchor`]); the next
//!   Interactive frames that move one global slider from that frame's value
//!   (within its bound, [`DRAG_SLIDERS`]; at most [`DRAG_REUSE_MAX_FRAMES`]
//!   frames), with the same masks, size and the rest of the settings, draw
//!   only `R0` and output `clamp(R0 + S)` ([`local_render::add_sum`]).
//!   Anything else draws the layers (and anchors the next frames); a Final
//!   frame is always exact and drops the anchor with the Interactive frames.
//!
//! `brush` / `subject` / `sky` masks sample the Session's surface of their
//! `surface.id` ([`Session::set_mask_surface`]): a frame with an active one
//! whose surface is not set is [`Error::MaskSurfaceMissing`], of another
//! size than `surface.width` / `surface.height` [`Error::MaskSurfaceMismatch`],
//! before anything is drawn.
//!
//! The layers of masks that are gone or no longer active are dropped at the
//! next frame; a frame without an active mask drops them all.

use crate::local_mask::{self, LocalMask, MaskShape};
use crate::local_render::{self, PlaneError, SourceMap};
use crate::mask_surface::MaskSurface;
use crate::pipeline::{self, Rendered};
use crate::settings::{DevelopSettings, WhiteBalanceMode};
use crate::spatial::{self, Quality};
use crate::{
    frame, niho6, rendered_geometry, Error, Framed, HeadWhiteBalance, ParkedNiho3, PreparedNiho3,
    RawEngine, Session, SessionSource, SettingsError,
};
use serde_json::Value;
use std::sync::Arc;

/// The layers of one Session's masked frames.
#[derive(Default)]
pub(crate) struct MaskLayers {
    /// `R0`'s last frame at each quality.
    base: FrameSlots,
    layers: Vec<MaskLayer>,
    /// The layers' differences that a drag of a global slider reuses (the
    /// last Interactive frame that drew the layers; dropped with the
    /// Interactive frames).
    anchor: Option<DragAnchor>,
}

impl MaskLayers {
    fn invalidate_interactive(&mut self) {
        self.base.interactive = None;
        for layer in &mut self.layers {
            layer.frames.interactive = None;
        }
        self.anchor = None;
    }

    /// Drops the planes made from the surface `id`.
    pub(crate) fn forget_surface(&mut self, id: &str) {
        for layer in &mut self.layers {
            if layer
                .plane
                .as_ref()
                .is_some_and(|plane| plane.surface.as_deref() == Some(id))
            {
                layer.plane = None;
            }
        }
        self.anchor = None;
    }
}

/// A global slider that a drag may move while the layers' differences are
/// reused, and how far from the anchor's value (`docs/local-adjustments.md`
/// "層の持ち方"): the top-level sliders of the global settings. The
/// absolute white balance's `whiteBalance.temperature` and
/// `whiteBalance.tint` are [`white_balance_move`]'s. The bounds keep the
/// reused frame near the exact one (`a_reused_drag_frame_stays_close_to_the_exact_one`):
/// the differences of the layers change with the global value they sit on
/// (Exposure the fastest).
const DRAG_SLIDERS: [(&str, f64); 23] = [
    ("exposure", 0.5),
    ("contrast", 25.0),
    ("highlights", 25.0),
    ("shadows", 25.0),
    ("whites", 25.0),
    ("blacks", 25.0),
    ("texture", 25.0),
    ("clarity", 25.0),
    ("dehaze", 25.0),
    ("vibrance", 25.0),
    ("saturation", 25.0),
    ("relativeTemperature", 25.0),
    ("relativeTint", 25.0),
    ("parametricShadows", 25.0),
    ("parametricDarks", 25.0),
    ("parametricLights", 25.0),
    ("parametricHighlights", 25.0),
    ("parametricShadowSplit", 25.0),
    ("parametricMidtoneSplit", 25.0),
    ("parametricHighlightSplit", 25.0),
    ("colorNoiseReduction", 25.0),
    ("colorNoiseReductionDetail", 25.0),
    ("colorNoiseReductionSmoothness", 25.0),
];

/// The bound of an absolute white balance's temperature, in mired (the
/// editor's slider is even in mired; 40 is 5500 K to about 4600 / 7000 K),
/// and of its tint.
const DRAG_TEMPERATURE_MIRED: f64 = 40.0;
const DRAG_TINT: f64 = 25.0;

/// At most this many drag frames in a row reuse one anchor; the next one
/// draws the layers again (a new anchor).
const DRAG_REUSE_MAX_FRAMES: usize = 60;

/// How far the one global slider in which the canonical values of two
/// global settings differ has moved, in its bounds ([`DRAG_SLIDERS`]; up to
/// 1 is reused): `None` when they are the same, or differ in more than one
/// value or in anything but such a slider.
fn slider_move(anchor: &Value, now: &Value) -> Option<f64> {
    let (Value::Object(a), Value::Object(b)) = (anchor, now) else {
        return None;
    };
    if a.len() != b.len() {
        return None;
    }
    let mut moved = None;
    for (key, before) in a {
        let after = b.get(key)?;
        if before == after {
            continue;
        }
        if moved.is_some() {
            return None;
        }
        moved = Some(match (key.as_str(), before, after) {
            ("whiteBalance", Value::Object(x), Value::Object(y)) => white_balance_move(x, y)?,
            _ => {
                let (_, bound) = DRAG_SLIDERS.iter().find(|(name, _)| name == key)?;
                (before.as_f64()? - after.as_f64()?).abs() / bound
            }
        });
    }
    moved
}

/// The move of one of an absolute white balance's temperature (in mired,
/// as the editor's slider) and tint, in its bound; `None` for any other
/// change.
fn white_balance_move(
    a: &serde_json::Map<String, Value>,
    b: &serde_json::Map<String, Value>,
) -> Option<f64> {
    let absolute = Some(&Value::from(WhiteBalanceMode::Absolute.as_str()));
    if a.len() != b.len() || a.get("mode") != absolute || b.get("mode") != absolute {
        return None;
    }
    let mired = |kelvin: f64| 1e6 / kelvin;
    let mut moved = None;
    for (key, before) in a {
        let after = b.get(key)?;
        if before == after {
            continue;
        }
        if moved.is_some() {
            return None;
        }
        let (x, y) = (before.as_f64()?, after.as_f64()?);
        moved = Some(match key.as_str() {
            "temperature" => (mired(x) - mired(y)).abs() / DRAG_TEMPERATURE_MIRED,
            "tint" => (x - y).abs() / DRAG_TINT,
            _ => return None,
        });
    }
    moved
}

/// The layers' differences of the frame a drag of a global slider started
/// from (`docs/local-adjustments.md` "層の持ち方"): while the next
/// Interactive frames move one global slider from this frame's value (by at
/// most its bound in [`DRAG_SLIDERS`], for at most
/// [`DRAG_REUSE_MAX_FRAMES`] frames), with the same masks, size and the
/// rest of the settings, they draw only `R0` and add `sum` to it
/// ([`local_render::add_sum`]) instead of drawing the layers.
struct DragAnchor {
    /// The (capped) `max_dimension` and the size of its frame.
    max_dimension: usize,
    size: (usize, usize),
    /// The canonical JSON of the settings' `masks` (ids, kinds, shapes,
    /// `invert`, `enabled`, `adjust`, surface ids).
    masks: String,
    /// The canonical value of the global settings (without `masks`).
    global: Value,
    /// `sum_k ((R_k - R0) * w_k + 32768) >> 16` per pixel and RGB channel
    /// ([`local_render::blend_keeping_sum`]).
    sum: Vec<i16>,
    /// The layers' approximations.
    approximations: Vec<&'static str>,
    /// The frames drawn from it so far.
    reused: usize,
}

impl DragAnchor {
    fn serves(&self, max_dimension: usize, masks: &str, global: &Value) -> bool {
        self.max_dimension == max_dimension
            && self.masks == masks
            && self.reused < DRAG_REUSE_MAX_FRAMES
            && slider_move(&self.global, global).is_some_and(|m| m <= 1.0)
    }
}

/// A frame per quality with the key it was drawn for.
#[derive(Default)]
struct FrameSlots {
    interactive: Option<(String, Rendered)>,
    released: Option<(String, Rendered)>,
}

impl FrameSlots {
    fn slot(&mut self, quality: Quality) -> &mut Option<(String, Rendered)> {
        match quality {
            Quality::Interactive => &mut self.interactive,
            Quality::Final => &mut self.released,
        }
    }

    fn slot_ref(&self, quality: Quality) -> &Option<(String, Rendered)> {
        match quality {
            Quality::Interactive => &self.interactive,
            Quality::Final => &self.released,
        }
    }

    fn get(&self, quality: Quality, key: &str) -> Option<&Rendered> {
        self.slot_ref(quality)
            .as_ref()
            .filter(|(k, _)| k == key)
            .map(|(_, frame)| frame)
    }
}

/// Adds the approximations of `from` that `into` does not list yet.
fn merge_approximations(into: &mut Vec<&'static str>, from: &[&'static str]) {
    for a in from {
        if !into.contains(a) {
            into.push(a);
        }
    }
}

/// What a frame of `settings` at `max_dimension` / `quality` is drawn from.
fn frame_key(settings: &DevelopSettings, max_dimension: usize, quality: Quality) -> String {
    format!("{max_dimension}|{quality:?}|{}", settings.to_json())
}

/// One mask's plane.
struct Plane {
    key: String,
    /// The surface it was sampled from (a surface mask's).
    surface: Option<String>,
    weights: Vec<u32>,
    /// Whether any weight is not 0 (an all-zero plane draws nothing).
    any: bool,
}

struct MaskLayer {
    id: String,
    caches: LayerCaches,
    /// The image this layer's local pass and point plane were made from
    /// (`None` the source, else the master key); `None` before its first
    /// frame.
    made_on: Option<Option<String>>,
    frames: FrameSlots,
    plane: Option<Plane>,
}

/// A layer's caches, swapped with the Session's around its render.
#[derive(Default)]
struct LayerCaches {
    cubes: Option<pipeline::SettingsCubes>,
    local: Option<pipeline::LocalPass>,
    color_points: Option<pipeline::ColorPointPlane>,
    niho6_last_used: Option<(Option<HeadWhiteBalance>, Arc<niho6::Analysis>)>,
    niho6_last_detail: Option<String>,
    niho3: Option<PreparedNiho3>,
    parked_niho3: Option<ParkedNiho3>,
    sized: Option<(usize, SessionSource)>,
    framed: Option<Framed>,
    stats: Vec<(usize, Quality, spatial::AdaptiveStats)>,
}

impl LayerCaches {
    /// Drops the source caches (the layer draws from `R0`'s image).
    fn drop_source(&mut self) {
        self.niho3 = None;
        self.parked_niho3 = None;
        self.sized = None;
        self.framed = None;
        self.stats.clear();
    }
}

fn plane_error(e: PlaneError) -> Error {
    match e {
        PlaneError::SurfaceMissing(id) => Error::MaskSurfaceMissing(id),
        PlaneError::SurfaceMismatch {
            mask,
            surface,
            expected,
            actual,
        } => Error::MaskSurfaceMismatch {
            mask,
            surface,
            expected,
            actual,
        },
    }
}

fn invalid_crop() -> Error {
    Error::InvalidSettings(vec![SettingsError::new(
        "geometry.crop",
        "invalidCrop",
        "the corners do not make a rectangle at this angle on this photo",
    )])
}

impl Session {
    /// The surface a mask samples (`None` for linear and radial masks):
    /// the one set under its `surface.id`, of its `surface` size.
    fn surface_of(&self, mask: &LocalMask) -> Result<Option<Arc<MaskSurface>>, Error> {
        let MaskShape::Surface(reference) = &mask.shape else {
            return Ok(None);
        };
        let surface = self
            .mask_surfaces
            .get(&reference.id)
            .ok_or_else(|| Error::MaskSurfaceMissing(mask.id.clone()))?;
        let actual = (surface.width(), surface.height());
        if actual != (reference.width, reference.height) {
            return Err(Error::MaskSurfaceMismatch {
                mask: mask.id.clone(),
                surface: reference.id.clone(),
                expected: (reference.width, reference.height),
                actual,
            });
        }
        Ok(Some(Arc::clone(surface)))
    }

    /// The output-to-working-image map of `settings`' geometry.
    fn mask_map(&self, settings: &DevelopSettings) -> Result<SourceMap, Error> {
        let (w, h) = self.working_size;
        SourceMap::new(rendered_geometry(settings), w, h).map_err(|_| invalid_crop())
    }

    /// One mask's 8-bit plane (`round(w / 65536 * 255)`, row-major, its
    /// `invert` applied, whether or not it is enabled) at the size a render
    /// of `settings` at `max_dimension` has, from the same map and plane as
    /// the render. For the editor's overlay; the Session's frame state is
    /// not touched. A `brush` / `subject` / `sky` mask samples its surface
    /// ([`Session::set_mask_surface`]; without it
    /// [`Error::MaskSurfaceMissing`], of another size
    /// [`Error::MaskSurfaceMismatch`]).
    pub fn mask_plane(
        &self,
        settings: &DevelopSettings,
        mask_id: &str,
        max_dimension: usize,
    ) -> Result<(usize, usize, Vec<u8>), Error> {
        let issues = settings.validate();
        if !issues.is_empty() {
            return Err(Error::InvalidSettings(issues));
        }
        let mask = settings
            .masks
            .iter()
            .find(|m| m.id == mask_id)
            .ok_or_else(|| Error::MaskNotFound(mask_id.to_string()))?;
        let (sw, sh) = self.source.size();
        let capped = self.capped_dimension(max_dimension);
        let (w, h) = frame::output_size(rendered_geometry(settings), sw, sh, capped)
            .map_err(|e| Error::InvalidSettings(vec![e]))?;
        let map = self.mask_map(settings)?;
        let surface = self.surface_of(mask)?;
        let weights = local_render::mask_weights(mask, &map, w, h, surface.as_deref())
            .map_err(plane_error)?;
        Ok((
            w,
            h,
            weights
                .into_iter()
                .map(local_render::weight_to_u8)
                .collect(),
        ))
    }

    /// [`Session::render`] of settings with an active mask.
    pub(crate) fn render_masked(
        &mut self,
        settings: &DevelopSettings,
        max_dimension: usize,
        quality: Quality,
    ) -> Result<Rendered, Error> {
        // Every surface mask that is drawn needs its surface, before anything
        // is drawn. A layer whose local settings equal the global ones (its
        // delta clamped away by the global value) is not drawn
        // (`render_layers`), so it needs none either.
        let global = local_render::without_masks(settings);
        for mask in settings.masks.iter().filter(|m| m.is_active()) {
            if local_render::local_settings(&global, &mask.adjust) == global {
                continue;
            }
            self.surface_of(mask)?;
        }
        let max_dimension = self.capped_dimension(max_dimension);
        let mut layers = self.masks.take().unwrap_or_default();
        let result = self.render_layers(&mut layers, settings, max_dimension, quality);
        self.masks = Some(layers);
        result
    }

    fn render_layers(
        &mut self,
        state: &mut MaskLayers,
        settings: &DevelopSettings,
        max_dimension: usize,
        quality: Quality,
    ) -> Result<Rendered, Error> {
        if quality == Quality::Final {
            state.invalidate_interactive();
        }
        let global = local_render::without_masks(settings);
        let masks = local_mask::masks_value(&settings.masks).to_string();
        let global_value = global.to_value();
        if quality == Quality::Interactive {
            if let Some(frame) =
                self.render_reusing(state, &global, &global_value, &masks, max_dimension)?
            {
                return Ok(frame);
            }
            // This frame draws the layers: it becomes the anchor below.
            state.anchor = None;
        }
        let base_key = frame_key(&global, max_dimension, quality);
        // Whether R0's source caches are of this frame (its size and
        // quality): not when its frame comes from an earlier one.
        let mut base_ready = false;
        if state.base.get(quality, &base_key).is_none() {
            *state.base.slot(quality) = None;
            let frame = self.render_one(&global, max_dimension, quality)?;
            *state.base.slot(quality) = Some((base_key.clone(), frame));
            base_ready = true;
        }
        // The image R0's own render would draw from at this frame.
        let base_due = if base_ready {
            None
        } else {
            Some(self.image_identity(&global, max_dimension, quality)?)
        };
        let (width, height) = {
            let base = state.base.get(quality, &base_key).expect("R0");
            (base.width, base.height)
        };
        let map = self.mask_map(&global)?;
        let map_key = map.key();
        // The image R0 draws from now (its master's key): a layer drawing
        // from the same image uses R0's source caches.
        let mut base_image = self.niho3.as_ref().map(|prepared| prepared.key.clone());
        let active: Vec<&LocalMask> = settings.masks.iter().filter(|m| m.is_active()).collect();
        state
            .layers
            .retain(|layer| active.iter().any(|mask| mask.id == layer.id));
        let mut drawn = Vec::new();
        for mask in active {
            let local = local_render::local_settings(&global, &mask.adjust);
            if local == global {
                continue;
            }
            let index = match state.layers.iter().position(|layer| layer.id == mask.id) {
                Some(index) => index,
                None => {
                    state.layers.push(MaskLayer {
                        id: mask.id.clone(),
                        caches: LayerCaches::default(),
                        made_on: None,
                        frames: FrameSlots::default(),
                        plane: None,
                    });
                    state.layers.len() - 1
                }
            };
            let layer = &mut state.layers[index];
            let plane_key = format!(
                "{}|{map_key}|{width}x{height}",
                local_render::shape_key(mask)
            );
            if layer.plane.as_ref().is_none_or(|p| p.key != plane_key) {
                layer.plane = None;
                let surface = self.surface_of(mask)?;
                let weights =
                    local_render::mask_weights(mask, &map, width, height, surface.as_deref())
                        .map_err(plane_error)?;
                let any = weights.iter().any(|w| *w != 0);
                layer.plane = Some(Plane {
                    key: plane_key,
                    surface: match &mask.shape {
                        MaskShape::Surface(reference) => Some(reference.id.clone()),
                        _ => None,
                    },
                    weights,
                    any,
                });
            }
            if !layer.plane.as_ref().is_some_and(|p| p.any) {
                continue;
            }
            let key = frame_key(&local, max_dimension, quality);
            if layer.frames.get(quality, &key).is_none() {
                *layer.frames.slot(quality) = None;
                if !base_ready
                    && base_due.as_ref() != Some(&base_image)
                    && base_due == Some(self.layer_image(layer, &local, max_dimension, quality)?)
                {
                    // R0's frame was kept, but its master is of the other
                    // quality (a drag frame's display-size one, the full
                    // one parked) and this layer draws from R0's image of
                    // this frame: make R0's master this frame's, as R0's
                    // own render would, so the layer shares it instead of
                    // preparing one.
                    self.prepare_master(&global, max_dimension, quality)?;
                    base_image = self.niho3.as_ref().map(|prepared| prepared.key.clone());
                    base_ready = true;
                }
                let frame = self.render_layer(
                    layer,
                    &local,
                    max_dimension,
                    quality,
                    base_image.as_deref(),
                )?;
                assert_eq!(
                    (frame.width, frame.height),
                    (width, height),
                    "a layer renders R0's frame"
                );
                *layer.frames.slot(quality) = Some((key.clone(), frame));
            }
            drawn.push((index, key));
        }
        let base = state.base.get(quality, &base_key).expect("R0");
        let mut layer_approximations = Vec::new();
        let mut terms: Vec<(&[u8], &[u32])> = Vec::with_capacity(drawn.len());
        for (index, key) in &drawn {
            let layer = &state.layers[*index];
            let frame = layer.frames.get(quality, key).expect("R_k");
            merge_approximations(&mut layer_approximations, &frame.approximations);
            let plane = layer.plane.as_ref().expect("plane");
            terms.push((&frame.rgba, &plane.weights));
        }
        let mut approximations = base.approximations.clone();
        merge_approximations(&mut approximations, &layer_approximations);
        let mut anchor = None;
        let rgba = if terms.is_empty() {
            base.rgba.clone()
        } else if quality == Quality::Interactive {
            // The same bytes as the blend, keeping the layers' terms for the
            // drag frames that follow.
            let (rgba, sum) = local_render::blend_keeping_sum(&base.rgba, &terms);
            anchor = Some(DragAnchor {
                max_dimension,
                size: (width, height),
                masks,
                global: global_value,
                sum,
                approximations: layer_approximations,
                reused: 0,
            });
            rgba
        } else {
            local_render::blend(&base.rgba, &terms)
        };
        state.anchor = anchor;
        Ok(Rendered {
            width,
            height,
            rgba,
            approximations,
        })
    }

    /// A drag frame of a global slider from the anchor's differences
    /// ([`DragAnchor`]): `R0` drawn as always, plus the anchor's terms
    /// ([`local_render::add_sum`]); the layers are not drawn. `None` when
    /// the anchor does not serve this frame (the layers are drawn).
    fn render_reusing(
        &mut self,
        state: &mut MaskLayers,
        global: &DevelopSettings,
        global_value: &Value,
        masks: &str,
        max_dimension: usize,
    ) -> Result<Option<Rendered>, Error> {
        let quality = Quality::Interactive;
        if !state
            .anchor
            .as_ref()
            .is_some_and(|anchor| anchor.serves(max_dimension, masks, global_value))
        {
            return Ok(None);
        }
        let base_key = frame_key(global, max_dimension, quality);
        if state.base.get(quality, &base_key).is_none() {
            *state.base.slot(quality) = None;
            let frame = self.render_one(global, max_dimension, quality)?;
            *state.base.slot(quality) = Some((base_key.clone(), frame));
        }
        let base = state.base.get(quality, &base_key).expect("R0");
        let size = (base.width, base.height);
        let anchor = state.anchor.as_mut().expect("anchor");
        if anchor.size != size {
            return Ok(None);
        }
        anchor.reused += 1;
        let mut approximations = base.approximations.clone();
        merge_approximations(&mut approximations, &anchor.approximations);
        Ok(Some(Rendered {
            width: size.0,
            height: size.1,
            rgba: local_render::add_sum(&base.rgba, &anchor.sum),
            approximations,
        }))
    }

    /// The image a layer's frame of `local` draws from
    /// ([`Session::image_identity`] with the layer's analysis state).
    fn layer_image(
        &mut self,
        layer: &mut MaskLayer,
        local: &DevelopSettings,
        max_dimension: usize,
        quality: Quality,
    ) -> Result<Option<String>, Error> {
        self.swap_settings_caches(&mut layer.caches);
        let image = self.image_identity(local, max_dimension, quality);
        self.swap_settings_caches(&mut layer.caches);
        image
    }

    /// The master step of [`Session::render_one`] alone (the frame of
    /// `settings` itself is kept).
    fn prepare_master(
        &mut self,
        settings: &DevelopSettings,
        max_dimension: usize,
        quality: Quality,
    ) -> Result<(), Error> {
        let white_changed = self.ensure_head_white(settings);
        if !self.ensure_niho3(settings, max_dimension, quality, white_changed)? {
            self.release_master();
        }
        Ok(())
    }

    /// `R_k`: `local` rendered with the layer's caches in place of the
    /// Session's (module docs).
    fn render_layer(
        &mut self,
        layer: &mut MaskLayer,
        local: &DevelopSettings,
        max_dimension: usize,
        quality: Quality,
        base_image: Option<&str>,
    ) -> Result<Rendered, Error> {
        self.swap_settings_caches(&mut layer.caches);
        let result = self.render_layer_swapped(layer, local, max_dimension, quality, base_image);
        self.swap_settings_caches(&mut layer.caches);
        result
    }

    fn render_layer_swapped(
        &mut self,
        layer: &mut MaskLayer,
        local: &DevelopSettings,
        max_dimension: usize,
        quality: Quality,
        base_image: Option<&str>,
    ) -> Result<Rendered, Error> {
        let image = self.image_identity(local, max_dimension, quality)?;
        if layer.made_on.as_ref() != Some(&image) {
            // The local pass and the point plane were of another image.
            self.local = None;
            self.color_points = None;
        }
        layer.made_on = Some(image.clone());
        if image.as_deref() == base_image {
            layer.caches.drop_source();
            // R0's local pass (swapped out with its settings caches) serves
            // when it is the layer's: a delta outside the local pass.
            self.local_shared = layer.caches.local.take();
            let result = self.render_one(local, max_dimension, quality);
            layer.caches.local = self.local_shared.take();
            return result;
        }
        // R0's analysis (the same source's) for the layer's own master.
        let seed = self.niho3_analysis();
        self.swap_source_caches(&mut layer.caches);
        let saved_seed = std::mem::replace(&mut self.niho3_seed, seed);
        let result = self.render_one(local, max_dimension, quality);
        self.niho3_seed = saved_seed;
        // A released frame's full-source master of the layer's own is not
        // kept (with its reduction and window): the Session keeps one full
        // master, R0's, and the layers' released frames are kept instead.
        // The next released frame of this layer prepares it again (the same
        // pixels for the same key); drag frames prepare display-size ones.
        if quality == Quality::Final && self.niho3.as_ref().is_some_and(|p| p.full) {
            self.niho3 = None;
            self.parked_niho3 = None;
            self.sized = None;
            self.framed = None;
            self.stats.clear();
            self.local = None;
            self.color_points = None;
        }
        self.swap_source_caches(&mut layer.caches);
        result
    }

    fn swap_settings_caches(&mut self, caches: &mut LayerCaches) {
        std::mem::swap(&mut self.cubes, &mut caches.cubes);
        std::mem::swap(&mut self.local, &mut caches.local);
        std::mem::swap(&mut self.color_points, &mut caches.color_points);
        std::mem::swap(&mut self.niho6_last_used, &mut caches.niho6_last_used);
        std::mem::swap(&mut self.niho6_last_detail, &mut caches.niho6_last_detail);
    }

    fn swap_source_caches(&mut self, caches: &mut LayerCaches) {
        std::mem::swap(&mut self.niho3, &mut caches.niho3);
        std::mem::swap(&mut self.parked_niho3, &mut caches.parked_niho3);
        std::mem::swap(&mut self.sized, &mut caches.sized);
        std::mem::swap(&mut self.framed, &mut caches.framed);
        std::mem::swap(&mut self.stats, &mut caches.stats);
    }

    /// The image a frame of `settings` draws from: `None` the source, else
    /// the key of the master `ensure_niho3` / `ensure_niho6` would hold
    /// (the same keys, from the Session's current analysis state).
    fn image_identity(
        &self,
        settings: &DevelopSettings,
        max_dimension: usize,
        quality: Quality,
    ) -> Result<Option<String>, Error> {
        let Some(engine) = self.niho3_mode(settings)? else {
            return Ok(None);
        };
        let target = self.niho3_preparation_target(settings, max_dimension, quality);
        Ok(Some(match engine {
            RawEngine::Niho6 => {
                let detail_key = settings.detail.map_or_else(
                    || "none".to_string(),
                    |detail| {
                        format!(
                            "{}|{:?}",
                            detail.luminance_noise_reduction, detail.color_noise_reduction
                        )
                    },
                );
                let (analysis_white, exposure) = match (
                    quality,
                    self.niho6_reuse_while_dragging,
                    self.niho6_last_used.as_ref(),
                ) {
                    (Quality::Interactive, true, Some((white, analysis)))
                        if self.niho6_last_detail.as_ref() == Some(&detail_key) =>
                    {
                        (*white, analysis.exposure_ev)
                    }
                    _ => (self.source_white, niho6::analysis_exposure(settings)),
                };
                let (w, h) = target.map_or_else(|| self.source.size(), |t| (t.width, t.height));
                self.niho6_master_key(w, h, settings, analysis_white, exposure)
            }
            RawEngine::Niho3 | RawEngine::Niho4 => {
                let SessionSource::WorkingCopy { meta, .. } = self.source.as_ref() else {
                    unreachable!("a RAW master of a raster")
                };
                if engine == RawEngine::Niho3 {
                    pipeline::niho3_preparation_key(meta, settings, target.map(|t| t.niho3()))
                } else {
                    pipeline::niho4_preparation_key(meta, settings, target.map(|t| t.niho4()))
                        .map_err(|error| Error::Niho4Prepare(error.to_string()))?
                }
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{encode, Filter};
    use serde_json::{json, Value};

    fn photo(w: usize, h: usize) -> Vec<u8> {
        let rgba: Vec<u8> = (0..w * h)
            .flat_map(|i| {
                let (x, y) = (i % w, i / w);
                [
                    (x * 255 / w) as u8,
                    (y * 255 / h) as u8,
                    ((x + y) % 97) as u8 + 60,
                    255,
                ]
            })
            .collect();
        encode::encode_png(&rgba, w, h).unwrap()
    }

    fn settings(extra: Value) -> DevelopSettings {
        let mut v = json!({
            "v": 5, "engine": "niho-10", "look": "niho-standard-1", "base": null, "shadows": 30
        });
        for (k, value) in extra.as_object().unwrap() {
            v[k] = value.clone();
        }
        DevelopSettings::from_value(&v).unwrap()
    }

    fn radial(id: &str, adjust: Value) -> Value {
        json!({
            "id": id, "kind": "radial", "center": {"x": 0.4, "y": 0.5},
            "radius": {"x": 0.3, "y": 0.4}, "angle": 15, "feather": 60, "adjust": adjust
        })
    }

    fn layer<'a>(s: &'a Session, id: &str) -> &'a MaskLayer {
        let state = s.masks.as_ref().expect("mask layers");
        state.layers.iter().find(|l| l.id == id).expect("layer")
    }

    /// A kept frame: its key and its pixels' address (the same key and
    /// address: not rendered again).
    fn kept(slots: &FrameSlots, quality: Quality) -> (String, usize) {
        let (key, frame) = slots.slot_ref(quality).as_ref().expect("frame");
        (key.clone(), frame.rgba.as_ptr() as usize)
    }

    fn frame_of(s: &Session, id: &str, quality: Quality) -> (String, usize) {
        kept(&layer(s, id).frames, quality)
    }

    fn base_of(s: &Session, quality: Quality) -> (String, usize) {
        kept(&s.masks.as_ref().expect("mask layers").base, quality)
    }

    #[test]
    fn the_overlay_plane_is_the_blends_weights_quantised() {
        let png = photo(90, 60);
        let s = settings(json!({
            "masks": [radial("a", json!({"exposure": -1}))],
            "geometry": {"rotate": 270, "angle": -4, "crop": {"left": 0.05, "top": 0.1, "right": 0.9, "bottom": 0.95}}
        }));
        let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
        for (quality, size) in [(Quality::Interactive, 48usize), (Quality::Final, 0)] {
            let frame = session.render(&s, size, quality).unwrap();
            let weights = layer(&session, "a").plane.as_ref().unwrap().weights.clone();
            let before = frame_of(&session, "a", quality);
            let (w, h, plane) = session.mask_plane(&s, "a", size).unwrap();
            assert_eq!((w, h), (frame.width, frame.height));
            let expected: Vec<u8> = weights
                .iter()
                .map(|w| local_render::weight_to_u8(*w))
                .collect();
            assert_eq!(plane, expected, "{quality:?}");
            // The overlay leaves the layers as they were.
            assert_eq!(frame_of(&session, "a", quality), before);
            assert_eq!(session.render(&s, size, quality).unwrap().rgba, frame.rgba);
        }
    }

    #[test]
    fn a_drag_renders_the_layers_whose_settings_moved() {
        let png = photo(120, 80);
        let with = |a: Value, b: Value, extra: Value| {
            let mut v = extra;
            v["masks"] = json!([radial("a", a), {
                "id": "b", "kind": "linear", "zero": {"x": 0.2, "y": 0.2},
                "full": {"x": 0.8, "y": 0.9}, "adjust": b
            }]);
            settings(v)
        };
        let q = Quality::Interactive;
        let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
        let first = with(
            json!({"exposure": -0.5}),
            json!({"saturation": 20}),
            json!({}),
        );
        session.render(&first, 64, q).unwrap();
        let (r0, a, b) = (
            base_of(&session, q),
            frame_of(&session, "a", q),
            frame_of(&session, "b", q),
        );
        // A's slider: only A renders.
        let moved = with(
            json!({"exposure": -0.6}),
            json!({"saturation": 20}),
            json!({}),
        );
        session.render(&moved, 64, q).unwrap();
        assert_eq!(base_of(&session, q), r0);
        assert_ne!(frame_of(&session, "a", q).0, a.0);
        assert_eq!(frame_of(&session, "b", q), b);
        // A's shape: no layer renders, only its plane.
        let mut shaped = moved.clone();
        shaped.masks[0].invert = true;
        let a = frame_of(&session, "a", q);
        session.render(&shaped, 64, q).unwrap();
        assert_eq!(frame_of(&session, "a", q), a);
        assert_eq!(frame_of(&session, "b", q), b);
        // A global slider dragged from that frame: only R0 renders, the
        // layers' differences of that frame (the anchor) are reused.
        let mut global = shaped.clone();
        global.vibrance = 15.0;
        session.render(&global, 64, q).unwrap();
        assert_ne!(base_of(&session, q).0, r0.0);
        assert_eq!(frame_of(&session, "a", q), a);
        assert_eq!(frame_of(&session, "b", q), b);
        // Two global keys moved from the anchor: every layer renders.
        let global = with(
            json!({"exposure": -0.6}),
            json!({"saturation": 20}),
            json!({"vibrance": 15, "clarity": 5}),
        );
        session.render(&global, 64, q).unwrap();
        assert_ne!(frame_of(&session, "a", q).0, a.0);
        assert_ne!(frame_of(&session, "b", q).0, b.0);
        // A Final render can refresh the frozen niho-6 analysis used by
        // Interactive frames, so the next drag must render them again.
        session.render(&global, 64, Quality::Final).unwrap();
        let state = session.masks.as_ref().unwrap();
        assert!(state.base.interactive.is_none());
        assert!(state
            .layers
            .iter()
            .all(|layer| layer.frames.interactive.is_none()));
        let b_final = frame_of(&session, "b", Quality::Final);
        let released_a = with(
            json!({"exposure": -0.7}),
            json!({"saturation": 20}),
            json!({"vibrance": 15, "clarity": 5}),
        );
        session.render(&released_a, 64, Quality::Final).unwrap();
        assert_eq!(frame_of(&session, "b", Quality::Final), b_final);
        let state = session.masks.as_ref().unwrap();
        assert!(state.base.interactive.is_none());
        assert!(state
            .layers
            .iter()
            .all(|layer| layer.frames.interactive.is_none()));
        // A mask that goes away takes its layer; no mask takes them all.
        let mut one = released_a.clone();
        one.masks.remove(0);
        session.render(&one, 64, q).unwrap();
        assert_eq!(session.masks.as_ref().unwrap().layers.len(), 1);
        one.masks.clear();
        session.render(&one, 64, q).unwrap();
        assert!(session.masks.is_none());
    }

    #[test]
    fn a_surface_s_plane_is_kept_while_it_is_set_and_dropped_with_it() {
        let png = photo(60, 40);
        let data: Vec<u8> = (0..20 * 10).map(|i| (i % 20 * 12) as u8).collect();
        let surface = crate::mask_surface::MaskSurface::new(20, 10, data).unwrap();
        let bytes = crate::mask_surface::encode_surface_png(&surface).unwrap();
        let id = crate::mask_surface::surface_id(&bytes);
        let s = settings(json!({ "masks": [{
            "id": "paint", "kind": "brush",
            "surface": {"id": id, "width": 20, "height": 10},
            "adjust": {"exposure": -0.5}
        }] }));
        let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
        session.set_mask_surface(&id, &bytes).unwrap();
        let first = session.render(&s, 32, Quality::Interactive).unwrap();
        let plane = |s: &Session| {
            layer(s, "paint")
                .plane
                .as_ref()
                .map(|p| (p.surface.clone(), p.weights.as_ptr() as usize))
        };
        let kept = plane(&session).expect("plane");
        assert_eq!(kept.0.as_deref(), Some(id.as_str()));
        // Another frame of the same shape keeps the plane.
        let mut moved = s.clone();
        moved.masks[0].adjust.exposure = -0.6;
        session.render(&moved, 32, Quality::Interactive).unwrap();
        assert_eq!(plane(&session), Some(kept));
        // Dropping the surface drops the plane made from it.
        session.drop_mask_surface(&id);
        assert_eq!(plane(&session), None);
        assert!(matches!(
            session.render(&s, 32, Quality::Interactive),
            Err(Error::MaskSurfaceMissing(m)) if m == "paint"
        ));
        session.set_mask_surface(&id, &bytes).unwrap();
        assert_eq!(
            session.render(&s, 32, Quality::Interactive).unwrap().rgba,
            first.rgba
        );
    }

    #[test]
    fn a_release_after_a_drag_shares_r0s_master_with_the_layer() {
        let png = photo(120, 80);
        let with = |saturation: f64| {
            settings(json!({ "masks": [radial("color", json!({"saturation": saturation}))] }))
        };
        let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
        session.render(&with(-40.0), 64, Quality::Final).unwrap();
        session
            .render(&with(-41.0), 64, Quality::Interactive)
            .unwrap();
        // Released: R0's Final frame is kept, its master is made the Final
        // one again and the layer draws from it.
        session.render(&with(-42.0), 64, Quality::Final).unwrap();
        let base = session.niho3.as_ref().map(|p| (p.key.clone(), p.full));
        assert!(base.as_ref().is_some_and(|(_, full)| *full));
        let color = layer(&session, "color");
        assert_eq!(color.made_on.clone().unwrap(), base.map(|(key, _)| key));
        assert!(color.caches.niho3.is_none());
    }

    #[test]
    fn a_layer_keeps_its_own_master_only_when_its_inputs_differ() {
        let png = photo(120, 80);
        // Shadows +30: R0 draws from a niho-6 master. Saturation leaves the
        // master's inputs; exposure and Highlights change them.
        let s = settings(json!({ "masks": [
            radial("color", json!({"saturation": -40})),
            radial("light", json!({"exposure": -0.7})),
            radial("tone", json!({"highlights": -50}))
        ] }));
        for (quality, size) in [(Quality::Interactive, 64usize), (Quality::Final, 0)] {
            let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
            session.render(&s, size, quality).unwrap();
            let base = session.niho3.as_ref().map(|p| p.key.clone());
            assert!(base.is_some(), "R0's master");
            let made_on = |id: &str| layer(&session, id).made_on.clone().unwrap();
            // Saturation draws from R0's master and reads R0's local pass.
            let color = &layer(&session, "color").caches;
            assert_eq!(made_on("color"), base, "{quality:?}");
            assert!(
                color.niho3.is_none() && color.local.is_none(),
                "{quality:?}"
            );
            for id in ["light", "tone"] {
                assert_ne!(made_on(id), base, "{id} {quality:?}");
                let own = &layer(&session, id).caches;
                // Its own master while dragging; a released frame's full
                // master is not kept (R0 keeps the one full master).
                assert_eq!(
                    own.niho3.is_some(),
                    quality == Quality::Interactive,
                    "{id} {quality:?}"
                );
            }
            if quality == Quality::Interactive {
                assert!(layer(&session, "tone").caches.local.is_some());
            }
            // Without a master on either side the layers share R0's reduction.
            let plain = settings(json!({ "shadows": 0, "masks": [
                radial("light", json!({"exposure": -0.7}))
            ] }));
            session.render(&plain, size, quality).unwrap();
            assert!(session.niho3.is_none());
            let light = &layer(&session, "light").caches;
            assert!(light.niho3.is_none() && light.sized.is_none() && light.stats.is_empty());
        }
    }

    #[test]
    fn one_global_slider_moved_is_a_drag_and_anything_else_is_not() {
        let value = |extra: Value| settings(extra).to_value();
        let anchor = value(json!({"contrast": 10}));
        let close = |m: Option<f64>, expected: f64| {
            assert!(m.is_some_and(|m| (m - expected).abs() < 1e-12), "{m:?}");
        };
        // In the slider's bound: Contrast 25, Exposure 0.5 EV.
        close(slider_move(&anchor, &value(json!({"contrast": 30}))), 0.8);
        close(
            slider_move(&anchor, &value(json!({"contrast": 10, "exposure": -1.25}))),
            2.5,
        );
        // Nothing moved, two keys, a key that is not a slider, a nested edit.
        for other in [
            json!({"contrast": 10}),
            json!({"contrast": 12, "vibrance": 1}),
            json!({"contrast": 10, "curveRefineSaturation": 90}),
            json!({"contrast": 10, "engine": "niho-8"}),
            json!({"contrast": 10, "hsl": ["red", {"hue": 5}]}),
            json!({"contrast": 10, "whiteBalance": {"mode": "relative"}, "relativeTemperature": 5}),
            json!({"contrast": 10, "geometry": {"rotate": 90}}),
            json!({"contrast": 10, "vignette": {"amount": -20, "midpoint": 50, "roundness": 0, "feather": 50, "highlights": 0, "style": "highlightPriority"}}),
        ] {
            assert_eq!(slider_move(&anchor, &value(other.clone())), None, "{other}");
        }
        // An absolute white balance: its temperature in mired (40), its
        // tint (25).
        let wb = |temperature: f64, tint: f64| {
            value(
                json!({"whiteBalance": {"mode": "absolute", "temperature": temperature, "tint": tint}}),
            )
        };
        close(
            slider_move(&wb(5000.0, 0.0), &wb(4000.0, 0.0)),
            (250.0 - 200.0) / 40.0,
        );
        close(slider_move(&wb(5000.0, 0.0), &wb(5000.0, 30.0)), 1.2);
        assert_eq!(slider_move(&wb(5000.0, 0.0), &wb(4000.0, 30.0)), None);
        assert_eq!(slider_move(&value(json!({})), &wb(5000.0, 0.0)), None);
    }

    /// A sky over a dark field with a saturated object and a little noise
    /// (`examples/mask_timing.rs`'s scene, scaled).
    fn scene(w: usize, h: usize) -> Vec<u8> {
        let mut rgba = Vec::with_capacity(w * h * 4);
        let mut state = 0x2f6b_4e1du32;
        for y in 0..h {
            for x in 0..w {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                let noise = (state % 9) as i32 - 4;
                let (fx, fy) = (x * 2048 / w, y * 1365 / h);
                let sky = fy < 1365 * 2 / 5;
                let object = (fx as i32 - 1300).pow(2) + (fy as i32 - 900).pow(2) < 200 * 200;
                let (r, g, b) = if sky {
                    (140 + (fx / 32) as i32, 180 + (fy / 16) as i32, 245)
                } else if object {
                    (190, 60 + (fx / 64) as i32, 40)
                } else {
                    (
                        30 + (fx / 24) as i32,
                        40 + (fy / 20) as i32,
                        25 + ((fx + fy) / 64) as i32,
                    )
                };
                let c = |v: i32| (v + noise).clamp(0, 255) as u8;
                rgba.extend_from_slice(&[c(r), c(g), c(b), 255]);
            }
        }
        encode::encode_png(&rgba, w, h).unwrap()
    }

    /// `examples/mask_timing.rs`'s three masks, one of each kind of delta
    /// (cube stages only, the master's input, the local pass), on a typical
    /// global edit plus `global`.
    fn three_masks(global: Value) -> DevelopSettings {
        let mut v = json!({
            "v": 5, "engine": "niho-10", "look": "niho-standard-1", "base": null,
            "highlights": -30, "shadows": 20, "contrast": 10, "vibrance": 10,
            "masks": [
                {"id": "sky", "kind": "linear", "zero": {"x": 0.5, "y": 0.55}, "full": {"x": 0.5, "y": 0.2},
                 "adjust": {"saturation": 20, "contrast": 15}},
                {"id": "object", "kind": "radial", "center": {"x": 0.63, "y": 0.66}, "radius": {"x": 0.15, "y": 0.22},
                 "angle": 10, "feather": 50, "adjust": {"exposure": -0.7}},
                {"id": "edge", "kind": "radial", "invert": true, "center": {"x": 0.5, "y": 0.5}, "radius": {"x": 0.45, "y": 0.5},
                 "angle": 0, "feather": 80, "adjust": {"clarity": 25, "texture": 20, "shadows": 25, "highlights": -30}}
            ]
        });
        for (k, value) in global.as_object().unwrap() {
            v[k] = value.clone();
        }
        DevelopSettings::from_value(&v).unwrap()
    }

    fn anchor_of(s: &Session) -> &DragAnchor {
        s.masks.as_ref().unwrap().anchor.as_ref().expect("anchor")
    }

    /// A layer's frame (RGBA) and plane.
    type LayerPixels = (Vec<u8>, Vec<u32>);

    /// `R0`'s kept frame of `q` and each layer's with its plane.
    fn kept_layers(s: &Session, q: Quality) -> (Vec<u8>, Vec<LayerPixels>) {
        let state = s.masks.as_ref().unwrap();
        let base = state.base.slot_ref(q).as_ref().unwrap().1.rgba.clone();
        let layers = state
            .layers
            .iter()
            .map(|l| {
                let frame = l.frames.slot_ref(q).as_ref().unwrap().1.rgba.clone();
                (frame, l.plane.as_ref().unwrap().weights.clone())
            })
            .collect();
        (base, layers)
    }

    /// `clamp(R0 + sum_k ((R_k^a - R0^a) * w_k + 32768) >> 16)`, written out.
    fn reference(r0: &[u8], anchor: &[u8], layers: &[LayerPixels]) -> Vec<u8> {
        let mut out = r0.to_vec();
        for p in 0..r0.len() / 4 {
            for c in 0..3 {
                let mut acc = i32::from(r0[p * 4 + c]);
                for (rgba, weights) in layers {
                    let diff = i32::from(rgba[p * 4 + c]) - i32::from(anchor[p * 4 + c]);
                    acc += (diff * weights[p] as i32 + 32768) >> 16;
                }
                out[p * 4 + c] = acc.clamp(0, 255) as u8;
            }
        }
        out
    }

    #[test]
    fn a_global_drag_adds_the_anchor_s_differences_to_a_new_r0() {
        let png = scene(160, 107);
        let q = Quality::Interactive;
        let at = |contrast: f64| three_masks(json!({ "contrast": contrast }));
        let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
        // The anchor: the exact frame (a new Session's), its sum kept.
        let first = session.render(&at(10.0), 96, q).unwrap();
        let mut fresh = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
        assert_eq!(first.rgba, fresh.render(&at(10.0), 96, q).unwrap().rgba);
        let (r0_anchor, layers) = kept_layers(&session, q);
        assert_eq!(layers.len(), 3);
        let terms: Vec<(&[u8], &[u32])> = layers
            .iter()
            .map(|(rgba, weights)| (rgba.as_slice(), weights.as_slice()))
            .collect();
        let (blended, sum) = local_render::blend_keeping_sum(&r0_anchor, &terms);
        assert_eq!(blended, first.rgba);
        assert_eq!(anchor_of(&session).sum, sum);
        assert_eq!(anchor_of(&session).reused, 0);
        let kept: Vec<_> = ["sky", "object", "edge"]
            .iter()
            .map(|id| frame_of(&session, id, q))
            .collect();
        // R0 as the global path draws it in the same drag.
        let mut global = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
        global
            .render(&local_render::without_masks(&at(10.0)), 96, q)
            .unwrap();
        for (i, contrast) in [14.0, 22.0, 30.0, 22.0].into_iter().enumerate() {
            let frame = session.render(&at(contrast), 96, q).unwrap();
            let r0 = global
                .render(&local_render::without_masks(&at(contrast)), 96, q)
                .unwrap();
            assert_eq!(kept_layers(&session, q).0, r0.rgba, "{contrast}: R0");
            assert_eq!(
                frame.rgba,
                local_render::add_sum(&r0.rgba, &sum),
                "{contrast}"
            );
            assert_eq!(frame.rgba, reference(&r0.rgba, &r0_anchor, &layers));
            assert_eq!(frame.approximations, first.approximations);
            assert_eq!(anchor_of(&session).reused, i + 1);
            // The layers were not drawn.
            for (id, before) in ["sky", "object", "edge"].iter().zip(&kept) {
                assert_eq!(&frame_of(&session, id, q), before, "{id}");
            }
        }
        // Back at the anchor's value: nothing moved, an exact frame.
        let back = session.render(&at(10.0), 96, q).unwrap();
        assert_eq!(back.rgba, first.rgba);
    }

    #[test]
    fn a_drag_draws_the_layers_again_past_its_bounds() {
        let png = scene(96, 64);
        let q = Quality::Interactive;
        let at = |contrast: f64| three_masks(json!({ "contrast": contrast }));
        let exact = |s: &DevelopSettings| {
            Session::open_raster(&png, 0, Filter::Lanczos3)
                .unwrap()
                .render(s, 48, q)
                .unwrap()
                .rgba
        };
        let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
        session.render(&at(-20.0), 48, q).unwrap();
        let anchor = frame_of(&session, "sky", q);
        // Contrast's bound (25) from the anchor's value is reused...
        session.render(&at(5.0), 48, q).unwrap();
        assert_eq!(frame_of(&session, "sky", q), anchor);
        assert_eq!(anchor_of(&session).reused, 1);
        // ...further is drawn: a new anchor, the exact frame.
        let far = session.render(&at(5.5), 48, q).unwrap();
        assert_ne!(frame_of(&session, "sky", q).0, anchor.0);
        assert_eq!(anchor_of(&session).reused, 0);
        assert_eq!(far.rgba, exact(&at(5.5)));
        // At most DRAG_REUSE_MAX_FRAMES frames from one anchor.
        let anchor = frame_of(&session, "sky", q);
        for i in 0..DRAG_REUSE_MAX_FRAMES {
            session
                .render(&at(if i % 2 == 0 { 6.0 } else { 7.0 }), 48, q)
                .unwrap();
            assert_eq!(frame_of(&session, "sky", q), anchor, "{i}");
        }
        assert_eq!(anchor_of(&session).reused, DRAG_REUSE_MAX_FRAMES);
        let next = session.render(&at(8.0), 48, q).unwrap();
        assert_ne!(frame_of(&session, "sky", q).0, anchor.0);
        assert_eq!(anchor_of(&session).reused, 0);
        assert_eq!(next.rgba, exact(&at(8.0)));
    }

    #[test]
    fn a_mask_slider_drag_draws_only_its_layer_exactly_and_anchors_the_next_drag() {
        let png = scene(96, 64);
        let q = Quality::Interactive;
        let with = |contrast: f64, exposure: f64| {
            let mut s = three_masks(json!({ "contrast": contrast }));
            s.masks[1].adjust.exposure = exposure;
            s
        };
        let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
        session.render(&with(10.0, -0.7), 48, q).unwrap();
        // A global frame reused from it, then the object's slider.
        session.render(&with(16.0, -0.7), 48, q).unwrap();
        let (r0, sky) = (base_of(&session, q), frame_of(&session, "sky", q));
        // Another global value than the anchor's: every layer is drawn again.
        let frame = session.render(&with(16.0, -0.8), 48, q).unwrap();
        assert_eq!(base_of(&session, q), r0);
        assert_ne!(frame_of(&session, "sky", q).0, sky.0);
        let mut fresh = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
        fresh.render(&with(10.0, -0.7), 48, q).unwrap();
        assert_eq!(
            frame.rgba,
            fresh.render(&with(16.0, -0.8), 48, q).unwrap().rgba
        );
        // Then only the object's layer is drawn, and stays exact.
        let (sky, edge) = (frame_of(&session, "sky", q), frame_of(&session, "edge", q));
        let object = frame_of(&session, "object", q);
        let frame = session.render(&with(16.0, -0.9), 48, q).unwrap();
        assert_eq!(base_of(&session, q), r0);
        assert_eq!(frame_of(&session, "sky", q), sky);
        assert_eq!(frame_of(&session, "edge", q), edge);
        assert_ne!(frame_of(&session, "object", q).0, object.0);
        assert_eq!(
            frame.rgba,
            fresh.render(&with(16.0, -0.9), 48, q).unwrap().rgba
        );
        assert_eq!(anchor_of(&session).masks, {
            local_mask::masks_value(&with(16.0, -0.9).masks).to_string()
        });
        // A global drag next reuses that frame's differences.
        let object = frame_of(&session, "object", q);
        session.render(&with(20.0, -0.9), 48, q).unwrap();
        assert_eq!(frame_of(&session, "object", q), object);
        assert_eq!(frame_of(&session, "sky", q), sky);
        assert_eq!(anchor_of(&session).reused, 1);
    }

    /// The mean and largest absolute difference per channel, and the share
    /// of channel values off by more than 3 levels.
    fn difference(a: &[u8], b: &[u8]) -> (f64, u8, f64) {
        let (mut total, mut largest, mut over) = (0u64, 0u8, 0usize);
        let mut n = 0usize;
        for (x, y) in a.chunks_exact(4).zip(b.chunks_exact(4)) {
            for c in 0..3 {
                let d = x[c].abs_diff(y[c]);
                total += u64::from(d);
                largest = largest.max(d);
                over += usize::from(d > 3);
                n += 1;
            }
        }
        (total as f64 / n as f64, largest, over as f64 / n as f64)
    }

    #[test]
    fn a_reused_drag_frame_stays_close_to_the_exact_one() {
        // The approximation (docs/local-adjustments.md "層の持ち方"): the
        // differences of the drag's start on the moved global frame. Against
        // the exact frame of the same Session and history (the anchor
        // dropped), and, for scale, against R0 alone (the masks left out).
        let png = scene(320, 213);
        let q = Quality::Interactive;
        // Typical steps of a drag, then each slider at its bound.
        let cases: [(&str, Value, Value, f64); 9] = [
            ("exposure +0.25", json!({}), json!({"exposure": 0.25}), 1.0),
            ("contrast +10", json!({}), json!({"contrast": 20}), 1.0),
            ("exposure +0.5", json!({}), json!({"exposure": 0.5}), 2.5),
            ("exposure -0.5", json!({}), json!({"exposure": -0.5}), 2.5),
            ("contrast +25", json!({}), json!({"contrast": 35}), 2.5),
            ("highlights -25", json!({}), json!({"highlights": -55}), 2.5),
            ("whites +25", json!({}), json!({"whites": 25}), 2.5),
            ("saturation +25", json!({}), json!({"saturation": 25}), 2.5),
            ("vibrance +25", json!({}), json!({"vibrance": 35}), 2.5),
        ];
        for (name, from, to, bound) in cases {
            let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
            session.render(&three_masks(from), 320, q).unwrap();
            let moved = three_masks(to);
            let reused = session.render(&moved, 320, q).unwrap();
            assert_eq!(anchor_of(&session).reused, 1, "{name}");
            session.masks.as_mut().unwrap().anchor = None;
            let exact = session.render(&moved, 320, q).unwrap();
            let r0 = kept_layers(&session, q).0;
            let (mean, largest, over) = difference(&reused.rgba, &exact.rgba);
            let (unmasked, _, _) = difference(&r0, &exact.rgba);
            eprintln!(
                "{name}: reused vs exact mean {mean:.3} max {largest} >3: {:.2}% (R0 alone {unmasked:.3})",
                over * 100.0
            );
            assert!(mean <= bound, "{name}: {mean}");
            assert!(mean <= unmasked * 0.6, "{name}: {mean} vs {unmasked}");
        }
    }

    #[test]
    fn a_release_is_exact_and_the_next_drag_starts_from_drawn_layers() {
        let png = scene(160, 107);
        let q = Quality::Interactive;
        let at = |contrast: f64| three_masks(json!({ "contrast": contrast }));
        let mut session = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
        session.render(&at(10.0), 80, q).unwrap();
        session.render(&at(16.0), 80, q).unwrap();
        assert_eq!(anchor_of(&session).reused, 1);
        // Released: a new Session's Final frame, and no anchor is left.
        let released = session.render(&at(16.0), 0, Quality::Final).unwrap();
        let mut fresh = Session::open_raster(&png, 0, Filter::Lanczos3).unwrap();
        assert_eq!(
            released.rgba,
            fresh.render(&at(16.0), 0, Quality::Final).unwrap().rgba
        );
        assert!(session.masks.as_ref().unwrap().anchor.is_none());
        // The next drag's first frame draws the layers and anchors the drag.
        let first = session.render(&at(20.0), 80, q).unwrap();
        let state = session.masks.as_ref().unwrap();
        assert!(state.layers.iter().all(|l| l.frames.interactive.is_some()));
        assert_eq!(anchor_of(&session).reused, 0);
        assert_eq!(first.rgba, fresh.render(&at(20.0), 80, q).unwrap().rgba);
    }
}
