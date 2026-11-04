//! 端末への保存（編集面の host の `saveFile` と「オリジナル」の書き出し。spec `niho-camera-app.md`「接続口 PhotoLibrary」）。
//!
//! - `camera_save_file`: 画面が描いたファイル（長辺 2048px などの JPEG・背景除去の PNG・XMP）を、保存ダイアログで選んだ場所へ書く。
//!   バイト列は raw IPC の body、名前は `x-niho-file-name`（URL エンコード）で受ける。名前はパスの区切り・制御文字を含まず、拡張子は
//!   jpg / jpeg / png / xmp だけ、大きさは 256MiB まで。
//! - `camera_export_original`: 開いた写真のファイルそのものを、保存ダイアログで選んだ場所へ写す（バイト列を画面へ運ばない）。
//!
//! どちらも開いている写真の元ファイルには書かない（spec 決まりごと 9）。既存のファイルへの上書きは保存ダイアログの確かめに任せ、
//! 書くときは同じフォルダの一時ファイルから置き換える（書きかけのファイルを残さない）。パスは画面へ渡さない（名前だけ返す）。

use crate::dialog;
use crate::error::{invalid_request, parse_request, run_blocking, CameraError};
use crate::photos::{check_photo_id, photos, CameraPhotos};
use niho_desktop_photo::common::{code, new_opaque_id, PageError};
use niho_desktop_photo::library::LISTED_PHOTO_NOT_FOUND_MESSAGE;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

/// `camera_save_file` で受けるバイト列の上限（原寸の PNG でも収まる大きさ）。
pub const MAX_SAVE_FILE_BYTES: usize = 256 * 1024 * 1024;
/// 保存するファイルの名前の添え書き（URL エンコード）。
pub const FILE_NAME_HEADER: &str = "x-niho-file-name";
/// macOS のファイル名の上限（UTF-8 のバイト数）。
const MAX_FILE_NAME_BYTES: usize = 255;

const ORIGINAL_OVERWRITE_MESSAGE: &str = "元の写真には上書きできません。別の名前で保存してください。";
const WRITE_FAILED_MESSAGE: &str = "保存できませんでした。保存先を確かめてください。";

