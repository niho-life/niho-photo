//! `developSettings.heal` (niho-photo#44, "修復"): marks brushed over the
//! photo, each filled from its surroundings ("消す", a multi-scale
//! PatchMatch, [`fill`]) or copied from another place ("写す"). See
//! `docs/heal.md`.
//!
//! - **Shape.** An array of marks in the order they were drawn: `{ id,
//!   mode: "remove" | "clone", radius, feather, points: [[x, y], ...],
//!   source?: [dx, dy] }`. `x` / `y` are `0..1` of the width / height of the
//!   photo before the geometry (EXIF orientation applied, before the
//!   quarter turns, flips, perspective, angle and crop), so a mark stays on
//!   the photo whatever the crop. `radius` is a fraction of the long edge
//!   (`0.002..0.25`), `feather` (`0..1`) the soft part of the brush's edge.
//!   `source` (`-1..1` per axis) is where "写す" copies from, relative to
//!   the mark; without one the engine picks the most similar place. No
//!   marks (the identity) writes no key; marks need `v: 8`.
//! - **Where.** First of all: the healed photo replaces the source the
//!   frames read (before the geometry window, the size reduction and every
//!   adjustment). A signed RAW heals its prepared master; the matches are
//!   found on the source itself, so moving a master slider re-applies the
//!   kept matches instead of searching again.
//! - **Cache.** A Session keeps the healed copy by the marks (and the
//!   master), and the plans of the marks by a key that also covers the
//!   earlier marks that overlap what the mark reads: adding a mark plans
//!   that mark only, deleting one replans only the later marks it touched.

mod complete;
mod fill;
mod shape;

use crate::decode::LinearImage;
use crate::settings::{num, DevelopSettings, SettingsError};
use crate::{Error, Session, SessionSource};
use fill::Plan;
use serde_json::{Map, Value};
use std::sync::{Arc, Mutex};

/// `v` of settings with at least one heal mark (niho-photo#44; 5 and 6
/// belong to other features).
pub const HEAL_SETTINGS_VERSION: u32 = 8;
/// Most marks of one photo.
pub const MAX_HEAL_MARKS: usize = 64;
/// Most points of one mark.
pub const MAX_HEAL_POINTS: usize = 512;
/// Most points of all the marks of one photo (the settings stay well under
/// their 64KiB limit: about 18 bytes a point).
pub const MAX_HEAL_TOTAL_POINTS: usize = 2048;
/// Smallest and largest `radius` (fractions of the long edge).
pub const MIN_HEAL_RADIUS: f64 = 0.002;
pub const MAX_HEAL_RADIUS: f64 = 0.25;
/// Longest `id` (ASCII bytes).
pub const MAX_HEAL_ID_BYTES: usize = 64;

/// "消す" (fill from the surroundings) or "写す" (copy from `source`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealMode {
    Remove,
    Clone,
}

impl HealMode {
    pub fn as_str(self) -> &'static str {
        match self {
            HealMode::Remove => "remove",
            HealMode::Clone => "clone",
        }
    }
}

/// One brushed mark ([`crate::heal`]).
#[derive(Debug, Clone, PartialEq)]
pub struct HealMark {
    pub id: String,
    pub mode: HealMode,
    /// Brush radius, a fraction of the long edge.
    pub radius: f64,
    /// Soft part of the brush's edge, `0` (hard) .. `1`.
    pub feather: f64,
    /// The stroke, `[x, y]` in `0..1` of the photo before the geometry.
    pub points: Vec<[f64; 2]>,
    /// "写す": the copied place relative to the mark (`0..1` units); `None`
    /// picks the most similar place. Kept but not read by "消す".
    pub source: Option<[f64; 2]>,
}

const MARK_KEYS: [&str; 6] = ["id", "mode", "radius", "feather", "points", "source"];

fn number(v: &Value, path: &str) -> Result<f64, SettingsError> {
    let n = v
        .as_f64()
        .ok_or_else(|| SettingsError::new(path, "invalidType", "must be a number"))?;
    if !n.is_finite() {
        return Err(SettingsError::new(path, "notFinite", "must be finite"));
    }
    Ok(n)
}

