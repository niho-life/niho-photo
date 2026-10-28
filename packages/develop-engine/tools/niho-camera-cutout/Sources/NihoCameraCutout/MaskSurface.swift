import Compression
import CoreGraphics
import Foundation
import ImageIO
import Vision

/// The surface of a detected local-adjustment mask (`docs/local-adjustments.md`
/// 「面の受け渡し」, niho-photo#135): one 8-bit gray value per pixel of the
/// working image (0 = outside, 255 = inside), every foreground subject
/// together.
public enum MaskSurface {
    /// The longest side the engine accepts (`MAX_SURFACE_SIDE`).
    public static let maxSide = 4096
    /// The largest PNG the engine accepts (`MAX_SURFACE_PNG_BYTES`).
    public static let maxPNGBytes = 8 * 1024 * 1024

    /// The working image to detect on: `url` with its EXIF orientation
    /// applied, its long edge at most `maxSide` (never enlarged), drawn
    /// into sRGB RGBA8. `sourceWidth` / `sourceHeight` are the oriented size
    /// before shrinking.
    public static func loadInput(
        _ url: URL,
        maxSide: Int = MaskSurface.maxSide
    ) throws -> (image: CGImage, sourceWidth: Int, sourceHeight: Int) {
        guard maxSide > 0,
              let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              CGImageSourceGetCount(source) > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let pixelWidth = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let pixelHeight = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue
        else { throw CutoutError.unreadableInput(url) }
        guard pixelWidth > 0, pixelHeight > 0 else { throw CutoutError.invalidImageDimensions }
        let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        // 5...8 turn the picture a quarter.
        let turned = (5...8).contains(orientation)
        let sourceWidth = turned ? pixelHeight : pixelWidth
        let sourceHeight = turned ? pixelWidth : pixelHeight
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: min(maxSide, max(sourceWidth, sourceHeight)),
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let oriented = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw CutoutError.unreadableInput(url)
        }
        return (try sRGBA8(oriented), sourceWidth, sourceHeight)
    }

    /// Every foreground subject of `image` in one soft mask of the image's
    /// size (`VNGenerateForegroundInstanceMaskRequest`, the revision of
    /// `detect`). `subjects` is the number of instances Vision found.
    public static func detectForeground(_ image: CGImage) throws -> (mask: MaskRaster, subjects: Int) {
        let request = VNGenerateForegroundInstanceMaskRequest()
        request.revision = CutoutMaskReference.engineRevision
        let handler = VNImageRequestHandler(cgImage: image, orientation: .up)
        try handler.perform([request])
        guard let observation = request.results?.first,
              !observation.allInstances.isEmpty
        else { throw CutoutError.noForegroundSubjects }
        let buffer = try observation.generateScaledMaskForImage(
            forInstances: observation.allInstances,
            from: handler
        )
        let mask = try MaskRaster(pixelBuffer: buffer)
        guard mask.width == image.width, mask.height == image.height else {
            throw CutoutError.unsupportedMaskFormat
        }
        guard mask.pixels.contains(where: { $0 != 0 }) else { throw CutoutError.noForegroundSubjects }
        return (mask, observation.allInstances.count)
    }

    /// The canonical surface PNG: signature, IHDR (8-bit grayscale, color
    /// type 0, not interlaced), one IDAT and IEND, nothing else (no tRNS,
    /// acTL, color profile or EXIF). Every row has filter 0 and the stream is
    /// zlib (deflate of Apple's Compression), so the same pixels give the
    /// same bytes on the same macOS. The bytes are not the Rust encoder's
    /// (`encode_surface_png`); the id is whatever these bytes hash to.
    public static func encodePNG(_ mask: MaskRaster) throws -> Data {
        guard mask.width <= maxSide, mask.height <= maxSide else { throw CutoutError.invalidImageDimensions }
        var scanlines = Data(capacity: (mask.width + 1) * mask.height)
        let start = mask.pixels.startIndex
        for y in 0..<mask.height {
            scanlines.append(0)
            scanlines.append(mask.pixels[(start + y * mask.width)..<(start + (y + 1) * mask.width)])
        }
        var header = Data()
        header.appendBigEndian(UInt32(mask.width))
        header.appendBigEndian(UInt32(mask.height))
        // depth 8, color type 0 (gray), deflate, adaptive filtering, no interlace
        header.append(contentsOf: [8, 0, 0, 0, 0])
        var png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        png.appendChunk("IHDR", header)
        png.appendChunk("IDAT", try zlib(scanlines))
        png.appendChunk("IEND", Data())
        guard png.count <= maxPNGBytes else { throw CutoutError.encodingFailed(URL(fileURLWithPath: "surface.png")) }
        return png
    }

    private static func sRGBA8(_ image: CGImage) throws -> CGImage {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                data: nil,
                width: image.width,
                height: image.height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: space,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              )
        else { throw CutoutError.invalidImageDimensions }
        context.interpolationQuality = .none
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard let result = context.makeImage() else { throw CutoutError.invalidImageDimensions }
        return result
    }

    /// RFC 1950: a two-byte header, the raw deflate stream and the Adler-32
    /// of the input.
    private static func zlib(_ input: Data) throws -> Data {
        let capacity = input.count + input.count / 64 + 1024
        var deflated = Data(count: capacity)
        let written = deflated.withUnsafeMutableBytes { output in
            input.withUnsafeBytes { source in
                compression_encode_buffer(
                    output.bindMemory(to: UInt8.self).baseAddress!,
                    capacity,
                    source.bindMemory(to: UInt8.self).baseAddress!,
                    input.count,
                    nil,
                    COMPRESSION_ZLIB
                )
            }
        }
        guard written > 0 else { throw CutoutError.encodingFailed(URL(fileURLWithPath: "surface.png")) }
        var stream = Data([0x78, 0x5E])
        stream.append(deflated.prefix(written))
        stream.appendBigEndian(adler32(input))
        return stream
    }

    static func adler32(_ data: Data) -> UInt32 {
        var a: UInt32 = 1
        var b: UInt32 = 0
        data.withUnsafeBytes { bytes in
            // 5552 bytes keep b below 2^32 before the modulo.
            var index = 0
            while index < bytes.count {
                let end = min(index + 5552, bytes.count)
                for byte in bytes[index..<end] {
                    a += UInt32(byte)
                    b += a
                }
                a %= 65521
                b %= 65521
                index = end
            }
        }
        return (b << 16) | a
    }

    /// CRC-32 (ISO 3309, PNG's) of the parts one after another.
    static func crc32(_ parts: Data...) -> UInt32 {
        var crc: UInt32 = 0xFFFF_FFFF
        for part in parts {
            for byte in part {
                crc = crcTable[Int((crc ^ UInt32(byte)) & 0xFF)] ^ (crc >> 8)
            }
        }
        return crc ^ 0xFFFF_FFFF
    }

    private static let crcTable: [UInt32] = (0..<256).map { index in
        var value = UInt32(index)
        for _ in 0..<8 {
            value = (value & 1) != 0 ? 0xEDB8_8320 ^ (value >> 1) : value >> 1
        }
        return value
    }
}

private extension Data {
    mutating func appendBigEndian(_ value: UInt32) {
        append(contentsOf: [UInt8(value >> 24), UInt8((value >> 16) & 0xFF), UInt8((value >> 8) & 0xFF), UInt8(value & 0xFF)])
    }

    mutating func appendChunk(_ type: String, _ body: Data) {
        let typeBytes = Data(type.utf8)
        appendBigEndian(UInt32(body.count))
        append(typeBytes)
        append(body)
        appendBigEndian(MaskSurface.crc32(typeBytes, body))
    }
}
