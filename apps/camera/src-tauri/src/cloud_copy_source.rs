//! Native-only input for the future P03 authenticated staging transport. No IPC or network is enabled.
//! Never serialize this object: paths, open handles and bytes stay in native code.
#![allow(dead_code)]

use crate::photos::{CameraPhotos, OpenedPhoto};
use sha2::{Digest, Sha256};
use std::fs::{File, Metadata, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::PathBuf;

const MAX_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CopySourceError {
  Missing,
  Changed,
  TooLarge,
  Cancelled,
  Transfer,
}

#[derive(PartialEq, Eq)]
struct Identity {
  device: u64,
  inode: u64,
  size: u64,
  modified: (i64, i64),
  changed: (i64, i64),
}

impl Identity {
  fn of(meta: Metadata) -> Result<Self, CopySourceError> {
    if !meta.is_file() {
      return Err(CopySourceError::Missing);
    }
    if meta.len() > MAX_BYTES {
      return Err(CopySourceError::TooLarge);
    }
    Ok(Self {
      device: meta.dev(),
      inode: meta.ino(),
      size: meta.len(),
      modified: (meta.mtime(), meta.mtime_nsec()),
      changed: (meta.ctime(), meta.ctime_nsec()),
    })
  }
}

/// Held open across start/resume/complete. It grants no authority to upload; formal auth is separate.
pub(crate) struct CloudCopySource {
  path: PathBuf,
  file: File,
  identity: Identity,
  sha256: String,
}

impl CloudCopySource {
  pub(crate) fn capture(photos: &CameraPhotos, photo_id: &str) -> Result<Self, CopySourceError> {
    let photo = photos.get(photo_id).ok_or(CopySourceError::Missing)?;
    Self::open(&photo)
  }

  fn open(photo: &OpenedPhoto) -> Result<Self, CopySourceError> {
    // O_NONBLOCK avoids blocking on a substituted FIFO before regular-file validation.
    let file = OpenOptions::new()
      .read(true)
      .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
      .open(&photo.path)
      .map_err(|_| CopySourceError::Missing)?;
    let identity = Identity::of(file.metadata().map_err(|_| CopySourceError::Missing)?)?;
    if identity.size != photo.digest.size_bytes {
      return Err(CopySourceError::Changed);
    }
    let mut source = Self {
      path: photo.path.clone(),
      file,
      identity,
      sha256: photo.digest.key.clone(),
    };
    source.verify(|| false)?;
    Ok(source)
  }

  fn assert_identity(&self) -> Result<(), CopySourceError> {
    let handle = Identity::of(self.file.metadata().map_err(|_| CopySourceError::Missing)?)?;
    // symlink_metadata rejects a final-component symlink even if it targets the original inode.
    let path = Identity::of(std::fs::symlink_metadata(&self.path).map_err(|_| CopySourceError::Missing)?)?;
    if self.identity != handle || self.identity != path {
      return Err(CopySourceError::Changed);
    }
    Ok(())
  }

  /// Verify again before renew/complete. A changed file never becomes a new source during retry.
  pub(crate) fn verify(&mut self, cancelled: impl Fn() -> bool) -> Result<(), CopySourceError> {
    self.stream_to_staging(&mut std::io::sink(), cancelled)
  }

  /// Only a private staging destination is allowed. Caller may complete only after this succeeds;
  /// the server must independently hash all received bytes before immutable original commit.
  pub(crate) fn stream_to_staging(
    &mut self,
    destination: &mut impl Write,
    cancelled: impl Fn() -> bool,
  ) -> Result<(), CopySourceError> {
    self.assert_identity()?;
    self
      .file
      .seek(SeekFrom::Start(0))
      .map_err(|_| CopySourceError::Missing)?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
      if cancelled() {
        return Err(CopySourceError::Cancelled);
      }
      let read = self.file.read(&mut buffer).map_err(|_| CopySourceError::Missing)?;
      if read == 0 {
        break;
      }
      size += read as u64;
      if size > self.identity.size || size > MAX_BYTES {
        return Err(CopySourceError::Changed);
      }
      hasher.update(&buffer[..read]);
      destination
        .write_all(&buffer[..read])
        .map_err(|_| CopySourceError::Transfer)?;
    }
    if cancelled() {
      return Err(CopySourceError::Cancelled);
    }
    self.assert_identity()?;
    if size != self.identity.size || format!("{:x}", hasher.finalize()) != self.sha256 {
      return Err(CopySourceError::Changed);
    }
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use niho_desktop_photo::saved_settings::content_digest;
  use std::sync::atomic::{AtomicU64, Ordering};

  struct Fixture(PathBuf);
  impl Fixture {
    fn new() -> Self {
      static SEQUENCE: AtomicU64 = AtomicU64::new(0);
      let dir = std::env::temp_dir().join(format!(
        "niho-copy-source-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
      ));
      std::fs::create_dir(&dir).unwrap();
      Self(dir)
    }
    fn photo(&self) -> OpenedPhoto {
      let path = self.0.join("synthetic.png");
      std::fs::write(&path, b"synthetic original, never a real photo").unwrap();
      OpenedPhoto {
        entry_id: "entry".into(),
        file_name: "synthetic.png".into(),
        digest: content_digest(&path).unwrap(),
        path,
        modified_at_ms: None,
      }
    }
  }
  impl Drop for Fixture {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  #[test]
  fn copy_and_cancel_leave_the_original_and_allow_same_source_retry() {
    let fixture = Fixture::new();
    let photo = fixture.photo();
    let before = std::fs::read(&photo.path).unwrap();
    let mut source = CloudCopySource::open(&photo).unwrap();
    assert_eq!(
      source.stream_to_staging(&mut Vec::new(), || true),
      Err(CopySourceError::Cancelled)
    );
    let mut staging = Vec::new();
    source.stream_to_staging(&mut staging, || false).unwrap();
    assert_eq!(staging, before);
    assert_eq!(std::fs::read(&photo.path).unwrap(), before);
  }

  #[test]
  fn same_bytes_replacement_and_symlink_do_not_rebind_an_existing_transfer() {
    let fixture = Fixture::new();
    let photo = fixture.photo();
    let mut source = CloudCopySource::open(&photo).unwrap();
    std::fs::rename(&photo.path, fixture.0.join("old.png")).unwrap();
    std::fs::copy(fixture.0.join("old.png"), &photo.path).unwrap();
    assert_eq!(source.verify(|| false), Err(CopySourceError::Changed));
    std::fs::remove_file(&photo.path).unwrap();
    std::os::unix::fs::symlink(fixture.0.join("old.png"), &photo.path).unwrap();
    assert_eq!(source.verify(|| false), Err(CopySourceError::Missing));
    assert!(matches!(CloudCopySource::open(&photo), Err(CopySourceError::Missing)));
  }

  #[test]
  fn changed_bytes_and_failed_staging_are_not_success_or_source_deletion() {
    let fixture = Fixture::new();
    let photo = fixture.photo();
    let mut source = CloudCopySource::open(&photo).unwrap();
    struct Failed;
    impl Write for Failed {
      fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
        Err(std::io::Error::other("synthetic failure"))
      }
      fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
      }
    }
    assert_eq!(
      source.stream_to_staging(&mut Failed, || false),
      Err(CopySourceError::Transfer)
    );
    assert!(photo.path.exists());
    std::fs::write(&photo.path, b"changed original").unwrap();
    assert_eq!(source.verify(|| false), Err(CopySourceError::Changed));
    assert!(matches!(CloudCopySource::open(&photo), Err(CopySourceError::Changed)));
  }

  #[test]
  fn rejects_a_change_during_streaming_before_complete() {
    let fixture = Fixture::new();
    let photo = fixture.photo();
    let mut source = CloudCopySource::open(&photo).unwrap();
    struct Changing(PathBuf);
    impl Write for Changing {
      fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        std::fs::write(&self.0, b"changed outside the app")?;
        Ok(bytes.len())
      }
      fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
      }
    }
    assert_eq!(
      source.stream_to_staging(&mut Changing(photo.path.clone()), || false),
      Err(CopySourceError::Changed)
    );
    assert!(photo.path.exists());
  }

  #[test]
  fn unknown_photo_and_over_limit_file_cannot_be_captured() {
    assert!(matches!(
      CloudCopySource::capture(&CameraPhotos::new(None), "unknown"),
      Err(CopySourceError::Missing)
    ));
    let fixture = Fixture::new();
    let photo = fixture.photo();
    OpenOptions::new()
      .write(true)
      .open(&photo.path)
      .unwrap()
      .set_len(MAX_BYTES + 1)
      .unwrap();
    assert!(matches!(CloudCopySource::open(&photo), Err(CopySourceError::TooLarge)));
  }
}
