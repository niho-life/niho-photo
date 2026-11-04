//! Output encoders: JPEG (quality 1..100) and PNG from the RGBA frame. The
//! pixels are sRGB; files carry no ICC profile (untagged = sRGB).

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder};

pub fn encode_jpeg(
    rgba: &[u8],
    width: usize,
    height: usize,
    quality: u8,
) -> Result<Vec<u8>, String> {
    let rgb: Vec<u8> = rgba
        .chunks_exact(4)
        .flat_map(|p| [p[0], p[1], p[2]])
        .collect();
    let mut out = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut out, quality.clamp(1, 100));
    encoder
        .encode(&rgb, width as u32, height as u32, ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn encode_png(rgba: &[u8], width: usize, height: usize) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    PngEncoder::new(&mut out)
        .write_image(rgba, width as u32, height as u32, ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// Validates a bounded preview/thumbnail produced by this SDK's PNG encoder.
/// Exact re-encoding rejects private ancillary data, alternate colour profiles,
/// trailing data and noncanonical compressed payloads without changing pixels.
pub fn validate_derived_png(bytes: &[u8], max_edge: u32) -> Result<(u32, u32), String> {
    use std::io::Cursor;
    let invalid = || "invalid canonical derived PNG".to_owned();
    if !matches!(max_edge, 512 | 1280)
        || bytes.len() > 8 * 1024 * 1024
        || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
    {
        return Err(invalid());
    }
    // Refuse metadata before decoding it, including compressed text/profile
    // chunks. CRCs, image framing and pixels are verified by the PNG crate.
    let mut offset = 8usize;
    let mut ended = false;
    while offset < bytes.len() {
        let header_end = offset.checked_add(8).ok_or_else(invalid)?;
        let header = bytes.get(offset..header_end).ok_or_else(invalid)?;
        let length = u32::from_be_bytes(header[..4].try_into().map_err(|_| invalid())?) as usize;
        let end = header_end
            .checked_add(length)
            .and_then(|end| end.checked_add(4))
            .filter(|end| *end <= bytes.len())
            .ok_or_else(invalid)?;
        match &header[4..8] {
            b"IHDR" | b"IDAT" => {}
            b"IEND" if length == 0 && end == bytes.len() => ended = true,
            _ => return Err(invalid()),
        }
        offset = end;
    }
    if !ended {
        return Err(invalid());
    }
    let mut cursor = Cursor::new(bytes);
    let mut decoder = png::Decoder::new_with_limits(
        &mut cursor,
        png::Limits {
            bytes: 16 * 1024 * 1024,
        },
    );
    decoder.set_transformations(png::Transformations::IDENTITY);
    let header = decoder.read_header_info().map_err(|_| invalid())?;
    let (width, height) = (header.width, header.height);
    if width == 0
        || height == 0
        || width > max_edge
        || height > max_edge
        || header.color_type != png::ColorType::Rgba
        || header.bit_depth != png::BitDepth::Eight
    {
        return Err(invalid());
    }
    let mut reader = decoder.read_info().map_err(|_| invalid())?;
    let mut rgba = vec![0; width as usize * height as usize * 4];
    if reader.output_buffer_size() != Some(rgba.len()) {
        return Err(invalid());
    }
    reader.next_frame(&mut rgba).map_err(|_| invalid())?;
    reader.finish().map_err(|_| invalid())?;
    drop(reader);
    if cursor.position() != bytes.len() as u64
        || encode_png(&rgba, width as usize, height as usize)? != bytes
    {
        return Err(invalid());
    }
    Ok((width, height))
}

#[cfg(test)]
mod derived_png_tests {
    use super::*;

    #[test]
    fn sdk_outputs_are_verified_without_changing_their_bytes() {
        let rgba = [10, 20, 30, 255, 80, 90, 100, 128];
        let png = encode_png(&rgba, 2, 1).unwrap();
        assert_eq!(validate_derived_png(&png, 512).unwrap(), (2, 1));
        assert_eq!(validate_derived_png(&png, 1280).unwrap(), (2, 1));
        assert_eq!(encode_png(&rgba, 2, 1).unwrap(), png);
        let wide = encode_png(&vec![255; 513 * 4], 513, 1).unwrap();
        assert!(validate_derived_png(&wide, 512).is_err());
        assert_eq!(validate_derived_png(&wide, 1280).unwrap(), (513, 1));
        assert!(validate_derived_png(&png, 256).is_err());
    }

    #[test]
    fn valid_metadata_crc_and_appended_bytes_do_not_pass_the_output_contract() {
        let png = encode_png(&[10, 20, 30, 255], 1, 1).unwrap();
        let mut with_text = png[..png.len() - 12].to_vec();
        let text = b"Author\0synthetic private metadata";
        with_text.extend_from_slice(&(text.len() as u32).to_be_bytes());
        with_text.extend_from_slice(b"tEXt");
        with_text.extend_from_slice(text);
        let mut crc = flate2::Crc::new();
        crc.update(b"tEXt");
        crc.update(text);
        with_text.extend_from_slice(&crc.sum().to_be_bytes());
        with_text.extend_from_slice(&png[png.len() - 12..]);
        assert!(validate_derived_png(&with_text, 1280).is_err());
        let mut appended = png.clone();
        appended.push(0);
        assert!(validate_derived_png(&appended, 1280).is_err());
        let mut damaged = png;
        *damaged.last_mut().unwrap() ^= 1;
        assert!(validate_derived_png(&damaged, 1280).is_err());
    }
}
