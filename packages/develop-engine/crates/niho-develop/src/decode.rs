//! Inputs of stage 2.
//!
//! (a) JPEG / PNG originals: decoded in the crate, EXIF orientation applied
//!     to the pixels, the embedded ICC profile (v2/v4 matrix/TRC, or a
//!     LUT-based A2B profile, `icc_lut`) converted to Photo Bench's
//!     working space (extended linear sRGB, the DNG SDK matrices); no
//!     profile means sRGB. Reduced to the processing size in linear light
//!     while decoding rows.
//! (b) Working copies (S4): 16-bit PNG, gamma 1.8 with a 2.0 ceiling, linear
//!     ProPhoto after Stage H and before exposure, plus their metadata.

use crate::color::{mat_mul, mat_vec_f32, to_f32, Mat3, SRGB_TO_XYZ_D50, XYZ_D50_TO_SRGB};
use crate::icc_lut::LutProfile;
use crate::resize::{fitted_size, resample_rows, Filter};
use crate::wb_table::WhiteBalanceTable;
use image::{DynamicImage, ImageDecoder, ImageFormat};
use serde_json::Value;
use std::fmt;
use std::io::Cursor;

/// Match the supported direct-photo pixel bound used by the browser renderer
/// ([`DecodeLimits::BROWSER`]).
pub const MAX_DECODE_IMAGE_PIXELS: u64 = 40_000_000;
const MAX_DECODE_ALLOCATION_BYTES: u64 = 512 * 1024 * 1024;
/// The native full-size export's bound ([`DecodeLimits::NATIVE`], 100 MP:
/// 45 MP and 61 MP sensors with room; niho-photo#132). The native renderer
/// reports it (`niho-develop-render capabilities`).
pub const MAX_NATIVE_DECODE_IMAGE_PIXELS: u64 = 100_000_000;
/// A 16-bit RGBA PNG of [`MAX_NATIVE_DECODE_IMAGE_PIXELS`] (800 MB) with room.
const MAX_NATIVE_DECODE_ALLOCATION_BYTES: u64 = 1024 * 1024 * 1024;

/// How large a source (JPEG / PNG original, working copy) a decode accepts,
/// read from the header before a decoder allocates pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodeLimits {
    /// Most pixels (width x height) of the source.
    pub max_pixels: u64,
    /// Most bytes one decoder may allocate.
    pub max_alloc_bytes: u64,
}

impl DecodeLimits {
    /// The browser's wasm and every caller that does not choose (40 MP).
    pub const BROWSER: Self = Self {
        max_pixels: MAX_DECODE_IMAGE_PIXELS,
        max_alloc_bytes: MAX_DECODE_ALLOCATION_BYTES,
    };
    /// The native full-size export (`niho-develop-render`, 100 MP).
    pub const NATIVE: Self = Self {
        max_pixels: MAX_NATIVE_DECODE_IMAGE_PIXELS,
        max_alloc_bytes: MAX_NATIVE_DECODE_ALLOCATION_BYTES,
    };
}

/// Working-copy encoding (spec: 16-bit PNG, gamma 1.8, ceiling 2.0).
pub const WORKING_COPY_GAMMA: f64 = 1.8;
pub const WORKING_COPY_MAX: f64 = 2.0;
pub const SIGNED_WORKING_COPY_KIND: &str = "signed-gamma18-v1";

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WorkingCopyEncoding {
    SignedGamma18V1 { ceiling: f64 },
}

impl WorkingCopyEncoding {
    pub fn ceiling(self) -> f64 {
        match self {
            Self::SignedGamma18V1 { ceiling } => ceiling,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignedWorkingCopyEncodeError {
    InvalidDimensions,
    InvalidLength { expected: usize, actual: usize },
    NonFiniteInput(usize),
    OutOfRangeInput(usize),
    Png(String),
}

impl fmt::Display for SignedWorkingCopyEncodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDimensions => write!(f, "invalid image dimensions"),
            Self::InvalidLength { expected, actual } => {
                write!(f, "invalid RGB length: expected {expected}, got {actual}")
            }
            Self::NonFiniteInput(index) => write!(f, "non-finite RGB sample at {index}"),
            Self::OutOfRangeInput(index) => {
                write!(f, "RGB sample at {index} exceeds signed ceiling 65536")
            }
            Self::Png(message) => write!(f, "PNG encode failed: {message}"),
        }
    }
}

impl std::error::Error for SignedWorkingCopyEncodeError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    /// Not a JPEG / PNG, or corrupt (`decode_failed`).
    DecodeFailed(String),
    /// An ICC profile that cannot be converted (`unsupported_profile`).
    UnsupportedProfile(String),
    /// Working-copy metadata missing or malformed.
    InvalidMetadata(String),
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DecodeError::DecodeFailed(m) => write!(f, "decode_failed: {m}"),
            DecodeError::UnsupportedProfile(m) => write!(f, "unsupported_profile: {m}"),
            DecodeError::InvalidMetadata(m) => write!(f, "invalid_metadata: {m}"),
        }
    }
}

