# Requirements: exifcleaner-node

**Defined:** 2026-08-22  
**Milestone:** v0.1 WebP Proof  
**Core Value:** Either produce a verified sanitized artifact while preserving image data, or refuse without changing the source or leaving a partial destination.

## v0.1 Requirements

### Evidence Foundation

- [ ] **EVID-01**: Maintainers can trace the upstream WebP fixture to ExifCleaner commit `ba365b3459b0d87ce255124a5eef819aca603efd`, its original path, byte size, and SHA-256 digest.
- [ ] **EVID-02**: Maintainers have labeled generated WebP cases covering still, lossless/lossy, alpha, ICC, EXIF, XMP, animation, odd padding, duplicate metadata, malformed sizes, truncation, unknown chunks, and trailers.
- [ ] **EVID-03**: Verification can prove image/animation payload byte identity, requested removal/preservation, fail-closed rejection, source immutability, and destination cleanup.

### Public API

- [ ] **API-01**: A consumer can call `inspectFile(path)` and receive `Result<Inspection, MetadataError>`, with a magic-detected WebP format, typed metadata entries, and warnings.
- [ ] **API-02**: A consumer can call `sanitizeFile(options)` with distinct source/destination paths, three explicit preservation flags, and an optional `AbortSignal`.
- [ ] **API-03**: A successful sanitization returns format, destination path, removed namespaces, preserved properties, and warnings.
- [ ] **API-04**: A consumer can call `getCapabilities()` to discover the exact WebP support, preservation controls, resource boundaries, and refusals without probing files.
- [ ] **API-05**: Expected failures are represented by a discriminated `MetadataError` inside a discriminated `Result`, enabling exhaustive handling without parsing message text.

### WebP Correctness

- [ ] **WEBP-01**: The engine identifies WebP by `RIFF`/`WEBP` magic and refuses extension-only matches and unsupported formats.
- [ ] **WEBP-02**: The parser validates the RIFF declared size, chunk boundaries, little-endian lengths, odd-size padding, required ordering, duplication policy, VP8X flags, and exact container end.
- [ ] **WEBP-03**: Inspection reports recognized EXIF, XMP, and ICC metadata without modifying the source.
- [ ] **WEBP-04**: Sanitization removes EXIF and XMP and removes ICC unless `preserveColorProfile` is true.
- [ ] **WEBP-05**: When `preserveOrientation` is true, sanitization preserves only supported orientation data rather than retaining the original EXIF payload; unsupported orientation representations are refused.
- [ ] **WEBP-06**: Still-image and animation reconstruction payload chunks remain byte-identical and ordered after sanitization.
- [ ] **WEBP-07**: The writer recomputes RIFF sizes, padding, and relevant VP8X metadata flags, and its output is independently reopened and verified before success.

### Safety and Refusal

- [ ] **SAFE-01**: Sanitization never overwrites the source and refuses equal or aliased source/destination paths.
- [ ] **SAFE-02**: Destination creation is exclusive; an existing destination is never replaced.
- [ ] **SAFE-03**: A destination created by the current call is removed after parse, write, cancellation, verification, or timestamp failure.
- [ ] **SAFE-04**: The engine refuses malformed/truncated containers, unknown chunks, trailers, unsupported format/features, and configured resource-limit violations with typed errors.
- [ ] **SAFE-05**: The engine observes a supplied `AbortSignal` at bounded work boundaries and returns a typed cancelled result without partial output.
- [ ] **SAFE-06**: When requested, source filesystem timestamps are applied to the verified destination; otherwise no timestamp-preservation claim is made.
- [ ] **SAFE-07**: Runtime inspection and sanitization perform no network requests, telemetry, subprocess execution, or native-code loading.

### Automated Release

- [ ] **REL-01**: Pull-request and main-branch automation runs the repository's defined verification command on the supported Node version before release work can proceed.
- [ ] **REL-02**: Tag-driven release automation builds and inspects the npm package contents before attempting publication.
- [ ] **REL-03**: npm publication uses a repository-bound OIDC trusted publisher with provenance and no long-lived npm write token.
- [ ] **REL-04**: Release automation refuses a version/tag mismatch or failed verification and cannot publish from an untrusted event.

