# Pinned leCore downloads — plan first, never auto-enable

This package retrieves public, immutable `staccs` artifacts. It does **not** run downloaded code, load models, change credentials/firewalls/execution policy, install software, or edit the active router registry. A downloaded file is **not** proof that a model can run on the 128 GiB Windows machine.

## Windows CMD: installed Node, no PATH repair

From this checkout, use the supplied launcher. It tries the existing Codex Node runtime at `%USERPROFILE%/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`, then `where node.exe`. It requires Node 24+. Nothing is installed. In PowerShell use `./download-models.cmd` instead of the bare launcher name.

Choose a private destination on a disk with enough free space. The following drive/path is an example, not an assertion about your machine.

```bat
rem Read-only, offline preflight. No directories or downloads are created.
download-models.cmd --dest "D:/Models/staccs"

rem Optional: reuse installed weights after exact byte-size AND SHA256 checks.
rem Choose the specific model/project directory, not the whole drive or user home.
download-models.cmd --dest "D:/Models/staccs" --existing-dir "D:/ExistingModels"

rem After reviewing the plan, explicitly download missing files.
download-models.cmd --dest "D:/Models/staccs" --existing-dir "D:/ExistingModels" --download
```

Do not supply `--existing-dir` unless that directory exists. Existing files are neither moved nor modified. Only regular files with a size appearing in the manifest are hashed; unrelated sizes are not read. The scan skips all symlinks/junctions, stops at eight nested directory levels, and rejects scans exceeding 100,000 entries. A same-name or same-size file alone is never accepted. Verified existing paths are retained in the pending output instead of downloading duplicates.

### All published GGUF checkpoints

The default pinned manifest, `manifests/staccs-lecore-gguf.json`, contains **10 checkpoint variants plus the Muse-Glimmer vision projector: 11 files, 196,835,527,136 bytes (183.32 GiB)**. This includes both distinct Qwen3-32B leCore precision allocations. Stock baseline quantizations, duplicate MLX counterparts, oversized artifacts, incomplete overlays and research-only formats have explicit exclusions; see the manifest's `coverage` and `exclusions` fields.

The default reserve is **32 GiB**. With no reusable files, primary GGUF downloads need **231,195,265,504 free bytes**, including the reserve. This is disk space, **not RAM**. The plan reports exact `totalMissingBytes`, `reserveBytes`, `requiredFreeBytes`, `availableBytes`, blockers and per-file verification status. The reserve can be changed with `--reserve-gib`, minimum 1 GiB. Do not use that minimum without separately budgeting system needs.

### Four further distinct models: conversion staging, not deployment

A separate manifest, `manifests/staccs-lecore-conversion-staging.json`, retains the four fit-sized distinct non-GGUF candidates: Seed-OSS-36B MLX, Qwen3.5 9B and 0.8B assimilated checkpoints, and BGE embeddings. Its **47 files total 40,537,504,993 bytes**. These cannot be made eligible for this llama.cpp router simply by downloading them. Seed's MLX packed representation in particular needs reviewed semantic-preserving conversion; architecture recognition alone is insufficient.

```bat
rem Separate explicit mode and destination; still read-only by default.
download-models.cmd --conversion-staging --dest "D:/Models/lecore-conversion-staging"

rem Stage only safetensors and allowed config/tokenizer/provenance data.
download-models.cmd --conversion-staging --dest "D:/Models/lecore-conversion-staging" --download
```

The two sets total **237,373,032,129 bytes**, before reuse. On one disk, completing both sets while retaining the default reserve needs **271,732,770,497 free bytes** initially. Each invocation independently checks current free space; running the second after the first recalculates what remains.

Staging permits `.safetensors`, `.json`, `.txt`, `.md` and `.jinja` only, with an explicit manifest-kind gate; non-weight files are capped at 32 MiB each. Templates/cards are inert bytes: they are not rendered or executed. No Python, pickle, `.bin`, ONNX, executable or package artifacts are selected. No conversion is performed. Staged candidates remain `conversion-required`, disabled and unverified.

## Direct Node CLI and output

```sh
node download-models.mjs --manifest manifests/staccs-lecore-gguf.json --dest ./models/staccs
node download-models.mjs --manifest manifests/staccs-lecore-gguf.json --dest ./models/staccs --download --concurrency 2
node download-models.mjs --manifest manifests/staccs-lecore-conversion-staging.json --conversion-staging --dest ./models/conversion-staging
```

JSON is written to stdout, human progress to stderr. Redirect stdout if you want to save the plan/pending report; that shell redirection writes a report, but the planner itself remains read-only. The output is **not an active registry file** and must not replace `setup/model-registry.json`.

