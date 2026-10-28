//! Research only (#130): the editor's Final 1280 steps on a signed working
//! copy, natively (compare with tools/reopen-wasm-bench.mjs on the same
//! input). `--loop N` repeats the preset frames (alternating the exposure so
//! the master is prepared again each time) for `sample` profiling.
//! `cargo run --release --example signed_final_timing -- <signed.png> <signed.json> [--loop N]`.
use niho_develop::settings::{ENGINE_NIHO_11, LOOK_NIHO_STANDARD_5};
use niho_develop::{xmp, DevelopSettings, Filter, Quality, Session};
use sha2::{Digest, Sha256};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let png = std::fs::read(&args[0]).unwrap();
    let meta = std::fs::read_to_string(&args[1]).unwrap();
    let loops: usize = args
        .iter()
        .position(|a| a == "--loop")
        .map_or(0, |i| args[i + 1].parse().unwrap());
    let t = Instant::now();
    let mut session = Session::open_working_copy(&png, &meta, Filter::Lanczos3).unwrap();
    let step =
        |label: &str, t: Instant| println!("{label}\t{:.0}", t.elapsed().as_secs_f64() * 1e3);
    step("open", t);
    let mut base = DevelopSettings::neutral();
    base.engine = ENGINE_NIHO_11.into();
    base.look = LOOK_NIHO_STANDARD_5.into();
    let as_shot = session.as_shot_white();
    let preset = |id: &str, on: &DevelopSettings| {
        xmp::apply_preset(xmp::builtin_preset(id).unwrap().xmp, on, 1.0, as_shot)
            .unwrap()
            .settings
    };
    let mut render = |label: &str, settings: &DevelopSettings| {
        let t = Instant::now();
        let frame = session.render(settings, 1280, Quality::Final).unwrap();
        let hash = Sha256::digest(&frame.rgba);
        println!(
            "{label}\t{:.0}\t{}x{}\t{:x}",
            t.elapsed().as_secs_f64() * 1e3,
            frame.width,
            frame.height,
            hash
        );
    };
    render("first", &base);
    let mut exposed = base.clone();
    exposed.exposure = 0.3;
    render("exposure", &exposed);
    for id in ["niho-bluesky2", "niho-pastel", "niho-colorful"] {
        render(&format!("preset:{id}"), &preset(id, &exposed));
    }
    let mut vibrance = preset("niho-pastel", &exposed);
    render("pastel", &vibrance);
    vibrance.vibrance += 20.0;
    render("pastel+vibrance", &vibrance);
    for index in 0..loops {
        let mut on = exposed.clone();
        on.exposure = 0.3 + 0.05 * (index % 2) as f64;
        render("loop", &preset("niho-bluesky2", &on));
    }
}
