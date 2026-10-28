//! 写真編集の現像（「この Mac」の写真の作業コピーと原寸の書き出し）の土台（S7c-2 #16946、
//公開移植前の内部構成については docs/migration/mac-client.md を参照。
//公開移植前の内部構成については docs/migration/mac-client.md を参照。
//! 保存ダイアログ・`.app` の中の sidecar の場所・ログの書き先はアプリが持ち、ここは写真の出どころ（{@link DevelopPhotos}）と
//! 設定（{@link DevelopConfig}）を受け取る。
//!
//公開移植前の内部構成については docs/migration/mac-client.md を参照。
//!   同じ土台で長辺 2560px の作業コピーにする。RAW は `.app` に同梱した `apple-raw-linear` をワーカーと同じ引数・同じ環境変数
//!   （HOME と PATH=/usr/bin:/bin だけ）で動かし、同じ校正の登録表（`Contents/Resources/develop-calibration/`）を当てる。
//!   `baseVersion` とページへ出す meta もワーカーと同じ規則で組む（`packages/develop-engine/calibration/base-version-vectors.json`
//!   をワーカーとこのファイルのテストの両方で確かめる）。HEIC / HEIF・TIFF・上限を超える JPEG / PNG は
//!   `apple-raw-linear raster` で作業コピーにする。上限以下の JPEG / PNG はオリジナルをそのまま渡す（ページが wasm で直接描く）。
//! - 原寸の書き出し: `apple-raw-linear render --long-edge full`（RAW だけ）→ 段 2 の native CLI `niho-develop-render` →
//!   `apple-raw-linear encode-jpeg`（オリジナルの撮影日時だけを付けた JPEG。Epic #17114 Decision 10）を順に動かし、書き出し先と
//!   同じフォルダの一時ファイルから rename する。途中のファイルは成功・失敗にかかわらず消す。HEIC / HEIF・TIFF は
//!   `unsupportedSource`。記事用の派生 JPEG はブラウザの wasm で作る。
//! - 作業コピーをクラウドへ一緒に上げる（v21。W2b-2 #17145・決まりごと 3）: `photo_editing_work_copy_info` は RAW の作業コピーを
//!   `photo_editing_develop_source` と同じ作り方・同じキャッシュで用意し、版・meta・大きさと同梱の登録表の SHA-256 を返す。上げる
//!   （`photo_editing_cloud_upload_work`、`photo_cloud.rs`）間は待ち行列の番と実行中の印を持つ（{@link PhotoDevelop::hold_work_copy}）。
//!   v22（W2c-2 #17145）から、HEIC / HEIF・TIFF・10MiB を超える PNG も同じ 2 つのコマンドで上げる。こちらはワーカーと同じ
//!   `apple-raw-linear raster`（同じ引数・環境変数）で ICC 付きの 8bit JPEG（`raster.ci2.p2.e2.icc-<srgb | ICC の SHA-256>`）を
//!   この Mac の編集とクラウド用で同じ `raster.ci2` 作業コピーを使う。
//! - 重い処理（作業コピー・書き出しの 3 段・作業コピーを上げる）は同時に 1 本（到着順の待ち
//!   行列。1 段で 0.9GB 前後使う）。子プロセスは 10 分で SIGTERM → SIGKILL。自分のプロセスグループ・cwd `/`・環境変数は HOME と
//!   PATH だけ。
//! - 作業コピーのキャッシュは `<app cache>/photo-develop/<写真の SHA-256>-<baseVersion>.png`（ラスタのクラウド用は `.jpg`）と
//!   `.json`（フォルダ 0700・ファイル 0600。合計 2GB を超えたら最終利用の古い順に消す）。同じ写真・同じ作り方（sidecar の版と
//!   校正）なら作り直さない。使う前に写真の中身を開いたときの SHA-256 と照らし、変わっていれば
//!   `cloudContentMismatch`。
//! - ページへはパスを渡さない（`photoId` と不透明な `token` だけ）。作業コピーのバイト列は `token`（1 回限り・10 分）で
//!   別のコマンドから受け取る（JSON に入れない）。

use crate::capabilities::{validate_photo_static, CapabilityStage};
use crate::common::{code, is_executable_file, lock, random_hex, scrub_paths, LogFn, PageError};
use crate::image_info::{read_raster_info, RasterInfo};
use crate::library::photo_kind;
use crate::mask_surfaces::{mask_surface_id, mask_surface_ids};
use crate::saved_settings::{
  content_digest, ensure_private_dir, is_content_key, set_mode, write_private_file_atomically, ContentDigest,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "macos")]
use std::os::unix::ffi::OsStrExt;

/// `.app` の `Contents/MacOS/` に同梱する sidecar（develop-sidecars-lock.mjs の stage が置く）。
pub const APPLE_RAW_LINEAR_NAME: &str = "apple-raw-linear";
pub const DEVELOP_RENDER_NAME: &str = "niho-develop-render";
/// `.app` の `Contents/Resources/` に置く校正のフォルダと、その中の登録表（develop-sidecars-lock.mjs と同じ名前）。
pub const CALIBRATION_RESOURCE_DIR: &str = "develop-calibration";
pub const CALIBRATION_REGISTRY_FILE: &str = "apple-registry.json";
pub const SIGNED_CALIBRATION_REGISTRY_FILE: &str = "apple-signed-registry.json";
/// 作業コピーのキャッシュ（アプリのキャッシュのフォルダの中）と上限。
pub const CACHE_DIR_NAME: &str = "photo-develop";
pub const CACHE_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// 作業コピーの長辺（ワーカーの `APPLE_RAW_LINEAR_WORKING_COPY_LONG_EDGE`）。
pub const WORKING_COPY_LONG_EDGE: u32 = 2560;
/// JPEG / PNG をオリジナルのまま渡す上限（web の `DEVELOP_WORK_DIRECT_RASTER_MAX_BYTES`・API の
/// `PHOTO_CLOUD_WORK_DIRECT_RASTER_MAX_BYTES` と同じ 10MiB）。超えたら作業コピーにする。
pub const DIRECT_RASTER_MAX_BYTES: u64 = 10 * 1024 * 1024;
/// {@link LocalRaster::Camera}（NIHO camera）で JPEG をオリジナルのまま渡す上限（web の `develop-work-target.ts` と同じ
/// 64MiB。K5-a #17153）。4,000 万画素を超える JPEG は画面が開いて分かるので、{@link PhotoDevelop::source_with_options} の
/// `force_working_copy` で作業コピーを求める。
pub const DIRECT_JPEG_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// 旧 recipe のまま受け付ける apple-raw-linear の系列（ワーカーの `APPLE_RAW_LINEAR_COMPATIBLE_SERIES`）。
pub const APPLE_RAW_LINEAR_SERIES: [&str; 2] = ["0.4", "0.5"];
/// 段 1 の処理の版・作業コピーの符号化の版（ワーカーの `APPLE_RAW_LINEAR_PROCESSING_VERSION`・`_ENCODING_VERSION`）。
const PROCESSING_VERSION: &str = "p2";
const ENCODING_VERSION: &str = "e1";
const SIGNED_PROCESSING_VERSION: &str = "p3";
const SIGNED_ENCODING_VERSION: &str = "e4";
const SIGNED_ENCODING_FORMAT: &str = "png16-signed-g18";
const SIGNED_MIN_TOOL_VERSION: &str = "0.5.0";
const SIGNED_MIN_RENDER_VERSION: &str = "0.11.0";
const NIHO7_MIN_RENDER_VERSION: &str = "0.16.0";
const NIHO11_MIN_RENDER_VERSION: &str = "0.18.0";
/// 部分補正（`developSettings.masks`。線形・円形と、面〔`--mask-surface`〕を読むブラシ・被写体・空。docs/local-adjustments.md）を
/// 描ける niho-develop-render の最小の版。これより古い sidecar へは `masks` のある設定を渡さない（`v: 5` を読めないか、マスクを
/// 描かない）。0.19.0 は線形・円形（#66）と面の口（#68）を同じ版で出す（どちらも公開前）ので、版の境は 1 つ。
pub const MASKS_MIN_RENDER_VERSION: &str = "0.19.0";
/// 同梱の niho-develop-render が描ける設定（`niho-develop-render capabilities` の 1 行。niho-photo#131）。原寸の書き出しへ渡せる
/// 設定は、版ではなくこれで決める。この口の無い古い renderer（0.16.0 など）は無い（None）扱いで、画面は遠近・修復・レンズ補正・
/// 中間調 / 全体の輝度を原寸へ渡さない（`packages/photo-editing/src/photo-editing-native-export.ts`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderCapabilities {
  /// 読める `developSettings.v`
  pub settings_versions: Vec<u32>,
  /// 描ける `developSettings.engine`
  pub engines: Vec<String>,
  /// `v` を上げずに足した描画（`colorGradingLuminance`: 中間調・全体の輝度）。古い renderer は黙って描かない
  pub features: Vec<String>,
  /// 描けるマスクの種類（`brush`・`subject`・`sky` は面を `--mask-surface` で受け取る）
  pub mask_kinds: Vec<String>,
  /// 読める元（オリジナル・作業コピー）の最大の画素数
  pub max_pixels: u64,
}

/// {@link RenderCapabilities} の一覧の長さ・名前の長さの上限（壊れた出力を覚えない）。
const RENDER_CAPABILITY_MAX_ITEMS: usize = 64;
const RENDER_CAPABILITY_MAX_NAME: usize = 64;
/// 中間調・全体の輝度（{@link RenderCapabilities::features}）。
const RENDER_FEATURE_COLOR_GRADING_LUMINANCE: &str = "colorGradingLuminance";

impl RenderCapabilities {
  /// `niho-develop-render capabilities` の stdout を読む。形が違えば None（描ける設定が分からない = 古い renderer と同じ扱い）。
  pub fn parse(stdout: &str) -> Option<Self> {
    let value: Value = serde_json::from_str(stdout.trim()).ok()?;
    if value.get("tool").and_then(Value::as_str) != Some(DEVELOP_RENDER_NAME) {
      return None;
    }
    let names = |key: &str| -> Option<Vec<String>> {
      let items = value.get(key)?.as_array()?;
      if items.len() > RENDER_CAPABILITY_MAX_ITEMS {
        return None;
      }
      items
        .iter()
        .map(|item| {
          item
            .as_str()
            .filter(|name| !name.is_empty() && name.len() <= RENDER_CAPABILITY_MAX_NAME)
            .map(str::to_string)
        })
        .collect()
    };
    let versions = value.get("settingsVersions")?.as_array()?;
    if versions.is_empty() || versions.len() > RENDER_CAPABILITY_MAX_ITEMS {
      return None;
    }
    let settings_versions = versions
      .iter()
      .map(|item| item.as_u64().and_then(|v| u32::try_from(v).ok()).filter(|v| *v > 0))
      .collect::<Option<Vec<u32>>>()?;
    let engines = names("engines").filter(|engines| !engines.is_empty())?;
    let max_pixels = value.get("maxPixels")?.as_u64().filter(|pixels| *pixels > 0)?;
    Some(Self {
      settings_versions,
      engines,
      features: names("features")?,
      mask_kinds: names("maskKinds")?,
      max_pixels,
    })
  }

  /// 画面へ渡す形（`camera_develop_status` の `renderer`。`PhotoLibraryCapabilities.nativeExportRenderer`）。
  pub fn to_json(&self) -> Value {
    json!({
      "settingsVersions": self.settings_versions,
      "engines": self.engines,
      "features": self.features,
      "maskKinds": self.mask_kinds,
      "maxPixels": self.max_pixels,
    })
  }

  /// この設定を描けないときの理由（ログ用）。`v`・`engine` が読めない版か、`v` を上げずに足した描画（中間調・全体の輝度）を
  /// 描けない。`v`・`engine` の無い設定はここでは見ない（renderer が `unsupported_settings` で断る）。
  pub fn unsupported_reason(&self, develop_settings: &Value) -> Option<String> {
    if let Some(v) = develop_settings.get("v").and_then(Value::as_f64) {
      if !self.settings_versions.iter().any(|readable| f64::from(*readable) == v) {
        return Some(format!(
          "developSettings v {v} is not readable by the bundled niho-develop-render"
        ));
      }
    }
    if let Some(engine) = develop_settings.get("engine").and_then(Value::as_str) {
      if !self.engines.iter().any(|known| known == engine) {
        return Some(format!(
          "engine {engine} is not rendered by the bundled niho-develop-render"
        ));
      }
    }
    if uses_color_grading_luminance(develop_settings)
      && !self
        .features
        .iter()
        .any(|feature| feature == RENDER_FEATURE_COLOR_GRADING_LUMINANCE)
    {
      return Some("the bundled niho-develop-render does not draw the midtone / global luminance".into());
    }
    None
  }
}

/// 中間調・全体の輝度（`colorGrading.midtone.luminance`・`colorGrading.global.luminance`）が 0 でない（数でない値も、描けない
/// 設定として true）。
fn uses_color_grading_luminance(develop_settings: &Value) -> bool {
  ["midtone", "global"].iter().any(|zone| {
    develop_settings
      .get("colorGrading")
      .and_then(|grading| grading.get(zone))
      .and_then(|band| band.get("luminance"))
      .is_some_and(|luminance| luminance.as_f64() != Some(0.0))
  })
}
pub(crate) const SIGNED_REGISTRY_SNAPSHOT: &[u8] = include_bytes!("../calibration/apple-signed-registry.json");

#[derive(Clone, Copy)]
pub(crate) struct RestorationCalibration {
  calibration_id: &'static str,
  pub(crate) file: &'static str,
  pub(crate) snapshot: &'static [u8],
  camera_id: &'static str,
  camera_make: &'static str,
  camera_model: &'static str,
  version: &'static str,
  lens_mode: &'static str,
}

/// 公開済み p2 のうち current registry から外れた immutable 校正だけを明示同梱する。
pub(crate) const RESTORATION_CALIBRATIONS: [RestorationCalibration; 3] = [
  RestorationCalibration {
    calibration_id: "panasonic-dc-s5-apple-v2",
    file: "panasonic-dc-s5/apple-v2.json",
    snapshot: include_bytes!("../calibration/panasonic-dc-s5/apple-v2.json"),
    camera_id: "panasonic-dc-s5",
    camera_make: "Panasonic",
    camera_model: "DC-S5",
    version: "v2",
    lens_mode: "apple",
  },
  RestorationCalibration {
    calibration_id: "panasonic-dc-s5-apple-v3",
    file: "panasonic-dc-s5/apple-v3.json",
    snapshot: include_bytes!("../calibration/panasonic-dc-s5/apple-v3.json"),
    camera_id: "panasonic-dc-s5",
    camera_make: "Panasonic",
    camera_model: "DC-S5",
    version: "v3",
    lens_mode: "apple",
  },
  RestorationCalibration {
    calibration_id: "sony-zv-e10m2-apple-v2",
    file: "sony-zv-e10m2/apple-v2.json",
    snapshot: include_bytes!("../calibration/sony-zv-e10m2/apple-v2.json"),
    camera_id: "sony-zv-e10m2",
    camera_make: "SONY",
    camera_model: "ZV-E10M2",
    version: "v2",
    lens_mode: "embedded",
  },
];
/// ラスタの作業コピー（`apple-raw-linear raster`。W2c-2 #17145）の読み方の版・符号化の版と JPEG の品質（ワーカーの
/// `APPLE_RAW_LINEAR_RASTER_DECODER_VERSION`・`_RASTER_ENCODING_VERSION`・`_RASTER_QUALITY`。テストでワーカーの値と照らす）。
const RASTER_DECODER_VERSION: &str = "ci2";
const RASTER_ENCODING_VERSION: &str = "e2";
const RASTER_QUALITY: &str = "0.94";
/// `raster` のある最初の apple-raw-linear（ワーカーの `APPLE_RAW_LINEAR_RASTER_MIN_VERSION`）。これより前の同梱物ではラスタの
/// 作業コピーを上げない（`photoEditingCloudWorkRaster` が false）。
pub const RASTER_MIN_TOOL_VERSION: &str = "0.4.3";
/// `raster --long-edge full` による原寸 JPEG 書き出しを持つ最初の sidecar。0.5.1 は登録表の fallback（#18398）だけで、
/// この口を持たない（同じ版で中身が別にならないよう、口を足した版を 0.5.2 にした）。
pub const FULL_SIZE_RASTER_MIN_TOOL_VERSION: &str = "0.5.2";
/// 作業コピーの JPEG の先頭から読む長さ（API の `PHOTO_CLOUD_WORK_JPEG_HEADER_BYTES` と同じ 128KiB。SOF はこの中にある）。
const JPEG_HEADER_BYTES: u64 = 128 * 1024;
/// 原寸の書き出しの JPEG の品質。
const EXPORT_JPEG_QUALITY: &str = "0.92";
const PREVIEW_JPEG_QUALITIES: [u8; 4] = [85, 72, 60, 45];
const MAX_PREVIEW_BYTES: u64 = 1024 * 1024;
/// `token` の有効期間と、覚えておく数の上限（1 回使ったら消す）。
const TOKEN_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_TOKENS: usize = 64;
/// 落ちた仕事の一時フォルダ・書きかけのファイルを消すまでの時間。
const ORPHAN_AGE: Duration = Duration::from_secs(60 * 60);
const WORK_DIR_PREFIX: &str = "work-";
/// キャッシュの記録（`.json`）の大きさの上限（meta は数 KB）。
const MAX_RECORD_BYTES: u64 = 1024 * 1024;
/// キャッシュの記録の版。2（W2b-2 #17145）: meta に `whiteBalanceTable` を写すようにした（それより前の記録の meta には無いので、
/// 使わずに作り直す）。3（W2c-2 #17145）: 作業コピーのファイルの拡張子（`extension`。PNG か、ラスタのクラウド用の JPEG）と
/// その SHA-256（`sha256`。前は `pngSha256`）を記録する（それより前の記録は使わずに作り直す）。
pub const CACHE_RECORD_VERSION: u64 = 3;
/// sidecar の標準出力・標準エラー出力を持つ量。
const STDOUT_MAX_BYTES: usize = 1024 * 1024;
const STDERR_TAIL_BYTES: usize = 8 * 1024;
const TOOL_POLL_INTERVAL: Duration = Duration::from_millis(20);
/// sidecar へ渡す PATH（ワーカーと同じ。利用者の PATH は渡さない）。
pub(crate) const SIDECAR_PATH_VAR: &str = "/usr/bin:/bin";

/// ページへ返す現像の code（エンジンの code・`engineUnavailable`・`folderNotFound`・`cloudContentMismatch` に足す）。
pub mod develop_code {
  /// 原寸の書き出しがこの形式に対応していない（HEIC / HEIF・TIFF）
  pub const UNSUPPORTED_SOURCE: &str = "unsupportedSource";
  /// 補正（`developSettings` の `v`・`engine`・`look`）をこの NIHO Desktop の段 2 が描けない（新しい Desktop が要る）
  pub const UNSUPPORTED_SETTINGS: &str = "unsupportedSettings";
  /// macOS の RAW 現像（RAW 8、DNG は 8.dng）がその機種に対応していない
  pub const UNSUPPORTED_CAMERA: &str = "unsupportedCamera";
  /// クラウドへ上げる作業コピーの対象でない写真（`photo_editing_work_copy_info` / `_cloud_upload_work`。v21 は RAW だけ、v22 は
  /// RAW・HEIC / HEIF・TIFF・10MiB を超える PNG のほか。JPEG・10MiB 以下の PNG は対象外）
  pub const NOT_APPLICABLE: &str = "notApplicable";
  /// 保存した RAW の土台を同じ recipe / 校正で復元できない。別の校正で同じ base を名乗らせない。
  pub const RESTORATION_UNAVAILABLE: &str = "restorationUnavailable";
  /// 補正の描かれるマスク（ブラシ・被写体・空）の面が、この Mac の面の置き場（{@link DevelopPhotos::mask_surface}）に無い・
  /// 読めない（エンジンの `maskSurfaceMissing` と同じ語）。書き出しの前に断る
  pub const MASK_SURFACE_MISSING: &str = "maskSurfaceMissing";
  /// 写真が原寸では大きすぎる（同梱の renderer が読める画素数を超える・この Mac のメモリに収まらない見込み。
  /// {@link FullSizeTooLarge}）。書き出しの前に断る（niho-photo#132）
  pub const TOO_LARGE: &str = "tooLarge";
}

pub const UNAVAILABLE_MESSAGE: &str = "この NIHO Desktop では現像を使えません。NIHO Desktop を入れ直してください。";
pub const TIMEOUT_MESSAGE: &str = "現像に時間がかかりすぎたため止めました。もう一度お試しください。";
const CACHE_PURGING_MESSAGE: &str = "写真のキャッシュを削除中です。完了後にもう一度お試しください。";
const SOURCE_FAILED_MESSAGE: &str = "現像の準備ができませんでした。もう一度お試しください。";
const UNSUPPORTED_CAMERA_MESSAGE: &str = "この RAW は macOS の RAW 現像に対応していないため、現像の準備ができません。";
const DECODE_FAILED_MESSAGE: &str = "写真を読み込めませんでした。壊れているか、対応していない形式です。";
pub const PHOTO_CHANGED_MESSAGE: &str = "開いた後に写真のファイルが変わりました。写真を開き直してください。";
const PHOTO_UNREADABLE_MESSAGE: &str = "写真のファイルを読めません。写真を開き直してください。";
const PHOTO_NOT_OPEN_MESSAGE: &str = "写真が見つかりません。写真を開き直してください。";
pub const TOKEN_NOT_FOUND_MESSAGE: &str = "現像の準備をやり直してください。";
const UNSUPPORTED_SOURCE_MESSAGE: &str = "HEIC・TIFF の写真は、この書き出しに対応していません。";
const UNSUPPORTED_RASTER_DIMENSIONS_MESSAGE: &str = "この画像の寸法は JPEG の上限を超えるため、原寸で書き出せません。";
pub const UNSUPPORTED_SETTINGS_MESSAGE: &str =
  "この写真の補正は、この NIHO Desktop ではまだ書き出せません。NIHO Desktop を更新してください。";
const EXPORT_FAILED_MESSAGE: &str = "書き出せませんでした。もう一度お試しください。";
pub const EXPORT_WRITE_FAILED_MESSAGE: &str = "書き出せませんでした。保存先を確かめてください。";
/// 作業コピーを作る `apple-raw-linear` が使えない（同梱の sidecar が無い・確かめに通らない）。
const NOT_APPLICABLE_MESSAGE: &str = "この写真の作業コピーはクラウドへ上げません。";
pub const INVALID_BASE_VERSION_MESSAGE: &str = "作業コピーの版が変わりました。もう一度お試しください。";
const RESTORATION_UNAVAILABLE_MESSAGE: &str =
  "保存した補正の土台を復元できません。NIHO Desktop を更新してもう一度お試しください。";
pub const MASK_SURFACE_MISSING_MESSAGE: &str =
  "部分補正のマスク（ブラシなど）の面がこの Mac に見つからないため、書き出せません。マスクを描き直してください。";
const INTERNAL_MESSAGE: &str = "現像で予期しないエラーが起きました。";

// ---------------------------------------------------------------------------
// 入力の分け方（web の `isDevelopWorkTarget`・API の `isPhotoCloudWorkTarget` と同じ規則）

/// `photo_editing_develop_source` の入力。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DevelopInput {
  /// RAW（写真の拡張子のうちラスタでないもの）: apple-raw-linear の作業コピー
  Raw,
  /// 10MiB 以下の JPEG / PNG: オリジナルをそのまま
  Raster,
  /// HEIC / HEIF・TIFF と上限を超える JPEG / PNG: apple-raw-linear の作業コピー
  RasterWorkingCopy,
}

fn extension_of(file_name: &str) -> String {
  file_name
    .rsplit_once('.')
    .map(|(_, extension)| extension.to_lowercase())
    .unwrap_or_default()
}

fn oriented_dimensions(width: u64, height: u64, orientation: u64) -> Option<(u64, u64)> {
  if width == 0 || height == 0 {
    return None;
  }
  Some(if matches!(orientation, 5..=8) {
    (height, width)
  } else {
    (width, height)
  })
}