impl std::error::Error for DecodeError {}

/// Reject oversized images from header dimensions before a decoder can allocate pixels.
fn set_decode_limits(
    decoder: &mut impl ImageDecoder,
    bounds: DecodeLimits,
) -> Result<(), DecodeError> {
    let (width, height) = decoder.dimensions();
    let pixel_count = u64::from(width) * u64::from(height);
    if width == 0 || height == 0 || pixel_count > bounds.max_pixels {
        return Err(DecodeError::DecodeFailed(format!(
            "image exceeds decode limit (maximum {} pixels)",
            bounds.max_pixels
        )));
    }

    let mut limits = image::Limits::default();
    limits.max_image_width = Some(bounds.max_pixels as u32);
    limits.max_image_height = Some(bounds.max_pixels as u32);
    limits.max_alloc = Some(bounds.max_alloc_bytes);
    decoder
        .set_limits(limits)
        .map_err(|e| DecodeError::DecodeFailed(e.to_string()))
}

/// Interleaved RGB `f32`.
#[derive(Debug, Clone)]
pub struct LinearImage {
    pub width: usize,
    pub height: usize,
    pub data: Vec<f32>,
}

/// How the original's colors were interpreted.
#[derive(Debug, Clone, PartialEq)]
pub enum ColorSource {
    /// No profile (or an sRGB one): the sRGB EOTF.
    Srgb { tagged: bool },
    /// Matrix/TRC profile converted to the working space.
    IccMatrixShaper,
    /// LUT-based profile (A2B lutAtoB / lut16 / lut8), `icc_lut`.
    IccLut,
}

#[derive(Debug, Clone)]
pub struct RasterInfo {
    pub format: &'static str,
    pub source_width: usize,
    pub source_height: usize,
    pub orientation_applied: bool,
    pub color: ColorSource,
}

impl RasterInfo {
    /// Photo Bench `DecodeInfo.isBoundedSRGBRaster`.
    pub fn is_bounded_srgb(&self) -> bool {
        matches!(self.color, ColorSource::Srgb { .. })
    }
}

/// A decoded original in extended linear sRGB at the processing size.
#[derive(Debug, Clone)]
pub struct Raster {
    pub image: LinearImage,
    pub info: RasterInfo,
}

pub(crate) enum Trc {
    Srgb,
    Gamma(f64),
    Parametric(Vec<f64>),
    Table(Vec<u16>),
}

impl Trc {
    pub(crate) fn eval(&self, v: f64) -> f64 {
        let v = v.clamp(0.0, 1.0);
        match self {
            Trc::Srgb => crate::color::srgb_eotf(v),
            Trc::Gamma(g) => libm::pow(v, *g),
            Trc::Parametric(p) => parametric_curve(p, v),
            Trc::Table(t) => {
                if t.is_empty() {
                    return v;
                }
                if t.len() == 1 {
                    return libm::pow(v, t[0] as f64 / 256.0);
                }
                let pos = v * (t.len() - 1) as f64;
                let i = (libm::floor(pos) as usize).min(t.len() - 2);
                let f = pos - i as f64;
                (t[i] as f64 * (1.0 - f) + t[i + 1] as f64 * f) / 65535.0
            }
        }
    }
}

/// ICC `parametricCurveType` functions 0..4.
fn parametric_curve(p: &[f64], x: f64) -> f64 {
    match p.len() {
        1 => libm::pow(x, p[0]),
        3 => {
            let (g, a, b) = (p[0], p[1], p[2]);
            if x >= -b / a {
                libm::pow(a * x + b, g)
            } else {
                0.0
            }
        }
        4 => {
            let (g, a, b, c) = (p[0], p[1], p[2], p[3]);
            if x >= -b / a {
                libm::pow(a * x + b, g) + c
            } else {
                c
            }
        }
        5 => {
            let (g, a, b, c, d) = (p[0], p[1], p[2], p[3], p[4]);
            if x >= d {
                libm::pow(a * x + b, g)
            } else {
                c * x
            }
        }
        7 => {
            let (g, a, b, c, d, e, f) = (p[0], p[1], p[2], p[3], p[4], p[5], p[6]);
            if x >= d {
                libm::pow(a * x + b, g) + e
            } else {
                c * x + f
            }
        }
        _ => x,
    }
}

enum Decoding {
    /// Per channel: the TRC while reading rows.
    Shaper([Trc; 3]),
    /// Device RGB -> PCS XYZ (D50) while reading rows (a CLUT is not
    /// separable, so it runs before the reduction).
    Lut(Box<LutProfile>),
}

struct ColorConversion {
    decoding: Decoding,
    /// Linear -> extended linear sRGB after the reduction; `None` = identity.
    matrix: Option<Mat3>,
    color: ColorSource,
}

