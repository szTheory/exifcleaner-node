# Capability Contract

`exifcleaner-node` is pre-1.0. `getCapabilities()` is the machine-readable authority; this document is the complete human-readable `icc-structural-v0.2` policy.

## Supported Surface

| Area         | Contract                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime      | Node.js 22+, ESM                                                                                                                             |
| Formats      | WebP and PNG, both detected by magic: WebP by `RIFF` + `WEBP`, PNG by its 8-byte signature                                                   |
| Operations   | `getCapabilities`, `inspectFile`, `sanitizeFile`, `classifyFallback`                                                                         |
| Metadata     | Inspect EXIF, XMP, ICC; remove EXIF/XMP; remove or structurally preserve ICC                                                                 |
| Preservation | Orientation, ICC profile, filesystem timestamps when explicitly requested and safely representable                                           |
| Resolution   | Capability-gated by `preserves.resolution`; a format reporting `false` (WebP) declines a `preserveResolution: true` request before any write |
| Still images | Lossy/lossless and alpha structures that satisfy the supported WebP contract                                                                 |
| Animation    | Recognized container/frame payloads copied byte-for-byte when structure is fully recognized                                                  |
| Cancellation | Optional `AbortSignal` on inspection and sanitization                                                                                        |
| Failures     | Discriminated `MetadataError` returned through `Result`                                                                                      |

`NativeFormat` is the format-neutral discriminant (currently `"webp" | "png"`).
`FormatCapabilities` is the format-neutral capability union, currently refined
by the supported `WebpCapabilities` and `PngCapabilities` shapes. Admission is
by magic admission: the already-open source must begin with `RIFF` + `WEBP`,
or with PNG's own 8-byte signature, never merely carry a matching extension.
The private registry is frozen and contains only those two qualified
handlers; this package exposes no handler registration API.

## Consumer and Publication Contract

A consumer submits one semantic request through `sanitizeFile` and receives one
verified `SanitizeResult` or one structured terminal/non-admission
`MetadataError`. On an error, call `classifyFallback` once: only
`phase: "admission"` with `nativeWrite: "not-started"` yields
`"safe-to-fallback"`; every other error yields `"do-not-fallback"`. The safe
disposition permits at most one ExifTool substitute, never another native write,
a retry loop, or a second writer after uncertainty. A `preserveResolution: true`
request against a format whose capability reports `preserves.resolution: false`
declines with `unsupported-feature`/`resolution-preservation` before any
destination exists, and is always `"safe-to-fallback"`.

The transaction completes admission before creating a randomly named,
owner-private same-parent stage. It writes, syncs, reopens, verifies, rechecks the
source, applies requested timestamps, and then performs exactly one platform-native
atomic no-replace publication. A collision after the native write has started is
terminal. A successful result is the only completion signal; the private stage path is never exposed.

Success includes `postCommitResidue`. POSIX deterministically retains one empty
private stage directory; Windows may also report that residue if its opened-directory
capability disposition fails. In either case the destination is already committed,
and the residue cannot revoke success. No success contract claims that only the
destination is created.

Pre-publication failures retain their root cause and attach one bounded
`owned-partial-remains` finalization when stage residue is uncertain. They never
use a pathname identity check followed by pathname removal. Windows may report
`owned-partial-removed` only after disposing the opaque opened-directory capability
with no stage file present. All finalization outcomes are terminal and
`"do-not-fallback"`; normal diagnostics remain concise and do not expose private
stage paths, inode values, payload bytes, registry internals, or backend-routing
details.

## ICC Structural Preservation Policy

`preserveColorProfile: true` uses policy `icc-structural-v0.2`. It means **preserve if present**: a WebP with no `ICCP` chunk succeeds and reports `preserved.colorProfile: false`. A present admitted `ICCP` chunk is copied byte-for-byte and the reopened destination proves that byte identity. The engine never repairs, normalizes, reserializes, or transforms a profile.

The policy admits only these structural header values:

| Field              | Admitted value                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ICC version        | Classic v2.0–v2.4 or v4.0–v4.4                                                                                                                                                                                                                    |
| Version bytes 8–11 | Byte 8 is `02h` or `04h`; byte 9 has BCD minor digit `0`–`4` and BCD bug-fix digit `0`–`9`; reserved bytes 10–11 are zero. Thus byte 9 is one of `00h`–`09h`, `10h`–`19h`, `20h`–`29h`, `30h`–`39h`, or `40h`–`49h`, never a raw binary interval. |
| Device class       | `scnr` (input) or `mntr` (display)                                                                                                                                                                                                                |
| Data color space   | `RGB `                                                                                                                                                                                                                                            |
| PCS                | `XYZ ` or `Lab `                                                                                                                                                                                                                                  |
| Signature and size | `acsp`; declared size exactly matches the payload; total profile length is four-byte aligned                                                                                                                                                      |
| Date and intent    | Valid creation date; rendering intent 0–3                                                                                                                                                                                                         |
| v2 tail            | Bytes 84–127 are reserved and zero                                                                                                                                                                                                                |
| v4 tail            | Bytes 84–99 are the Profile ID: zero is accepted, otherwise it must match the ICC MD5 conformance procedure. Bytes 100–127 are reserved and zero.                                                                                                 |
| v4 illuminant      | Header D50 PCS illuminant is exactly `0000f6d6 00010000 0000d32d`                                                                                                                                                                                 |

The Profile ID check is an ICC conformance/integrity check, not a cryptographic-security claim.

### Tag Table and Layout Rules

The profile must be at least 132 bytes, contain a nonempty tag table, and stay within both advertised ceilings: at most 16 MiB total profile bytes and at most 4,096 tag records. Counts, table sizes, offsets, and lengths are bounded before use.

Each tag record must have a unique nonzero signature. Its payload must begin after the complete tag table on a four-byte boundary, have a nonzero size of at least the eight-byte type header, lie wholly inside the profile, and have zero type-header reserved bytes. Different tag signatures may share a payload only when `(offset, size)` is exactly identical; partial overlaps, table/header references, zero-sized ranges, and ambiguous sharing are refused.

After exact aliases are collapsed, distinct payload ranges are sorted by physical offset. The first payload must immediately follow the table; every later payload must follow the preceding payload with only the required zero padding (0–3 bytes); and the final padded payload must end exactly at EOF. Gaps, nonzero padding, trailers, and noncanonical layouts are refused.

Tag contents are otherwise opaque. This policy validates the bounded container structure needed to preserve original bytes; it does not interpret a tag's semantic content.

### Outcomes and Refusals

When requested preservation sees a present profile that is malformed, outside the admitted subset, or above a policy limit, sanitization returns before it creates a destination:

```ts
{
  code: "unsupported-feature",
  feature: "color-profile-preservation",
  reason: "invalid" | "unsupported" | "policy-limit",
}
```

Consumers may switch on `code`, `feature`, and `reason`. `detail` is concise diagnostic context only and is not a compatibility contract; do not parse it. This phase establishes only the observably pre-write refusal. Phase 45 owns the canonical fallback disposition. Cancellation and any I/O, verification, cleanup, or file-identity uncertainty remain terminal outcomes.

`preserveColorProfile: false` skips ICC admission, removes the admitted-container `ICCP` content, rebuilds the VP8X ICC bit from retained chunks, reopens the destination, and proves no ICCP remains. This succeeds even when diagnostic ICC inspection reports warnings. Inspection warnings are informational and never authorize requested preservation.

## Sanitization Semantics

All three preservation booleans are explicit:

- `preserveOrientation`: preserve only a supported orientation value. The original EXIF block is not retained merely to keep orientation. If a minimal safe representation cannot be proven, the request is refused.
- `preserveColorProfile`: apply the structural policy above when an `ICCP` chunk is present; otherwise report requested-but-absent preservation truthfully.
- `preserveTimestamps`: apply source filesystem `atime and mtime only` to the
  verified destination, then verify the safely representable precision. This
  does not preserve embedded metadata dates, birth time, change time, or source
  atime. The package never restores source atime because doing so would mutate
  the source after a read.

