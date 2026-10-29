import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import NihoCameraCutout

/// `detect` / `compose` answer with one JSON line on stdout, and fail with one
/// `{"error":"<code>","message":"..."}` line and an exit code by kind (README
/// 「機械が読む契約」). The caller shows its own words for `error`; `message` is
/// for logs.
struct ToolFailure: Error, Equatable {
    let code: String
    let message: String
    let exitCode: Int32

    /// 1: the call itself is wrong. 2: this photo / this Mac cannot be cut
    /// out. 3: an input is unreadable or does not match. 4: the output.
    static func from(_ error: Error) -> ToolFailure {
        if let failure = error as? ToolFailure { return failure }
        let message = (error as? LocalizedError)?.errorDescription ?? describe(error)
        if let cli = error as? CLIError {
            switch cli {
            case .unknownSubject: return ToolFailure(code: "unknown_subject", message: message, exitCode: 1)
            case .invalidStrokes: return ToolFailure(code: "invalid_strokes", message: message, exitCode: 1)
            default: return ToolFailure(code: "invalid_arguments", message: message, exitCode: 1)
            }
        }
        if let cutout = error as? CutoutError {
            switch cutout {
            case .unsupportedOutput: return ToolFailure(code: "unsupported_output", message: message, exitCode: 1)
            case .noForegroundSubjects: return ToolFailure(code: "no_subjects", message: message, exitCode: 2)
            case .unsupportedMaskFormat: return ToolFailure(code: "engine_failed", message: message, exitCode: 2)
            case .unreadableInput: return ToolFailure(code: "input_unreadable", message: message, exitCode: 3)
            case .invalidImageDimensions: return ToolFailure(code: "invalid_image", message: message, exitCode: 3)
            case .corruptMask: return ToolFailure(code: "corrupt_mask", message: message, exitCode: 3)
            case .destinationExists: return ToolFailure(code: "destination_exists", message: message, exitCode: 4)
            case .destinationIsDirectory: return ToolFailure(code: "destination_is_directory", message: message, exitCode: 4)
            case .sourceOverwriteForbidden: return ToolFailure(code: "source_overwrite", message: message, exitCode: 4)
            case .encodingFailed: return ToolFailure(code: "encode_failed", message: message, exitCode: 4)
            }
        }
        let nsError = error as NSError
        if nsError.domain == "com.apple.Vision" || nsError.domain == "VNErrorDomain" {
            return ToolFailure(code: "engine_failed", message: describe(error), exitCode: 2)
        }
        // Inputs are checked up front (requireReadable), so what is left of the
        // file system errors comes from writing the masks or the output.
        if nsError.domain == NSCocoaErrorDomain || nsError.domain == NSPOSIXErrorDomain {
            return ToolFailure(code: "write_failed", message: describe(error), exitCode: 4)
        }
        return ToolFailure(code: "internal_error", message: describe(error), exitCode: 1)
    }

    var jsonLine: String {
        JSONLine.encode(["error": code, "message": message])
    }

    /// `domain code`: OS messages change with the system language.
    private static func describe(_ error: Error) -> String {
        let nsError = error as NSError
        return "\(nsError.domain) error \(nsError.code)"
    }
}

enum JSONLine {
    static func encode(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(
            withJSONObject: object,
            options: [.sortedKeys, .withoutEscapingSlashes]
        ), let text = String(data: data, encoding: .utf8) else {
            return #"{"error":"internal_error","message":"JSON encoding failed"}"#
        }
        return text
    }
}

