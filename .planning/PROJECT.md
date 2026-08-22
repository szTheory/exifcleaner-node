# exifcleaner-node

## What This Is

`exifcleaner-node` is a small, typed Node.js metadata inspection and sanitization engine. Its first pre-1.0 release supports WebP only and exists to prove that a fail-closed, in-process TypeScript implementation can eventually replace selected ExifTool work in ExifCleaner without weakening the app's privacy contract.

## Core Value

Never create false confidence: either produce a verified sanitized artifact while preserving image data, or refuse without changing the source or leaving a partial destination.

## Requirements

### Validated

- [x] Pinned WebP evidence and adversarial fixtures detect metadata leaks and payload drift.
- [x] The typed WebP-only API sanitizes to a new path or refuses without damaging the source.
- [x] CI verifies source, packed consumers, and Node 22/24 on Linux, macOS, and Windows.
- [x] v0.1.1 was published by repository-bound trusted automation with provenance.
- [x] ExifCleaner consumes exact v0.1.1 behind a bounded native WebP pilot with ExifTool fallback.

### Active

None. The next format remains intentionally unselected.

### Out of Scope

- Formats other than WebP — each format must graduate separately behind its own corpus and evidence.
- Replacing ExifTool in the ExifCleaner app — ExifTool remains the fallback until format-by-format evidence justifies a later integration decision.
- In-place sanitization — the source is never overwritten.
- Best-effort rewriting of unknown chunks, trailers, or malformed containers — ambiguity is refused.
- A full ExifTool-compatible tag model or CLI — this package exposes a deliberately small typed API.
- Claiming the bundled ExifTool binary can be removed — binary exit is a future milestone, not a v0.1 outcome.

## Context

- ExifCleaner issue [#303](https://github.com/szTheory/exifcleaner/issues/303) proposes a narrow TypeScript alternative but makes differential evidence a prerequisite because silent metadata misses are worse than an explicit refusal.
- The upstream evidence baseline is ExifCleaner commit [`ba365b3459b0d87ce255124a5eef819aca603efd`](https://github.com/szTheory/exifcleaner/commit/ba365b3459b0d87ce255124a5eef819aca603efd). Fixture origin and integrity are recorded in `docs/fixture-provenance.md`.
- WebP is the first slice because its RIFF chunk model explicitly separates `EXIF`, `XMP `, `ICCP`, image, and animation chunks.
- Issue [#299](https://github.com/szTheory/exifcleaner/issues/299) is a reminder that workflow metadata can survive a superficially successful WebP clean; unknown-chunk handling must therefore be explicit and conservative.

## Constraints

- **Runtime**: Node.js 22 or newer, ESM, TypeScript — matches the package engine and avoids a secondary runtime.
- **Correctness**: Detect content by magic bytes, validate RIFF sizes/padding/feature flags, and reopen the written destination before reporting success.
- **Filesystem safety**: Source and destination differ; destination creation is exclusive; any partial output is cleaned after failure.
- **Payload integrity**: Image and animation payload bytes are copied, not decoded or re-encoded.
- **Privacy**: No network activity, telemetry, or background lookup in the runtime library.
- **Scope**: WebP only and pre-1.0; unsupported formats and uncertain features return typed failures.
- **Evidence**: Every fixture has recorded origin, license status, and digest; upstream references are pinned to immutable SHAs where possible.

## Key Decisions

| Decision                                              | Rationale                                                                                                                | Outcome     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------- |
| Start with WebP                                       | RIFF has a bounded, specified chunk structure and exercises still, lossless, alpha, ICC, EXIF, XMP, and animation cases. | ✓ Validated |
| Use `Result` and discriminated `MetadataError` values | Expected failures are part of the public contract and must be exhaustively handleable.                                   | ✓ Validated |
| Refuse unknown chunks and trailers in v0.1            | Copying an unclassified payload could preserve private metadata while implying it was cleaned.                           | ✓ Validated |
| Never overwrite the source                            | A privacy tool must not turn a parser or I/O defect into data loss.                                                      | ✓ Validated |
| Preserve payload bytes instead of transcoding         | Sanitization should change metadata policy, not image pixels, frames, timing, or compression.                            | ✓ Validated |
| Keep ExifTool as the app fallback                     | One format slice is not evidence for removing a mature multi-format engine.                                              | ✓ Validated |
| Publish through trusted automation                    | OIDC and provenance avoid long-lived npm write tokens and connect package bytes to the public repository workflow.       | ✓ Validated |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition**:

1. Move verified requirements to Validated with the phase reference.
2. Move disproved assumptions to Out of Scope with a reason.
3. Record newly discovered requirements and decisions.
4. Re-check the support statement and core value for drift.

**After each milestone**:

1. Review the whole document against verification evidence.
2. Reassess whether another format is ready to graduate.
3. Keep binary exit deferred unless every required format has earned support.

---

_Last updated: 2026-08-22 after v0.1.1 release and ExifCleaner pilot verification_