Orientation is supported only when IFD0 contains one TIFF `SHORT`, count 1, with a value from 1 through 8. A malformed EXIF structure, duplicate tag, different TIFF type/count, or out-of-range value returns `unsupported-feature` when preservation is requested. An absent Orientation is not an error.

On success, `removedNamespaces` lists namespaces absent from the destination. When a minimal Orientation-only EXIF block remains, `EXIF` is intentionally not listed. `preserved` reports which requested values were actually present and retained. Neither field substitutes for the engine's post-write verification.

## Machine-Readable Limits

The WebP record returned by `getCapabilities()` exposes these enforced values:

| Field                             | Value                   | Meaning                                                                                      |
| --------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `colorProfile.policy`             | `icc-structural-v0.2`   | Stable name for the structural ICC preservation subset.                                      |
| `colorProfile.preservation`       | `preserve-if-present`   | An absent ICCP is a successful non-preservation outcome.                                     |
| `colorProfile.maxProfileBytes`    | `16777216`              | Maximum admitted ICC profile payload.                                                        |
| `colorProfile.maxTagCount`        | `4096`                  | Maximum admitted ICC tag records.                                                            |
| `limits.maxMetadataBytesPerChunk` | `16777216`              | Maximum buffered size of each ICC, EXIF, or XMP chunk.                                       |
| `limits.maxChunkCount`            | `10000`                 | Aggregate top-level and nested animation chunks accepted during one parse.                   |
| `limits.maxRiffBytes`             | `4294967294`            | WebP's specified maximum whole-file size: 4 GiB minus 2 bytes.                               |
| `animation.boundary`              | `aggregate-chunk-count` | Animation has no separate advertised frame cap; frames and nested chunks consume this limit. |

The `refuses` array machine-reports stable container refusal classes. Consumers should inspect returned `MetadataError.code` and, for ICC preservation, the typed fields above.

## Per-Format Preservation Capabilities

`getCapabilities().formats` is a discriminated union on `format`. Every member's
`preserves` object carries `orientation`, `colorProfile`, `timestamps`, and
`resolution` as required booleans; none of these fields is ever optional.

The meaning of `preserves.resolution` is fixed and does not vary by format:

- `true` means the format's resolution-bearing data (for example PNG's `pHYs`
  chunk, or JPEG's JFIF/EXIF density fields) is always retained or explicitly
  preserved by the handler, so a `preserveResolution: true` request may be
  routed to this native library.
- `false` means the handler cannot honor that request, so a consumer must
  route the request to ExifTool instead.

There is no third state.

WebP reports `resolution: false`. WebP has no dedicated resolution-bearing
chunk in its supported surface, and native WebP resolution preservation is
future work (FUT-01), not a capability of the current handler. PNG reports
`resolution: true`: its `pHYs` chunk is always kept byte-identical when
`preserveResolution: true` (see "## PNG" below).

Capability-shape changes -- adding a required field to `CommonFormatCapabilities`
or widening the discriminated union with a new format -- are a minor version
bump under this package's semver policy. This shape (the `resolution` field
added in KIT-03) ships as part of `exifcleaner-node@0.3.0`, published once the
PNG and JPEG handlers land in Phases 56 and 57.

The ExifCleaner app reads only `preserves.orientation`, `preserves.colorProfile`,
and `preserves.timestamps` until its own adoption phase; it does not yet read
`preserves.resolution`.

## PNG

PNG admission is a **closed preserve-list**, never a delete-list: a chunk type
that is not on one of three code-defined lists declines the whole source with
a typed pre-write `unsafe-structure` refusal, rather than guessing whether to
keep or strip it.

