//! Mask surfaces of `brush` / `subject` / `sky` masks
//! (`docs/local-adjustments.md` "面の受け渡し", Epic #31 M4 = #68): immutable
//! 8-bit gray PNGs named by the sha256 of their bytes. A [`crate::Session`]
//! holds the ones set with [`crate::Session::set_mask_surface`]; the planes
//! (`local_render.rs`) sample them with [`Sampler`].
//!
//! A surface PNG is taken only when
//!
//! - its id is 64 lowercase hex digits and is the sha256 of the PNG bytes,
//! - it is at most [`MAX_SURFACE_PNG_BYTES`] bytes,
//! - it is a still 8-bit grayscale PNG: colour type 0, bit depth 8 (not
//!   1 / 2 / 4 / 16), interlaced or not, no `tRNS` (transparency), no `acTL`
//!   (animation), 1..=[`MAX_SURFACE_SIDE`] pixels per side, and decodes to
//!   its end.
//!
//! Everything else is a [`SurfaceError`] (`maskSurfaceInvalid` in the
//! engine's errors). The value of a pixel is `byte / 255`.

use sha2::{Digest, Sha256};
use std::fmt;
use std::io::Cursor;

/// The largest surface PNG (bytes).
pub const MAX_SURFACE_PNG_BYTES: usize = 8 * 1024 * 1024;
/// The longest side of a surface (pixels), as the settings' `surface.width`
/// / `surface.height` allow.
pub const MAX_SURFACE_SIDE: u32 = 4096;

/// A decoded surface: `width * height` bytes, row-major, value `byte / 255`.
#[derive(Clone, PartialEq, Eq)]
pub struct MaskSurface {
    width: u32,
    height: u32,
    data: Vec<u8>,
}

impl fmt::Debug for MaskSurface {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "MaskSurface({}x{})", self.width, self.height)
    }
}

impl MaskSurface {
    /// A surface of `data` (`width * height` bytes, row-major).
    pub fn new(width: u32, height: u32, data: Vec<u8>) -> Result<Self, SurfaceError> {
        check_sides(width, height)?;
        if data.len() != width as usize * height as usize {
            return Err(SurfaceError::DataLength {
                expected: width as usize * height as usize,
                actual: data.len(),
            });
        }
        Ok(Self {
            width,
            height,
            data,
        })
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn data(&self) -> &[u8] {
        &self.data
    }

    /// The value (`0..=1`) at working-image position `(u, v)` (`0..1` of the
    /// width and height): [`Sampler::value`].
    pub fn sample(&self, u: f64, v: f64) -> f32 {
        Sampler::new(self).value(u, v)
    }
}

/// A surface that does not fit the contract (module docs).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SurfaceError {
    /// The id is not 64 lowercase hex digits.
    InvalidId,
    /// More than [`MAX_SURFACE_PNG_BYTES`].
    TooLarge { bytes: usize },
    /// The sha256 of the bytes is not the id (`actual` is the bytes').
    HashMismatch { actual: String },
    /// Not a PNG the decoder reads to its end.
    Png(String),
    /// A PNG of another colour type or bit depth.
    Format { color_type: String, bit_depth: u8 },
    /// A `tRNS` chunk (transparency).
    Transparency,
    /// An `acTL` chunk (an animated PNG).
    Animated,
    /// A side outside `1..=4096`.
    Size { width: u32, height: u32 },
    /// [`MaskSurface::new`] with `data` of another length.
    DataLength { expected: usize, actual: usize },
}

impl fmt::Display for SurfaceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SurfaceError::InvalidId => {
                write!(f, "the id must be 64 lowercase hex digits (the PNG's sha256)")
            }
            SurfaceError::TooLarge { bytes } => write!(
                f,
                "the PNG is {bytes} bytes (at most {MAX_SURFACE_PNG_BYTES})"
            ),
            SurfaceError::HashMismatch { actual } => {
                write!(f, "the PNG's sha256 is {actual}, not its id")
            }
            SurfaceError::Png(e) => write!(f, "not a readable PNG: {e}"),
            SurfaceError::Format {
                color_type,
                bit_depth,
            } => write!(
                f,
                "the PNG must be 8-bit grayscale (colour type 0, bit depth 8), not {color_type} at {bit_depth} bits"
            ),
            SurfaceError::Transparency => {
                write!(f, "the PNG must not carry transparency (tRNS)")
            }
            SurfaceError::Animated => write!(f, "the PNG must be a still image (acTL)"),
            SurfaceError::Size { width, height } => write!(
                f,
                "the PNG is {width}x{height} (1..={MAX_SURFACE_SIDE} pixels per side)"
            ),
            SurfaceError::DataLength { expected, actual } => {
                write!(f, "the surface has {actual} values, not {expected}")
            }
        }
    }
}

