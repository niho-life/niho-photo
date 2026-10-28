import Foundation
import NihoCameraCutout
import Testing

/// The editor paints its preview with a TS port of the brush
/// (packages/photo-editing/src/photo-cutout.ts `applyCutoutStrokes`) and the
/// export goes through `compose`. Both sides read one fixture: a small
/// synthetic ramp with hand-computed expected bytes (written for the public
/// repository; no image, model or earlier fixture data). This test checks
/// MaskRaster paints those bytes, photo-cutout.test.ts checks the port does.
/// A deliberate change to the brush updates the fixture's `expected` and both
/// tests together.
struct BrushParityTests {
    struct Fixture: Codable, Equatable {
        let note: String
        let width: Int
        let height: Int
        /// Raw mask bytes (row-major, top-left origin).
        let input: [UInt8]
        let strokes: [CutoutBrushStroke]
        /// `MaskRaster(input).applying(strokes)`.
        let expected: [UInt8]
    }

    static let fixtureURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("../../../../../photo-editing/src/fixtures/cutout-brush-parity.json")
        .standardizedFileURL

    @Test func maskRasterPaintsTheFixturesBytes() throws {
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: Self.fixtureURL))
        #expect(fixture.input.count == fixture.width * fixture.height)
        #expect(fixture.expected.count == fixture.width * fixture.height)
        let input = try MaskRaster(width: fixture.width, height: fixture.height, pixels: Data(fixture.input))
        #expect(input.applying(fixture.strokes).pixels == Data(fixture.expected))
        // The strokes change something (the fixture is not trivially "no-op").
        #expect(fixture.expected != fixture.input)
        // The mask PNG MaskRaster writes decodes back to the same bytes (the TS PNG reader reads it too).
        #expect(try MaskRaster(pngData: input.pngData()).pixels == input.pixels)
    }
}
