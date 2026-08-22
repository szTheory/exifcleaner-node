# Architecture Research

**Project:** exifcleaner-node  
**Researched:** 2026-08-22

## Proposed Boundaries

```text
public API
  inspectFile ───────┐
  sanitizeFile ──────┼─> filesystem orchestration ─> WebP parser/policy/writer
  getCapabilities ──┘              │                         │
                              typed Result              pure byte model
                                      └──── reopen verification ────┘
```

| Component          | Owns                                                                                  | Must not own                    |
| ------------------ | ------------------------------------------------------------------------------------- | ------------------------------- |
| Public API         | Stable functions and exported result/error/types                                      | RIFF offsets or raw `fs` errors |
| File orchestration | Magic-byte dispatch, limits, exclusive destination, cleanup, timestamps, cancellation | Metadata policy guesses         |
| WebP parser        | RIFF/WEBP validation, bounded chunk iteration, padding/order/feature consistency      | Filesystem mutation             |
| Policy             | Classification into remove, preserve, payload, or refuse                              | Byte-level I/O                  |
| WebP writer        | Size recomputation, VP8X flag updates, byte-for-byte payload copying                  | Decoding or transcoding         |
| Verifier           | Reparse destination, assert requested removals/preservations and structural integrity | Trusting writer state           |

## Data Flow

1. Validate arguments, distinct paths, cancellation state, source type, and input limit.
2. Read enough bytes to identify `RIFF` + `WEBP`; extension is irrelevant.
3. Parse all declared chunks with overflow, boundary, padding, order, duplication, and trailer checks.
4. Classify every chunk. Refuse anything unknown or unsupported before destination creation.
5. Build an output plan: remove `EXIF`/`XMP `, optionally preserve minimal orientation/ICC, copy reconstruction and animation payloads byte-for-byte, and update `VP8X` flags/sizes.
6. Create the destination exclusively, write the complete planned bytes, then close and reopen it.
7. Reparse and verify structural/policy/payload invariants. Restore timestamps only when requested.
8. Return `ok: true` with `SanitizeResult`; on every failure, remove a destination created by this invocation and return a typed error.

## Build Order

1. Evidence fixtures and pure parser invariants.
2. Policy and writer against in-memory fixtures.
3. Filesystem transaction and public API.
4. Release automation.
5. Consumer documentation and integration contract.

The parser precedes the writer so the same independent code can reopen and judge emitted bytes. Release automation follows behavioral verification so distribution cannot outrun the support contract.

## Compatibility Boundary with ExifCleaner

ExifCleaner at the pinned SHA reads JSON metadata and strips with preservation options through an ExifTool port. This package should be integrated later as another adapter, selected only for capabilities it reports. It must not imitate the ExifTool CLI or force a big-bang replacement.

## Primary Sources

- [WebP Container Specification](https://developers.google.com/speed/webp/docs/riff_container) — normative container and ordering rules.
- [WebP Container API](https://developers.google.com/speed/webp/docs/container-api) — upstream component model for image frames and ICC/EXIF/XMP chunks.
- [Pinned ExifCleaner command boundary](https://github.com/szTheory/exifcleaner/blob/ba365b3459b0d87ce255124a5eef819aca603efd/src/application/commands/strip_metadata_command.ts) — current call shape.
- [Pinned ExifCleaner main handler](https://github.com/szTheory/exifcleaner/blob/ba365b3459b0d87ce255124a5eef819aca603efd/src/main/exif_handlers.ts) — application integration boundary.
