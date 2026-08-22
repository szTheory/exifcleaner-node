# Capability Contract

`exifcleaner-node` is pre-1.0. `getCapabilities()` is the machine-readable authority; this document explains the intended v0.1 contract for humans.

## Supported Surface

| Area         | v0.1                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| Runtime      | Node.js 22+, ESM                                                                                     |
| Formats      | WebP only, detected by `RIFF` + `WEBP` magic                                                         |
| Operations   | `inspectFile`, `sanitizeFile`, `getCapabilities`                                                     |
| Metadata     | Inspect EXIF, XMP, ICC; remove EXIF/XMP; remove or preserve ICC                                      |
| Preservation | Orientation, color profile, filesystem timestamps when explicitly requested and safely representable |
| Still images | Lossy/lossless and alpha structures that satisfy the supported WebP contract                         |
| Animation    | Container/frame payloads copied byte-for-byte when the structure is fully recognized                 |
| Cancellation | Optional `AbortSignal` on inspection and sanitization                                                |
| Failures     | Discriminated `MetadataError` returned through `Result`                                              |

## Sanitization Semantics

All three preservation booleans are explicit:

- `preserveOrientation`: preserve only a supported orientation value. The original EXIF block is not retained merely to keep orientation. If a minimal safe representation cannot be proven, the request is refused.
- `preserveColorProfile`: retain the recognized `ICCP` chunk. When false, ICC data is removed.
- `preserveTimestamps`: apply source filesystem timestamps to the verified destination. This does not preserve embedded metadata dates.

Orientation is supported only when IFD0 contains one TIFF `SHORT`, count 1, with a value from 1 through 8. A malformed EXIF structure, duplicate tag, different TIFF type/count, or out-of-range value returns `unsupported-feature` when preservation is requested. An absent Orientation is not an error.

On success, `removedNamespaces` lists namespaces absent from the destination. When a minimal Orientation-only EXIF block remains, `EXIF` is intentionally not listed. `preserved` reports which requested values were actually present and retained. Neither field substitutes for the engine's own post-write verification.

## Machine-Readable Limits

The WebP record returned by `getCapabilities()` exposes these enforced values:

| Field                             | Value                     | Meaning                                                                                      |
| --------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------- |
| `limits.maxMetadataBytesPerChunk` | `16777216`                | Maximum buffered size of each ICC, EXIF, or XMP chunk.                                       |
| `limits.maxChunkCount`            | `10000`                   | Aggregate top-level and nested animation chunks accepted during one parse.                   |
| `limits.maxRiffBytes`             | `4294967294`              | WebP's specified maximum whole-file size: 4 GiB minus 2 bytes.                               |
| `animation.boundary`              | `"aggregate-chunk-count"` | Animation has no separate advertised frame cap; frames and nested chunks consume this limit. |

The `refuses` array machine-reports the stable refusal classes. Consumers should inspect returned `MetadataError.code` for the specific failure.

## Safety Guarantees

| Guarantee                 | Consequence                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Source never overwritten  | `sourcePath` remains unchanged on success and failure.                                                                           |
| Distinct paths            | Equal or aliased source/destination paths are refused.                                                                           |
| Exclusive destination     | A pre-existing destination is never replaced.                                                                                    |
| Owned cleanup             | Cleanup verifies the destination inode before pathname removal. A replacement is never removed and yields `destination-changed`. |
| Full classification first | Unknown/unsupported content is refused before output is accepted as sanitized.                                                   |
| Reopen verification       | A write is not success until the destination reparses and satisfies removal, preservation, structure, and payload checks.        |
| Payload identity          | Image and animation payload chunks are copied without decode/re-encode and compared byte-for-byte.                               |
| Local operation           | No network calls, telemetry, subprocesses, or native-code loading occur in runtime inspection/sanitization.                      |
| Total expected failures   | Consumers branch on `Result.ok` and `MetadataError.code`, not thrown message strings.                                            |

## Fail-Closed Refusals

- Missing or incorrect RIFF/WEBP magic.
- Declared RIFF/chunk sizes that overflow, truncate, overlap, or leave a trailer.
- Invalid odd-byte padding or unsupported chunk ordering/duplication/VP8X inconsistency.
- Unknown chunks, including application/vendor chunks not yet classified.
- Unsupported WebP features or preservation representations.
- Input, chunk-count, metadata-size, or other configured resource limits.
- Existing or aliased destination, cancellation, permission failure, timestamp failure, or post-write verification failure.
- Destination pathname replacement during writing, verification, timestamp preservation, or cleanup.

Warnings never convert an unsafe or unknown condition into success.

## Explicit Non-Capabilities

- No JPEG, PNG, GIF, TIFF, AVIF, HEIF, PDF, audio, video, RAW, or sidecar support.
- No in-place rewrite.
- No ExifTool command-line compatibility or exhaustive tag database.
- Animation is limited to recognized `ANIM`/`ANMF` structures with validated nested `VP8`, `VP8L`, and optional `ALPH` chunks. Unknown nested chunks are refused.
- No promise that every WebP found in the wild is accepted; refusal is part of the privacy contract.
- Codec validation is limited to VP8/VP8L headers and structural consistency. The engine preserves compressed payload bytes but is not an image decoder.
- No claim that ExifCleaner can remove its bundled ExifTool binary.

## ExifCleaner Integration Boundary

ExifCleaner should consult capabilities and route only verified supported WebP cases to this library. Every other format and any refused WebP remains on the existing ExifTool path. A future adapter and staged rollout require their own evidence; v0.1 does not silently change the app.

## Sources

- [WebP Container Specification](https://developers.google.com/speed/webp/docs/riff_container)
- [ExifCleaner issue #303](https://github.com/szTheory/exifcleaner/issues/303)
- [ExifCleaner issue #299](https://github.com/szTheory/exifcleaner/issues/299)
- [Pinned ExifCleaner baseline](https://github.com/szTheory/exifcleaner/commit/ba365b3459b0d87ce255124a5eef819aca603efd)
