//! 現像（`crate::develop`）のテストの道具: 偽の sidecar（sh）。引数・環境変数・cwd を書き残し、印のファイルで失敗・待ちを作る。

use crate::common::random_hex;
use crate::develop::{
  DevelopConfig, DevelopTimeouts, LocalRaster, PhotoDevelop, SidecarPaths, APPLE_RAW_LINEAR_NAME, CACHE_DIR_NAME,
  CACHE_MAX_BYTES, CALIBRATION_REGISTRY_FILE, DEVELOP_RENDER_NAME, RESTORATION_CALIBRATIONS,
  SIGNED_CALIBRATION_REGISTRY_FILE, SIGNED_REGISTRY_SNAPSHOT,
};
use crate::image_info::RasterInfo;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 偽の sidecar が書く PNG（IHDR まで。2560×1707）。
pub const FAKE_PNG: &[u8] =
  b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x0a\x00\x00\x00\x06\xab\x08\x02\x00\x00\x00fake";
/// 偽の同梱の登録表（`calibrationRegistrySha256` はこのバイト列の SHA-256）。
pub const FAKE_REGISTRY: &str = r#"{"schema":"niho-develop-calibration-registry/v1"}"#;
/// 偽の sidecar の `raster` が書く JPEG（SOI・SOF0 の 8bit・3 成分・2560×1707・EOI）。
pub const FAKE_RASTER_JPEG: &[u8] =
  b"\xff\xd8\xff\xc0\x00\x11\x08\x06\xab\x0a\x00\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01\xff\xd9";
/// 偽の sidecar の `raster` の meta の `iccSha256`（偽の sidecar は大文字で書く。Desktop は小文字にそろえる）。
pub const FAKE_RASTER_ICC_SHA256: &str = "8e2c0c4e5b1a5f7c9d3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e";

