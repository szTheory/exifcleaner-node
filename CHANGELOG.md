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