fn raw_page_info(info: &Value) -> Option<Value> {
  let native = info.get("nativeSize")?;
  let width = native.get("width")?.as_u64()?;
  let height = native.get("height")?.as_u64()?;
  let orientation = info.get("orientation").and_then(Value::as_u64).unwrap_or(1);
  let (width, height) = oriented_dimensions(width, height, orientation)?;
  let as_shot = info
    .get("neutral")
    .filter(|value| value.is_object())
    .and_then(|neutral| {
      Some(json!({
        "temperature": neutral.get("temperatureK")?.as_f64()?,
        "tint": neutral.get("tint")?.as_f64()?,
      }))
    })
    .unwrap_or(Value::Null);
  Some(json!({
    "kind": "raw",
    "width": width,
    "height": height,
    "asShotWhiteBalance": as_shot,
    "settings": {},
  }))
}

/// sips が追加する EXIF と IPTC だけを除く。ICC (APP2) と圧縮画素には触れず、不正なsegmentは拒否する。
fn strip_jpeg_private_metadata(bytes: &[u8]) -> Option<Vec<u8>> {
  if !bytes.starts_with(&[0xff, 0xd8]) {
    return None;
  }
  let mut output = bytes[..2].to_vec();
  let mut offset = 2usize;
  while offset + 2 <= bytes.len() {
    if bytes[offset] != 0xff {
      return None;
    }
    let marker = bytes[offset + 1];
    if marker == 0xda || marker == 0xd9 {
      output.extend_from_slice(&bytes[offset..]);
      return Some(output);
    }
    if matches!(marker, 0x01 | 0xd0..=0xd7) {
      output.extend_from_slice(&bytes[offset..offset + 2]);
      offset += 2;
      continue;
    }
    if offset + 4 > bytes.len() {
      return None;
    }
    let length = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]) as usize;
    let end = offset.checked_add(2 + length)?;
    if length < 2 || end > bytes.len() {
      return None;
    }
    if marker != 0xe1 && marker != 0xed {
      output.extend_from_slice(&bytes[offset..end]);
    }
    offset = end;
  }
  None
}

fn jpeg_has_no_exif_or_gps(bytes: &[u8]) -> bool {
  if !bytes.starts_with(&[0xff, 0xd8]) {
    return false;
  }
  let mut offset = 2usize;
  while offset + 2 <= bytes.len() {
    if bytes[offset] != 0xff {
      return false;
    }
    let marker = bytes[offset + 1];
    if marker == 0xda || marker == 0xd9 {
      return true;
    }
    if matches!(marker, 0x01 | 0xd0..=0xd7) {
      offset += 2;
      continue;
    }
    if offset + 4 > bytes.len() {
      return false;
    }
    let length = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]) as usize;
    if length < 2 || offset + 2 + length > bytes.len() {
      return false;
    }
    // APP1 は EXIF / XMP、APP13 は IPTC。どちらも編集前プレビューには持ち込まない。
    if marker == 0xe1 || marker == 0xed {
      return false;
    }
    offset += 2 + length;
  }
  false
}

fn is_direct_raster_extension(extension: &str) -> bool {
  matches!(extension, "jpg" | "jpeg" | "png")
}

/// 写真の名前と大きさから入力を決める（NIHO Desktop の規則）。写真の拡張子でなければ None。
pub fn develop_input(file_name: &str, size_bytes: u64) -> Option<DevelopInput> {
  develop_input_for(file_name, size_bytes, LocalRaster::Desktop)
}

/// アプリの {@link LocalRaster} ごとの入力の決め方。Desktop は JPEG / PNG とも 10MiB まで、camera は web と同じく
/// JPEG は 64MiB・PNG は 10MiB までオリジナルのまま渡す。
pub fn develop_input_for(file_name: &str, size_bytes: u64, local_raster: LocalRaster) -> Option<DevelopInput> {
  if photo_kind(file_name)? == "raw" {
    return Some(DevelopInput::Raw);
  }
  let extension = extension_of(file_name);
  let direct_max = match (local_raster, extension.as_str()) {
    (LocalRaster::Camera, "jpg" | "jpeg") => DIRECT_JPEG_MAX_BYTES,
    _ => DIRECT_RASTER_MAX_BYTES,
  };
  if is_direct_raster_extension(&extension) && size_bytes <= direct_max {
    return Some(DevelopInput::Raster);
  }
  Some(DevelopInput::RasterWorkingCopy)
}

/// 原寸の書き出しの入力（RAW は同じ土台の原寸、JPEG / PNG はオリジナル、HEIC / HEIF・TIFF は `apple-raw-linear raster` の
/// 原寸の JPEG）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportInput {
  Raw,
  Raster,
  /// HEIC / HEIF・TIFF（{@link LocalRaster::Camera} だけ）
  RasterFullSize,
}

/// NIHO Desktop の規則。HEIC / HEIF・TIFF は None（`unsupportedSource`）。
pub fn export_input(file_name: &str) -> Option<ExportInput> {
  export_input_for(file_name, LocalRaster::Desktop)
}

/// アプリの {@link LocalRaster} ごとの原寸の書き出しの入力。camera は HEIC / HEIF・TIFF も書き出す。
pub fn export_input_for(file_name: &str, local_raster: LocalRaster) -> Option<ExportInput> {
  match photo_kind(file_name)? {
    "raw" => Some(ExportInput::Raw),
    _ if is_direct_raster_extension(&extension_of(file_name)) => Some(ExportInput::Raster),
    _ if local_raster == LocalRaster::Camera => Some(ExportInput::RasterFullSize),
    _ => None,
  }
}

/// クラウドへ一緒に上げる作業コピーの種類（`photo_editing_work_copy_info` / `_cloud_upload_work`。W2b-2 / W2c-2 #17145）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudWorkKind {
  /// RAW: `apple-raw-linear render` の 16bit PNG（`raw-apple.*`。v21〜）
  Raw,
  /// HEIC / HEIF・TIFF・10MiB を超える PNG: `apple-raw-linear raster` の ICC 付きの 8bit JPEG（`raster.ci2.p2.e2.*`。v22〜）
  Raster,
}

/// 写真の名前と大きさから、クラウドへ一緒に上げる作業コピーの種類を決める（API の `isPhotoCloudWorkClientUploadSupported` と同じ
/// 区分: 作業コピーを作る写真のうち JPEG を除いたもの）。JPEG（大きさによらない）・10MiB 以下の PNG・写真の拡張子でないものは
/// None（`notApplicable`）。
pub fn cloud_work_kind(file_name: &str, size_bytes: u64) -> Option<CloudWorkKind> {
  if photo_kind(file_name)? == "raw" {
    return Some(CloudWorkKind::Raw);
  }
  match extension_of(file_name).as_str() {
    "heic" | "heif" | "tif" | "tiff" => Some(CloudWorkKind::Raster),
    "png" if size_bytes > DIRECT_RASTER_MAX_BYTES => Some(CloudWorkKind::Raster),
    _ => None,
  }
}

// ---------------------------------------------------------------------------
// 原寸の書き出しの大きさ（niho-photo#132）

/// `capabilities` に答えない古い niho-develop-render が読める画素数（crate の `MAX_DECODE_IMAGE_PIXELS`。配布中の 0.16.0 も
/// 4,000 万画素を超える作業コピー・オリジナルを読み込みで断る）。
pub const LEGACY_RENDER_MAX_PIXELS: u64 = 40_000_000;
/// 原寸の書き出しの一番重い段に使ってよいメモリ（物理メモリのこの割合。ほかのアプリと macOS の分を残す）。
pub const FULL_SIZE_MEMORY_SHARE: f64 = 0.75;
/// niho-develop-render の原寸（`--max-dimension 0`）の peak memory footprint の 1 画素あたりの bytes。補正の無い描画と、補正ごとの
/// 足し（Studio・release・合成の作業コピー 24 / 45 / 61MP の実測。`niho-develop-render` の `tests/cli.rs` の
/// `full_size_peak_memory`。安全側に丸める）。
const RENDER_BYTES_PER_PIXEL: f64 = 60.0;
const RENDER_MASK_BYTES_PER_PIXEL: f64 = 16.0;
const RENDER_DETAIL_BYTES_PER_PIXEL: f64 = 16.0;
const RENDER_GEOMETRY_BYTES_PER_PIXEL: f64 = 16.0;
const RENDER_HEAL_BYTES_PER_PIXEL: f64 = 16.0;
const RENDER_LENS_BYTES_PER_PIXEL: f64 = 32.0;
/// apple-raw-linear の原寸の段（RAW の `render --long-edge full`・HEIC / TIFF の `raster --long-edge full`）の 1 画素あたり
/// （DC-S5 の 24MP で peak memory footprint 1.4〜1.5 GiB。`tools/apple-raw-linear/README.md`）。
const SOURCE_STAGE_BYTES_PER_PIXEL: f64 = 66.0;

/// 原寸では書き出せない写真（読める画素数を超える・この Mac のメモリに収まらない見込み。niho-photo#132）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FullSizeTooLarge {
  /// この Mac で原寸の書き出しが描ける長辺の見込み（画素）
  pub max_long_edge: u64,
}

impl FullSizeTooLarge {
  /// 書き出しの前に出す 1 行（「この写真は原寸では大きすぎます（長辺 7,747 px まで）。」）。
  pub fn message(&self) -> String {
    format!(
      "この写真は原寸では大きすぎます（長辺 {} px まで）。",
      grouped_digits(self.max_long_edge)
    )
  }
}

/// 3 桁ごとに「,」を入れる（画面の数の書き方。`toLocaleString("ja-JP")` と同じ）。
fn grouped_digits(value: u64) -> String {
  let digits = value.to_string();
  let mut out = String::with_capacity(digits.len() + digits.len() / 3);
  for (i, digit) in digits.chars().enumerate() {
    if i > 0 && (digits.len() - i) % 3 == 0 {
      out.push(',');
    }
    out.push(digit);
  }
  out
}

/// 原寸の書き出しの一番重い段の最大メモリの見積もり（bytes）。段は 1 つずつ動くので、元を原寸にする段（RAW・HEIC / TIFF）と
/// niho-develop-render の段の大きい方。後者は補正ごとに足す（マスクは描かれる層の数、8 枚まで）。
pub fn full_size_peak_bytes(pixels: u64, input: ExportInput, develop_settings: &Value) -> u64 {
  let present = |key: &str| match develop_settings.get(key) {
    None | Some(Value::Null) => false,
    Some(Value::Array(items)) => !items.is_empty(),
    Some(Value::Object(fields)) => !fields.is_empty(),
    Some(_) => true,
  };
  let masks = develop_settings
    .get("masks")
    .and_then(Value::as_array)
    .map_or(0, |masks| masks.len().min(8));
  let mut per_pixel = RENDER_BYTES_PER_PIXEL + RENDER_MASK_BYTES_PER_PIXEL * masks as f64;
  for (key, bytes) in [
    ("detail", RENDER_DETAIL_BYTES_PER_PIXEL),
    ("geometry", RENDER_GEOMETRY_BYTES_PER_PIXEL),
    ("heal", RENDER_HEAL_BYTES_PER_PIXEL),
    ("lens", RENDER_LENS_BYTES_PER_PIXEL),
  ] {
    if present(key) {
      per_pixel += bytes;
    }
  }
  let source = match input {
    ExportInput::Raster => 0.0,
    ExportInput::Raw | ExportInput::RasterFullSize => SOURCE_STAGE_BYTES_PER_PIXEL,
  };
  (per_pixel.max(source) * pixels as f64).ceil() as u64
}

/// `width`×`height`（向きを反映した寸法）の写真を原寸で書き出せないか。`max_pixels` は同梱の renderer が読める画素数、`memory`
/// はこの Mac の物理メモリ（分からなければ None で、メモリでは断らない）。書き出せる長辺の見込みは、画素数とメモリの両方に収まる
/// 大きさ（見積もりは画素数に比例する）。
pub fn full_size_too_large(
  width: u64,
  height: u64,
  input: ExportInput,
  develop_settings: &Value,
  max_pixels: u64,
  memory: Option<u64>,
) -> Option<FullSizeTooLarge> {
  let pixels = width.checked_mul(height).filter(|pixels| *pixels > 0)?;
  let mut share = 1.0_f64;
  if pixels > max_pixels {
    share = share.min(max_pixels as f64 / pixels as f64);
  }
  if let Some(memory) = memory {
    let budget = memory as f64 * FULL_SIZE_MEMORY_SHARE;
    let peak = full_size_peak_bytes(pixels, input, develop_settings) as f64;
    if peak > budget {
      share = share.min(budget / peak);
    }
  }
  (share < 1.0).then(|| FullSizeTooLarge {
    max_long_edge: (width.max(height) as f64 * share.sqrt()).floor() as u64,
  })
}

/// この Mac の物理メモリ（bytes。macOS の `hw.memsize`。読めなければ None）。
pub fn physical_memory_bytes() -> Option<u64> {
  #[cfg(target_os = "macos")]
  {
    let mut value: u64 = 0;
    let mut size = std::mem::size_of::<u64>();
    // SAFETY: `hw.memsize` は 64 bit の整数。`value` と `size` はこの呼び出しの間だけ有効な領域を指す。
    let status = unsafe {
      libc::sysctlbyname(
        c"hw.memsize".as_ptr(),
        (&mut value as *mut u64).cast(),
        &mut size,
        std::ptr::null_mut(),
        0,
      )
    };
    (status == 0 && size == std::mem::size_of::<u64>() && value > 0).then_some(value)
  }
  #[cfg(not(target_os = "macos"))]
  {
    None
  }
}

// ---------------------------------------------------------------------------
// baseVersion と meta（ワーカーの `describeAppleRawLinearWorkingCopy` / `buildAppleRawLinearBaseVersion` /
// `buildAppleRawLinearArtifactMeta` と同じ規則）

/// 作業コピーが実際に当てた土台（作業コピーの meta の `_source` から読む）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedBase {
  pub decoder_version: String,
  /// `<cameraId>-<track>-<version>`（例 `panasonic-dc-s5-apple-v2`）。校正なしは None
  pub calibration_id: Option<String>,
  /// `apple` / `embedded` / `none`
  pub lens_mode: String,
}

/// 作業コピーのレンズ補正として受け付ける値（off は色の計測専用で、作業コピーには使わない）。
const WORKING_COPY_LENS_MODES: [&str; 3] = ["apple", "embedded", "none"];

/// 作業コピーの meta（`--working-copy-meta`）から土台を読む。形が違えば `invalidResponse`（ワーカーと同じ code）。
pub fn describe_working_copy(working_copy_meta: &Value) -> Result<AppliedBase, &'static str> {
  const INVALID: &str = "invalidResponse";
  let source = working_copy_meta
    .get("_source")
    .filter(|source| source.is_object())
    .ok_or(INVALID)?;
  let decoder_version = source
    .get("decoderVersion")
    .and_then(Value::as_str)
    .filter(|version| !version.is_empty())
    .ok_or(INVALID)?;
  let lens_mode = source
    .get("lensCorrection")
    .filter(|lens| lens.is_object())
    .and_then(|lens| lens.get("mode"))
    .and_then(Value::as_str)
    .filter(|mode| WORKING_COPY_LENS_MODES.contains(mode))
    .ok_or(INVALID)?;
  // 校正なしは `calibration: null` と明示する（キーが無いのは壊れた meta）
  let calibration_id = match source.get("calibration") {
    Some(Value::Null) => None,
    Some(calibration @ Value::Object(_)) => {
      let parts: Option<Vec<&str>> = ["cameraId", "track", "version"]
        .iter()
        .map(|key| {
          calibration
            .get(*key)
            .and_then(Value::as_str)
            .filter(|part| !part.is_empty())
        })
        .collect();
      Some(parts.ok_or(INVALID)?.join("-"))
    }
    _ => return Err(INVALID),
  };
  Ok(AppliedBase {
    decoder_version: decoder_version.to_string(),
    calibration_id,
    lens_mode: lens_mode.to_string(),
  })
}

/// API の `BASE_VERSION_PATTERN`（`^[A-Za-z0-9._-]{1,120}$`。キャッシュのファイル名の 1 段にもなる）。
pub fn is_base_version(value: &str) -> bool {
  (1..=120).contains(&value.len())
    && value
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// RAW の作業コピーの baseVersion: `raw-apple.d<RAW の版>.p2.e1.cal-<機種別補正>.lens-<レンズ補正>`。形が違えば
/// `invalidBaseVersion`（ワーカーと同じ code）。
pub fn build_base_version(applied: &AppliedBase) -> Result<String, &'static str> {
  build_raw_base_version(applied, PROCESSING_VERSION, ENCODING_VERSION)
}

fn build_raw_base_version(applied: &AppliedBase, processing: &str, encoding: &str) -> Result<String, &'static str> {
  let decoder = applied.decoder_version.to_lowercase().replace('.', "");
  let base_version = format!(
    "raw-apple.d{decoder}.{processing}.{encoding}.cal-{}.lens-{}",
    applied.calibration_id.as_deref().unwrap_or("none"),
    applied.lens_mode
  );
  if decoder.is_empty() || !is_base_version(&base_version) {
    return Err("invalidBaseVersion");
  }
  Ok(base_version)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SavedRawBase<'a> {
  decoder: &'a str,
  calibration_id: &'a str,
  lens_mode: &'a str,
}

fn parse_saved_raw_base<'a>(base: &'a str, processing: &str, encoding: &str) -> Option<SavedRawBase<'a>> {
  let tail = base.strip_prefix("raw-apple.d")?;
  let marker = format!(".{processing}.{encoding}.cal-");
  let (decoder, tail) = tail.split_once(marker.as_str())?;
  let (calibration_id, lens_mode) = tail.split_once(".lens-")?;
  if decoder.is_empty()
    || !decoder.bytes().all(|byte| byte.is_ascii_alphanumeric())
    || calibration_id.is_empty()
    || !calibration_id
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    || !WORKING_COPY_LENS_MODES.contains(&lens_mode)
  {
    return None;
  }
  Some(SavedRawBase {
    decoder,
    calibration_id,
    lens_mode,
  })
}

fn decoder_base_part(version: &str) -> String {
  version.to_lowercase().replace('.', "")
}

fn is_signed_raw_base(base: &str) -> bool {
  parse_saved_raw_base(base, SIGNED_PROCESSING_VERSION, SIGNED_ENCODING_VERSION).is_some()
}

fn supports_known_signed_raw(meta: &Value) -> bool {
  let Some(calibration) = meta.get("dcpSha256").and_then(Value::as_str) else {
    return false;
  };
  let Some(suffix) = calibration.strip_prefix("apple-ciraw8/linear-prophoto-d50/cal-") else {
    return false;
  };
  let Some((camera, version)) = suffix.rsplit_once("-apple-v") else {
    return false;
  };
  !version.is_empty()
    && version.bytes().all(|byte| byte.is_ascii_digit())
    && matches!(camera, "panasonic-dc-s5" | "sony-zv-e10m2" | "sony-ilme-fx30")
}

/// 新規 signed RAW producer の環境変数。未設定は ON、厳密な `0` / `1` だけを受け付ける。
/// 不正値は呼び出し側がログを残して OFF にするため `None`。
pub fn signed_raw_generation_from_env(value: Option<&str>) -> Option<bool> {
  match value {
    None | Some("1") => Some(true),
    Some("0") => Some(false),
    Some(_) => None,
  }
}

/// 非 UTF-8 は未設定と区別し、不正値と同じく `None` にする。
pub fn signed_raw_generation_from_var(value: Result<String, std::env::VarError>) -> Option<bool> {
  match value {
    Ok(value) => signed_raw_generation_from_env(Some(&value)),
    Err(std::env::VarError::NotPresent) => signed_raw_generation_from_env(None),
    Err(std::env::VarError::NotUnicode(_)) => None,
  }
}

fn is_legacy_raw_base(base: &str) -> bool {
  parse_saved_raw_base(base, PROCESSING_VERSION, ENCODING_VERSION).is_some()
}

fn calibration_document_identity(document: &Value) -> Option<(String, &str)> {
  let camera_id = document.get("camera")?.get("id")?.as_str()?;
  let track = document.get("track")?.as_str()?;
  let version = document.get("version")?.as_str()?;
  let lens_mode = document.get("lens")?.get("mode")?.as_str()?;
  Some((format!("{camera_id}-{track}-{version}"), lens_mode))
}

/// 校正の `lens.mode` で描いた作業コピーが、保存 base のレンズになり得るか（apple-raw-linear の `render`）。`embedded` は RAW に
/// 補正データが無ければ `apple` に下がり、`apple` は Core Image がその RAW のレンズを直せなければ `none` になる。描いた後に
/// baseVersion が保存 base と完全に一致するかを別に確かめるので、ここは描く前の絞り込み。
fn saved_lens_reachable(calibration_lens: &str, saved_lens: &str) -> bool {
  calibration_lens == saved_lens || saved_lens == "none" || (calibration_lens == "embedded" && saved_lens == "apple")
}

fn read_json_file(path: &Path) -> Option<Value> {
  std::fs::read(path)
    .ok()
    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
}

/// 登録表の `file`（登録表のフォルダからの相対パス）。絶対パス・`..` を含むものは None。
fn registry_file_path(calibration_dir: &Path, file: &str) -> Option<PathBuf> {
  let relative = Path::new(file);
  (!relative.is_absolute()
    && relative
      .components()
      .all(|part| matches!(part, std::path::Component::Normal(_))))
  .then(|| calibration_dir.join(relative))
}

/// 校正 JSON が保存 base の校正（id・RAW の版・レンズ）か。
fn calibration_matches_saved_base(document: &Value, saved: SavedRawBase<'_>) -> bool {
  let document_decoder = document
    .get("decoder")
    .and_then(|decoder| decoder.get("decoderVersion"))
    .and_then(Value::as_str)
    .map(decoder_base_part);
  calibration_document_identity(document).is_some_and(|(id, lens)| {
    id == saved.calibration_id
      && saved_lens_reachable(lens, saved.lens_mode)
      && document_decoder.as_deref() == Some(saved.decoder)
  })
}

fn registry_contains_calibration(registry: &Path, calibration_dir: &Path, saved: SavedRawBase<'_>) -> bool {
  let Some(entries) =
    read_json_file(registry).and_then(|document| document.get("cameras").and_then(Value::as_array).cloned())
  else {
    return false;
  };
  entries
    .iter()
    .filter_map(|entry| entry.get("file").and_then(Value::as_str))
    .any(|file| {
      registry_file_path(calibration_dir, file)
        .and_then(|path| read_json_file(&path))
        .is_some_and(|document| calibration_matches_saved_base(&document, saved))
    })
}

/// 登録表の `fallback`（登録の無い機種に当てる汎用の補正・#18398）が保存 base の校正なら、そのファイル。描くときは
/// `--calibration` で明示する（登録表に選ばせると、保存の後にその機種を登録したとき機種の校正が選ばれ、汎用で保存した写真を
/// 同じ base で描けない）。
fn registry_fallback_calibration(registry: &Path, calibration_dir: &Path, saved: SavedRawBase<'_>) -> Option<PathBuf> {
  let registry = read_json_file(registry)?;
  let path = registry_file_path(calibration_dir, registry.get("fallback")?.get("file")?.as_str()?)?;
  read_json_file(&path)
    .filter(|document| calibration_matches_saved_base(document, saved))
    .map(|_| path)
}