pub const FAKE_APPLE_RAW_LINEAR: &str = r#"#!/bin/sh
d=$(dirname "$0")
cmd="$1"; shift
{ printf 'apple-raw-linear %s' "$cmd"; for a in "$@"; do printf ' %s' "$a"; done; printf '\n'; } >> "$d/calls.txt"
env | sort > "$d/env-apple-raw-linear.txt"
pwd > "$d/cwd.txt"
case "$cmd" in
  version) if [ -f "$d/tool-version" ]; then echo "apple-raw-linear $(cat "$d/tool-version")"; else echo "apple-raw-linear 0.4.3"; fi ;;
  registry)
    [ -f "$d/registry-exit" ] && { echo '{"error":"invalid_calibration","message":"x"}'; exit 4; }
    [ -f "$2" ] || [ -f "$1" ] || { echo '{"error":"input_not_found","message":"x"}'; exit 4; }
    echo '{"registry":"apple-registry.json","cameras":2,"entries":[]}' ;;
  info)
    printf '%s\n' "$1" >> "$d/opened.txt"
    if [ -f "$d/info-camera.json" ]; then cat "$d/info-camera.json"
    elif [ -f "$d/info-unsupported" ]; then echo '{"camera":{"make":"Panasonic","model":"DC-S5"},"supportedDecoderVersions":["7"]}'
    else echo '{"camera":{"make":"Panasonic","model":"DC-S5"},"supportedDecoderVersions":["7","8"],"nativeSize":{"width":6000,"height":4000},"orientation":1,"neutral":{"temperatureK":5200,"tint":3}}'
    fi ;;
  render)
    out=""; meta=""; wcmeta=""; edge=""; calibration=""; registry=""; decoder="8"; lens="apple"
    while [ $# -gt 0 ]; do
      case "$1" in
        --out) out="$2"; shift 2 ;;
        --meta) meta="$2"; shift 2 ;;
        --working-copy-meta) wcmeta="$2"; shift 2 ;;
        --long-edge) edge="$2"; shift 2 ;;
        --calibration) calibration="$2"; shift 2 ;;
        --calibration-registry) registry="$2"; shift 2 ;;
        --decoder-version) decoder="$2"; shift 2 ;;
        --lens-correction) lens="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    echo "render-start $edge" >> "$d/timeline.txt"
    if [ -f "$d/render-hang" ]; then
      trap '' TERM
      sleep 30 &
      echo $! > "$d/sleep-pid"
      wait
    fi
    [ -f "$d/render-sleep" ] && sleep "$(cat "$d/render-sleep")"
    if [ -f "$d/render-exit" ]; then
      printf '{"error":"%s","message":"/test-data/users/secret/P1.RW2"}\n' "$(cat "$d/render-error")"
      exit "$(cat "$d/render-exit")"
    fi
    cp "$d/fake.png" "$out"
    printf '%s' "$edge" >> "$out"
    if [ -f "$d/wc-meta.json" ]; then cp "$d/wc-meta.json" "$wcmeta"
    elif [ -z "$calibration" ] && [ -z "$registry" ]; then cat > "$wcmeta" <<EOF
{"kind":"raw","_source":{"tool":{"name":"apple-raw-linear","version":"0.4.3"},"decoderVersion":"$decoder","camera":{"make":"Panasonic","model":"DC-S5"},"calibration":null,"lensCorrection":{"mode":"$lens"}}}
EOF
    elif [ "$(basename "$calibration")" = "apple-v3.json" ]; then cat > "$wcmeta" <<'EOF'
{"kind":"raw","_source":{"tool":{"name":"apple-raw-linear","version":"0.4.3"},"decoderVersion":"8","camera":{"make":"Panasonic","model":"DC-S5"},"calibration":{"id":"cal-panasonic-dc-s5-apple-v3","cameraId":"panasonic-dc-s5","track":"apple","version":"v3","baseVersion":"p2"},"lensCorrection":{"mode":"apple"}}}
EOF
    elif echo "$calibration" | grep -q 'sony-zv-e10m2/apple-v2.json$'; then cat > "$wcmeta" <<'EOF'
{"kind":"raw","_source":{"tool":{"name":"apple-raw-linear","version":"0.4.1"},"decoderVersion":"8","camera":{"make":"SONY","model":"ZV-E10M2"},"calibration":{"id":"cal-sony-zv-e10m2-apple-v2","cameraId":"sony-zv-e10m2","track":"apple","version":"v2","baseVersion":"p2"},"lensCorrection":{"mode":"embedded"}}}
EOF
    elif [ "$(basename "$registry")" = "apple-signed-registry.json" ]; then cat > "$wcmeta" <<'EOF'
{"kind":"raw","dcpSha256":"apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v4","_source":{"tool":{"name":"apple-raw-linear","version":"0.5.0"},"decoderVersion":"8","camera":{"make":"Panasonic","model":"DC-S5"},"calibration":{"id":"cal-panasonic-dc-s5-apple-v4","cameraId":"panasonic-dc-s5","track":"apple","version":"v4","baseVersion":"p3"},"lensCorrection":{"mode":"apple"}}}
EOF
    else cat > "$wcmeta" <<'EOF'
{"kind":"raw","baselineEV":-0.11598,"asShotWhite":{"x":0.41,"y":0.40,"temperature":3398,"tint":10},"dcpSha256":"apple-ciraw8/linear-prophoto-d50/cal-panasonic-dc-s5-apple-v2","lookTableIncluded":false,"asShotWhiteAdobe":null,
 "_source":{"tool":{"name":"apple-raw-linear","version":"0.4.1"},"decoderVersion":"8","input":{"path":"/test-data/users/secret/P1.RW2"},"camera":{"make":"Panasonic","model":"DC-S5"},
 "calibration":{"id":"cal-panasonic-dc-s5-apple-v2","cameraId":"panasonic-dc-s5","track":"apple","version":"v2","path":"/test-data/users/secret/cal.json","registry":{"registry":"/test-data/users/secret/apple-registry.json","file":"panasonic-dc-s5/apple-v2.json"}},
 "lensCorrection":{"mode":"apple"},"output":"/test-data/users/secret/work.png","toolMeta":"/test-data/users/secret/work.tool.json","createdAt":"2026-09-29T00:00:00Z"}}