- **Always kept** (critical): `IHDR`, `PLTE`, `IDAT`, `IEND`.
- **Always kept** (measured against ExifTool `-all=`, `PNG_PRESERVED_CHUNK_TYPES`):
  `tRNS`, `cHRM`, `bKGD`, `sBIT`, `sPLT`, `hIST`, `cICP`, `mDCv`, `cLLi`,
  `sCAL`, `oFFs`, `pCAL`, `sTER`, `iDOT`, `vpAg`.
- **Always removed** (`PNG_REMOVED_CHUNK_TYPES`): `tEXt`, `zTXt`, `iTXt`,
  `eXIf`, `tIME`, `caBX` (C2PA), and -- matching ExifTool's own behavior even
  with color-profile preservation requested -- `gAMA` and `sRGB`. The handler
  never writes a colour chunk of its own; it only removes chunks or copies
  them byte-identically (D-09).
- **Conditional** (`PNG_CONDITIONAL_CHUNK_TYPES`): `iCCP` is kept
  byte-identical in place when `preserveColorProfile: true` (after its
  bounded-inflate profile passes the same `icc-structural-v0.2` policy WebP
  uses), else removed. `pHYs` is kept byte-identical in its original relative
  position when `preserveResolution: true`, else removed.
- **Unregistered private ancillary chunk** (a type in neither the PNG
  extensions registry nor any of the lists above, for example Android's
  `npTc` nine-patch data) is **stripped** as a privacy-reasoned difference
  from ExifTool `-all=`, which keeps it: an opaque payload nobody can audit.
  Its type is recorded so a permitted-difference kind can grant it in the
  differential harness.
- **Registered but unmeasured ancillary chunk** (present in the PNG
  extensions registry but not on any list above, for example `gIFg`, `gIFt`,
  `gIFx`, `dSIG`, `fRAc`, or the upper-last-letter `mDCV`/`cLLI` casing)
  declines the source with a typed pre-write refusal
  (`unmeasured-registered-chunks` in `refuses`). A future measurement can
  graduate such a type onto one of the lists above; the handler never
  guesses.
