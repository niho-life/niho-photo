#!/usr/bin/env python3
"""Fetch one fixed-repository Actions artifact and extract its data-only payload."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import select
import stat
import subprocess
import sys
import tempfile
import time
import zipfile


REPOSITORY = "niho-life/niho-photo"
TARGETS = ("aarch64-apple-darwin", "x86_64-unknown-linux-gnu")
SHA40 = re.compile(r"^[a-f0-9]{40}$")
POSITIVE_INTEGER = re.compile(r"^[1-9][0-9]*$")
MAX_METADATA_BYTES = 1024 * 1024
MAX_ZIP_BYTES = 300 * 1024 * 1024
MAX_BUILD_RECORD_BYTES = 1024 * 1024
MAX_TARBALL_BYTES = 256 * 1024 * 1024
MAX_TOTAL_BYTES = MAX_BUILD_RECORD_BYTES + MAX_TARBALL_BYTES
MAX_COMPRESSION_RATIO = 100
DOWNLOAD_TIMEOUT_SECONDS = 300


class ArtifactDownloadError(Exception):
    """A fail-closed artifact identity, transport, or ZIP failure."""


def normalize_digest(value: object) -> str:
    if not isinstance(value, str):
        raise ArtifactDownloadError("artifact digestがありません")
    match = re.fullmatch(r"(?:sha256:)?([a-f0-9]{64})", value)
    if not match:
        raise ArtifactDownloadError("artifact digest形式が不正です")
    return f"sha256:{match.group(1)}"


def positive_integer(value: object, label: str) -> int:
    text = str(value)
    if not POSITIVE_INTEGER.fullmatch(text):
        raise ArtifactDownloadError(f"{label}はpositive integerが必要です")
    return int(text)


def expected_artifact_name(source: str, run_id: int, run_attempt: int, target: str) -> str:
    return f"niho-renderer-{source}-run-{run_id}-attempt-{run_attempt}-{target}"


def expected_zip_entries(source: str, target: str) -> tuple[str, str]:
    return (
        f"niho-develop-render-{source}-{target}.tgz",
        f"renderer-build-{target}.json",
    )


def validate_metadata(
    metadata: object,
    *,
    artifact_id: int,
    artifact_name: str,
    artifact_digest: str,
    run_id: int,
    builder_source: str,
) -> None:
    if not isinstance(metadata, dict):
        raise ArtifactDownloadError("artifact metadataがobjectではありません")
    required = ("id", "name", "digest", "expired", "size_in_bytes", "workflow_run")
    if any(key not in metadata for key in required):
        raise ArtifactDownloadError("artifact metadata fieldが不足しています")
    if type(metadata["id"]) is not int or metadata["id"] != artifact_id:
        raise ArtifactDownloadError("artifact metadata IDが一致しません")
    if metadata["name"] != artifact_name:
        raise ArtifactDownloadError("artifact metadata nameが一致しません")
    if normalize_digest(metadata["digest"]) != artifact_digest:
        raise ArtifactDownloadError("artifact metadata digestが一致しません")
    if metadata["expired"] is not False:
        raise ArtifactDownloadError("artifactは期限切れです")
    if type(metadata["size_in_bytes"]) is not int or not 0 < metadata["size_in_bytes"] <= MAX_ZIP_BYTES:
        raise ArtifactDownloadError("artifact metadata sizeが不正です")
    workflow_run = metadata["workflow_run"]
    if not isinstance(workflow_run, dict) or any(key not in workflow_run for key in ("id", "head_sha", "head_branch")):
        raise ArtifactDownloadError("artifact workflow_run fieldが不足しています")
    if type(workflow_run["id"]) is not int or workflow_run["id"] != run_id:
        raise ArtifactDownloadError("artifact workflow run IDが一致しません")
    if workflow_run["head_sha"] != builder_source:
        raise ArtifactDownloadError("artifact builder sourceが一致しません")
    if workflow_run["head_branch"] != "main":
        raise ArtifactDownloadError("artifact workflow branchがmainではありません")


def sha256_file(file: Path) -> str:
    digest = hashlib.sha256()
    with file.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _safe_zip_info(info: zipfile.ZipInfo, allowed: set[str]) -> None:
    name = info.filename
    if name not in allowed:
        raise ArtifactDownloadError("artifact ZIPに未知entryがあります")
    if (
        not name
        or name.startswith("/")
        or "\\" in name
        or "/" in name
        or any(part in ("", ".", "..") for part in name.split("/"))
    ):
        raise ArtifactDownloadError("artifact ZIP entry pathが不正です")
    if info.is_dir() or name.endswith("/"):
        raise ArtifactDownloadError("artifact ZIP directoryは許可されません")
    if info.flag_bits & 0x1:
        raise ArtifactDownloadError("artifact ZIP encrypted entryは許可されません")
    mode = (info.external_attr >> 16) & 0xFFFF
    kind = stat.S_IFMT(mode)
    if kind not in (0, stat.S_IFREG):
        raise ArtifactDownloadError("artifact ZIPはregular fileだけを許可します")
    if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
        raise ArtifactDownloadError("artifact ZIP compressionが不正です")
    maximum = MAX_BUILD_RECORD_BYTES if name.startswith("renderer-build-") else MAX_TARBALL_BYTES
    if info.file_size <= 0 or info.file_size > maximum or info.compress_size < 0:
        raise ArtifactDownloadError("artifact ZIP entry sizeが不正です")
    if info.file_size > max(MAX_BUILD_RECORD_BYTES, info.compress_size * MAX_COMPRESSION_RATIO):
        raise ArtifactDownloadError("artifact ZIP compression bombを拒否しました")


def validate_and_extract_zip(
    zip_path: Path,
    output_directory: Path,
    *,
    expected_digest: str,
    source: str,
    target: str,
) -> tuple[str, str]:
    if sha256_file(zip_path) != expected_digest:
        raise ArtifactDownloadError("artifact ZIP実SHA-256が期待digestと一致しません")
    if output_directory.exists() or output_directory.is_symlink():
        raise ArtifactDownloadError("artifact出力は新規directoryが必要です")
    expected = expected_zip_entries(source, target)
    allowed = set(expected)
    try:
        with zipfile.ZipFile(zip_path, "r") as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if len(infos) != 2 or len(set(names)) != 2:
                raise ArtifactDownloadError("artifact ZIPはexact 2 unique entriesが必要です")
            if set(names) != allowed:
                raise ArtifactDownloadError("artifact ZIP entry集合が不正です")
            for info in infos:
                _safe_zip_info(info, allowed)
            if sum(info.file_size for info in infos) > MAX_TOTAL_BYTES:
                raise ArtifactDownloadError("artifact ZIP展開sizeが上限を超えました")
            output_directory.mkdir(mode=0o755, parents=False, exist_ok=False)
            written: list[Path] = []
            try:
                for info in infos:
                    destination = output_directory / info.filename
                    with archive.open(info, "r") as source_handle:
                        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
                        written.append(destination)
                        total = 0
                        try:
                            with os.fdopen(descriptor, "wb") as output_handle:
                                while chunk := source_handle.read(1024 * 1024):
                                    total += len(chunk)
                                    if total > info.file_size:
                                        raise ArtifactDownloadError("artifact ZIP entryが宣言sizeを超えました")
                                    output_handle.write(chunk)
                        except Exception:
                            if destination.exists():
                                destination.unlink()
                            raise
                    if total != info.file_size:
                        raise ArtifactDownloadError("artifact ZIP entryがtruncatedです")
            except Exception:
                for destination in written:
                    if destination.exists():
                        destination.unlink()
                output_directory.rmdir()
                raise
    except (zipfile.BadZipFile, RuntimeError, EOFError, OSError) as error:
        raise ArtifactDownloadError("artifact ZIPを安全に検証できません") from error
    return expected


def _gh_metadata(artifact_id: int) -> object:
    if type(artifact_id) is not int or artifact_id < 1:
        raise ArtifactDownloadError("artifact IDはpositive integerが必要です")
    api_path = f"repos/{REPOSITORY}/actions/artifacts/{artifact_id}"
    try:
        result = subprocess.run(
            ["gh", "api", api_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ArtifactDownloadError("artifact metadata取得に失敗しました") from error
    if result.returncode != 0 or not 0 < len(result.stdout) <= MAX_METADATA_BYTES:
        raise ArtifactDownloadError("artifact metadata取得に失敗しました")
    try:
        return json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ArtifactDownloadError("artifact metadata JSONが不正です") from error


def _download_zip(artifact_id: int, destination: Path) -> None:
    if type(artifact_id) is not int or artifact_id < 1:
        raise ArtifactDownloadError("artifact IDはpositive integerが必要です")
    api_path = f"repos/{REPOSITORY}/actions/artifacts/{artifact_id}/zip"
    try:
        process = subprocess.Popen(
            ["gh", "api", api_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except OSError as error:
        raise ArtifactDownloadError("artifact ZIP取得に失敗しました") from error
    if process.stdout is None:
        process.kill()
        raise ArtifactDownloadError("artifact ZIP取得に失敗しました")
    deadline = time.monotonic() + DOWNLOAD_TIMEOUT_SECONDS
    size = 0
    try:
        with destination.open("xb") as output:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ArtifactDownloadError("artifact ZIP取得がtimeoutしました")
                readable, _, _ = select.select([process.stdout], [], [], min(remaining, 5))
                if not readable:
                    if process.poll() is not None:
                        break
                    continue
                chunk = os.read(process.stdout.fileno(), 1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_ZIP_BYTES:
                    raise ArtifactDownloadError("artifact ZIPがsize上限を超えました")
                output.write(chunk)
        returncode = process.wait(timeout=max(1, int(deadline - time.monotonic())))
        if returncode != 0 or size == 0:
            raise ArtifactDownloadError("artifact ZIP取得に失敗しました")
    except Exception as error:
        if process.poll() is None:
            process.kill()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        if destination.exists():
            destination.unlink()
        if isinstance(error, ArtifactDownloadError):
            raise
        raise ArtifactDownloadError("artifact ZIP取得に失敗しました") from error


def download_artifact(args: argparse.Namespace) -> None:
    artifact_id = positive_integer(args.artifact_id, "artifact ID")
    run_id = positive_integer(args.run_id, "run ID")
    run_attempt = positive_integer(args.run_attempt, "run attempt")
    if run_attempt != 1:
        raise ArtifactDownloadError("手動rerunのartifactは取得できません")
    if args.target not in TARGETS or not SHA40.fullmatch(args.source) or not SHA40.fullmatch(args.builder_source):
        raise ArtifactDownloadError("source/target identityが不正です")
    digest = normalize_digest(args.artifact_digest)
    canonical_name = expected_artifact_name(args.source, run_id, run_attempt, args.target)
    if args.artifact_name != canonical_name:
        raise ArtifactDownloadError("artifact nameがrun/source/target identityと一致しません")
    output = Path(args.output)
    if not output.is_absolute() or output.exists() or output.is_symlink() or not output.parent.is_dir():
        raise ArtifactDownloadError("artifact出力pathが不正です")
    metadata = _gh_metadata(artifact_id)
    validate_metadata(
        metadata,
        artifact_id=artifact_id,
        artifact_name=canonical_name,
        artifact_digest=digest,
        run_id=run_id,
        builder_source=args.builder_source,
    )
    with tempfile.TemporaryDirectory(prefix="niho-renderer-artifact-") as temporary:
        zip_path = Path(temporary) / "artifact.zip"
        _download_zip(artifact_id, zip_path)
        validate_and_extract_zip(
            zip_path,
            output,
            expected_digest=digest,
            source=args.source,
            target=args.target,
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--artifact-id", required=True)
    parser.add_argument("--artifact-name", required=True)
    parser.add_argument("--artifact-digest", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-attempt", required=True)
    parser.add_argument("--builder-source", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--target", required=True, choices=TARGETS)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def main() -> int:
    try:
        download_artifact(parse_args())
        return 0
    except ArtifactDownloadError as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
