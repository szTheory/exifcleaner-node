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
carrying Orientation only in XMP, or in a legacy ImageMagick raw EXIF profile
(`Raw profile type exif`/`Raw profile type APP1`), or whose non-`eXIf`
Orientation disagrees with `eXIf`, declines orientation preservation to
ExifTool rather than guessing which source wins (D-11, D-12). An agreeing or
orientation-free non-`eXIf` source does not decline.

PNG decompression is bounded: streaming inflate refuses rather than hangs on
a compression-bomb `iCCP`, `zTXt` or `iTXt` chunk, capped at 16 MiB per
metadata chunk, 16 MiB inflated per ICC profile, 16 MiB inflated per text
chunk, 48 MiB inflated in total, and 10,000 aggregate ancillary chunks
(D-14). `getCapabilities()`'s new `PngCapabilities` member states these
limits plus its `refuses` list: `unknown-critical-chunks`,
`malformed-container`, `crc-mismatch`, `chunk-order`, `truncation`,
`trailing-data`, `animation`, `resource-limits`,
`unmeasured-registered-chunks`, and `unsafe-chunk-adjacency` (the D-06 `iDOT`
adjacency decline). `preserves` reports `orientation`, `colorProfile`,
`timestamps` and `resolution` all `true` -- PNG can honor every preservation
flag WebP cannot.

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