pub(crate) fn trc_from(curve: &Option<moxcms::ToneReprCurve>) -> Option<Trc> {
    match curve.as_ref()? {
        moxcms::ToneReprCurve::Lut(t) => Some(if t.is_empty() {
            Trc::Gamma(1.0)
        } else {
            Trc::Table(t.clone())
        }),
        moxcms::ToneReprCurve::Parametric(p) => {
            Some(Trc::Parametric(p.iter().map(|v| *v as f64).collect()))
        }
    }
}

fn is_srgb_like(colorants: &Mat3, trc: &[Trc; 3]) -> bool {
    let close = colorants
        .iter()
        .flatten()
        .zip(SRGB_TO_XYZ_D50.iter().flatten())
        .all(|(a, b)| (a - b).abs() < 2e-3);
    let curve_close = trc.iter().all(|t| {
        (1..=16).all(|i| {
            let v = i as f64 / 16.0;
            (t.eval(v) - crate::color::srgb_eotf(v)).abs() < 2e-3
        })
    });
    close && curve_close
}

fn conversion_for(icc: Option<&[u8]>) -> Result<ColorConversion, DecodeError> {
    let srgb = |tagged| ColorConversion {
        decoding: Decoding::Shaper([Trc::Srgb, Trc::Srgb, Trc::Srgb]),
        matrix: None,
        color: ColorSource::Srgb { tagged },
    };
    let Some(bytes) = icc else {
        return Ok(srgb(false));
    };
    let profile = moxcms::ColorProfile::new_from_slice(bytes)
        .map_err(|e| DecodeError::UnsupportedProfile(format!("ICC profile unreadable: {e:?}")))?;
    if profile.color_space == moxcms::DataColorSpace::Gray {
        let trc = trc_from(&profile.gray_trc).unwrap_or(Trc::Srgb);
        let t2 = trc_from(&profile.gray_trc).unwrap_or(Trc::Srgb);
        let t3 = trc_from(&profile.gray_trc).unwrap_or(Trc::Srgb);
        return Ok(ColorConversion {
            decoding: Decoding::Shaper([trc, t2, t3]),
            matrix: None,
            color: ColorSource::IccMatrixShaper,
        });
    }
    if profile.color_space != moxcms::DataColorSpace::Rgb {
        // The decoders hand over RGB (a CMYK JPEG is already inverted to
        // RGB without its profile), so only RGB and gray profiles apply.
        return Err(DecodeError::UnsupportedProfile(format!(
            "{:?} profiles are not supported (RGB / gray only)",
            profile.color_space
        )));
    }
    if !profile.is_matrix_shaper() {
        // Matrix/TRC wins when a profile has both (the exact TRC path).
        let lut = LutProfile::new(&profile)
            .map_err(|e| DecodeError::UnsupportedProfile(format!("ICC LUT profile: {e}")))?;
        return Ok(ColorConversion {
            decoding: Decoding::Lut(Box::new(lut)),
            matrix: Some(XYZ_D50_TO_SRGB),
            color: ColorSource::IccLut,
        });
    }
    let (Some(r), Some(g), Some(b)) = (
        trc_from(&profile.red_trc),
        trc_from(&profile.green_trc),
        trc_from(&profile.blue_trc),
    ) else {
        return Err(DecodeError::UnsupportedProfile("missing TRC".into()));
    };
    let colorants: Mat3 = profile.colorant_matrix().v;
    let trc = [r, g, b];
    if is_srgb_like(&colorants, &trc) {
        return Ok(srgb(true));
    }
    Ok(ColorConversion {
        decoding: Decoding::Shaper(trc),
        matrix: Some(mat_mul(&XYZ_D50_TO_SRGB, &colorants)),
        color: ColorSource::IccMatrixShaper,
    })
}

/// Decodes a JPEG / PNG original into extended linear sRGB, applying EXIF
/// orientation and reducing to at most `max_dimension` on the long edge
/// (0 = original size) with `filter` in linear light.
pub fn decode_raster(
    bytes: &[u8],
    max_dimension: usize,
    filter: Filter,
) -> Result<Raster, DecodeError> {
    decode_raster_with_limits(bytes, max_dimension, filter, DecodeLimits::BROWSER)
}

