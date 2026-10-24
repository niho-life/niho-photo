//! `niho-6` JPEG / PNG highlight and shadow response (#18397, `NIHO6.md`).
//!
//! The input is the 750px analysis image of the whole photo in linear
//! ProPhoto ([`crate::niho6`]). The 26 source-only features are the frozen
//! RAW ones ([`raw_response::feature_vectors`], `round100_features.py`); each
//! response reads its own subset of them through a tanh / tanh / softplus
//! network whose two non-negative outputs `a`, `b` give the gain in EV:
//! Highlights `-(h·a + h²·b)` with `h = -H/100`, Shadows `s·a + s²·b` with
//! `s = S/100` (the RAW responses' form). The coefficients were fitted on
//! Lightroom's JPEG exports outside this crate (`tools/calibrate`); the
//! embedded asset is their representation only. No fitting happens here.

use crate::raw_response::{self, FEATURE_COUNT};
use serde_json::Value;
use std::fmt;
use std::sync::OnceLock;

const MODEL_JSON: &str = include_str!("../niho6/response-jpeg.json");
const MODEL_SCHEMA: &str = "niho.jpeg-response-models.v1";
/// Upper bounds of the gain magnitude (EV), as the RAW responses.
const HIGHLIGHT_MAX_EV: f64 = 8.0;
const SHADOW_MAX_EV: f64 = 4.0;
const MAX_HIDDEN: usize = 64;

/// SHA-256 of the fitted highlight response the asset represents.
pub const HIGHLIGHT_MODEL_SHA256: &str =
    "b9adfcfacf0df7ec0ca8296165d464ec8931968bee252aca80c8f5be85b16fbf";
/// SHA-256 of the fitted shadow response the asset represents.
pub const SHADOW_MODEL_SHA256: &str =
    "c0e715ec0fb11452ead0cc961014ca8b05c28df87be9b152fa9dff08415b8e6e";

#[derive(Clone, Debug, PartialEq)]
pub enum ResponseError {
    Features(raw_response::RawResponseError),
    InvalidHighlights(f64),
    InvalidShadows(f64),
    EmbeddedModel(String),
    /// [`CoefficientMaps`] that do not fit their size (a zero or overflowing
    /// size, a map of another length, a non-finite or negative coefficient).
    InvalidMaps(String),
}

impl fmt::Display for ResponseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Features(e) => write!(f, "features: {e}"),
            Self::InvalidHighlights(v) => write!(f, "highlights must be in [-100, 0], got {v}"),
            Self::InvalidShadows(v) => write!(f, "shadows must be in [0, 100], got {v}"),
            Self::EmbeddedModel(m) => write!(f, "invalid embedded niho-6 response model: {m}"),
            Self::InvalidMaps(m) => write!(f, "invalid niho-6 coefficient maps: {m}"),
        }
    }
}

impl std::error::Error for ResponseError {}

/// Non-negative coefficient maps of the analysis image, independent of the
/// amounts (made once per photo and exposure).
#[derive(Clone, Debug)]
pub struct CoefficientMaps {
    pub width: usize,
    pub height: usize,
    pub highlight_a: Vec<f32>,
    pub highlight_b: Vec<f32>,
    pub shadow_a: Vec<f32>,
    pub shadow_b: Vec<f32>,
}

/// One response: its feature subset, normalization and network.
pub(crate) struct Model {
    pub(crate) features: Vec<usize>,
    pub(crate) hidden1: usize,
    pub(crate) hidden2: usize,
    /// `W1` (input-major), `b1`, `W2`, `b2`, `W3`, `b3`.
    pub(crate) weights: Vec<f64>,
    pub(crate) mean: Vec<f64>,
    pub(crate) scale: Vec<f64>,
}

impl Model {
    fn weight_count(inputs: usize, hidden1: usize, hidden2: usize) -> usize {
        inputs * hidden1 + hidden1 + hidden1 * hidden2 + hidden2 + hidden2 * 2 + 2
    }

    /// `(a, b)`. Every output adds its bias, then its inputs in order (no
    /// FMA, `libm`): native and wasm give the same bits.
    fn infer(&self, feature: &[f32; FEATURE_COUNT]) -> [f64; 2] {
        match (self.features.len(), self.hidden1, self.hidden2) {
            (FEATURE_COUNT, 8, 4) => self.infer_fixed::<FEATURE_COUNT, 8, 4>(feature),
            _ => self.infer_reference(feature),
        }
    }