fn pair(v: &Value, path: &str) -> Result<[f64; 2], SettingsError> {
    match v.as_array().map(Vec::as_slice) {
        Some([x, y]) => Ok([
            number(x, &format!("{path}[0]"))?,
            number(y, &format!("{path}[1]"))?,
        ]),
        _ => Err(SettingsError::new(
            path,
            "invalidType",
            "must be an array of two numbers",
        )),
    }
}

/// Reads `heal` (`null` is no marks). Wrong types, unknown keys,
/// non-finite numbers and too many marks or points are errors; ranges are
/// [`validate_heal`]'s.
pub fn parse_heal(v: &Value) -> Result<Vec<HealMark>, SettingsError> {
    if v.is_null() {
        return Ok(Vec::new());
    }
    let items = v
        .as_array()
        .ok_or_else(|| SettingsError::new("heal", "invalidType", "must be an array"))?;
    if items.len() > MAX_HEAL_MARKS {
        return Err(SettingsError::new(
            "heal",
            "tooMany",
            "at most 64 heal marks are allowed",
        ));
    }
    let mut marks = Vec::with_capacity(items.len());
    let mut total = 0usize;
    for (index, item) in items.iter().enumerate() {
        let path = format!("heal[{index}]");
        let object = item
            .as_object()
            .ok_or_else(|| SettingsError::new(&path, "invalidType", "must be an object"))?;
        if let Some(key) = object.keys().find(|k| !MARK_KEYS.contains(&k.as_str())) {
            return Err(SettingsError::new(
                &format!("{path}.{key}"),
                "unknownKey",
                "unknown heal mark field",
            ));
        }
        let field = |key: &str| object.get(key).unwrap_or(&Value::Null);
        let id = field("id")
            .as_str()
            .ok_or_else(|| {
                SettingsError::new(&format!("{path}.id"), "invalidType", "must be a string")
            })?
            .to_string();
        let mode = match field("mode").as_str() {
            Some("remove") => HealMode::Remove,
            Some("clone") => HealMode::Clone,
            Some(_) => {
                return Err(SettingsError::new(
                    &format!("{path}.mode"),
                    "invalidValue",
                    "must be remove or clone",
                ))
            }
            None => {
                return Err(SettingsError::new(
                    &format!("{path}.mode"),
                    "invalidType",
                    "must be a string",
                ))
            }
        };
        let radius = number(field("radius"), &format!("{path}.radius"))?;
        let feather = number(field("feather"), &format!("{path}.feather"))?;
        let points_path = format!("{path}.points");
        let raw = field("points")
            .as_array()
            .ok_or_else(|| SettingsError::new(&points_path, "invalidType", "must be an array"))?;
        if raw.len() > MAX_HEAL_POINTS {
            return Err(SettingsError::new(
                &points_path,
                "tooMany",
                "at most 512 points per heal mark are allowed",
            ));
        }
        total += raw.len();
        if total > MAX_HEAL_TOTAL_POINTS {
            return Err(SettingsError::new(
                "heal",
                "tooMany",
                "at most 2048 heal points are allowed in all",
            ));
        }
        let points = raw
            .iter()
            .enumerate()
            .map(|(j, p)| pair(p, &format!("{points_path}[{j}]")))
            .collect::<Result<Vec<_>, _>>()?;
        let source = match field("source") {
            Value::Null => None,
            v => Some(pair(v, &format!("{path}.source"))?),
        };
        marks.push(HealMark {
            id,
            mode,
            radius,
            feather,
            points,
            source,
        });
    }
    Ok(marks)
}

/// The `heal` array (written only when there are marks).
pub fn heal_to_value(marks: &[HealMark]) -> Value {
    Value::Array(
        marks
            .iter()
            .map(|mark| {
                let mut o = Map::new();
                o.insert("id".into(), Value::from(mark.id.clone()));
                o.insert("mode".into(), Value::from(mark.mode.as_str()));
                o.insert("radius".into(), num(mark.radius));
                o.insert("feather".into(), num(mark.feather));
                o.insert(
                    "points".into(),
                    Value::Array(
                        mark.points
                            .iter()
                            .map(|p| Value::Array(vec![num(p[0]), num(p[1])]))
                            .collect(),
                    ),
                );
                if let Some(s) = mark.source {
                    o.insert("source".into(), Value::Array(vec![num(s[0]), num(s[1])]));
                }
                Value::Object(o)
            })
            .collect(),
    )
}

