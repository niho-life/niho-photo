"""NIHO-owned image math shared by the research sky-mask trainer."""

import numpy as np


def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """sRGB uint8 / float 0..1 (H, W, 3) -> CIE Lab (D65), float32."""
    c = rgb.astype(np.float32)
    if c.max() > 1.0:
        c /= 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    m = np.array(
        [[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]],
        np.float32,
    )
    xyz = lin @ m.T
    xyz /= np.array([0.95047, 1.0, 1.08883], np.float32)
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16.0 / 116.0)
    lab = np.empty_like(f)
    lab[..., 0] = 116.0 * f[..., 1] - 16.0
    lab[..., 1] = 500.0 * (f[..., 0] - f[..., 1])
    lab[..., 2] = 200.0 * (f[..., 1] - f[..., 2])
    return lab


def box(img: np.ndarray, r: int) -> np.ndarray:
    """Mean over a (2r+1)^2 window with edge clamping."""
    pad = np.pad(img, ((r + 1, r), (r + 1, r)), mode="edge").astype(np.float64)
    s = pad.cumsum(0).cumsum(1)
    k = 2 * r + 1
    out = s[k:, k:] - s[:-k, k:] - s[k:, :-k] + s[:-k, :-k]
    return (out / (k * k)).astype(np.float32)


def guided_filter(guide: np.ndarray, src: np.ndarray, r: int, eps: float) -> np.ndarray:
    """He et al. guided filter with a grey guide."""
    mean_i = box(guide, r)
    mean_p = box(src, r)
    cov_ip = box(guide * src, r) - mean_i * mean_p
    var_i = box(guide * guide, r) - mean_i * mean_i
    a = cov_ip / (var_i + eps)
    b = mean_p - a * mean_i
    return box(a, r) * guide + box(b, r)
