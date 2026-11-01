//! Sky masks made from the photo (niho-photo#141, `docs/local-adjustments.md`
//! "空の検出"): the small U-Net NIHO trains from scratch on its own photos
//! (#158, `tools/sky-mask-train`), run here without a model runtime (no
//! `.onnx`).
//!
//! The model is what `train_sky.py export` writes: `layout.json` (the
//! model input's long side, the inputs, the width of each level and every
//! convolution's place in the weights; BatchNorm folded in) and
//! `weights.f32` (little endian). [`SkyModel::parse`] takes the long side,
//! the widths and the layers from that header, so a retrained model of
//! another size reads the same way; a header that is not this U-Net is an
//! error.
//!
//! 1. **Model input.** The photo resampled to the long side `long` with
//!    PIL's 8-bit `BILINEAR` (a triangle filter whose support grows with the
//!    reduction; fixed point, the horizontal pass first), each side rounded
//!    to a multiple of `2^(levels + 1)` (32 for 4 levels, so every level
//!    halves cleanly), as `value / 255`. With `inputs: "rgb-ev"` two more
//!    channels carry the pixel's scene brightness from the capture's
//!    exposure (`(EV - 12) / 4`, clipped to -3..=3) and whether it is known.
//! 2. **U-Net.** 3x3 convolutions (zero padded, BatchNorm folded, ReLU): the
//!    stem and one level per further width each halve the size (stride 2,
//!    then stride 1), a context level halves once more; each decoder
//!    upsamples (bilinear, half-pixel centres: PyTorch's
//!    `align_corners=False`), puts the encoder level of that size after it
//!    and convolves; the head gives the logit at half the input's size.
//! 3. **Output size.** The sigmoid resampled (PIL's float `BILINEAR`) to the
//!    photo's size, then a guided filter on the photo's luminance (Lab
//!    `L / 100`, radius `long side / 256`, at least 2; eps 1e-3) snaps the
//!    edge, clipped to 0..=1 and rounded (half to even) to 0..=255.
//!
//! 4. **Refine** ([`estimate_sky`]; `train_sky.py predict --low 0.1
//!    --fill-delta 8 --fill-reach 0.1 --min-area 0.001`, set on #158's
//!    tuning scenes only). The model sees the photo at half of 384 on the
//!    long side, so sky between twigs and wires and behind window bars is
//!    left out, and that sky's probability often stays at 0.1..0.4:
//!    - weaker sky (0.1 and up) joined (4-neighbours) to sure sky (0.5 and
//!      up) becomes 0.5;
//!    - when sky covers 2 % of the photo or more, the gaps of the sky's own
//!      colour next to it become 1 (`label_fill.py`: Lab within 8 of one of
//!      the three k-means colours of the inner flat sky, in the upper 80 %;
//!      a piece touching the sky under 5 % of the photo, or an isolated one
//!      under 1 % within a tenth of the long side of the sky and ringed by
//!      texture);
//!    - sky pieces (4-neighbours) under 0.1 % of the photo become 0.
//!
//! The steps are `train_sky.py predict`'s, so a model scores here as it
//! scored there. Every sum runs in a fixed order and the transcendental
//! functions are `libm`'s (the ones a wasm build links), so native and wasm
//! agree bit for bit. The output rows of a convolution may run on threads
//! ([`crate::par`]); each is computed as the sequential loop computes it.

use std::fmt;

use serde_json::Value;

/// Output channels one pass of a convolution computes together (two
/// 4-lane vectors).
const LANES: usize = 8;
/// Output pixels one pass computes together (they share the weights'
/// loads).
const PIXELS: usize = 4;
/// The most levels (widths) and the widest level a header may give.
const MAX_LEVELS: usize = 6;
const MAX_WIDTH: usize = 512;
/// The longest model input a header may give.
const MAX_LONG: usize = 2048;

/// What the model reads besides the photo's colour.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkyInputs {
    /// sRGB only (3 channels).
    Rgb,
    /// sRGB, the pixel's scene brightness from the capture's exposure, and
    /// whether the exposure is known (5 channels).
    RgbEv,
}

impl SkyInputs {
    fn channels(self) -> usize {
        match self {
            SkyInputs::Rgb => 3,
            SkyInputs::RgbEv => 5,
        }
    }

    /// The header's name (`"rgb"` / `"rgb-ev"`).
    pub fn name(self) -> &'static str {
        match self {
            SkyInputs::Rgb => "rgb",
            SkyInputs::RgbEv => "rgb-ev",
        }
    }
}

/// One 3x3 convolution (padding 1), BatchNorm folded in.
struct Conv {
    cin: usize,
    cout: usize,
    stride: usize,
    relu: bool,
    /// By groups of [`LANES`] outputs: `[group][ky][kx][in][lane]` (the
    /// lanes past `cout` are 0).
    weights: Vec<f32>,
    /// `cout` rounded up to [`LANES`] (0 past `cout`).
    bias: Vec<f32>,
}

/// A sky model read from its header and weights ([`SkyModel::parse`]).
pub struct SkyModel {
    long: usize,
    inputs: SkyInputs,
    widths: Vec<usize>,
    /// In the header's order: the stem, the further levels and the context
    /// (2 each), the decoders from the deepest, the head.
    layers: Vec<Conv>,
}

impl fmt::Debug for SkyModel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "SkyModel(long {}, {}, widths {:?})",
            self.long,
            self.inputs.name(),
            self.widths
        )
    }
}

/// A layer as the header must give it: `(name, in, out, stride, relu)`.
type Shape = (String, usize, usize, usize, bool);

/// The layers of the U-Net of these `widths`, in the header's order.
fn expected_layers(inputs: usize, widths: &[usize]) -> Vec<Shape> {
    let levels = widths.len();
    let mut layers = vec![
        ("stem.0".to_string(), inputs, widths[0], 2, true),
        ("stem.1".to_string(), widths[0], widths[0], 1, true),
    ];
    for k in 1..levels {
        layers.push((format!("enc{}.0", k + 1), widths[k - 1], widths[k], 2, true));
        layers.push((format!("enc{}.1", k + 1), widths[k], widths[k], 1, true));
    }
    let deepest = widths[levels - 1];
    layers.push(("ctx.0".to_string(), deepest, deepest, 2, true));
    layers.push(("ctx.1".to_string(), deepest, deepest, 1, true));
    for k in (1..=levels).rev() {
        let below = widths[k.min(levels - 1)];
        layers.push((
            format!("dec{k}"),
            below + widths[k - 1],
            widths[k - 1],
            1,
            true,
        ));
    }
    layers.push(("head".to_string(), widths[0], 1, 1, false));
    layers
}

fn usize_of(value: &Value, what: &str) -> Result<usize, String> {
    value
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| format!("sky model: {what} must be a non-negative integer"))
}

/// The `count` floats a layer's `key` (`"weights"` / `"bias"`) places.
fn placed<'a>(
    values: &'a [f32],
    layer: &Value,
    name: &str,
    key: &str,
    count: usize,
) -> Result<&'a [f32], String> {
    let start = usize_of(&layer[key], &format!("{name}.{key}"))?;
    start
        .checked_add(count)
        .and_then(|end| values.get(start..end))
        .ok_or_else(|| format!("sky model: {name}.{key} is past the weights"))
}