/// Range checks of the marks: ids (1..64 ASCII bytes, unique), radius,
/// feather, at least one point, points in `0..1`, source in `-1..1`, and
/// the counts.
pub fn validate_heal(marks: &[HealMark], issues: &mut Vec<SettingsError>) {
    let mut check = |path: String, value: f64, lo: f64, hi: f64| {
        if !value.is_finite() || value < lo || value > hi {
            issues.push(SettingsError::new(
                &path,
                "outOfRange",
                &format!("must be within {lo}..{hi}"),
            ));
        }
    };
    let mut ids = std::collections::BTreeSet::new();
    let mut shape_issues = Vec::new();
    if marks.len() > MAX_HEAL_MARKS {
        shape_issues.push(SettingsError::new(
            "heal",
            "tooMany",
            "at most 64 heal marks are allowed",
        ));
    }
    if marks.iter().map(|m| m.points.len()).sum::<usize>() > MAX_HEAL_TOTAL_POINTS {
        shape_issues.push(SettingsError::new(
            "heal",
            "tooMany",
            "at most 2048 heal points are allowed in all",
        ));
    }
    for (index, mark) in marks.iter().enumerate() {
        let path = format!("heal[{index}]");
        if mark.id.is_empty() || mark.id.len() > MAX_HEAL_ID_BYTES || !mark.id.is_ascii() {
            shape_issues.push(SettingsError::new(
                &format!("{path}.id"),
                "invalidValue",
                "must be 1..64 ASCII bytes",
            ));
        } else if !ids.insert(mark.id.as_str()) {
            shape_issues.push(SettingsError::new(
                &format!("{path}.id"),
                "duplicateId",
                "heal mark ids must be unique",
            ));
        }
        check(
            format!("{path}.radius"),
            mark.radius,
            MIN_HEAL_RADIUS,
            MAX_HEAL_RADIUS,
        );
        check(format!("{path}.feather"), mark.feather, 0.0, 1.0);
        if mark.points.is_empty() {
            shape_issues.push(SettingsError::new(
                &format!("{path}.points"),
                "emptyPoints",
                "a heal mark needs at least one point",
            ));
        } else if mark.points.len() > MAX_HEAL_POINTS {
            shape_issues.push(SettingsError::new(
                &format!("{path}.points"),
                "tooMany",
                "at most 512 points per heal mark are allowed",
            ));
        }
        for (j, p) in mark.points.iter().enumerate() {
            check(format!("{path}.points[{j}][0]"), p[0], 0.0, 1.0);
            check(format!("{path}.points[{j}][1]"), p[1], 0.0, 1.0);
        }
        if let Some(s) = mark.source {
            check(format!("{path}.source[0]"), s[0], -1.0, 1.0);
            check(format!("{path}.source[1]"), s[1], -1.0, 1.0);
        }
    }
    issues.extend(shape_issues);
}

/// FNV-1a over bytes (the cache keys; the same on every target).
fn fnv(hash: u64, bytes: &[u8]) -> u64 {
    bytes.iter().fold(hash, |h, b| {
        (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3)
    })
}

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;

/// What a mark's pixels depend on (not its `id`).
fn mark_hash(hash: u64, mark: &HealMark) -> u64 {
    let mut h = fnv(hash, &[mark.mode as u8]);
    h = fnv(h, &mark.radius.to_bits().to_le_bytes());
    h = fnv(h, &mark.feather.to_bits().to_le_bytes());
    h = fnv(h, &(mark.points.len() as u64).to_le_bytes());
    for p in &mark.points {
        h = fnv(h, &p[0].to_bits().to_le_bytes());
        h = fnv(h, &p[1].to_bits().to_le_bytes());
    }
    match (mark.mode, mark.source) {
        (HealMode::Clone, Some(s)) => {
            h = fnv(h, &[1]);
            h = fnv(h, &s[0].to_bits().to_le_bytes());
            fnv(h, &s[1].to_bits().to_le_bytes())
        }
        _ => fnv(h, &[0]),
    }
}

