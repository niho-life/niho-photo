import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import NihoCameraCutout
@testable import NihoCameraCutoutCLI
import Testing
import UniformTypeIdentifiers

/// Runs Apple Vision for real on a synthetic photo (a shaded object on a
/// plain wall; no personal photo in Git). Opt-in with NIHO_CUTOUT_E2E=1 so a
/// plain `swift test` never depends on the Mac's foreground model; the CI
/// (niho-camera-cutout.yml) runs it on GitHub's macOS runner as its own step.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["NIHO_CUTOUT_E2E"] == "1"))
struct VisionEndToEndTests {
    @Test func detectsTheObjectAndExportsATransparentPNG() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("CutoutVisionTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let input = root.appendingPathComponent("object.png")
        try writeSyntheticPhoto(to: input, width: 640, height: 480)
        let inputData = try Data(contentsOf: input, options: .mappedIfSafe)
        let inputHash = CutoutHash.sha256(inputData)

        let result = try await CutoutDetector().detect(data: inputData, sourceURL: input)
        #expect(result.width == 640 && result.height == 480)
        #expect(result.inputSHA256 == inputHash)
        let largest = try #require(result.masks.first { $0.selection == result.largestSelection })
        #expect(result.masks.contains { $0.selection == .all })
        let mask = try MaskRaster(pngData: largest.pngData)
        #expect(mask.width == 640 && mask.height == 480)
        // Top-left origin: the object is in the middle, the wall in the corners.
        #expect(mask.pixels[240 * 640 + 320] > 200)
        #expect(mask.pixels[8 * 640 + 8] < 30)
        #expect(mask.pixels[470 * 640 + 630] < 30)

        let output = root.appendingPathComponent("cutout.png")
        let image = try #require(CIImage(data: inputData))
        let size = try CutoutComposer().export(
            image: image,
            maskPNGData: largest.pngData,
            background: .transparent,
            destination: output,
            format: .png,
            protectedSourceURLs: [input]
        )
        #expect(size == CGSize(width: 640, height: 480))
        let alpha = try alphaChannel(output)
        #expect(alpha[240 * 640 + 320] > 200)
        #expect(alpha[8 * 640 + 8] < 30)
        #expect(try CutoutHash.sha256(fileURL: input) == inputHash)
    }

    @Test func detectKeepsEveryMaskOnceAndComposeUsesIt() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("CutoutDetectTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let input = root.appendingPathComponent("object.png")
        try writeSyntheticPhoto(to: input, width: 640, height: 480)
        let masks = root.appendingPathComponent("masks", isDirectory: true)
        let options = try DetectOptions(arguments: ["--input", input.path, "--masks-dir", masks.path])

        let first = try await DetectCommand.run(options)
        #expect(first["width"] as? Int == 640 && first["height"] as? Int == 480)
        #expect(first["engine"] as? String == "VNGenerateForegroundInstanceMaskRequest")
        #expect(first["inputSHA256"] as? String == (try CutoutHash.sha256(fileURL: input)))
        let subjects = try #require(first["subjects"] as? [[String: Any]])
        let largest = try #require(first["largest"] as? String)
        let chosen = try #require(subjects.first { $0["selection"] as? String == largest })
        #expect(subjects.contains { $0["selection"] as? String == "all" })
        let file = try #require(chosen["mask"] as? String)
        let digest = try #require(chosen["maskSHA256"] as? String)
        #expect(file == "\(digest).png")
        let maskURL = masks.appendingPathComponent(file)
        #expect(CutoutHash.sha256(try Data(contentsOf: maskURL)) == digest)

        // The same photo again: the same files, nothing half-written left.
        let modified = try FileManager.default.attributesOfItem(atPath: maskURL.path)[.modificationDate] as? Date
        let second = try await DetectCommand.run(options)
        #expect((second["subjects"] as? [[String: Any]])?.count == subjects.count)
        #expect(try FileManager.default.attributesOfItem(atPath: maskURL.path)[.modificationDate] as? Date == modified)
        #expect(try FileManager.default.contentsOfDirectory(atPath: masks.path).allSatisfy { !$0.hasPrefix(".") })

        let output = root.appendingPathComponent("cutout.png")
        let summary = try ComposeCommand.run(try ComposeOptions(arguments: [
            "--input", input.path, "--mask", maskURL.path, "--mask-sha256", digest, "--output", output.path,
        ]))
        #expect(summary["width"] as? Int == 640)
        let alpha = try alphaChannel(output)
        #expect(alpha[240 * 640 + 320] > 200 && alpha[8 * 640 + 8] < 30)
    }

