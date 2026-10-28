//! Research only (lane 2 of #125): a signed working copy stand-in for
//! timing benches, made from a linear ProPhoto working copy of
//! `niho-base-raw render` (the public RW2). Its colors are not Apple's;
//! only its size and content are realistic.
//! `cargo run --release --example signed_bench_copy -- <linear.png> <linear.json> <out.png> <out.json> [calibration]`.
use niho_develop::decode::{decode_working_copy, encode_signed_working_copy};
use niho_develop::Filter;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [png, meta, out_png, out_meta] = [0, 1, 2, 3].map(|i| args[i].clone());
    let calibration = args
        .get(4)
        .cloned()
        .unwrap_or_else(|| "cal-panasonic-dc-s5-apple-v4".into());
    let bytes = std::fs::read(&png).unwrap();
    let image = decode_working_copy(&bytes, 0, Filter::Lanczos3).unwrap();
    let source: serde_json::Value = serde_json::from_slice(&std::fs::read(&meta).unwrap()).unwrap();
    let (signed, encoding) = encode_signed_working_copy(&image).unwrap();
    let as_shot = source
        .get("asShotWhite")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({"x":0.3127,"y":0.329,"temperature":5500,"tint":0}));
    let out = serde_json::json!({
        "kind": "raw",
        "baselineEV": source.get("baselineEV").and_then(|v| v.as_f64()).unwrap_or(0.0),
        "asShotWhite": as_shot,
        "asShotWhiteAdobe": null,
        "whiteBalanceTable": null,
        "dcpSha256": format!("apple-ciraw8/linear-prophoto-d50/{calibration}"),
        "lookTableIncluded": false,
        "encoding": {"kind": "signed-gamma18-v1", "ceiling": encoding.ceiling()},
    });
    std::fs::write(&out_png, signed).unwrap();
    std::fs::write(&out_meta, out.to_string()).unwrap();
    println!(
        "{}x{} ceiling {}",
        image.width,
        image.height,
        encoding.ceiling()
    );
}
