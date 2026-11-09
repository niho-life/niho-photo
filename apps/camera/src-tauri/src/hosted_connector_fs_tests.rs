//! 登録したフォルダの下の read-only のファイル系の試験（実際の一時フォルダ・合成の bytes）。

use super::*;
use std::fs;
use std::io::Write;
use std::os::unix::fs::symlink;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

struct Dir(PathBuf);

impl Dir {
  fn new(tag: &str) -> Self {
    let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let path = std::env::temp_dir().join(format!("niho-hosted-fs-{tag}-{}-{unique}", std::process::id()));
    fs::create_dir_all(&path).unwrap();
    Self(fs::canonicalize(&path).unwrap())
  }
  fn path(&self) -> &Path {
    &self.0
  }
  fn write(&self, relative: &str, bytes: &[u8]) {
    let path = self.0.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::File::create(path).unwrap().write_all(bytes).unwrap();
  }
}

impl Drop for Dir {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.0);
  }
}

fn expected(entry: &EntryInfo) -> ExpectedIdentity {
  ExpectedIdentity {
    size_bytes: entry.size_bytes,
    file_id: entry.file_id.clone(),
    change_token: entry.change_token.clone(),
  }
}

fn sha256_hex(bytes: &[u8]) -> String {
  format!("{:x}", Sha256::digest(bytes))
}

#[test]
fn lists_stats_opens_and_hashes_regular_files_below_the_root() {
  let dir = Dir::new("list");
  dir.write("a.jpg", b"synthetic jpeg one");
  dir.write("trip/b.rw2", b"synthetic raw two");
  let root = register("root-1".into(), dir.path()).unwrap();
  assert!(root_available(&root));
  assert_eq!(root.name, dir.path().file_name().unwrap().to_string_lossy());

  let mut top = list(&root, "").unwrap();
  top.sort_by(|a, b| a.name.cmp(&b.name));
  assert_eq!(
    top
      .iter()
      .map(|entry| (entry.name.as_str(), entry.kind))
      .collect::<Vec<_>>(),
    vec![("a.jpg", EntryKind::File), ("trip", EntryKind::Directory)]
  );
  let nested = list(&root, "trip").unwrap();
  assert_eq!(nested.len(), 1);
  assert_eq!(nested[0].size_bytes, 17);

  let entry = stat(&root, "trip/b.rw2").unwrap().unwrap();
  assert_eq!(entry, nested[0]);
  let (mut file, opened) = open(&root, "trip/b.rw2").unwrap();
  assert_eq!(opened, entry);
  let mut bytes = Vec::new();
  file.read_to_end(&mut bytes).unwrap();
  assert_eq!(bytes, b"synthetic raw two");

  assert_eq!(
    hash(&root, "trip/b.rw2", &expected(&entry), &|| false).unwrap(),
    HashOutcome::Hashed {
      sha256: sha256_hex(b"synthetic raw two"),
      bytes: 17
    }
  );
  assert_eq!(stat(&root, "trip/missing.jpg").unwrap(), None);
  assert_eq!(stat(&root, "gone/missing.jpg").unwrap(), None);
}

#[test]
fn refuses_dot_dot_empty_components_symlinks_and_non_files() {
  let dir = Dir::new("refuse");
  let outside = Dir::new("outside");
  outside.write("secret.jpg", b"outside the root");
  dir.write("a.jpg", b"inside");
  symlink(outside.path(), dir.path().join("link-dir")).unwrap();
  symlink(outside.path().join("secret.jpg"), dir.path().join("link.jpg")).unwrap();
  let root = register("root-1".into(), dir.path()).unwrap();

  for path in ["../a.jpg", "a.jpg/..", "/a.jpg", "trip//a.jpg", "./a.jpg", ""] {
    assert_eq!(open(&root, path).err(), Some(FsError::Refused), "{path}");
  }
  assert_eq!(open(&root, "link.jpg").err(), Some(FsError::Refused));
  assert_eq!(open(&root, "link-dir/secret.jpg").err(), Some(FsError::Refused));
  assert_eq!(list(&root, "link-dir").err(), Some(FsError::Refused));
  assert_eq!(
    stat(&root, "link.jpg").unwrap(),
    None,
    "a symlink is not a regular file"
  );
  assert!(open(&root, "a.jpg").is_ok());
  let listed = list(&root, "").unwrap();
  assert!(listed
    .iter()
    .any(|entry| entry.name == "link.jpg" && entry.kind == EntryKind::Symlink));
  // directory は開かない
  fs::create_dir(dir.path().join("sub")).unwrap();
  assert_eq!(open(&root, "sub").err(), Some(FsError::Refused));
}