    /// [`Self::infer`] for the embedded shape: the same additions in the
    /// same order per output, with the outputs of a layer side by side (each
    /// input adds to every output before the next input), so the compiler
    /// keeps independent outputs in SIMD lanes. Bit for bit the reference.
    #[inline]
    fn infer_fixed<const N: usize, const H1: usize, const H2: usize>(
        &self,
        feature: &[f32; FEATURE_COUNT],
    ) -> [f64; 2] {
        let w1 = &self.weights[..N * H1];
        let b1 = &self.weights[N * H1..N * H1 + H1];
        let w2 = &self.weights[N * H1 + H1..N * H1 + H1 + H1 * H2];
        let b2 = &self.weights[N * H1 + H1 + H1 * H2..N * H1 + H1 + H1 * H2 + H2];
        let w3 = &self.weights[N * H1 + H1 + H1 * H2 + H2..N * H1 + H1 + H1 * H2 + H2 + H2 * 2];
        let b3 = &self.weights[N * H1 + H1 + H1 * H2 + H2 + H2 * 2..];
        let mut x = [0.0_f64; N];
        for (slot, ((&index, mean), scale)) in x
            .iter_mut()
            .zip(self.features.iter().zip(&self.mean).zip(&self.scale))
        {
            *slot = ((f64::from(feature[index]) - mean) / scale).clamp(-6.0, 6.0);
        }
        let mut first = [0.0_f64; H1];
        first.copy_from_slice(b1);
        for (x, weights) in x.iter().zip(w1.chunks_exact(H1)) {
            for (value, weight) in first.iter_mut().zip(weights) {
                *value += x * weight;
            }
        }
        for value in &mut first {
            *value = libm::tanh(*value);
        }
        let mut second = [0.0_f64; H2];
        second.copy_from_slice(b2);
        for (x, weights) in first.iter().zip(w2.chunks_exact(H2)) {
            for (value, weight) in second.iter_mut().zip(weights) {
                *value += x * weight;
            }
        }
        for value in &mut second {
            *value = libm::tanh(*value);
        }
        let mut result = [b3[0], b3[1]];
        for (x, weights) in second.iter().zip(w3.chunks_exact(2)) {
            result[0] += x * weights[0];
            result[1] += x * weights[1];
        }
        result.map(softplus)
    }

    /// The frozen definition: each output adds its bias, then its inputs in
    /// order (no FMA, `libm`).
    fn infer_reference(&self, feature: &[f32; FEATURE_COUNT]) -> [f64; 2] {
        let n = self.features.len();
        let (h1, h2) = (self.hidden1, self.hidden2);
        let w1 = 0;
        let b1 = w1 + n * h1;
        let w2 = b1 + h1;
        let b2 = w2 + h1 * h2;
        let w3 = b2 + h2;
        let b3 = w3 + h2 * 2;
        let mut x = [0.0_f64; FEATURE_COUNT];
        for (slot, (&index, (mean, scale))) in x
            .iter_mut()
            .zip(self.features.iter().zip(self.mean.iter().zip(&self.scale)))
        {
            *slot = ((f64::from(feature[index]) - mean) / scale).clamp(-6.0, 6.0);
        }
        let mut first = [0.0_f64; MAX_HIDDEN];
        for (output, activation) in first[..h1].iter_mut().enumerate() {
            let mut value = self.weights[b1 + output];
            for (input, x) in x[..n].iter().enumerate() {
                value += x * self.weights[w1 + input * h1 + output];
            }
            *activation = libm::tanh(value);
        }
        let mut second = [0.0_f64; MAX_HIDDEN];
        for (output, activation) in second[..h2].iter_mut().enumerate() {
            let mut value = self.weights[b2 + output];
            for (input, x) in first[..h1].iter().enumerate() {
                value += x * self.weights[w2 + input * h2 + output];
            }
            *activation = libm::tanh(value);
        }
        let mut result = [0.0_f64; 2];
        for (output, activation) in result.iter_mut().enumerate() {
            let mut value = self.weights[b3 + output];
            for (input, x) in second[..h2].iter().enumerate() {
                value += x * self.weights[w3 + input * 2 + output];
            }
            *activation = softplus(value);
        }
        result
    }
}

fn softplus(value: f64) -> f64 {
    value.max(0.0) + libm::log1p(libm::exp(-value.abs()))
}

