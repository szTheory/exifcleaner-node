# Pitfalls Research

**Project:** exifcleaner-node  
**Researched:** 2026-08-22

| Pitfall                                         | Early warning                                                        | Prevention                                                                                                       | Phase |
| ----------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----- |
| Treating RIFF size as trustworthy               | Slice/read crosses buffer end; integer wrap; unexplained trailer     | Validate header, declared file size, each `8 + size + pad`, safe integer arithmetic, and exact end-of-container. | 1–2   |
| Removing chunks but leaving VP8X claims         | Output says EXIF/XMP/ICCP exists when it does not, or the reverse    | Recompute relevant feature bits from output and reparse.                                                         | 2     |
| Dropping odd-byte padding incorrectly           | Later FourCC is shifted; decoder behavior differs                    | Preserve/rebuild one zero pad byte for odd payload sizes and reject nonconforming input under v0.1 policy.       | 1–2   |
| Copying unknown chunks                          | ComfyUI or vendor metadata survives while result claims sanitization | Refuse unknown FourCCs until explicitly classified with evidence.                                                | 1–2   |
| Preserving whole EXIF to keep orientation       | Camera, author, GPS, or thumbnail metadata survives                  | Parse orientation and emit only the minimal supported representation; otherwise refuse preservation.             | 2     |
| Mutating image data through a codec             | Pixels, frame timing, compression, or alpha change                   | Never decode; compare payload chunks byte-for-byte and in order.                                                 | 2     |
| Destination race or overwrite                   | Existing destination changes between check and write                 | Use exclusive create, not check-then-write.                                                                      | 2     |
| Partial output survives failure/cancel          | Destination exists after a returned error                            | Track ownership of the created path and clean it on every non-success exit.                                      | 2     |
| Writer verifies itself                          | Same misunderstanding exists in emit and check logic                 | Reopen through the parser and assert independent invariants; retain differential fixtures.                       | 1–2   |
| Fixture laundering                              | Copied bytes have no origin/license/hash                             | Pin SHA, path, retrieval URL, size, digest, and role in `docs/fixture-provenance.md`.                            | 1     |
| Release outruns package trust setup             | Tag exists but npm publish fails or uses a long-lived secret         | Verify clean build/package first; use protected GitHub environment and npm OIDC trusted publisher.               | 3     |
| One green format becomes a binary-removal claim | ExifCleaner loses coverage or edge-case depth                        | Keep per-format capabilities and ExifTool fallback; treat binary exit as a future independent decision.          | 4+    |

## Highest-Risk Semantic Edge

Orientation is stored inside EXIF, not as a separate WebP chunk. "Preserve orientation" therefore cannot mean keeping the original EXIF payload. The implementation must either extract and reconstruct only a proven minimal orientation value or refuse the preservation request. A warning is not an adequate substitute for this privacy boundary.

## Corpus Warning

The pinned 152-byte `sample.webp` is valuable provenance evidence but not a complete corpus. It covers a tiny still WebP with EXIF. Separate generated cases are needed for lossless/lossy, alpha, ICC, XMP, duplicate metadata chunks, animation, odd padding, size boundaries, truncation, trailers, unknown chunks, aborts, and filesystem races. Generated fixtures must be labeled generated rather than implied to come from upstream.

## Primary Sources

- [WebP Container Specification](https://developers.google.com/speed/webp/docs/riff_container)
- [ExifCleaner issue #303](https://github.com/szTheory/exifcleaner/issues/303)
- [ExifCleaner issue #299](https://github.com/szTheory/exifcleaner/issues/299)
- [Pinned upstream fixture directory](https://github.com/szTheory/exifcleaner/tree/ba365b3459b0d87ce255124a5eef819aca603efd/tests/e2e/fixtures)
- [Node.js 22 file system API](https://nodejs.org/docs/latest-v22.x/api/fs.html)