impl SkyModel {
    /// Reads a model: `layout_json` is the header (`{"long", "inputs",
    /// "channels", "floats", "layers": [{"name", "in", "out", "stride",
    /// "relu", "weights", "bias"}]}`), `weights` the `floats` little-endian
    /// f32 it places (each convolution's `[out][in][3][3]` weights and its
    /// biases). The layers must be this U-Net's for the header's widths
    /// (1..=6 levels, each 1..=512 wide) and inputs; the weights must be
    /// finite.
    pub fn parse(layout_json: &str, weights: &[u8]) -> Result<Self, String> {
        let layout: Value =
            serde_json::from_str(layout_json).map_err(|e| format!("sky model: {e}"))?;
        let long = usize_of(&layout["long"], "long")?;
        let inputs = match layout["inputs"].as_str() {
            Some("rgb") => SkyInputs::Rgb,
            Some("rgb-ev") => SkyInputs::RgbEv,
            _ => return Err("sky model: inputs must be \"rgb\" or \"rgb-ev\"".to_string()),
        };
        let widths = layout["channels"]
            .as_array()
            .ok_or_else(|| "sky model: channels must be an array".to_string())?
            .iter()
            .map(|w| usize_of(w, "a channel width"))
            .collect::<Result<Vec<_>, _>>()?;
        if widths.is_empty()
            || widths.len() > MAX_LEVELS
            || widths.iter().any(|&w| w == 0 || w > MAX_WIDTH)
        {
            return Err(format!(
                "sky model: channels must be 1..={MAX_LEVELS} widths of 1..={MAX_WIDTH}"
            ));
        }
        let multiple = 1usize << (widths.len() + 1);
        if long < multiple || long > MAX_LONG {
            return Err(format!("sky model: long must be {multiple}..={MAX_LONG}"));
        }
        let floats = usize_of(&layout["floats"], "floats")?;
        if floats.checked_mul(4) != Some(weights.len()) {
            return Err(format!(
                "sky model: {} bytes of weights, but the header places {floats} floats",
                weights.len()
            ));
        }
        let values: Vec<f32> = weights
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        if values.iter().any(|v| !v.is_finite()) {
            return Err("sky model: the weights must be finite".to_string());
        }
        let given = layout["layers"]
            .as_array()
            .ok_or_else(|| "sky model: layers must be an array".to_string())?;
        let expected = expected_layers(inputs.channels(), &widths);
        if given.len() != expected.len() {
            return Err(format!(
                "sky model: {} layers, but a U-Net of {} levels has {}",
                given.len(),
                widths.len(),
                expected.len()
            ));
        }
        let mut layers = Vec::with_capacity(expected.len());
        for (layer, (name, cin, cout, stride, relu)) in given.iter().zip(expected) {
            let same = layer["name"].as_str() == Some(name.as_str())
                && layer["in"].as_u64() == Some(cin as u64)
                && layer["out"].as_u64() == Some(cout as u64)
                && layer["stride"].as_u64() == Some(stride as u64)
                && layer["relu"].as_bool() == Some(relu);
            if !same {
                return Err(format!(
                    "sky model: layer {} is not {name} ({cin} -> {cout}, stride {stride})",
                    layer["name"]
                ));
            }
            let w = placed(&values, layer, &name, "weights", cout * cin * 9)?;
            let b = placed(&values, layer, &name, "bias", cout)?;
            layers.push(Conv::new(cin, cout, stride, relu, w, b));
        }
        Ok(SkyModel {
            long,
            inputs,
            widths,
            layers,
        })
    }

    /// The model input's long side.
    pub fn long_side(&self) -> usize {
        self.long
    }

    /// What the model reads besides the colour.
    pub fn inputs(&self) -> SkyInputs {
        self.inputs
    }

    /// The width of each level.
    pub fn widths(&self) -> &[usize] {
        &self.widths
    }

    /// The model input's size for a photo of `width x height`
    /// (`train_sky.py`'s `model_size`): scaled to the long side, each side
    /// rounded (half to even) to the multiple every level halves, at least
    /// one multiple.
    pub fn input_size(&self, width: usize, height: usize) -> (usize, usize) {
        let multiple = (1usize << (self.widths.len() + 1)) as f64;
        let scale = self.long as f64 / width.max(height) as f64;
        let side = |n: usize| {
            let rounded = (n as f64 * scale / multiple).round_ties_even() * multiple;
            (rounded as usize).max(multiple as usize)
        };
        (side(width), side(height))
    }

    /// The logits at half the model input's size.
    fn logits(&self, input: Map) -> Map {
        let mut layers = self.layers.iter();
        let mut next = || layers.next().expect("a parsed model has every layer");
        let mut top = conv(&padded(&input), next());
        top = conv(&padded(&top), next());
        let mut skips: Vec<Map> = Vec::with_capacity(self.widths.len());
        for _ in 1..self.widths.len() {
            let down = conv(&padded(&top), next());
            let level = conv(&padded(&down), next());
            skips.push(std::mem::replace(&mut top, level));
        }
        skips.push(top);
        let deepest = skips.last().expect("at least one level");
        let context = conv(&padded(deepest), next());
        let mut low = conv(&padded(&context), next());
        for skip in skips.iter().rev() {
            low = conv(&upsampled_beside(&low, skip), next());
        }
        conv(&padded(&low), next())
    }

    /// The model's input channels for the resized photo.
    fn features(&self, small: &[u8], w: usize, h: usize, ev100: Option<f64>) -> Map {
        let c = self.inputs.channels();
        let mut v = Vec::with_capacity(w * h * c);
        for px in small.chunks_exact(3) {
            let rgb = [
                px[0] as f32 / 255.0,
                px[1] as f32 / 255.0,
                px[2] as f32 / 255.0,
            ];
            v.extend_from_slice(&rgb);
            if self.inputs == SkyInputs::RgbEv {
                match ev100 {
                    Some(ev100) => {
                        let lum = lab_lightness(rgb) / 100.0;
                        let lin = if lum > 0.08 {
                            libm::powf((lum + 0.16) / 1.16, 3.0)
                        } else {
                            lum / 9.033
                        };
                        let ev = ev100 as f32 + libm::log2f(lin.max(1e-4) / 0.18);
                        v.extend_from_slice(&[((ev - 12.0) / 4.0).clamp(-3.0, 3.0), 1.0]);
                    }
                    None => v.extend_from_slice(&[0.0, 0.0]),
                }
            }
        }
        Map { w, h, c, v }
    }
}

impl Conv {
    fn new(cin: usize, cout: usize, stride: usize, relu: bool, w: &[f32], b: &[f32]) -> Self {
        let groups = cout.div_ceil(LANES);
        let mut weights = vec![0.0f32; groups * 9 * cin * LANES];
        let mut bias = vec![0.0f32; groups * LANES];
        bias[..cout].copy_from_slice(b);
        for o in 0..cout {
            let (group, lane) = (o / LANES, o % LANES);
            for i in 0..cin {
                for tap in 0..9 {
                    weights[((group * 9 + tap) * cin + i) * LANES + lane] =
                        w[(o * cin + i) * 9 + tap];
                }
            }
        }
        Conv {
            cin,
            cout,
            stride,
            relu,
            weights,
            bias,
        }
    }
}

/// A feature map: `w x h` pixels of `c` channels, row-major, the channels
/// of a pixel together.
struct Map {
    w: usize,
    h: usize,
    c: usize,
    v: Vec<f32>,
}

/// A [`Map`] inside a border of one zero pixel (a convolution's padding):
/// `(w + 2) x (h + 2)` pixels.
struct Padded {
    w: usize,
    h: usize,
    c: usize,
    v: Vec<f32>,
}

fn padded(map: &Map) -> Padded {
    let (pw, c) = (map.w + 2, map.c);
    let mut v = vec![0.0f32; pw * (map.h + 2) * c];
    for (y, row) in map.v.chunks_exact(map.w * c).enumerate() {
        v[((y + 1) * pw + 1) * c..][..map.w * c].copy_from_slice(row);
    }
    Padded {
        w: map.w,
        h: map.h,
        c,
        v,
    }
}

/// PyTorch's bilinear sampling along one axis with `align_corners=False`:
/// for every output index the two input indices and their weights.
fn bilinear_axis(n_in: usize, n_out: usize) -> Vec<(usize, usize, f32, f32)> {
    let scale = n_in as f32 / n_out as f32;
    (0..n_out)
        .map(|o| {
            let source = (scale * (o as f32 + 0.5) - 0.5).max(0.0);
            let i0 = (source as usize).min(n_in - 1);
            let i1 = if i0 + 1 < n_in { i0 + 1 } else { i0 };
            let l1 = source - i0 as f32;
            (i0, i1, 1.0 - l1, l1)
        })
        .collect()
}