/// The embedded responses and the chroma exponents of the `niho-6` gain:
/// `out = rgb·G + (rgb − Y)·(C − G)`, `G = 2^(gH + gS)`,
/// `C = 2^(αH·gH + αS·gS)` ([`crate::niho6`]).
pub(crate) struct Models {
    pub(crate) highlight: Model,
    pub(crate) shadow: Model,
    pub(crate) highlight_chroma_alpha: f32,
    pub(crate) shadow_chroma_alpha: f32,
}

static MODELS: OnceLock<Result<Models, String>> = OnceLock::new();

pub(crate) fn models() -> Result<&'static Models, ResponseError> {
    MODELS
        .get_or_init(|| parse_models(MODEL_JSON))
        .as_ref()
        .map_err(|m| ResponseError::EmbeddedModel(m.clone()))
}

fn parse_models(text: &str) -> Result<Models, String> {
    let root: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    expect_string(&root, "schema", MODEL_SCHEMA)?;
    expect_string(
        &root,
        "featureSourceSha256",
        raw_response::FEATURE_SOURCE_SHA256,
    )?;
    let highlight = parse_model(
        root.get("highlight").ok_or("missing highlight")?,
        HIGHLIGHT_MODEL_SHA256,
    )?;
    let shadow = parse_model(
        root.get("shadow").ok_or("missing shadow")?,
        SHADOW_MODEL_SHA256,
    )?;
    let alpha = |key: &str| -> Result<f32, String> {
        let value = root
            .get("chroma")
            .and_then(|c| c.get(key))
            .and_then(Value::as_f64)
            .ok_or_else(|| format!("missing chroma.{key}"))?;
        if !value.is_finite() || !(-2.0..=3.0).contains(&value) {
            return Err(format!("chroma.{key} out of range"));
        }
        Ok(value as f32)
    };
    Ok(Models {
        highlight,
        shadow,
        highlight_chroma_alpha: alpha("highlightAlpha")?,
        shadow_chroma_alpha: alpha("shadowAlpha")?,
    })
}

fn expect_string(root: &Value, key: &str, expected: &str) -> Result<(), String> {
    match root.get(key).and_then(Value::as_str) {
        Some(actual) if actual == expected => Ok(()),
        Some(_) => Err(format!("{key} mismatch")),
        None => Err(format!("missing or invalid {key}")),
    }
}

fn finite_array(root: &Value, key: &str, expected: usize) -> Result<Vec<f64>, String> {
    let values = root
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("missing or invalid {key}"))?;
    if values.len() != expected {
        return Err(format!("{key} length mismatch"));
    }
    values
        .iter()
        .map(|v| {
            v.as_f64()
                .filter(|x| x.is_finite())
                .ok_or_else(|| format!("{key} has a non-finite value"))
        })
        .collect()
}

fn parse_model(value: &Value, expected_sha: &str) -> Result<Model, String> {
    expect_string(value, "sourceSha256", expected_sha)?;
    let features: Vec<usize> = value
        .get("features")
        .and_then(Value::as_array)
        .ok_or("missing features")?
        .iter()
        .map(|v| {
            v.as_u64()
                .map(|i| i as usize)
                .filter(|i| *i < FEATURE_COUNT)
                .ok_or_else(|| "feature index out of range".to_string())
        })
        .collect::<Result<_, _>>()?;
    if features.is_empty() {
        return Err("no features".into());
    }
    let hidden = value
        .get("hidden")
        .and_then(Value::as_array)
        .ok_or("missing hidden")?;
    let size = |i: usize| -> Result<usize, String> {
        hidden
            .get(i)
            .and_then(Value::as_u64)
            .map(|v| v as usize)
            .filter(|v| (1..=MAX_HIDDEN).contains(v))
            .ok_or_else(|| "invalid hidden size".to_string())
    };
    if hidden.len() != 2 {
        return Err("hidden must have two layers".into());
    }
    let (hidden1, hidden2) = (size(0)?, size(1)?);
    let n = features.len();
    let weights = finite_array(value, "weights", Model::weight_count(n, hidden1, hidden2))?;
    let mean = finite_array(value, "mean", n)?;
    let scale = finite_array(value, "scale", n)?;
    if scale.iter().any(|s| *s <= 0.0) {
        return Err("scale must be positive".into());
    }
    Ok(Model {
        features,
        hidden1,
        hidden2,
        weights,
        mean,
        scale,
    })
}

/// The 26 features of a linear ProPhoto analysis image (the expensive part,
/// made once per photo).
#[derive(Debug)]
pub struct Features {
    pub width: usize,
    pub height: usize,
    pub(crate) vectors: Vec<[f32; FEATURE_COUNT]>,
}

