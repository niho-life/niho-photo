import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import NihoCameraCutout

// niho-camera-cutout — see README.md for the contract.
// One-shot form: one summary line on stdout; one error line on stderr, exit 1.
// detect / compose / surface: one JSON line on stdout, also for errors (exit 1–4).

func runCutout(_ options: Options) async throws {
    let started = ContinuousClock.now
    let inputData: Data
    do {
        inputData = try Data(contentsOf: options.input, options: .mappedIfSafe)
    } catch {
        throw CutoutError.unreadableInput(options.input)
    }
    let detector = CutoutDetector()
    let result = try await detector.detect(data: inputData, sourceURL: options.input)
    let selection: CutoutSubjectSelection
    switch options.selection {
    case .largest: selection = result.largestSelection
    case .all: selection = .all
    case let .instance(id): selection = .instance(id)
    }
    guard let mask = result.masks.first(where: { $0.selection == selection }) else {
        throw CLIError.unknownSubject(selection.storageKey)
    }
    guard let source = CGImageSourceCreateWithData(inputData as CFData, nil),
          let sourceImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { throw CutoutError.unreadableInput(options.input) }
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    let exifProperties = properties?[kCGImagePropertyExifDictionary] as? [CFString: Any]
    let captureDateTimeOriginal = exifProperties?[kCGImagePropertyExifDateTimeOriginal] as? String
    let raw = (properties?[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1
    let orientation = CGImagePropertyOrientation(rawValue: raw) ?? .up
    let normalized = CIImage(cgImage: sourceImage).oriented(orientation)
    let composer = CutoutComposer()
    let size = try composer.export(
        image: normalized,
        maskPNGData: mask.pngData,
        background: options.background,
        destination: options.output,
        format: try .inferred(from: options.output, jpegQuality: options.jpegQuality),
        captureDateTimeOriginal: captureDateTimeOriginal,
        protectedSourceURLs: [options.input]
    )
    let elapsed = started.duration(to: .now)
    let components = elapsed.components
    let milliseconds = Double(components.seconds) * 1_000
        + Double(components.attoseconds) / 1_000_000_000_000_000
    print("\(Int(size.width))x\(Int(size.height)) subject=\(selection.storageKey) \(String(format: "%.0f", milliseconds))ms -> \(options.output.path)")
}

func emit(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

let arguments = Array(CommandLine.arguments.dropFirst())
let machineReadable = ["detect", "compose", "surface"].contains(arguments.first)
do {
    switch try Command.parse(arguments) {
    case .help: print(Command.usage)
    case .version: print("\(Tool.name) \(Tool.version)")
    case let .detect(options): emit(JSONLine.encode(try await DetectCommand.run(options)))
    case let .compose(options): emit(JSONLine.encode(try ComposeCommand.run(options)))
    case let .surface(options): emit(JSONLine.encode(try SurfaceCommand.run(options)))
    case let .cutout(options): try await runCutout(options)
    }
} catch {
    if machineReadable {
        let failure = ToolFailure.from(error)
        emit(failure.jsonLine)
        exit(failure.exitCode)
    }
    FileHandle.standardError.write(Data("\(Tool.name): \(error.localizedDescription)\n".utf8))
    exit(EXIT_FAILURE)
}
