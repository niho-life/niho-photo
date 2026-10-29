//! Data-parallel loops (#148). With the `threads` feature the work runs on
//! rayon's pool (native threads, or Web Workers in the threaded wasm); without
//! it these are the plain sequential loops.
//!
//! The helpers only split work into rows or items that do not read each
//! other's output: every element is computed by the same closure, with the
//! same operations in the same order, as the sequential loop, so the bytes do
//! not depend on the thread count (`tests/render_identity.rs`). Never use them
//! for a reduction (a sum, a histogram, a maximum): splitting one changes the
//! order of the additions. The bounds are the same in both builds, so code
//! that would not be thread safe fails to compile without the feature too.

/// Calls `f(y, row)` for every `row_len`-long row of `data` (the last row may
/// be shorter). Rows may run at the same time on different threads.
#[inline]
pub(crate) fn for_each_row_mut<T, F>(data: &mut [T], row_len: usize, f: F)
where
    T: Send,
    F: Fn(usize, &mut [T]) + Sync + Send,
{
    if data.is_empty() {
        return;
    }
    assert!(row_len > 0, "rows of a non-empty buffer need a length");
    #[cfg(feature = "threads")]
    {
        use rayon::prelude::*;
        data.par_chunks_mut(row_len)
            .enumerate()
            .for_each(|(y, row)| f(y, row));
    }
    #[cfg(not(feature = "threads"))]
    for (y, row) in data.chunks_mut(row_len).enumerate() {
        f(y, row);
    }
}

/// [`for_each_row_mut`] with a scratch value: `f(scratch, y, row)`, where
/// `scratch` comes from `init` (once per run of rows a thread takes; once
/// in all without the feature). A row must not read what an earlier row
/// left in it (it fills what it reads), so the bytes do not depend on which
/// rows shared a scratch. Keep it to a row's length (#150).
#[inline]
pub(crate) fn for_each_row_mut_with<T, S, I, F>(data: &mut [T], row_len: usize, init: I, f: F)
where
    T: Send,
    I: Fn() -> S + Sync + Send,
    F: Fn(&mut S, usize, &mut [T]) + Sync + Send,
{
    if data.is_empty() {
        return;
    }
    assert!(row_len > 0, "rows of a non-empty buffer need a length");
    #[cfg(feature = "threads")]
    {
        use rayon::prelude::*;
        data.par_chunks_mut(row_len)
            .enumerate()
            .for_each_init(init, |scratch, (y, row)| f(scratch, y, row));
    }
    #[cfg(not(feature = "threads"))]
    {
        let mut scratch = init();
        for (y, row) in data.chunks_mut(row_len).enumerate() {
            f(&mut scratch, y, row);
        }
    }
}

/// Calls `f(y, a_row, b_row)` for every row `y` of two buffers split into
/// the same number of rows (`a` into `a_len`-long rows, `b` into `b_len`-long
/// ones; a part's result beside its pixels). Rows may run at the same time
/// on different threads (#150).
#[inline]
pub(crate) fn for_each_row_pair_mut<A, B, F>(
    a: &mut [A],
    a_len: usize,
    b: &mut [B],
    b_len: usize,
    f: F,
) where
    A: Send,
    B: Send,
    F: Fn(usize, &mut [A], &mut [B]) + Sync + Send,
{
    if a.is_empty() && b.is_empty() {
        return;
    }
    assert!(
        a_len > 0 && b_len > 0,
        "rows of a non-empty buffer need a length"
    );
    assert_eq!(
        a.len().div_ceil(a_len),
        b.len().div_ceil(b_len),
        "the buffers split together have as many rows"
    );
    #[cfg(feature = "threads")]
    {
        use rayon::prelude::*;
        a.par_chunks_mut(a_len)
            .zip(b.par_chunks_mut(b_len))
            .enumerate()
            .for_each(|(y, (a, b))| f(y, a, b));
    }
    #[cfg(not(feature = "threads"))]
    for (y, (a, b)) in a.chunks_mut(a_len).zip(b.chunks_mut(b_len)).enumerate() {
        f(y, a, b);
    }
}

/// Calls `f(first, band)` for consecutive bands of whole `row_len`-long rows
/// of `data`, `first` being the index of the band's first row: the whole
/// buffer at once without the feature or on one thread, about four bands
/// per thread on more. For loops whose rows share work along the way (a
/// window of filtered input rows) that each band makes again from its first
/// row: `f` must give every row the values the whole buffer's loop gives it
/// (#150).
#[inline]
pub(crate) fn for_each_band_mut<T, F>(data: &mut [T], row_len: usize, f: F)
where
    T: Send,
    F: Fn(usize, &mut [T]) + Sync + Send,
{
    if data.is_empty() {
        return;
    }
    assert!(row_len > 0, "rows of a non-empty buffer need a length");
    #[cfg(feature = "threads")]
    {
        use rayon::prelude::*;
        let threads = rayon::current_num_threads();
        if threads <= 1 {
            f(0, data);
            return;
        }
        let band = data.len().div_ceil(row_len).div_ceil(threads * 4);
        data.par_chunks_mut(band * row_len)
            .enumerate()
            .for_each(|(i, part)| f(i * band, part));
    }
    #[cfg(not(feature = "threads"))]
    f(0, data);
}