/// The marks' pixels at one size: a Session redraws when it changes.
fn fingerprint(marks: &[HealMark], width: usize, height: usize) -> u64 {
    let mut h = fnv(FNV_OFFSET, &(width as u64).to_le_bytes());
    h = fnv(h, &(height as u64).to_le_bytes());
    marks.iter().fold(h, mark_hash)
}

/// The plan key of each mark at `width x height`: the mark, the size and
/// the keys of the earlier marks that write where it reads (a plan reads
/// only its footprint, so other marks do not change it).
fn plan_keys(marks: &[HealMark], width: usize, height: usize) -> Vec<u64> {
    let footprints: Vec<shape::Footprint> = marks
        .iter()
        .map(|m| shape::footprint(m, width, height))
        .collect();
    let mut keys: Vec<u64> = Vec::with_capacity(marks.len());
    for (k, mark) in marks.iter().enumerate() {
        let mut h = fnv(FNV_OFFSET, &(width as u64).to_le_bytes());
        h = fnv(h, &(height as u64).to_le_bytes());
        h = mark_hash(h, mark);
        for j in 0..k {
            if footprints[j].write.intersects(&footprints[k].read) {
                h = fnv(h, &keys[j].to_le_bytes());
            }
        }
        keys.push(h);
    }
    keys
}

/// Plans kept across frames (and shared by the sessions made from one):
/// the most recently used up to a memory budget.
#[derive(Default)]
pub(crate) struct PlanCache {
    inner: Mutex<PlanCacheInner>,
}

#[derive(Default)]
struct PlanCacheInner {
    entries: Vec<(u64, Arc<Plan>)>,
    bytes: usize,
    planned: u64,
    healed: u64,
}

/// Bytes of plans a cache keeps.
const PLAN_CACHE_BYTES: usize = 48 << 20;

impl PlanCache {
    fn lock(&self) -> std::sync::MutexGuard<'_, PlanCacheInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn get(&self, key: u64) -> Option<Arc<Plan>> {
        let mut inner = self.lock();
        let at = inner.entries.iter().position(|(k, _)| *k == key)?;
        let entry = inner.entries.remove(at);
        let plan = Arc::clone(&entry.1);
        inner.entries.push(entry);
        Some(plan)
    }

    fn put(&self, key: u64, plan: Arc<Plan>) {
        let mut inner = self.lock();
        inner.planned += 1;
        inner.bytes += plan.bytes();
        inner.entries.push((key, plan));
        while inner.bytes > PLAN_CACHE_BYTES && inner.entries.len() > 1 {
            let (_, old) = inner.entries.remove(0);
            inner.bytes -= old.bytes();
        }
    }
}

/// How much healing a session (and the sessions sharing its plans) did:
/// marks planned (searched) and photos healed (plans applied). Tests and
/// tools read it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct HealStats {
    pub planned: u64,
    pub healed: u64,
}

/// Heals `target` with `marks` (their [`plan_keys`]) in order. The plans
/// are found on `reference` (made only when a plan is missing; `None`:
/// `target` itself) with the earlier marks applied, then applied to
/// `target`.
fn heal_into(
    marks: &[HealMark],
    keys: &[u64],
    target: &mut LinearImage,
    reference: Option<&dyn Fn() -> LinearImage>,
    cache: &PlanCache,
) {
    let mut search: Option<LinearImage> = None;
    let mut done: Vec<Arc<Plan>> = Vec::with_capacity(marks.len());
    for (k, mark) in marks.iter().enumerate() {
        let plan = match cache.get(keys[k]) {
            Some(plan) => plan,
            None => {
                let plan = match reference {
                    None => fill::plan(mark, target),
                    Some(make) => {
                        let image = search.get_or_insert_with(|| {
                            let mut image = make();
                            for (m, p) in marks.iter().zip(&done) {
                                fill::apply(p, m, &mut image);
                            }
                            image
                        });
                        fill::plan(mark, image)
                    }
                };
                let plan = Arc::new(plan);
                cache.put(keys[k], Arc::clone(&plan));
                plan
            }
        };
        fill::apply(&plan, mark, target);
        if let Some(image) = search.as_mut() {
            fill::apply(&plan, mark, image);
        }
        done.push(plan);
    }
    cache.lock().healed += 1;
}

