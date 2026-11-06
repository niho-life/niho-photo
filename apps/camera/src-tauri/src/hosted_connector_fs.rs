//! 常設 Mac の接続用ソフト（Epic #240 / B03 #244）が読む、登録したフォルダの下の read-only のファイル系。
//!
//! - 登録したフォルダは real path と device・inode に固定する（`RegisteredRoot`）。開くたびに `O_NOFOLLOW` で開き、
//!   device・inode が登録時と違えば（差し替え・symlink への置き換え・未 mount）「届かない」として扱い、中を読まない。
//! - その下は directory の descriptor から 1 要素ずつ `openat(O_NOFOLLOW)` で辿る。`..`・空の要素・symlink を拒み、
//!   root の外へ出ない。通常ファイル以外は開かない。書き込み・command の実行はしない。
//! - path は native の外へ出さない。画面（接続用ソフトの窓）が見るのは root の ID と root からの相対 path だけ。
//! - hash は native で読む（`hash`）。開いた時と読み終えた時の大きさ・device と inode・ns 精度の mtime と ctime が
//!   どれか違えば、その hash を捨てる（`HashOutcome::Changed`）。

use std::ffi::{CStr, CString};
use std::fs::File;
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// 登録したフォルダ。`path` は native の外へ出さない。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredRoot {
  pub id: String,
  /// 登録画面に出すフォルダの名前（最後の要素）
  pub name: String,
  pub path: PathBuf,
  pub dev: u64,
  pub ino: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsError {
  /// 登録した実体に届かない（未 mount・消えた・差し替えられた・symlink になった）
  Unavailable,
  /// 相対 path の要素が無い
  NotFound,
  /// 形の不正な path・symlink・通常ファイルでないもの（root の外へは辿らない）
  Refused,
  Io,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
  File,
  Directory,
  Symlink,
  Other,
}

/// 接続用ソフトの `DirectoryEntry`（`packages/photo-hosted-connector/src/ports.ts`）と同じ形。
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EntryInfo {
  pub name: String,
  pub kind: EntryKind,
  pub size_bytes: u64,
  pub mtime_ms: f64,
  /// device と inode（同じ名前で差し替えたファイルを見分ける）
  pub file_id: String,
  /// ns 精度の mtime と ctime（中身が変わったかもしれないときに変わる）
  pub change_token: String,
}

/// 索引が覚えているファイルの同一性。hash の前後でこれと違えば、その hash を捨てる。
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedIdentity {
  pub size_bytes: u64,
  pub file_id: String,
  pub change_token: String,
}