/// [`decode_raster`] with the source bound `limits` (the native full-size
/// export reads up to [`DecodeLimits::NATIVE`]).
pub fn decode_raster_with_limits(
    bytes: &[u8],
    max_dimension: usize,
    filter: Filter,
    limits: DecodeLimits,
) -> Result<Raster, DecodeError> {
    let format =
        image::guess_format(bytes).map_err(|e| DecodeError::DecodeFailed(e.to_string()))?;
    let mut jpeg_size = (0, 0);
    let (dynamic, icc, orientation, format_name) = match format {
        ImageFormat::Jpeg => {
            let mut decoder = image::codecs::jpeg::JpegDecoder::new(Cursor::new(bytes))
                .map_err(|e| DecodeError::DecodeFailed(e.to_string()))?;
            set_decode_limits(&mut decoder, limits)?;
            let icc = decoder.icc_profile().ok().flatten();
            let orientation = decoder
                .orientation()
                .unwrap_or(image::metadata::Orientation::NoTransforms);
            let (width, height) = decoder.dimensions();
            jpeg_size = (width as usize, height as usize);
            let img = match scaled_jpeg(bytes, width, height, max_dimension, limits) {
                Some(img) => img,
                None => DynamicImage::from_decoder(decoder)
                    .map_err(|e| DecodeError::DecodeFailed(e.to_string()))?,
            };
            (img, icc, orientation, "jpeg")
        }
        ImageFormat::Png => {
            let mut decoder = image::codecs::png::PngDecoder::new(Cursor::new(bytes))
                .map_err(|e| DecodeError::DecodeFailed(e.to_string()))?;
            set_decode_limits(&mut decoder, limits)?;
            let icc = decoder.icc_profile().ok().flatten();
            let orientation = decoder
                .orientation()
                .unwrap_or(image::metadata::Orientation::NoTransforms);
            let img = DynamicImage::from_decoder(decoder)
                .map_err(|e| DecodeError::DecodeFailed(e.to_string()))?;
            (img, icc, orientation, "png")
        }
        other => {
            return Err(DecodeError::DecodeFailed(format!(
                "unsupported format {other:?} (JPEG / PNG only)"
            )))
        }
    };
    let conversion = conversion_for(icc.as_deref())?;
    let orientation_applied = orientation != image::metadata::Orientation::NoTransforms;
    let mut dynamic = dynamic;
    dynamic.apply_orientation(orientation);
    let (src_w, src_h) = (dynamic.width() as usize, dynamic.height() as usize);
    if src_w == 0 || src_h == 0 {
        return Err(DecodeError::DecodeFailed("empty image".into()));
    }
    // The original's size (a scaled JPEG decode is smaller): the output
    // size follows it, the reduction starts from the decoded pixels.
    let (full_w, full_h) = match (format_name, orientation_swaps(orientation)) {
        ("jpeg", false) => (jpeg_size.0, jpeg_size.1),
        ("jpeg", true) => (jpeg_size.1, jpeg_size.0),
        _ => (src_w, src_h),
    };
    let (out_w, out_h) = if max_dimension == 0 {
        (full_w, full_h)
    } else {
        fitted_size(full_w, full_h, max_dimension)
    };
    let data = match &dynamic {
        DynamicImage::ImageRgb16(_)
        | DynamicImage::ImageRgba16(_)
        | DynamicImage::ImageLuma16(_)
        | DynamicImage::ImageLumaA16(_) => {
            let rgb = dynamic.to_rgb16();
            let raw = rgb.as_raw();
            let read = row_reader(&conversion.decoding, 65535);
            to_linear(src_w, src_h, out_w, out_h, filter, |y, row| {
                read(&raw[y * src_w * 3..(y + 1) * src_w * 3], row)
            })
        }
        _ => {
            // Avoid a second full-size copy when the decoder already gave RGB8.
            let owned;
            let rgb = match &dynamic {
                DynamicImage::ImageRgb8(buffer) => buffer,
                other => {
                    owned = other.to_rgb8();
                    &owned
                }
            };
            let raw = rgb.as_raw();
            let read = row_reader(&conversion.decoding, 255);
            to_linear(src_w, src_h, out_w, out_h, filter, |y, row| {
                read(&raw[y * src_w * 3..(y + 1) * src_w * 3], row)
            })
        }
    };
    let mut data = data;
    if let Some(m) = conversion.matrix {
        let m = to_f32(&m);
        for px in data.chunks_exact_mut(3) {
            let v = mat_vec_f32(&m, [px[0], px[1], px[2]]);
            px.copy_from_slice(&v);
        }
    }
    Ok(Raster {
        image: LinearImage {
            width: out_w,
            height: out_h,
            data,
        },
        info: RasterInfo {
            format: format_name,
            source_width: full_w,
            source_height: full_h,
            orientation_applied,
            color: conversion.color,
        },
    })
}

type RowReader<'a, S> = Box<dyn Fn(&[S], &mut [f32]) + 'a>;