impl std::error::Error for SurfaceError {}

fn check_sides(width: u32, height: u32) -> Result<(), SurfaceError> {
    if (1..=MAX_SURFACE_SIDE).contains(&width) && (1..=MAX_SURFACE_SIDE).contains(&height) {
        Ok(())
    } else {
        Err(SurfaceError::Size { width, height })
    }
}

/// Whether `id` has the form of a surface id (64 lowercase hex digits).
pub fn is_surface_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The id of a surface PNG: the sha256 of its bytes in lowercase hex.
pub fn surface_id(png: &[u8]) -> String {
    Sha256::digest(png)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Checks that `png` is the surface `id` names (the id's form, the size
/// cap and the sha256), without decoding it.
pub fn verify_surface_id(id: &str, png: &[u8]) -> Result<(), SurfaceError> {
    if !is_surface_id(id) {
        return Err(SurfaceError::InvalidId);
    }
    if png.len() > MAX_SURFACE_PNG_BYTES {
        return Err(SurfaceError::TooLarge { bytes: png.len() });
    }
    let actual = surface_id(png);
    if actual != id {
        return Err(SurfaceError::HashMismatch { actual });
    }
    Ok(())
}

/// [`verify_surface_id`], then [`decode_surface_png`].
pub fn load_surface(id: &str, png: &[u8]) -> Result<MaskSurface, SurfaceError> {
    verify_surface_id(id, png)?;
    decode_surface_png(png)
}

fn png_error(e: impl fmt::Display) -> SurfaceError {
    SurfaceError::Png(e.to_string())
}

/// Decodes a surface PNG strictly (module docs; the id is not checked).
pub fn decode_surface_png(png: &[u8]) -> Result<MaskSurface, SurfaceError> {
    if png.len() > MAX_SURFACE_PNG_BYTES {
        return Err(SurfaceError::TooLarge { bytes: png.len() });
    }
    let mut cursor = Cursor::new(png);
    let mut decoder = png::Decoder::new(&mut cursor);
    decoder.set_transformations(png::Transformations::IDENTITY);
    // The header first: refuse a size or format before reading the rest.
    let header = decoder.read_header_info().map_err(png_error)?;
    if header.color_type != png::ColorType::Grayscale || header.bit_depth != png::BitDepth::Eight {
        return Err(SurfaceError::Format {
            color_type: format!("{:?}", header.color_type),
            bit_depth: header.bit_depth as u8,
        });
    }
    check_sides(header.width, header.height)?;
    let mut reader = decoder.read_info().map_err(png_error)?;
    let info = reader.info();
    if info.trns.is_some() {
        return Err(SurfaceError::Transparency);
    }
    if info.animation_control.is_some() {
        return Err(SurfaceError::Animated);
    }
    let (width, height) = (info.width, info.height);
    let mut data = vec![0u8; width as usize * height as usize];
    if reader.output_buffer_size() != Some(data.len()) {
        return Err(png_error("unexpected output size"));
    }
    reader.next_frame(&mut data).map_err(png_error)?;
    reader.finish().map_err(png_error)?;
    // png::Reader::finish stops at IEND, even when more input follows.
    // Cursor consumes only the bytes the decoder parsed, including the IEND CRC.
    drop(reader);
    if cursor.position() != png.len() as u64 {
        return Err(png_error("bytes after IEND"));
    }
    MaskSurface::new(width, height, data)
}

/// Encodes a surface as a non-interlaced 8-bit grayscale PNG (the png
/// crate's balanced compression and adaptive filter: the same pixels give
/// the same bytes, and so the same id, on every target of one build).
pub fn encode_surface_png(surface: &MaskSurface) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, surface.width, surface.height);
        encoder.set_color(png::ColorType::Grayscale);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Balanced);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer
            .write_image_data(&surface.data)
            .map_err(|e| e.to_string())?;
        writer.finish().map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Bilinear sampling of a surface spread over the whole working image
