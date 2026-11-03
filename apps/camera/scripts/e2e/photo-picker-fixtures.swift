import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let arguments = CommandLine.arguments
guard arguments.count == 2 else { exit(2) }
let output = URL(fileURLWithPath: arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

let width = 192
let height = 128
let colorSpace = CGColorSpaceCreateDeviceRGB()
let context = CGContext(
  data: nil,
  width: width,
  height: height,
  bitsPerComponent: 8,
  bytesPerRow: 0,
  space: colorSpace,
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
)!
for y in 0..<height {
  for x in 0..<width {
    let red = CGFloat(x) / CGFloat(width - 1)
    let green = CGFloat(y) / CGFloat(height - 1)
    let blue = CGFloat((x + y) % (width + height)) / CGFloat(width + height - 2)
    context.setFillColor(CGColor(colorSpace: colorSpace, components: [red, green, blue, 1])!)
    context.fill(CGRect(x: x, y: y, width: 1, height: 1))
  }
}
let image = context.makeImage()!

func write(_ fileName: String, _ type: UTType) throws {
  let destinationURL = output.appendingPathComponent(fileName)
  guard let destination = CGImageDestinationCreateWithURL(destinationURL as CFURL, type.identifier as CFString, 1, nil) else {
    throw NSError(domain: "PhotoPickerE2E", code: 1)
  }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else {
    throw NSError(domain: "PhotoPickerE2E", code: 2)
  }
}

try write("fixture-jpeg.jpg", .jpeg)
try write("fixture-png.png", .png)
try write("fixture-heic.heic", .heic)
try write("fixture-tiff.tiff", .tiff)
