# exifcleaner-node

A small, typed metadata inspection and sanitization engine for Node.js.

This project is pre-1.0 and supports **WebP only**. It is an evidence-led experiment related to [ExifCleaner issue #303](https://github.com/szTheory/exifcleaner/issues/303), not a complete ExifTool replacement. ExifCleaner should retain ExifTool as the fallback for unsupported formats, features, and refused inputs.

## Install

```sh
npm install exifcleaner-node
```

## Public API

```ts
import {
  classifyFallback,
  getCapabilities,
  inspectFile,
  sanitizeFile,
} from "exifcleaner-node";

const capabilities = getCapabilities();

const controller = new AbortController();
const inspection = await inspectFile("input.webp", {
  signal: controller.signal,
});
if (!inspection.ok) {
  // MetadataError is a discriminated union: switch on inspection.error.code.
  console.error(inspection.error);
} else {
  console.log(inspection.value.entries, inspection.value.warnings);
}

const sanitized = await sanitizeFile({
  sourcePath: "input.webp",
  destinationPath: "output.webp",
  preserveOrientation: true,
  preserveColorProfile: true,
  preserveTimestamps: true,
});

if (sanitized.ok) {
  console.log(sanitized.value.removedNamespaces);
} else if (classifyFallback(sanitized.error) === "safe-to-fallback") {
  // A caller may use one qualified substitute writer here.
  console.error("Use the existing ExifTool substitute once.");
} else {
  console.error(sanitized.error);
}
```

The public contracts are:

- `Inspection`: `{ format: "webp", entries, warnings }`
- `InspectOptions`: `{ signal? }`
- `SanitizeOptions`: `{ sourcePath, destinationPath, preserveOrientation, preserveColorProfile, preserveTimestamps, signal? }`
- `SanitizeResult`: `{ format, destinationPath, removedNamespaces, preserved, warnings }`
- `Result<T, MetadataError>`: a discriminated success/failure union
- `MetadataError`: a discriminated expected-failure union

## Consumer Flow

Call `sanitizeFile` once for one semantic request. A returned successful
`SanitizeResult` is the only completion signal; do not treat a destination
pathname observed during the call as a completed output. On a returned error,
Call `classifyFallback` once. Its only results are `"safe-to-fallback"` and
`"do-not-fallback"`: only the former authorizes at most one ExifTool substitute.
For every other disposition, preserve the original terminal result. Do not retry
the native operation, start a fallback loop, or run another writer after any
uncertainty.

Use `getCapabilities()` as the machine-readable support contract; do not infer support from a filename extension.

## Guarantees

- WebP is detected from file magic, not its extension.
- The source is never overwritten.
- The destination is created exclusively; an existing path is not replaced.
- A failed or cancelled post-create operation retains its structured root error
  and reports whether an owned partial was removed, already missing, replaced
  and left untouched, or may remain after cleanup failed.
- Cleanup and timestamp operations identity-check the exclusively created destination; a detected replacement path is left untouched and reported as `destination-changed`.
- Successful output is synced, independently reopened, parsed, and checked before success is returned.
- Image and animation payload bytes are copied without decoding or re-encoding.
- Runtime processing makes no network request and launches no subprocess.
- Expected failures are returned as typed values.

When `preserveColorProfile` is requested, a WebP ICCP profile is retained only
when it matches the bounded `icc-structural-v0.2` preservation policy. An absent
profile succeeds with `preserved.colorProfile: false`; an admitted profile is
retained byte-for-byte and verified after reopening the destination. Consumers
can switch on the typed refusal fields `code: "unsupported-feature"`,
`feature: "color-profile-preservation"`, and
`reason: "invalid" | "unsupported" | "policy-limit"`. Do not parse diagnostic
`detail` text. This is a structural byte-preservation guarantee, not a claim
about color correctness, transform quality, or full ICC semantic conformance.

## Refusals

The engine fails closed on malformed or truncated containers, unknown chunks, trailing data, unsupported formats or WebP features, ambiguous preservation requests, resource-limit violations, aliased source/destination paths, existing or replaced destinations, cancellation, and I/O failures. Orientation preservation accepts only a single TIFF `SHORT` value from 1 through 8; malformed or unsupported representations return `unsupported-feature` before a destination is created.

Node has no portable atomic “unlink only if this inode still matches” operation. Cleanup checks identity immediately before removal, but callers handling actively hostile concurrent writers should use a destination directory those writers cannot modify.

`getCapabilities()` reports the enforced limits: 16 MiB per metadata chunk, 10,000 aggregate RIFF chunks including nested animation chunks, and WebP's 4 GiB-minus-2-byte size ceiling. It also states that compressed codec validation is header-only: the engine preserves VP8/VP8L bytes but is not an image decoder. Animation support means structurally validated `ANIM`/`ANMF` containers whose nested image payloads can be preserved byte-for-byte; it is not an unlimited frame-count claim.

See the [ICC structural policy and complete capability contract](docs/capabilities.md)
for the detailed rule table and [fixture provenance](docs/fixture-provenance.md)
for the evidence chain.

## Development

Requires Node.js 22 or newer.

```sh
npm ci
npm run verify
```

Useful focused commands are `npm run typecheck`, `npm test`, `npm run build`,
`npm run check:runtime`, and `npm run check:pack`. Protected releases run the
same checks before publishing through npm trusted publishing.

## License

MIT. See [LICENSE](LICENSE).