/// Feature indices that move with the exposure: `logY` and `meanLogY`. The
/// others are differences or ratios of log luminances (local and global),
/// so scaling the analysis image by `2^ev` leaves them as they are.
pub(crate) const EXPOSURE_FEATURES: [usize; 2] = [0, 1];

pub fn features(
    linear_prophoto_rgb: &[f32],
    width: usize,
    height: usize,
) -> Result<Features, ResponseError> {
    let vectors = raw_response::feature_vectors(linear_prophoto_rgb, width, height)
        .map_err(ResponseError::Features)?;
    Ok(Features {
        width,
        height,
        vectors,
    })
}

/// The coefficient maps of `features` seen at `exposure_ev` (R20: Lightroom
/// decides Highlights / Shadows on the exposed photo): `logY` and
/// `meanLogY` move by `exposure_ev`, then the networks.
pub fn coefficient_maps_at(
    features: &Features,
    exposure_ev: f64,
) -> Result<CoefficientMaps, ResponseError> {
    let models = models()?;
    let pixels = features.vectors.len();
    let shift = exposure_ev as f32;
    let mut maps = CoefficientMaps {
        width: features.width,
        height: features.height,
        highlight_a: Vec::with_capacity(pixels),
        highlight_b: Vec::with_capacity(pixels),
        shadow_a: Vec::with_capacity(pixels),
        shadow_b: Vec::with_capacity(pixels),
    };
    for vector in &features.vectors {
        let mut feature = *vector;
        if shift != 0.0 {
            for index in EXPOSURE_FEATURES {
                feature[index] += shift;
            }
        }
        let [ha, hb] = models.highlight.infer(&feature);
        let [sa, sb] = models.shadow.infer(&feature);
        maps.highlight_a.push(ha as f32);
        maps.highlight_b.push(hb as f32);
        maps.shadow_a.push(sa as f32);
        maps.shadow_b.push(sb as f32);
    }
    Ok(maps)
}

/// The coefficient maps of a linear ProPhoto analysis image at exposure 0.
pub fn coefficient_maps(
    linear_prophoto_rgb: &[f32],
    width: usize,
    height: usize,
) -> Result<CoefficientMaps, ResponseError> {
    coefficient_maps_at(&features(linear_prophoto_rgb, width, height)?, 0.0)
}

/// Highlight and shadow gains (EV) at the analysis size. `highlights` in
/// `[-100, 0]`, `shadows` in `[0, 100]`; the other directions are not this
/// response's.
/// The pixel count of `maps`, after checking that every map fits it (the
/// maps are public: a caller may build or change them) and holds finite,
/// non-negative coefficients.
fn validate_maps(maps: &CoefficientMaps) -> Result<usize, ResponseError> {
    if maps.width == 0 || maps.height == 0 {
        return Err(ResponseError::InvalidMaps(format!(
            "empty size {}x{}",
            maps.width, maps.height
        )));
    }
    let pixels = maps.width.checked_mul(maps.height).ok_or_else(|| {
        ResponseError::InvalidMaps(format!("size {}x{} overflows", maps.width, maps.height))
    })?;
    for (name, map) in [
        ("highlight_a", &maps.highlight_a),
        ("highlight_b", &maps.highlight_b),
        ("shadow_a", &maps.shadow_a),
        ("shadow_b", &maps.shadow_b),
    ] {
        if map.len() != pixels {
            return Err(ResponseError::InvalidMaps(format!(
                "{name} has {} values for {pixels} pixels",
                map.len()
            )));
        }
        if let Some(bad) = map.iter().find(|v| !v.is_finite() || **v < 0.0) {
            return Err(ResponseError::InvalidMaps(format!("{name} holds {bad}")));
        }
    }
    Ok(pixels)
}

