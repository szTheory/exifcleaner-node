# Capability Contract

`exifcleaner-node` is pre-1.0. `getCapabilities()` is the machine-readable authority; this document is the complete human-readable `icc-structural-v0.2` policy.

## Supported Surface

| Area         | Contract                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------- |
| Runtime      | Node.js 22+, ESM                                                                                   |
| Formats      | WebP only, detected by `RIFF` + `WEBP` magic                                                       |
| Operations   | `inspectFile`, `sanitizeFile`, `getCapabilities`                                                   |
| Metadata     | Inspect EXIF, XMP, ICC; remove EXIF/XMP; remove or structurally preserve ICC                       |
| Preservation | Orientation, ICC profile, filesystem timestamps when explicitly requested and safely representable |
| Still images | Lossy/lossless and alpha structures that satisfy the supported WebP contract                       |
| Animation    | Recognized container/frame payloads copied byte-for-byte when structure is fully recognized        |
| Cancellation | Optional `AbortSignal` on inspection and sanitization                                              |
| Failures     | Discriminated `MetadataError` returned through `Result`                                            |

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
- `preserveTimestamps`: apply source filesystem timestamps to the verified destination. This does not preserve embedded metadata dates.

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

## Safety Guarantees

| Guarantee                 | Consequence                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Source never overwritten  | `sourcePath` remains unchanged on success and failure.                                                                           |
| Distinct paths            | Equal or aliased source/destination paths are refused.                                                                           |
| Exclusive destination     | A pre-existing destination is never replaced.                                                                                    |
| Owned cleanup             | Cleanup verifies the destination inode immediately before pathname removal; detected replacements are retained and reported.     |
| Full classification first | Unknown/unsupported content is refused before output is accepted as sanitized.                                                   |
| Reopen verification       | A write is not success until the destination reparses and satisfies removal, preservation, structure, and payload checks.        |
| Payload identity          | Image, animation, and admitted ICC payload chunks are copied without decode/re-encode and compared byte-for-byte where retained. |
| Local operation           | No network calls, telemetry, subprocesses, or native-code loading occur in runtime inspection/sanitization.                      |
| Total expected failures   | Consumers branch on `Result.ok` and `MetadataError.code`, not thrown message strings.                                            |

## Explicit Non-Capabilities

- No CMM, color transform, tag-content grammar validation, class-required-tag matrix, registry validation, full ICC semantic conformance, transform-quality evaluation, or color-correctness claim.
- No JPEG, PNG, GIF, TIFF, AVIF, HEIF, PDF, audio, video, RAW, or sidecar support.
- No in-place rewrite, no ExifTool command-line compatibility, and no exhaustive tag database.
- No Electron routing, UI control, native-engine switch, or second native format is introduced by this policy.
- Animation is limited to recognized `ANIM`/`ANMF` structures with validated nested `VP8`, `VP8L`, and optional `ALPH` chunks. Unknown nested chunks are refused.
- No promise that every WebP found in the wild is accepted; refusal is part of the privacy contract.
- Codec validation is limited to VP8/VP8L headers and structural consistency. The engine preserves compressed payload bytes but is not an image decoder.
- No claim that ExifCleaner can remove its bundled ExifTool binary.

Warnings never convert an unsafe or unknown condition into success. Portable Node does not expose an atomic unlink-if-inode-matches primitive. The engine closes the practical race with identity checks and refuses detected replacements, but applications facing actively hostile concurrent directory writers should supply a destination directory those writers cannot modify.

## ExifCleaner Integration Boundary

ExifCleaner should consult capabilities and route only verified supported WebP cases to this library. Every other format and any refused WebP remains on the existing ExifTool path. A future adapter and staged rollout require their own evidence; this contract does not silently change the app.

## Sources

- [WebP Container Specification](https://developers.google.com/speed/webp/docs/riff_container)
- [ICC.1:2022](https://www.color.org/specifications/ICC.1-2022-05.pdf)
- [ICC v2.4 Minor Revision](https://archive.color.org/files/ICC_Minor_Revision_for_Web.pdf)
- [ExifCleaner issue #303](https://github.com/szTheory/exifcleaner/issues/303)
- [Pinned ExifCleaner baseline](https://github.com/szTheory/exifcleaner/commit/ba365b3459b0d87ce255124a5eef819aca603efd)