/// `low` upsampled to `skip`'s size, then `skip`'s channels after its own
/// (a decoder's input, `cat([up(low), skip])`), padded.
fn upsampled_beside(low: &Map, skip: &Map) -> Padded {
    let (w, h, c) = (skip.w, skip.h, low.c + skip.c);
    let pw = w + 2;
    let mut v = vec![0.0f32; pw * (h + 2) * c];
    let (xs, ys) = (bilinear_axis(low.w, w), bilinear_axis(low.h, h));
    let at = |y: usize, x: usize| &low.v[(y * low.w + x) * low.c..][..low.c];
    for (y, &(y0, y1, ly0, ly1)) in ys.iter().enumerate() {
        for (x, &(x0, x1, lx0, lx1)) in xs.iter().enumerate() {
            let (up, beside) = v[((y + 1) * pw + x + 1) * c..][..c].split_at_mut(low.c);
            let (v00, v01, v10, v11) = (at(y0, x0), at(y0, x1), at(y1, x0), at(y1, x1));
            for (k, out) in up.iter_mut().enumerate() {
                *out = ly0 * (lx0 * v00[k] + lx1 * v01[k]) + ly1 * (lx0 * v10[k] + lx1 * v11[k]);
            }
            beside.copy_from_slice(&skip.v[(y * w + x) * skip.c..][..skip.c]);
        }
    }
    Padded { w, h, c, v }
}

/// One convolution of a padded map.
fn conv(input: &Padded, conv: &Conv) -> Map {
    debug_assert_eq!(input.c, conv.cin);
    let size = |n: usize| (n - 1) / conv.stride + 1;
    let (w, h) = (size(input.w), size(input.h));
    let mut v = vec![0.0f32; w * h * conv.cout];
    crate::par::for_each_row_mut(&mut v, w * conv.cout, |y, row| {
        conv_row(input, conv, y, row)
    });
    Map {
        w,
        h,
        c: conv.cout,
        v,
    }
}

/// Output row `y` of a convolution: every output is its bias plus the taps
/// in the order `ky`, `kx`, input channel, whichever block computes it.
fn conv_row(input: &Padded, conv: &Conv, y: usize, row: &mut [f32]) {
    let cout = conv.cout;
    let w = row.len() / cout;
    for (group, weights) in conv.weights.chunks_exact(9 * conv.cin * LANES).enumerate() {
        let first = group * LANES;
        let outputs = (cout - first).min(LANES);
        let bias: [f32; LANES] = conv.bias[first..first + LANES]
            .try_into()
            .expect("the bias fills whole groups");
        let mut store = |x: usize, acc: &[f32; LANES]| {
            let out = &mut row[x * cout + first..][..outputs];
            for (o, &a) in out.iter_mut().zip(acc) {
                *o = if conv.relu { a.max(0.0) } else { a };
            }
        };
        let mut x = 0;
        while x + PIXELS <= w {
            let block = conv_block::<PIXELS>(input, conv.stride, weights, bias, x, y);
            for (p, acc) in block.iter().enumerate() {
                store(x + p, acc);
            }
            x += PIXELS;
        }
        while x < w {
            let [acc] = conv_block::<1>(input, conv.stride, weights, bias, x, y);
            store(x, &acc);
            x += 1;
        }
    }
}

/// [`LANES`] outputs of the `P` output pixels from `x` on row `y`.
#[inline(always)]
fn conv_block<const P: usize>(
    input: &Padded,
    stride: usize,
    weights: &[f32],
    bias: [f32; LANES],
    x: usize,
    y: usize,
) -> [[f32; LANES]; P] {
    let (pw, cin) = (input.w + 2, input.c);
    let mut acc = [bias; P];
    for ky in 0..3 {
        let line = (y * stride + ky) * pw;
        for kx in 0..3 {
            let taps = &weights[(ky * 3 + kx) * cin * LANES..][..cin * LANES];
            let pixels: [&[f32]; P] = std::array::from_fn(|p| {
                let at = (line + (x + p) * stride + kx) * cin;
                &input.v[at..at + cin]
            });
            for (i, lanes) in taps.chunks_exact(LANES).enumerate() {
                let lanes: &[f32; LANES] = lanes.try_into().expect("whole lanes");
                for (acc, pixel) in acc.iter_mut().zip(&pixels) {
                    let v = pixel[i];
                    for (a, &w) in acc.iter_mut().zip(lanes) {
                        *a += v * w;
                    }
                }
            }
        }
    }
    acc
}

/// An estimated sky: `width * height` values, row-major, 0 (not sky) ..=
/// 255 (sky), at the input's size (the bytes of a mask surface,
/// [`crate::mask_surface::MaskSurface::new`]).
#[derive(Clone, PartialEq, Eq)]
pub struct SkySurface {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

impl fmt::Debug for SkySurface {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SkySurface({}x{})", self.width, self.height)
    }
}

impl SkySurface {
    /// Whether any pixel is sky (128 or more: more likely sky than not; the
    /// evaluation of #158 counts a photo without sky as wrong from one such
    /// pixel).
    pub fn has_sky(&self) -> bool {
        self.data.iter().any(|&v| v >= 128)
    }
}

/// The model's sky map of a photo, sky or not. `rgb` is sRGB 8-bit RGB (3
/// bytes per pixel, row-major) of `width x height`; `ev100` is the capture's
/// exposure value at ISO 100 (`log2(N^2 / t) - log2(ISO / 100)`), `None`
/// when unknown (a non-finite one counts as unknown; an `"rgb"` model does
/// not read it). Returns the surface at the input's size, or `None` for
/// input it cannot read: a zero side, `rgb` not `width * height * 3` bytes,
/// a side past `u32`.
pub fn predict(
    model: &SkyModel,
    rgb: &[u8],
    width: usize,
    height: usize,
    ev100: Option<f64>,
) -> Option<SkySurface> {
    let probability = probability(model, rgb, width, height, ev100)?;
    surface_of(width, height, &probability.v)
}

/// [`predict`] followed by the refine steps (the module's step 4): the
/// surface `train_sky.py predict --low 0.1 --fill-delta 8 --fill-reach 0.1
/// --min-area 0.001` writes, sky or not.
pub fn predict_refined(
    model: &SkyModel,
    rgb: &[u8],
    width: usize,
    height: usize,
    ev100: Option<f64>,
) -> Option<SkySurface> {
    let mut probability = probability(model, rgb, width, height, ev100)?;
    refine(rgb, width, height, &mut probability.v);
    surface_of(width, height, &probability.v)
}

/// The probabilities clipped to 0..=1 and rounded (half to even) to
/// 0..=255.
fn surface_of(width: usize, height: usize, probability: &[f32]) -> Option<SkySurface> {
    let (width, height) = (u32::try_from(width).ok()?, u32::try_from(height).ok()?);
    let data = probability
        .iter()
        .map(|&p| (p.clamp(0.0, 1.0) * 255.0).round_ties_even() as u8)
        .collect();
    Some(SkySurface {
        width,
        height,
        data,
    })
}