fn explicit_restoration_calibration(
  calibration_dir: &Path,
  legacy_registry: &Path,
  saved: SavedRawBase<'_>,
  info: &Value,
) -> Result<Option<PathBuf>, DevelopError> {
  if saved.calibration_id == "none" {
    return Ok(None);
  }
  let Some(restoration) = RESTORATION_CALIBRATIONS.iter().find(|candidate| {
    candidate.calibration_id == saved.calibration_id && saved_lens_reachable(candidate.lens_mode, saved.lens_mode)
  }) else {
    if registry_contains_calibration(legacy_registry, calibration_dir, saved) {
      return Ok(None);
    }
    if let Some(fallback) = registry_fallback_calibration(legacy_registry, calibration_dir, saved) {
      return Ok(Some(fallback));
    }
    return Err(DevelopError::new(
      develop_code::RESTORATION_UNAVAILABLE,
      RESTORATION_UNAVAILABLE_MESSAGE,
      "the saved p2 calibration is not bundled",
    ));
  };
  let path = calibration_dir.join(restoration.file);
  let bytes = std::fs::symlink_metadata(&path)
    .ok()
    .filter(|metadata| metadata.is_file())
    .and_then(|_| std::fs::read(&path).ok())
    .filter(|bytes| sha256_hex(bytes) == sha256_hex(restoration.snapshot))
    .ok_or_else(|| {
      DevelopError::new(
        develop_code::RESTORATION_UNAVAILABLE,
        RESTORATION_UNAVAILABLE_MESSAGE,
        "the immutable restoration calibration is missing or changed",
      )
    })?;
  let document: Value = serde_json::from_slice(&bytes).map_err(|_| {
    DevelopError::new(
      develop_code::RESTORATION_UNAVAILABLE,
      RESTORATION_UNAVAILABLE_MESSAGE,
      "the restoration calibration is not readable JSON",
    )
  })?;
  let expected_calibration_base = format!("apple-ciraw8/linear-prophoto-d50/cal-{}", restoration.calibration_id);
  let document_matches = document.get("schema").and_then(Value::as_str) == Some("niho-develop-calibration/v1")
    && document.get("track").and_then(Value::as_str) == Some("apple")
    && document.get("version").and_then(Value::as_str) == Some(restoration.version)
    && document
      .get("decoder")
      .and_then(|decoder| decoder.get("decoderVersion"))
      .and_then(Value::as_str)
      .is_some_and(|decoder| decoder_base_part(decoder) == saved.decoder)
    && document.get("baseVersion").and_then(Value::as_str) == Some(expected_calibration_base.as_str())
    && document
      .get("camera")
      .and_then(|camera| camera.get("id"))
      .and_then(Value::as_str)
      == Some(restoration.camera_id)
    && document
      .get("camera")
      .and_then(|camera| camera.get("make"))
      .and_then(Value::as_str)
      == Some(restoration.camera_make)
    && document
      .get("camera")
      .and_then(|camera| camera.get("model"))
      .and_then(Value::as_str)
      == Some(restoration.camera_model)
    && document
      .get("lens")
      .and_then(|lens| lens.get("mode"))
      .and_then(Value::as_str)
      == Some(restoration.lens_mode);
  if !document_matches {
    return Err(DevelopError::new(
      develop_code::RESTORATION_UNAVAILABLE,
      RESTORATION_UNAVAILABLE_MESSAGE,
      "the restoration calibration identity does not match its saved base",
    ));
  }
  let camera_make = info
    .get("camera")
    .and_then(|camera| camera.get("make"))
    .and_then(Value::as_str);
  let camera_model = info
    .get("camera")
    .and_then(|camera| camera.get("model"))
    .and_then(Value::as_str);
  let camera_matches = camera_make.is_some_and(|make| make.trim().eq_ignore_ascii_case(restoration.camera_make))
    && camera_model.is_some_and(|model| model.trim().eq_ignore_ascii_case(restoration.camera_model));
  if !camera_matches {
    return Err(DevelopError::new(
      develop_code::RESTORATION_UNAVAILABLE,
      RESTORATION_UNAVAILABLE_MESSAGE,
      "the RAW camera does not match the saved restoration calibration",
    ));
  }
  Ok(Some(path))
}

/// `info --json` の `supportedDecoderVersions` から使う RAW の版（`8`、無ければ DNG の `8.dng`）。
pub fn select_decoder_version(supported: &[String]) -> Option<&'static str> {
  ["8", "8.dng"]
    .into_iter()
    .find(|version| supported.iter().any(|supported| supported == version))
}

/// `apple-raw-linear version` の版（`x.y.z`）が {@link APPLE_RAW_LINEAR_SERIES} のいずれかか。
pub fn is_compatible_tool_version(version: &str) -> bool {
  let parts: Vec<&str> = version.split('.').collect();
  parts.len() == 3
    && parts
      .iter()
      .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    && APPLE_RAW_LINEAR_SERIES.contains(&format!("{}.{}", parts[0], parts[1]).as_str())
}

/// `<name> x.y.z …`（`apple-raw-linear version`・`niho-develop-render version`）の版。
pub fn parse_version_line(name: &str, stdout: &str) -> Option<String> {
  let rest = stdout.trim().strip_prefix(name)?.strip_prefix(' ')?;
  let version = rest.split_whitespace().next()?;
  let parts: Vec<&str> = version.split('.').collect();
  (parts.len() == 3
    && parts
      .iter()
      .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())))
  .then(|| version.to_string())
}

/// crate が読むキー（ワーカーの `APPLE_RAW_LINEAR_CRATE_META_KEYS`。テストでワーカーの一覧と照らす）。`whiteBalanceTable`
/// （apple-raw-linear 0.4.2・S11 #17108）は校正の白の行列の表をこの RAW で自己点検した結果で、段 2 の crate が白の変更に使う。
const CRATE_META_KEYS: [&str; 7] = [
  "kind",
  "baselineEV",
  "asShotWhite",
  "dcpSha256",
  "lookTableIncluded",
  "asShotWhiteAdobe",
  "whiteBalanceTable",
];
/// 出どころ `_source` のうち写すキー（ワーカーの `APPLE_RAW_LINEAR_SOURCE_META_KEYS`）。
const SOURCE_META_KEYS: [&str; 8] = [
  "tool",
  "decoderVersion",
  "calibration",
  "matrixApplied",
  "baselineEVApplied",
  "encoding",
  "outputSize",
  "lensCorrection",
];
const SIGNED_SOURCE_META_KEYS: [&str; 9] = [
  "recipe",
  "sourceSize",
  "decodedSize",
  "requestedLongEdge",
  "noiseReduction",
  "gamutMapping",
  "sharpen",
  "calibrationMatrixOrder",
  "calibrationProvenance",
];
/// 校正のうち写すキー（ワーカーの `CALIBRATION_META_KEYS`）。
const CALIBRATION_META_KEYS: [&str; 6] = ["id", "cameraId", "track", "version", "baseVersion", "sha256"];

fn pick(record: &Map<String, Value>, keys: &[&str]) -> Map<String, Value> {
  keys
    .iter()
    .filter_map(|key| record.get(*key).map(|value| (key.to_string(), value.clone())))
    .collect()
}

/// ページへ出す作業コピーの meta（ワーカーが API に保存する `buildAppleRawLinearArtifactMeta` と同じ形。クラウドへ上げるときは
/// API がこの形と照らす: W2a #17145）。crate が読むキーと、出どころ `_source` の許可したキーだけを写す。オリジナル・作業フォルダの
/// パス（`input`・`output`・`toolMeta`・校正の `path`）・カメラの機種名（`camera`）・作った日時（`createdAt`）は入れない。
///
/// `whiteBalanceTable`（apple-raw-linear 0.4.2・S11 #17108）は、ワーカーと同じく中身を選ばずにそのまま写す（段 2 の crate が
/// RAW の白の変更に使う）。書き出しの `niho-develop-render` は作業コピーの meta をそのまま読むので、これを落とすとページの
/// プレビューと書き出しで白がずれる。
pub fn artifact_meta(working_copy_meta: &Value, source_extension: &str) -> Value {
  let empty = Map::new();
  let record = working_copy_meta.as_object().unwrap_or(&empty);
  let mut meta = pick(record, &CRATE_META_KEYS);
  if let Some(encoding) = record.get("encoding") {
    meta.insert("encoding".into(), encoding.clone());
  }
  meta.insert("engine".into(), json!("apple-raw-linear"));
  meta.insert("orientationApplied".into(), json!(true));
  meta.insert("colorSpace".into(), json!("linear-prophoto-d50"));
  meta.insert("sourceExtension".into(), json!(source_extension));
  if let Some(source) = record.get("_source").and_then(Value::as_object) {
    let mut picked = pick(source, &SOURCE_META_KEYS);
    picked.extend(pick(source, &SIGNED_SOURCE_META_KEYS));
    if let Some(tool) = picked.get("tool").and_then(Value::as_object) {
      let tool = pick(tool, &["name", "version"]);
      picked.insert("tool".into(), Value::Object(tool));
    }
    match picked.get("calibration") {
      Some(Value::Object(calibration)) => {
        let mut kept = pick(calibration, &CALIBRATION_META_KEYS);
        // 使った機種別補正の登録（registry のファイル名と、その中の相対パス）。絶対パスは入れない
        let registry = match calibration.get("registry") {
          Some(Value::Object(registry)) => json!({
            "registry": registry
              .get("registry")
              .and_then(Value::as_str)
              .map(|name| Path::new(name).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()),
            "file": registry.get("file").and_then(Value::as_str).filter(|file| !file.starts_with('/')),
          }),
          _ => Value::Null,
        };
        kept.insert("registry".into(), registry);
        picked.insert("calibration".into(), Value::Object(kept));
      }
      Some(_) => {
        picked.insert("calibration".into(), Value::Null);
      }
      None => {}
    }
    match picked.get("calibrationProvenance") {
      Some(Value::Object(provenance)) => {
        picked.insert(
          "calibrationProvenance".into(),
          Value::Object(pick(provenance, &["sha256", "matrix", "recipe"])),
        );
      }
      Some(_) => {
        picked.insert("calibrationProvenance".into(), Value::Null);
      }
      None => {}
    }
    meta.insert("_source".into(), Value::Object(picked));
  }
  Value::Object(meta)
}

// ---------------------------------------------------------------------------
// ラスタの作業コピーの baseVersion と meta（W2c-2 #17145。ワーカーの `parseAppleRawLinearRasterMeta` /
// `buildAppleRawLinearRasterBaseVersion` / `buildAppleRawLinearRasterArtifactMeta` と同じ規則）

/// `apple-raw-linear raster` の meta（`--meta` のファイル）のうち使うもの。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RasterMeta {
  pub width: u32,
  pub height: u32,
  /// 埋め込んだ ICC の SHA-256（小文字の 16 進）。sRGB 扱いで埋め込まなければ None
  pub icc_sha256: Option<String>,
  pub color_space: String,
  /// 元の ICC を変換した先（`displayP3` / `srgb`）。そのまま埋め込んだら None
  pub converted: Option<String>,
  pub orientation_applied: bool,
}

fn is_sha256_hex(value: &str) -> bool {
  value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// `raster` の meta を確かめて読む。形が違えば `invalidResponse`（ワーカーと同じ code）。
pub fn parse_raster_meta(meta: &Value) -> Result<RasterMeta, &'static str> {
  const INVALID: &str = "invalidResponse";
  if meta.get("kind").and_then(Value::as_str) != Some("raster")
    || meta.get("encoding").and_then(Value::as_str) != Some("jpeg8")
  {
    return Err(INVALID);
  }
  let dimension = |key: &str| {
    meta
      .get(key)
      .and_then(Value::as_u64)
      .filter(|value| *value > 0)
      .and_then(|value| u32::try_from(value).ok())
  };
  let (Some(width), Some(height)) = (dimension("width"), dimension("height")) else {
    return Err(INVALID);
  };
  let icc_sha256 = match meta.get("iccSha256") {
    Some(Value::Null) => None,
    Some(Value::String(sha256)) if is_sha256_hex(sha256) => Some(sha256.to_lowercase()),
    _ => return Err(INVALID),
  };
  let color_space = meta
    .get("colorSpace")
    .and_then(Value::as_str)
    .filter(|space| !space.is_empty())
    .ok_or(INVALID)?;
  let converted = match meta.get("converted") {
    Some(Value::Null) => None,
    Some(Value::String(converted)) if converted == "displayP3" || converted == "srgb" => Some(converted.clone()),
    _ => return Err(INVALID),
  };
  let orientation_applied = meta.get("orientationApplied").and_then(Value::as_bool).ok_or(INVALID)?;
  Ok(RasterMeta {
    width,
    height,
    icc_sha256,
    color_space: color_space.to_string(),
    converted,
    orientation_applied,
  })
}

/// ラスタの作業コピーの baseVersion: `raster.ci2.p2.e2.icc-<埋め込んだ ICC の SHA-256>`（ICC を埋め込まない sRGB 扱いは
/// `icc-srgb`）。ICC の SHA-256 が小文字の 16 進 64 桁でなければ `invalidBaseVersion`（ワーカーと同じ code）。
pub fn build_raster_base_version(icc_sha256: Option<&str>) -> Result<String, &'static str> {
  if icc_sha256.is_some_and(|sha256| !is_sha256_hex(sha256) || sha256.bytes().any(|byte| byte.is_ascii_uppercase())) {
    return Err("invalidBaseVersion");
  }
  let base_version = format!(
    "raster.{RASTER_DECODER_VERSION}.{PROCESSING_VERSION}.{RASTER_ENCODING_VERSION}.icc-{}",
    icc_sha256.unwrap_or("srgb")
  );
  if !is_base_version(&base_version) {
    return Err("invalidBaseVersion");
  }
  Ok(base_version)
}

/// ラスタの作業コピーの meta のキー（ワーカーの `buildAppleRawLinearRasterArtifactMeta` が組むキー。テストでワーカーの TS と照らす。
/// RAW の {@link CRATE_META_KEYS} とは別の一覧）。
const RASTER_META_KEYS: [&str; 7] = [
  "kind",
  "encoding",
  "iccSha256",
  "colorSpace",
  "converted",
  "sourceExtension",
  "orientationApplied",
];

/// ページへ出す・クラウドへ上げるときに API へ申告するラスタの作業コピーの meta（ワーカーが API に保存する
/// `buildAppleRawLinearRasterArtifactMeta` と同じ 7 つのキーだけ。パス・ツールの詳細は入れない）。
pub fn raster_artifact_meta(meta: &RasterMeta, source_extension: &str) -> Value {
  let picked: Map<String, Value> = RASTER_META_KEYS
    .iter()
    .map(|key| {
      let value = match *key {
        "kind" => json!("raster"),
        "encoding" => json!("jpeg8"),
        "iccSha256" => json!(meta.icc_sha256),
        "colorSpace" => json!(meta.color_space),
        "converted" => json!(meta.converted),
        "sourceExtension" => json!(source_extension),
        "orientationApplied" => json!(meta.orientation_applied),
        _ => Value::Null,
      };
      (key.to_string(), value)
    })
    .collect();
  Value::Object(picked)
}

// ---------------------------------------------------------------------------
// sidecar の子プロセス

/// sidecar の終わり方。
#[derive(Debug, Default, Clone)]
pub struct ToolRun {
  pub exit_code: Option<i32>,
  pub signal: Option<i32>,
  pub timed_out: bool,
  /// 起動できなかったときの `io::ErrorKind`
  pub spawn_error: Option<String>,
  pub stdout: String,
  pub stderr_tail: String,
}

impl ToolRun {
  pub fn succeeded(&self) -> bool {
    self.spawn_error.is_none() && !self.timed_out && self.exit_code == Some(0)
  }

  /// 標準出力の最後の JSON 行の `error`（sidecar の失敗の語彙。`message` はパスを含みうるので読まない）。
  pub fn tool_error(&self) -> Option<String> {
    let last = self.stdout.lines().map(str::trim).rfind(|line| !line.is_empty())?;
    let parsed: Value = serde_json::from_str(last).ok()?;
    parsed.get("error").and_then(Value::as_str).map(str::to_string)
  }

  /// ログに書く終わり方（パスを含まない）。
  fn summary(&self) -> Value {
    json!({
      "exitCode": self.exit_code,
      "signal": self.signal,
      "timedOut": self.timed_out,
      "spawnError": self.spawn_error,
      "toolError": self.tool_error(),
    })
  }

  /// 標準エラー出力の末尾（最後の 5 行・800 文字まで）。`paths` とホームを伏せる（落ちた・何も言わずに失敗したときだけログへ書く）。
  fn scrubbed_stderr(&self, paths: &[PathBuf]) -> String {
    let lines: Vec<&str> = self
      .stderr_tail
      .lines()
      .filter(|line| !line.trim().is_empty())
      .collect();
    let tail = lines[lines.len().saturating_sub(5)..].join("\n");
    let scrubbed = scrub_paths(&tail, paths, std::env::var("HOME").ok().as_deref());
    scrubbed
      .chars()
      .rev()
      .take(800)
      .collect::<Vec<char>>()
      .into_iter()
      .rev()
      .collect()
  }
}

/// sidecar の起動コマンド。環境変数は HOME と PATH=/usr/bin:/bin だけ（ワーカーと同じ。親の秘密・Adobe の場所を渡さない）、
/// cwd は `/`、自分のプロセスグループ（止めるときに子孫ごと止める）。
pub fn sidecar_command(program: &Path, args: &[OsString]) -> Command {
  let mut command = Command::new(program);
  command.args(args).env_clear().env("PATH", SIDECAR_PATH_VAR);
  if let Some(home) = std::env::var_os("HOME") {
    command.env("HOME", home);
  }
  command
    .current_dir("/")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
  }
  command
}

fn signal_group(pid: i32, signal: libc::c_int) {
  #[cfg(unix)]
  unsafe {
    libc::killpg(pid as libc::pid_t, signal);
  }
}

/// 標準出力（先頭の `max` バイト）か標準エラー出力（末尾の `max` バイト）を最後まで読む（読むのをやめると子が書き込みで止まる）。
fn read_pipe<R: Read + Send + 'static>(pipe: Option<R>, max: usize, keep_tail: bool) -> mpsc::Receiver<Vec<u8>> {
  let (sender, receiver) = mpsc::channel();
  std::thread::spawn(move || {
    let mut kept = Vec::new();
    if let Some(mut pipe) = pipe {
      let mut chunk = [0u8; 8192];
      loop {
        match pipe.read(&mut chunk) {
          Ok(0) | Err(_) => break,
          Ok(read) if keep_tail => {
            kept.extend_from_slice(&chunk[..read]);
            if kept.len() > max * 2 {
              kept.drain(..kept.len() - max);
            }
          }
          Ok(read) => {
            let take = max.saturating_sub(kept.len()).min(read);
            kept.extend_from_slice(&chunk[..take]);
          }
        }
      }
    }
    if keep_tail && kept.len() > max {
      kept.drain(..kept.len() - max);
    }
    let _ = sender.send(kept);
  });
  receiver
}

/// sidecar を走らせ、終わるか `timeout` まで待つ。過ぎたらプロセスグループへ SIGTERM、`kill_grace` 後に SIGKILL。
/// `running` には走っている間だけプロセスグループの ID を置く（アプリの終了で止める）。blocking のスレッドから呼ぶ。
pub fn run_sidecar(
  program: &Path,
  args: &[OsString],
  timeout: Duration,
  kill_grace: Duration,
  running: &Mutex<Option<i32>>,
) -> ToolRun {
  let mut child = match sidecar_command(program, args).spawn() {
    Ok(child) => child,
    Err(err) => {
      return ToolRun {
        spawn_error: Some(err.kind().to_string()),
        ..ToolRun::default()
      }
    }
  };
  let pid = child.id() as i32;
  *lock(running) = Some(pid);
  let stdout = read_pipe(child.stdout.take(), STDOUT_MAX_BYTES, false);
  let stderr = read_pipe(child.stderr.take(), STDERR_TAIL_BYTES, true);
  let deadline = Instant::now() + timeout;
  let mut timed_out = false;
  let status = loop {
    match child.try_wait() {
      Ok(Some(status)) => break Some(status),
      Ok(None) if Instant::now() >= deadline => {
        timed_out = true;
        signal_group(pid, libc::SIGTERM);
        let grace = Instant::now() + kill_grace;
        let mut exited = None;
        while Instant::now() < grace {
          if let Ok(Some(status)) = child.try_wait() {
            exited = Some(status);
            break;
          }
          std::thread::sleep(TOOL_POLL_INTERVAL);
        }
        if exited.is_none() {
          signal_group(pid, libc::SIGKILL);
          exited = child.wait().ok();
        }
        break exited;
      }
      Ok(None) => std::thread::sleep(TOOL_POLL_INTERVAL),
      Err(_) => {
        signal_group(pid, libc::SIGKILL);
        break child.wait().ok();
      }
    }
  };
  // 回収した直後に、同じグループに残った子孫を止める（空なら ESRCH で何もしない。エンジンと同じ）
  signal_group(pid, libc::SIGKILL);
  *lock(running) = None;
  let stdout = stdout.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
  let stderr = stderr.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
  #[cfg(unix)]
  let signal = {
    use std::os::unix::process::ExitStatusExt;
    status.and_then(|status| status.signal())
  };
  #[cfg(not(unix))]
  let signal: Option<i32> = None;
  ToolRun {
    exit_code: status.and_then(|status| status.code()),
    signal,
    timed_out,
    spawn_error: None,
    stdout: String::from_utf8_lossy(&stdout).into_owned(),
    stderr_tail: String::from_utf8_lossy(&stderr).into_owned(),
  }
}

fn os_args<const N: usize>(args: [&OsStr; N]) -> Vec<OsString> {
  args.iter().map(|arg| arg.to_os_string()).collect()
}

// ---------------------------------------------------------------------------
// 同時に 1 本の待ち行列（到着順）

#[derive(Default)]
struct JobQueue {
  /// （次に配る番号, いま動かしてよい番号）
  tickets: Mutex<(u64, u64)>,
  turn: Condvar,
}

struct JobTurn<'a>(&'a JobQueue);

impl JobQueue {
  fn enter(&self) -> JobTurn<'_> {
    self.wait_turn();
    JobTurn(self)
  }

  /// 自分の番まで待つ。番を終えるときは必ず {@link JobQueue::leave} を呼ぶ（async の間も番を持つ {@link HeldWorkCopy} 用。
  /// ふだんは Drop で渡す {@link JobQueue::enter}）。
  fn wait_turn(&self) {
    let mut tickets = lock(&self.tickets);
    let ticket = tickets.0;
    tickets.0 += 1;
    while tickets.1 != ticket {
      tickets = self.turn.wait(tickets).unwrap_or_else(|poison| poison.into_inner());
    }
  }

  fn leave(&self) {
    lock(&self.tickets).1 += 1;
    self.turn.notify_all();
  }
}

impl Drop for JobTurn<'_> {
  fn drop(&mut self) {
    self.0.leave();
  }
}

// ---------------------------------------------------------------------------
// 作業コピーのキャッシュ（`<app cache>/photo-develop/`）

/// 作業コピーのファイルの形式（キャッシュの拡張子と、クラウドへ上げるときの Content-Type・part の名前）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkCopyFormat {
  /// 16bit PNG（RAW の `apple-raw-linear render`）
  Png,
  /// ICC 付きの 8bit JPEG（ラスタのクラウド用の `apple-raw-linear raster`。W2c-2 #17145）
  Jpeg,
}

impl WorkCopyFormat {
  /// キャッシュのファイルの拡張子（API の objectKey の拡張子と同じ）。
  pub fn extension(self) -> &'static str {
    match self {
      WorkCopyFormat::Png => "png",
      WorkCopyFormat::Jpeg => "jpg",
    }
  }

  /// 署名付き POST のファイルの Content-Type（API の `photoCloudWorkContentType` と同じ）。
  pub fn content_type(self) -> &'static str {
    match self {
      WorkCopyFormat::Png => "image/png",
      WorkCopyFormat::Jpeg => "image/jpeg",
    }
  }

  fn from_extension(extension: &str) -> Option<Self> {
    match extension {
      "png" => Some(WorkCopyFormat::Png),
      "jpg" => Some(WorkCopyFormat::Jpeg),
      _ => None,
    }
  }
}

/// キャッシュにある作業コピー。
#[derive(Debug, Clone)]
pub(crate) struct CachedWorkingCopy {
  /// 作業コピーのファイル（`<stem>.png` か `<stem>.jpg`）
  pub file: PathBuf,
  pub format: WorkCopyFormat,
  pub record: PathBuf,
  pub base_version: String,
  pub meta: Value,
  pub byte_length: u64,
  /// 作業コピーのファイルの SHA-256
  pub sha256: String,
}

