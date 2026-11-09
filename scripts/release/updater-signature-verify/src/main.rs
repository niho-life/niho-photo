use std::env;
use std::fs;
use std::path::Path;

use minisign_verify::{PublicKey, Signature};

const MAX_ARCHIVE_BYTES: u64 = 250 * 1024 * 1024;
const MAX_SIGNATURE_BYTES: u64 = 16 * 1024;

fn read_regular_file(path: &Path, max_bytes: u64) -> Result<Vec<u8>, &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "file read failed")?;
    if !metadata.file_type().is_file() || metadata.len() == 0 || metadata.len() > max_bytes {
        return Err("file type or size is invalid");
    }
    let bytes = fs::read(path).map_err(|_| "file read failed")?;
    if bytes.len() as u64 != metadata.len() {
        return Err("file size changed while reading");
    }
    Ok(bytes)
}

fn verify_minisign(
    public_key_text: &str,
    signature_text: &str,
    archive: &[u8],
) -> Result<Signature, &'static str> {
    let public_key = PublicKey::decode(public_key_text).map_err(|_| "public key is invalid")?;
    let signature = Signature::decode(signature_text).map_err(|_| "signature is invalid")?;
    public_key
        .verify(archive, &signature, true)
        .map_err(|_| "signature does not match the pinned key and archive")?;
    Ok(signature)
}

fn verify_signed_version(
    trusted_comment: &str,
    expected_version: &str,
) -> Result<(), &'static str> {
    let signed_version = trusted_comment
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
        .ok_or("signed version is missing")?;
    if signed_version != expected_version {
        return Err("signed version does not match the release version");
    }
    Ok(())
}

fn verify_archive_signature(
    public_key_text: &str,
    signature_text: &str,
    archive: &[u8],
    expected_version: &str,
) -> Result<(), &'static str> {
    // The trusted comment becomes usable only after Minisign verifies both signatures.
    let signature = verify_minisign(public_key_text, signature_text, archive)?;
    verify_signed_version(signature.trusted_comment(), expected_version)
}

fn run() -> Result<(), &'static str> {
    let mut args = env::args().skip(1);
    let public_key_text = args.next().ok_or("usage")?;
    let archive_path = args.next().ok_or("usage")?;
    let signature_path = args.next().ok_or("usage")?;
    let expected_version = args.next().ok_or("usage")?;
    if args.next().is_some() {
        return Err("usage");
    }

    let archive = read_regular_file(Path::new(&archive_path), MAX_ARCHIVE_BYTES)?;
    let signature_bytes = read_regular_file(Path::new(&signature_path), MAX_SIGNATURE_BYTES)?;
    let signature_text =
        std::str::from_utf8(&signature_bytes).map_err(|_| "signature is invalid")?;
    verify_archive_signature(
        &public_key_text,
        signature_text,
        &archive,
        &expected_version,
    )?;
    Ok(())
}

fn main() {
    match run() {
        Ok(()) => println!("Updater signature matches the pinned key, archive, and version."),
        Err(_) => {
            eprintln!("Updater signature verification failed.");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{verify_archive_signature, verify_minisign, verify_signed_version};

    const PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const OTHER_PUBLIC_KEY: &str = "untrusted comment: minisign public key: A49EF4746FA6E6D7\nRWTX5qZvdPSepDGWg2bz8n6ArQnBMwgQK1geVosorcbLzcunD+KJ+cYe";
    const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";

    #[test]
    fn minisign_rejects_wrong_key_and_changed_archive() {
        assert!(verify_minisign(PUBLIC_KEY, SIGNATURE, b"test").is_ok());
        assert!(verify_minisign(OTHER_PUBLIC_KEY, SIGNATURE, b"test").is_err());
        assert!(verify_minisign(PUBLIC_KEY, SIGNATURE, b"changed").is_err());
    }

    #[test]
    fn archive_verification_rejects_a_valid_signature_without_a_signed_version() {
        assert_eq!(
            verify_archive_signature(PUBLIC_KEY, SIGNATURE, b"test", "1.2.3"),
            Err("signed version is missing")
        );
    }

    #[test]
    fn signed_version_must_be_present_and_match_exactly() {
        let comment = "timestamp:1700000000\tfile:archive.tar.gz\tversion:1.2.3";
        assert!(verify_signed_version(comment, "1.2.3").is_ok());
        assert!(verify_signed_version(comment, "1.2.4").is_err());
        assert!(
            verify_signed_version("timestamp:1700000000\tfile:archive.tar.gz", "1.2.3").is_err()
        );
    }
}
