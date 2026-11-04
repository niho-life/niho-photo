#!/usr/bin/env python3
"""Offline tests for the trusted native renderer artifact transport."""

from __future__ import annotations

import hashlib
import io
from pathlib import Path
import shutil
import stat
import struct
import sys
import tempfile
import unittest
from unittest import mock
import warnings
import zipfile


sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).parent))
import native_renderer_artifact as artifact  # noqa: E402


SOURCE = "a" * 40
BUILDER = "b" * 40
TARGET = "x86_64-unknown-linux-gnu"
RUN_ID = 77
ARTIFACT_ID = 101
NAME = artifact.expected_artifact_name(SOURCE, RUN_ID, 1, TARGET)


def zip_bytes(entries: list[tuple[str, bytes, int | None]]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data, mode in entries:
            info = zipfile.ZipInfo(name)
            info.compress_type = zipfile.ZIP_DEFLATED
            if mode is not None:
                info.create_system = 3
                info.external_attr = mode << 16
            archive.writestr(info, data)
    return output.getvalue()


def valid_entries() -> list[tuple[str, bytes, int | None]]:
    tarball, record = artifact.expected_zip_entries(SOURCE, TARGET)
    return [(record, b'{"schemaVersion":1}\n', stat.S_IFREG | 0o644), (tarball, b"synthetic tgz bytes", stat.S_IFREG | 0o644)]


def encrypted_zip(value: bytes) -> bytes:
    changed = bytearray(value)
    offset = 0
    while True:
        offset = changed.find(b"PK\x03\x04", offset)
        if offset < 0:
            break
        flags = struct.unpack_from("<H", changed, offset + 6)[0]
        struct.pack_into("<H", changed, offset + 6, flags | 1)
        offset += 4
    offset = 0
    while True:
        offset = changed.find(b"PK\x01\x02", offset)
        if offset < 0:
            break
        flags = struct.unpack_from("<H", changed, offset + 8)[0]
        struct.pack_into("<H", changed, offset + 8, flags | 1)
        offset += 4
    return bytes(changed)


class MetadataTests(unittest.TestCase):
    def metadata(self) -> dict[str, object]:
        return {
            "id": ARTIFACT_ID,
            "name": NAME,
            "digest": "sha256:" + "c" * 64,
            "expired": False,
            "size_in_bytes": 1234,
            "workflow_run": {"id": RUN_ID, "head_sha": BUILDER, "head_branch": "main"},
        }

    def validate(self, value: object) -> None:
        artifact.validate_metadata(
            value,
            artifact_id=ARTIFACT_ID,
            artifact_name=NAME,
            artifact_digest="sha256:" + "c" * 64,
            run_id=RUN_ID,
            builder_source=BUILDER,
        )

    def test_accepts_exact_identity_and_normalizes_digest(self) -> None:
        self.validate(self.metadata())
        self.assertEqual(artifact.normalize_digest("c" * 64), "sha256:" + "c" * 64)

    def test_rejects_metadata_identity_mismatches_and_missing_fields(self) -> None:
        mutations = []
        for key, value in (
            ("id", 102),
            ("name", "wrong"),
            ("digest", "sha256:" + "d" * 64),
            ("expired", True),
            ("size_in_bytes", 0),
        ):
            changed = self.metadata()
            changed[key] = value
            mutations.append(changed)
        for key, value in (("id", 78), ("head_sha", "d" * 40), ("head_branch", "feature")):
            changed = self.metadata()
            changed["workflow_run"][key] = value  # type: ignore[index]
            mutations.append(changed)
        for key in ("id", "name", "digest", "expired", "size_in_bytes", "workflow_run"):
            changed = self.metadata()
            del changed[key]
            mutations.append(changed)
        changed = self.metadata()
        del changed["workflow_run"]["head_sha"]  # type: ignore[index]
        mutations.append(changed)
        for value in mutations:
            with self.subTest(value=value):
                with self.assertRaises(artifact.ArtifactDownloadError):
                    self.validate(value)


class TransportTests(unittest.TestCase):
    def test_metadata_uses_only_the_fixed_repository_and_positive_id(self) -> None:
        response = {"id": ARTIFACT_ID}
        completed = artifact.subprocess.CompletedProcess([], 0, stdout=b'{"id":101}')
        with mock.patch.object(artifact.subprocess, "run", return_value=completed) as run:
            self.assertEqual(artifact._gh_metadata(ARTIFACT_ID), response)
        run.assert_called_once_with(
            ["gh", "api", "repos/niho-life/niho-photo/actions/artifacts/101"],
            stdout=artifact.subprocess.PIPE,
            stderr=artifact.subprocess.DEVNULL,
            check=False,
            timeout=60,
        )
        with mock.patch.object(artifact.subprocess, "run") as invalid_run:
            with self.assertRaises(artifact.ArtifactDownloadError):
                artifact._gh_metadata(0)
        invalid_run.assert_not_called()

    def test_metadata_transport_and_json_fail_closed(self) -> None:
        cases = (
            artifact.subprocess.CompletedProcess([], 1, stdout=b""),
            artifact.subprocess.CompletedProcess([], 0, stdout=b""),
            artifact.subprocess.CompletedProcess([], 0, stdout=b"{"),
            artifact.subprocess.CompletedProcess([], 0, stdout=b"x" * (artifact.MAX_METADATA_BYTES + 1)),
        )
        for result in cases:
            with self.subTest(returncode=result.returncode, size=len(result.stdout)):
                with mock.patch.object(artifact.subprocess, "run", return_value=result):
                    with self.assertRaises(artifact.ArtifactDownloadError):
                        artifact._gh_metadata(ARTIFACT_ID)
        with mock.patch.object(artifact.subprocess, "run", side_effect=artifact.subprocess.TimeoutExpired("gh", 60)):
            with self.assertRaises(artifact.ArtifactDownloadError):
                artifact._gh_metadata(ARTIFACT_ID)


class ZipTests(unittest.TestCase):
    def check(self, value: bytes, *, digest: str | None = None) -> tuple[Path, Path]:
        root = Path(tempfile.mkdtemp(prefix="renderer-artifact-test-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        zip_path = root / "artifact.zip"
        zip_path.write_bytes(value)
        output = root / "output"
        artifact.validate_and_extract_zip(
            zip_path,
            output,
            expected_digest=digest or f"sha256:{hashlib.sha256(value).hexdigest()}",
            source=SOURCE,
            target=TARGET,
        )
        return zip_path, output

    def test_extracts_exact_two_regular_data_files(self) -> None:
        value = zip_bytes(valid_entries())
        _, output = self.check(value)
        self.assertEqual(sorted(path.name for path in output.iterdir()), sorted(artifact.expected_zip_entries(SOURCE, TARGET)))
        for path in output.iterdir():
            self.assertTrue(path.is_file())
            self.assertFalse(path.is_symlink())

    def test_rejects_actual_zip_digest_tampering_and_truncation(self) -> None:
        value = zip_bytes(valid_entries())
        with self.assertRaises(artifact.ArtifactDownloadError):
            self.check(value, digest="sha256:" + "0" * 64)
        with self.assertRaises(artifact.ArtifactDownloadError):
            self.check(value[:-16])

    def test_rejects_duplicate_unknown_traversal_absolute_backslash_and_directory(self) -> None:
        tarball, record = artifact.expected_zip_entries(SOURCE, TARGET)
        cases = [
            [(record, b"one", None), (record, b"two", None)],
            [(record, b"one", None), ("unknown", b"two", None)],
            [(record, b"one", None), ("../" + tarball, b"two", None)],
            [(record, b"one", None), ("/" + tarball, b"two", None)],
            [(record, b"one", None), ("folder\\" + tarball, b"two", None)],
            [(record, b"one", None), (tarball + "/", b"two", None)],
        ]
        for entries in cases:
            with self.subTest(entries=[name for name, _, _ in entries]):
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UserWarning)
                    value = zip_bytes(entries)
                with self.assertRaises(artifact.ArtifactDownloadError):
                    self.check(value)

    def test_rejects_symlink_special_and_encrypted_entries(self) -> None:
        tarball, record = artifact.expected_zip_entries(SOURCE, TARGET)
        for mode in (stat.S_IFLNK | 0o777, stat.S_IFCHR | 0o600, stat.S_IFIFO | 0o600):
            value = zip_bytes([(record, b"record", stat.S_IFREG | 0o644), (tarball, b"payload", mode)])
            with self.subTest(mode=mode):
                with self.assertRaises(artifact.ArtifactDownloadError):
                    self.check(value)
        value = encrypted_zip(zip_bytes(valid_entries()))
        with self.assertRaises(artifact.ArtifactDownloadError):
            self.check(value)

    def test_rejects_oversized_and_compression_bomb_entries(self) -> None:
        tarball, record = artifact.expected_zip_entries(SOURCE, TARGET)
        oversized = zip_bytes([(record, b"record", None), (tarball, b"abc", None)])
        original = artifact.MAX_TARBALL_BYTES
        artifact.MAX_TARBALL_BYTES = 2
        try:
            with self.assertRaises(artifact.ArtifactDownloadError):
                self.check(oversized)
        finally:
            artifact.MAX_TARBALL_BYTES = original
        bomb = zip_bytes([(record, b"record", None), (tarball, b"0" * (2 * 1024 * 1024), None)])
        with self.assertRaises(artifact.ArtifactDownloadError):
            self.check(bomb)


if __name__ == "__main__":
    unittest.main()
