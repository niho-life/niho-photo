//! The response analysis as versioned bytes (#155). A helper worker makes
//! it (as [`super::prepare_analysis`] does) and gives the bytes to the
//! editor's session, which only copies them in: the editor's own worker is
//! not held by the analysis. The bytes are the analysis itself, so the
//! frames drawn from an analysis taken in are the bytes the session draws
//! making it (`tests/analysis_transfer.rs`).
//!
//! Version 3 (1 had no source fingerprint and is not read; 2 is still
//! accepted). Numbers are little-endian; `f32` and `f64` are their bits.
//!
//! | bytes | |
//! |---|---|
//! | 6 | `NIHOAN` |
//! | 2 | version (`u16`, 3) |
//! | 1 | camera: 0 Panasonic DC-S5, 1 Sony ZV-E10 II, 2 Sony FX30 |
//! | 8 | effective color noise reduction (`f64`) |
//! | 8 | luminance noise reduction (`f64`) |
//! | 8 | baseline exposure (`f64`) |
//! | 4 + 4 | source width, height (`u32`) |
//! | 8 | fingerprint of the source pixels (`u64`, [`source_fingerprint`]) |
//! | 1 | CNR source: 0 the source itself (both amounts 0), 2 filtered but omitted |
//! | 1 (+ …) | coefficients: 0 none, 1 then width, height (`u32`, the analysis size) and five maps of width · height `f32` (highlight a, b, alpha, shadow a, b) |
//! | 1 (+ …) | NIHO 7 highlight maps: 0 none, 1 residual (one map), 2 FX30 shoulder (a, b), 3 could not be made; the maps are of the coefficients' size |
//!
//! Nothing follows. Version 2 used tag 1 followed by the full filtered CNR
//! source. Version 3 omits it so the bounded editor cache keeps only the
//! expensive reduced coefficients and NIHO 7 maps; a frame rebuilds CNR.

use super::{analysis_size, camera, AnalysisCache, CnrSource, Niho7HighlightMaps};
use crate::decode::{LinearImage, WorkingCopyEncoding, WorkingCopyMeta};
use crate::niho4_response::{Camera, CoefficientMaps};
use std::fmt;
use std::sync::{Arc, OnceLock};

const MAGIC: &[u8; 6] = b"NIHOAN";
const VERSION: u16 = 3;
const PREVIOUS_VERSION: u16 = 2;

const CNR_ORIGINAL: u8 = 0;
const CNR_FILTERED: u8 = 1;
const CNR_OMITTED: u8 = 2;
const COEFFICIENTS_NONE: u8 = 0;
const COEFFICIENTS: u8 = 1;
const NIHO7_NONE: u8 = 0;
const NIHO7_RESIDUAL: u8 = 1;
const NIHO7_FX_SHOULDER: u8 = 2;
const NIHO7_FAILED: u8 = 3;

/// Why bytes are not taken in. The session is left as it was: a frame
/// that needs the analysis makes it.
#[derive(Debug, PartialEq)]
pub(crate) enum TransferError {
    /// Shorter than their own sections say.
    Truncated,
    /// Not analysis bytes (another magic).
    NotAnalysis,
    /// A version this build does not read.
    Version(u16),
    /// A camera code this build does not know.
    Camera(u8),
    /// A noise reduction amount that is not finite.
    Amount,
    /// The session's photo is not a signed RAW working copy of a known camera.
    NotSignedRaw,
    /// The analysis of another photo (camera, baseline exposure, size or
    /// the source pixels' fingerprint).
    OtherPhoto,
    /// A section of another kind than its key allows.
    Section { section: &'static str, tag: u8 },
    /// Coefficients of another size than the source's analysis.
    CoefficientSize { width: usize, height: usize },
    /// Bytes after the last section.
    Trailing(usize),
}

impl fmt::Display for TransferError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated => write!(f, "the analysis bytes end early"),
            Self::NotAnalysis => write!(f, "not analysis bytes"),
            Self::Version(version) => write!(f, "analysis bytes of version {version}"),
            Self::Camera(code) => write!(f, "unknown camera {code}"),
            Self::Amount => write!(f, "the noise reduction amount is not finite"),
            Self::NotSignedRaw => write!(f, "the photo is not a signed RAW of a known camera"),
            Self::OtherPhoto => write!(f, "the analysis of another photo"),
            Self::Section { section, tag } => write!(f, "{section} of kind {tag}"),
            Self::CoefficientSize { width, height } => {
                write!(f, "coefficients of {width}x{height}")
            }
            Self::Trailing(count) => write!(f, "{count} bytes after the analysis"),
        }
    }
}

