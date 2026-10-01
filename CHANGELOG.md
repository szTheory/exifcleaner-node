# Changelog

## Unreleased

### Fixed (PNG)

PNG metadata parsing no longer allows an unbounded amount of non-`IDAT` chunk data to be
buffered in memory during a single parse: aggregate buffered non-`IDAT` data is now capped at
48 MiB, with a typed `unsafe-structure` refusal when the cap is exceeded. A separate memory
retention issue is also fixed -- small chunks read through PNG's shared 64 KiB read-ahead window
are now copied before being stored, instead of retaining a reference to the window's own backing
buffer for the lifetime of the parse. An animation chunk (`acTL`, `fcTL`, `fdAT`) is now refused
inside the parse loop before its data is read, rather than after.

### Added

`getCapabilities()` now reports the new PNG aggregate buffered-metadata limit via
`limits.maxBufferedMetadataBytesTotal`.

## 0.3.1

### Fixed

A successful `sanitizeFile` on macOS and Linux no longer leaves an empty hidden private stage
directory (`.exifcleaner-stage-<uuid>`) beside the output. After the output is committed, the
library now removes only the empty stage directory it created, and only while it still holds
that directory open and the path still matches the directory's original identity (a
non-recursive `rmdir`, never a recursive removal). If removal does not complete -- the directory
is not empty, the identity has changed, or the `rmdir` itself fails -- the result is still a
success, and `postCommitResidue` reports `private-empty-stage-directory-remains` with the
underlying cause. Windows behaviour is unchanged: its opened-directory capability disposition
already reported `{ state: "none" }` on success. The public API and types are unchanged.

## 0.3.0

### Added (JPEG)

Native JPEG sanitize is a closed classification rule (D-01), never a per-identifier keep registry:
every marker segment maps to exactly one of four classes. `SOI`, `EOI`, `DQT`, `DHT`, `DRI`, an
admitted `SOF` (`SOF0` baseline, `SOF1` extended-sequential Huffman, `SOF2` progressive, all 8-bit
only), and every `SOS` plus its entropy-coded scan data are copied byte-identical. An `APP14`
segment identified `Adobe` is always kept, matching ExifTool `-all=`. Every other APPn/`COM` segment
is removed by default -- `APP0` `JFXX`, `APP1` `Exif`/`XMP`/`ExtendedXMP`, `APP2` `FPXR`/`MPF`,
`APP11` (JUMBF/C2PA), `APP13` (Photoshop), any non-`Adobe` `APP14`, every other/unknown `APPn`, and
every `COM`. **Both engines remove C2PA/JUMBF (APP11); ExifTool has deleted JUMBF since 12.64** --
this library's removal is measured parity (D-02), not a difference it introduces.

On request, `APP2` `ICC_PROFILE` is kept byte-identical across every sequence number
(`preserveColorProfile`, the same `icc-structural-v0.2` policy WebP and PNG use), `APP0` `JFIF` is
kept byte-identical (`preserveResolution`, unless an `APP14` `Adobe` segment is also present, D-06:
`JFIF` is then always dropped with no decline), and a minimal EXIF IFD0 is synthesized holding
Orientation and/or X/YResolution (`preserveOrientation`/`preserveResolution`) copied from the
source's own first `APP1` `Exif` segment -- the source Exif segment itself is never copied forward.
A JFIF and an IFD0 resolution source are each kept independently with no reconciliation and no unit
conversion (D-04), matching ExifTool. `preserveOrientation: true` declines pre-write
(`unsupported-feature`, `feature: "orientation-preservation"`) when a non-`eXIf`-analog XMP/
ExtendedXMP `tiff:Orientation` disagrees with or is missing alongside a present EXIF Orientation, or
when an ExtendedXMP cannot be reassembled (D-05); segment order, not "EXIF always wins," decides
which of a disagreeing EXIF/XMP Orientation value ExifTool itself would pick, a correction to an
earlier planning assumption. A `preserveResolution: true` request against a kept `JFIF` carrying a
non-empty embedded thumbnail declines pre-write instead of silently dropping the thumbnail (D-01/
JPG-01).