/// Calls `f(y, rows)` for every row `y` of `N` buffers of the same length,
/// split into `row_len`-long rows together (`rows[i]` is row `y` of
/// `outputs[i]`). Rows may run at the same time on different threads.
#[inline]
pub(crate) fn for_each_rows_mut<T, F, const N: usize>(outputs: [&mut [T]; N], row_len: usize, f: F)
where
    T: Send,
    F: Fn(usize, [&mut [T]; N]) + Sync + Send,
{
    let len = outputs.first().map_or(0, |output| output.len());
    assert!(
        outputs.iter().all(|output| output.len() == len),
        "the buffers split together have one length"
    );
    if len == 0 {
        return;
    }
    assert!(row_len > 0, "rows of a non-empty buffer need a length");
    let mut chunks = outputs.map(|output| output.chunks_mut(row_len));
    let rows = std::iter::from_fn(move || {
        let row = chunks.each_mut().map(|chunk| chunk.next());
        row.iter()
            .all(Option::is_some)
            .then(|| row.map(|part| part.expect("every buffer has the row")))
    });
    #[cfg(feature = "threads")]
    {
        use rayon::prelude::*;
        rows.collect::<Vec<_>>()
            .into_par_iter()
            .enumerate()
            .for_each(|(y, row)| f(y, row));
    }
    #[cfg(not(feature = "threads"))]
    for (y, row) in rows.enumerate() {
        f(y, row);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_row_is_visited_once_with_its_index() {
        let mut data: Vec<u32> = vec![0; 23];
        for_each_row_mut(&mut data, 5, |y, row| {
            for (x, value) in row.iter_mut().enumerate() {
                *value += (y * 5 + x) as u32 + 1;
            }
        });
        assert_eq!(data, (1..=23).collect::<Vec<u32>>());
        let mut empty: Vec<u32> = Vec::new();
        for_each_row_mut(&mut empty, 0, |_, _| unreachable!());
    }

    #[test]
    fn buffers_split_together_see_the_same_rows() {
        let (mut a, mut b) = (vec![0u32; 10], vec![0u32; 10]);
        for_each_rows_mut([&mut a[..], &mut b[..]], 4, |y, [left, right]| {
            for (x, (l, r)) in left.iter_mut().zip(right.iter_mut()).enumerate() {
                *l = (y * 4 + x) as u32;
                *r = 100 + (y * 4 + x) as u32;
            }
        });
        assert_eq!(a, (0..10).collect::<Vec<u32>>());
        assert_eq!(b, (100..110).collect::<Vec<u32>>());
    }

    #[test]
    fn rows_with_a_scratch_fill_what_they_read() {
        let mut data: Vec<u32> = vec![0; 23];
        for_each_row_mut_with(
            &mut data,
            5,
            || vec![0u32; 5],
            |scratch, y, row| {
                for (x, slot) in scratch.iter_mut().enumerate() {
                    *slot = (y * 5 + x) as u32 + 1;
                }
                row.copy_from_slice(&scratch[..row.len()]);
            },
        );
        assert_eq!(data, (1..=23).collect::<Vec<u32>>());
    }

    #[test]
    fn paired_buffers_see_the_same_rows() {
        let (mut pixels, mut results) = (vec![0u32; 10], vec![0u32; 3]);
        for_each_row_pair_mut(&mut pixels, 4, &mut results, 1, |y, row, result| {
            for (x, value) in row.iter_mut().enumerate() {
                *value = (y * 4 + x) as u32;
            }
            result[0] = row.len() as u32 + 100 * y as u32;
        });
        assert_eq!(pixels, (0..10).collect::<Vec<u32>>());
        assert_eq!(results, vec![4, 104, 202]);
    }

    #[test]
    fn bands_cover_every_row_once_from_their_first_row() {
        for rows in [1usize, 2, 7, 33, 100] {
            let mut data: Vec<u32> = vec![0; rows * 3];
            for_each_band_mut(&mut data, 3, |first, band| {
                assert_eq!(band.len() % 3, 0, "whole rows");
                for (i, row) in band.chunks_mut(3).enumerate() {
                    for (x, value) in row.iter_mut().enumerate() {
                        *value += ((first + i) * 3 + x) as u32 + 1;
                    }
                }
            });
            assert_eq!(data, (1..=rows as u32 * 3).collect::<Vec<u32>>());
        }
    }
}
