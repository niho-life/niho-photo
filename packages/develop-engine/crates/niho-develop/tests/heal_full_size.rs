//! Time and memory of healing at full size (#133, `docs/heal.md` "大きな印と
//! 上限"): a 24 MP (6000 x 4000) and a 61 MP (9504 x 6336) photo of
//! textured grass, healed with four sets of marks — 16 dust spots, a wire
//! across the whole frame, one large mark (radius 10% of the long edge)
//! and one of the largest radius (25%).
//!
//! Each case heals the photo once ([`heal::heal_in_place`], the work of a
//! full-size export after the decode) and prints its time and the peak
//! heap above the photo, counted by this binary's allocator. The bounds
//! are generous: they catch a regression by a factor, not a benchmark.
//! Ignored by default (seconds and gigabytes); run with
//!
//!   cargo test --release -p niho-develop --test heal_full_size -- --ignored --nocapture

use niho_develop::heal::{self, HealMark};
use niho_develop::LinearImage;
use serde_json::json;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

struct Counting;

static CURRENT: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
/// One measured case at a time (the counts are the process's).
static SERIAL: Mutex<()> = Mutex::new(());

fn grow(bytes: usize) {
    let now = CURRENT.fetch_add(bytes, Ordering::Relaxed) + bytes;
    PEAK.fetch_max(now, Ordering::Relaxed);
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            grow(layout.size());
        }
        p
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(layout) };
        if !p.is_null() {
            grow(layout.size());
        }
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        CURRENT.fetch_sub(layout.size(), Ordering::Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = unsafe { System.realloc(ptr, layout, new_size) };
        if !p.is_null() {
            if new_size >= layout.size() {
                grow(new_size - layout.size());
            } else {
                CURRENT.fetch_sub(layout.size() - new_size, Ordering::Relaxed);
            }
        }
        p
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

fn lattice(ix: i64, iy: i64, seed: u64) -> f32 {
    let mut z = seed
        ^ (ix as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15)
        ^ (iy as u64).wrapping_mul(0xc2b2_ae3d_27d4_eb4f);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    ((z ^ (z >> 31)) >> 40) as f32 / (1u64 << 24) as f32
}

/// Smooth value noise (`0..1`) on cells of `cell` pixels.
fn noise(x: usize, y: usize, cell: usize, seed: u64) -> f32 {
    let (ix, iy) = ((x / cell) as i64, (y / cell) as i64);
    let (tx, ty) = (
        (x % cell) as f32 / cell as f32,
        (y % cell) as f32 / cell as f32,
    );
    let (sx, sy) = (tx * tx * (3.0 - 2.0 * tx), ty * ty * (3.0 - 2.0 * ty));
    let a = lattice(ix, iy, seed);
    let b = lattice(ix + 1, iy, seed);
    let c = lattice(ix, iy + 1, seed);
    let d = lattice(ix + 1, iy + 1, seed);
    a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
}

/// Textured grass (linear sRGB) under a sky band.
fn photo(width: usize, height: usize) -> LinearImage {
    let mut data = Vec::with_capacity(width * height * 3);
    for y in 0..height {
        for x in 0..width {
            if y < height / 4 {
                let l = 0.6 + 0.2 * y as f32 / height as f32;
                data.extend_from_slice(&[0.8 * l, 0.9 * l, l]);
            } else {
                let n =
                    0.5 * noise(x, y, 5, 1) + 0.3 * noise(x, y, 17, 2) + 0.2 * noise(x, y, 60, 3);
                let k = 0.6 + 0.8 * n;
                data.extend_from_slice(&[0.06 * k, 0.13 * k, 0.04 * k]);
            }
        }
    }
    LinearImage {
        width,
        height,
        data,
    }
}

/// `(name, marks, bound on the peak heap above the photo in photo sizes,
/// bound on the time in seconds)`.
fn cases() -> Vec<(&'static str, Vec<HealMark>, f64, f64)> {
    let marks = |v: serde_json::Value| heal::parse_heal(&v).unwrap();
    let spots: Vec<_> = (0..16)
        .map(|i| {
            let (x, y) = (0.1 + 0.05 * i as f64, 0.35 + 0.035 * (i % 5) as f64);
            json!({"id": format!("s{i}"), "mode": "remove", "radius": 0.004, "feather": 0.5, "points": [[x, y]]})
        })
        .collect();
    let wire: Vec<[f64; 2]> = (0..64)
        .map(|i| {
            let t = i as f64 / 63.0;
            [0.02 + 0.96 * t, 0.3 + 0.6 * t]
        })
        .collect();
    vec![
        ("spots", marks(json!(spots)), 2.0, 60.0),
        (
            "wire",
            marks(
                json!([{"id": "w", "mode": "remove", "radius": 0.003, "feather": 0.5, "points": wire}]),
            ),
            2.0,
            120.0,
        ),
        (
            "large",
            marks(
                json!([{"id": "l", "mode": "remove", "radius": 0.1, "feather": 0.3, "points": [[0.5, 0.6]]}]),
            ),
            2.0,
            60.0,
        ),
        (
            "largest",
            marks(
                json!([{"id": "x", "mode": "remove", "radius": 0.25, "feather": 0.3, "points": [[0.5, 0.6]]}]),
            ),
            2.0,
            60.0,
        ),
    ]
}

fn measure(width: usize, height: usize) {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let source = photo(width, height);
    let photo_bytes = source.data.len() * 4;
    for (name, marks, heap_bound, time_bound) in cases() {
        let mut image = source.clone();
        let base = CURRENT.load(Ordering::Relaxed);
        PEAK.store(base, Ordering::Relaxed);
        let t = Instant::now();
        heal::heal_in_place(&marks, &mut image);
        let seconds = t.elapsed().as_secs_f64();
        let extra = PEAK.load(Ordering::Relaxed) - base;
        let ratio = extra as f64 / photo_bytes as f64;
        println!(
            "{}",
            json!({
                "size": [width, height], "case": name,
                "seconds": (seconds * 100.0).round() / 100.0,
                "peakHeapAbovePhotoMiB": extra / (1 << 20),
                "photoMiB": photo_bytes / (1 << 20),
                "peakInPhotos": (ratio * 100.0).round() / 100.0,
            })
        );
        assert!(ratio <= heap_bound, "{name}: {ratio:.2} photos of heap");
        assert!(seconds <= time_bound, "{name}: {seconds:.1} s");
        assert!(image.data != source.data, "{name}: nothing healed");
    }
}

#[test]
#[ignore = "full size: seconds and gigabytes (run with --release --ignored)"]
fn healing_24_megapixels() {
    measure(6000, 4000);
}

#[test]
#[ignore = "full size: seconds and gigabytes (run with --release --ignored)"]
fn healing_61_megapixels() {
    measure(9504, 6336);
}