fn camera_code(camera: Camera) -> u8 {
    match camera {
        Camera::PanasonicDcS5 => 0,
        Camera::SonyZvE10m2 => 1,
        Camera::SonyIlmeFx30 => 2,
    }
}

fn camera_from_code(code: u8) -> Option<Camera> {
    match code {
        0 => Some(Camera::PanasonicDcS5),
        1 => Some(Camera::SonyZvE10m2),
        2 => Some(Camera::SonyIlmeFx30),
        _ => None,
    }
}

/// A fingerprint of the source pixels (their `f32` bits): bytes are taken
/// in only by a session of the same photo, as two photos of one camera,
/// baseline and size are not told apart by those (and with a noise
/// reduction the other photo's filtered pixels would be drawn). Four
/// multiply-xor lanes over the bits, then mixed with the length; about the
/// cost of one pass over the source.
pub(crate) fn source_fingerprint(data: &[f32]) -> u64 {
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut lanes: [u64; 4] = [
        0xcbf2_9ce4_8422_2325,
        0x9e37_79b9_7f4a_7c15,
        0xc2b2_ae3d_27d4_eb4f,
        0x1656_67b1_9e37_79f9,
    ];
    let chunks = data.chunks_exact(4);
    let rest = chunks.remainder();
    for chunk in chunks {
        for (lane, value) in lanes.iter_mut().zip(chunk) {
            *lane = (*lane ^ u64::from(value.to_bits())).wrapping_mul(PRIME);
        }
    }
    for (lane, value) in lanes.iter_mut().zip(rest) {
        *lane = (*lane ^ u64::from(value.to_bits())).wrapping_mul(PRIME);
    }
    let mut hash = (data.len() as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    for lane in lanes {
        hash = (hash ^ lane).wrapping_mul(PRIME).rotate_left(29);
    }
    hash
}

impl AnalysisCache {
    /// This analysis as compact version 3 bytes (what it holds: a part not made yet
    /// is written as none). `fingerprint` is [`source_fingerprint`] of the
    /// source it was made from.
    pub(crate) fn to_bytes(&self, fingerprint: u64) -> Vec<u8> {
        let filtered = self.cnr_amount != 0.0 || self.luminance_nr_amount != 0.0;
        let coefficients = self.coefficients.get();
        let niho7 = self.niho7_highlights.get();
        let floats = coefficients.map_or(0, |maps| maps.width * maps.height * 5)
            + match niho7 {
                Some(Ok(Niho7HighlightMaps::Residual(residual))) => residual.len(),
                Some(Ok(Niho7HighlightMaps::FxShoulder { a, b })) => a.len() + b.len(),
                _ => 0,
            };
        let mut out =
            Vec::with_capacity(MAGIC.len() + 2 + 1 + 8 * 4 + 4 * 2 + 3 + 4 * 2 + floats * 4);
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&VERSION.to_le_bytes());
        out.push(camera_code(self.camera));
        out.extend_from_slice(&self.cnr_amount.to_bits().to_le_bytes());
        out.extend_from_slice(&self.luminance_nr_amount.to_bits().to_le_bytes());
        out.extend_from_slice(&self.baseline_ev_bits.to_le_bytes());
        put_size(&mut out, self.source_width, self.source_height);
        out.extend_from_slice(&fingerprint.to_le_bytes());
        out.push(if filtered { CNR_OMITTED } else { CNR_ORIGINAL });
        match coefficients {
            None => out.push(COEFFICIENTS_NONE),
            Some(maps) => {
                out.push(COEFFICIENTS);
                put_size(&mut out, maps.width, maps.height);
                for map in [
                    &maps.highlight_a,
                    &maps.highlight_b,
                    &maps.highlight_alpha,
                    &maps.shadow_a,
                    &maps.shadow_b,
                ] {
                    put_f32s(&mut out, map);
                }
            }
        }
        match (niho7, coefficients) {
            (Some(Ok(Niho7HighlightMaps::Residual(residual))), Some(_)) => {
                out.push(NIHO7_RESIDUAL);
                put_f32s(&mut out, residual);
            }
            (Some(Ok(Niho7HighlightMaps::FxShoulder { a, b })), Some(_)) => {
                out.push(NIHO7_FX_SHOULDER);
                put_f32s(&mut out, a);
                put_f32s(&mut out, b);
            }
            // Made again (to the same error) by the frame that needs them.
            (Some(Err(_)), _) => out.push(NIHO7_FAILED),
            _ => out.push(NIHO7_NONE),
        }
        out
    }

    /// Whether `other` is the analysis of the same source, camera, baseline
    /// exposure and noise reduction (the analysis [`AnalysisCache::serves`]
    /// the same settings).
    pub(crate) fn same_key(&self, other: &AnalysisCache) -> bool {
        self.camera == other.camera
            && self.cnr_amount == other.cnr_amount
            && self.luminance_nr_amount == other.luminance_nr_amount
            && self.baseline_ev_bits == other.baseline_ev_bits
            && self.source_width == other.source_width
            && self.source_height == other.source_height
            && self.source_ptr == other.source_ptr
            && self.source_len == other.source_len
    }

    /// Sets in this analysis's shared cells what it has not made yet and
    /// `other`, the same key's analysis taken in, has (the coefficients,
    /// the NIHO 7 highlight maps). Its CNR source stays (the same values).
    /// Whether it set anything.
    pub(crate) fn fill_from(&self, other: AnalysisCache) -> bool {
        let mut filled = false;
        if let Some(maps) = Arc::into_inner(other.coefficients).and_then(OnceLock::into_inner) {
            filled |= self.coefficients.set(maps).is_ok();
        }
        if let Some(maps) = Arc::into_inner(other.niho7_highlights).and_then(OnceLock::into_inner) {
            filled |= self.niho7_highlights.set(maps).is_ok();
        }
        filled
    }
}