/// キャッシュへ置く作業コピーの記録（{@link DevelopCache::store}）。
#[derive(Debug, Clone, Copy)]
pub(crate) struct CacheEntry<'a> {
  /// 写真の中身の SHA-256
  pub key: &'a str,
  /// 作り方（sidecar の版と校正の中身）
  pub recipe: &'a str,
  pub renderer: &'a str,
  pub base_version: &'a str,
  /// ページへ出す meta
  pub meta: &'a Value,
  /// 作業コピーのファイルの形式（キャッシュの拡張子）
  pub format: WorkCopyFormat,
}

/// キャッシュの掃除の結果。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DevelopSweep {
  pub removed: usize,
  pub removed_bytes: u64,
  pub total_bytes: u64,
}

/// この仕事だけの一時フォルダ（キャッシュと同じボリューム。0700）。Drop で中身ごと消す。
pub(crate) struct WorkDir {
  pub path: PathBuf,
}

impl Drop for WorkDir {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.path);
  }
}

pub(crate) struct DevelopCache {
  dir: PathBuf,
  max_bytes: u64,
  /// 置く・探す・掃除を直列にする
  guard: Mutex<()>,
  /// `cache_purge` の世代。作業コピーを作っている間に消されたら、その作業コピーは置かない
  generation: AtomicU64,
}

/// `<SHA-256>-<baseVersion>.png|jpg|json` を `(<SHA-256>-<baseVersion>, 拡張子)` に分ける。
fn parse_cache_file_name(name: &str) -> Option<(&str, &str)> {
  let (stem, extension) = name.rsplit_once('.')?;
  if extension != "json" && WorkCopyFormat::from_extension(extension).is_none() {
    return None;
  }
  let key = stem.get(..64)?;
  let base_version = stem.get(64..)?.strip_prefix('-')?;
  (is_content_key(key) && is_base_version(base_version)).then_some((stem, extension))
}

fn age(now: SystemTime, modified: SystemTime) -> Duration {
  now.duration_since(modified).unwrap_or(Duration::ZERO)
}

impl DevelopCache {
  pub(crate) fn new(dir: PathBuf, max_bytes: u64) -> Self {
    Self {
      dir,
      max_bytes,
      guard: Mutex::new(()),
      generation: AtomicU64::new(0),
    }
  }

  fn stem(key: &str, base_version: &str) -> String {
    format!("{key}-{base_version}")
  }

  /// 同じ写真（`key`）・同じ作り方（`recipe`）の作業コピー。無い・壊れていれば None（壊れたものは次の掃除で消える）。
  pub(crate) fn find(&self, key: &str, recipe: &str, requested_base: Option<&str>) -> Option<CachedWorkingCopy> {
    let _guard = lock(&self.guard);
    let prefix = format!("{key}-");
    let mut found: Option<(SystemTime, CachedWorkingCopy)> = None;
    for entry in std::fs::read_dir(&self.dir).ok()?.flatten() {
      let name = entry.file_name();
      let Some(name) = name.to_str() else { continue };
      if !name.starts_with(&prefix) {
        continue;
      }
      let Some((stem, "json")) = parse_cache_file_name(name) else {
        continue;
      };
      let Ok(metadata) = entry.metadata() else {
        continue;
      };
      if !metadata.is_file() || metadata.len() > MAX_RECORD_BYTES {
        continue;
      }
      let Some(record) = std::fs::read(entry.path())
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
      else {
        continue;
      };
      let base_version = record.get("baseVersion").and_then(Value::as_str).unwrap_or_default();
      if requested_base.is_some_and(|requested| requested != base_version) {
        continue;
      }
      let byte_length = record.get("byteLength").and_then(Value::as_u64).unwrap_or_default();
      let sha256 = record.get("sha256").and_then(Value::as_str).unwrap_or_default();
      let format = record
        .get("extension")
        .and_then(Value::as_str)
        .and_then(WorkCopyFormat::from_extension);
      let valid = record.get("version").and_then(Value::as_u64) == Some(CACHE_RECORD_VERSION)
        && record.get("recipe").and_then(Value::as_str) == Some(recipe)
        && record.get("contentSha256").and_then(Value::as_str) == Some(key)
        && Self::stem(key, base_version) == stem
        && record.get("meta").is_some_and(Value::is_object)
        && byte_length > 0
        && is_content_key(sha256);
      let Some(format) = format.filter(|_| valid) else {
        continue;
      };
      let file = self.dir.join(format!("{stem}.{}", format.extension()));
      let Ok(file_metadata) = std::fs::symlink_metadata(&file) else {
        continue;
      };
      if !file_metadata.is_file() || file_metadata.len() != byte_length {
        continue;
      }
      let used = file_metadata.modified().unwrap_or(UNIX_EPOCH);
      if found.as_ref().is_some_and(|(newest, _)| *newest >= used) {
        continue;
      }
      found = Some((
        used,
        CachedWorkingCopy {
          file,
          format,
          record: entry.path(),
          base_version: base_version.to_string(),
          meta: record.get("meta").cloned().unwrap_or(Value::Null),
          byte_length,
          sha256: sha256.to_string(),
        },
      ));
    }
    found.map(|(_, cached)| cached)
  }

  /// いまの `cache_purge` の世代（作業コピーを作り始める前に読み、{@link DevelopCache::store} に渡す）。
  pub(crate) fn generation(&self) -> u64 {
    self.generation.load(Ordering::SeqCst)
  }

  /// 作った作業コピー（`made`。同じボリュームの一時フォルダの中）を rename でキャッシュへ入れ、記録を書く（どちらも 0600）。
  /// 作り始めた後に `cache_purge` があった（`generation` が古い）ら置かずに消し、`Interrupted` で失敗する。
  pub(crate) fn store(&self, generation: u64, entry: &CacheEntry<'_>, made: &Path) -> io::Result<CachedWorkingCopy> {
    let CacheEntry {
      key,
      recipe,
      renderer,
      base_version,
      meta,
      format,
    } = *entry;
    let purged = || {
      let _ = std::fs::remove_file(made);
      io::Error::new(
        io::ErrorKind::Interrupted,
        "the cache was purged while the working copy was made",
      )
    };
    // 消去は作業フォルダごと消すので、作ったファイルを読む前に世代を照らす（読めずに NotFound にしない）
    if self.generation() != generation {
      return Err(purged());
    }
    let digest = content_digest(made)?;
    let _guard = lock(&self.guard);
    if self.generation() != generation {
      return Err(purged());
    }
    ensure_private_dir(&self.dir)?;
    let stem = Self::stem(key, base_version);
    let file = self.dir.join(format!("{stem}.{}", format.extension()));
    let record_path = self.dir.join(format!("{stem}.json"));
    std::fs::rename(made, &file)?;
    set_mode(&file, 0o600)?;
    let record = json!({
      "version": CACHE_RECORD_VERSION,
      "recipe": recipe,
      "renderer": renderer,
      "contentSha256": key,
      "baseVersion": base_version,
      "meta": meta,
      "extension": format.extension(),
      "byteLength": digest.size_bytes,
      "sha256": digest.key,
      "createdAtMs": SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_millis() as u64).unwrap_or_default(),
    });
    let bytes = serde_json::to_vec(&record).map_err(io::Error::other)?;
    if let Err(err) = write_private_file_atomically(&record_path, &bytes) {
      let _ = std::fs::remove_file(&file);
      return Err(err);
    }
    Ok(CachedWorkingCopy {
      file,
      format,
      record: record_path,
      base_version: base_version.to_string(),
      meta: meta.clone(),
      byte_length: digest.size_bytes,
      sha256: digest.key,
    })
  }

  /// 壊れていた作業コピーを消す（次の要求で作り直す）。
  pub(crate) fn forget(&self, cached: &CachedWorkingCopy) {
    let _guard = lock(&self.guard);
    let _ = std::fs::remove_file(&cached.record);
    let _ = std::fs::remove_file(&cached.file);
  }

  /// この仕事だけの一時フォルダ。
  pub(crate) fn work_dir(&self) -> io::Result<WorkDir> {
    ensure_private_dir(&self.dir)?;
    let path = self.dir.join(format!("{WORK_DIR_PREFIX}{}", random_hex(8)));
    std::fs::create_dir(&path)?;
    set_mode(&path, 0o700)?;
    Ok(WorkDir { path })
  }

  /// 合計が上限を超えていたら、最終利用（作業コピーのファイルの更新日時）の古い順に上限以下まで消す（`keep` のファイルは消さない）。1 時間より
  /// 古い一時フォルダ・書きかけの記録・片方だけ残った作業コピーも消す。キャッシュの形でないファイル・シンボリックリンクには触れない。
  pub(crate) fn sweep(&self, keep: &[PathBuf], now: SystemTime) -> DevelopSweep {
    let _guard = lock(&self.guard);
    self.sweep_locked(keep, now, false)
  }

  /// `cache_purge`（Mac を返す・渡すとき）: 作業コピーを全部消す（写真の中身から作ったものなので残さない）。
  pub(crate) fn purge(&self) -> DevelopSweep {
    let _guard = lock(&self.guard);
    self.generation.fetch_add(1, Ordering::SeqCst);
    self.sweep_locked(&[], SystemTime::now(), true)
  }

  fn sweep_locked(&self, keep: &[PathBuf], now: SystemTime, purge: bool) -> DevelopSweep {
    let mut outcome = DevelopSweep::default();
    let Ok(entries) = std::fs::read_dir(&self.dir) else {
      return outcome;
    };
    let mut pairs: HashMap<String, CachePair> = HashMap::new();
    for entry in entries.flatten() {
      let name = entry.file_name();
      let Some(name) = name.to_str() else { continue };
      let Ok(metadata) = entry.metadata() else {
        continue;
      };
      let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
      if metadata.is_dir() && name.starts_with(WORK_DIR_PREFIX) {
        if purge || age(now, modified) > ORPHAN_AGE {
          let _ = std::fs::remove_dir_all(entry.path());
        }
        continue;
      }
      if !metadata.is_file() {
        continue;
      }
      if let Some(record) = name.strip_suffix(".tmp") {
        if parse_cache_file_name(record).is_some() && (purge || age(now, modified) > ORPHAN_AGE) {
          let _ = std::fs::remove_file(entry.path());
        }
        continue;
      }
      let Some((stem, extension)) = parse_cache_file_name(name) else {
        continue;
      };
      outcome.total_bytes += metadata.len();
      let pair = pairs.entry(stem.to_string()).or_insert_with(|| CachePair {
        stem: stem.to_string(),
        ..CachePair::default()
      });
      pair.len += metadata.len();
      if extension != "json" {
        pair.used = modified;
        pair.file = Some(entry.path());
      } else {
        if pair.file.is_none() {
          pair.used = pair.used.max(modified);
        }
        pair.record = Some(entry.path());
      }
    }
    let remove = |outcome: &mut DevelopSweep, pair: &CachePair| {
      for path in [&pair.record, &pair.file].into_iter().flatten() {
        let _ = std::fs::remove_file(path);
      }
      outcome.total_bytes = outcome.total_bytes.saturating_sub(pair.len);
      outcome.removed += 1;
      outcome.removed_bytes += pair.len;
    };
    let mut ordered: Vec<CachePair> = pairs.into_values().collect();
    // 最終利用の古い順（同じ時刻なら名前順）
    ordered.sort_by(|a, b| (a.used, &a.stem).cmp(&(b.used, &b.stem)));
    let mut kept = Vec::new();
    for pair in ordered {
      let orphan = pair.file.is_none() || pair.record.is_none();
      if purge || (orphan && age(now, pair.used) > ORPHAN_AGE) {
        remove(&mut outcome, &pair);
      } else {
        kept.push(pair);
      }
    }
    for pair in kept {
      if outcome.total_bytes <= self.max_bytes {
        break;
      }
      if pair.file.as_ref().is_some_and(|file| keep.contains(file)) {
        continue;
      }
      remove(&mut outcome, &pair);
    }
    outcome
  }
}

/// キャッシュの 1 組（`<SHA-256>-<baseVersion>` の作業コピー（PNG / JPEG）と記録）。
#[derive(Debug)]
struct CachePair {
  stem: String,
  /// 最終利用（作業コピーのファイルの更新日時。無ければ記録の更新日時）
  used: SystemTime,
  file: Option<PathBuf>,
  record: Option<PathBuf>,
  len: u64,
}

impl Default for CachePair {
  fn default() -> Self {
    Self {
      stem: String::new(),
      used: UNIX_EPOCH,
      file: None,
      record: None,
      len: 0,
    }
  }
}

/// 最終利用を記録する（ファイルの更新日時。中身は変えない）。
fn mark_used(path: &Path) {
  if let Ok(file) = std::fs::OpenOptions::new().write(true).open(path) {
    let _ = file.set_modified(SystemTime::now());
  }
}

fn sha256_hex(bytes: &[u8]) -> String {
  Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

// ---------------------------------------------------------------------------
// 同梱の sidecar と、使えるかの確認

/// sidecar と校正の場所。
#[derive(Debug, Clone)]
pub struct SidecarPaths {
  pub apple_raw_linear: PathBuf,
  pub develop_render: PathBuf,
  pub calibration_dir: PathBuf,
}

/// 確かめた sidecar（`photoEditingDevelop` が true のときだけある）。
#[derive(Debug, Clone)]
pub struct Sidecars {
  pub paths: SidecarPaths,
  pub registry: PathBuf,
  /// 同梱の校正の登録表（`apple-registry.json`）のバイト列の SHA-256（作業コピーをクラウドへ上げる準備の
  /// `calibrationRegistrySha256`。API が自分の登録表の写しと照らす。W2a #17145）
  pub registry_sha256: String,
  /// signed p3/e4 専用。旧 registry の override と混ぜない。
  pub signed_registry: Option<PathBuf>,
  pub signed_registry_sha256: Option<String>,
  pub apple_raw_linear_version: String,
  pub develop_render_version: String,
  /// 同梱の niho-develop-render が描ける設定（答えない古い renderer は None）
  pub develop_render_capabilities: Option<RenderCapabilities>,
  /// RAW の作業コピーの作り方（apple-raw-linear の版と校正の中身）。変われば作業コピーを作り直す
  pub raw_recipe: String,
  pub signed_raw_recipe: Option<String>,
}

impl Sidecars {
  /// 同梱の apple-raw-linear が `raster` を持つか（ラスタの作業コピーをクラウドへ上げる v22。W2c-2 #17145）。
  pub fn supports_raster(&self) -> bool {
    is_raster_tool_version(&self.apple_raw_linear_version)
  }

  pub fn supports_full_size_raster_export(&self) -> bool {
    is_full_size_raster_export_tool_version(&self.apple_raw_linear_version)
  }

  pub fn supports_signed_restore(&self) -> bool {
    self.signed_registry.is_some()
      && self.signed_registry_sha256.is_some()
      && self.signed_raw_recipe.is_some()
      && version_at_least(&self.apple_raw_linear_version, SIGNED_MIN_TOOL_VERSION)
      && version_at_least(&self.develop_render_version, SIGNED_MIN_RENDER_VERSION)
  }

  /// 同梱の niho-develop-render が部分補正（`masks`）を描けるか（{@link MASKS_MIN_RENDER_VERSION} 以上）。
  pub fn supports_masks(&self) -> bool {
    version_at_least(&self.develop_render_version, MASKS_MIN_RENDER_VERSION)
  }

  /// ラスタのクラウド用の作業コピーの作り方（apple-raw-linear の版だけ。校正は使わないので含めない）。変われば作り直す。
  pub fn raster_recipe(&self) -> String {
    format!("apple-raw-linear {}; raster", self.apple_raw_linear_version)
  }
}

/// apple-raw-linear の版（`x.y.z`）が `raster` のある版（{@link RASTER_MIN_TOOL_VERSION} 以上。ワーカーの
/// `isAppleRawLinearRasterVersion`）か。
pub fn is_raster_tool_version(version: &str) -> bool {
  version_at_least(version, RASTER_MIN_TOOL_VERSION)
}

pub fn is_full_size_raster_export_tool_version(version: &str) -> bool {
  version_at_least(version, FULL_SIZE_RASTER_MIN_TOOL_VERSION)
}

/// 設定が部分補正（`masks` の空でない配列）を持つか。
pub(crate) fn carries_masks(develop_settings: &Value) -> bool {
  develop_settings
    .get("masks")
    .and_then(Value::as_array)
    .is_some_and(|masks| !masks.is_empty())
}

fn version_at_least(version: &str, minimum: &str) -> bool {
  let parts = |version: &str| -> Option<[u64; 3]> {
    let parts: Vec<u64> = version
      .split('.')
      .map(|part| part.parse().ok())
      .collect::<Option<_>>()?;
    parts.try_into().ok()
  };
  matches!((parts(version), parts(minimum)), (Some(version), Some(min)) if version >= min)
}

/// 校正の内容もキャッシュの作り方に含める。registry の参照先だけが変わった場合も再生成する。
fn calibration_fingerprint(dir: &Path) -> io::Result<String> {
  fn walk(root: &Path, dir: &Path, files: &mut Vec<(String, String)>) -> io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
      let entry = entry?;
      if entry.file_name().to_string_lossy().starts_with('.') {
        continue;
      }
      let metadata = entry.metadata()?;
      if metadata.is_dir() {
        walk(root, &entry.path(), files)?;
      } else if metadata.is_file() {
        let relative = entry
          .path()
          .strip_prefix(root)
          .map(|path| path.to_string_lossy().into_owned())
          .unwrap_or_default();
        files.push((relative, sha256_hex(&std::fs::read(entry.path())?)));
      }
    }
    Ok(())
  }
  let mut files = Vec::new();
  walk(dir, dir, &mut files)?;
  files.sort();
  let listing: String = files
    .iter()
    .map(|(file, digest)| format!("{digest}  {file}\n"))
    .collect();
  Ok(sha256_hex(listing.as_bytes()))
}

/// sidecar が使えるか確かめる（実行できる・版が合う・`apple-raw-linear registry` が通る）。起動時に裏で 1 回だけ呼ぶ。
/// 失敗の文はログ用（パスを含めない）。
pub fn probe_sidecars(
  paths: &SidecarPaths,
  timeout: Duration,
  running: &Mutex<Option<i32>>,
) -> Result<Sidecars, String> {
  for (name, path) in [
    (APPLE_RAW_LINEAR_NAME, &paths.apple_raw_linear),
    (DEVELOP_RENDER_NAME, &paths.develop_render),
  ] {
    if !is_executable_file(path) {
      return Err(format!("{name} is not bundled"));
    }
  }
  let registry = paths.calibration_dir.join(CALIBRATION_REGISTRY_FILE);
  if !std::fs::symlink_metadata(&registry).is_ok_and(|metadata| metadata.is_file()) {
    return Err("the calibration registry is not bundled".into());
  }
  let grace = Duration::from_secs(1);
  let version = run_sidecar(
    &paths.apple_raw_linear,
    &os_args([OsStr::new("version")]),
    timeout,
    grace,
    running,
  );
  let apple_raw_linear_version = version
    .succeeded()
    .then(|| parse_version_line(APPLE_RAW_LINEAR_NAME, &version.stdout))
    .flatten()
    .ok_or_else(|| format!("apple-raw-linear version failed: {}", version.summary()))?;
  if !is_compatible_tool_version(&apple_raw_linear_version) {
    let expected = APPLE_RAW_LINEAR_SERIES.map(|series| format!("{series}.x")).join(" or ");
    return Err(format!(
      "apple-raw-linear {apple_raw_linear_version} is not in {expected}"
    ));
  }
  let checked = run_sidecar(
    &paths.apple_raw_linear,
    &os_args([OsStr::new("registry"), registry.as_os_str()]),
    timeout,
    grace,
    running,
  );
  let summary: Option<Value> = serde_json::from_str(checked.stdout.trim()).ok();
  let registry_ok = checked.succeeded()
    && summary.as_ref().is_some_and(|summary| {
      summary.get("registry").is_some_and(Value::is_string) && summary.get("cameras").is_some_and(Value::is_number)
    });
  if !registry_ok {
    return Err(format!("apple-raw-linear registry failed: {}", checked.summary()));
  }
  let signed_registry = paths.calibration_dir.join(SIGNED_CALIBRATION_REGISTRY_FILE);
  let signed_registry = if version_at_least(&apple_raw_linear_version, SIGNED_MIN_TOOL_VERSION)
    && std::fs::symlink_metadata(&signed_registry).is_ok_and(|metadata| metadata.is_file())
    && std::fs::read(&signed_registry).is_ok_and(|bytes| sha256_hex(&bytes) == sha256_hex(SIGNED_REGISTRY_SNAPSHOT))
  {
    let checked = run_sidecar(
      &paths.apple_raw_linear,
      &os_args([OsStr::new("registry"), signed_registry.as_os_str()]),
      timeout,
      grace,
      running,
    );
    let summary: Option<Value> = serde_json::from_str(checked.stdout.trim()).ok();
    (checked.succeeded()
      && summary.as_ref().is_some_and(|value| {
        value.get("registry").is_some_and(Value::is_string) && value.get("cameras").is_some_and(Value::is_number)
      }))
    .then_some(signed_registry)
  } else {
    None
  };
  let render = run_sidecar(
    &paths.develop_render,
    &os_args([OsStr::new("version")]),
    timeout,
    grace,
    running,
  );
  let develop_render_version = render
    .succeeded()
    .then(|| parse_version_line(DEVELOP_RENDER_NAME, &render.stdout))
    .flatten()
    .ok_or_else(|| format!("niho-develop-render version failed: {}", render.summary()))?;
  // 描ける設定（niho-photo#131）。この口の無い古い renderer は invalid_arguments で答えるので、失敗にせず None にする
  let capabilities = run_sidecar(
    &paths.develop_render,
    &os_args([OsStr::new("capabilities")]),
    timeout,
    grace,
    running,
  );
  let develop_render_capabilities = capabilities
    .succeeded()
    .then(|| RenderCapabilities::parse(&capabilities.stdout))
    .flatten();
  let registry_sha256 = std::fs::read(&registry)
    .map(|bytes| sha256_hex(&bytes))
    .map_err(|err| format!("calibration registry: {}", err.kind()))?;
  let signed_registry_sha256 = signed_registry
    .as_ref()
    .and_then(|path| std::fs::read(path).ok())
    .map(|bytes| sha256_hex(&bytes));
  let calibration =
    calibration_fingerprint(&paths.calibration_dir).map_err(|err| format!("calibration: {}", err.kind()))?;
  let raw_recipe = format!("apple-raw-linear {apple_raw_linear_version}; calibration {calibration}");
  let signed_raw_recipe = signed_registry_sha256.as_ref().map(|digest| {
    format!("apple-raw-linear {apple_raw_linear_version}; signed registry {digest}; calibration {calibration}")
  });
  Ok(Sidecars {
    raw_recipe,
    paths: paths.clone(),
    registry,
    registry_sha256,
    signed_registry,
    signed_registry_sha256,
    apple_raw_linear_version,
    develop_render_version,
    develop_render_capabilities,
    signed_raw_recipe,
  })
}

// ---------------------------------------------------------------------------
// 写真の出どころ（アプリが実装する。NIHO Desktop は開いた写真の `PhotoEditing`）

/// 開いている写真の元ファイル・表示名・開いたときの中身（パスはページへ渡さない）。
#[derive(Debug, Clone)]
pub struct OpenPhoto {
  pub path: PathBuf,
  pub file_name: String,
  pub digest: ContentDigest,
}