Every admitted frame class outside baseline/extended-sequential/progressive 8-bit refuses before any
write with one of twelve typed pre-write declines: `malformed-container`, `truncation`,
`undefined-table-reference`, `lossless-frame` (`SOF3`), `hierarchical-frame` (`SOF5`-`SOF7`, `DHP`,
`EXP`), `arithmetic-frame` (`SOF9`-`SOF11`, `SOF13`-`SOF15`, `DAC`), `non-t81-frame` (`JPG`, `JPGn`
including JPEG-LS), `non-8-bit-precision`, `unsupported-component-count`, `dnl-marker`,
`resource-limits`, and `mpf-secondary-image`. Structural caps, derived from a 7,187-real-JPEG plus
ExifTool-corpus census (never lowered to make a fixture pass): `maxSegmentCount` 2048,
`maxScanCount` 512, `maxTableSegmentCount` 512, `maxIccSegments` 255, `maxReassembledIccBytes` and
`maxExtendedXmpBytes` 16 MiB each, `maxFileBytes` 512 MiB. A file above any cap declines pre-write
(`resource-limits`, safe-to-fallback) rather than failing outright.

Anything after the primary `EOI` -- a trailing secondary image, a Multi-Picture Format (MPF, CIPA
DC-007) container, a Google Motion Photo or Adobe gain-map XMP-linked payload, or a Samsung
`SEFH`/`SEFT` embedded-picture trailer -- is truncated at the primary `EOI`, matching ExifTool
`-all=`, which truncates any trailer regardless of content. **Native JPEG removes MPF secondary
images and motion-photo video just as the ExifTool path already does** for every class this phase
measured a clean promotion: a real Google Motion Photo (Google.jpg, D-13), a Google Motion Photo
shape built from an appended MP4 blob, a Samsung SEFH/SEFT trailer, and a malformed MPF index
(truncated or out-of-range, which ExifTool's own `-all=` deletes before ever parsing). Two
constructed classes measured a residual confound -- their "secondary" JPEG reuses the primary's own
DQT/DHT/SOF0/SOS tables, so the sampling method used to measure them cannot distinguish shared
codec-table bytes from an actual leak -- and are recorded refused (`mpf-secondary-image`) per the
measured-refusal rule applied mechanically, not by preference: a CIPA two-image MPF container and an
Adobe-gain-map-shaped MPF container.

`getCapabilities()`'s new `JpegCapabilities` member states these limits and the full `refuses` list
above, plus `preserves.orientation`, `.colorProfile`, `.timestamps` and `.resolution` all `true`.

### Added (PNG)

Native PNG sanitize is closed-list: every chunk not on a code-defined
preserve/remove/conditional list declines the source rather than guessing.
`gAMA` and `sRGB` are always removed, matching ExifTool `-all=` even with
color-profile preservation requested (D-08) -- native never writes a colour
chunk of its own. Apple's `iDOT` chunk is kept, and a request that would
remove a chunk between `iDOT` and the first `IDAT` declines pre-write instead
of writing a stale offset (D-06).

PNG orientation is preserved as a minimal `eXIf` (Orientation only, no writer
defaults) placed immediately after `IHDR`, always before any `iDOT` and the
first `IDAT` (D-11, D-13). Orientation is read only from `eXIf`; a PNG
carrying Orientation only in XMP (`XML:com.adobe.xmp`) or in a legacy
ImageMagick raw EXIF profile (`Raw profile type exif`/`Raw profile type
APP1`), or whose non-`eXIf` Orientation disagrees with `eXIf`, declines
orientation preservation to ExifTool rather than guessing which source wins
(D-11, D-12). Both keywords are recognised in any of `tEXt`, `zTXt` or
`iTXt` -- routed by keyword, not by chunk type (WR-01) -- and XMP carried in
`tEXt`/`zTXt` is reported under the `XMP` namespace exactly like XMP in
`iTXt`. An agreeing or orientation-free non-`eXIf` source does not decline.

PNG decompression is bounded: streaming inflate refuses rather than hangs on
a compression-bomb `iCCP`, `zTXt` or `iTXt` chunk, capped at 16 MiB per
metadata chunk, 16 MiB inflated per ICC profile, 16 MiB inflated per text
chunk, 48 MiB inflated in total, and 10,000 aggregate ancillary chunks
(D-14). The number of `IDAT` chunks is separately capped at 65,536 `IDAT`
chunks, refused as `unsafe-structure` as soon as the count is exceeded and
before that chunk's data or CRC is read, closing a gap where a file of tiny
`IDAT` chunks could occupy sanitize for seconds to minutes with superlinear
cost (CR-02); the cap is 36x the largest `IDAT` count measured across 19,979
real PNGs and still admits 512 MiB of image data at libpng's 8 KiB default
`IDAT` size, so a file above it falls back to ExifTool rather than failing.
`getCapabilities()`'s new `PngCapabilities` member states these limits
(including the new `limits.maxIdatChunkCount`) plus its `refuses` list:
`unknown-critical-chunks`, `malformed-container`, `crc-mismatch`,
`chunk-order`, `truncation`, `trailing-data`, `animation`,
`resource-limits`, `unmeasured-registered-chunks`, and
`unsafe-chunk-adjacency` (the D-06 `iDOT` adjacency decline). `preserves`
reports `orientation`, `colorProfile`, `timestamps` and `resolution` all
`true` -- PNG can honor every preservation flag WebP cannot. A compressed
`iCCP`, `zTXt` or `iTXt` field with bytes after its zlib stream declines
pre-write as `malformed-file` (safe to fall back), closing a gap where an
attacker-appended payload could ride an otherwise legitimate profile past
inflate unnoticed (CR-01); a preserved `iCCP` is therefore always exactly
the profile ExifTool would keep, since native never re-encodes a profile
(D-09).

### Fixed (PNG)

D-05's preserve-list now keeps `mDCV`/`cLLI` (the PNG Third Edition spelling)
byte-identical, corrected from the previously-carried `mDCv`/`cLLi`
lower-last-letter spelling that never appears in the real registry. Measured
against ExifTool 13.59 (2026-09-26): both `-all=` and `-all= -TagsFromFile @
-ICC_Profile` preserve `mDCV`/`cLLI` unchanged. The deprecated `mDCv`/`cLLi`
spelling now declines pre-write as registered-but-unmeasured instead of being
silently preserved.

### Differences from ExifTool

Native strips unregistered private ancillary PNG chunks (a type in neither
the PNG extensions registry nor a measured list) as an opaque payload nobody
can audit, while ExifTool `-all=` keeps them. The known cost: private
functional chunks such as Android `npTc` nine-patch data are removed.
Separately, a chunk registered in the PNG extensions registry but not yet
measured against ExifTool (for example `gIFg`, `dSIG`, `fRAc`) declines to
ExifTool rather than guessing keep or strip.

### Changed

`sanitizeFile` now requires `preserveResolution: boolean`, and
`SanitizeResult.preserved` reports `resolution`. A missing or non-boolean flag
returns `invalid-options`.

### Changed (WebP)

WebP with `preserveResolution: true` now returns a typed admission decline
(`unsupported-feature`, `feature: "resolution-preservation"`) before any
write, and `classifyFallback` returns `safe-to-fallback`. Previously the flag
did not exist. WebP output for `preserveResolution: false` is byte-identical
to 0.2.2.

### Changed (JPEG)

`NativeFormat` widens to `"webp" | "png" | "jpeg"`, and `FormatCapabilities` gains the
`JpegCapabilities` member alongside `WebpCapabilities` and `PngCapabilities`. `inspectFile` and
`removedNamespaces` report JPEG's removable metadata under the existing cross-format `EXIF`, `XMP`,
`ICC` and `C2PA` namespaces, widened by exactly one new member: `JPEG` (JFIF/JFXX density and
thumbnail fields, `COM`, `APP13`, `MPF`, every other removable `APPn`, and trailer data).

### Release

The `release` job now retains the CycloneDX SBOM it already generates as a workflow artifact
(`sbom-cyclonedx`, `if-no-files-found: error`), instead of generating it and discarding it --
`scripts/release_workflow_gate.cjs` fails closed if this retention step is ever removed or moved
before generation.