/// (`docs/local-adjustments.md` "面の式"), in `f32` with `+ - * /` and
/// `floor` only (native and wasm agree bit for bit):
///
/// `x = u * width - 0.5`, `y = v * height - 0.5` (`u`, `v` as `f32`),
/// `x0 = floor(x)`, `y0 = floor(y)`, `fx = x - x0`, `fy = y - y0`; the four
/// neighbours `(x0 | x0 + 1, y0 | y0 + 1)` with each index clamped to the
/// surface (the edge values extend outwards); `top = a + (b - a) * fx`,
/// `bottom = c + (d - c) * fx`, `m = (top + (bottom - top) * fy) / 255` on
/// the bytes `a` (x0, y0), `b` (x0 + 1, y0), `c` (x0, y0 + 1), `d`
/// (x0 + 1, y0 + 1). `m` stays in `0..=1` (a byte of 255 everywhere is
/// exactly 1).
#[derive(Debug, Clone, Copy)]
pub struct Sampler<'a> {
    data: &'a [u8],
    width: usize,
    /// `width - 1` and `height - 1` as `f32` (the last index).
    last_x: f32,
    last_y: f32,
    width_f: f32,
    height_f: f32,
}

impl<'a> Sampler<'a> {
    pub fn new(surface: &'a MaskSurface) -> Self {
        Self {
            data: &surface.data,
            width: surface.width as usize,
            last_x: (surface.width - 1) as f32,
            last_y: (surface.height - 1) as f32,
            width_f: surface.width as f32,
            height_f: surface.height as f32,
        }
    }