/// 現像が写真を読む口。NIHO Desktop は開いた写真（`photo_editing.rs` の `PhotoEditing`）が実装する（C2 #18390 で
/// `PhotoEditing` を直に受け取っていたのを、この trait にした）。`Arc` に包んだままでも渡せる。
pub trait DevelopPhotos {
  /// 開いている写真（現像の作業コピー・原寸の書き出し）。開いていなければ None。
  fn open_photo(&self, photo_id: &str) -> Option<OpenPhoto>;
  /// この Mac に保存済みの補正があるか（signed の新規生成を決める）。写真・保存先の状態が分からないときも true。
  fn has_saved_settings(&self, photo_id: &str) -> bool;
  /// 部分補正のマスク（ブラシ・被写体・空）の面の PNG（docs/local-adjustments.md「面の受け渡し」。`surface_id` は 16 進の
  /// 小文字 64 文字）。この Mac に無い・読めない・中身の SHA-256 が `surface_id` でないときは None。原寸の書き出しが、描かれる
  /// マスクの面をここから読んで `niho-develop-render --mask-surface` へ渡す（無ければ書き出す前に
  /// {@link develop_code::MASK_SURFACE_MISSING}）。既定は面の置き場を持たないアプリ（いつも None）。
  fn mask_surface(&self, _photo_id: &str, _surface_id: &str) -> Option<Vec<u8>> {
    None
  }
}

/// 新規 producer と保存済み・編集中の recipe 復元を分けるため、画面が知っている状態を source bridge に添える。
/// native の保存ストアに記録がある場合は、アプリ側がその記録から組み立てた context を優先する。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DevelopSourceContext {
  pub has_saved_develop_settings: bool,
  pub has_develop_edits: bool,
  /// 保存済みまたは draft が使っている作業コピーの `baseVersion`。オリジナル直描き・旧 `base: null` は None。
  pub base_version: Option<String>,
}

impl DevelopSourceContext {
  fn from_legacy(context: (bool, bool)) -> Self {
    Self {
      has_saved_develop_settings: context.0,
      has_develop_edits: context.1,
      base_version: None,
    }
  }
}

impl<T: DevelopPhotos + ?Sized> DevelopPhotos for Arc<T> {
  fn open_photo(&self, photo_id: &str) -> Option<OpenPhoto> {
    (**self).open_photo(photo_id)
  }

  fn has_saved_settings(&self, photo_id: &str) -> bool {
    (**self).has_saved_settings(photo_id)
  }

  fn mask_surface(&self, photo_id: &str, surface_id: &str) -> Option<Vec<u8>> {
    (**self).mask_surface(photo_id, surface_id)
  }
}

// ---------------------------------------------------------------------------
// 現像（作業コピー・原寸の書き出し）

/// 待ち時間の上限（テストでは短くする）。
#[derive(Clone, Debug)]
pub struct DevelopTimeouts {
  /// 使えるかの確かめ（`version`・`registry`・`niho-develop-render version`。1 本ごと。handshake が待つので短く）
  pub probe: Duration,
  /// `info`
  pub query: Duration,
  /// `render`・`raster`・`niho-develop-render`・`encode-jpeg`（1 本ごと）
  pub heavy: Duration,
  /// SIGTERM から SIGKILL までの猶予
  pub kill_grace: Duration,
}

impl Default for DevelopTimeouts {
  fn default() -> Self {
    Self {
      probe: Duration::from_secs(10),
      query: Duration::from_secs(30),
      heavy: Duration::from_secs(10 * 60),
      kill_grace: Duration::from_secs(2),
    }
  }
}

/// 製品ごとのラスタ入力上限と原寸書き出し能力。作業コピーの生成はどちらも `apple-raw-linear raster`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalRaster {
  /// NIHO Desktop: JPEG / PNG は 10MiB までオリジナルのまま。HEIC / HEIF・TIFF の原寸書き出しは公開しない。
  Desktop,
  /// NIHO camera: JPEG は 64MiB・PNG は 10MiB までオリジナルのまま。HEIC / HEIF・TIFF も原寸で書き出す。
  Camera,
}

/// 現像の設定（アプリが渡す: 同梱の sidecar の場所・作業コピーのキャッシュのフォルダ・待ち時間・ログ）。
pub struct DevelopConfig {
  /// 同梱の sidecar（`.app` の外で動かしている・Intel Mac などで場所が決まらなければ None）
  pub sidecars: Option<SidecarPaths>,
  /// 作業コピーのキャッシュ（`<app cache>/photo-develop`）。None なら現像を使えない
  pub cache_dir: Option<PathBuf>,
  pub cache_max_bytes: u64,
  pub timeouts: DevelopTimeouts,
  /// macOS の画像metadata読取とプレビューJPEG encode（production は絶対パス `/usr/bin/sips`、テストは偽物）。
  pub sips: PathBuf,
  /// ラスタの保存寸法と orientation。production は None（ImageIO）、テストだけ偽物を渡す。
  pub raster_info: Option<RasterInfoReader>,
  /// 新しい signed p3/e4 作業コピーの生成。読取・保存済み signed の復元とは独立し、製品側が既定値を決める。
  pub signed_raw_generation: bool,
  /// 製品ごとのラスタ入力上限と原寸書き出し能力。
  pub local_raster: LocalRaster,
  /// ログへ書く（kind, payload。NIHO Desktop は `desktop-bridge.log`）
  pub log: LogFn,
}

/// 現像の失敗（ページへは `code` と Desktop の文だけ。`detail` はログ用でパスを含めない）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevelopError {
  pub code: &'static str,
  pub message: &'static str,
  pub detail: String,
}

impl DevelopError {
  pub fn new(code: &'static str, message: &'static str, detail: impl Into<String>) -> Self {
    Self {
      code,
      message,
      detail: detail.into(),
    }
  }
}

fn internal(detail: impl Into<String>) -> DevelopError {
  DevelopError::new(code::INTERNAL, INTERNAL_MESSAGE, detail)
}

fn unavailable(detail: impl Into<String>) -> DevelopError {
  DevelopError::new(code::ENGINE_UNAVAILABLE, UNAVAILABLE_MESSAGE, detail)
}

fn not_open() -> DevelopError {
  DevelopError::new(code::NOT_FOUND, PHOTO_NOT_OPEN_MESSAGE, "photoId is not open")
}

fn not_applicable(detail: &str) -> DevelopError {
  DevelopError::new(develop_code::NOT_APPLICABLE, NOT_APPLICABLE_MESSAGE, detail)
}

fn validate_develop_input(path: &Path, stage: CapabilityStage) -> Result<(), DevelopError> {
  validate_photo_static(path, stage).map(|_| ()).map_err(|error| {
    DevelopError::new(
      error.code,
      error.message,
      format!("{} validation: {}", stage.as_str(), error.code),
    )
  })
}

/// 作業コピー・書き出し・クラウド用のラスタの作業コピーのどれの失敗か（同じ sidecar の失敗でもページへの code と文が違う）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Operation {
  Source,
  Export,
  /// クラウドへ上げるラスタの作業コピー（`apple-raw-linear raster`。W2c-2 #17145。ページは失敗を見せない）
  Raster,
}

impl Operation {
  fn name(self) -> &'static str {
    match self {
      Operation::Source => "source",
      Operation::Export => "export",
      Operation::Raster => "raster",
    }
  }

  /// sidecar の失敗をページの code にする（ワーカーの `classifyAppleRawLinearFailure` の分け方）。書き出しは
  /// `unsupportedSettings` のほかは `exportFailed`。
  fn tool_failure(self, step: &str, run: &ToolRun) -> DevelopError {
    let detail = format!("{step}: {}", run.summary());
    if run.timed_out {
      return DevelopError::new(
        if self == Operation::Export {
          code::EXPORT_FAILED
        } else {
          code::ENGINE_UNAVAILABLE
        },
        TIMEOUT_MESSAGE,
        detail,
      );
    }
    if run.spawn_error.is_some() {
      return unavailable(detail);
    }
    let tool_error = run.tool_error();
    let tool_error = tool_error.as_deref();
    if self == Operation::Export {
      if step == "develop" && run.exit_code == Some(2) {
        return DevelopError::new(develop_code::UNSUPPORTED_SETTINGS, UNSUPPORTED_SETTINGS_MESSAGE, detail);
      }
      if step == "encode" && tool_error == Some("write_failed") {
        return DevelopError::new(code::EXPORT_FAILED, EXPORT_WRITE_FAILED_MESSAGE, detail);
      }
      if step == "raster" && run.exit_code == Some(3) && tool_error == Some("unsupported_dimensions") {
        return DevelopError::new(
          develop_code::UNSUPPORTED_SOURCE,
          UNSUPPORTED_RASTER_DIMENSIONS_MESSAGE,
          detail,
        );
      }
      return DevelopError::new(code::EXPORT_FAILED, EXPORT_FAILED_MESSAGE, detail);
    }
    if self == Operation::Raster {
      // ワーカーの分け方: 扱えない色のプロファイル（exit 3 `unsupported_profile`）・読めない写真（exit 4）は再試行しない失敗
      return match (run.exit_code, tool_error) {
        (Some(3), Some("unsupported_profile"))
        | (Some(4), Some("input_not_found" | "read_failed" | "decode_failed")) => {
          DevelopError::new(code::DECODE_FAILED, DECODE_FAILED_MESSAGE, detail)
        }
        _ => DevelopError::new(code::INTERNAL, SOURCE_FAILED_MESSAGE, detail),
      };
    }
    match (run.exit_code, tool_error) {
      (Some(2), _) | (Some(3), Some("unsupported_decoder_version")) => {
        DevelopError::new(develop_code::UNSUPPORTED_CAMERA, UNSUPPORTED_CAMERA_MESSAGE, detail)
      }
      (Some(4), Some("input_not_found" | "read_failed")) => {
        DevelopError::new(code::DECODE_FAILED, DECODE_FAILED_MESSAGE, detail)
      }
      _ => DevelopError::new(code::INTERNAL, SOURCE_FAILED_MESSAGE, detail),
    }
  }

  fn invalid_output(self, detail: impl Into<String>) -> DevelopError {
    match self {
      Operation::Source | Operation::Raster => DevelopError::new(code::INTERNAL, SOURCE_FAILED_MESSAGE, detail),
      Operation::Export => DevelopError::new(code::EXPORT_FAILED, EXPORT_FAILED_MESSAGE, detail),
    }
  }
}

/// `photo_editing_develop_source_bytes` で受け取るもの。
#[derive(Debug, Clone)]
enum TokenSource {
  /// オリジナル（10MiB 以下の JPEG / PNG）。読むときに開いたときの中身と照らす
  Original { path: PathBuf, digest: ContentDigest },
  /// キャッシュの作業コピー
  WorkingCopy(CachedWorkingCopy),
}

struct SourceToken {
  photo_id: String,
  source: TokenSource,
  issued: Instant,
}

/// 作った作業コピー（キャッシュへ入れる前）。
struct MadeWorkingCopy {
  /// 作業コピーのファイル（この仕事の一時フォルダの中）
  file: PathBuf,
  format: WorkCopyFormat,
  /// ワーカーと同じ meta のファイル（RAW だけ。原寸の書き出しで niho-develop-render に渡す）
  meta_path: Option<PathBuf>,
  base_version: String,
  /// ページへ出す meta
  meta: Value,
}

/// 作業コピーの作り方（{@link PhotoDevelop::ensure_working_copy}。作り方ごとにキャッシュの `recipe` が違う）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkCopyMaker {
  /// RAW: apple-raw-linear の `render`（この Mac の編集とクラウドの両方。16bit PNG）
  RawLegacy,
  /// signed p3/e4。新規生成は flag と未編集判定を通したときだけ。保存済み signed の復元では flag を見ない。
  RawSigned,
  /// HEIC / HEIF・TIFF・上限を超える JPEG / PNG: apple-raw-linear の `raster`（`raster.ci2.*`。ICC 付きの 8bit JPEG）。
  /// この Mac の編集とクラウド用で同じキャッシュを使う。
  Raster,
}

impl WorkCopyMaker {
  /// `photo_editing_develop_source` の作業コピー。
  fn of_input(input: DevelopInput) -> Self {
    match input {
      DevelopInput::Raw => WorkCopyMaker::RawLegacy,
      DevelopInput::Raster | DevelopInput::RasterWorkingCopy => WorkCopyMaker::Raster,
    }
  }
}

/// 画像情報の読み取り口（テストでは合成値を注入する）。
pub type RasterInfoReader = Arc<dyn Fn(&Path) -> Result<RasterInfo, String> + Send + Sync>;

/// 作業コピーの大きさ（RAW の `--long-edge`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LongEdge {
  WorkingCopy,
  Pixels(u32),
  Full,
}

/// 実行中の現像の数を数える（「更新して再起動」の前の確認）。
struct Activity<'a>(&'a PhotoDevelop);

impl Drop for Activity<'_> {
  fn drop(&mut self) {
    self.0.in_flight.fetch_sub(1, Ordering::SeqCst);
  }
}

/// `cache_purge` 中は新しい現像を拒否し、終了時に必ず gate を開ける。
struct CachePurgeGate<'a>(&'a PhotoDevelop);

impl Drop for CachePurgeGate<'_> {
  fn drop(&mut self) {
    *lock(&self.0.activity_gate) = false;
  }
}

/// 書き出し先の決まり（保存ダイアログは上書きしてよい。フォルダ指定は既にあるファイルを上書きしない）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Overwrite {
  Allowed,
  Never,
}

/// 書き出し先のフォルダの一時ファイル（Drop で消す。rename した後は無いので何もしない）。書いている間は `current` に置き、
/// アプリの終了（{@link PhotoDevelop::shutdown}）でも消せるようにする（書き出しを並行して処理できるので、いくつでも置ける）。
struct PendingOutput<'a> {
  path: PathBuf,
  current: &'a Mutex<Vec<PathBuf>>,
}

impl<'a> PendingOutput<'a> {
  fn new(path: PathBuf, current: &'a Mutex<Vec<PathBuf>>) -> Self {
    lock(current).push(path.clone());
    Self { path, current }
  }
}

impl Drop for PendingOutput<'_> {
  fn drop(&mut self) {
    remove_pending_output(&self.path);
    lock(self.current).retain(|pending| pending != &self.path);
  }
}

/// 書き出しの一時ファイルと、`encode-jpeg` が同じフォルダに書く書きかけ（`.<一時ファイルの名前>.partial-<pid>`）を消す。時間切れの
/// SIGKILL・アプリの終了で sidecar が自分で消せなかったものが、写真の中身と撮影情報を持ったまま利用者のフォルダに残らないように。
/// 一時ファイルの名前は乱数なので、この書き出しのものだけを特定できる。シンボリックリンク・フォルダには触れない。
fn remove_pending_output(path: &Path) {
  let _ = std::fs::remove_file(path);
  let (Some(folder), Some(name)) = (path.parent(), path.file_name().and_then(|name| name.to_str())) else {
    return;
  };
  let prefix = format!(".{name}.partial-");
  let Ok(entries) = std::fs::read_dir(folder) else {
    return;
  };
  for entry in entries.flatten() {
    let is_partial = entry
      .file_name()
      .to_str()
      .is_some_and(|entry_name| entry_name.starts_with(&prefix));
    if is_partial && entry.metadata().is_ok_and(|metadata| metadata.is_file()) {
      let _ = std::fs::remove_file(entry.path());
    }
  }
}

/// sidecar を確かめる回数の上限（起動直後の 1 回と、失敗したときのやり直し 1 回）。
const MAX_PROBE_ATTEMPTS: u32 = 2;

#[derive(Default)]
struct ProbeState {
  ready: Option<Arc<Sidecars>>,
  failure: Option<String>,
  attempts: u32,
}

/// 現像の sidecar・待ち行列・キャッシュ・token を持つ（アプリに 1 つ）。
pub struct PhotoDevelop {
  config: DevelopConfig,
  cache: Option<DevelopCache>,
  /// sidecar の確かめ（成功は覚える。失敗は 1 回だけやり直す）。確かめている間はロックを持つ（同時に 2 回動かさない）
  probe: Mutex<ProbeState>,
  queue: JobQueue,
  tokens: Mutex<HashMap<String, SourceToken>>,
  in_flight: AtomicUsize,
  /// activity の開始と、cache_purge の「実行中でない」確認を直列化する。
  activity_gate: Mutex<bool>,
  /// 走っている sidecar のプロセスグループ（アプリの終了で止める）
  running: Mutex<Option<i32>>,
  /// 書いている途中の書き出しの一時ファイル（アプリの終了で消す）
  pending_outputs: Mutex<Vec<PathBuf>>,
  shutting_down: AtomicBool,
}

/// クラウドへ上げる作業コピー（`photo_editing_cloud_upload_work`。{@link PhotoDevelop::hold_work_copy}）。持っている間は待ち
/// 行列の番と実行中の印（`cache_purge` を断る・「更新して再起動」の前に数える）を持つ。上げる処理（async）の間ずっと持つので
/// `Arc` で持ち、Drop で番を渡して印を外す。
pub struct HeldWorkCopy {
  develop: Arc<PhotoDevelop>,
  /// 待ち行列の番を持っているか（番を待つ前に失敗したら false）
  has_turn: bool,
  cached: Option<CachedWorkingCopy>,
  /// 番を待った時間（ログ用）
  pub waited: Duration,
}

impl HeldWorkCopy {
  fn cached(&self) -> &CachedWorkingCopy {
    self
      .cached
      .as_ref()
      .expect("a held work copy has its cached working copy")
  }

  /// 上げる作業コピー（キャッシュのファイル。RAW は 16bit PNG、ラスタは ICC 付きの 8bit JPEG。パスはページへ返さない）。
  pub fn file(&self) -> &Path {
    &self.cached().file
  }

  /// 上げる作業コピーの形式（署名付き POST の Content-Type と part の名前を決める）。
  pub fn format(&self) -> WorkCopyFormat {
    self.cached().format
  }

  /// 上げる作業コピーの大きさと SHA-256（キャッシュの記録。送りながら照らす）。
  pub fn expected(&self) -> ContentDigest {
    let cached = self.cached();
    ContentDigest {
      key: cached.sha256.clone(),
      size_bytes: cached.byte_length,
    }
  }

  /// 上げ終えた（最終利用を記録する。掃除で古い順に消すときの順番）。
  pub fn uploaded(&self) {
    mark_used(self.file());
  }

  /// 送りながら照らした中身が記録と違った・読めなかった（壊れた作業コピーは消して、次に作り直させる）。
  pub fn damaged(&self) {
    if let (Some(cache), Some(cached)) = (&self.develop.cache, &self.cached) {
      cache.forget(cached);
    }
  }
}

impl Drop for HeldWorkCopy {
  fn drop(&mut self) {
    if self.has_turn {
      self.develop.queue.leave();
    }
    self.develop.in_flight.fetch_sub(1, Ordering::SeqCst);
  }
}

impl PhotoDevelop {
  /// アプリに 1 つ作る。sidecar の確かめは最初の {@link PhotoDevelop::sidecars}（起動直後に裏で呼ぶ）まで行わない。
  pub fn new(config: DevelopConfig) -> Arc<Self> {
    let cache = config
      .cache_dir
      .clone()
      .map(|dir| DevelopCache::new(dir, config.cache_max_bytes));
    Arc::new(Self {
      config,
      cache,
      probe: Mutex::new(ProbeState::default()),
      queue: JobQueue::default(),
      tokens: Mutex::new(HashMap::new()),
      in_flight: AtomicUsize::new(0),
      activity_gate: Mutex::new(false),
      running: Mutex::new(None),
      pending_outputs: Mutex::new(Vec::new()),
      shutting_down: AtomicBool::new(false),
    })
  }

  fn log(&self, kind: &str, payload: Value) {
    (self.config.log)(&format!("photo_editing.{kind}"), payload);
  }

  /// 同梱の sidecar（handshake と各コマンドが使う）。使えると分かったら覚えて確かめ直さない。使えなかったら、一時的な失敗
  /// （起動直後の混み合いなど）でアプリを閉じるまでずっと使えないままにならないよう、次の呼び出しで 1 回だけ確かめ直す
  /// （{@link MAX_PROBE_ATTEMPTS}）。sidecar が無いビルドは確かめ直さない。
  pub fn sidecars(&self) -> Result<Arc<Sidecars>, DevelopError> {
    let mut state = lock(&self.probe);
    if let Some(sidecars) = &state.ready {
      return Ok(sidecars.clone());
    }
    let Some(paths) = &self.config.sidecars else {
      return Err(unavailable("sidecars are not bundled"));
    };
    if state.attempts >= MAX_PROBE_ATTEMPTS {
      return Err(unavailable(state.failure.clone().unwrap_or_default()));
    }
    state.attempts += 1;
    let started = Instant::now();
    match probe_sidecars(paths, self.config.timeouts.probe, &self.running) {
      Ok(sidecars) => {
        self.log(
          "develop_ready",
          json!({
            "appleRawLinear": sidecars.apple_raw_linear_version,
            "developRender": sidecars.develop_render_version,
            "developRenderCapabilities": sidecars.develop_render_capabilities.is_some(),
            "attempt": state.attempts,
            "elapsedMs": started.elapsed().as_millis() as u64,
          }),
        );
        let sidecars = Arc::new(sidecars);
        state.ready = Some(sidecars.clone());
        state.failure = None;
        Ok(sidecars)
      }
      Err(reason) => {
        self.log(
          "develop_unavailable",
          json!({ "reason": reason, "attempt": state.attempts }),
        );
        state.failure = Some(reason.clone());
        Err(unavailable(reason))
      }
    }
  }

  /// handshake の `photoEditingDevelop` の sidecar の分（エンジンの有無は呼び出し側が見る）。
  pub fn is_available(&self) -> bool {
    self.cache.is_some() && self.sidecars().is_ok()
  }

  /// handshake は起動時の sidecar probe を待たない。確認が終わっていて使えるときだけ true を返す。
  pub fn is_available_cached(&self) -> bool {
    if self.cache.is_none() {
      return false;
    }
    let state = match self.probe.try_lock() {
      Ok(state) => state,
      Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
      Err(std::sync::TryLockError::WouldBlock) => return false,
    };
    state.ready.is_some()
  }

  /// handshake の `photoEditingCloudWorkRaster`（v22）の sidecar の分: 起動時の確かめが終わって使えて、同梱の apple-raw-linear が
  /// `raster` を持つ（0.4.3 以上）ときだけ true（待たない）。
  pub fn is_raster_available_cached(&self) -> bool {
    if self.cache.is_none() {
      return false;
    }
    let state = match self.probe.try_lock() {
      Ok(state) => state,
      Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
      Err(std::sync::TryLockError::WouldBlock) => return false,
    };
    state.ready.as_ref().is_some_and(|sidecars| sidecars.supports_raster())
  }

  /// 部分補正（`masks`）のある設定を原寸で書き出せる sidecar が使えるときだけ true（待たない）。
  pub fn is_masks_export_available_cached(&self) -> bool {
    if self.cache.is_none() {
      return false;
    }
    let state = match self.probe.try_lock() {
      Ok(state) => state,
      Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
      Err(std::sync::TryLockError::WouldBlock) => return false,
    };
    state.ready.as_ref().is_some_and(|sidecars| sidecars.supports_masks())
  }

  /// 同梱の niho-develop-render が描ける設定（{@link RenderCapabilities}）。起動時の確かめが終わって使えて、renderer が
  /// `capabilities` に答えたときだけ（待たない）。
  pub fn render_capabilities_cached(&self) -> Option<RenderCapabilities> {
    self.cache.as_ref()?;
    let state = match self.probe.try_lock() {
      Ok(state) => state,
      Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
      Err(std::sync::TryLockError::WouldBlock) => return None,
    };
    state
      .ready
      .as_ref()
      .and_then(|sidecars| sidecars.develop_render_capabilities.clone())
  }

  /// 原寸ラスタ書き出しで必要な `raster --long-edge full` を持つ sidecar が使えるときだけ true（待たない）。
  pub fn is_full_size_raster_export_available_cached(&self) -> bool {
    if self.cache.is_none() {
      return false;
    }
    let state = match self.probe.try_lock() {
      Ok(state) => state,
      Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
      Err(std::sync::TryLockError::WouldBlock) => return false,
    };
    state
      .ready
      .as_ref()
      .is_some_and(|sidecars| sidecars.supports_full_size_raster_export())
  }

  pub fn is_full_size_base_restore_available_cached(&self) -> bool {
    if self.cache.is_none() {
      return false;
    }
    let state = match self.probe.try_lock() {
      Ok(state) => state,
      Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
      Err(std::sync::TryLockError::WouldBlock) => return false,
    };
    state
      .ready
      .as_ref()
      .is_some_and(|sidecars| sidecars.supports_signed_restore())
  }