impl ExpectedIdentity {
  fn matches(&self, info: &EntryInfo) -> bool {
    info.kind == EntryKind::File
      && info.size_bytes == self.size_bytes
      && info.file_id == self.file_id
      && info.change_token == self.change_token
  }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum HashOutcome {
  Hashed {
    sha256: String,
    bytes: u64,
  },
  /// 開いた時点で同一性が違った・読んでいる間に変わった・差し替えられた
  Changed,
}

/// 登録時の実体を作る。real path にし、directory であることを確かめて device・inode を覚える。
pub fn register(id: String, path: &std::path::Path) -> Result<RegisteredRoot, FsError> {
  let real = std::fs::canonicalize(path).map_err(|_| FsError::Unavailable)?;
  let fd = open_path_dir(&real)?;
  let st = fstat(&fd).map_err(|_| FsError::Io)?;
  let name = real
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_else(|| real.to_string_lossy().into_owned());
  Ok(RegisteredRoot {
    id,
    name,
    path: real,
    dev: dev_of(&st),
    ino: st.st_ino,
  })
}

/// 今、登録した実体に届くか。
pub fn root_available(root: &RegisteredRoot) -> bool {
  open_root(root).is_ok()
}

/// `relative_dir`（"/" 区切り。"" は root）の中身。名前が UTF-8 でない項目と `.`・`..` は返さない。
pub fn list(root: &RegisteredRoot, relative_dir: &str) -> Result<Vec<EntryInfo>, FsError> {
  let dir = open_dir(root, &components(relative_dir)?)?;
  let mut out = Vec::new();
  for name in read_names(&dir)? {
    let Ok(c_name) = CString::new(name.as_bytes()) else {
      continue;
    };
    // 一覧と stat の間に消えた項目は飛ばす（次の走査で missing になる）
    if let Ok(st) = stat_at(&dir, &c_name) {
      out.push(info(name, &st));
    }
  }
  Ok(out)
}

/// 通常ファイルの今の metadata。消えた・通常ファイルでなくなったら None。
pub fn stat(root: &RegisteredRoot, relative_path: &str) -> Result<Option<EntryInfo>, FsError> {
  let (parents, name) = split_file(relative_path)?;
  let dir = match open_dir(root, &parents) {
    Ok(dir) => dir,
    Err(FsError::NotFound) => return Ok(None),
    Err(error) => return Err(error),
  };
  match stat_at(&dir, &name) {
    Ok(st) => {
      let entry = info(utf8(&name)?, &st);
      Ok((entry.kind == EntryKind::File).then_some(entry))
    }
    Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
    Err(_) => Err(FsError::Io),
  }
}

/// 通常ファイルを read-only で開く。symlink・通常ファイルでないもの・root の外は拒む。
pub fn open(root: &RegisteredRoot, relative_path: &str) -> Result<(File, EntryInfo), FsError> {
  let (parents, name) = split_file(relative_path)?;
  let dir = open_dir(root, &parents)?;
  // FIFO などで止まらないよう O_NONBLOCK で開き、通常ファイルだけを残す（通常ファイルには効かない）
  let fd = open_at(&dir, &name, libc::O_RDONLY | libc::O_NONBLOCK).map_err(classify)?;
  let st = fstat(&fd).map_err(|_| FsError::Io)?;
  let entry = info(utf8(&name)?, &st);
  if entry.kind != EntryKind::File {
    return Err(FsError::Refused);
  }
  Ok((File::from(fd), entry))
}

/// 開いたファイルの今の metadata（読み終えた後の確かめ）。
pub fn reopened_info(file: &File, name: &str) -> Result<EntryInfo, FsError> {
  let st = fstat(file).map_err(|_| FsError::Io)?;
  Ok(info(name.to_string(), &st))
}

/// ファイル全体の SHA-256。開いた時・読み終えた時（開いた fd と、名前から辿り直した先）の同一性が `expected` と
/// 同じときだけ hash を返す。`cancelled` が true になったら途中でやめる（`Io`）。
pub fn hash(
  root: &RegisteredRoot,
  relative_path: &str,
  expected: &ExpectedIdentity,
  cancelled: &dyn Fn() -> bool,
) -> Result<HashOutcome, FsError> {
  let (mut file, before) = match open(root, relative_path) {
    Ok(opened) => opened,
    Err(FsError::NotFound | FsError::Refused) => return Ok(HashOutcome::Changed),
    Err(error) => return Err(error),
  };
  if !expected.matches(&before) {
    return Ok(HashOutcome::Changed);
  }
  let mut hasher = Sha256::new();
  let mut buffer = vec![0u8; 1 << 20];
  let mut bytes = 0u64;
  loop {
    if cancelled() {
      return Err(FsError::Io);
    }
    let read = match file.read(&mut buffer) {
      Ok(0) => break,
      Ok(read) => read,
      Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
      Err(_) => return Err(FsError::Io),
    };
    hasher.update(&buffer[..read]);
    bytes += read as u64;
  }
  let after_open = reopened_info(&file, &before.name)?;
  let after_path = stat(root, relative_path)?;
  if bytes != expected.size_bytes
    || !expected.matches(&after_open)
    || !after_path.as_ref().is_some_and(|entry| expected.matches(entry))
  {
    return Ok(HashOutcome::Changed);
  }
  Ok(HashOutcome::Hashed {
    sha256: format!("{:x}", hasher.finalize()),
    bytes,
  })
}

// ---------------------------------------------------------------------------
// descriptor 相対の操作

fn components(relative: &str) -> Result<Vec<CString>, FsError> {
  if relative.is_empty() {
    return Ok(Vec::new());
  }
  relative
    .split('/')
    .map(|part| {
      if part.is_empty() || part == "." || part == ".." {
        return Err(FsError::Refused);
      }
      CString::new(part).map_err(|_| FsError::Refused)
    })
    .collect()
}

fn split_file(relative_path: &str) -> Result<(Vec<CString>, CString), FsError> {
  let mut parts = components(relative_path)?;
  let name = parts.pop().ok_or(FsError::Refused)?;
  Ok((parts, name))
}

fn utf8(name: &CStr) -> Result<String, FsError> {
  name.to_str().map(str::to_string).map_err(|_| FsError::Refused)
}

fn classify(error: io::Error) -> FsError {
  match error.raw_os_error() {
    Some(libc::ENOENT) => FsError::NotFound,
    // symlink（O_NOFOLLOW）・directory でない要素
    Some(libc::ELOOP | libc::ENOTDIR | libc::EISDIR) => FsError::Refused,
    _ => FsError::Io,
  }
}

fn open_path_dir(path: &std::path::Path) -> Result<OwnedFd, FsError> {
  let c_path = CString::new(path.as_os_str().as_bytes()).map_err(|_| FsError::Unavailable)?;
  // SAFETY: c_path は NUL 終端。返った fd は下で一度だけ OwnedFd に渡す。
  let fd = unsafe {
    libc::open(
      c_path.as_ptr(),
      libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
  };
  if fd < 0 {
    return Err(FsError::Unavailable);
  }
  // SAFETY: open が返した新しい有効な fd の所有権。
  Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn open_root(root: &RegisteredRoot) -> Result<OwnedFd, FsError> {
  let fd = open_path_dir(&root.path)?;
  let st = fstat(&fd).map_err(|_| FsError::Unavailable)?;
  // 登録した実体でなければ（差し替え・別の volume が同じ場所に mount された）読まない
  if dev_of(&st) != root.dev || st.st_ino != root.ino {
    return Err(FsError::Unavailable);
  }
  Ok(fd)
}

fn open_dir(root: &RegisteredRoot, parts: &[CString]) -> Result<OwnedFd, FsError> {
  let mut dir = open_root(root)?;
  for part in parts {
    dir = open_at(&dir, part, libc::O_RDONLY | libc::O_DIRECTORY).map_err(classify)?;
  }
  Ok(dir)
}

fn open_at(dir: &OwnedFd, name: &CStr, flags: libc::c_int) -> io::Result<OwnedFd> {
  // SAFETY: dir は開いている directory の fd、name は NUL 終端。返った fd は下で一度だけ OwnedFd に渡す。
  let fd = unsafe {
    libc::openat(
      dir.as_raw_fd(),
      name.as_ptr(),
      flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
  };
  if fd < 0 {
    return Err(io::Error::last_os_error());
  }
  // SAFETY: openat が返した新しい有効な fd の所有権。
  Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn stat_at(dir: &OwnedFd, name: &CStr) -> io::Result<libc::stat> {
  let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
  // SAFETY: dir は開いている directory の fd、name は NUL 終端、st は書き込み先。symlink は辿らない。
  let status = unsafe {
    libc::fstatat(
      dir.as_raw_fd(),
      name.as_ptr(),
      st.as_mut_ptr(),
      libc::AT_SYMLINK_NOFOLLOW,
    )
  };
  if status != 0 {
    return Err(io::Error::last_os_error());
  }
  // SAFETY: fstatat が成功したので st は初期化済み。
  Ok(unsafe { st.assume_init() })
}

fn fstat(fd: &impl AsRawFd) -> io::Result<libc::stat> {
  let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
  // SAFETY: fd は開いている fd、st は書き込み先。
  let status = unsafe { libc::fstat(fd.as_raw_fd(), st.as_mut_ptr()) };
  if status != 0 {
    return Err(io::Error::last_os_error());
  }
  // SAFETY: fstat が成功したので st は初期化済み。
  Ok(unsafe { st.assume_init() })
}

/// directory の項目の名前。fdopendir は渡した fd を持って closedir で閉じるので、複製を渡す。
fn read_names(dir: &OwnedFd) -> Result<Vec<String>, FsError> {
  let raw = dir.try_clone().map_err(|_| FsError::Io)?.into_raw_fd();
  // SAFETY: raw は複製した有効な directory の fd。成功すれば stream が持ち、closedir で閉じる。
  let stream = unsafe { libc::fdopendir(raw) };
  if stream.is_null() {
    // SAFETY: fdopendir が失敗したので raw はまだこちらの持ち物。
    unsafe { libc::close(raw) };
    return Err(FsError::Io);
  }
  let mut names = Vec::new();
  let result = loop {
    // SAFETY: errno を 0 にして、readdir の NULL が終わりか失敗かを見分ける（この thread の errno）。
    unsafe { *libc::__error() = 0 };
    // SAFETY: stream は開いている。返る項目は次の readdir / closedir まで有効。
    let entry = unsafe { libc::readdir(stream) };
    if entry.is_null() {
      let failed = io::Error::last_os_error().raw_os_error().unwrap_or(0) != 0;
      break if failed { Err(FsError::Io) } else { Ok(()) };
    }
    // SAFETY: entry は有効な dirent で、d_name は NUL 終端。
    let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
    if let Ok(name) = name.to_str() {
      if name != "." && name != ".." {
        names.push(name.to_string());
      }
    }
  };
  // SAFETY: stream はここで一度だけ閉じる（複製した fd も閉じる）。
  unsafe { libc::closedir(stream) };
  result.map(|()| names)
}

fn dev_of(st: &libc::stat) -> u64 {
  // macOS の dev_t は i32（std の MetadataExt::dev と同じ変換）
  st.st_dev as u64
}

fn info(name: String, st: &libc::stat) -> EntryInfo {
  let kind = match st.st_mode & libc::S_IFMT {
    libc::S_IFREG => EntryKind::File,
    libc::S_IFDIR => EntryKind::Directory,
    libc::S_IFLNK => EntryKind::Symlink,
    _ => EntryKind::Other,
  };
  let mtime_ns = i128::from(st.st_mtime) * 1_000_000_000 + i128::from(st.st_mtime_nsec);
  let ctime_ns = i128::from(st.st_ctime) * 1_000_000_000 + i128::from(st.st_ctime_nsec);
  EntryInfo {
    name,
    kind,
    size_bytes: u64::try_from(st.st_size).unwrap_or(0),
    mtime_ms: mtime_ns as f64 / 1_000_000.0,
    file_id: format!("{}:{}", dev_of(st), st.st_ino),
    change_token: format!("{mtime_ns}:{ctime_ns}"),
  }
}

#[cfg(test)]
#[path = "hosted_connector_fs_tests.rs"]
mod tests;
