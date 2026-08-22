---
gsd_state_version: 1.0
milestone: v0.1
milestone_name: WebP Proof
status: Awaiting npm bootstrap
last_updated: "2026-08-22T17:02:00.000Z"
last_activity: 2026-08-22
last_activity_desc: WebP slice and release dry-run verified on GitHub
progress:
  total_phases: 4
  completed_phases: 3
  total_plans: 0
  completed_plans: 0
  percent: 97
---

# Project State

## Project Reference

See `.planning/PROJECT.md` (updated 2026-08-22), `.planning/REQUIREMENTS.md`, and `.planning/ROADMAP.md`.

**Core value:** Either produce a verified sanitized artifact while preserving image data, or refuse without changing the source or leaving a partial destination.  
**Current focus:** Phase 3 — bind npm trusted publishing after the package exists

## Current Position

- Phase: 3 of 4 — Automated Release
- Plan: WebP proof implemented
- Status: Awaiting one-time npm package bootstrap
- Last activity: 2026-08-22 — CI and release dry-run passed on GitHub

Progress: █████████▓ 97% (29/30 requirements)

## Accumulated Context

### Decisions

- v0.1 supports WebP only and is pre-1.0.
- Public functions are `inspectFile`, `sanitizeFile`, and `getCapabilities`.
- Expected failures use discriminated `Result` and `MetadataError` unions.
- Source overwrite, destination replacement, unknown chunks, trailers, ambiguous orientation preservation, malformed input, unsupported features, and resource-limit violations are refusals.
- Image and animation payload bytes are copied without decode/re-encode.
- Successful sanitization requires a reopened destination verification pass.
- ExifTool remains the ExifCleaner fallback; package work does not imply binary exit.
- Release design uses npm trusted publishing and provenance after verification.
- Runtime dependencies remain at zero; codec validation is explicitly header-only.

### Evidence Baseline

- ExifCleaner source: `ba365b3459b0d87ce255124a5eef819aca603efd`
- Upstream fixture: `tests/e2e/fixtures/sample.webp`
- Recorded fixture identity: 152 bytes; SHA-256 `16d1cad79550c1e13f7710032f9bb41f5c36e49d0debe65761f7ee4c333360cd`
- Domain rationale: ExifCleaner issue #303; surviving WebP workflow report: issue #299.
- Implementation commits: `4e76273`, `5d403dc`.
- Hosted CI: 77/77 steps passed across Linux, macOS, and Windows on Node 22 and 24.
- Release dry-run: 19/19 steps passed, including audit, package smoke, checksum, SBOM, and build attestation.

### Deferred

- Every non-WebP format.
- ExifCleaner production adapter and staged rollout.
- Performance/size claims pending measurement.
- Bundled ExifTool removal pending full portfolio evidence.

## Next Action

An authenticated npm maintainer must create `exifcleaner-node` on the registry once. npm requires a package to exist before a trusted publisher can be bound. After that, bind `szTheory/exifcleaner-node` + `release.yml` + `npm`, arm `NPM_PUBLISH_ENABLED`, and create the protected `v0.1.0` tag.

## Operator Notes

- Do not mark requirements complete from implementation alone; verification evidence and repository state must agree.
- Do not describe npm publication until registry evidence exists.
- Re-read `.planning/research/PITFALLS.md` before changing parser or writer policy.
