import CoreGraphics
import Foundation
import ImageIO
@testable import NihoCameraCutout
@testable import NihoCameraCutoutCLI
import Testing
import UniformTypeIdentifiers

/// `surface` without Vision: the arguments, the canonical PNG, the working
/// image it detects on (orientation, never larger than --max-side) and the
/// failures that come before detection. Vision runs in VisionEndToEndTests.
struct SurfaceTests {
    @Test func parsesSurface() throws {
        let command = try Command.parse(["surface", "--input", "w.png", "--output", "s.png", "--kind", "subject"])
        guard case let .surface(options) = command else {
            Issue.record("\(command)")
            return
        }
        #expect(options.input.lastPathComponent == "w.png")
        #expect(options.output.lastPathComponent == "s.png")
        #expect(options.kind == .subject)
        #expect(options.maxSide == 4096)
        let sky = try SurfaceOptions(arguments: ["--input", "a", "--output", "b", "--kind", "sky", "--max-side", "1"])
        #expect(sky.kind == .sky && sky.maxSide == 1)
    }

    @Test func surfaceArgumentsAreStrict() {
        #expect(throws: CLIError.missingOption("--kind")) {
            try Command.parse(["surface", "--input", "a", "--output", "b"])
        }
        #expect(throws: CLIError.invalidKind("person")) {
            try SurfaceOptions(arguments: ["--input", "a", "--output", "b", "--kind", "person"])
        }
        for side in ["0", "4097", "-1", "big"] {
            #expect(throws: CLIError.invalidMaxSide(side)) {
                try SurfaceOptions(arguments: ["--input", "a", "--output", "b", "--kind", "subject", "--max-side", side])
            }
        }
        #expect(throws: CLIError.unknownOption("--masks-dir")) {
            try SurfaceOptions(arguments: ["--input", "a", "--output", "b", "--kind", "subject", "--masks-dir", "m"])
        }
    }

    @Test func checksumsAreZlibsAndPNGs() {
        #expect(MaskSurface.adler32(Data("Wikipedia".utf8)) == 0x11E6_0398)
        #expect(MaskSurface.crc32(Data("IEND".utf8)) == 0xAE42_6082)
        // Many bytes: the running sums are reduced before they overflow.
        #expect(MaskSurface.adler32(Data(repeating: 0xFF, count: 100_000)) == 0x149A_302C)
    }

    @Test func thePNGIsCanonical() throws {
        let width = 37
        let height = 5
        let pixels = Data((0..<(width * height)).map { UInt8(($0 * 7) % 256) })
        let mask = try MaskRaster(width: width, height: height, pixels: pixels)
        let png = try MaskSurface.encodePNG(mask)
        #expect(try MaskSurface.encodePNG(mask) == png)
        #expect(Array(png.prefix(8)) == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

        let chunks = try readChunks(png)
        #expect(chunks.map(\.type) == ["IHDR", "IDAT", "IEND"])
        let header = Array(chunks[0].body)
        #expect(header == [0, 0, 0, 37, 0, 0, 0, 5, 8, 0, 0, 0, 0])
        #expect(chunks[2].body.isEmpty)

        // ImageIO reads it as plain 8-bit gray with the same bytes.
        #expect(try MaskRaster(pngData: png).pixels == pixels)
        let source = try #require(CGImageSourceCreateWithData(png as CFData, nil))
        let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
        #expect(image.bitsPerPixel == 8 && image.bitsPerComponent == 8)
        #expect(image.alphaInfo == .none)
        #expect(image.colorSpace?.model == .monochrome)
    }

    @Test func aWideMaskIsRefused() throws {
        let mask = try MaskRaster(width: 4097, height: 1, pixels: Data(count: 4097))
        #expect(throws: CutoutError.invalidImageDimensions) { try MaskSurface.encodePNG(mask) }
    }

    @Test func theInputIsTurnedUprightAndNeverLargerThanTheMaxSide() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        // Stored 40×20, left half red and right half blue, EXIF orientation 6
        // (shown turned a quarter clockwise): upright it is 20×40, red on top.
        let turned = root.appendingPathComponent("turned.jpg")
        try writeHalves(turned, width: 40, height: 20, orientation: 6)
        let loaded = try MaskSurface.loadInput(turned)
        #expect(loaded.image.width == 20 && loaded.image.height == 40)
        #expect(loaded.sourceWidth == 20 && loaded.sourceHeight == 40)
        let pixels = try rgba8(loaded.image)
        let top = pixel(pixels, width: 20, x: 10, y: 5)
        let bottom = pixel(pixels, width: 20, x: 10, y: 35)
        #expect(top.red > 200 && top.blue < 60)
        #expect(bottom.blue > 200 && bottom.red < 60)

        let large = root.appendingPathComponent("large.png")
        try writeHalves(large, width: 300, height: 200, orientation: nil)
        let shrunk = try MaskSurface.loadInput(large, maxSide: 150)
        #expect(shrunk.image.width == 150 && shrunk.image.height == 100)
        #expect(shrunk.sourceWidth == 300 && shrunk.sourceHeight == 200)
        let same = try MaskSurface.loadInput(large)
        #expect(same.image.width == 300 && same.image.height == 200)
    }

    @Test func failuresBeforeDetectionMapToCodes() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let input = root.appendingPathComponent("input.png")
        try writeHalves(input, width: 8, height: 6, orientation: nil)
        func failure(_ arguments: [String]) -> ToolFailure? {
            do {
                _ = try SurfaceCommand.run(try SurfaceOptions(arguments: arguments))
                return nil
            } catch {
                return ToolFailure.from(error)
            }
        }
        let output = root.appendingPathComponent("surface.png").path
        let sky = failure(["--input", input.path, "--output", output, "--kind", "sky"])
        #expect(sky?.code == "unsupported_kind" && sky?.exitCode == 2)
        let missing = failure(["--input", root.appendingPathComponent("none.png").path, "--output", output, "--kind", "subject"])
        #expect(missing?.code == "input_unreadable" && missing?.exitCode == 3)
        let existing = failure(["--input", input.path, "--output", input.path, "--kind", "subject"])
        #expect(existing?.code == "destination_exists" && existing?.exitCode == 4)
        let directory = failure(["--input", input.path, "--output", root.path, "--kind", "subject"])
        #expect(directory?.code == "destination_is_directory" && directory?.exitCode == 4)
        #expect(!FileManager.default.fileExists(atPath: output))
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).sorted() == ["input.png"])
    }

    // MARK: - helpers

    private func readChunks(_ png: Data) throws -> [(type: String, body: Data)] {
        var chunks: [(type: String, body: Data)] = []
        var offset = png.startIndex + 8
        func be32(_ at: Int) -> UInt32 {
            png[at..<(at + 4)].reduce(0) { ($0 << 8) | UInt32($1) }
        }
        while offset < png.endIndex {
            let length = Int(be32(offset))
            let typeBytes = png[(offset + 4)..<(offset + 8)]
            let body = png[(offset + 8)..<(offset + 8 + length)]
            #expect(be32(offset + 8 + length) == MaskSurface.crc32(Data(typeBytes), Data(body)))
            chunks.append((try #require(String(data: typeBytes, encoding: .ascii)), Data(body)))
            offset += 12 + length
        }
        #expect(offset == png.endIndex)
        return chunks
    }

    private func temporaryDirectory() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("CutoutSurfaceTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    /// Left half red, right half blue; PNG or JPEG by the extension, with an
    /// EXIF orientation when given.
    private func writeHalves(_ url: URL, width: Int, height: Int, orientation: Int?) throws {
        let space = try #require(CGColorSpace(name: CGColorSpace.sRGB))
        let context = try #require(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        context.setFillColor(CGColor(srgbRed: 1, green: 0, blue: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width / 2, height: height))
        context.setFillColor(CGColor(srgbRed: 0, green: 0, blue: 1, alpha: 1))
        context.fill(CGRect(x: width / 2, y: 0, width: width - width / 2, height: height))
        let image = try #require(context.makeImage())
        let type = url.pathExtension == "jpg" ? UTType.jpeg : UTType.png
        let destination = try #require(CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil))
        var properties: [CFString: Any] = [:]
        if let orientation { properties[kCGImagePropertyOrientation] = orientation }
        if type == .jpeg { properties[kCGImageDestinationLossyCompressionQuality] = 1.0 }
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
    }

    private func rgba8(_ image: CGImage) throws -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
        let space = try #require(CGColorSpace(name: CGColorSpace.sRGB))
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
                bytesPerRow: image.width * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            return true
        }
        try #require(drawn)
        return bytes
    }

    /// Top-left origin (the bitmap's first row is the image's top).
    private func pixel(_ bytes: [UInt8], width: Int, x: Int, y: Int) -> (red: UInt8, blue: UInt8) {
        let index = (y * width + x) * 4
        return (bytes[index], bytes[index + 2])
    }
}
