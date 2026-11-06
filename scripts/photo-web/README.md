# Photo Web formal release

`.github/workflows/photo-web-release.yml` is the only publisher for the formal Photo Web package. It runs manually from `main`, builds at that exact SHA, and publishes one immutable `photo-web-<source SHA>` release with exactly three assets: the Web manifest, normalized data-only USTAR archive, and Sigstore bundle. A reused tag fails; existing releases are never replaced.

The build uses the SDK version, source commit, and manifest digest pinned by `packages/photo-cloud-media/sdk-baseline.json`. It downloads and verifies the complete public SDK release, its receipt, and GitHub Sigstore attestation before packaging those proofs into the archive. The publisher signs the Web manifest with the fixed workflow identity and verifies the bundle before creating the tag.

The archive contains only `server/photo-web.mjs`, `static/**`, and the three SDK proof files under `provenance/`. It is normalized to regular files and directories with strict USTAR metadata, and enforces the receiver's 32 MiB archive/expanded budgets, 128-file cap, and 8 MiB per-file cap. It never contains cloud secrets or admission settings. `PHOTO_WEB_CLOUD_ENABLED` remains false unless runtime configuration explicitly sets it to `true`.

Dispatching this workflow publishes a public immutable GitHub release. Do so only after the PR has merged and the formal release is explicitly scheduled. The source changes in this PR only add the guarded path; they do not dispatch it or deploy a host.
