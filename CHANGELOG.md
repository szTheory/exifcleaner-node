# Changelog

## Unreleased

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