/// The model's sky probability at the photo's size (steps 1 to 3), clipped
/// to 0..=1.
fn probability(
    model: &SkyModel,
    rgb: &[u8],
    width: usize,
    height: usize,
    ev100: Option<f64>,
) -> Option<Plane> {
    if width == 0 || height == 0 || width.checked_mul(height)?.checked_mul(3)? != rgb.len() {
        return None;
    }
    u32::try_from(width).ok()?;
    u32::try_from(height).ok()?;
    let (mw, mh) = model.input_size(width, height);
    let small = resize_rgb8(rgb, width, height, mw, mh);
    let input = model.features(&small, mw, mh, ev100.filter(|ev| ev.is_finite()));
    let logits = model.logits(input);
    let probability: Vec<f32> = logits
        .v
        .iter()
        .map(|&z| 1.0 / (1.0 + libm::expf(-z)))
        .collect();
    let src = Plane {
        w: width,
        h: height,
        v: resize(&probability, logits.w, logits.h, 1, width, height),
    };
    let guide = Plane {
        w: width,
        h: height,
        v: lightness_plane(rgb),
    };
    let radius = ((width.max(height) as f64 / 256.0).round_ties_even() as usize).max(2);
    let mut filtered = guided_filter(&guide, &src, radius, 1e-3);
    for p in &mut filtered.v {
        *p = p.clamp(0.0, 1.0);
    }
    Some(filtered)
}

/// The sky of a photo ([`predict_refined`]), or `None` when no pixel is sky
/// ([`SkySurface::has_sky`]) or the input cannot be read.
pub fn estimate_sky(
    model: &SkyModel,
    rgb: &[u8],
    width: usize,
    height: usize,
    ev100: Option<f64>,
) -> Option<SkySurface> {
    predict_refined(model, rgb, width, height, ev100).filter(SkySurface::has_sky)
}

/// Weaker sky joined to sure sky becomes sure (step 4).
const LOW: f32 = 0.1;
/// Sure sky (the surface's 128 and up).
const SURE: f32 = 0.5;
/// The share of the photo the sky must cover before its gaps are filled.
const FILL_FROM: f64 = 0.02;
/// The largest Lab distance from one of the sky's colours.
const FILL_DELTA: f32 = 8.0;
/// Isolated gaps lie within this share of the long side of the sky.
const FILL_REACH: f64 = 0.1;
/// Only the upper share of the rows is searched.
const FILL_ROWS: f64 = 0.8;
/// Sky pieces smaller than this share of the photo are dropped.
const MIN_AREA: f64 = 0.001;

/// The refine steps on `probability` (`width * height`, 0..=1) of the photo
/// `rgb`, in place (`train_sky.py`'s `refine`).
fn refine(rgb: &[u8], width: usize, height: usize, probability: &mut [f32]) {
    let n = width * height;
    // Weaker sky joined to sure sky.
    let weak: Vec<bool> = probability.iter().map(|&p| p >= LOW).collect();
    let (pieces, count) = label(&weak, width, height, false);
    let mut seeded = vec![false; count + 1];
    for (i, &k) in pieces.iter().enumerate() {
        if probability[i] >= SURE {
            seeded[k as usize] = true;
        }
    }
    seeded[0] = false;
    for (i, &k) in pieces.iter().enumerate() {
        if seeded[k as usize] && probability[i] < SURE {
            probability[i] = SURE;
        }
    }
    // The gaps of the sky's colour.
    let sky: Vec<bool> = probability.iter().map(|&p| p >= SURE).collect();
    let covered = sky.iter().filter(|&&s| s).count();
    if covered as f64 / n as f64 >= FILL_FROM {
        if let Some(filled) = fill(rgb, &sky, width, height) {
            for i in 0..n {
                if filled[i] && !sky[i] {
                    probability[i] = 1.0;
                }
            }
        }
    }
    // Small sky pieces.
    let sky: Vec<bool> = probability.iter().map(|&p| p >= SURE).collect();
    let (pieces, count) = label(&sky, width, height, false);
    let mut area = vec![0usize; count + 1];
    for &k in &pieces {
        area[k as usize] += 1;
    }
    let limit = MIN_AREA * n as f64;
    for (i, &k) in pieces.iter().enumerate() {
        if k != 0 && (area[k as usize] as f64) < limit {
            probability[i] = 0.0;
        }
    }
}

/// The sky with the gaps of its own colour added (`label_fill.py`'s
/// `fill`), or `None` when the sky has fewer than 200 inner flat pixels.
fn fill(rgb: &[u8], sky: &[bool], width: usize, height: usize) -> Option<Vec<bool>> {
    let (w, h, n) = (width, height, width * height);
    let lab = lab_pixels(rgb);
    let lightness = Plane {
        w,
        h,
        v: lab.iter().map(|p| p[0]).collect(),
    };
    let flat = flat_pixels(&lightness);
    let eroded = erode(sky, w, h, 5);
    let inner: Vec<[f32; 3]> = (0..n)
        .filter(|&i| eroded[i] && flat[i])
        .map(|i| lab[i])
        .collect();
    if inner.len() < 200 {
        return None;
    }
    let colours = kmeans(&inner, 3, 12);
    let rows = (FILL_ROWS * h as f64) as usize;
    let candidate: Vec<bool> = (0..n)
        .map(|i| !sky[i] && i / w < rows && nearest_colour(lab[i], &colours) < FILL_DELTA)
        .collect();
    let (pieces, count) = label(&candidate, w, h, true);
    if count == 0 {
        return Some(sky.to_vec());
    }
    let near_sky = dilate(sky, w, h, 2);
    let distance = distance_to(sky, w, h);
    let mut area = vec![0usize; count + 1];
    let mut touches = vec![false; count + 1];
    let mut nearest = vec![f64::INFINITY; count + 1];
    // (top, left, bottom, right), bottom and right exclusive
    let mut bounds = vec![(usize::MAX, usize::MAX, 0usize, 0usize); count + 1];
    for (i, &k) in pieces.iter().enumerate() {
        if k == 0 {
            continue;
        }
        let k = k as usize;
        let (x, y) = (i % w, i / w);
        area[k] += 1;
        touches[k] |= near_sky[i];
        nearest[k] = nearest[k].min(distance[i]);
        let b = &mut bounds[k];
        *b = (b.0.min(y), b.1.min(x), b.2.max(y + 1), b.3.max(x + 1));
    }
    let mean = box_mean(&lightness, 4);
    let squared = Plane {
        w,
        h,
        v: lightness.v.iter().map(|v| v * v).collect(),
    };
    let mean_squared = box_mean(&squared, 4);
    let spread: Vec<f32> = (0..n)
        .map(|i| (mean_squared.v[i] - mean.v[i] * mean.v[i]).max(0.0).sqrt())
        .collect();
    let reach = FILL_REACH * w.max(h) as f64;
    let mut add = vec![false; count + 1];
    for k in 1..=count {
        let share = area[k] as f64 / n as f64;
        if touches[k] && share < 0.05 {
            add[k] = true;
        } else if share < 0.01 && nearest[k] <= reach {
            add[k] = ringed_by_texture(&pieces, k as u32, bounds[k], &spread, w, h);
        }
    }
    Some((0..n).map(|i| sky[i] || add[pieces[i] as usize]).collect())
}

/// Whether the 4-pixel ring around piece `k` (a diamond, cut at the photo's
/// edge) has a mean lightness spread of 6 or more.
fn ringed_by_texture(
    pieces: &[u32],
    k: u32,
    (top, left, bottom, right): (usize, usize, usize, usize),
    spread: &[f32],
    w: usize,
    h: usize,
) -> bool {
    const RING: usize = 4;
    let (y0, x0) = (top.saturating_sub(RING), left.saturating_sub(RING));
    let (y1, x1) = ((bottom + RING).min(h), (right + RING).min(w));
    let (bw, bh) = (x1 - x0, y1 - y0);
    let piece: Vec<bool> = (0..bw * bh)
        .map(|j| pieces[(y0 + j / bw) * w + x0 + j % bw] == k)
        .collect();
    let grown = dilate(&piece, bw, bh, RING);
    let (mut sum, mut count) = (0.0f64, 0usize);
    for j in 0..bw * bh {
        if grown[j] && !piece[j] {
            sum += spread[(y0 + j / bw) * w + x0 + j % bw] as f64;
            count += 1;
        }
    }
    count > 0 && sum / count as f64 >= 6.0
}