  fn cache(&self) -> Result<&DevelopCache, DevelopError> {
    self.cache.as_ref().ok_or_else(|| unavailable("no app cache directory"))
  }

  fn begin(&self) -> Result<Activity<'_>, DevelopError> {
    self.enter_activity()?;
    Ok(Activity(self))
  }

  /// 実行中の印を付ける（外すのは {@link Activity} か {@link HeldWorkCopy} の Drop）。`cache_purge` の最中は断る。
  fn enter_activity(&self) -> Result<(), DevelopError> {
    let purging = lock(&self.activity_gate);
    if *purging {
      return Err(DevelopError::new(
        code::ENGINE_UNAVAILABLE,
        CACHE_PURGING_MESSAGE,
        "cache purge in progress",
      ));
    }
    self.in_flight.fetch_add(1, Ordering::SeqCst);
    Ok(())
  }

  pub fn has_work_in_flight(&self) -> bool {
    self.in_flight.load(Ordering::SeqCst) > 0 || *lock(&self.activity_gate)
  }

  /// `cache_purge`（Mac を返す・渡すとき）: 現像が実行中なら断り（`cache_purge_failed`）、そうでなければ新しい現像を断りながら
  /// `purge_other_caches`（アプリのほかのキャッシュ）と作業コピーを消す。断るときの失敗は `PageError` から作る（NIHO Desktop は
  /// `DesktopCommandError`）。
  pub fn with_cache_purge<E: From<PageError>>(
    &self,
    purge_other_caches: impl FnOnce() -> Result<(), E>,
  ) -> Result<(), E> {
    // 仕事の開始と purge の確認を同じ gate で直列化し、確認直後に新しい処理が始まらないようにする。
    let mut purging = lock(&self.activity_gate);
    if self.in_flight.load(Ordering::SeqCst) > 0 {
      return Err(E::from(PageError::new(
        "cache_purge_failed",
        "写真の現像中はキャッシュを削除できません。処理が終わってから再試行してください。",
      )));
    }
    *purging = true;
    drop(purging);
    let _gate = CachePurgeGate(self);
    purge_other_caches()?;
    if let Some(outcome) = self.purge_cache() {
      self.log(
        "develop_cache_purged",
        json!({ "removed": outcome.removed, "removedBytes": outcome.removed_bytes, "remainingBytes": outcome.total_bytes }),
      );
    }
    Ok(())
  }

  /// アプリの終了: 走っている sidecar を止め（待たない）、書き出し先のフォルダの書きかけを消す。
  pub fn shutdown(&self) {
    self.shutting_down.store(true, Ordering::SeqCst);
    if let Some(pid) = *lock(&self.running) {
      signal_group(pid, libc::SIGKILL);
    }
    for pending in lock(&self.pending_outputs).clone() {
      remove_pending_output(&pending);
    }
  }

  fn run(&self, program: &Path, args: &[OsString], timeout: Duration) -> ToolRun {
    if self.shutting_down.load(Ordering::SeqCst) {
      return ToolRun {
        spawn_error: Some("app is shutting down".into()),
        ..ToolRun::default()
      };
    }
    run_sidecar(program, args, timeout, self.config.timeouts.kill_grace, &self.running)
  }

  /// sidecar の失敗（{@link Operation::tool_failure}）。sidecar が何も言わずに失敗した（落ちた）ときは、写真・作業フォルダの
  /// パスとホームを伏せた標準エラー出力の末尾をログ用の detail に足す。
  /// `extra` は書き出し先（一時ファイル・保存先）など、ほかに伏せるパス（そのフォルダも `…` になる）。
  fn failure(
    &self,
    operation: Operation,
    step: &str,
    run: &ToolRun,
    photo: &OpenPhoto,
    work: &WorkDir,
    extra: &[&Path],
  ) -> DevelopError {
    let mut failure = operation.tool_failure(step, run);
    if run.tool_error().is_none() && !run.timed_out && run.spawn_error.is_none() {
      let mut paths = vec![photo.path.clone(), work.path.clone()];
      paths.extend(extra.iter().map(|path| path.to_path_buf()));
      let stderr = run.scrubbed_stderr(&paths);
      if !stderr.is_empty() {
        failure.detail = format!("{}; stderr: {stderr}", failure.detail);
      }
    }
    failure
  }

  /// 開いたときの中身と今のファイルを照らす（変わっていれば・読めなければ `cloudContentMismatch`）。
  fn verify_original(&self, photo: &OpenPhoto) -> Result<(), DevelopError> {
    match content_digest(&photo.path) {
      Ok(current) if current == photo.digest => Ok(()),
      Ok(_) => Err(DevelopError::new(
        code::CLOUD_CONTENT_MISMATCH,
        PHOTO_CHANGED_MESSAGE,
        "the photo changed after it was opened",
      )),
      Err(err) => Err(DevelopError::new(
        code::CLOUD_CONTENT_MISMATCH,
        PHOTO_UNREADABLE_MESSAGE,
        format!("read: {}", err.kind()),
      )),
    }
  }

  fn issue_token(&self, photo_id: &str, source: TokenSource) -> String {
    let mut tokens = lock(&self.tokens);
    tokens.retain(|_, token| token.issued.elapsed() < TOKEN_TTL);
    while tokens.len() >= MAX_TOKENS {
      let Some(oldest) = tokens
        .iter()
        .min_by_key(|(_, token)| token.issued)
        .map(|(id, _)| id.clone())
      else {
        break;
      };
      tokens.remove(&oldest);
    }
    let token = format!("develop-{}", random_hex(16));
    tokens.insert(
      token.clone(),
      SourceToken {
        photo_id: photo_id.to_string(),
        source,
        issued: Instant::now(),
      },
    );
    token
  }

  /// 写真を開くときのページ向け metadata。ラスタは macOS ImageIO、RAW は同梱の
  /// `apple-raw-linear info --json` を使う。どちらも実際にデコーダで読めることを確かめ、向きを適用した寸法だけを返す。
  pub fn inspect_photo(&self, path: &Path, file_name: &str) -> Result<Value, DevelopError> {
    let _activity = self.begin()?;
    validate_develop_input(path, CapabilityStage::Metadata)?;
    let kind = photo_kind(file_name)
      .ok_or_else(|| DevelopError::new(code::DECODE_FAILED, DECODE_FAILED_MESSAGE, "not a photo extension"))?;
    if kind == "raw" {
      let sidecars = self.sidecars()?;
      let run = self.run(
        &sidecars.paths.apple_raw_linear,
        &os_args([OsStr::new("info"), path.as_os_str(), OsStr::new("--json")]),
        self.config.timeouts.query,
      );
      if !run.succeeded() {
        return Err(Operation::Source.tool_failure("info", &run));
      }
      let info = serde_json::from_str::<Value>(&run.stdout)
        .ok()
        .filter(Value::is_object)
        .ok_or_else(|| Operation::Source.invalid_output("info did not print a JSON object"))?;
      return raw_page_info(&info)
        .ok_or_else(|| Operation::Source.invalid_output("info did not describe the RAW dimensions"));
    }

    let info = match &self.config.raster_info {
      Some(read) => read(path),
      None => read_raster_info(path),
    }
    .map_err(|detail| {
      DevelopError::new(
        code::DECODE_FAILED,
        DECODE_FAILED_MESSAGE,
        format!("ImageIO metadata: {detail}"),
      )
    })?;
    let (width, height) = info.display_dimensions().ok_or_else(|| {
      DevelopError::new(
        code::DECODE_FAILED,
        DECODE_FAILED_MESSAGE,
        "ImageIO returned invalid dimensions",
      )
    })?;
    Ok(json!({
      "kind": "raster",
      "width": width,
      "height": height,
      "asShotWhiteBalance": null,
      "settings": {},
    }))
  }

  /// クラウド追加用の補正前プレビュー。ラスタは `apple-raw-linear raster --preview-out`、RAW は同じ作業コピーを
  /// `niho-develop-render` の中立設定で描き、macOS の `sips` で JPEG にする。1024px 以下・1MiB 以下で、EXIF/GPS/IPTCを持たない。
  pub fn preview_original(
    &self,
    photos: &dyn DevelopPhotos,
    photo_id: &str,
    max_dimension: u32,
  ) -> Result<Vec<u8>, DevelopError> {
    let _activity = self.begin()?;
    if max_dimension == 0 || max_dimension > WORKING_COPY_LONG_EDGE {
      return Err(DevelopError::new(
        code::INVALID_REQUEST,
        SOURCE_FAILED_MESSAGE,
        "preview dimension is out of range",
      ));
    }
    let sidecars = self.sidecars()?;
    let cache = self.cache()?;
    let photo = photos.open_photo(photo_id).ok_or_else(not_open)?;
    validate_develop_input(&photo.path, CapabilityStage::Thumbnail)?;
    self.verify_original(&photo)?;
    let _turn = self.queue.enter();
    let work = cache
      .work_dir()
      .map_err(|err| internal(format!("work dir: {}", err.kind())))?;
    let preview = work.path.join("preview.jpg");

    if photo_kind(&photo.file_name) == Some("raster") {
      let disposable = work.path.join("raster.jpg");
      let meta = work.path.join("raster.json");
      let max_dimension = max_dimension.to_string();
      let run = self.run(
        &sidecars.paths.apple_raw_linear,
        &os_args([
          OsStr::new("raster"),
          photo.path.as_os_str(),
          OsStr::new("--out"),
          disposable.as_os_str(),
          OsStr::new("--preview-out"),
          preview.as_os_str(),
          OsStr::new("--meta"),
          meta.as_os_str(),
          OsStr::new("--long-edge"),
          OsStr::new(&max_dimension),
          OsStr::new("--quality"),
          OsStr::new(RASTER_QUALITY),
        ]),
        self.config.timeouts.heavy,
      );
      if !run.succeeded() {
        return Err(self.failure(Operation::Source, "preview-raster", &run, &photo, &work, &[]));
      }
    } else {
      let made = self.render_raw(
        &sidecars,
        &photo,
        &work,
        LongEdge::Pixels(max_dimension),
        Operation::Source,
        WorkCopyMaker::RawLegacy,
        None,
      )?;
      let settings = work.path.join("preview-settings.json");
      // CLI は版付き設定だけを読む。保存済み補正を参照せず、identity look の中立設定でプレビューを作る。
      let neutral =
        serde_json::to_vec(&json!({ "v": 1, "engine": "niho-2", "base": made.base_version, "look": "niho-interim-1" }))
          .map_err(|_| internal("preview settings could not be serialized"))?;
      write_private_file_atomically(&settings, &neutral)
        .map_err(|err| internal(format!("preview settings: {}", err.kind())))?;
      let rendered = work.path.join("preview.png");
      let meta = made
        .meta_path
        .as_ref()
        .ok_or_else(|| internal("RAW preview has no working-copy meta"))?;
      let run = self.run(
        &sidecars.paths.develop_render,
        &os_args([
          OsStr::new("render"),
          OsStr::new("--settings"),
          settings.as_os_str(),
          OsStr::new("--out"),
          rendered.as_os_str(),
          OsStr::new("--max-dimension"),
          OsStr::new(&max_dimension.to_string()),
          OsStr::new("--working-copy"),
          made.file.as_os_str(),
          OsStr::new("--meta"),
          meta.as_os_str(),
          OsStr::new("--base-version"),
          OsStr::new(&made.base_version),
        ]),
        self.config.timeouts.heavy,
      );
      if !run.succeeded() {
        return Err(self.failure(Operation::Source, "preview-develop", &run, &photo, &work, &[]));
      }
      let mut encoded = false;
      for quality in PREVIEW_JPEG_QUALITIES {
        let run = self.run(
          &self.config.sips,
          &os_args([
            OsStr::new("-s"),
            OsStr::new("format"),
            OsStr::new("jpeg"),
            OsStr::new("-s"),
            OsStr::new("formatOptions"),
            OsStr::new(&quality.to_string()),
            OsStr::new("--out"),
            preview.as_os_str(),
            rendered.as_os_str(),
          ]),
          self.config.timeouts.heavy,
        );
        if run.succeeded() {
          let sanitized = std::fs::read(&preview)
            .ok()
            .and_then(|bytes| strip_jpeg_private_metadata(&bytes));
          if let Some(bytes) = sanitized.filter(|bytes| {
            bytes.len() as u64 <= MAX_PREVIEW_BYTES && parse_jpeg_frame(bytes).is_some_and(|frame| frame.is_rgb8())
          }) {
            write_private_file_atomically(&preview, &bytes)
              .map_err(|err| internal(format!("preview metadata removal: {}", err.kind())))?;
            encoded = true;
            break;
          }
        }
      }
      if !encoded {
        return Err(DevelopError::new(
          code::INTERNAL,
          SOURCE_FAILED_MESSAGE,
          "could not encode a preview within the size limit",
        ));
      }
    }

    self.verify_original(&photo)?;
    let bytes = std::fs::read(&preview).map_err(|err| {
      DevelopError::new(
        code::INTERNAL,
        SOURCE_FAILED_MESSAGE,
        format!("preview read: {}", err.kind()),
      )
    })?;
    if bytes.len() as u64 > MAX_PREVIEW_BYTES
      || !jpeg_has_no_exif_or_gps(&bytes)
      || !parse_jpeg_frame(&bytes).is_some_and(|frame| frame.is_rgb8())
    {
      return Err(DevelopError::new(
        code::INTERNAL,
        SOURCE_FAILED_MESSAGE,
        "preview is not a metadata-free JPEG within the size limit",
      ));
    }
    Ok(bytes)
  }

  /// `photo_editing_develop_source`: 写真の入力（オリジナルか作業コピー）を決め、作業コピーが要れば作る（キャッシュにあれば
  /// 作り直さない）。バイト列は返さず、`token` で `source_bytes` から受け取る。
  pub fn source(&self, photos: &dyn DevelopPhotos, photo_id: &str) -> Result<Value, DevelopError> {
    self.source_with_context(photos, photo_id, None)
  }

  /// {@link PhotoDevelop::source} に、ページが知っている保存・編集の有無（`hasSavedDevelopSettings`・`hasDevelopEdits`）を添える。
  pub fn source_with_context(
    &self,
    photos: &dyn DevelopPhotos,
    photo_id: &str,
    signed_context: Option<(bool, bool)>,
  ) -> Result<Value, DevelopError> {
    self.source_with_options(photos, photo_id, signed_context, false)
  }

  /// {@link PhotoDevelop::source_with_context} に、オリジナルのまま渡せる JPEG / PNG でも作業コピーにするか（`force_working_copy`。
  /// 画面が開いて 4,000 万画素を超えると分かった JPEG。web の `develop-work-target.ts` と同じ）を添える。
  pub fn source_with_options(
    &self,
    photos: &dyn DevelopPhotos,
    photo_id: &str,
    signed_context: Option<(bool, bool)>,
    force_working_copy: bool,
  ) -> Result<Value, DevelopError> {
    self.source_with_options_context(
      photos,
      photo_id,
      signed_context.map(DevelopSourceContext::from_legacy),
      force_working_copy,
    )
  }

  /// {@link PhotoDevelop::source_with_options} に、保存済み・draft の exact base を含む context を添える。
  /// context 欠落は旧クライアントとして保守的に扱い、新規 signed producer を起動しない。
  pub fn source_with_options_context(
    &self,
    photos: &dyn DevelopPhotos,
    photo_id: &str,
    source_context: Option<DevelopSourceContext>,
    force_working_copy: bool,
  ) -> Result<Value, DevelopError> {
    let started = Instant::now();
    let result = self
      .begin()
      .and_then(|_activity| self.source_inner(photos, photo_id, source_context.as_ref(), force_working_copy));
    match &result {
      Ok((input, cached, value)) => self.log(
        "develop_source",
        json!({
          "input": format!("{input:?}"),
          "cached": cached,
          "byteLength": value.get("byteLength"),
          "baseVersion": value.get("baseVersion"),
          "elapsedMs": started.elapsed().as_millis() as u64,
        }),
      ),
      Err(err) => self.log(
        "develop_failed",
        json!({ "operation": Operation::Source.name(), "code": err.code, "detail": err.detail, "elapsedMs": started.elapsed().as_millis() as u64 }),
      ),
    }
    result.map(|(_, _, value)| value)
  }

  fn source_inner(
    &self,
    photos: &dyn DevelopPhotos,
    photo_id: &str,
    source_context: Option<&DevelopSourceContext>,
    force_working_copy: bool,
  ) -> Result<(DevelopInput, bool, Value), DevelopError> {
    let sidecars = self.sidecars()?;
    let cache = self.cache()?;
    // 作り始める前の `cache_purge` の世代（作っている間に消されたら、作った作業コピーは置かない）
    let generation = cache.generation();
    let photo = photos.open_photo(photo_id).ok_or_else(not_open)?;
    validate_develop_input(&photo.path, CapabilityStage::Decoder)?;
    let mut input =
      develop_input_for(&photo.file_name, photo.digest.size_bytes, self.config.local_raster).ok_or_else(|| {
        DevelopError::new(
          develop_code::UNSUPPORTED_SOURCE,
          UNSUPPORTED_SOURCE_MESSAGE,
          "not a photo extension",
        )
      })?;
    if force_working_copy && input == DevelopInput::Raster {
      input = DevelopInput::RasterWorkingCopy;
    }
    self.verify_original(&photo)?;
    if input == DevelopInput::Raster {
      let byte_length = photo.digest.size_bytes;
      let token = self.issue_token(
        photo_id,
        TokenSource::Original {
          path: photo.path,
          digest: photo.digest,
        },
      );
      return Ok((
        input,
        false,
        json!({ "kind": "raster", "byteLength": byte_length, "token": token }),
      ));
    }
    let (maker, requested_base) = if input == DevelopInput::Raw {
      self.raw_source_plan(photos, photo_id, &sidecars, source_context)?
    } else {
      (WorkCopyMaker::of_input(input), None)
    };
    let (cached, was_cached) =
      self.ensure_working_copy(&sidecars, cache, generation, &photo, maker, requested_base.as_deref())?;
    let value = json!({
      "kind": "workingCopy",
      "byteLength": cached.byte_length,
      "baseVersion": cached.base_version,
      "meta": cached.meta,
    });
    let token = self.issue_token(photo_id, TokenSource::WorkingCopy(cached));
    let mut value = value;
    value["token"] = json!(token);
    Ok((input, was_cached, value))
  }

  /// 作り方（RAW は {@link Sidecars::raw_recipe}、ラスタは {@link Sidecars::raster_recipe}）と作った道具の名前。
  fn recipe_of(&self, sidecars: &Sidecars, maker: WorkCopyMaker) -> (String, &'static str) {
    match maker {
      WorkCopyMaker::RawLegacy => (sidecars.raw_recipe.clone(), APPLE_RAW_LINEAR_NAME),
      WorkCopyMaker::RawSigned => (
        sidecars
          .signed_raw_recipe
          .clone()
          .unwrap_or_else(|| "signed unavailable".into()),
        APPLE_RAW_LINEAR_NAME,
      ),
      WorkCopyMaker::Raster => (sidecars.raster_recipe(), APPLE_RAW_LINEAR_NAME),
    }
  }

  fn raw_source_plan(
    &self,
    photos: &dyn DevelopPhotos,
    photo_id: &str,
    sidecars: &Sidecars,
    source_context: Option<&DevelopSourceContext>,
  ) -> Result<(WorkCopyMaker, Option<String>), DevelopError> {
    let exact = |base: &str| {
      if is_signed_raw_base(base) {
        if sidecars.supports_signed_restore() {
          Ok((WorkCopyMaker::RawSigned, Some(base.to_string())))
        } else {
          Err(DevelopError::new(
            develop_code::RESTORATION_UNAVAILABLE,
            RESTORATION_UNAVAILABLE_MESSAGE,
            "the saved signed RAW recipe is unavailable",
          ))
        }
      } else if is_legacy_raw_base(base) {
        Ok((WorkCopyMaker::RawLegacy, Some(base.to_string())))
      } else {
        Err(DevelopError::new(
          develop_code::RESTORATION_UNAVAILABLE,
          RESTORATION_UNAVAILABLE_MESSAGE,
          "the saved RAW base recipe is not bundled",
        ))
      }
    };
    // 保存ストアが「保存あり」と答えたのに exact base が来ない場合は、古い base:null・壊れた記録・古いクライアントの
    // いずれでも新規 producer を起動しない。camera adapter は保存ストアを読み直した context を渡す。
    if photos.has_saved_settings(photo_id) {
      let base = source_context
        .filter(|context| context.has_saved_develop_settings)
        .and_then(|context| context.base_version.as_deref());
      return base.map(exact).unwrap_or_else(|| Ok((WorkCopyMaker::RawLegacy, None)));
    }

    let Some(context) = source_context else {
      return Ok((WorkCopyMaker::RawLegacy, None));
    };
    if let Some(base) = context.base_version.as_deref() {
      return exact(base);
    }
    if context.has_saved_develop_settings || context.has_develop_edits {
      return Ok((WorkCopyMaker::RawLegacy, None));
    }
    if self.config.signed_raw_generation && sidecars.supports_signed_restore() {
      Ok((WorkCopyMaker::RawSigned, None))
    } else {
      Ok((WorkCopyMaker::RawLegacy, None))
    }
  }

  /// クラウドへ一緒に上げる作業コピーの種類（{@link cloud_work_kind}）。対象でない写真と、同梱の apple-raw-linear が `raster` を
  /// 持たない（0.4.3 より前）ときのラスタは `notApplicable`（何も作らない）。
  fn cloud_work_kind_of(&self, sidecars: &Sidecars, photo: &OpenPhoto) -> Result<CloudWorkKind, DevelopError> {
    match cloud_work_kind(&photo.file_name, photo.digest.size_bytes) {
      Some(CloudWorkKind::Raw) => Ok(CloudWorkKind::Raw),
      Some(CloudWorkKind::Raster) if sidecars.supports_raster() => Ok(CloudWorkKind::Raster),
      Some(CloudWorkKind::Raster) => Err(not_applicable("the bundled apple-raw-linear has no raster")),
      None => Err(not_applicable("not a photo whose working copy is uploaded")),
    }
  }

  /// 作業コピーをキャッシュから探し、無ければ待ち行列の番で作って置く（`photo_editing_develop_source` と
  /// `photo_editing_work_copy_info` で同じ作り方・同じキャッシュ）。`(作業コピー, キャッシュにあったか)`。呼ぶ前に写真の中身を
  /// 照らしておく（{@link PhotoDevelop::verify_original}）。`generation` は作り始める前に読んだ `cache_purge` の世代。
  fn ensure_working_copy(
    &self,
    sidecars: &Sidecars,
    cache: &DevelopCache,
    generation: u64,
    photo: &OpenPhoto,
    maker: WorkCopyMaker,
    requested_base: Option<&str>,
  ) -> Result<(CachedWorkingCopy, bool), DevelopError> {
    let (mut recipe, mut renderer) = self.recipe_of(sidecars, maker);
    let lookup_started = Instant::now();
    let legacy_cached = if maker == WorkCopyMaker::RawSigned && requested_base.is_none() {
      let (legacy_recipe, _) = self.recipe_of(sidecars, WorkCopyMaker::RawLegacy);
      cache.find(&photo.digest.key, &legacy_recipe, None)
    } else {
      None
    };
    let cached = legacy_cached.or_else(|| cache.find(&photo.digest.key, &recipe, requested_base));
    self.log("develop_stage", json!({ "stage": "cacheLookup", "elapsedMs": lookup_started.elapsed().as_secs_f64() * 1000.0, "cached": cached.is_some() }));
    if let Some(cached) = cached {
      return Ok((cached, true));
    }
    let _turn = self.queue.enter();
    // 待っている間に、同じ写真の別の要求が作ったかもしれない
    if maker == WorkCopyMaker::RawSigned && requested_base.is_none() {
      let (legacy_recipe, _) = self.recipe_of(sidecars, WorkCopyMaker::RawLegacy);
      if let Some(cached) = cache.find(&photo.digest.key, &legacy_recipe, None) {
        return Ok((cached, true));
      }
    }
    if let Some(cached) = cache.find(&photo.digest.key, &recipe, requested_base) {
      return Ok((cached, true));
    }
    let work = cache
      .work_dir()
      .map_err(|err| internal(format!("work dir: {}", err.kind())))?;
    let mut made = match maker {
      WorkCopyMaker::RawLegacy => self.render_raw(
        sidecars,
        photo,
        &work,
        LongEdge::WorkingCopy,
        Operation::Source,
        WorkCopyMaker::RawLegacy,
        requested_base,
      )?,
      WorkCopyMaker::RawSigned => self.render_raw(
        sidecars,
        photo,
        &work,
        LongEdge::WorkingCopy,
        Operation::Source,
        WorkCopyMaker::RawSigned,
        requested_base,
      )?,
      WorkCopyMaker::Raster => self.render_raster(sidecars, photo, &work)?,
    };
    // signed registry に一致しない機種は旧 recipe を維持する。cal-none を既知機種の校正へ結びつけない。
    if maker == WorkCopyMaker::RawSigned && requested_base.is_none() && made.base_version.contains(".cal-none.") {
      (recipe, renderer) = self.recipe_of(sidecars, WorkCopyMaker::RawLegacy);
      if let Some(cached) = cache.find(&photo.digest.key, &recipe, None) {
        return Ok((cached, true));
      }
      made = self.render_raw(
        sidecars,
        photo,
        &work,
        LongEdge::WorkingCopy,
        Operation::Source,
        WorkCopyMaker::RawLegacy,
        None,
      )?;
    }
    if requested_base.is_some_and(|base| base != made.base_version) {
      return Err(DevelopError::new(
        develop_code::RESTORATION_UNAVAILABLE,
        RESTORATION_UNAVAILABLE_MESSAGE,
        format!("rendered base {} differs from requested base", made.base_version),
      ));
    }
    // 描いている間に写真が変わっていたら、その作業コピーは使わない
    self.verify_original(photo)?;
    let store_started = Instant::now();
    let cached = cache
      .store(
        generation,
        &CacheEntry {
          key: &photo.digest.key,
          recipe: &recipe,
          renderer,
          base_version: &made.base_version,
          meta: &made.meta,
          format: made.format,
        },
        &made.file,
      )
      .map_err(|err| match err.kind() {
        io::ErrorKind::Interrupted => DevelopError::new(
          code::INTERNAL,
          TOKEN_NOT_FOUND_MESSAGE,
          "the cache was purged while developing",
        ),
        kind => internal(format!("cache store: {kind}")),
      })?;
    self.log(
      "develop_stage",
      json!({ "stage": "cacheStore", "elapsedMs": store_started.elapsed().as_secs_f64() * 1000.0 }),
    );
    self.sweep_cache(std::slice::from_ref(&cached.file));
    Ok((cached, false))
  }

  /// `photo_editing_work_copy_info`（v21。W2b-2 #17145）: クラウドへ一緒に上げる作業コピーを用意し（無ければ作る）、
  /// `{ baseVersion, calibrationRegistrySha256, meta, sizeBytes, width, height }` を返す（API の `work/client-upload` の準備の本文と
  /// 同じ名前）。RAW は `photo_editing_develop_source` と同じ作り方・同じキャッシュ。v22（W2c-2）から HEIC / HEIF・TIFF・10MiB を
  /// 超える PNG は、ワーカーと同じ `apple-raw-linear raster` の JPEG（この Mac の編集と同じキャッシュ）を使う。
  /// `calibrationRegistrySha256` はラスタでも同梱の登録表の SHA-256（API の schema 上
  /// 必須。照合は RAW だけ）。JPEG・10MiB 以下の PNG は `notApplicable`。
  pub fn work_copy_info(&self, photos: &dyn DevelopPhotos, photo_id: &str) -> Result<Value, DevelopError> {
    self.work_copy_info_with_context(photos, photo_id, None)
  }

  /// {@link PhotoDevelop::work_copy_info} に、ページが知っている保存・編集の有無を添える。
  pub fn work_copy_info_with_context(
    &self,
    photos: &dyn DevelopPhotos,
    photo_id: &str,
    signed_context: Option<(bool, bool)>,
  ) -> Result<Value, DevelopError> {
    let started = Instant::now();
    let result = self
      .begin()
      .and_then(|_activity| self.work_copy_info_inner(photos, photo_id, signed_context));
    match &result {
      Ok((cached, value)) => self.log(
        "develop_work_info",
        json!({
          "cached": cached,
          "sizeBytes": value.get("sizeBytes"),
          "baseVersion": value.get("baseVersion"),
          "elapsedMs": started.elapsed().as_millis() as u64,
        }),
      ),
      Err(err) => self.log(
        "develop_failed",
        json!({ "operation": "workInfo", "code": err.code, "detail": err.detail, "elapsedMs": started.elapsed().as_millis() as u64 }),
      ),
    }
    result.map(|(_, value)| value)
  }

  fn work_copy_info_inner(
    &self,
    photos: &dyn DevelopPhotos,
    photo_id: &str,
    signed_context: Option<(bool, bool)>,
  ) -> Result<(bool, Value), DevelopError> {
    let sidecars = self.sidecars()?;
    let cache = self.cache()?;
    let generation = cache.generation();
    let photo = photos.open_photo(photo_id).ok_or_else(not_open)?;
    let kind = self.cloud_work_kind_of(&sidecars, &photo)?;
    self.verify_original(&photo)?;
    let source_context = signed_context.map(DevelopSourceContext::from_legacy);
    let (maker, requested_base) = match kind {
      CloudWorkKind::Raw => self.raw_source_plan(photos, photo_id, &sidecars, source_context.as_ref())?,
      CloudWorkKind::Raster => (WorkCopyMaker::Raster, None),
    };
    let (cached, was_cached) =
      self.ensure_working_copy(&sidecars, cache, generation, &photo, maker, requested_base.as_deref())?;
    let Some((width, height)) = work_copy_size(&cached) else {
      cache.forget(&cached);
      return Err(DevelopError::new(
        code::INTERNAL,
        SOURCE_FAILED_MESSAGE,
        "the cached working copy is gone or damaged",
      ));
    };
    // 続けて上げる（{@link PhotoDevelop::hold_work_copy}）ので、掃除で古い順に消されないよう最終利用を記録する
    mark_used(&cached.file);
    Ok((
      was_cached,
      json!({
        "baseVersion": cached.base_version,
        "calibrationRegistrySha256": if is_signed_raw_base(&cached.base_version) {
          sidecars.signed_registry_sha256.as_deref().unwrap_or(&sidecars.registry_sha256)
        } else {
          &sidecars.registry_sha256
        },
        "meta": cached.meta,
        "sizeBytes": cached.byte_length,
        "width": width,
        "height": height,
      }),
    ))
  }

  /// `photo_editing_cloud_upload_work`（v21）の前半: 上げる作業コピー（{@link PhotoDevelop::work_copy_info} が用意したキャッシュの
  /// RAW の PNG か、v22 からはラスタの JPEG）を決め、上げ終わるまで待ち行列の番と実行中の印を持つ（重い処理の同時 1 本の約束に
  /// 乗せる。上げている間に `cache_purge` で消されない）。作り直さない: キャッシュに無ければ `notFound`（ページは
  /// `photo_editing_work_copy_info` からやり直す）、`base_version` がキャッシュと違えば `invalidRequest`。対象でない写真は
  /// `notApplicable`。blocking のスレッドから呼ぶ（番を待つ）。
  pub fn hold_work_copy(
    self: &Arc<Self>,
    photos: &dyn DevelopPhotos,
    photo_id: &str,
    base_version: &str,
  ) -> Result<HeldWorkCopy, DevelopError> {
    let started = Instant::now();
    self.enter_activity()?;
    let mut held = HeldWorkCopy {
      develop: self.clone(),
      has_turn: false,
      cached: None,
      waited: Duration::ZERO,
    };
    let sidecars = self.sidecars()?;
    let cache = self.cache()?;
    let photo = photos.open_photo(photo_id).ok_or_else(not_open)?;
    let kind = self.cloud_work_kind_of(&sidecars, &photo)?;
    let maker = match kind {
      CloudWorkKind::Raw if is_signed_raw_base(base_version) => WorkCopyMaker::RawSigned,
      CloudWorkKind::Raw => WorkCopyMaker::RawLegacy,
      CloudWorkKind::Raster => WorkCopyMaker::Raster,
    };
    let (recipe, _) = self.recipe_of(&sidecars, maker);
    self.queue.wait_turn();
    held.has_turn = true;
    held.waited = started.elapsed();
    // Prefer the exact base version. If this photo/recipe has only another
    // version cached, keep it long enough to return INVALID_REQUEST below;
    // never hold or upload that mismatched copy.
    let cached = cache
      .find(&photo.digest.key, &recipe, Some(base_version))
      .or_else(|| cache.find(&photo.digest.key, &recipe, None))
      .ok_or_else(|| {
        DevelopError::new(
          code::NOT_FOUND,
          TOKEN_NOT_FOUND_MESSAGE,
          "no cached working copy for the photo",
        )
      })?;
    if cached.base_version != base_version {
      return Err(DevelopError::new(
        code::INVALID_REQUEST,
        INVALID_BASE_VERSION_MESSAGE,
        "baseVersion differs from the cached working copy",
      ));
    }
    held.cached = Some(cached);
    Ok(held)
  }

  /// キャッシュの掃除（上限を超えた作業コピー・落ちた仕事の一時フォルダ・書きかけ）。作業コピーを置いたとき・書き出しの後・
  /// 起動直後（sidecar の確かめの後）に呼ぶ。`keep` の作業コピーは消さない。
  pub fn sweep_cache(&self, keep: &[PathBuf]) {
    let Some(cache) = &self.cache else { return };
    let swept = cache.sweep(keep, SystemTime::now());
    if swept.removed > 0 {
      self.log(
        "develop_cache_swept",
        json!({ "removed": swept.removed, "removedBytes": swept.removed_bytes, "totalBytes": swept.total_bytes }),
      );
    }
  }

  /// `apple-raw-linear info` → RAW の版 → `render` → baseVersion・meta。新規生成はワーカーと同じ引数、保存 base の復元は
  /// decoder / calibration / lens をその base に固定する。
  // 公開移植では既存の現像・保存APIと引数順の互換を維持する。
  #[expect(clippy::too_many_arguments)]
  fn render_raw(
    &self,
    sidecars: &Sidecars,
    photo: &OpenPhoto,
    work: &WorkDir,
    long_edge: LongEdge,
    operation: Operation,
    maker: WorkCopyMaker,
    expected_base: Option<&str>,
  ) -> Result<MadeWorkingCopy, DevelopError> {
    let signed = maker == WorkCopyMaker::RawSigned;
    let registry = if signed {
      sidecars.signed_registry.as_ref().ok_or_else(|| {
        DevelopError::new(
          develop_code::RESTORATION_UNAVAILABLE,
          RESTORATION_UNAVAILABLE_MESSAGE,
          "the signed calibration registry is unavailable",
        )
      })?
    } else {
      &sidecars.registry
    };
    let tool = &sidecars.paths.apple_raw_linear;
    let info_started = Instant::now();
    let info = self.run(
      tool,
      &os_args([OsStr::new("info"), photo.path.as_os_str(), OsStr::new("--json")]),
      self.config.timeouts.query,
    );
    self.log(
      "develop_stage",
      json!({ "stage": "info", "elapsedMs": info_started.elapsed().as_secs_f64() * 1000.0 }),
    );
    if !info.succeeded() {
      return Err(self.failure(operation, "info", &info, photo, work, &[]));
    }
    let info_document = serde_json::from_str::<Value>(&info.stdout)
      .ok()
      .filter(Value::is_object)
      .ok_or_else(|| operation.invalid_output("info did not print a JSON object"))?;
    let supported: Vec<String> = info_document
      .get("supportedDecoderVersions")
      .and_then(Value::as_array)
      .cloned()
      .map(|versions| versions.iter().filter_map(Value::as_str).map(str::to_string).collect())
      .ok_or_else(|| operation.invalid_output("info printed no supportedDecoderVersions"))?;
    let saved_base = expected_base
      .map(|base| {
        let (processing, encoding) = if signed {
          (SIGNED_PROCESSING_VERSION, SIGNED_ENCODING_VERSION)
        } else {
          (PROCESSING_VERSION, ENCODING_VERSION)
        };
        parse_saved_raw_base(base, processing, encoding).ok_or_else(|| {
          DevelopError::new(
            develop_code::RESTORATION_UNAVAILABLE,
            RESTORATION_UNAVAILABLE_MESSAGE,
            "the saved RAW base recipe is malformed or unsupported",
          )
        })
      })
      .transpose()?;
    let decoder_version = if let Some(saved) = saved_base {
      supported
        .iter()
        .find(|version| decoder_base_part(version) == saved.decoder)
        .map(String::as_str)
        .ok_or_else(|| {
          DevelopError::new(
            develop_code::RESTORATION_UNAVAILABLE,
            RESTORATION_UNAVAILABLE_MESSAGE,
            format!("saved RAW decoder {} is unavailable", saved.decoder),
          )
        })?
    } else {
      let Some(decoder_version) = select_decoder_version(&supported) else {
        let detail = format!(
          "RAW decoder version 8 is not supported (supported: {})",
          supported.join(", ")
        );
        return Err(match operation {
          Operation::Export => DevelopError::new(code::EXPORT_FAILED, EXPORT_FAILED_MESSAGE, detail),
          Operation::Source | Operation::Raster => {
            DevelopError::new(develop_code::UNSUPPORTED_CAMERA, UNSUPPORTED_CAMERA_MESSAGE, detail)
          }
        });
      };
      decoder_version
    };
    let png = work.path.join("work.png");
    let meta_path = work.path.join("work.meta.json");
    let tool_meta = work.path.join("work.tool.json");
    let long_edge = match long_edge {
      LongEdge::WorkingCopy => WORKING_COPY_LONG_EDGE.to_string(),
      LongEdge::Pixels(value) => value.to_string(),
      LongEdge::Full => "full".to_string(),
    };
    let mut args = os_args([
      OsStr::new("render"),
      photo.path.as_os_str(),
      OsStr::new("--out"),
      png.as_os_str(),
      OsStr::new("--meta"),
      tool_meta.as_os_str(),
      OsStr::new("--working-copy-meta"),
      meta_path.as_os_str(),
      OsStr::new("--long-edge"),
      OsStr::new(&long_edge),
      OsStr::new("--space"),
      OsStr::new("linear-prophoto"),
      OsStr::new("--encoding"),
      OsStr::new(if signed { SIGNED_ENCODING_FORMAT } else { "png16-g18" }),
      OsStr::new("--decoder-version"),
      OsStr::new(decoder_version),
    ]);
    if signed {
      args.extend(os_args([
        OsStr::new("--nr"),
        OsStr::new("off"),
        OsStr::new("--gamut-mapping"),
        OsStr::new("off"),
      ]));
    }
    let explicit_calibration = if !signed {
      saved_base
        .map(|saved| {
          explicit_restoration_calibration(
            &sidecars.paths.calibration_dir,
            &sidecars.registry,
            saved,
            &info_document,
          )
        })
        .transpose()?
        .flatten()
    } else {
      if let Some(saved) = saved_base.filter(|saved| saved.calibration_id != "none") {
        if !registry_contains_calibration(registry, &sidecars.paths.calibration_dir, saved) {
          return Err(DevelopError::new(
            develop_code::RESTORATION_UNAVAILABLE,
            RESTORATION_UNAVAILABLE_MESSAGE,
            "the saved signed calibration is not bundled",
          ));
        }
      }
      None
    };
    if let Some(calibration) = explicit_calibration {
      args.extend(os_args([OsStr::new("--calibration"), calibration.as_os_str()]));
    } else if !saved_base.is_some_and(|saved| saved.calibration_id == "none") {
      args.extend(os_args([OsStr::new("--calibration-registry"), registry.as_os_str()]));
    }
    if let Some(saved) = saved_base.filter(|saved| matches!(saved.lens_mode, "apple" | "embedded")) {
      args.extend(os_args([OsStr::new("--lens-correction"), OsStr::new(saved.lens_mode)]));
    }
    let rendered = self.run(tool, &args, self.config.timeouts.heavy);
    if !rendered.succeeded() {
      return Err(self.failure(operation, "render", &rendered, photo, work, &[]));
    }
    if let Some(meta) = read_json_file(&tool_meta) {
      for (stage, elapsed_ms) in raw_stage_timings(&meta) {
        self.log("develop_stage", json!({ "stage": stage, "elapsedMs": elapsed_ms }));
      }
    }
    let working_copy_meta: Value = std::fs::read(&meta_path)
      .ok()
      .and_then(|bytes| serde_json::from_slice(&bytes).ok())
      .filter(Value::is_object)
      .ok_or_else(|| operation.invalid_output("apple-raw-linear did not write a readable working-copy meta"))?;
    let applied = describe_working_copy(&working_copy_meta).map_err(|code| operation.invalid_output(code))?;
    if applied.decoder_version != decoder_version {
      return Err(operation.invalid_output("apple-raw-linear used another RAW decoder version"));
    }
    let base_version = if signed {
      build_raw_base_version(&applied, SIGNED_PROCESSING_VERSION, SIGNED_ENCODING_VERSION)
    } else {
      build_base_version(&applied)
    }
    .map_err(|code| operation.invalid_output(code))?;
    if png_size(&png).is_none() {
      return Err(operation.invalid_output("apple-raw-linear wrote an invalid working copy"));
    }
    Ok(MadeWorkingCopy {
      file: png,
      format: WorkCopyFormat::Png,
      meta_path: Some(meta_path),
      base_version,
      meta: artifact_meta(&working_copy_meta, &extension_of(&photo.file_name)),
    })
  }

  /// クラウドへ上げるラスタの作業コピー（HEIC / HEIF・TIFF・10MiB を超える PNG。W2c-2 #17145）: `apple-raw-linear raster` を
  /// ワーカーと同じ引数（`raster <写真> --out … --meta … --long-edge 2560 --quality 0.94`。プレビューは作らない）・同じ環境変数で
  /// 動かし、baseVersion と meta をワーカーと同じ規則で組む。書いた JPEG の最初の SOF が 8bit・3 成分で、寸法が meta と同じことも
  /// 確かめる（API の入れ終わりと同じ見方）。
  fn render_raster(
    &self,
    sidecars: &Sidecars,
    photo: &OpenPhoto,
    work: &WorkDir,
  ) -> Result<MadeWorkingCopy, DevelopError> {
    self.render_raster_at(sidecars, photo, work, LongEdge::WorkingCopy, Operation::Raster)
  }

  /// `apple-raw-linear raster` を `long_edge`（作業コピーは {@link WORKING_COPY_LONG_EDGE}、原寸の書き出しは
  /// `full`）で描く。
  fn render_raster_at(
    &self,
    sidecars: &Sidecars,
    photo: &OpenPhoto,
    work: &WorkDir,
    long_edge: LongEdge,
    operation: Operation,
  ) -> Result<MadeWorkingCopy, DevelopError> {
    let jpeg = work.path.join("work.jpg");
    let meta_path = work.path.join("work.meta.json");
    let long_edge = match long_edge {
      LongEdge::WorkingCopy => WORKING_COPY_LONG_EDGE.to_string(),
      LongEdge::Pixels(value) => value.to_string(),
      LongEdge::Full => "full".to_string(),
    };
    let args = os_args([
      OsStr::new("raster"),
      photo.path.as_os_str(),
      OsStr::new("--out"),
      jpeg.as_os_str(),
      OsStr::new("--meta"),
      meta_path.as_os_str(),
      OsStr::new("--long-edge"),
      OsStr::new(&long_edge),
      OsStr::new("--quality"),
      OsStr::new(RASTER_QUALITY),
    ]);
    let rendered = self.run(&sidecars.paths.apple_raw_linear, &args, self.config.timeouts.heavy);
    if !rendered.succeeded() {
      return Err(self.failure(operation, "raster", &rendered, photo, work, &[]));
    }
    let tool_meta: Value = std::fs::read(&meta_path)
      .ok()
      .and_then(|bytes| serde_json::from_slice(&bytes).ok())
      .filter(Value::is_object)
      .ok_or_else(|| operation.invalid_output("apple-raw-linear raster did not write a readable meta"))?;
    let raster = parse_raster_meta(&tool_meta).map_err(|code| operation.invalid_output(code))?;
    let base_version =
      build_raster_base_version(raster.icc_sha256.as_deref()).map_err(|code| operation.invalid_output(code))?;
    let written = jpeg_frame(&jpeg)
      .filter(JpegFrame::is_rgb8)
      .map(|frame| (frame.width, frame.height));
    if written != Some((raster.width, raster.height)) {
      return Err(operation.invalid_output("apple-raw-linear raster wrote an invalid working copy"));
    }
    Ok(MadeWorkingCopy {
      file: jpeg,
      format: WorkCopyFormat::Jpeg,
      meta_path: None,
      base_version,
      meta: raster_artifact_meta(&raster, &extension_of(&photo.file_name)),
    })
  }

  /// `photo_editing_develop_source_bytes`: `token` のバイト列（1 回限り）。オリジナルは開いたときの中身と、作業コピーは
  /// 記録した SHA-256 と照らしてから返す。
  pub fn source_bytes(&self, photos: &dyn DevelopPhotos, photo_id: &str, token: &str) -> Result<Vec<u8>, DevelopError> {
    // RAW は数十 MiB になることがあり、読み取りと SHA-256 検証中の cache_purge / 再起動を防ぐ。
    let _activity = self.begin()?;
    let taken = lock(&self.tokens).remove(token);
    let Some(taken) = taken.filter(|taken| taken.photo_id == photo_id && taken.issued.elapsed() < TOKEN_TTL) else {
      return Err(DevelopError::new(
        code::NOT_FOUND,
        TOKEN_NOT_FOUND_MESSAGE,
        "unknown or expired token",
      ));
    };
    if photos.open_photo(photo_id).is_none() {
      return Err(not_open());
    }
    match taken.source {
      TokenSource::Original { path, digest } => {
        // 開いた後に別の（大きな）ファイルへ置き換わっていても、読む前に大きさで止める
        let metadata = std::fs::metadata(&path).map_err(|err| {
          DevelopError::new(
            code::CLOUD_CONTENT_MISMATCH,
            PHOTO_UNREADABLE_MESSAGE,
            format!("stat: {}", err.kind()),
          )
        })?;
        if metadata.len() != digest.size_bytes {
          return Err(DevelopError::new(
            code::CLOUD_CONTENT_MISMATCH,
            PHOTO_CHANGED_MESSAGE,
            "the photo changed after it was opened",
          ));
        }
        let bytes = std::fs::read(&path).map_err(|err| {
          DevelopError::new(
            code::CLOUD_CONTENT_MISMATCH,
            PHOTO_UNREADABLE_MESSAGE,
            format!("read: {}", err.kind()),
          )
        })?;
        if bytes.len() as u64 != digest.size_bytes || sha256_hex(&bytes) != digest.key {
          return Err(DevelopError::new(
            code::CLOUD_CONTENT_MISMATCH,
            PHOTO_CHANGED_MESSAGE,
            "the photo changed after it was opened",
          ));
        }
        Ok(bytes)
      }
      TokenSource::WorkingCopy(cached) => {
        let bytes = std::fs::read(&cached.file).ok();
        match bytes {
          Some(bytes) if bytes.len() as u64 == cached.byte_length && sha256_hex(&bytes) == cached.sha256 => {
            mark_used(&cached.file);
            Ok(bytes)
          }
          _ => {
            if let Some(cache) = &self.cache {
              cache.forget(&cached);
            }
            Err(DevelopError::new(
              code::NOT_FOUND,
              TOKEN_NOT_FOUND_MESSAGE,
              "the cached working copy is gone or damaged",
            ))
          }
        }
      }
    }
  }

  /// `photo_editing_export_develop`: 原寸の JPEG を `destination` に書く（RAW は同じ土台の原寸、JPEG / PNG はオリジナルに
  /// 段 2 を当てる）。`Overwrite::Never` なら既にあるファイルを上書きしない。
  pub fn export(
    &self,
    photos: &dyn DevelopPhotos,
    photo_id: &str,
    develop_settings: &Value,
    destination: &Path,
    overwrite: Overwrite,
  ) -> Result<(), DevelopError> {
    self.export_with_saved_state(photos, photo_id, develop_settings, false, false, destination, overwrite)
  }

  /// {@link PhotoDevelop::export} に、ページが知っている保存・編集の有無（`hasSavedDevelopSettings`・`hasDevelopEdits`）を添える。
  // 公開移植では既存の現像・保存APIと引数順の互換を維持する。
  #[expect(clippy::too_many_arguments)]
  pub fn export_with_saved_state(
    &self,
    photos: &dyn DevelopPhotos,
    photo_id: &str,
    develop_settings: &Value,
    has_saved_develop_settings: bool,
    has_develop_edits: bool,
    destination: &Path,
    overwrite: Overwrite,
  ) -> Result<(), DevelopError> {
    let started = Instant::now();
    let mut steps = Map::new();
    let result = match self.begin() {
      Ok(_activity) => {
        let result = self.export_inner(
          photos,
          photo_id,
          develop_settings,
          has_saved_develop_settings,
          has_develop_edits,
          destination,
          overwrite,
          &mut steps,
        );
        // 成功・失敗とも、この仕事の一時フォルダは消えている。落ちた前の仕事の残り（1 時間より古いもの）もここで消す
        self.sweep_cache(&[]);
        result
      }
      Err(err) => Err(err),
    };
    match &result {
      Ok(input) => self.log(
        "develop_exported",
        json!({ "input": format!("{input:?}"), "stepsMs": steps, "elapsedMs": started.elapsed().as_millis() as u64 }),
      ),
      Err(err) => self.log(
        "develop_failed",
        json!({ "operation": Operation::Export.name(), "code": err.code, "detail": err.detail, "stepsMs": steps, "elapsedMs": started.elapsed().as_millis() as u64 }),
      ),
    }
    result.map(|_| ())
  }

  // 公開移植では既存の現像・保存APIと引数順の互換を維持する。
  #[expect(clippy::too_many_arguments)]
  fn export_inner(
    &self,
    photos: &dyn DevelopPhotos,
    photo_id: &str,
    develop_settings: &Value,
    has_saved_develop_settings: bool,
    has_develop_edits: bool,
    destination: &Path,
    overwrite: Overwrite,
    steps: &mut Map<String, Value>,
  ) -> Result<ExportInput, DevelopError> {
    let sidecars = self.sidecars()?;
    // 部分補正のある設定は、描ける sidecar にだけ渡す（作業コピーを作る前に断る。古い sidecar はマスクを落とさず失敗するが、
    // 原寸の作業コピーを作る時間を使わせない）
    if carries_masks(develop_settings) && !sidecars.supports_masks() {
      return Err(DevelopError::new(
        develop_code::UNSUPPORTED_SETTINGS,
        UNSUPPORTED_SETTINGS_MESSAGE,
        format!(
          "local masks need niho-develop-render {MASKS_MIN_RENDER_VERSION} (bundled {})",
          sidecars.develop_render_version
        ),
      ));
    }
    // 描ける設定の分かる renderer には、読めない `v`・engine・描かない輝度を渡さない（原寸の作業コピーを作る前に断る。niho-photo#131）
    if let Some(reason) = sidecars
      .develop_render_capabilities
      .as_ref()
      .and_then(|capabilities| capabilities.unsupported_reason(develop_settings))
    {
      return Err(DevelopError::new(
        develop_code::UNSUPPORTED_SETTINGS,
        UNSUPPORTED_SETTINGS_MESSAGE,
        reason,
      ));
    }
    let cache = self.cache()?;
    let photo = photos.open_photo(photo_id).ok_or_else(not_open)?;
    validate_develop_input(&photo.path, CapabilityStage::FullRender)?;
    let input = self.export_input_of(&sidecars, &photo)?;
    // 描かれる面のマスク（ブラシ・被写体・空）の面を、作業コピーを作る前にこの Mac の置き場から読む（無ければ断る。sidecar は面の
    // 無い有効なマスクを描かずに失敗する）。描かれないマスクの面は渡さない
    let mut surfaces = Vec::new();
    for surface_id in mask_surface_ids(develop_settings, true) {
      let bytes = is_content_key(&surface_id)
        .then(|| photos.mask_surface(photo_id, &surface_id))
        .flatten()
        .filter(|bytes| mask_surface_id(bytes) == surface_id)
        .ok_or_else(|| {
          DevelopError::new(
            develop_code::MASK_SURFACE_MISSING,
            MASK_SURFACE_MISSING_MESSAGE,
            format!("mask surface {surface_id} is not on this Mac"),
          )
        })?;
      surfaces.push((surface_id, bytes));
    }
    let folder = destination
      .parent()
      .filter(|folder| !folder.as_os_str().is_empty())
      .ok_or_else(|| internal("destination has no folder"))?;
    let _turn = self.queue.enter();
    self.verify_original(&photo)?;
    let work = cache
      .work_dir()
      .map_err(|err| internal(format!("work dir: {}", err.kind())))?;
    let settings_path = work.path.join("settings.json");
    let mut effective_settings = develop_settings.clone();
    let rendered = work.path.join("rendered.png");
    let mut develop_args = os_args([
      OsStr::new("render"),
      OsStr::new("--settings"),
      settings_path.as_os_str(),
      OsStr::new("--out"),
      rendered.as_os_str(),
      OsStr::new("--max-dimension"),
      OsStr::new("0"),
    ]);
    // 面はこの仕事の一時フォルダへ写して渡す（置き場のパスを sidecar へ渡さない。仕事が終われば一時フォルダごと消える）
    for (surface_id, bytes) in &surfaces {
      let path = work.path.join(format!("surface-{surface_id}.png"));
      write_private_file_atomically(&path, bytes).map_err(|err| internal(format!("mask surface: {}", err.kind())))?;
      let mut argument = OsString::from(format!("{surface_id}="));
      argument.push(path.as_os_str());
      develop_args.extend([OsString::from("--mask-surface"), argument]);
    }
    drop(surfaces);
    let mut full_size: Option<MadeWorkingCopy> = None;
    match input {
      ExportInput::Raw => {
        let step = Instant::now();
        let saved_base = develop_settings.get("base").and_then(Value::as_str);
        let exact_base = saved_base;
        let maker = match saved_base {
          Some(base) if is_signed_raw_base(base) && sidecars.supports_signed_restore() => WorkCopyMaker::RawSigned,
          Some(base) if is_legacy_raw_base(base) => WorkCopyMaker::RawLegacy,
          Some(_) => {
            return Err(DevelopError::new(
              develop_code::RESTORATION_UNAVAILABLE,
              RESTORATION_UNAVAILABLE_MESSAGE,
              "the saved base recipe is not bundled",
            ));
          }
          None if has_saved_develop_settings || photos.has_saved_settings(photo_id) || has_develop_edits => {
            WorkCopyMaker::RawLegacy
          }
          None if self.config.signed_raw_generation && sidecars.supports_signed_restore() => WorkCopyMaker::RawSigned,
          None => WorkCopyMaker::RawLegacy,
        };
        let mut made = self.render_raw(
          &sidecars,
          &photo,
          &work,
          LongEdge::Full,
          Operation::Export,
          maker,
          exact_base,
        )?;
        // 未編集の新規生成だけは、signed registry に無い機種を旧 recipe に戻す。保存 base の復元では絶対に代替しない。
        if exact_base.is_none() && maker == WorkCopyMaker::RawSigned && made.base_version.contains(".cal-none.") {
          made = self.render_raw(
            &sidecars,
            &photo,
            &work,
            LongEdge::Full,
            Operation::Export,
            WorkCopyMaker::RawLegacy,
            None,
          )?;
        }
        if exact_base.is_some_and(|base| base != made.base_version) {
          return Err(DevelopError::new(
            develop_code::RESTORATION_UNAVAILABLE,
            RESTORATION_UNAVAILABLE_MESSAGE,
            format!("rendered base {} differs from saved base", made.base_version),
          ));
        }
        if exact_base.is_none() && !has_develop_edits && is_signed_raw_base(&made.base_version) {
          if let Value::Object(settings) = &mut effective_settings {
            let known = supports_known_signed_raw(&made.meta);
            let niho7 = known && version_at_least(&sidecars.develop_render_version, NIHO7_MIN_RENDER_VERSION);
            let niho11 = known && version_at_least(&sidecars.develop_render_version, NIHO11_MIN_RENDER_VERSION);
            settings.insert(
              "engine".into(),
              json!(if niho11 {
                "niho-11"
              } else if niho7 {
                "niho-7"
              } else if known {
                "niho-4"
              } else {
                "niho-3"
              }),
            );
            settings.insert(
              "look".into(),
              json!(if niho7 {
                "niho-standard-5"
              } else if known {
                "niho-standard-3"
              } else {
                "niho-standard-2"
              }),
            );
            settings.insert("base".into(), json!(made.base_version.clone()));
          }
        }
        steps.insert("workingCopy".into(), json!(step.elapsed().as_millis() as u64));
        let meta_path = made.meta_path.clone().ok_or_else(|| internal("no working-copy meta"))?;
        develop_args.extend(os_args([
          OsStr::new("--working-copy"),
          made.file.as_os_str(),
          OsStr::new("--meta"),
          meta_path.as_os_str(),
          OsStr::new("--base-version"),
          OsStr::new(&made.base_version),
        ]));
        full_size = Some(made);
      }
      ExportInput::Raster => develop_args.extend(os_args([OsStr::new("--raster"), photo.path.as_os_str()])),
      ExportInput::RasterFullSize => {
        // HEIC / HEIF・TIFF: `apple-raw-linear raster` で ICC 付きの原寸の JPEG にしてから段 2 へ（RAW 専用の `render` は使わない）
        let step = Instant::now();
        let made = self.render_raster_at(&sidecars, &photo, &work, LongEdge::Full, Operation::Export)?;
        steps.insert("workingCopy".into(), json!(step.elapsed().as_millis() as u64));
        develop_args.extend(os_args([OsStr::new("--raster"), made.file.as_os_str()]));
        full_size = Some(made);
      }
    }
    let settings_bytes = serde_json::to_vec(&effective_settings).map_err(|err| internal(format!("settings: {err}")))?;
    write_private_file_atomically(&settings_path, &settings_bytes)
      .map_err(|err| internal(format!("settings: {}", err.kind())))?;
    let step = Instant::now();
    let developed = self.run(
      &sidecars.paths.develop_render,
      &develop_args,
      self.config.timeouts.heavy,
    );
    steps.insert("develop".into(), json!(step.elapsed().as_millis() as u64));
    if !developed.succeeded() {
      return Err(self.failure(Operation::Export, "develop", &developed, &photo, &work, &[destination]));
    }
    // 原寸の作業コピー（約 100MB）は描き終えたら手放す
    if let Some(made) = full_size.take() {
      let _ = std::fs::remove_file(&made.file);
    }
    if png_size(&rendered).is_none() {
      return Err(Operation::Export.invalid_output("niho-develop-render wrote no PNG"));
    }
    // 書き出し先の名前は 255 バイトまで使うので、一時ファイルの名前には入れない（隠しファイル・短い名前）
    let pending = PendingOutput::new(
      folder.join(format!(".niho-develop-{}.jpg", random_hex(8))),
      &self.pending_outputs,
    );
    let step = Instant::now();
    let encoded = self.run(
      &sidecars.paths.apple_raw_linear,
      &os_args([
        OsStr::new("encode-jpeg"),
        OsStr::new("--pixels"),
        rendered.as_os_str(),
        OsStr::new("--metadata-from"),
        photo.path.as_os_str(),
        OsStr::new("--out"),
        pending.path.as_os_str(),
        OsStr::new("--quality"),
        OsStr::new(EXPORT_JPEG_QUALITY),
      ]),
      self.config.timeouts.heavy,
    );
    steps.insert("encode".into(), json!(step.elapsed().as_millis() as u64));
    if !encoded.succeeded() {
      return Err(self.failure(
        Operation::Export,
        "encode",
        &encoded,
        &photo,
        &work,
        &[pending.path.as_path(), destination],
      ));
    }
    if !std::fs::symlink_metadata(&pending.path).is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0) {
      return Err(Operation::Export.invalid_output("encode-jpeg wrote no JPEG"));
    }
    // 書いている間に写真が変わっていたら、その JPEG は置かない
    self.verify_original(&photo)?;
    place_output(&pending.path, destination, overwrite).map_err(|err| {
      DevelopError::new(
        code::EXPORT_FAILED,
        EXPORT_WRITE_FAILED_MESSAGE,
        format!("place: {}", err.kind()),
      )
    })?;
    Ok(input)
  }

  /// 書き出しの前（保存ダイアログを出す前）の確認: 写真が開いている・書き出せる形式・sidecar が使える。
  pub fn check_export(&self, photos: &dyn DevelopPhotos, photo_id: &str) -> Result<OpenPhoto, DevelopError> {
    let photo = photos.open_photo(photo_id).ok_or_else(not_open)?;
    if export_input_for(&photo.file_name, self.config.local_raster).is_none() {
      return Err(DevelopError::new(
        develop_code::UNSUPPORTED_SOURCE,
        UNSUPPORTED_SOURCE_MESSAGE,
        "HEIC / TIFF",
      ));
    }
    let sidecars = self.sidecars()?;
    self.export_input_of(&sidecars, &photo)?;
    Ok(photo)
  }

  /// 原寸では大きすぎる写真か（保存ダイアログを出す前・フォルダへの 1 枚ごと。niho-photo#132）。同梱の renderer が読める画素数
  /// （`capabilities` の `maxPixels`。答えない古い renderer は {@link LEGACY_RENDER_MAX_PIXELS}）と、この Mac のメモリに収まる見込み
  /// （{@link full_size_peak_bytes}）で決める。写真が開いていない・書き出せない形式・sidecar が使えない・寸法が分からないときは
  /// None（断らない。失敗は今までどおり書き出しの中で返る）。
  pub fn full_size_too_large(
    &self,
    photos: &dyn DevelopPhotos,
    photo_id: &str,
    develop_settings: &Value,
  ) -> Option<FullSizeTooLarge> {
    let photo = photos.open_photo(photo_id)?;
    let sidecars = self.sidecars().ok()?;
    let input = self.export_input_of(&sidecars, &photo).ok()?;
    let (width, height) = self.full_size_dimensions(&sidecars, &photo.path, input)?;
    let max_pixels = sidecars
      .develop_render_capabilities
      .as_ref()
      .map_or(LEGACY_RENDER_MAX_PIXELS, |capabilities| capabilities.max_pixels);
    let too_large = full_size_too_large(
      width,
      height,
      input,
      develop_settings,
      max_pixels,
      physical_memory_bytes(),
    );
    if let Some(too_large) = too_large {
      self.log(
        "export_too_large",
        json!({ "width": width, "height": height, "maxPixels": max_pixels, "maxLongEdge": too_large.max_long_edge }),
      );
    }
    too_large
  }

  /// 原寸の書き出しの元の寸法（向きを反映。{@link inspect_photo} と同じ読み方: RAW は `apple-raw-linear info`、ほかは ImageIO）。
  fn full_size_dimensions(&self, sidecars: &Sidecars, path: &Path, input: ExportInput) -> Option<(u64, u64)> {
    if input == ExportInput::Raw {
      let run = self.run(
        &sidecars.paths.apple_raw_linear,
        &os_args([OsStr::new("info"), path.as_os_str(), OsStr::new("--json")]),
        self.config.timeouts.query,
      );
      let info: Value = run
        .succeeded()
        .then(|| serde_json::from_str(&run.stdout).ok())
        .flatten()?;
      let page = raw_page_info(&info)?;
      return Some((page.get("width")?.as_u64()?, page.get("height")?.as_u64()?));
    }
    match &self.config.raster_info {
      Some(read) => read(path),
      None => read_raster_info(path),
    }
    .ok()?
    .display_dimensions()
  }

  /// 原寸の書き出しの入力（{@link export_input_for}）。HEIC / HEIF・TIFF は同梱の apple-raw-linear が `raster` を持つ（0.4.3〜）
  /// ときだけ。原寸書き出しには `raster --long-edge full` を含む 0.5.2 以上が必要。
  fn export_input_of(&self, sidecars: &Sidecars, photo: &OpenPhoto) -> Result<ExportInput, DevelopError> {
    match export_input_for(&photo.file_name, self.config.local_raster) {
      Some(ExportInput::RasterFullSize) if !sidecars.supports_full_size_raster_export() => Err(DevelopError::new(
        develop_code::UNSUPPORTED_SOURCE,
        UNSUPPORTED_SOURCE_MESSAGE,
        "the bundled apple-raw-linear has no full-size raster export",
      )),
      Some(input) => Ok(input),
      None => Err(DevelopError::new(
        develop_code::UNSUPPORTED_SOURCE,
        UNSUPPORTED_SOURCE_MESSAGE,
        "HEIC / TIFF",
      )),
    }
  }

  /// `cache_purge`: 作業コピーを全部消す。
  pub(crate) fn purge_cache(&self) -> Option<DevelopSweep> {
    self.cache.as_ref().map(DevelopCache::purge)
  }
}