/// Heals an image in place (a one-shot render's decoded original, which
/// is its own reference). Public for the full-size time and memory tests
/// (`tests/heal_full_size.rs`, #133).
pub fn heal_in_place(marks: &[HealMark], image: &mut LinearImage) {
    if marks.is_empty() {
        return;
    }
    let keys = plan_keys(marks, image.width, image.height);
    heal_into(marks, &keys, image, None, &PlanCache::default());
}

/// The healed copy of a Session's active source and what it was made from.
pub(crate) struct Healed {
    key: String,
    pub(crate) source: SessionSource,
}

impl Session {
    /// Keeps [`Session::healed`] for these settings' marks on the active
    /// source (the NIHO 3 / 4 / 6 master or the source). Without marks it
    /// is dropped. When it changes the frames made from the active source
    /// (reductions, window, statistics, local pass, color-point plane) are
    /// dropped too.
    pub(crate) fn ensure_heal(
        &mut self,
        settings: &DevelopSettings,
        use_niho3: bool,
    ) -> Result<(), Error> {
        if settings.heal.is_empty() {
            if self.healed.take().is_some() {
                self.drop_healed_frames();
            }
            return Ok(());
        }
        let (identity, unhealed) = self.unhealed(use_niho3);
        let (width, height) = unhealed.size();
        let key = format!(
            "{identity}|{:016x}",
            fingerprint(&settings.heal, width, height)
        );
        if self.healed.as_ref().is_some_and(|h| h.key == key) {
            return Ok(());
        }
        // One healed copy in memory at a time.
        self.healed = None;
        let (_, unhealed) = self.unhealed(use_niho3);
        let keys = plan_keys(&settings.heal, width, height);
        let mut image = unhealed.image().clone();
        // A master's plans are found on the source at the master's size.
        let source = self.source.as_ref();
        let filter = self.filter;
        let reference = move || {
            if source.size() == (width, height) {
                source.image().clone()
            } else {
                match source.reduced(width, height, filter) {
                    SessionSource::Raster(raster) => raster.image,
                    SessionSource::WorkingCopy { image, .. } => image,
                }
            }
        };
        heal_into(
            &settings.heal,
            &keys,
            &mut image,
            use_niho3.then_some(&reference as &dyn Fn() -> LinearImage),
            &self.heal_plans,
        );
        let source = unhealed.with_image(image);
        self.healed = Some(Healed { key, source });
        self.drop_healed_frames();
        Ok(())
    }

    /// The source the marks heal (the master's key, or "source") before
    /// the marks.
    fn unhealed(&self, use_niho3: bool) -> (&str, &SessionSource) {
        if use_niho3 {
            let prepared = self.niho3.as_ref().expect("prepared niho3");
            (prepared.key.as_str(), &prepared.source)
        } else {
            ("source", self.source.as_ref())
        }
    }

    fn drop_healed_frames(&mut self) {
        self.framed = None;
        self.sized = None;
        self.stats.clear();
        self.local = None;
        self.color_points = None;
    }

