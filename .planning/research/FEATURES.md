# Feature Research

**Project:** exifcleaner-node  
**Researched:** 2026-08-22

## Table Stakes for a Privacy-Sensitive Metadata Engine

| Feature                       | v0.1 interpretation                                                                                                           | Complexity | Dependencies                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------ |
| Inspect before changing       | `inspectFile(path)` reports WebP metadata entries and warnings without mutation.                                              | Medium     | Validated parser and typed entries               |
| Sanitize to a new artifact    | `sanitizeFile(options)` requires distinct source/destination paths and never overwrites either.                               | High       | Exclusive I/O, writer, cleanup                   |
| Explicit preservation         | Orientation, ICC profile, and timestamps are opt-in booleans; defaults cannot be inferred from filename or application state. | High       | EXIF handling, ICC chunks, filesystem timestamps |
| Truthful capability discovery | `getCapabilities()` states WebP-only support and preservation/refusal behavior.                                               | Low        | Stable public contract                           |
| Total expected failures       | A discriminated `Result` carries a discriminated `MetadataError`; normal bad input does not leak untyped exceptions.          | Medium     | Error taxonomy across layers                     |
| Output verification           | Success follows a reopen and parse of the final bytes, not merely a successful write call.                                    | High       | Parser independent of writer                     |
| Payload preservation          | Still-image and animation payload bytes remain identical and in order.                                                        | Medium     | Chunk-aware copying                              |
| Cancellation and limits       | Optional `AbortSignal` and bounded input/chunk/resource policy stop work cleanly.                                             | Medium     | Checks at I/O and parse boundaries               |

## Deliberate Differentiators

- Fail closed on unknown chunks and trailing bytes instead of silently copying potential metadata.
- Return which namespaces were removed and what was preserved.
- Treat destination cleanup and non-overwrite behavior as API guarantees, not caller conventions.
- Carry fixture origin and hashes in-repository so privacy claims have an auditable evidence chain.

## Anti-Features

| Anti-feature                             | Why not                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Extension-based detection                | A renamed or mislabeled file must not enter the wrong parser.                       |
| In-place editing                         | Couples parser failure to source data loss.                                         |
| "Strip what we recognize, copy the rest" | Unknown data can be exactly where private workflow information lives.               |
| Pixel decode/re-encode                   | Changes image semantics and adds codec risk unrelated to metadata policy.           |
| Broad format claims                      | ExifCleaner issue #303 explicitly identifies evidence depth as the limiting factor. |
| Success after write without reopen       | Cannot detect a malformed or policy-violating emitted container.                    |
| Network-backed inspection                | Violates the local privacy model and makes results nondeterministic.                |

## Later Features

- Graduate one format at a time with a specification, corpus, differential oracle, and consumer need.
- Add an ExifCleaner adapter while retaining per-format ExifTool fallback.
- Measure throughput and memory before making performance claims.
- Consider binary exit only after app-required formats and preservation semantics are independently verified.

## Primary Sources

- [ExifCleaner issue #303](https://github.com/szTheory/exifcleaner/issues/303) — intended narrow surface and the prerequisite for differential evidence.
- [ExifCleaner issue #299](https://github.com/szTheory/exifcleaner/issues/299) — real report of WebP workflow metadata surviving cleaning.
- [Pinned ExifCleaner strip command](https://github.com/szTheory/exifcleaner/blob/ba365b3459b0d87ce255124a5eef819aca603efd/src/application/commands/strip_metadata_command.ts) — current preservation inputs and ExifTool boundary.
- [WebP Container Specification](https://developers.google.com/speed/webp/docs/riff_container) — standard metadata and reconstruction chunks.