/// CIE Lab (D65) of every pixel of sRGB 8-bit RGB (`sky_math.srgb_to_lab`).
fn lab_pixels(rgb: &[u8]) -> Vec<[f32; 3]> {
    let linear: Vec<f32> = (0..=255u8).map(|v| srgb_linear(v as f32 / 255.0)).collect();
    rgb.chunks_exact(3)
        .map(|c| {
            let [r, g, b] = [c[0], c[1], c[2]].map(|v| linear[v as usize]);
            let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
            let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
            let [fx, fy, fz] = [x, y, z].map(lab_f);
            [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
        })
        .collect()
}

/// Pixels whose lightness gradient (`np.gradient`: central differences,
/// one-sided at the edges) is under 2.
fn flat_pixels(lightness: &Plane) -> Vec<bool> {
    let (w, h, v) = (lightness.w, lightness.h, &lightness.v);
    let along = |i: usize, len: usize, at: &dyn Fn(usize) -> f32| -> f32 {
        if len < 2 {
            0.0
        } else if i == 0 {
            at(1) - at(0)
        } else if i == len - 1 {
            at(len - 1) - at(len - 2)
        } else {
            (at(i + 1) - at(i - 1)) / 2.0
        }
    };
    (0..w * h)
        .map(|i| {
            let (x, y) = (i % w, i / w);
            let gx = along(x, w, &|t| v[y * w + t]);
            let gy = along(y, h, &|t| v[t * w + x]);
            libm::hypotf(gx, gy) < 2.0
        })
        .collect()
}

/// Lloyd's k-means of `x` (`label_fill.py`'s `kmeans`): at most 20000 rows
/// (evenly spaced), the first centres the evenly spaced rows.
fn kmeans(x: &[[f32; 3]], k: usize, iterations: usize) -> Vec<[f32; 3]> {
    let spaced = |n: usize, m: usize| -> Vec<usize> {
        if m == 1 {
            return vec![0];
        }
        let step = (n - 1) as f64 / (m - 1) as f64;
        (0..m)
            .map(|i| {
                if i == m - 1 {
                    n - 1
                } else {
                    (i as f64 * step) as usize
                }
            })
            .collect()
    };
    let rows: Vec<[f32; 3]> = if x.len() > 20000 {
        spaced(x.len(), 20000).into_iter().map(|i| x[i]).collect()
    } else {
        x.to_vec()
    };
    let mut centres: Vec<[f32; 3]> = spaced(rows.len(), k.min(rows.len()))
        .into_iter()
        .map(|i| rows[i])
        .collect();
    let mut nearest = vec![0usize; rows.len()];
    for _ in 0..iterations {
        for (row, slot) in rows.iter().zip(&mut nearest) {
            *slot = nearest_index(*row, &centres).0;
        }
        for (j, centre) in centres.iter_mut().enumerate() {
            let (mut sum, mut count) = ([0.0f64; 3], 0usize);
            for (row, &slot) in rows.iter().zip(&nearest) {
                if slot == j {
                    for c in 0..3 {
                        sum[c] += row[c] as f64;
                    }
                    count += 1;
                }
            }
            if count > 0 {
                *centre = sum.map(|s| (s / count as f64) as f32);
            }
        }
    }
    centres
}

/// The index of the nearest centre (the first of equals) and the squared
/// distance to it.
fn nearest_index(p: [f32; 3], centres: &[[f32; 3]]) -> (usize, f32) {
    let mut best = (0, f32::INFINITY);
    for (j, c) in centres.iter().enumerate() {
        let d = (p[0] - c[0]) * (p[0] - c[0])
            + (p[1] - c[1]) * (p[1] - c[1])
            + (p[2] - c[2]) * (p[2] - c[2]);
        if d < best.1 {
            best = (j, d);
        }
    }
    best
}

/// The Lab distance to the nearest of `colours`.
fn nearest_colour(p: [f32; 3], colours: &[[f32; 3]]) -> f32 {
    nearest_index(p, colours).1.sqrt()
}

/// The connected pieces of `mask` (4-neighbours, or 8 with `diagonal`),
/// numbered from 1 in the order a row-major scan meets them; 0 elsewhere.
fn label(mask: &[bool], w: usize, h: usize, diagonal: bool) -> (Vec<u32>, usize) {
    let mut pieces = vec![0u32; w * h];
    let mut count = 0u32;
    let mut stack = Vec::new();
    for start in 0..w * h {
        if !mask[start] || pieces[start] != 0 {
            continue;
        }
        count += 1;
        pieces[start] = count;
        stack.push(start);
        while let Some(i) = stack.pop() {
            let (x, y) = ((i % w) as isize, (i / w) as isize);
            for dy in -1isize..=1 {
                for dx in -1isize..=1 {
                    if (dx == 0 && dy == 0) || (!diagonal && dx != 0 && dy != 0) {
                        continue;
                    }
                    let (nx, ny) = (x + dx, y + dy);
                    if nx < 0 || ny < 0 || nx >= w as isize || ny >= h as isize {
                        continue;
                    }
                    let j = ny as usize * w + nx as usize;
                    if mask[j] && pieces[j] == 0 {
                        pieces[j] = count;
                        stack.push(j);
                    }
                }
            }
        }
    }
    (pieces, count as usize)
}

/// `iterations` binary erosions by the 4-neighbour cross; outside the
/// image counts as not set (scipy's `binary_erosion`).
fn erode(mask: &[bool], w: usize, h: usize, iterations: usize) -> Vec<bool> {
    let mut current = mask.to_vec();
    for _ in 0..iterations {
        current = (0..w * h)
            .map(|i| {
                let (x, y) = (i % w, i / w);
                current[i]
                    && x > 0
                    && x + 1 < w
                    && y > 0
                    && y + 1 < h
                    && current[i - 1]
                    && current[i + 1]
                    && current[i - w]
                    && current[i + w]
            })
            .collect();
    }
    current
}

/// `iterations` binary dilations by the 4-neighbour cross (scipy's
/// `binary_dilation`).
fn dilate(mask: &[bool], w: usize, h: usize, iterations: usize) -> Vec<bool> {
    let mut current = mask.to_vec();
    for _ in 0..iterations {
        current = (0..w * h)
            .map(|i| {
                let (x, y) = (i % w, i / w);
                current[i]
                    || (x > 0 && current[i - 1])
                    || (x + 1 < w && current[i + 1])
                    || (y > 0 && current[i - w])
                    || (y + 1 < h && current[i + w])
            })
            .collect();
    }
    current
}

/// The exact Euclidean distance of every pixel to the nearest set pixel of
/// `mask` (0 on it; scipy's `distance_transform_edt` of the inverse), by
/// Felzenszwalb and Huttenlocher's lower envelope of parabolas, columns
/// then rows.
fn distance_to(mask: &[bool], w: usize, h: usize) -> Vec<f64> {
    const FAR: f64 = 1e20;
    let mut squared: Vec<f64> = mask.iter().map(|&m| if m { 0.0 } else { FAR }).collect();
    let mut line = Vec::new();
    for x in 0..w {
        line.clear();
        line.extend((0..h).map(|y| squared[y * w + x]));
        let out = envelope(&line);
        for y in 0..h {
            squared[y * w + x] = out[y];
        }
    }
    for y in 0..h {
        let out = envelope(&squared[y * w..(y + 1) * w]);
        squared[y * w..(y + 1) * w].copy_from_slice(&out);
    }
    squared.into_iter().map(f64::sqrt).collect()
}

/// The 1-D squared distance transform of `f` (sampled parabolas; `z[0]` is
/// minus infinity, so the back-tracking stops at the first parabola).
fn envelope(f: &[f64]) -> Vec<f64> {
    let n = f.len();
    let mut v = vec![0usize; n];
    let mut z = vec![0.0f64; n + 1];
    let mut k = 0usize;
    z[0] = f64::NEG_INFINITY;
    z[1] = f64::INFINITY;
    let cross = |q: usize, p: usize| {
        ((f[q] + (q * q) as f64) - (f[p] + (p * p) as f64)) / (2.0 * (q as f64 - p as f64))
    };
    for q in 1..n {
        let mut s = cross(q, v[k]);
        while s <= z[k] {
            k -= 1;
            s = cross(q, v[k]);
        }
        k += 1;
        v[k] = q;
        z[k] = s;
        z[k + 1] = f64::INFINITY;
    }
    let mut out = vec![0.0f64; n];
    let mut k = 0usize;
    for (q, slot) in out.iter_mut().enumerate() {
        while z[k + 1] < q as f64 {
            k += 1;
        }
        let d = q as f64 - v[k] as f64;
        *slot = d * d + f[v[k]];
    }
    out
}

struct Plane {
    w: usize,
    h: usize,
    v: Vec<f32>,
}

impl Plane {
    fn new(w: usize, h: usize) -> Self {
        Plane {
            w,
            h,
            v: vec![0.0; w * h],
        }
    }
}

/// PIL's `BILINEAR` taps along one axis (a triangle filter whose support
/// grows with the reduction): for every output sample the first input
/// sample and the normalized weights.
fn pil_taps(len_in: usize, len_out: usize) -> Vec<(usize, Vec<f64>)> {
    let scale = len_in as f64 / len_out as f64;
    let filterscale = scale.max(1.0);
    let support = filterscale;
    let ss = 1.0 / filterscale;
    (0..len_out)
        .map(|xx| {
            let center = (xx as f64 + 0.5) * scale;
            let xmin = ((center - support + 0.5) as i64).max(0) as usize;
            let xmax = ((center + support + 0.5) as i64).min(len_in as i64) as usize - xmin;
            let mut weights: Vec<f64> = (0..xmax)
                .map(|x| {
                    let t = ((x + xmin) as f64 - center + 0.5) * ss;
                    if t.abs() < 1.0 {
                        1.0 - t.abs()
                    } else {
                        0.0
                    }
                })
                .collect();
            let total: f64 = weights.iter().sum();
            if total != 0.0 {
                weights.iter_mut().for_each(|w| *w /= total);
            }
            (xmin, weights)
        })
        .collect()
}

/// The index of sample `k` of line `o` in the layout of [`resample_axis`].
fn sample_index(o: usize, k: usize, len: usize, lines: usize, rows: bool) -> usize {
    if rows {
        o * len + k
    } else {
        k * lines + o
    }
}

/// PIL's float `BILINEAR` resample along one axis, accumulated in `f64`.
/// `src` holds `lines` lines of `len_in` samples of `channels` interleaved
/// values: along the rows (`rows`) line `o` is row `o`, otherwise it is
/// column `o` of an image `lines` columns wide. The output keeps that
/// layout with `len_out` samples per line.
fn resample_axis(
    src: &[f32],
    len_in: usize,
    len_out: usize,
    channels: usize,
    lines: usize,
    rows: bool,
) -> Vec<f32> {
    let taps = pil_taps(len_in, len_out);
    let mut out = vec![0.0f32; lines * len_out * channels];
    for o in 0..lines {
        for c in 0..channels {
            for (xx, (xmin, weights)) in taps.iter().enumerate() {
                let mut acc = 0.0f64;
                for (k, w) in weights.iter().enumerate() {
                    let i = sample_index(o, xmin + k, len_in, lines, rows) * channels + c;
                    acc += src[i] as f64 * w;
                }
                out[sample_index(o, xx, len_out, lines, rows) * channels + c] = acc as f32;
            }
        }
    }
    out
}

/// Resizes an interleaved float image of `channels` values per pixel (the
/// horizontal pass, then the vertical one, like PIL).
fn resize(src: &[f32], w: usize, h: usize, channels: usize, ow: usize, oh: usize) -> Vec<f32> {
    let horizontal = if ow != w {
        resample_axis(src, w, ow, channels, h, true)
    } else {
        src.to_vec()
    };
    if oh != h {
        resample_axis(&horizontal, h, oh, channels, ow, false)
    } else {
        horizontal
    }
}

/// The fraction bits of PIL's 8-bit resample.
const PRECISION_BITS: u32 = 32 - 8 - 2;

/// PIL's 8-bit `BILINEAR` resample of RGB along one axis (the layout of
/// [`resample_axis`]): the weights in fixed point, half added, the sum
/// shifted down and clipped to 0..=255.
fn resample_axis_rgb8(
    src: &[u8],
    len_in: usize,
    len_out: usize,
    lines: usize,
    rows: bool,
) -> Vec<u8> {
    let one = (1u32 << PRECISION_BITS) as f64;
    let taps: Vec<(usize, Vec<i32>)> = pil_taps(len_in, len_out)
        .into_iter()
        .map(|(xmin, weights)| {
            let fixed = weights
                .iter()
                .map(|&w| {
                    if w < 0.0 {
                        (-0.5 + w * one) as i32
                    } else {
                        (0.5 + w * one) as i32
                    }
                })
                .collect();
            (xmin, fixed)
        })
        .collect();
    let mut out = vec![0u8; lines * len_out * 3];
    for o in 0..lines {
        for c in 0..3 {
            for (xx, (xmin, weights)) in taps.iter().enumerate() {
                let mut acc: i32 = 1 << (PRECISION_BITS - 1);
                for (k, &w) in weights.iter().enumerate() {
                    acc += src[sample_index(o, xmin + k, len_in, lines, rows) * 3 + c] as i32 * w;
                }
                out[sample_index(o, xx, len_out, lines, rows) * 3 + c] =
                    (acc >> PRECISION_BITS).clamp(0, 255) as u8;
            }
        }
    }
    out
}

/// Resizes sRGB 8-bit RGB like PIL's `Image.resize(..., BILINEAR)`: the
/// horizontal pass to 8 bits, then the vertical one.
fn resize_rgb8(src: &[u8], w: usize, h: usize, ow: usize, oh: usize) -> Vec<u8> {
    let horizontal = if ow != w {
        resample_axis_rgb8(src, w, ow, h, true)
    } else {
        src.to_vec()
    };
    if oh != h {
        resample_axis_rgb8(&horizontal, h, oh, ow, false)
    } else {
        horizontal
    }
}

fn srgb_linear(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        libm::powf((v + 0.055) / 1.055, 2.4)
    }
}