/// Reads compact version 3 or legacy version 2 bytes as the analysis of
/// `image` (the session's source,
/// opened from `meta`; `fingerprint` is [`source_fingerprint`] of its
/// pixels): the bytes must be of this photo (camera, baseline exposure,
/// size and the pixels' fingerprint) and whole. Every length is checked before it is read,
/// so broken bytes are an error and never a panic.
pub(crate) fn import_analysis(
    bytes: &[u8],
    image: &LinearImage,
    meta: &WorkingCopyMeta,
    fingerprint: u64,
) -> Result<AnalysisCache, TransferError> {
    let mut reader = Reader { bytes };
    if reader.take(MAGIC.len())? != MAGIC {
        return Err(TransferError::NotAnalysis);
    }
    let version = u16::from_le_bytes(reader.array()?);
    if version != VERSION && version != PREVIOUS_VERSION {
        return Err(TransferError::Version(version));
    }
    let code = reader.u8()?;
    let analysis_camera = camera_from_code(code).ok_or(TransferError::Camera(code))?;
    let cnr_amount = f64::from_bits(u64::from_le_bytes(reader.array()?));
    let luminance_nr_amount = f64::from_bits(u64::from_le_bytes(reader.array()?));
    if !cnr_amount.is_finite() || !luminance_nr_amount.is_finite() {
        return Err(TransferError::Amount);
    }
    let baseline_ev_bits = u64::from_le_bytes(reader.array()?);
    let size = reader.size()?;
    let source_fingerprint = u64::from_le_bytes(reader.array()?);

    let (
        Some(own_camera),
        WorkingCopyMeta::Raw {
            baseline_ev,
            encoding: Some(WorkingCopyEncoding::SignedGamma18V1 { .. }),
            ..
        },
    ) = (camera(meta), meta)
    else {
        return Err(TransferError::NotSignedRaw);
    };
    if analysis_camera != own_camera
        || baseline_ev_bits != baseline_ev.to_bits()
        || size != (image.width, image.height)
        || source_fingerprint != fingerprint
    {
        return Err(TransferError::OtherPhoto);
    }

    // As `make_analysis` makes it: the source itself only without noise
    // reduction.
    let filtered = !(cnr_amount == 0.0 && luminance_nr_amount == 0.0);
    let cnr_source = match reader.u8()? {
        CNR_ORIGINAL if !filtered => CnrSource::Original,
        CNR_FILTERED if filtered && version == PREVIOUS_VERSION => {
            CnrSource::Filtered(reader.f32s(image.data.len())?)
        }
        CNR_OMITTED if filtered && version == VERSION => CnrSource::Missing,
        tag => {
            return Err(TransferError::Section {
                section: "CNR source",
                tag,
            })
        }
    };

    let coefficients = match reader.u8()? {
        COEFFICIENTS_NONE => None,
        COEFFICIENTS => {
            let (width, height) = reader.size()?;
            if (width, height) != analysis_size(image.width, image.height) {
                return Err(TransferError::CoefficientSize { width, height });
            }
            let pixels = width * height;
            Some(CoefficientMaps {
                camera: analysis_camera,
                width,
                height,
                highlight_a: reader.f32s(pixels)?,
                highlight_b: reader.f32s(pixels)?,
                highlight_alpha: reader.f32s(pixels)?,
                shadow_a: reader.f32s(pixels)?,
                shadow_b: reader.f32s(pixels)?,
            })
        }
        tag => {
            return Err(TransferError::Section {
                section: "coefficients",
                tag,
            })
        }
    };

    let fx30 = analysis_camera == Camera::SonyIlmeFx30;
    let niho7 = match (reader.u8()?, &coefficients) {
        // Not made, or made to an error a frame that needs them meets again.
        (NIHO7_NONE | NIHO7_FAILED, _) => None,
        (NIHO7_RESIDUAL, Some(maps)) if !fx30 => Some(Niho7HighlightMaps::Residual(
            reader.f32s(maps.width * maps.height)?,
        )),
        (NIHO7_FX_SHOULDER, Some(maps)) if fx30 => Some(Niho7HighlightMaps::FxShoulder {
            a: reader.f32s(maps.width * maps.height)?,
            b: reader.f32s(maps.width * maps.height)?,
        }),
        (tag, _) => {
            return Err(TransferError::Section {
                section: "NIHO 7 highlight maps",
                tag,
            })
        }
    };

    if !reader.bytes.is_empty() {
        return Err(TransferError::Trailing(reader.bytes.len()));
    }
    Ok(AnalysisCache {
        camera: analysis_camera,
        cnr_amount,
        luminance_nr_amount,
        baseline_ev_bits,
        source_width: image.width,
        source_height: image.height,
        source_ptr: image.data.as_ptr() as usize,
        source_len: image.data.len(),
        cnr_source: Arc::new(cnr_source),
        coefficients: Arc::new(coefficients.map_or_else(OnceLock::new, OnceLock::from)),
        niho7_highlights: Arc::new(
            niho7.map_or_else(OnceLock::new, |maps| OnceLock::from(Ok(maps))),
        ),
        preview_source: None,
    })
}