    /// `m` (`0..=1`) at working-image position `(u, v)`.
    #[inline(always)]
    pub fn value(&self, u: f64, v: f64) -> f32 {
        let x = u as f32 * self.width_f - 0.5;
        let y = v as f32 * self.height_f - 0.5;
        let x0 = libm::floorf(x);
        let y0 = libm::floorf(y);
        let (fx, fy) = (x - x0, y - y0);
        // An index clamped to 0..=last (integral values: the casts are exact).
        let index = |c: f32, last: f32| -> usize {
            if c <= 0.0 {
                0
            } else if c >= last {
                last as usize
            } else {
                c as usize
            }
        };
        let (i0, i1) = (index(x0, self.last_x), index(x0 + 1.0, self.last_x));
        let (j0, j1) = (index(y0, self.last_y), index(y0 + 1.0, self.last_y));
        let at = |i: usize, j: usize| f32::from(self.data[j * self.width + i]);
        let (a, b) = (at(i0, j0), at(i1, j0));
        let (c, d) = (at(i0, j1), at(i1, j1));
        let top = a + (b - a) * fx;
        let bottom = c + (d - c) * fx;
        (top + (bottom - top) * fy) / 255.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn surface(width: u32, height: u32, data: &[u8]) -> MaskSurface {
        MaskSurface::new(width, height, data.to_vec()).unwrap()
    }

    /// A PNG of any colour type / depth (for the refusals).
    fn png_of(
        width: u32,
        height: u32,
        color: png::ColorType,
        depth: png::BitDepth,
        data: &[u8],
        edit: impl FnOnce(&mut png::Encoder<'_, &mut Vec<u8>>),
    ) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, width, height);
            encoder.set_color(color);
            encoder.set_depth(depth);
            edit(&mut encoder);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(data).unwrap();
            writer.finish().unwrap();
        }
        out
    }

    #[test]
    fn a_surface_round_trips_and_its_id_is_the_sha256_of_the_png() {
        let s = surface(3, 2, &[0, 128, 255, 7, 8, 9]);
        let png = encode_surface_png(&s).unwrap();
        assert_eq!(decode_surface_png(&png).unwrap(), s);
        let id = surface_id(&png);
        assert!(is_surface_id(&id));
        assert_eq!(load_surface(&id, &png).unwrap(), s);
        // The same pixels encode to the same bytes.
        assert_eq!(encode_surface_png(&s.clone()).unwrap(), png);
        // The sha256 of "abc" (FIPS 180-2).
        assert_eq!(
            surface_id(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn a_surface_must_end_at_iend_even_when_its_hash_matches() {
        let png = encode_surface_png(&surface(2, 2, &[0, 128, 255, 7])).unwrap();
        for suffix in [&[0][..], b"trailing bytes", png.as_slice()] {
            let mut appended = png.clone();
            appended.extend_from_slice(suffix);
            let id = surface_id(&appended);
            assert!(verify_surface_id(&id, &appended).is_ok());
            assert!(matches!(
                load_surface(&id, &appended),
                Err(SurfaceError::Png(_))
            ));
        }
        let interlaced = interlaced_gray_png(2, 2, &[0, 128, 255, 7]);
        assert!(decode_surface_png(&interlaced).is_ok());
        let mut appended = interlaced;
        appended.push(0);
        assert!(matches!(
            decode_surface_png(&appended),
            Err(SurfaceError::Png(_))
        ));
    }

    /// An Adam7-interlaced 8-bit gray PNG written by hand (the png crate's
    /// encoder does not interlace): every pass's rows with filter 0.
    fn interlaced_gray_png(width: usize, height: usize, data: &[u8]) -> Vec<u8> {
        use std::io::Write;
        const PASSES: [(usize, usize, usize, usize); 7] = [
            (0, 0, 8, 8),
            (4, 0, 8, 8),
            (0, 4, 4, 8),
            (2, 0, 4, 4),
            (0, 2, 2, 4),
            (1, 0, 2, 2),
            (0, 1, 1, 2),
        ];
        let mut raw = Vec::new();
        for (x0, y0, dx, dy) in PASSES {
            let columns: Vec<usize> = (x0..width).step_by(dx).collect();
            if columns.is_empty() {
                continue;
            }
            for y in (y0..height).step_by(dy) {
                raw.push(0);
                raw.extend(columns.iter().map(|x| data[y * width + x]));
            }
        }
        let mut zlib = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        zlib.write_all(&raw).unwrap();
        let idat = zlib.finish().unwrap();
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&(width as u32).to_be_bytes());
        ihdr.extend_from_slice(&(height as u32).to_be_bytes());
        ihdr.extend_from_slice(&[8, 0, 0, 0, 1]);
        let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
        for (kind, body) in [(b"IHDR", ihdr), (b"IDAT", idat), (b"IEND", Vec::new())] {
            out.extend_from_slice(&(body.len() as u32).to_be_bytes());
            out.extend_from_slice(kind);
            out.extend_from_slice(&body);
            let mut crc = flate2::Crc::new();
            crc.update(kind);
            crc.update(&body);
            out.extend_from_slice(&crc.sum().to_be_bytes());
        }
        out
    }

    #[test]
    fn an_interlaced_gray_png_is_read_too() {
        let data: Vec<u8> = (0..9 * 7).map(|i| (i * 4) as u8).collect();
        let png = interlaced_gray_png(9, 7, &data);
        assert_eq!(png[28], 1, "interlace method Adam7");
        assert_eq!(decode_surface_png(&png).unwrap().data(), &data[..]);
    }

    #[test]
    fn ids_sizes_hashes_and_formats_are_checked() {
        let s = surface(2, 2, &[1, 2, 3, 4]);
        let png = encode_surface_png(&s).unwrap();
        let id = surface_id(&png);
        for bad in [
            id.to_uppercase(),
            id[..63].to_string(),
            format!("{id}0"),
            "g".repeat(64),
            String::new(),
        ] {
            assert_eq!(
                load_surface(&bad, &png),
                Err(SurfaceError::InvalidId),
                "{bad}"
            );
        }
        let other = "0".repeat(64);
        assert_eq!(
            load_surface(&other, &png),
            Err(SurfaceError::HashMismatch { actual: id.clone() })
        );
        let mut large = png.clone();
        large.resize(MAX_SURFACE_PNG_BYTES + 1, 0);
        assert_eq!(
            load_surface(&surface_id(&large), &large),
            Err(SurfaceError::TooLarge {
                bytes: MAX_SURFACE_PNG_BYTES + 1
            })
        );
        assert!(matches!(
            decode_surface_png(b"not a png"),
            Err(SurfaceError::Png(_))
        ));
        let mut truncated = png.clone();
        truncated.truncate(png.len() - 20);
        assert!(matches!(
            decode_surface_png(&truncated),
            Err(SurfaceError::Png(_))
        ));
        use png::{BitDepth, ColorType};
        let formats: [(ColorType, BitDepth, Vec<u8>); 5] = [
            (ColorType::Rgb, BitDepth::Eight, vec![0; 12]),
            (ColorType::Rgba, BitDepth::Eight, vec![0; 16]),
            (ColorType::GrayscaleAlpha, BitDepth::Eight, vec![0; 8]),
            (ColorType::Grayscale, BitDepth::Sixteen, vec![0; 8]),
            (ColorType::Grayscale, BitDepth::Four, vec![0; 2]),
        ];
        for (color, depth, data) in formats {
            let png = png_of(2, 2, color, depth, &data, |_| {});
            assert!(
                matches!(decode_surface_png(&png), Err(SurfaceError::Format { .. })),
                "{color:?} {depth:?}"
            );
        }
        let indexed = png_of(2, 2, ColorType::Indexed, BitDepth::Eight, &[0; 4], |e| {
            e.set_palette(vec![0, 0, 0]);
        });
        assert!(matches!(
            decode_surface_png(&indexed),
            Err(SurfaceError::Format { .. })
        ));
        let transparent = png_of(2, 2, ColorType::Grayscale, BitDepth::Eight, &[0; 4], |e| {
            e.set_trns(vec![0, 0]);
        });
        assert_eq!(
            decode_surface_png(&transparent),
            Err(SurfaceError::Transparency)
        );
        let animated = png_of(2, 2, ColorType::Grayscale, BitDepth::Eight, &[0; 4], |e| {
            e.set_animated(1, 0).unwrap();
        });
        assert_eq!(decode_surface_png(&animated), Err(SurfaceError::Animated));
        let wide = png_of(
            MAX_SURFACE_SIDE + 1,
            1,
            ColorType::Grayscale,
            BitDepth::Eight,
            &vec![0; MAX_SURFACE_SIDE as usize + 1],
            |_| {},
        );
        assert_eq!(
            decode_surface_png(&wide),
            Err(SurfaceError::Size {
                width: MAX_SURFACE_SIDE + 1,
                height: 1
            })
        );
        // A zero side: the PNG header itself is invalid.
        let mut zero = png_of(1, 1, ColorType::Grayscale, BitDepth::Eight, &[0], |_| {});
        zero[16..20].copy_from_slice(&0u32.to_be_bytes());
        assert!(decode_surface_png(&zero).is_err());
        assert_eq!(
            MaskSurface::new(0, 4, Vec::new()),
            Err(SurfaceError::Size {
                width: 0,
                height: 4
            })
        );
        assert_eq!(
            MaskSurface::new(2, 2, vec![0; 3]),
            Err(SurfaceError::DataLength {
                expected: 4,
                actual: 3
            })
        );
    }

    #[test]
    fn a_one_pixel_surface_is_a_constant() {
        for value in [0u8, 1, 128, 254, 255] {
            let s = surface(1, 1, &[value]);
            for (u, v) in [(0.0, 0.0), (0.3, 0.9), (1.0, 1.0), (-0.2, 1.4)] {
                assert_eq!(s.sample(u, v), f32::from(value) / 255.0, "{value} {u} {v}");
            }
        }
        assert_eq!(surface(1, 1, &[255]).sample(0.5, 0.5), 1.0);
    }

    #[test]
    fn a_two_by_two_surface_interpolates_between_its_pixel_centres() {
        // Pixel centres at u = 1/4 and 3/4 (and v likewise).
        let s = surface(2, 2, &[0, 255, 51, 102]);
        // `m` against the byte-scale value it is drawn from.
        let at = |u: f64, v: f64, byte: f32| assert_eq!(s.sample(u, v), byte / 255.0, "{u} {v}");
        at(0.25, 0.25, 0.0);
        at(0.75, 0.25, 255.0);
        at(0.25, 0.75, 51.0);
        at(0.75, 0.75, 102.0);
        // Half way along the top row and down the left column.
        at(0.5, 0.25, 127.5);
        at(0.25, 0.5, 25.5);
        // The centre: the mean of the four.
        at(0.5, 0.5, (0.0 + 255.0 + 51.0 + 102.0) / 4.0);
        // Outside the pixel centres the edge values extend (no wrap).
        at(0.0, 0.0, 0.0);
        at(1.0, 0.0, 255.0);
        at(1.0, 1.0, 102.0);
        at(0.0, 1.0, 51.0);
        at(-3.0, 0.25, 0.0);
        at(5.0, 0.75, 102.0);
        // Along the top edge (v above the first centre) only the x ramp.
        at(0.5, 0.0, 127.5);
        assert_eq!(s.sample(0.75, 0.25), 1.0);
        // Values stay within 0..=1.
        for i in 0..=40 {
            for j in 0..=40 {
                let m = s.sample(i as f64 / 40.0, j as f64 / 40.0);
                assert!((0.0..=1.0).contains(&m), "{m}");
            }
        }
    }
}