fn lab_f(t: f32) -> f32 {
    if t > 0.008856 {
        libm::cbrtf(t)
    } else {
        7.787 * t + 16.0 / 116.0
    }
}

/// CIE Lab (D65) `L` of linear RGB.
fn lightness_of_linear(r: f32, g: f32, b: f32) -> f32 {
    116.0 * lab_f(0.2126 * r + 0.7152 * g + 0.0722 * b) - 16.0
}

/// CIE Lab (D65) `L` of sRGB 0..=1.
fn lab_lightness(rgb: [f32; 3]) -> f32 {
    lightness_of_linear(
        srgb_linear(rgb[0]),
        srgb_linear(rgb[1]),
        srgb_linear(rgb[2]),
    )
}

/// `L / 100` of every pixel of sRGB 8-bit RGB (the guided filter's guide).
fn lightness_plane(rgb: &[u8]) -> Vec<f32> {
    let linear: Vec<f32> = (0..=255u8).map(|v| srgb_linear(v as f32 / 255.0)).collect();
    rgb.chunks_exact(3)
        .map(|c| {
            let [r, g, b] = [c[0], c[1], c[2]].map(|v| linear[v as usize]);
            lightness_of_linear(r, g, b) / 100.0
        })
        .collect()
}

/// Mean over a `(2r+1)^2` window, indices clamped to the edge (separable
/// running sums in `f64`).
fn box_mean(p: &Plane, r: usize) -> Plane {
    let (w, h) = (p.w, p.h);
    let k = (2 * r + 1) as f64;
    let ri = r as isize;
    let clamp = |i: isize, n: usize| i.clamp(0, n as isize - 1) as usize;
    let mut tmp = vec![0.0f64; w * h];
    for y in 0..h {
        let row = &p.v[y * w..(y + 1) * w];
        let mut s: f64 = (-ri..=ri).map(|t| row[clamp(t, w)] as f64).sum();
        for x in 0..w {
            tmp[y * w + x] = s;
            s += row[clamp(x as isize + ri + 1, w)] as f64 - row[clamp(x as isize - ri, w)] as f64;
        }
    }
    let mut out = Plane::new(w, h);
    for x in 0..w {
        let mut s: f64 = (-ri..=ri).map(|t| tmp[clamp(t, h) * w + x]).sum();
        for y in 0..h {
            out.v[y * w + x] = (s / (k * k)) as f32;
            s +=
                tmp[clamp(y as isize + ri + 1, h) * w + x] - tmp[clamp(y as isize - ri, h) * w + x];
        }
    }
    out
}