Options: `--plan` (default), `--download`, `--conversion-staging`, `--existing-dir`, `--reserve-gib 32`, `--concurrency 1` (1–4), `--idle-timeout-seconds 60`, and `--total-timeout-hours 24`. A blocked read-only plan exits 2; validation or download failure exits 1. No automatic network retry loop, overwrite, reset or deletion of conflicting files is performed.

## Safety and recovery

- Repository owner, immutable 40-hex revision, safe relative path, exact length and SHA256 are mandatory. The downloader constructs the pinned Hub URL itself; arbitrary manifest URLs are refused. LFS SHA256 comes from the pinned inventory; staging text/config hashes were computed from those exact pinned bytes.
- Only HTTPS on port 443 to an explicit official Hub/CDN allowlist is accepted, with a five-redirect limit. Hub redirects must stay within the same pinned repository artifact. No `HF_TOKEN`, cookies, netrc, ambient authorization or proxy configuration is read or forwarded. A private/gated model fails rather than requesting credentials. New CDN hosts fail closed and require a reviewed code update, not a network-policy change.
- All existing destinations are hash-checked. A conflicting destination is never overwritten. Downloading uses `.part` plus identity/prefix-hash metadata; resume requires the same repository, revision, path, full hash/size and a matching rehashed local prefix. Resumed responses must return exact `206` and `Content-Range`; an ignored Range never truncates the partial.
- Length and SHA256 are checked before publication, then the actual on-disk file is rehashed. Publication uses an **atomic no-clobber hard link** from `.part` to the final name, followed by unlinking `.part`. This intentionally replaces unsafe overwrite-capable `rename()`. NTFS/ext4 support this; unsupported filesystems fail closed instead of falling back to a destructive copy/rename. Keep temporary and final files on the same volume.
- Root/ancestor symlinks, junctions, non-regular destinations and multiply-linked writable partials are rejected. Use a private directory not concurrently modified by another program/user. Portable Node APIs cannot atomically protect against a hostile actor swapping ancestor directories between checks; this is not a sandbox against an attacker who can write the destination tree.
- One exclusive root lock prevents concurrent downloader instances. A stale lock is never removed automatically: first confirm the recorded process has stopped, then inspect it manually. Network concurrency is bounded; disk writes are serialized and free space checked before each bounded chunk. This protects the reserve under normal use, but cannot prevent another process consuming space between a free-space check and write.
- Ctrl+C/SIGTERM abort network work and retains a hash-checked partial when possible. Graceful checkpointing rereads the partial, which can take time for a large file; let it finish. A power loss/forced kill can leave an orphaned or stale checkpoint. Such files are blocked for manual review rather than guessed, silently deleted or resumed unsafely. Short writes, errors, unexpected lengths and wrong hashes never produce a trusted final model.

## Runtime admission remains separate

Pending entries are `enabled:false`, `routing.auto:false`, `compatibility.status:"unverified"` with no asserted capabilities, measured context, peak RAM or KV budget. Muse has separate disabled text and vision candidates sharing verified weights; text omits the projector. Vision needs the matching projector and a real image-input smoke test. Separate loaded processes require distinct ports and full per-process memory accounting; sharing a path does not prove shared RAM.

BGE's embedding identity is **not** replaced with the currently installed embedding model. Revision, tokenizer, pooling, dimension, normalization and retrieval index identity must be explicitly verified before use. No existing index is silently reused.

A local validation pass must establish runtime-version/architecture support, bounded-context load, context/KV and peak-memory measurements, and task-specific smoke tests. Do not load all weights simultaneously. A 128 GiB system's file-size fit is not a RAM guarantee or proof of usable throughput.

## Verification

`node --test test-download-models.mjs` uses tiny fixtures and injected HTTP responses, not real model transfers. It covers pin/schema/path restrictions, plan-only behavior, hashes, disk totals/headroom, resume and cancellation, wrong-length/hash/range rejection, official redirects without credentials, conflict/no-clobber races, symlink/junction and hard-link refusal, process locks, bounded concurrency/timeouts, existing-file reuse, separate staging and disabled pending entries.

At handoff these tests were run on Node 24.19.0/Linux. Windows CMD/NTFS execution and actual rig model loads require Windows validation; do not equate Linux mocks with those outcomes.

Official references: [Hub pinned downloads](https://huggingface.co/docs/huggingface_hub/en/guides/download), [Hub download/CDN host documentation](https://huggingface.co/docs/hub/models-downloading). No model weights are included in this repository.