EOF
    fi
    echo '{}' > "$meta"
    echo "render-end $edge" >> "$d/timeline.txt"
    echo '{"ok":true}' ;;
  raster)
    out=""; preview=""; meta=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --out) out="$2"; shift 2 ;;
        --preview-out) preview="$2"; shift 2 ;;
        --meta) meta="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    echo "raster-start" >> "$d/timeline.txt"
    if [ -f "$d/raster-exit" ]; then
      printf '{"error":"%s","message":"/test-data/users/secret/IMG_0001.HEIC"}\n' "$(cat "$d/raster-error")"
      exit "$(cat "$d/raster-exit")"
    fi
    cp "$d/fake.jpg" "$out"
    [ -n "$preview" ] && cp "$d/fake.jpg" "$preview"
    if [ -f "$d/raster-meta.json" ]; then cp "$d/raster-meta.json" "$meta"; else cat > "$meta" <<'EOF'
{"kind":"raster","encoding":"jpeg8","width":2560,"height":1707,"iccSha256":"8E2C0C4E5B1A5F7C9D3A2B1C0D9E8F7A6B5C4D3E2F1A0B9C8D7E6F5A4B3C2D1E","colorSpace":"kCGColorSpaceDisplayP3","converted":null,"sourceWidth":4032,"sourceHeight":2688,"orientationApplied":true,"bytes":24,"preview":null,"tool":{"name":"apple-raw-linear","version":"0.4.3"},"input":"/test-data/users/secret/IMG_0001.HEIC"}
EOF
    fi
    echo "raster-end" >> "$d/timeline.txt"
    cat "$meta" ;;
  encode-jpeg)
    out=""
    while [ $# -gt 0 ]; do case "$1" in --out) out="$2"; shift 2 ;; *) shift ;; esac; done
    echo "encode" >> "$d/timeline.txt"
    # 本物の encode-jpeg と同じく、書き出し先のフォルダに .<名前>.partial-<pid> を書いてから rename する（途中で止まると残る）
    partial="$(dirname "$out")/.$(basename "$out").partial-$$"
    [ -f "$d/encode-partial" ] && printf 'PARTIAL' > "$partial"
    [ -f "$d/encode-hang" ] && sleep 30
    [ -f "$d/encode-crash" ] && { echo "cannot write $out in $(dirname "$out")" >&2; exit 6; }
    [ -f "$d/encode-exit" ] && { echo '{"error":"write_failed","message":"x"}'; exit 4; }
    printf 'JPEG' > "$out"
    echo '{"ok":true}' ;;
  *) echo '{"error":"invalid_arguments","message":"x"}'; exit 1 ;;
esac
"#;

pub const FAKE_DEVELOP_RENDER: &str = r#"#!/bin/sh
d=$(dirname "$0")
cmd="$1"; shift
{ printf 'niho-develop-render %s' "$cmd"; for a in "$@"; do printf ' %s' "$a"; done; printf '\n'; } >> "$d/calls.txt"
env | sort > "$d/env-niho-develop-render.txt"
case "$cmd" in
  version) if [ -f "$d/render-version" ]; then v=$(cat "$d/render-version"); else v=0.11.0; fi; echo "niho-develop-render $v (niho-develop $v, engine niho-3)" ;;
  capabilities) if [ -f "$d/render-capabilities" ]; then cat "$d/render-capabilities"; else echo '{"error":"invalid_arguments","message":"x"}'; exit 1; fi ;;
  render)
    out=""; settings=""; wc=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --out) out="$2"; shift 2 ;;
        --settings) settings="$2"; shift 2 ;;
        --working-copy) wc="$2"; shift 2 ;;
        --mask-surface) ms="$2"; cp "${ms#*=}" "$d/last-surface-${ms%%=*}.png"; shift 2 ;;
        *) shift ;;
      esac
    done
    echo "develop" >> "$d/timeline.txt"
    cp "$settings" "$d/last-settings.json"
    [ -n "$wc" ] && [ -f "$wc" ] && cp "$wc" "$d/last-working-copy.png"
    if [ -f "$d/develop-exit" ]; then echo '{"error":"unsupported_settings","message":"x"}'; exit "$(cat "$d/develop-exit")"; fi
    cp "$d/fake.png" "$out"
    echo '{"width":2560,"height":1707}' ;;
  *) echo '{"error":"invalid_arguments","message":"x"}'; exit 1 ;;