/// He et al.'s guided filter with a grey guide.
fn guided_filter(guide: &Plane, src: &Plane, r: usize, eps: f32) -> Plane {
    let mul = |a: &Plane, b: &Plane| Plane {
        w: a.w,
        h: a.h,
        v: a.v.iter().zip(&b.v).map(|(x, y)| x * y).collect(),
    };
    let mean_i = box_mean(guide, r);
    let mean_p = box_mean(src, r);
    let corr_ip = box_mean(&mul(guide, src), r);
    let corr_ii = box_mean(&mul(guide, guide), r);
    let n = guide.v.len();
    let mut a = Plane::new(guide.w, guide.h);
    let mut b = Plane::new(guide.w, guide.h);
    for i in 0..n {
        let cov = corr_ip.v[i] - mean_i.v[i] * mean_p.v[i];
        let var = corr_ii.v[i] - mean_i.v[i] * mean_i.v[i];
        a.v[i] = cov / (var + eps);
        b.v[i] = mean_p.v[i] - a.v[i] * mean_i.v[i];
    }
    let (ma, mb) = (box_mean(&a, r), box_mean(&b, r));
    Plane {
        w: guide.w,
        h: guide.h,
        v: (0..n).map(|i| ma.v[i] * guide.v[i] + mb.v[i]).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A header and weights for a U-Net of `widths` (`rgb`, long 64): every
    /// weight a small hashed value, except that the stem keeps `b - r` and
    /// `r - b` (after ReLU) in its first two channels, `dec1` passes them on
    /// from the skip, and the head reads `gain * (b - r) + bias`. So the sky
    /// is where the photo is bluer than red.
    fn blue_model(widths: &[usize], gain: f32, bias: f32) -> (String, Vec<u8>) {
        let mut values: Vec<f32> = Vec::new();
        let mut layers = Vec::new();
        let mut state = 0x2545_f491u32;
        let mut noise = || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state % 2001) as f32 / 100_000.0 - 0.01
        };
        for (name, cin, cout, stride, relu) in expected_layers(3, widths) {
            let start = values.len();
            let mut w: Vec<f32> = (0..cout * cin * 9).map(|_| noise()).collect();
            let mut b: Vec<f32> = (0..cout).map(|_| noise()).collect();
            let center = |o: usize, i: usize| (o * cin + i) * 9 + 4;
            match name.as_str() {
                "stem.0" => {
                    for o in 0..2 {
                        for i in 0..cin {
                            w[center(o, i)] = 0.0;
                        }
                        b[o] = 0.0;
                    }
                    w[center(0, 2)] = 1.0;
                    w[center(0, 0)] = -1.0;
                    w[center(1, 0)] = 1.0;
                    w[center(1, 2)] = -1.0;
                }
                "stem.1" => {
                    w[center(0, 0)] = 1.0;
                    w[center(1, 1)] = 1.0;
                }
                "dec1" => {
                    let skip = cin - widths[0];
                    w[center(0, skip)] = 1.0;
                    w[center(1, skip + 1)] = 1.0;
                }
                "head" => {
                    w[center(0, 0)] = gain;
                    w[center(0, 1)] = -gain;
                    b[0] = bias;
                }
                _ => {}
            }
            values.extend(&w);
            values.extend(&b);
            layers.push(serde_json::json!({
                "name": name, "in": cin, "out": cout, "stride": stride, "relu": relu,
                "weights": start, "bias": start + w.len(),
            }));
        }
        let layout = serde_json::json!({
            "long": 64, "inputs": "rgb", "channels": widths, "floats": values.len(),
            "layers": layers,
        });
        let bytes = values.iter().flat_map(|v| v.to_le_bytes()).collect();
        (layout.to_string(), bytes)
    }

    fn blue(widths: &[usize], gain: f32, bias: f32) -> SkyModel {
        let (layout, weights) = blue_model(widths, gain, bias);
        SkyModel::parse(&layout, &weights).unwrap()
    }

    /// The top 40% a smooth blue sky, below it brown ground.
    fn sky_photo(w: usize, h: usize) -> Vec<u8> {
        (0..w * h)
            .flat_map(|i| {
                let y = i / w;
                if y * 10 < h * 4 {
                    [110, 160, (235 - y / 4) as u8]
                } else {
                    [120 + (i % 7) as u8, 90, 60]
                }
            })
            .collect()
    }

    fn mean_rows(surface: &SkySurface, rows: std::ops::Range<usize>) -> f64 {
        let w = surface.width as usize;
        let values = &surface.data[rows.start * w..rows.end * w];
        values.iter().map(|&v| v as f64).sum::<f64>() / values.len() as f64
    }

    #[test]
    fn the_header_gives_the_size_and_the_layers() {
        let model = blue(&[4, 6, 8, 8], 12.0, 0.0);
        assert_eq!(model.long_side(), 64);
        assert_eq!(model.inputs(), SkyInputs::Rgb);
        assert_eq!(model.widths(), &[4, 6, 8, 8]);
        // Multiples of 32 for 4 levels, rounded half to even.
        assert_eq!(model.input_size(1024, 683), (64, 32));
        assert_eq!(model.input_size(683, 1024), (32, 64));
        assert_eq!(model.input_size(1024, 1024), (64, 64));
        assert_eq!(model.input_size(10, 1), (64, 32));
        // Another depth reads the same way (multiples of 2^(levels + 1)).
        let shallow = blue(&[4, 4], 12.0, 0.0);
        assert_eq!(shallow.input_size(1024, 683), (64, 40));
    }

    #[test]
    fn headers_that_are_not_this_u_net_are_errors() {
        let (layout, weights) = blue_model(&[4, 4, 4, 4], 12.0, 0.0);
        let original: Value = serde_json::from_str(&layout).unwrap();
        let parse = |v: &Value, w: &[u8]| SkyModel::parse(&v.to_string(), w);
        assert!(parse(&original, &weights).is_ok());
        assert!(SkyModel::parse("{", &weights).is_err());
        assert!(parse(&original, &weights[..weights.len() - 4]).is_err());
        let mut nan = weights.clone();
        nan[0..4].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(parse(&original, &nan).is_err());
        let changed = |path: &[&str], value: Value| {
            let mut v = original.clone();
            let mut at = &mut v;
            for key in path {
                at = match key.parse::<usize>() {
                    Ok(i) => &mut at[i],
                    Err(_) => &mut at[*key],
                };
            }
            *at = value;
            parse(&v, &weights)
        };
        assert!(changed(&["inputs"], "rgbd".into()).is_err());
        assert!(changed(&["layers", "3", "stride"], 2.into()).is_err());
        assert!(changed(&["layers", "14", "name"], "tail".into()).is_err());
        assert!(changed(&["layers", "0", "bias"], (weights.len() / 4).into()).is_err());
        assert!(changed(&["channels"], serde_json::json!([4, 4, 4])).is_err());
        assert!(changed(&["long"], 16.into()).is_err());
    }

    /// "上が青・下が茶色": the sky above, none below, at the photo's size.
    #[test]
    fn a_blue_top_over_brown_ground_is_sky_above_and_not_below() {
        let (w, h) = (300, 200);
        let model = blue(&[4, 6, 8, 8], 12.0, 0.0);
        let surface = estimate_sky(&model, &sky_photo(w, h), w, h, None).expect("sky");
        assert_eq!((surface.width, surface.height), (300, 200));
        let (top, bottom) = (mean_rows(&surface, 0..60), mean_rows(&surface, 100..200));
        assert!(top > 230.0, "top {top}");
        assert!(bottom < 25.0, "bottom {bottom}");
    }

    #[test]
    fn a_model_that_sees_no_sky_gives_none() {
        let (w, h) = (96, 64);
        let photo = sky_photo(w, h);
        let none = blue(&[4, 4, 4, 4], 0.0, -8.0);
        assert_eq!(estimate_sky(&none, &photo, w, h, None), None);
        assert!(!predict(&none, &photo, w, h, None).unwrap().has_sky());
        let all = blue(&[4, 4, 4, 4], 0.0, 8.0);
        let surface = estimate_sky(&all, &photo, w, h, None).unwrap();
        assert!(surface.data.iter().all(|&v| v == 255));
    }

    #[test]
    fn an_rgb_model_does_not_read_the_exposure() {
        let (w, h) = (130, 97);
        let model = blue(&[4, 6, 8, 8], 12.0, 0.0);
        let photo = sky_photo(w, h);
        let unknown = predict(&model, &photo, w, h, None).unwrap();
        assert_eq!(predict(&model, &photo, w, h, Some(13.0)), Some(unknown));
    }

    #[test]
    fn tiny_and_invalid_inputs_do_not_panic() {
        let model = blue(&[4, 4, 4, 4], 12.0, 0.0);
        assert_eq!(predict(&model, &[], 0, 0, None), None);
        assert_eq!(predict(&model, &[1, 2], 1, 1, None), None);
        let one = predict(&model, &[100, 150, 230], 1, 1, None).unwrap();
        assert_eq!((one.width, one.height, one.data.len()), (1, 1, 1));
    }

    /// PIL's 8-bit resample: 4 -> 2 samples of a step (weights 3/7, 3/7,
    /// 1/7 in 22-bit fixed point), and a flat colour stays flat.
    #[test]
    fn the_8_bit_resample_is_pils() {
        let row: Vec<u8> = [0u8, 255, 255, 0].iter().flat_map(|&v| [v, v, v]).collect();
        assert_eq!(resize_rgb8(&row, 4, 1, 2, 1), vec![146; 6]);
        let flat: Vec<u8> = [17u8, 130, 240].repeat(35);
        assert_eq!(resize_rgb8(&flat, 7, 5, 3, 2), [17u8, 130, 240].repeat(6));
    }

    /// PyTorch's `align_corners=False` 2x upsampling: the edge samples kept,
    /// the rest 1/4 and 3/4 between neighbours.
    #[test]
    fn the_decoders_upsample_with_half_pixel_centres() {
        let axis = bilinear_axis(3, 6);
        assert_eq!(axis[0], (0, 1, 1.0, 0.0));
        assert_eq!(axis[1], (0, 1, 0.75, 0.25));
        assert_eq!(axis[2], (0, 1, 0.25, 0.75));
        assert_eq!(axis[5], (2, 2, 0.75, 0.25));
    }

    /// The pieces, the cross erosion and dilation and the distance agree
    /// with direct definitions on a scattered mask.
    #[test]
    fn the_morphology_matches_its_definitions() {
        let (w, h) = (23, 17);
        let mut state = 0x9e37_79b9u32;
        let mask: Vec<bool> = (0..w * h)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state % 5 < 2
            })
            .collect();
        let at = |x: isize, y: isize| {
            x >= 0
                && y >= 0
                && (x as usize) < w
                && (y as usize) < h
                && mask[y as usize * w + x as usize]
        };
        let cross = [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)];
        let eroded = erode(&mask, w, h, 1);
        let dilated = dilate(&mask, w, h, 1);
        for i in 0..w * h {
            let (x, y) = ((i % w) as isize, (i / w) as isize);
            assert_eq!(eroded[i], cross.iter().all(|&(dx, dy)| at(x + dx, y + dy)));
            assert_eq!(dilated[i], cross.iter().any(|&(dx, dy)| at(x + dx, y + dy)));
        }
        let distance = distance_to(&mask, w, h);
        for (i, &got) in distance.iter().enumerate() {
            let (x, y) = ((i % w) as f64, (i / w) as f64);
            let direct = (0..w * h)
                .filter(|&j| mask[j])
                .map(|j| ((j % w) as f64 - x).hypot((j / w) as f64 - y))
                .fold(f64::INFINITY, f64::min);
            assert!((got - direct).abs() < 1e-9, "{i}: {got} vs {direct}");
        }
        for diagonal in [false, true] {
            let (pieces, count) = label(&mask, w, h, diagonal);
            for i in 0..w * h {
                assert_eq!(pieces[i] != 0, mask[i]);
                let (x, y) = (i % w, i / w);
                for (dx, dy) in [(1usize, 0usize), (0, 1)] {
                    let j = (y + dy) * w + x + dx;
                    if x + dx < w && y + dy < h && mask[i] && mask[j] {
                        assert_eq!(pieces[i], pieces[j]);
                    }
                }
                if diagonal && x + 1 < w && y + 1 < h && mask[i] && mask[i + w + 1] {
                    assert_eq!(pieces[i], pieces[i + w + 1]);
                }
            }
            assert_eq!(*pieces.iter().max().unwrap() as usize, count);
        }
    }

    /// Weaker sky joined to sure sky becomes sure, weaker sky on its own does
    /// not, and a speck of sure sky under 0.1 % of the photo goes.
    #[test]
    fn refine_joins_weak_sky_and_drops_specks() {
        let (w, h) = (64, 64);
        let rgb = vec![0u8; w * h * 3];
        let mut p = vec![0.0f32; w * h];
        for y in 0..10 {
            for x in 0..10 {
                p[y * w + x] = 0.9;
                p[y * w + x + 10] = 0.2;
                p[(y + 30) * w + x + 30] = 0.3;
            }
        }
        p[50 * w + 5] = 0.8;
        p[50 * w + 6] = 0.8;
        refine(&rgb, w, h, &mut p);
        assert_eq!(p[5 * w + 5], 0.9);
        assert_eq!(p[5 * w + 15], SURE);
        assert_eq!(p[35 * w + 35], 0.3);
        assert_eq!(p[50 * w + 5], 0.0);
        let surface = surface_of(w, h, &p).unwrap();
        assert_eq!(surface.data[5 * w + 15], 128);
        assert_eq!(surface.data[50 * w + 5], 0);
    }

    /// A sky band over a textured tree: a slit and a square gap of the sky's
    /// colour close to it are added, nothing else is.
    #[test]
    fn fill_adds_sky_coloured_gaps_beside_the_sky() {
        let (w, h) = (300, 200);
        let mut state = 0x1234_5678u32;
        let mut rgb = vec![0u8; w * h * 3];
        for i in 0..w * h {
            let pixel = if i / w < 60 {
                [120, 170, 230]
            } else {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                let t = 20 + (state % 100) as u8;
                [40, t, 30]
            };
            rgb[i * 3..i * 3 + 3].copy_from_slice(&pixel);
        }
        let mut expected = vec![false; w * h];
        for i in 0..w * h {
            let (x, y) = (i % w, i / w);
            let gap = (70..80).contains(&y) && (100..110).contains(&x);
            let slit = (70..85).contains(&y) && x == 200;
            if gap || slit {
                rgb[i * 3..i * 3 + 3].copy_from_slice(&[120, 170, 230]);
            }
            expected[i] = y < 60 || gap || slit;
        }
        let sky: Vec<bool> = (0..w * h).map(|i| i / w < 60).collect();
        assert_eq!(fill(&rgb, &sky, w, h), Some(expected));
    }
}