#[test]
fn a_root_replaced_by_a_symlink_or_another_directory_is_unavailable() {
  let parent = Dir::new("swap");
  let outside = Dir::new("swap-outside");
  outside.write("secret.jpg", b"outside the root");
  let folder = parent.path().join("photos");
  fs::create_dir(&folder).unwrap();
  fs::write(folder.join("a.jpg"), b"inside").unwrap();
  let root = register("root-1".into(), &folder).unwrap();
  assert!(root_available(&root));

  // 同じ名前の別の directory
  fs::rename(&folder, parent.path().join("photos-old")).unwrap();
  fs::create_dir(&folder).unwrap();
  fs::write(folder.join("a.jpg"), b"another directory").unwrap();
  assert!(!root_available(&root));
  assert_eq!(list(&root, "").err(), Some(FsError::Unavailable));
  assert_eq!(open(&root, "a.jpg").err(), Some(FsError::Unavailable));

  // root 自体が symlink になった
  fs::remove_dir_all(&folder).unwrap();
  symlink(outside.path(), &folder).unwrap();
  assert!(!root_available(&root));
  assert_eq!(open(&root, "secret.jpg").err(), Some(FsError::Unavailable));

  // 元の実体が戻れば読める（未 mount → 再 mount と同じ）
  fs::remove_file(&folder).unwrap();
  fs::rename(parent.path().join("photos-old"), &folder).unwrap();
  assert!(root_available(&root));
  assert!(open(&root, "a.jpg").is_ok());
}

#[test]
fn a_hash_is_discarded_when_the_file_changed_or_was_replaced() {
  let dir = Dir::new("hash");
  dir.write("a.jpg", b"synthetic bytes one");
  let root = register("root-1".into(), dir.path()).unwrap();
  let entry = stat(&root, "a.jpg").unwrap().unwrap();

  // 大きさの違う古い同一性
  let mut stale = expected(&entry);
  stale.size_bytes += 1;
  assert_eq!(hash(&root, "a.jpg", &stale, &|| false).unwrap(), HashOutcome::Changed);

  // 同じ名前で差し替え（inode が変わる）
  let identity = expected(&entry);
  fs::rename(dir.path().join("a.jpg"), dir.path().join("old.jpg")).unwrap();
  dir.write("a.jpg", b"synthetic bytes one");
  assert_eq!(
    hash(&root, "a.jpg", &identity, &|| false).unwrap(),
    HashOutcome::Changed
  );

  // 消えた
  fs::remove_file(dir.path().join("a.jpg")).unwrap();
  assert_eq!(
    hash(&root, "a.jpg", &identity, &|| false).unwrap(),
    HashOutcome::Changed
  );

  // 取消
  let old = stat(&root, "old.jpg").unwrap().unwrap();
  assert_eq!(
    hash(&root, "old.jpg", &expected(&old), &|| true).err(),
    Some(FsError::Io)
  );
}

#[test]
fn identity_has_nanosecond_change_tokens_and_device_inode_ids() {
  let dir = Dir::new("identity");
  dir.write("a.jpg", b"one");
  let root = register("root-1".into(), dir.path()).unwrap();
  let entry = stat(&root, "a.jpg").unwrap().unwrap();
  let meta = fs::symlink_metadata(dir.path().join("a.jpg")).unwrap();
  use std::os::unix::fs::MetadataExt;
  assert_eq!(entry.file_id, format!("{}:{}", meta.dev(), meta.ino()));
  let mtime_ns = i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec());
  let ctime_ns = i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec());
  assert_eq!(entry.change_token, format!("{mtime_ns}:{ctime_ns}"));
  assert_eq!(
    serde_json::to_value(&entry).unwrap()["kind"],
    serde_json::json!("file"),
    "the connector reads camelCase kinds"
  );
}