esac
"#;

pub const FAKE_SIPS: &str = r#"#!/bin/sh
d=$(dirname "$0")
{ printf 'sips'; for a in "$@"; do printf ' %s' "$a"; done; printf '\n'; } >> "$d/calls.txt"
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$out" ]; then
  cp "$d/fake.jpg" "$out"
else
  printf '/test-data/hidden/input\n  pixelWidth: 6000\n  pixelHeight: 4000\n  orientation: 1\n  format: jpeg\n'
fi
"#;

/// 偽の sidecar・校正・ImageIO hook と、作業コピーのキャッシュの一時フォルダ
/// （`<dir>/sidecars`・`<dir>/cache/photo-develop`）。
pub struct SidecarHarness {
  /// 一時フォルダ
  pub dir: PathBuf,
  pub sidecars: PathBuf,
  pub logs: Arc<Mutex<Vec<String>>>,
  /// {@link SidecarHarness::new} が作った一時フォルダ（Drop で消す）。{@link SidecarHarness::in_dir} のフォルダは作った側が消す
  owns_dir: bool,
}

fn write_executable(path: &Path, script: &str) {
  use std::os::unix::fs::PermissionsExt;
  fs::write(path, script).unwrap();
  fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

impl SidecarHarness {
  /// 一時フォルダを作り、その `sidecars` に偽の sidecar・校正を置く（Drop で消す）。
  pub fn new(name: &str) -> Self {
    let dir = std::env::temp_dir().join(format!(
      "niho-desktop-photo-develop-test-{name}-{}-{}",
      std::process::id(),
      random_hex(6)
    ));
    fs::create_dir_all(&dir).unwrap();
    let mut harness = Self::in_dir(dir);
    harness.owns_dir = true;
    harness
  }

  /// `dir`（ほかのテストの道具が作った一時フォルダ）の `sidecars` に偽の sidecar・校正を置く。`dir` は消さない。
  pub fn in_dir(dir: PathBuf) -> Self {
    let sidecars = dir.join("sidecars");
    fs::create_dir_all(sidecars.join("calibration/panasonic-dc-s5")).unwrap();
    fs::create_dir_all(sidecars.join("calibration/sony-zv-e10m2")).unwrap();
    fs::create_dir_all(sidecars.join("calibration/sony-ilme-fx30")).unwrap();
    write_executable(&sidecars.join(APPLE_RAW_LINEAR_NAME), FAKE_APPLE_RAW_LINEAR);
    write_executable(&sidecars.join(DEVELOP_RENDER_NAME), FAKE_DEVELOP_RENDER);
    write_executable(&sidecars.join("sips"), FAKE_SIPS);
    fs::write(sidecars.join("fake.png"), FAKE_PNG).unwrap();
    fs::write(sidecars.join("fake.jpg"), FAKE_RASTER_JPEG).unwrap();
    fs::write(
      sidecars.join("calibration").join(CALIBRATION_REGISTRY_FILE),
      FAKE_REGISTRY,
    )
    .unwrap();
    fs::write(
      sidecars.join("calibration").join(SIGNED_CALIBRATION_REGISTRY_FILE),
      SIGNED_REGISTRY_SNAPSHOT,
    )
    .unwrap();
    for restoration in RESTORATION_CALIBRATIONS {
      fs::write(
        sidecars.join("calibration").join(restoration.file),
        restoration.snapshot,
      )
      .unwrap();
    }
    for (current, snapshot) in [
      (
        "panasonic-dc-s5/apple-v4.json",
        include_bytes!("../../calibration/panasonic-dc-s5/apple-v4.json").as_slice(),
      ),
      (
        "sony-zv-e10m2/apple-v3.json",
        include_bytes!("../../calibration/sony-zv-e10m2/apple-v3.json").as_slice(),
      ),
      (
        "sony-ilme-fx30/apple-v2.json",
        include_bytes!("../../calibration/sony-ilme-fx30/apple-v2.json").as_slice(),
      ),
    ] {
      fs::write(sidecars.join("calibration").join(current), snapshot).unwrap();
    }
    Self {
      dir,
      sidecars,
      logs: Arc::new(Mutex::new(Vec::new())),
      owns_dir: false,
    }
  }

  pub fn config(&self) -> DevelopConfig {
    let logs = self.logs.clone();
    let metadata_dir = self.sidecars.clone();
    DevelopConfig {
      sidecars: Some(SidecarPaths {
        apple_raw_linear: self.sidecars.join(APPLE_RAW_LINEAR_NAME),
        develop_render: self.sidecars.join(DEVELOP_RENDER_NAME),
        calibration_dir: self.sidecars.join("calibration"),
      }),
      cache_dir: Some(self.cache_dir()),
      cache_max_bytes: CACHE_MAX_BYTES,
      timeouts: DevelopTimeouts {
        probe: Duration::from_secs(10),
        query: Duration::from_secs(10),
        heavy: Duration::from_secs(10),
        kill_grace: Duration::from_millis(300),
      },
      sips: self.sidecars.join("sips"),
      raster_info: Some(Arc::new(move |path| {
        if metadata_dir.join("image-info-error").is_file() {
          return Err("/test-data/users/secret/photo.jpg could not be read".into());
        }
        let mut opened = fs::OpenOptions::new()
          .create(true)
          .append(true)
          .open(metadata_dir.join("opened.txt"))
          .map_err(|err| err.to_string())?;
        writeln!(opened, "{}", path.display()).map_err(|err| err.to_string())?;
        let orientation = fs::read_to_string(metadata_dir.join("image-orientation"))
          .ok()
          .and_then(|value| value.trim().parse().ok())
          .unwrap_or(1);
        Ok(RasterInfo {
          width: 6000,
          height: 4000,
          orientation,
        })
      })),
      signed_raw_generation: false,
      local_raster: LocalRaster::Desktop,
      log: Arc::new(move |kind, payload| logs.lock().unwrap().push(format!("{kind} {payload}"))),
    }
  }

  pub fn cache_dir(&self) -> PathBuf {
    self.dir.join("cache").join(CACHE_DIR_NAME)
  }

  pub fn develop(&self) -> Arc<PhotoDevelop> {
    PhotoDevelop::new(self.config())
  }

  pub fn develop_with(&self, adjust: impl FnOnce(&mut DevelopConfig)) -> Arc<PhotoDevelop> {
    let mut config = self.config();
    adjust(&mut config);
    PhotoDevelop::new(config)
  }

  pub fn mark(&self, name: &str, content: &str) {
    fs::write(self.sidecars.join(name), content).unwrap();
  }

  pub fn unmark(&self, name: &str) {
    let _ = fs::remove_file(self.sidecars.join(name));
  }

  pub fn lines(&self, file: &str) -> Vec<String> {
    fs::read_to_string(self.sidecars.join(file))
      .unwrap_or_default()
      .lines()
      .map(str::to_string)
      .collect()
  }

  /// probe（version・registry・version・capabilities）を除いた呼び出し
  pub fn work_calls(&self) -> Vec<String> {
    self
      .lines("calls.txt")
      .into_iter()
      .filter(|line| {
        !line.ends_with(" version")
          && !line.ends_with(" capabilities")
          && !line.starts_with("apple-raw-linear registry")
      })
      .collect()
  }

  pub fn cache_names(&self) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(self.cache_dir())
      .map(|entries| {
        entries
          .flatten()
          .map(|entry| entry.file_name().to_string_lossy().into_owned())
          .collect()
      })
      .unwrap_or_default();
    names.sort();
    names
  }

  pub fn has_log(&self, needle: &str) -> bool {
    self.logs.lock().unwrap().iter().any(|line| line.contains(needle))
  }

  pub fn log_lines(&self) -> Vec<String> {
    self.logs.lock().unwrap().clone()
  }
}

impl Drop for SidecarHarness {
  fn drop(&mut self) {
    if self.owns_dir {
      let _ = fs::remove_dir_all(&self.dir);
    }
  }
}