pub fn gains(
    maps: &CoefficientMaps,
    highlights: f64,
    shadows: f64,
) -> Result<(Vec<f32>, Vec<f32>), ResponseError> {
    if !highlights.is_finite() || !(-100.0..=0.0).contains(&highlights) {
        return Err(ResponseError::InvalidHighlights(highlights));
    }
    if !shadows.is_finite() || !(0.0..=100.0).contains(&shadows) {
        return Err(ResponseError::InvalidShadows(shadows));
    }
    let pixels = validate_maps(maps)?;
    let h = -highlights / 100.0;
    let s = shadows / 100.0;
    let mut highlight = Vec::with_capacity(pixels);
    let mut shadow = Vec::with_capacity(pixels);
    for i in 0..pixels {
        let gh = (h * f64::from(maps.highlight_a[i]) + h * h * f64::from(maps.highlight_b[i]))
            .clamp(0.0, HIGHLIGHT_MAX_EV);
        let gs = (s * f64::from(maps.shadow_a[i]) + s * s * f64::from(maps.shadow_b[i]))
            .clamp(0.0, SHADOW_MAX_EV);
        highlight.push(-(gh as f32));
        shadow.push(gs as f32);
    }
    Ok((highlight, shadow))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn side_by_side_outputs_are_the_reference_accumulation() {
        let models = models().expect("embedded models");
        let mut state = 0x6c07_8965u32;
        for model in [&models.highlight, &models.shadow] {
            assert_eq!(
                (model.features.len(), model.hidden1, model.hidden2),
                (FEATURE_COUNT, 8, 4),
                "the embedded shape takes the fast path"
            );
            for sample in 0..4096 {
                let mut feature = [0.0_f32; FEATURE_COUNT];
                for value in &mut feature {
                    state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    let unit = state as f64 / u32::MAX as f64;
                    *value = match sample % 3 {
                        0 => (unit * 16.0 - 8.0) as f32,
                        1 => (unit * 200.0 - 100.0) as f32,
                        _ => (unit * 0.02 - 0.01) as f32,
                    };
                }
                let fast = model.infer(&feature);
                let reference = model.infer_reference(&feature);
                assert_eq!(fast.map(f64::to_bits), reference.map(f64::to_bits));
            }
        }
    }

    #[test]
    fn embedded_models_parse_and_give_signed_gains() {
        let models = models().expect("embedded models");
        assert!(models.highlight_chroma_alpha.is_finite());
        // Highlights only darken, Shadows only lift, zero amounts do nothing.
        let (w, h) = (40, 30);
        let mut rgb = Vec::with_capacity(w * h * 3);
        for y in 0..h {
            for x in 0..w {
                let v = 0.002 + 0.9 * ((x + y * w) as f32 / (w * h) as f32).powi(2);
                rgb.extend_from_slice(&[v, v, v]);
            }
        }
        let maps = coefficient_maps(&rgb, w, h).expect("maps");
        let (gh, gs) = gains(&maps, -100.0, 100.0).expect("gains");
        assert!(gh.iter().all(|g| g.is_finite() && *g <= 0.0));
        assert!(gs.iter().all(|g| g.is_finite() && *g >= 0.0));
        let (zero_h, zero_s) = gains(&maps, 0.0, 0.0).unwrap();
        assert!(zero_h.iter().chain(&zero_s).all(|g| *g == 0.0));
    }

    #[test]
    fn rejects_amounts_outside_this_response() {
        let maps = CoefficientMaps {
            width: 1,
            height: 1,
            highlight_a: vec![1.0],
            highlight_b: vec![0.0],
            shadow_a: vec![1.0],
            shadow_b: vec![0.0],
        };
        assert!(matches!(
            gains(&maps, 10.0, 0.0),
            Err(ResponseError::InvalidHighlights(_))
        ));
        assert!(matches!(
            gains(&maps, 0.0, -10.0),
            Err(ResponseError::InvalidShadows(_))
        ));
    }

    #[test]
    fn rejects_maps_that_do_not_fit_their_size_instead_of_panicking() {
        let fitting = || CoefficientMaps {
            width: 2,
            height: 1,
            highlight_a: vec![1.0, 1.0],
            highlight_b: vec![0.0, 0.0],
            shadow_a: vec![1.0, 1.0],
            shadow_b: vec![0.0, 0.0],
        };
        assert!(gains(&fitting(), -50.0, 50.0).is_ok());
        let broken = [
            CoefficientMaps {
                width: 0,
                ..fitting()
            },
            CoefficientMaps {
                width: usize::MAX,
                height: 2,
                ..fitting()
            },
            CoefficientMaps {
                shadow_b: vec![0.0],
                ..fitting()
            },
            CoefficientMaps {
                highlight_a: vec![1.0, f32::NAN],
                ..fitting()
            },
            CoefficientMaps {
                shadow_a: vec![1.0, -0.5],
                ..fitting()
            },
        ];
        for maps in broken {
            assert!(matches!(
                gains(&maps, -50.0, 50.0),
                Err(ResponseError::InvalidMaps(_))
            ));
        }
    }
}
