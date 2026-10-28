import Foundation
import NihoCameraCutout

enum Command: Equatable {
    case help
    case version
    case detect(DetectOptions)
    case compose(ComposeOptions)
    case surface(SurfaceOptions)
    case cutout(Options)

    static let usage = """
        usage: niho-camera-cutout --input PATH --output PATH [--subject largest|all|ID] [--background transparent|white|#RRGGBB] [--jpeg-quality 0...1]
               niho-camera-cutout detect --input PATH --masks-dir DIR
               niho-camera-cutout compose --input PATH --mask PATH --output PATH [--mask-sha256 HEX] [--background transparent|white|#RRGGBB] [--strokes FILE.json] [--jpeg-quality 0...1]
               niho-camera-cutout surface --input PATH --output PATH --kind subject|sky [--max-side 1...4096]
               niho-camera-cutout version | help
        """

    /// `help` / `version` only as the sole argument, so a path named
    /// "version" after `--input` still parses as a path. `detect` /
    /// `compose` / `surface` only as the first argument (the one-shot form
    /// starts with a flag).
    static func parse(_ arguments: [String]) throws -> Command {
        if arguments.count == 1 {
            switch arguments[0] {
            case "-h", "--help", "help": return .help
            case "-V", "--version", "version": return .version
            default: break
            }
        }
        switch arguments.first {
        case "detect": return .detect(try DetectOptions(arguments: Array(arguments.dropFirst())))
        case "compose": return .compose(try ComposeOptions(arguments: Array(arguments.dropFirst())))
        case "surface": return .surface(try SurfaceOptions(arguments: Array(arguments.dropFirst())))
        default: return .cutout(try Options(arguments: arguments))
        }
    }
}

/// The one-shot form (Photo Bench's CLI, unchanged): detect, pick a subject
/// and export in one run.
struct Options: Equatable {
    enum Selection: Equatable { case largest, all, instance(Int) }
    let input: URL
    let output: URL
    let selection: Selection
    let background: CutoutBackground
    let jpegQuality: Double

    init(arguments: [String]) throws {
        var input: String?
        var output: String?
        var selection: Selection = .largest
        var background: CutoutBackground = .transparent
        var jpegQuality = 0.92
        var index = 0
        while index < arguments.count {
            let flag = arguments[index]
            guard index + 1 < arguments.count else { throw CLIError.usage }
            let value = arguments[index + 1]
            switch flag {
            case "--input", "-i": input = value
            case "--output", "-o": output = value
            case "--subject":
                if value == "largest" { selection = .largest }
                else if value == "all" { selection = .all }
                else if let id = Int(value), id > 0 { selection = .instance(id) }
                else { throw CLIError.invalidSubject(value) }
            case "--background": background = try parseBackground(value)
            case "--jpeg-quality": jpegQuality = try parseQuality(value)
            default: throw CLIError.unknownOption(flag)
            }
            index += 2
        }
        guard let input, let output else { throw CLIError.usage }
        self.input = URL(fileURLWithPath: input)
        self.output = URL(fileURLWithPath: output)
        self.selection = selection
        self.background = background
        self.jpegQuality = jpegQuality
    }
}

/// `detect`: run Vision once and keep every subject's mask as an immutable
/// PNG named by its SHA-256 in `--masks-dir`.
struct DetectOptions: Equatable {
    let input: URL
    let masksDirectory: URL

    init(arguments: [String]) throws {
        let values = try flagValues(arguments, allowed: ["--input", "--masks-dir"])
        guard let input = values["--input"], let masks = values["--masks-dir"] else {
            throw CLIError.missingOption(values["--input"] == nil ? "--input" : "--masks-dir")
        }
        self.input = URL(fileURLWithPath: input)
        self.masksDirectory = URL(fileURLWithPath: masks, isDirectory: true)
    }
}

/// `compose`: apply one saved mask, the brush strokes and the background to
/// an image (the developed photo) and export it.
struct ComposeOptions: Equatable {
    let input: URL
    let mask: URL
    let maskSHA256: String?
    let output: URL
    let background: CutoutBackground
    let strokes: URL?
    let jpegQuality: Double

    init(arguments: [String]) throws {
        let values = try flagValues(arguments, allowed: [
            "--input", "--mask", "--mask-sha256", "--output", "--background", "--strokes", "--jpeg-quality",
        ])
        for required in ["--input", "--mask", "--output"] where values[required] == nil {
            throw CLIError.missingOption(required)
        }
        input = URL(fileURLWithPath: values["--input"]!)
        mask = URL(fileURLWithPath: values["--mask"]!)
        output = URL(fileURLWithPath: values["--output"]!)
        if let digest = values["--mask-sha256"] {
            guard digest.wholeMatch(of: /[0-9a-f]{64}/) != nil else { throw CLIError.invalidDigest(digest) }
            maskSHA256 = digest
        } else {
            maskSHA256 = nil
        }
        background = try values["--background"].map(parseBackground) ?? .transparent
        strokes = values["--strokes"].map { URL(fileURLWithPath: $0) }
        jpegQuality = try values["--jpeg-quality"].map(parseQuality) ?? 0.92
    }
}