- **`iDOT` adjacency** (Apple's private chunk, D-06): its offsets are
  relative to its own chunk start, so nothing may be inserted or removed
  between `iDOT` and the first `IDAT`. A request that would remove a chunk in
  that span declines with a typed pre-write refusal
  (`unsafe-chunk-adjacency` in `refuses`) instead of writing a stale offset.

### PNG orientation (D-11, D-12, D-13)

`eXIf` is PNG's only orientation source: when `preserveOrientation: true` and
`eXIf` IFD0 tag `0x0112` (Orientation) is valid (1-8), the source `eXIf` is
removed and a minimal `eXIf` -- Orientation only, via `createOrientationExif`,
no writer defaults such as `YCbCrPositioning` -- is inserted immediately after
`IHDR`, always before any `iDOT` and the first `IDAT`. The destination is
re-parsed and the inserted `eXIf` compared byte-for-byte against
`createOrientationExif(orientation)` before publication.

A PNG whose Orientation comes only from an XMP `iTXt` (`tiff:Orientation`,
keyword `XML:com.adobe.xmp`) or a legacy ImageMagick raw-EXIF-profile text
chunk (`tEXt`/`zTXt` keyword `Raw profile type exif` or
`Raw profile type APP1`) -- or whose non-`eXIf` Orientation disagrees with
`eXIf` -- declines orientation preservation (`unsupported-feature`,
`feature: "orientation-preservation"`) before any write, rather than guessing
which source should win: ExifTool's own pick in that case depends on chunk
order, and promoting an XMP-only Orientation into a fresh `eXIf` would rotate
pixels in viewers that currently display the image unrotated. An agreeing
non-`eXIf` Orientation, or a non-`eXIf` block carrying no Orientation, does
not decline. These readers return only a routing value or its absence -- their
bytes never reach the output -- and the raw-EXIF-profile reader's declared
byte count is bounds-checked against the same text-decompression limit as
`tEXt`/`zTXt` (`PNG_MAX_INFLATED_TEXT_BYTES`) before any hex is decoded,
independent of any preservation flag.

### PNG namespace mapping (D-15)

`inspectFile` and `removedNamespaces` report PNG's removable metadata under
the same closed namespace set (`EXIF`, `XMP`, `ICC`, `PNG`, `C2PA`) every
format uses. No entry is produced for `pHYs`, `gAMA`, or `sRGB`, or an
unregistered chunk stripped under D-05 -- those are reported through
`removedNamespaces`/`preserved` only, never as an inspection entry.

| Chunk                               | Namespace | Entry                                                                                                                         |
| ----------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `eXIf`                              | `EXIF`    | One entry per decoded EXIF tag (`parseExif`).                                                                                 |
| `iCCP` (inflated)                   | `ICC`     | One entry per decoded ICC field (`parseIcc`).                                                                                 |
| `tEXt`                              | `PNG`     | `{ name: keyword, value: Latin-1 text }`.                                                                                     |
| `zTXt` (inflated)                   | `PNG`     | `{ name: keyword, value: Latin-1 text }`.                                                                                     |
| `iTXt`, keyword `XML:com.adobe.xmp` | `XMP`     | One entry per decoded XMP property (`parseXmp`).                                                                              |
| `iTXt`, any other keyword           | `PNG`     | `{ name: keyword, value: UTF-8 text }`; invalid UTF-8 adds a `metadata-invalid` warning and produces no entry (fatal decode). |
| `tIME`                              | `PNG`     | `{ name: "ModifyDate", value: "YYYY:MM:DD HH:MM:SS" }`.                                                                       |
| `caBX` (C2PA)                       | `C2PA`    | `{ name: "JUMBF", value: <byte length of the chunk data> }`. The JUMBF box contents are never parsed.                         |
| `pHYs`, `gAMA`, `sRGB`              | `PNG`     | No entry -- reported only via `removedNamespaces`/`preserved.resolution`.                                                     |

Every successful PNG sanitize re-parses the staged destination (CRC and chunk
order re-checked), asserts its chunk-type sequence against the plan computed
from admission, and compares every kept chunk byte-for-byte against its
source range before publication. A mismatch is `verification-failed` and the
destination is never published.

## Safety Guarantees

| Guarantee                 | Consequence                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Source never overwritten  | `sourcePath` remains unchanged on success and failure.                                                                           |
| Distinct paths            | Equal or aliased source/destination paths are refused.                                                                           |
| Atomic no-replace publish | A pre-existing destination is never replaced; the native publication call is the single success authority.                       |
| Stage finalization        | Error cleanup never removes a pathname. Only a Windows opened-directory capability may dispose a directory-only stage.           |
| Full classification first | Unknown/unsupported content is refused before output is accepted as sanitized.                                                   |
| Reopen verification       | A write is not success until the destination reparses and satisfies removal, preservation, structure, and payload checks.        |
| Payload identity          | Image, animation, and admitted ICC payload chunks are copied without decode/re-encode and compared byte-for-byte where retained. |
| Local operation           | No network calls, telemetry, or subprocesses occur in runtime inspection/sanitization.                                           |
| Total expected failures   | Consumers branch on `Result.ok` and `MetadataError.code`, not thrown message strings.                                            |
| Output mode               | Output is created with non-executable ordinary permission bits no more permissive than the source, subject to umask.             |

## Filesystem Boundaries and Non-Guarantees

The private-stage/native no-replace policy prevents replacement of a pre-existing
destination but does not claim atomic rollback or in-place overwrite. A process
crash or power loss may leave private-stage residue. Portable Node cannot promise
universal directory durability or locking. Pre-publication uncertainty deliberately
does not attempt pathname removal, so a concurrent replacement cannot gain cleanup
authority.

The package does not promise or copy birth time, change time, owner/group, ACLs,
xattrs, quarantine/SELinux labels, hard-link topology, sparse allocation, or
other broad filesystem attributes. It does not reproduce exact POSIX modes,
setuid, setgid, sticky, executable bits, ownership, or ACL policy across
platforms. Electron's separately qualified macOS xattr handling is outside this
package.

## Explicit Non-Capabilities

- No CMM, color transform, tag-content grammar validation, class-required-tag matrix, registry validation, full ICC semantic conformance, transform-quality evaluation, or color-correctness claim.
- No JPEG, GIF, TIFF, AVIF, HEIF, PDF, audio, video, RAW, or sidecar support. No APNG (refused as an animation, FUT-03).
- No in-place rewrite, no ExifTool command-line compatibility, and no exhaustive tag database.
- No Electron routing, UI control, native-engine switch, or second native format is introduced by this policy.
- Animation is limited to recognized `ANIM`/`ANMF` structures with validated nested `VP8`, `VP8L`, and optional `ALPH` chunks. Unknown nested chunks are refused.
- No promise that every WebP found in the wild is accepted; refusal is part of the privacy contract.
- Codec validation is limited to VP8/VP8L headers and structural consistency. The engine preserves compressed payload bytes but is not an image decoder.
- No claim that ExifCleaner can remove its bundled ExifTool binary.

Warnings never convert an unsafe or unknown condition into success. Portable Node
does not expose an atomic unlink-if-identity-matches primitive, so this contract never
uses identity-check-then-remove cleanup. Concurrent private-stage replacements are
left untouched with bounded residue rather than treated as removable.

## ExifCleaner Integration Boundary

ExifCleaner should consult capabilities and route only verified supported WebP cases to this library. Every other format and any refused WebP remains on the existing ExifTool path. A future adapter and staged rollout require their own evidence; this contract does not silently change the app.

## Automated WebP Qualification

The supported WebP contract is admitted by several independent automated
authorities. No passing layer substitutes for another:

- deterministic grammar and hostile cases prove fail-closed container
  admission, including accepting and rejecting directions;
- transaction fault and barrier cases prove unchanged sources, no-replace
  destinations, at most one writer, bounded cancellation, and truthful terminal
  finalization;
- every successful case is reopened to prove metadata removal or requested
  preservation and byte-identical retained compressed image/animation payloads;
- pinned independent decoding proves the bounded still and animation samples
  remain decodable with the same canvas, timing, and frame evidence;
- a pinned metadata differential proves the expected namespaces are absent or
  preserved with no unreviewed difference;
- the exact packed artifact is installed with scripts disabled and exercised on
  Linux, macOS, and Windows, on x64 and arm64, under Node.js 22 and 24; and
- a fresh-process Linux x64 comparison against packed `v0.1.1` admits the locked
  time, peak-memory, payload-size slope, and cancellation limits documented in
  [WebP Benchmark Admission](benchmark-admission.md).

The final Phase 46 conclusion exists only when the immutable implementation and
tarball identities, corpus manifest, oracle authorities, all twelve installed
platform/runtime conclusions, and both benchmark conclusions agree. Pull
request benchmark reports remain visible but informational; explicit phase and
release admission uses the hard verdict.

These checks establish the behaviors named above for the committed bounded
corpus. They do not convert structural parsing into a decoder, establish color
correctness or browser parity, prove universal WebP conformance, or admit
unknown containers. Refusal remains a supported and intentional result.

## Sources

- [WebP Container Specification](https://developers.google.com/speed/webp/docs/riff_container)
- [ICC.1:2022](https://www.color.org/specifications/ICC.1-2022-05.pdf)
- [ICC v2.4 Minor Revision](https://archive.color.org/files/ICC_Minor_Revision_for_Web.pdf)
- [ExifCleaner issue #303](https://github.com/szTheory/exifcleaner/issues/303)
- [Pinned ExifCleaner baseline](https://github.com/szTheory/exifcleaner/commit/ba365b3459b0d87ce255124a5eef819aca603efd)
