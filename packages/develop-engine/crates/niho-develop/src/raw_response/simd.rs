//! Independent Gaussian accumulators. Explicit mul/add forbids FMA rounding.

pub(super) fn convolve_row(source: &[f32], starts: &[usize], weights: &[f32], output: &mut [f32]) {
    assert_eq!(starts.len(), weights.len());
    // Check all loads once per row, before entering the SIMD loops.
    assert!(starts
        .iter()
        .all(|&start| start <= source.len() && output.len() <= source.len() - start));
    let wide = output.len() / 32 * 32;
    for offset in (0..wide).step_by(32) {
        output[offset..offset + 32].copy_from_slice(&sum32_inner(source, starts, weights, offset));
    }
    let complete = output.len() / 16 * 16;
    for offset in (wide..complete).step_by(16) {
        output[offset..offset + 16].copy_from_slice(&sum16_inner(source, starts, weights, offset));
    }
    for (offset, value) in output.iter_mut().enumerate().skip(complete) {
        let mut sum = 0.0_f32;
        for (&start, &weight) in starts.iter().zip(weights) {
            sum += source[start + offset] * weight;
        }
        *value = sum;
    }
}

#[cfg(target_arch = "aarch64")]
#[inline]
fn sum32_inner(source: &[f32], starts: &[usize], weights: &[f32], offset: usize) -> [f32; 32] {
    use core::arch::aarch64::*;
    // The safe entry checks every load, including the last lane of each block.
    unsafe {
        let mut acc = [vdupq_n_f32(0.0); 8];
        for (&start, &weight) in starts.iter().zip(weights) {
            let p = source.as_ptr().add(start + offset);
            let w = vdupq_n_f32(weight);
            for (lane, value) in acc.iter_mut().enumerate() {
                *value = vaddq_f32(*value, vmulq_f32(vld1q_f32(p.add(lane * 4)), w));
            }
        }
        let mut out = [0.0; 32];
        let p = out.as_mut_ptr();
        for (lane, value) in acc.iter().enumerate() {
            vst1q_f32(p.add(lane * 4), *value);
        }
        out
    }
}

#[cfg(target_arch = "aarch64")]
#[inline]
fn sum16_inner(source: &[f32], starts: &[usize], weights: &[f32], offset: usize) -> [f32; 16] {
    use core::arch::aarch64::*;
    // The safe entry checks every load, including the last lane of each block.
    unsafe {
        let mut a = vdupq_n_f32(0.0);
        let mut b = a;
        let mut c = a;
        let mut d = a;
        for (&start, &weight) in starts.iter().zip(weights) {
            let p = source.as_ptr().add(start + offset);
            let w = vdupq_n_f32(weight);
            a = vaddq_f32(a, vmulq_f32(vld1q_f32(p), w));
            b = vaddq_f32(b, vmulq_f32(vld1q_f32(p.add(4)), w));
            c = vaddq_f32(c, vmulq_f32(vld1q_f32(p.add(8)), w));
            d = vaddq_f32(d, vmulq_f32(vld1q_f32(p.add(12)), w));
        }
        let mut out = [0.0; 16];
        let p = out.as_mut_ptr();
        vst1q_f32(p, a);
        vst1q_f32(p.add(4), b);
        vst1q_f32(p.add(8), c);
        vst1q_f32(p.add(12), d);
        out
    }
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline]
fn sum32_inner(source: &[f32], starts: &[usize], weights: &[f32], offset: usize) -> [f32; 32] {
    use core::arch::wasm32::*;
    // Bounds are validated by the safe entry. v128_load/store allow unaligned access.
    unsafe {
        let mut acc = [f32x4_splat(0.0); 8];
        for (&start, &weight) in starts.iter().zip(weights) {
            let p = source.as_ptr().add(start + offset);
            let w = f32x4_splat(weight);
            for (lane, value) in acc.iter_mut().enumerate() {
                *value = f32x4_add(*value, f32x4_mul(v128_load(p.add(lane * 4).cast()), w));
            }
        }
        let mut out = [0.0; 32];
        let p = out.as_mut_ptr();
        for (lane, value) in acc.iter().enumerate() {
            v128_store(p.add(lane * 4).cast(), *value);
        }
        out
    }
}

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
#[inline]
fn sum16_inner(source: &[f32], starts: &[usize], weights: &[f32], offset: usize) -> [f32; 16] {
    use core::arch::wasm32::*;
    // Bounds are validated by the safe entry. v128_load/store allow unaligned access.
    unsafe {
        let mut a = f32x4_splat(0.0);
        let mut b = a;
        let mut c = a;
        let mut d = a;
        for (&start, &weight) in starts.iter().zip(weights) {
            let p = source.as_ptr().add(start + offset);
            let w = f32x4_splat(weight);
            a = f32x4_add(a, f32x4_mul(v128_load(p.cast()), w));
            b = f32x4_add(b, f32x4_mul(v128_load(p.add(4).cast()), w));
            c = f32x4_add(c, f32x4_mul(v128_load(p.add(8).cast()), w));
            d = f32x4_add(d, f32x4_mul(v128_load(p.add(12).cast()), w));
        }
        let mut out = [0.0; 16];
        let p = out.as_mut_ptr();
        v128_store(p.cast(), a);
        v128_store(p.add(4).cast(), b);
        v128_store(p.add(8).cast(), c);
        v128_store(p.add(12).cast(), d);
        out
    }
}

#[cfg(not(any(
    target_arch = "aarch64",
    all(target_arch = "wasm32", target_feature = "simd128")
)))]
#[inline]
fn sum32_inner(source: &[f32], starts: &[usize], weights: &[f32], offset: usize) -> [f32; 32] {
    let mut out = [0.0; 32];
    for (&start, &weight) in starts.iter().zip(weights) {
        for (lane, value) in out.iter_mut().enumerate() {
            *value += source[start + offset + lane] * weight;
        }
    }
    out
}

#[cfg(not(any(
    target_arch = "aarch64",
    all(target_arch = "wasm32", target_feature = "simd128")
)))]
#[inline]
fn sum16_inner(source: &[f32], starts: &[usize], weights: &[f32], offset: usize) -> [f32; 16] {
    let mut out = [0.0; 16];
    for (&start, &weight) in starts.iter().zip(weights) {
        for (lane, value) in out.iter_mut().enumerate() {
            *value += source[start + offset + lane] * weight;
        }
    }
    out
}