/// 保存できる種類（拡張子 → 保存ダイアログの種類の名前と拡張子）。
fn save_kind(extension: &str) -> Option<(&'static str, &'static [&'static str])> {
  match extension {
    "jpg" | "jpeg" => Some(("JPEG", &["jpg", "jpeg"])),
    "png" => Some(("PNG", &["png"])),
    "xmp" => Some(("XMP", &["xmp"])),
    _ => None,
  }
}

pub(crate) fn extension_of(name: &str) -> Option<String> {
  Path::new(name)
    .extension()
    .and_then(|extension| extension.to_str())
    .map(str::to_lowercase)
}

/// `%XX` の URL エンコードを戻す（UTF-8 でなければ None）。
pub fn percent_decode(value: &str) -> Option<String> {
  let bytes = value.as_bytes();
  let mut decoded = Vec::with_capacity(bytes.len());
  let mut index = 0;
  while index < bytes.len() {
    if bytes[index] == b'%' {
      let hex = std::str::from_utf8(bytes.get(index + 1..index + 3)?).ok()?;
      decoded.push(u8::from_str_radix(hex, 16).ok()?);
      index += 3;
    } else {
      decoded.push(bytes[index]);
      index += 1;
    }
  }
  String::from_utf8(decoded).ok()
}

/// 保存ダイアログの既定の名前として使えるか（パスの区切り・制御文字・先頭の `.` を含まず、255 バイトまで）。
pub(crate) fn is_plain_file_name(name: &str) -> bool {
  !name.is_empty()
    && name.len() <= MAX_FILE_NAME_BYTES
    && name.trim() == name
    && !name.starts_with('.')
    && !name
      .chars()
      .any(|ch| ch == '/' || ch == '\\' || ch == ':' || ch.is_control())
}

/// `camera_save_file` の名前（添え書きを戻して確かめる）と、その種類。名前・種類が使えなければ `invalidRequest`。
pub fn save_file_name(header: Option<&str>) -> Result<(String, String), CameraError> {
  let name = header.and_then(percent_decode).ok_or_else(invalid_request)?;
  let extension = extension_of(&name).ok_or_else(invalid_request)?;
  if !is_plain_file_name(&name) || save_kind(&extension).is_none() {
    return Err(invalid_request());
  }
  Ok((name, extension))
}

/// 保存ダイアログが返したパスの拡張子を、その種類の拡張子にそろえる（消されたら足す）。
pub fn with_extension_of_kind(path: PathBuf, allowed: &[&str], extension: &str) -> PathBuf {
  let matches = extension_of(&path.to_string_lossy()).is_some_and(|found| allowed.contains(&found.as_str()));
  if matches {
    return path;
  }
  let mut name = path.file_name().map(|name| name.to_os_string()).unwrap_or_default();
  name.push(format!(".{extension}"));
  path.with_file_name(name)
}

/// 開いている写真の元ファイルへは書かない。
pub(crate) fn refuse_open_original(photos: &CameraPhotos, destination: &Path) -> Result<(), CameraError> {
  if photos.is_open_original(destination) {
    Err(CameraError::new(code::EXPORT_FAILED, ORIGINAL_OVERWRITE_MESSAGE))
  } else {
    Ok(())
  }
}

/// 同じフォルダの一時ファイルに書いてから置き換える（書きかけを残さない）。
pub fn write_replacing(
  destination: &Path,
  write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
) -> Result<(), CameraError> {
  write_replacing_guarded(destination, write, |temporary, destination| {
    std::fs::rename(temporary, destination)
  })
}

pub(crate) fn write_replacing_guarded(
  destination: &Path,
  write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
  commit: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), CameraError> {
  let failed = || CameraError::new(code::EXPORT_FAILED, WRITE_FAILED_MESSAGE);
  let folder = destination
    .parent()
    .filter(|folder| folder.is_dir())
    .ok_or_else(failed)?;
  let temporary = folder.join(format!(".{}.niho-camera.tmp", new_opaque_id("save")));
  let result = (|| {
    let mut file = std::fs::OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(&temporary)?;
    write(&mut file)?;
    file.sync_all()?;
    commit(&temporary, destination)?;
    std::fs::File::open(folder)?.sync_all()
  })();
  if result.is_err() {
    let _ = std::fs::remove_file(&temporary);
  }
  result.map_err(|_| failed())
}

pub(crate) fn saved_name(destination: &Path) -> String {
  destination
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_default()
}

/// 画面が描いたファイルを保存ダイアログで選んだ場所へ書く（`{ result: "saved" | "cancelled" }`）。
#[tauri::command]
pub async fn camera_save_file(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<Value, CameraError> {
  let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
    return Err(invalid_request());
  };
  if body.is_empty() || body.len() > MAX_SAVE_FILE_BYTES {
    return Err(invalid_request());
  }
  let header = request
    .headers()
    .get(FILE_NAME_HEADER)
    .and_then(|value| value.to_str().ok());
  let (name, extension) = save_file_name(header)?;
  let bytes = body.clone();
  let photos = photos(&app)?;
  let (kind, allowed) = save_kind(&extension).ok_or_else(invalid_request)?;
  let Some(destination) = dialog::save_file("保存", &name, (kind, allowed)).await? else {
    return Ok(json!({ "result": "cancelled" }));
  };
  let destination = with_extension_of_kind(destination, allowed, &extension);
  refuse_open_original(&photos, &destination)?;
  run_blocking(move || {
    write_replacing(&destination, |file| file.write_all(&bytes))?;
    Ok(json!({ "result": "saved", "fileName": saved_name(&destination) }))
  })
  .await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportOriginalRequest {
  pub photo_id: String,
  #[serde(default)]
  pub suggested_file_name: Option<String>,
}

/// 「オリジナル」の既定の名前（画面の案が使えなければ元の名前。拡張子は元の写真と同じ）。
pub fn original_file_name(suggested: Option<&str>, original: &str) -> String {
  let extension = extension_of(original).unwrap_or_default();
  suggested
    .filter(|name| is_plain_file_name(name) && extension_of(name).as_deref() == Some(extension.as_str()))
    .unwrap_or(original)
    .to_string()
}

/// 開いた写真のファイルそのものを保存ダイアログで選んだ場所へ写す（`{ saved, fileName? }`。閉じたら `{ saved: false }`）。
#[tauri::command]
pub async fn camera_export_original(app: tauri::AppHandle, request: Option<Value>) -> Result<Value, CameraError> {
  let request: ExportOriginalRequest = parse_request(request)?;
  check_photo_id(&request.photo_id)?;
  if request
    .suggested_file_name
    .as_ref()
    .is_some_and(|name| name.len() > 1024)
  {
    return Err(invalid_request());
  }
  let photos = photos(&app)?;
  let photo = photos
    .get(&request.photo_id)
    .ok_or_else(|| CameraError::from(PageError::new(code::NOT_FOUND, LISTED_PHOTO_NOT_FOUND_MESSAGE)))?;
  let extension = extension_of(&photo.file_name).ok_or_else(invalid_request)?;
  let file_name = original_file_name(request.suggested_file_name.as_deref(), &photo.file_name);
  let allowed = [extension.as_str()];
  let Some(destination) = dialog::save_file("オリジナルを書き出す", &file_name, ("写真", &allowed)).await?
  else {
    return Ok(json!({ "saved": false }));
  };
  let destination = with_extension_of_kind(destination, &allowed, &extension);
  refuse_open_original(&photos, &destination)?;
  run_blocking(move || {
    let mut source = std::fs::File::open(&photo.path)
      .map_err(|_| CameraError::new(code::NOT_FOUND, "写真を読めませんでした。ファイルを確かめてください。"))?;
    write_replacing(&destination, |file| std::io::copy(&mut source, file).map(|_| ()))?;
    Ok(json!({ "saved": true, "fileName": saved_name(&destination) }))
  })
  .await
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::photos::{edits_limits, EDITS_DIR_NAME};
  use niho_desktop_photo::saved_settings::SavedSettingsStore;

  fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("niho-camera-save-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  #[test]
  fn the_file_name_header_is_decoded_and_only_plain_names_of_the_saved_kinds_pass() {
    assert_eq!(
      save_file_name(Some("%E5%A4%95%E6%96%B9%20P1.jpg")).unwrap(),
      ("夕方 P1.jpg".to_string(), "jpg".to_string())
    );
    assert_eq!(save_file_name(Some("P1.PNG")).unwrap().1, "png");
    assert_eq!(save_file_name(Some("preset.xmp")).unwrap().1, "xmp");
    for bad in [
      None,
      Some(""),
      Some("P1"),
      Some("P1.RW2"),
      Some("P1.heic"),
      Some("run.sh"),
      Some("..%2F..%2Fetc%2Fpasswd.jpg"),
      Some("a%2Fb.jpg"),
      Some("a%5Cb.jpg"),
      Some(".hidden.jpg"),
      Some("%0Aline.jpg"),
      Some("%E5%A4.jpg"),
      Some("%ZZ.jpg"),
    ] {
      assert_eq!(
        save_file_name(bad).err().map(|err| err.code),
        Some(code::INVALID_REQUEST.to_string()),
        "{bad:?}"
      );
    }
    let long = format!("{}.jpg", "a".repeat(252));
    assert!(save_file_name(Some(&long)).is_err());
  }

  #[test]
  fn the_saved_path_keeps_the_kind_extension() {
    assert_eq!(
      with_extension_of_kind(PathBuf::from("/x/P1.jpeg"), &["jpg", "jpeg"], "jpg"),
      PathBuf::from("/x/P1.jpeg")
    );
    assert_eq!(
      with_extension_of_kind(PathBuf::from("/x/P1"), &["jpg", "jpeg"], "jpg"),
      PathBuf::from("/x/P1.jpg")
    );
    assert_eq!(
      with_extension_of_kind(PathBuf::from("/x/P1.png"), &["xmp"], "xmp"),
      PathBuf::from("/x/P1.png.xmp")
    );
    assert_eq!(original_file_name(Some("コピー.RW2"), "P1.RW2"), "コピー.RW2");
    assert_eq!(original_file_name(Some("a/b.RW2"), "P1.RW2"), "P1.RW2");
    assert_eq!(original_file_name(Some("P1.jpg"), "P1.RW2"), "P1.RW2");
    assert_eq!(original_file_name(None, "P1.RW2"), "P1.RW2");
  }

  #[test]
  fn writing_replaces_the_destination_without_leaving_a_temporary_file() {
    let dir = temp_dir("write");
    let destination = dir.join("P1.jpg");
    std::fs::write(&destination, b"old").unwrap();
    write_replacing(&destination, |file| file.write_all(b"new")).unwrap();
    assert_eq!(std::fs::read(&destination).unwrap(), b"new");
    let failed = write_replacing(&destination, |_| Err(std::io::Error::other("boom")));
    assert_eq!(failed.unwrap_err().code, code::EXPORT_FAILED);
    assert_eq!(std::fs::read(&destination).unwrap(), b"new");
    let names: Vec<String> = std::fs::read_dir(&dir)
      .unwrap()
      .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
      .collect();
    assert_eq!(names, vec!["P1.jpg".to_string()], "一時ファイルを残さない");
    assert!(write_replacing(&dir.join("missing").join("P1.jpg"), |_| Ok(())).is_err());
    let late_fence = write_replacing_guarded(
      &destination,
      |file| file.write_all(b"must-not-commit"),
      |_, _| Err(std::io::Error::other("identity changed")),
    );
    assert!(late_fence.is_err());
    assert_eq!(std::fs::read(&destination).unwrap(), b"new");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn an_open_original_is_never_a_save_destination() {
    let dir = temp_dir("original");
    let photos = CameraPhotos::new(Some(SavedSettingsStore::new(
      dir.join("app-data").join(EDITS_DIR_NAME),
      edits_limits(),
    )));
    let original = dir.join("DSC02072.JPG");
    std::fs::write(&original, b"\xff\xd8\xffjpeg").unwrap();
    photos.open("entry-1", &original).unwrap();
    // 大文字小文字の違う名前も同じファイル（APFS の既定は大文字小文字を区別しない）
    let same_file = if dir.join("dsc02072.jpg").exists() {
      dir.join("dsc02072.jpg")
    } else {
      original.clone()
    };
    assert_eq!(
      refuse_open_original(&photos, &same_file).unwrap_err().code,
      code::EXPORT_FAILED
    );
    std::os::unix::fs::symlink(&original, dir.join("link.jpg")).unwrap();
    assert!(refuse_open_original(&photos, &dir.join("link.jpg")).is_err());
    assert!(refuse_open_original(&photos, &dir.join("DSC02072-export.jpg")).is_ok());
    std::fs::write(dir.join("other.jpg"), b"other").unwrap();
    assert!(refuse_open_original(&photos, &dir.join("other.jpg")).is_ok());
    let _ = std::fs::remove_dir_all(&dir);
  }
}