    /// `surface` (niho-photo#135): every subject in one canonical gray PNG of
    /// the working image's frame, shrunk to --max-side.
    @Test func surfaceIsTheForegroundOfTheWorkingImage() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("CutoutSurfaceE2E-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let input = root.appendingPathComponent("object.png")
        try writeSyntheticPhoto(to: input, width: 640, height: 480)
        let output = root.appendingPathComponent("surface.png")

        let summary = try SurfaceCommand.run(try SurfaceOptions(arguments: [
            "--input", input.path, "--output", output.path, "--kind", "subject", "--max-side", "320",
        ]))
        #expect(summary["kind"] as? String == "subject")
        #expect(summary["width"] as? Int == 320 && summary["height"] as? Int == 240)
        #expect(summary["sourceWidth"] as? Int == 640 && summary["sourceHeight"] as? Int == 480)
        #expect((summary["subjects"] as? Int ?? 0) >= 1)
        let png = try Data(contentsOf: output)
        #expect(summary["surfaceSHA256"] as? String == CutoutHash.sha256(png))
        #expect(summary["bytes"] as? Int == png.count)
        let surface = try MaskRaster(pngData: png)
        #expect(surface.width == 320 && surface.height == 240)
        // Top-left origin: the vase in the middle, the wall in the corners.
        #expect(surface.pixels[120 * 320 + 160] > 200)
        #expect(surface.pixels[4 * 320 + 4] < 30)
        #expect(surface.pixels[235 * 320 + 315] < 30)
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).sorted() == ["object.png", "surface.png"])

        // Never over an existing file.
        #expect(throws: CutoutError.destinationExists(output)) {
            try SurfaceCommand.run(try SurfaceOptions(arguments: [
                "--input", input.path, "--output", output.path, "--kind", "subject",
            ]))
        }
    }

    /// A warm wall with a soft gradient and a shaded dark-blue vase in front.
    private func writeSyntheticPhoto(to url: URL, width: Int, height: Int) throws {
        let space = try #require(CGColorSpace(name: CGColorSpace.sRGB))
        let context = try #require(CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: space,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        let wall = try #require(CGGradient(
            colorsSpace: space,
            colors: [
                CGColor(srgbRed: 0.93, green: 0.90, blue: 0.84, alpha: 1),
                CGColor(srgbRed: 0.80, green: 0.76, blue: 0.70, alpha: 1),
            ] as CFArray,
            locations: [0, 1]
        ))
        context.drawLinearGradient(
            wall,
            start: CGPoint(x: 0, y: CGFloat(height)),
            end: .zero,
            options: []
        )
        let body = CGRect(x: 220, y: 90, width: 200, height: 300)
        context.saveGState()
        context.addEllipse(in: body)
        context.addRect(CGRect(x: 280, y: 360, width: 80, height: 60))
        context.clip()
        let vase = try #require(CGGradient(
            colorsSpace: space,
            colors: [
                CGColor(srgbRed: 0.25, green: 0.38, blue: 0.70, alpha: 1),
                CGColor(srgbRed: 0.06, green: 0.10, blue: 0.25, alpha: 1),
            ] as CFArray,
            locations: [0, 1]
        ))
        context.drawRadialGradient(
            vase,
            startCenter: CGPoint(x: 290, y: 300),
            startRadius: 10,
            endCenter: CGPoint(x: 320, y: 240),
            endRadius: 200,
            options: [.drawsAfterEndLocation]
        )
        context.restoreGState()
        let image = try #require(context.makeImage())
        let destination = try #require(CGImageDestinationCreateWithURL(
            url as CFURL,
            UTType.png.identifier as CFString,
            1,
            nil
        ))
        CGImageDestinationAddImage(destination, image, nil)
        #expect(CGImageDestinationFinalize(destination))
    }

    /// Straight (unpremultiplied) alpha, top-left origin, one byte per pixel.
    private func alphaChannel(_ url: URL) throws -> [UInt8] {
        let source = try #require(CGImageSourceCreateWithURL(url as CFURL, nil))
        let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
        var alpha = [UInt8](repeating: 0, count: image.width * image.height)
        let rendered = alpha.withUnsafeMutableBytes { bytes -> Bool in
            guard let context = CGContext(
                data: bytes.baseAddress,
                width: image.width,
                height: image.height,
                bitsPerComponent: 8,
                bytesPerRow: image.width,
                space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.alphaOnly.rawValue
            ) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            return true
        }
        try #require(rendered)
        return alpha
    }
}
