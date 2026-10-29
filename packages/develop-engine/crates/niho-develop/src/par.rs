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
}