/// Turns one row of 8- or 16-bit samples (`max` = 255 / 65535) into
/// linear values: the TRC tables, or the LUT profile's input tables and the
/// rest of its conversion.
fn row_reader<S: Copy + Into<u32>>(decoding: &Decoding, max: u32) -> RowReader<'_, S> {
    match decoding {
        Decoding::Shaper(trc) => {
            let luts: Vec<Vec<f32>> = trc
                .iter()
                .map(|t| {
                    (0..=max)
                        .map(|i| t.eval(i as f64 / max as f64) as f32)
                        .collect()
                })
                .collect();
            Box::new(move |src, row| {
                for (d, (i, s)) in row.iter_mut().zip(src.iter().enumerate()) {
                    let s: u32 = (*s).into();
                    *d = luts[i % 3][s as usize];
                }
            })
        }
        Decoding::Lut(lut) => {
            let tables: Vec<Vec<f32>> = (0..3).map(|k| lut.input_table(k, max)).collect();
            Box::new(move |src, row| {
                for (d, s) in row.chunks_exact_mut(3).zip(src.chunks_exact(3)) {
                    let c = [0, 1, 2].map(|k| {
                        let s: u32 = s[k].into();
                        tables[k][s as usize]
                    });
                    d.copy_from_slice(&lut.to_xyz(c));
                }
            })
        }
    }
}

/// Whether `orientation` turns the image by a quarter.
fn orientation_swaps(orientation: image::metadata::Orientation) -> bool {
    use image::metadata::Orientation::*;
    matches!(
        orientation,
        Rotate90 | Rotate270 | Rotate90FlipH | Rotate270FlipH
    )
}

/// A JPEG much larger than the render, decoded with the IDCT scaled by 1/2,
/// 1/4 or 1/8 (jpeg-decoder): the largest reduction whose long edge stays
/// at least twice `max_dimension`, so the linear-light reduction after it
/// still does most of the work (6000px to 1280: 3000px, a quarter of the
/// pixels to hold; to 2560: no reduction). Only for 8-bit gray / YCbCr;
/// `None` (no such reduction, another format or anything jpeg-decoder
/// rejects) decodes at full size with zune-jpeg as before.
fn scaled_jpeg(
    bytes: &[u8],
    width: u32,
    height: u32,
    max_dimension: usize,
    limits: DecodeLimits,
) -> Option<DynamicImage> {
    if max_dimension == 0 {
        return None;
    }
    let long = width.max(height) as usize;
    let mut denominator = 1;
    while denominator < 8 && long.div_ceil(denominator * 2) >= 2 * max_dimension {
        denominator *= 2;
    }
    if denominator == 1 {
        return None;
    }
    let mut decoder = jpeg_decoder::Decoder::new(Cursor::new(bytes));
    decoder.set_max_decoding_buffer_size(limits.max_alloc_bytes as usize);
    decoder.read_info().ok()?;
    let info = decoder.info()?;
    if !matches!(
        info.pixel_format,
        jpeg_decoder::PixelFormat::RGB24 | jpeg_decoder::PixelFormat::L8
    ) {
        return None;
    }
    let request = |v: u32| u16::try_from(v.div_ceil(denominator as u32)).ok();
    let (w, h) = decoder.scale(request(width)?, request(height)?).ok()?;
    let pixels = decoder.decode().ok()?;
    let (w, h) = (w as u32, h as u32);
    match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => {
            image::RgbImage::from_raw(w, h, pixels).map(DynamicImage::ImageRgb8)
        }
        _ => image::GrayImage::from_raw(w, h, pixels).map(DynamicImage::ImageLuma8),
    }
}

fn to_linear(
    src_w: usize,
    src_h: usize,
    out_w: usize,
    out_h: usize,
    filter: Filter,
    mut row: impl FnMut(usize, &mut [f32]),
) -> Vec<f32> {
    if out_w == src_w && out_h == src_h {
        let mut data = vec![0.0f32; src_w * src_h * 3];
        for y in 0..src_h {
            row(y, &mut data[y * src_w * 3..(y + 1) * src_w * 3]);
        }
        return data;
    }
    resample_rows(src_w, src_h, out_w, out_h, filter, row)
}

/// White point recorded for a RAW working copy.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AsShotWhite {
    pub x: f64,
    pub y: f64,
    pub temperature: Option<f64>,
    pub tint: Option<f64>,
}

/// A white on Lightroom's scale: temperature (K) and tint, the units of an
/// absolute `whiteBalance` and of XMP `Temperature` / `Tint`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LightroomWhite {
    pub temperature: f64,
    pub tint: f64,
}

impl LightroomWhite {
    /// `Some` for a finite, positive temperature and a finite tint.
    pub fn new(temperature: f64, tint: f64) -> Option<Self> {
        (temperature.is_finite() && temperature > 0.0 && tint.is_finite())
            .then_some(Self { temperature, tint })
    }
}

impl AsShotWhite {
    /// Its temperature and tint, when both are recorded.
    pub fn lightroom(&self) -> Option<LightroomWhite> {
        LightroomWhite::new(self.temperature?, self.tint?)
    }
}