### Consumer Readiness

- [ ] **CONS-01**: Package exports expose ESM JavaScript and TypeScript declarations for the documented public API on Node 22+.
- [ ] **CONS-02**: README and capability documentation state WebP-only, pre-1.0 status; exact guarantees, preservation semantics, and refusals; and ExifTool fallback expectations.
- [ ] **CONS-03**: Fixture provenance documentation distinguishes pinned upstream bytes from locally generated cases and records origin, license, digest, and intended evidence role.
- [ ] **CONS-04**: A consumer example demonstrates exhaustive success/error handling and never implies in-place cleaning, multi-format support, publication, or complete ExifTool replacement.

## Future Requirements

### Format Graduation

- **FMT-01**: Graduate one additional format only after its specification, corpus, adversarial cases, differential oracle, preservation semantics, and refusal boundary are documented and verified.
- **FMT-02**: Add an ExifCleaner adapter that consults `getCapabilities()` and falls back to ExifTool for every unsupported or refused case.
- **FMT-03**: Measure performance and memory on representative corpora before describing the package as faster or smaller in practice.

### Binary Exit

- **EXIT-01**: Consider removal of the bundled ExifTool binary only after every app-required format has graduated with equivalent-or-better correctness evidence and a reversible rollout plan.
- **EXIT-02**: Preserve an explicit fallback or rollback path until production evidence shows no privacy or data-integrity regression.

## Out of Scope

| Feature                                                   | Reason                                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| JPEG, PNG, TIFF, AVIF, PDF, media, or RAW support in v0.1 | Format support is earned independently, not inherited from ExifCleaner or ExifTool.    |
| In-place sanitization                                     | Conflicts with the source-preservation guarantee.                                      |
| Unknown-chunk pass-through                                | Could retain private vendor/workflow metadata under a success result.                  |
| Pixel/frame transcoding                                   | Not needed to enforce metadata policy and risks changing user content.                 |
| ExifTool-compatible CLI/tag completeness                  | The package is a narrow typed engine, not a reimplementation of all ExifTool behavior. |
| ExifCleaner binary removal                                | WebP alone cannot justify eliminating the app's multi-format fallback.                 |
| Runtime networking or telemetry                           | Conflicts with local, deterministic privacy processing.                                |

## Traceability

| Requirement | Phase   | Status  |
| ----------- | ------- | ------- |
| EVID-01     | Phase 1 | Pending |
| EVID-02     | Phase 1 | Pending |
| EVID-03     | Phase 1 | Pending |
| API-01      | Phase 2 | Pending |
| API-02      | Phase 2 | Pending |
| API-03      | Phase 2 | Pending |
| API-04      | Phase 2 | Pending |
| API-05      | Phase 2 | Pending |
| WEBP-01     | Phase 2 | Pending |
| WEBP-02     | Phase 2 | Pending |
| WEBP-03     | Phase 2 | Pending |
| WEBP-04     | Phase 2 | Pending |
| WEBP-05     | Phase 2 | Pending |
| WEBP-06     | Phase 2 | Pending |
| WEBP-07     | Phase 2 | Pending |
| SAFE-01     | Phase 2 | Pending |
| SAFE-02     | Phase 2 | Pending |
| SAFE-03     | Phase 2 | Pending |
| SAFE-04     | Phase 2 | Pending |
| SAFE-05     | Phase 2 | Pending |
| SAFE-06     | Phase 2 | Pending |
| SAFE-07     | Phase 2 | Pending |
| REL-01      | Phase 3 | Pending |
| REL-02      | Phase 3 | Pending |
| REL-03      | Phase 3 | Pending |
| REL-04      | Phase 3 | Pending |
| CONS-01     | Phase 4 | Pending |
| CONS-02     | Phase 4 | Pending |
| CONS-03     | Phase 4 | Pending |
| CONS-04     | Phase 4 | Pending |

**Coverage:**

- v0.1 requirements: 30 total
- Mapped to phases: 30
- Unmapped: 0 ✓

---

_Requirements defined: 2026-08-22_  
_Last updated: 2026-08-22 after initial roadmap mapping_