/// `surface`: the surface of a local-adjustment mask (every foreground
/// subject of the working image) as the canonical 8-bit gray PNG. `sky` is
/// accepted and refused (`unsupported_kind`) until it has a detector.
struct SurfaceOptions: Equatable {
    enum Kind: String, Equatable { case subject, sky }
    let input: URL
    let output: URL
    let kind: Kind
    let maxSide: Int

    init(arguments: [String]) throws {
        let values = try flagValues(arguments, allowed: ["--input", "--output", "--kind", "--max-side"])
        for required in ["--input", "--output", "--kind"] where values[required] == nil {
            throw CLIError.missingOption(required)
        }
        input = URL(fileURLWithPath: values["--input"]!)
        output = URL(fileURLWithPath: values["--output"]!)
        guard let kind = Kind(rawValue: values["--kind"]!) else { throw CLIError.invalidKind(values["--kind"]!) }
        self.kind = kind
        if let side = values["--max-side"] {
            guard let parsed = Int(side), (1...MaskSurface.maxSide).contains(parsed) else {
                throw CLIError.invalidMaxSide(side)
            }
            maxSide = parsed
        } else {
            maxSide = MaskSurface.maxSide
        }
    }
}

/// `--key value` pairs for the subcommands: unknown, repeated or valueless
/// options are errors (the one-shot form keeps Photo Bench's looser parser).
private func flagValues(_ arguments: [String], allowed: Set<String>) throws -> [String: String] {
    var values: [String: String] = [:]
    var index = 0
    while index < arguments.count {
        let flag = arguments[index]
        guard allowed.contains(flag) else { throw CLIError.unknownOption(flag) }
        guard index + 1 < arguments.count else { throw CLIError.missingValue(flag) }
        guard values[flag] == nil else { throw CLIError.repeatedOption(flag) }
        values[flag] = arguments[index + 1]
        index += 2
    }
    return values
}

private func parseBackground(_ value: String) throws -> CutoutBackground {
    if value == "transparent" { return .transparent }
    if value == "white" { return .color(.white) }
    let hex = value.hasPrefix("#") ? String(value.dropFirst()) : value
    guard hex.count == 6, let raw = UInt32(hex, radix: 16) else {
        throw CLIError.invalidBackground(value)
    }
    return .color(CutoutRGBA(
        red: Double((raw >> 16) & 0xff) / 255,
        green: Double((raw >> 8) & 0xff) / 255,
        blue: Double(raw & 0xff) / 255
    ))
}

private func parseQuality(_ value: String) throws -> Double {
    guard let parsed = Double(value), (0...1).contains(parsed) else {
        throw CLIError.invalidQuality(value)
    }
    return parsed
}

enum CLIError: LocalizedError, Equatable {
    case usage
    case unknownOption(String)
    case missingOption(String)
    case missingValue(String)
    case repeatedOption(String)
    case invalidSubject(String)
    case unknownSubject(String)
    case invalidBackground(String)
    case invalidQuality(String)
    case invalidDigest(String)
    case invalidStrokes(String)
    case invalidKind(String)
    case invalidMaxSide(String)

    var errorDescription: String? {
        switch self {
        case .usage: Command.usage
        case let .unknownOption(value): "不明なオプションです: \(value)"
        case let .missingOption(value): "必要なオプションがありません: \(value)"
        case let .missingValue(value): "オプションの値がありません: \(value)"
        case let .repeatedOption(value): "同じオプションが 2 回あります: \(value)"
        case let .invalidSubject(value): "被写体指定が不正です: \(value)"
        case let .unknownSubject(value): "被写体が見つかりません: \(value)"
        case let .invalidBackground(value): "背景色が不正です: \(value)"
        case let .invalidQuality(value): "JPEG品質が不正です: \(value)"
        case let .invalidDigest(value): "SHA-256 は小文字の 16 進 64 文字で指定してください: \(value)"
        case let .invalidStrokes(reason): "ブラシの指定を読めません: \(reason)"
        case let .invalidKind(value): "面の種類は subject か sky で指定してください: \(value)"
        case let .invalidMaxSide(value): "--max-side は 1〜4096 の整数で指定してください: \(value)"
        }
    }
}