/// 書き出しの一時ファイルを `destination` に置く。`Overwrite::Never` は hard link を試し、使えないボリュームでは排他的 rename を使う。
/// どちらも destination が既にあれば失敗する。排他的 rename を使えないボリュームでは安全側に倒して失敗する。
fn place_output(pending: &Path, destination: &Path, overwrite: Overwrite) -> io::Result<()> {
  match overwrite {
    Overwrite::Allowed => std::fs::rename(pending, destination),
    Overwrite::Never => match std::fs::hard_link(pending, destination) {
      Ok(()) => {
        let _ = std::fs::remove_file(pending);
        Ok(())
      }
      Err(err) if err.kind() == io::ErrorKind::AlreadyExists => Err(err),
      Err(_) => rename_exclusive(pending, destination),
    },
  }
}

#[cfg(target_os = "macos")]
fn rename_exclusive(pending: &Path, destination: &Path) -> io::Result<()> {
  let pending = std::ffi::CString::new(pending.as_os_str().as_bytes())
    .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "source path contains NUL"))?;
  let destination = std::ffi::CString::new(destination.as_os_str().as_bytes())
    .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "destination path contains NUL"))?;
  // SAFETY: both C strings are NUL-terminated and remain alive for the duration of the syscall.
  let result = unsafe {
    libc::renameatx_np(
      libc::AT_FDCWD,
      pending.as_ptr(),
      libc::AT_FDCWD,
      destination.as_ptr(),
      libc::RENAME_EXCL,
    )
  };
  if result == 0 {
    Ok(())
  } else {
    Err(io::Error::last_os_error())
  }
}