/// Working-copy metadata (spec "作業コピー"; union by source kind).
#[derive(Debug, Clone, PartialEq)]
pub enum WorkingCopyMeta {
    Raw {
        /// BaselineExposure + DCP BaselineExposureOffset.
        baseline_ev: f64,
        as_shot_white: AsShotWhite,
        /// The as-shot white as Adobe (Lightroom) reads it for this camera
        /// (`asShotWhiteAdobe`, written by the stage 1 tools from a
        /// per-model map; S9 #16999). When present, the absolute white
        /// balance starts from it, so a Lightroom K / tint lands where it
        /// does in Lightroom; otherwise from `as_shot_white`.
        as_shot_white_adobe: Option<AsShotWhite>,
        /// The camera model's white-balance matrix table
        /// (`whiteBalanceTable`, S11 #17108), carried when stage 1's
        /// self-check on this RAW passed: the absolute white balance then
        /// takes Apple's own matrix instead of approximating it.
        white_balance_table: Option<Box<WhiteBalanceTable>>,
        dcp_sha256: String,
        look_table_included: bool,
        /// Absent is the legacy unsigned 0..2 gamma-1.8 encoding.
        encoding: Option<WorkingCopyEncoding>,
    },
    Raster {
        /// `sRGB` when the original had no profile.
        icc_sha256: String,
    },
}

impl WorkingCopyMeta {
    pub fn encoding(&self) -> Option<WorkingCopyEncoding> {
        match self {
            Self::Raw { encoding, .. } => *encoding,
            Self::Raster { .. } => None,
        }
    }

    /// The as-shot white on Adobe's (Lightroom's) scale, the one place that
    /// chooses it: `asShotWhiteAdobe` when the working copy carries it, else
    /// `asShotWhite`. A RAW's absolute white balance adapts from it
    /// (`pipeline`), and a preset's amount interpolates from its
    /// temperature and tint ([`Self::lightroom_as_shot_white`]). `None` for
    /// a non-RAW working copy (no absolute white balance).
    pub fn adobe_as_shot_white(&self) -> Option<&AsShotWhite> {
        match self {
            WorkingCopyMeta::Raw {
                as_shot_white,
                as_shot_white_adobe,
                ..
            } => Some(as_shot_white_adobe.as_ref().unwrap_or(as_shot_white)),
            WorkingCopyMeta::Raster { .. } => None,
        }
    }

    /// [`Self::adobe_as_shot_white`]'s temperature and tint, when it records
    /// both (the start of a preset's absolute white at partial amounts,
    /// `xmp::apply_preset`).
    pub fn lightroom_as_shot_white(&self) -> Option<LightroomWhite> {
        self.adobe_as_shot_white().and_then(AsShotWhite::lightroom)
    }

    /// Reads `{"kind":"raw","baselineEV":..,"asShotWhite":{"x","y","temperature","tint"},
    /// "asShotWhiteAdobe":{"x","y",..}|null (optional),
    /// "whiteBalanceTable":{"schema":"niho-develop-wb-table/v1",..}|null (optional,
    /// see [`WhiteBalanceTable::from_meta`]),"dcpSha256":..,"lookTableIncluded":..}`
    /// or `{"kind":"raster","iccSha256":..}`.
    pub fn from_json(text: &str) -> Result<Self, DecodeError> {
        let v: Value =
            serde_json::from_str(text).map_err(|e| DecodeError::InvalidMetadata(e.to_string()))?;
        let kind = v["kind"].as_str().unwrap_or_default();
        let bad = |m: &str| DecodeError::InvalidMetadata(m.to_string());
        match kind {
            "raw" => {
                let baseline_ev = v["baselineEV"]
                    .as_f64()
                    .filter(|x| x.is_finite())
                    .ok_or_else(|| bad("baselineEV"))?;
                let white = |key: &str| -> Result<AsShotWhite, DecodeError> {
                    let w = &v[key];
                    let coordinate = |c: &str| {
                        w[c].as_f64()
                            .filter(|c| c.is_finite() && *c > 0.0)
                            .ok_or_else(|| bad(&format!("{key}.{c}")))
                    };
                    Ok(AsShotWhite {
                        x: coordinate("x")?,
                        y: coordinate("y")?,
                        temperature: w["temperature"].as_f64(),
                        tint: w["tint"].as_f64(),
                    })
                };
                let encoding = match v.get("encoding") {
                    None | Some(Value::Null) => None,
                    Some(value) => {
                        let object = value
                            .as_object()
                            .ok_or_else(|| bad("encoding must be an object"))?;
                        if object.get("kind").and_then(Value::as_str)
                            != Some(SIGNED_WORKING_COPY_KIND)
                        {
                            return Err(bad("encoding.kind must be signed-gamma18-v1"));
                        }
                        let ceiling = object
                            .get("ceiling")
                            .and_then(Value::as_f64)
                            .filter(|v| {
                                v.is_finite()
                                    && (1.0..=65536.0).contains(v)
                                    && *v == libm::trunc(*v)
                                    && (*v as u64).is_power_of_two()
                            })
                            .ok_or_else(|| {
                                bad("encoding.ceiling must be a finite power of two in 1..65536")
                            })?;
                        if object.keys().any(|key| key != "kind" && key != "ceiling") {
                            return Err(bad("encoding contains unknown fields"));
                        }
                        Some(WorkingCopyEncoding::SignedGamma18V1 { ceiling })
                    }
                };
                Ok(WorkingCopyMeta::Raw {
                    baseline_ev,
                    as_shot_white: white("asShotWhite")?,
                    as_shot_white_adobe: match &v["asShotWhiteAdobe"] {
                        Value::Null => None,
                        _ => Some(white("asShotWhiteAdobe")?),
                    },
                    white_balance_table: WhiteBalanceTable::from_meta(&v["whiteBalanceTable"])
                        .map_err(DecodeError::InvalidMetadata)?
                        .map(Box::new),
                    dcp_sha256: v["dcpSha256"].as_str().unwrap_or_default().to_string(),
                    look_table_included: v["lookTableIncluded"].as_bool().unwrap_or(false),
                    encoding,
                })
            }
            "raster" => {
                if v.get("encoding").is_some_and(|value| !value.is_null()) {
                    return Err(bad("encoding is only valid for raw working copies"));
                }
                Ok(WorkingCopyMeta::Raster {
                    icc_sha256: v["iccSha256"].as_str().unwrap_or("sRGB").to_string(),
                })
            }
            _ => Err(bad("kind must be raw or raster")),
        }
    }
}

