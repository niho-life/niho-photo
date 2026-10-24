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
//!   only, dragging a global slider renders them all, and releasing a mask's
//!   slider (Final) renders only that layer when the other layers' Final
//!   frames are still those settings'. A Final render invalidates all
//!   Interactive frames because it can refresh the frozen `niho-6` analysis
//!   used by drag renders. A plane is kept per layer while the mask's shape
//!   (a surface mask's: its surface's id, which names the surface's bytes,
//!   and size), the geometry and the size stay; dropping a surface drops the
//!   planes made from it.
//!
//! `brush` / `subject` / `sky` masks sample the Session's surface of their
//! `surface.id` ([`Session::set_mask_surface`]): a frame with an active one
//! whose surface is not set is [`Error::MaskSurfaceMissing`], of another
//! size than `surface.width` / `surface.height` [`Error::MaskSurfaceMismatch`],
//! before anything is drawn.
//!
//! The layers of masks that are gone or no longer active are dropped at the
//! next frame; a frame without an active mask drops them all.

use crate::local_mask::{LocalMask, MaskShape};
use crate::local_render::{self, PlaneError, SourceMap};
use crate::mask_surface::MaskSurface;
use crate::pipeline::{self, Rendered};
use crate::settings::DevelopSettings;
use crate::spatial::{self, Quality};
use crate::{
    frame, niho6, rendered_geometry, Error, Framed, HeadWhiteBalance, ParkedNiho3, PreparedNiho3,
    RawEngine, Session, SessionSource, SettingsError,
};
use std::sync::Arc;

/// The layers of one Session's masked frames.
#[derive(Default)]
pub(crate) struct MaskLayers {
    /// `R0`'s last frame at each quality.
    base: FrameSlots,
    layers: Vec<MaskLayer>,
}

impl MaskLayers {
    fn invalidate_interactive(&mut self) {
        self.base.interactive = None;
        for layer in &mut self.layers {
            layer.frames.interactive = None;
        }
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

    fn get(&self, quality: Quality, key: &str) -> Option<&Rendered> {
        let slot = match quality {
            Quality::Interactive => &self.interactive,
            Quality::Final => &self.released,
        };
        slot.as_ref()
            .filter(|(k, _)| k == key)
            .map(|(_, frame)| frame)
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
        let mut approximations = base.approximations.clone();
        let mut terms: Vec<(&[u8], &[u32])> = Vec::with_capacity(drawn.len());
        for (index, key) in &drawn {
            let layer = &state.layers[*index];
            let frame = layer.frames.get(quality, key).expect("R_k");
            for a in &frame.approximations {
                if !approximations.contains(a) {
                    approximations.push(a);
                }
            }
            let plane = layer.plane.as_ref().expect("plane");
            terms.push((&frame.rgba, &plane.weights));
        }
        let rgba = if terms.is_empty() {
            base.rgba.clone()
        } else {
            local_render::blend(&base.rgba, &terms)
        };
        Ok(Rendered {
            width,
            height,
            rgba,
            approximations,
        })
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
                        if self.niho6_last_detail.as_ref() == Some(&detail_key)
                            && analysis.kind == niho6::analysis_kind(settings) =>
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
        let slot = match quality {
            Quality::Interactive => &slots.interactive,
            Quality::Final => &slots.released,
        };
        let (key, frame) = slot.as_ref().expect("frame");
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
        // A global slider: every layer renders.
        let global = with(
            json!({"exposure": -0.6}),
            json!({"saturation": 20}),
            json!({"vibrance": 15}),
        );
        session.render(&global, 64, q).unwrap();
        assert_ne!(base_of(&session, q).0, r0.0);
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
            json!({"vibrance": 15}),
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
}
