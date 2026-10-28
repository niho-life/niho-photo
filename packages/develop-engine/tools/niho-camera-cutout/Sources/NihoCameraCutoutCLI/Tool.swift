enum Tool {
    static let name = "niho-camera-cutout"
    /// The sidecar version NIHO camera checks at launch (`niho-camera-cutout
    /// version` → `niho-camera-cutout 0.1.0`, the same line as
    /// apple-raw-linear). scripts/sidecar-lock.mjs reads this literal.
    /// 0.1.0: copied from Photo Bench c76775b (NIHO camera 0.4.0) unchanged,
    /// plus `version` and `help`. Masks and composition are Photo Bench's.
    /// 0.2.0: `detect` (immutable masks named by SHA-256) and `compose`
    /// (mask + strokes + background), one JSON line each. Pixels unchanged.
    /// 0.3.0: `surface` (every foreground subject of the working image as
    /// the canonical 8-bit gray PNG of a local-adjustment mask, niho-photo#135).
    /// detect / compose and the one-shot form unchanged.
    static let version = "0.3.0"
}