/// Decodes a working copy into linear ProPhoto (values 0..2), reduced to
/// `max_dimension` (0 = as stored).
pub fn decode_working_copy(
    bytes: &[u8],
    max_dimension: usize,
    filter: Filter,
) -> Result<LinearImage, DecodeError> {
    decode_working_copy_with_limits(bytes, max_dimension, filter, DecodeLimits::BROWSER)
}

/// [`decode_working_copy`] with the source bound `limits`.
pub fn decode_working_copy_with_limits(
    bytes: &[u8],
    max_dimension: usize,
    filter: Filter,
    limits: DecodeLimits,
) -> Result<LinearImage, DecodeError> {
    let mut decoder = image::codecs::png::PngDecoder::new(Cursor::new(bytes))
        .map_err(|e| DecodeError::DecodeFailed(e.to_string()))?;
    set_decode_limits(&mut decoder, limits)?;
    let img = DynamicImage::from_decoder(decoder)
        .map_err(|e| DecodeError::DecodeFailed(e.to_string()))?;
    let rgb = match img {
        DynamicImage::ImageRgb16(i) => i,
        DynamicImage::ImageRgba16(_) => img.to_rgb16(),
        _ => {
            return Err(DecodeError::DecodeFailed(
                "working copy must be a 16-bit RGB PNG".into(),
            ))
        }
    };
    let (w, h) = (rgb.width() as usize, rgb.height() as usize);
    let lut: Vec<f32> = (0..65536)
        .map(|i| (WORKING_COPY_MAX * libm::pow(i as f64 / 65535.0, WORKING_COPY_GAMMA)) as f32)
        .collect();
    let (out_w, out_h) = if max_dimension == 0 {
        (w, h)
    } else {
        fitted_size(w, h, max_dimension)
    };
    let raw = rgb.as_raw();
    let data = to_linear(w, h, out_w, out_h, filter, |y, row| {
        for (d, s) in row.iter_mut().zip(raw[y * w * 3..(y + 1) * w * 3].iter()) {
            *d = lut[*s as usize];
        }
    });
    Ok(LinearImage {
        width: out_w,
        height: out_h,
        data,
    })
}

/// Metadata-aware working-copy decode. This is the unified session/one-shot
/// entry; [`decode_working_copy`] remains the legacy unsigned public API.
pub fn decode_working_copy_with_meta(
    bytes: &[u8],
    meta: &WorkingCopyMeta,
    max_dimension: usize,
    filter: Filter,
) -> Result<LinearImage, DecodeError> {
    decode_working_copy_with_meta_and_limits(
        bytes,
        meta,
        max_dimension,
        filter,
        DecodeLimits::BROWSER,
    )
}

