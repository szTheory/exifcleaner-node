# Changelog

## Unreleased

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