    /// Marks planned and photos healed by this session and the sessions
    /// sharing its plans ([`HealStats`]).
    pub fn heal_stats(&self) -> HealStats {
        let inner = self.heal_plans.lock();
        HealStats {
            planned: inner.planned,
            healed: inner.healed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marks(json: &str) -> Vec<HealMark> {
        parse_heal(&serde_json::from_str(json).unwrap()).unwrap()
    }

    #[test]
    fn marks_round_trip_and_keep_the_source() {
        let json = r#"[{"id":"a","mode":"remove","radius":0.02,"feather":0.5,"points":[[0.1,0.2],[0.3,0.25]]},
            {"id":"b","mode":"clone","radius":0.01,"feather":0,"points":[[0.5,0.5]],"source":[-0.1,0.05]}]"#;
        let parsed = marks(json);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1].source, Some([-0.1, 0.05]));
        assert_eq!(parse_heal(&heal_to_value(&parsed)).unwrap(), parsed);
        let mut issues = Vec::new();
        validate_heal(&parsed, &mut issues);
        assert!(issues.is_empty(), "{issues:?}");
    }

    #[test]
    fn shapes_and_ranges_are_checked() {
        let shape = |json: &str| {
            parse_heal(&serde_json::from_str(json).unwrap())
                .unwrap_err()
                .code
        };
        assert_eq!(shape(r#"{}"#), "invalidType");
        assert_eq!(
            shape(r#"[{"id":"a","mode":"blur","radius":0.1,"feather":0,"points":[]}]"#),
            "invalidValue"
        );
        assert_eq!(
            shape(r#"[{"id":"a","mode":"remove","radius":0.1,"feather":0,"points":[[0.1]]}]"#),
            "invalidType"
        );
        assert_eq!(
            shape(r#"[{"id":"a","mode":"remove","radius":0.1,"feather":0,"points":[],"size":1}]"#),
            "unknownKey"
        );
        assert_eq!(
            shape(r#"[{"id":"a","mode":"remove","feather":0,"points":[]}]"#),
            "invalidType"
        );
        let many = format!(
            "[{}]",
            vec![r#"{"id":"a","mode":"remove","radius":0.1,"feather":0,"points":[[0,0]]}"#; 65]
                .join(",")
        );
        assert_eq!(shape(&many), "tooMany");
        let points = vec!["[0.5,0.5]"; 513].join(",");
        assert_eq!(
            shape(&format!(
                r#"[{{"id":"a","mode":"remove","radius":0.1,"feather":0,"points":[{points}]}}]"#
            )),
            "tooMany"
        );
        let four = (0..5)
            .map(|i| {
                format!(
                    r#"{{"id":"m{i}","mode":"remove","radius":0.1,"feather":0,"points":[{}]}}"#,
                    vec!["[0.5,0.5]"; 450].join(",")
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        assert_eq!(shape(&format!("[{four}]")), "tooMany");

        let bad = marks(
            r#"[{"id":"","mode":"remove","radius":0.3,"feather":1.5,"points":[]},
                {"id":"x","mode":"clone","radius":0.001,"feather":-0.1,"points":[[1.5,-0.1]],"source":[2,0]},
                {"id":"x","mode":"remove","radius":0.1,"feather":0,"points":[[0,1]]}]"#,
        );
        let mut issues = Vec::new();
        validate_heal(&bad, &mut issues);
        let codes: Vec<(String, String)> = issues.into_iter().map(|e| (e.path, e.code)).collect();
        for (path, code) in [
            ("heal[0].id", "invalidValue"),
            ("heal[0].radius", "outOfRange"),
            ("heal[0].feather", "outOfRange"),
            ("heal[0].points", "emptyPoints"),
            ("heal[1].radius", "outOfRange"),
            ("heal[1].feather", "outOfRange"),
            ("heal[1].points[0][0]", "outOfRange"),
            ("heal[1].points[0][1]", "outOfRange"),
            ("heal[1].source[0]", "outOfRange"),
            ("heal[2].id", "duplicateId"),
        ] {
            assert!(
                codes.contains(&(path.to_string(), code.to_string())),
                "{path} {code}: {codes:?}"
            );
        }
    }

    #[test]
    fn plan_keys_follow_only_the_overlapping_earlier_marks() {
        let base = marks(
            r#"[{"id":"a","mode":"remove","radius":0.01,"feather":0,"points":[[0.1,0.1]]},
                {"id":"b","mode":"remove","radius":0.01,"feather":0,"points":[[0.9,0.9]]},
                {"id":"c","mode":"remove","radius":0.01,"feather":0,"points":[[0.12,0.1]]}]"#,
        );
        let keys = plan_keys(&base, 1000, 800);
        // Moving the far mark "b" keeps "a" and "c"; moving "a" changes "c".
        let mut moved = base.clone();
        moved[1].points[0] = [0.8, 0.9];
        let after = plan_keys(&moved, 1000, 800);
        assert_eq!((keys[0], keys[2]), (after[0], after[2]));
        assert_ne!(keys[1], after[1]);
        let mut near = base.clone();
        near[0].points[0] = [0.11, 0.1];
        let after = plan_keys(&near, 1000, 800);
        assert_ne!(keys[2], after[2]);
        // The id does not count; the size does.
        let mut renamed = base.clone();
        renamed[0].id = "z".into();
        assert_eq!(plan_keys(&renamed, 1000, 800), keys);
        assert_ne!(plan_keys(&base, 500, 400), keys);
    }
}