/// [`decode_working_copy_with_meta`] with the source bound `limits`.
pub fn decode_working_copy_with_meta_and_limits(
    bytes: &[u8],
    meta: &WorkingCopyMeta,
    max_dimension: usize,
    filter: Filter,
    limits: DecodeLimits,
) -> Result<LinearImage, DecodeError> {
    let Some(WorkingCopyEncoding::SignedGamma18V1 { ceiling }) = meta.encoding() else {
        return decode_working_copy_with_limits(bytes, max_dimension, filter, limits);
    };
    let mut decoder = image::codecs::png::PngDecoder::new(Cursor::new(bytes))
        .map_err(|e| DecodeError::DecodeFailed(e.to_string()))?;
    set_decode_limits(&mut decoder, limits)?;
    let img = DynamicImage::from_decoder(decoder)
        .map_err(|e| DecodeError::DecodeFailed(e.to_string()))?;
    let rgb = match img {
        DynamicImage::ImageRgb16(i) => i,
        DynamicImage::ImageRgba16(_) => img.to_rgb16(),
        _ => {
            return Err(DecodeError::DecodeFailed(
                "working copy must be a 16-bit RGB PNG".into(),
            ))
        }
    };
    let (w, h) = (rgb.width() as usize, rgb.height() as usize);
    let lut: Vec<f32> = (0..65536)
        .map(|code| {
            let centered = (code as f64 - 32768.0) / 32767.0;
            (centered.signum() * libm::pow(centered.abs(), WORKING_COPY_GAMMA) * ceiling) as f32
        })
        .collect();
    let (out_w, out_h) = if max_dimension == 0 {
        (w, h)
    } else {
        fitted_size(w, h, max_dimension)
    };
    let raw = rgb.as_raw();
    let data = to_linear(w, h, out_w, out_h, filter, |y, row| {
        for (d, s) in row.iter_mut().zip(raw[y * w * 3..(y + 1) * w * 3].iter()) {
            *d = lut[*s as usize];
        }
    });
    Ok(LinearImage {
        width: out_w,
        height: out_h,
        data,
    })
}

/// Encodes linear ProPhoto as a working copy PNG (tests and tooling; the
/// production writer is the S4 worker).
pub fn encode_working_copy(image: &LinearImage) -> Vec<u8> {
    let data: Vec<u16> = image
        .data
        .iter()
        .map(|v| {
            let e = libm::pow(
                (*v as f64 / WORKING_COPY_MAX).clamp(0.0, 1.0),
                1.0 / WORKING_COPY_GAMMA,
            );
            libm::round(e * 65535.0) as u16
        })
        .collect();
    let buffer = image::ImageBuffer::<image::Rgb<u16>, Vec<u16>>::from_raw(
        image.width as u32,
        image.height as u32,
        data,
    )
    .expect("buffer size");
    let mut out = Vec::new();
    DynamicImage::ImageRgb16(buffer)
        .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
        .expect("png encode");
    out
}

/// Encodes the signed NIHO 3 working-copy representation and returns the
/// metadata value that must accompany it.
pub fn encode_signed_working_copy(
    image: &LinearImage,
) -> Result<(Vec<u8>, WorkingCopyEncoding), SignedWorkingCopyEncodeError> {
    if image.width == 0
        || image.height == 0
        || image.width > u32::MAX as usize
        || image.height > u32::MAX as usize
    {
        return Err(SignedWorkingCopyEncodeError::InvalidDimensions);
    }
    let expected = image
        .width
        .checked_mul(image.height)
        .and_then(|pixels| pixels.checked_mul(3))
        .ok_or(SignedWorkingCopyEncodeError::InvalidDimensions)?;
    if image.data.len() != expected {
        return Err(SignedWorkingCopyEncodeError::InvalidLength {
            expected,
            actual: image.data.len(),
        });
    }
    if let Some(index) = image.data.iter().position(|value| !value.is_finite()) {
        return Err(SignedWorkingCopyEncodeError::NonFiniteInput(index));
    }
    if let Some(index) = image.data.iter().position(|value| value.abs() > 65536.0) {
        return Err(SignedWorkingCopyEncodeError::OutOfRangeInput(index));
    }
    let max_abs = image
        .data
        .iter()
        .fold(1.0_f64, |m, v| m.max(f64::from(v.abs())));
    let ceiling = libm::pow(2.0, libm::ceil(libm::log2(max_abs)));
    let data: Vec<u16> = image
        .data
        .iter()
        .map(|value| {
            let normalized = f64::from(value.abs()) / ceiling;
            let magnitude = libm::pow(normalized, 1.0 / WORKING_COPY_GAMMA) * 32767.0;
            // e4 uses nearest-even after adding the signed midpoint, matching
            // the Swift producer and the frozen reference codec.
            (32768.0 + f64::from(value.signum()) * magnitude).round_ties_even() as u16
        })
        .collect();
    let buffer = image::ImageBuffer::<image::Rgb<u16>, Vec<u16>>::from_raw(
        image.width as u32,
        image.height as u32,
        data,
    )
    .ok_or(SignedWorkingCopyEncodeError::InvalidLength {
        expected,
        actual: image.data.len(),
    })?;
    let mut output = Vec::new();
    DynamicImage::ImageRgb16(buffer)
        .write_to(&mut Cursor::new(&mut output), ImageFormat::Png)
        .map_err(|error| SignedWorkingCopyEncodeError::Png(error.to_string()))?;
    Ok((output, WorkingCopyEncoding::SignedGamma18V1 { ceiling }))
}