enum DetectCommand {
    /// Masks go to `<masks-dir>/<mask SHA-256>.png`. A file of that name that
    /// already has those bytes is kept (the same photo detected again); one
    /// that does not is replaced.
    static func run(_ options: DetectOptions) async throws -> [String: Any] {
        let started = ContinuousClock.now
        try requireReadable(options.input)
        let inputData: Data
        do {
            inputData = try Data(contentsOf: options.input)
        } catch {
            throw CutoutError.unreadableInput(options.input)
        }
        let result = try await CutoutDetector().detect(data: inputData, sourceURL: options.input)
        try FileManager.default.createDirectory(at: options.masksDirectory, withIntermediateDirectories: true)
        var subjects: [[String: Any]] = []
        for mask in result.masks {
            let digest = CutoutHash.sha256(mask.pngData)
            try writeImmutable(mask.pngData, digest: digest, in: options.masksDirectory)
            subjects.append([
                "selection": mask.selection.storageKey,
                "pixelCount": mask.pixelCount,
                "mask": "\(digest).png",
                "maskSHA256": digest,
                // Vision scales every mask to the (oriented) image.
                "maskWidth": result.width,
                "maskHeight": result.height,
            ])
        }
        return [
            "schemaVersion": CutoutMaskReference.currentSchemaVersion,
            "engine": CutoutMaskReference.engineIdentifier,
            "engineRevision": CutoutMaskReference.engineRevision,
            "width": result.width,
            "height": result.height,
            "inputSHA256": result.inputSHA256,
            "sourceOrientation": try sourceOrientation(inputData, sourceURL: options.input),
            "largest": result.largestSelection.storageKey,
            "subjects": subjects,
            "durationMs": milliseconds(since: started),
        ]
    }