#[cfg(not(target_os = "macos"))]
fn rename_exclusive(_pending: &Path, _destination: &Path) -> io::Result<()> {
  Err(io::Error::new(
    io::ErrorKind::Unsupported,
    "exclusive rename is unavailable on this platform",
  ))
}

/// JPEG の最初のフレームヘッダ（SOF0〜SOF2）の寸法・精度・成分数。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JpegFrame {
  pub width: u32,
  pub height: u32,
  pub precision: u8,
  pub components: u8,
}

impl JpegFrame {
  /// 8bit・3 成分（ICC 付きの 8bit RGB。API の入れ終わりが受ける形）で、寸法が 0 でないか。
  pub fn is_rgb8(&self) -> bool {
    self.precision == 8 && self.components == 3 && self.width > 0 && self.height > 0
  }
}

/// JPEG の先頭（128KiB まで）のマーカーを順に読み、最初の SOF を返す（API の `readPhotoCloudWorkJpegFrameHeader` と同じ読み方）。
/// SOI で始まらない・SOS / EOI より前に SOF が無い・最初の SOF が SOF0〜SOF2 でない・セグメントが壊れている・上限の外まで続くなら
/// None。マーカーの前の FF の連続は読み飛ばす。
pub fn parse_jpeg_frame(bytes: &[u8]) -> Option<JpegFrame> {
  let end = bytes.len().min(JPEG_HEADER_BYTES as usize);
  if end < 2 || bytes[0] != 0xff || bytes[1] != 0xd8 {
    return None;
  }
  let mut offset = 2;
  while offset < end {
    if bytes[offset] != 0xff {
      return None;
    }
    while offset < end && bytes[offset] == 0xff {
      offset += 1;
    }
    if offset >= end {
      return None;
    }
    let marker = bytes[offset];
    offset += 1;
    // 長さの無いマーカー（FF 00・TEM・RST0〜7・SOI）
    if marker == 0x00 || marker == 0x01 || (0xd0..=0xd8).contains(&marker) {
      continue;
    }
    // EOI・SOS: SOF より前に画像が終わる・スキャンが始まる
    if marker == 0xd9 || marker == 0xda || offset + 2 > end {
      return None;
    }
    let length = usize::from(u16::from_be_bytes([bytes[offset], bytes[offset + 1]]));
    if length < 2 || offset + length > end {
      return None;
    }
    // SOF は C0〜CF のうち DHT（C4）・JPG（C8）・DAC（CC）以外。受けるのは SOF0〜SOF2 だけ
    if (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
      if !(0xc0..=0xc2).contains(&marker) || length < 8 {
        return None;
      }
      let components = bytes[offset + 7];
      if length != 8 + usize::from(components) * 3 {
        return None;
      }
      return Some(JpegFrame {
        precision: bytes[offset + 2],
        height: u32::from(u16::from_be_bytes([bytes[offset + 3], bytes[offset + 4]])),
        width: u32::from(u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]])),
        components,
      });
    }
    offset += length;
  }
  None
}

/// JPEG のファイルの最初の SOF（{@link parse_jpeg_frame}。先頭の 128KiB だけ読む）。
pub fn jpeg_frame(path: &Path) -> Option<JpegFrame> {
  let mut bytes = Vec::new();
  std::fs::File::open(path)
    .ok()?
    .take(JPEG_HEADER_BYTES)
    .read_to_end(&mut bytes)
    .ok()?;
  parse_jpeg_frame(&bytes)
}

/// キャッシュの作業コピーの寸法（PNG は IHDR、JPEG は 8bit・3 成分の SOF）。読めなければ None。
fn work_copy_size(cached: &CachedWorkingCopy) -> Option<(u32, u32)> {
  match cached.format {
    WorkCopyFormat::Png => png_size(&cached.file),
    WorkCopyFormat::Jpeg => jpeg_frame(&cached.file)
      .filter(JpegFrame::is_rgb8)
      .map(|frame| (frame.width, frame.height)),
  }
}

/// PNG の IHDR の幅・高さ（PNG でない・0 なら None）。
pub fn png_size(path: &Path) -> Option<(u32, u32)> {
  let mut header = [0u8; 24];
  std::fs::File::open(path).ok()?.read_exact(&mut header).ok()?;
  if header[..8] != [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a] || &header[12..16] != b"IHDR" {
    return None;
  }
  let width = u32::from_be_bytes([header[16], header[17], header[18], header[19]]);
  let height = u32::from_be_bytes([header[20], header[21], header[22], header[23]]);
  (width > 0 && height > 0).then_some((width, height))
}

// ---------------------------------------------------------------------------

#[cfg(test)]
#[path = "develop_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "develop_local_raster_tests.rs"]
mod local_raster_tests;

// Tool metadata also contains private paths and capture metadata. Only these finite timings may enter logs.
fn raw_stage_timings(meta: &Value) -> Vec<(&'static str, f64)> {
  [
    ("decodeRender", "decode"),
    ("lens", "lens"),
    ("whiteBalanceTableCheck", "whiteBalance"),
    ("color", "color"),
    ("lanczos4", "downsample"),
    ("encode", "encode"),
  ]
  .into_iter()
  .filter_map(|(key, stage)| {
    let elapsed = meta.get("timingMs")?.get(key)?.as_f64()?;
    (elapsed.is_finite() && elapsed >= 0.0).then_some((stage, elapsed))
  })
  .collect()
}