/// A size as two `u32` (a source and its analysis are far below their
/// bound; one above it is written as the bound and read as another size).
fn put_size(out: &mut Vec<u8>, width: usize, height: usize) {
    for value in [width, height] {
        out.extend_from_slice(&u32::try_from(value).unwrap_or(u32::MAX).to_le_bytes());
    }
}

fn put_f32s(out: &mut Vec<u8>, values: &[f32]) {
    let start = out.len();
    out.resize(start + values.len() * 4, 0);
    for (bytes, value) in out[start..].chunks_exact_mut(4).zip(values) {
        bytes.copy_from_slice(&value.to_le_bytes());
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], TransferError> {
        if count > self.bytes.len() {
            return Err(TransferError::Truncated);
        }
        let (head, rest) = self.bytes.split_at(count);
        self.bytes = rest;
        Ok(head)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], TransferError> {
        let mut array = [0; N];
        array.copy_from_slice(self.take(N)?);
        Ok(array)
    }

    fn u8(&mut self) -> Result<u8, TransferError> {
        Ok(self.array::<1>()?[0])
    }

    fn size(&mut self) -> Result<(usize, usize), TransferError> {
        let width = u32::from_le_bytes(self.array()?);
        let height = u32::from_le_bytes(self.array()?);
        Ok((width as usize, height as usize))
    }

    /// `count` values (a size already checked against the photo's, so the
    /// length cannot overflow).
    fn f32s(&mut self, count: usize) -> Result<Vec<f32>, TransferError> {
        let bytes = self.take(count.checked_mul(4).ok_or(TransferError::Truncated)?)?;
        Ok(bytes
            .chunks_exact(4)
            .map(|value| f32::from_le_bytes([value[0], value[1], value[2], value[3]]))
            .collect())
    }
}