    private static func writeImmutable(_ data: Data, digest: String, in directory: URL) throws {
        let destination = directory.appendingPathComponent("\(digest).png")
        if let existing = try? Data(contentsOf: destination), CutoutHash.sha256(existing) == digest { return }
        let temporary = directory.appendingPathComponent(".\(digest).partial-\(getpid())")
        defer { try? FileManager.default.removeItem(at: temporary) }
        try data.write(to: temporary)
        guard rename(temporary.path, destination.path) == 0 else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: destination.path])
        }
    }

    static func sourceOrientation(_ data: Data, sourceURL: URL) throws -> Int {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { throw CutoutError.unreadableInput(sourceURL) }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        return (properties?[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
    }
}

enum ComposeCommand {
    /// The mask must have the image's aspect ratio (it was detected on the
    /// same frame). A crop or a quarter turn in between is refused instead of
    /// stretching the mask over a different picture.
    static let aspectTolerance = 0.01

    static func run(_ options: ComposeOptions) throws -> [String: Any] {
        let started = ContinuousClock.now
        try requireReadable(options.input)
        let maskData: Data
        do {
            maskData = try Data(contentsOf: options.mask)
        } catch {
            throw CutoutError.corruptMask("マスクを読めません: \(options.mask.path)")
        }
        if let expected = options.maskSHA256, CutoutHash.sha256(maskData) != expected {
            throw CutoutError.corruptMask("SHA-256 が違います: \(options.mask.lastPathComponent)")
        }
        let mask = try MaskRaster(pngData: maskData)
        let strokes = try options.strokes.map(readStrokes) ?? []
        let image = try orientedImage(options.input)
        let extent = image.extent.integral
        let imageAspect = extent.width / extent.height
        let maskAspect = Double(mask.width) / Double(mask.height)
        guard abs(imageAspect / maskAspect - 1) <= aspectTolerance else {
            throw ToolFailure(
                code: "mask_mismatch",
                message: "マスク（\(mask.width)x\(mask.height)）と画像（\(Int(extent.width))x\(Int(extent.height))）の縦横比が違います",
                exitCode: 3
            )
        }
        let format = try CutoutOutputFormat.inferred(from: options.output, jpegQuality: options.jpegQuality)
        let size = try CutoutComposer().export(
            image: image,
            maskPNGData: maskData,
            background: options.background,
            brushStrokes: strokes,
            destination: options.output,
            format: format,
            protectedSourceURLs: [options.input, options.mask]
        )
        let formatName: String
        switch format {
        case .png: formatName = "png"
        case .jpeg: formatName = "jpeg"
        }
        return [
            "width": Int(size.width),
            "height": Int(size.height),
            "format": formatName,
            "output": options.output.path,
            "strokes": strokes.count,
            "durationMs": milliseconds(since: started),
        ]
    }

    /// `[{"mode":"erase"|"restore","radius":0.05,"points":[{"x":0.5,"y":0.5}]}]`
    /// (CutoutBrushStroke). Top-left origin, normalized to the image (points
    /// in -1...2, so a drag past the edge is kept); the radius is a fraction
    /// of the shorter edge.
    static func readStrokes(_ url: URL) throws -> [CutoutBrushStroke] {
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            throw CLIError.invalidStrokes("ファイルを読めません: \(url.path)")
        }
        let strokes: [CutoutBrushStroke]
        do {
            strokes = try JSONDecoder().decode([CutoutBrushStroke].self, from: data)
        } catch {
            throw CLIError.invalidStrokes("JSON の形が違います")
        }
        for (index, stroke) in strokes.enumerated() {
            guard stroke.radius.isFinite, stroke.radius > 0, stroke.radius <= 1 else {
                throw CLIError.invalidStrokes("\(index) 本目の radius は 0 より大きく 1 以下にしてください")
            }
            // Past the edge is fine (the brush may leave the photo while
            // dragging); far outside is a broken file.
            guard stroke.points.allSatisfy({ (-1...2).contains($0.x) && (-1...2).contains($0.y) }) else {
                throw CLIError.invalidStrokes("\(index) 本目の点は -1〜2 の範囲にしてください")
            }
        }
        return strokes
    }

    private static func orientedImage(_ url: URL) throws -> CIImage {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let sourceImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { throw CutoutError.unreadableInput(url) }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        let raw = (properties?[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1
        let orientation = CGImagePropertyOrientation(rawValue: raw) ?? .up
        return CIImage(cgImage: sourceImage).oriented(orientation)
    }
}

enum SurfaceCommand {
    /// The output is a new file (never over an existing one, the input or a
    /// symlink): the PNG goes to a hidden file in the same folder and is
    /// linked into place. `sky` has no detector yet (`unsupported_kind`, 2).
    static func run(_ options: SurfaceOptions) throws -> [String: Any] {
        let started = ContinuousClock.now
        try requireReadable(options.input)
        guard options.kind == .subject else {
            throw ToolFailure(
                code: "unsupported_kind",
                message: "この版は \(options.kind.rawValue) の面を作れません",
                exitCode: 2
            )
        }
        try requireNew(options.output)
        let loaded = try MaskSurface.loadInput(options.input, maxSide: options.maxSide)
        let detected = try MaskSurface.detectForeground(loaded.image)
        let png = try MaskSurface.encodePNG(detected.mask)
        try install(png, at: options.output)
        return [
            "kind": options.kind.rawValue,
            "engine": CutoutMaskReference.engineIdentifier,
            "engineRevision": CutoutMaskReference.engineRevision,
            "width": detected.mask.width,
            "height": detected.mask.height,
            "sourceWidth": loaded.sourceWidth,
            "sourceHeight": loaded.sourceHeight,
            "subjects": detected.subjects,
            "surfaceSHA256": CutoutHash.sha256(png),
            "bytes": png.count,
            "durationMs": milliseconds(since: started),
        ]
    }

    private static func requireNew(_ destination: URL) throws {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: destination.path, isDirectory: &isDirectory) else { return }
        if isDirectory.boolValue { throw CutoutError.destinationIsDirectory(destination) }
        throw CutoutError.destinationExists(destination)
    }

    private static func install(_ data: Data, at destination: URL) throws {
        let directory = destination.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let temporary = directory.appendingPathComponent(".\(UUID().uuidString)-\(destination.lastPathComponent)")
        defer { try? FileManager.default.removeItem(at: temporary) }
        try data.write(to: temporary)
        // link(2) never replaces a file and refuses an existing symlink.
        guard Darwin.link(temporary.path, destination.path) == 0 else {
            if errno == EEXIST { throw CutoutError.destinationExists(destination) }
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: destination.path])
        }
    }
}

/// Up front, so a missing input is `input_unreadable` (3) and not an OS
/// error from deep inside ImageIO or the hash stream.
func requireReadable(_ url: URL) throws {
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory),
          !isDirectory.boolValue,
          FileManager.default.isReadableFile(atPath: url.path)
    else { throw CutoutError.unreadableInput(url) }
}

func milliseconds(since started: ContinuousClock.Instant) -> Int {
    let components = started.duration(to: .now).components
    return Int((Double(components.seconds) * 1_000
        + Double(components.attoseconds) / 1_000_000_000_000_000).rounded())
}
