# exifcleaner-node

A small, typed metadata inspection and sanitization engine for Node.js.

This project is pre-1.0 and supports **WebP only**. It is an evidence-led experiment related to [ExifCleaner issue #303](https://github.com/szTheory/exifcleaner/issues/303), not a complete ExifTool replacement. ExifCleaner should retain ExifTool as the fallback for unsupported formats, features, and refused inputs.

## Install

```sh
npm install exifcleaner-node
```

## Public API

```ts
import { getCapabilities, inspectFile, sanitizeFile } from "exifcleaner-node";

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

if (!sanitized.ok) {
  console.error(sanitized.error);
} else {
  console.log(sanitized.value.removedNamespaces);
}
```

The public contracts are:

- `Inspection`: `{ format: "webp", entries, warnings }`
- `InspectOptions`: `{ signal? }`
- `SanitizeOptions`: `{ sourcePath, destinationPath, preserveOrientation, preserveColorProfile, preserveTimestamps, signal? }`
- `SanitizeResult`: `{ format, destinationPath, removedNamespaces, preserved, warnings }`
- `Result<T, MetadataError>`: a discriminated success/failure union
- `MetadataError`: a discriminated expected-failure union

Use `getCapabilities()` as the machine-readable support contract; do not infer support from a filename extension.

## Guarantees

- WebP is detected from file magic, not its extension.
- The source is never overwritten.
- The destination is created exclusively; an existing path is not replaced.
- A partial destination created by a failed or cancelled call is cleaned up.
- Cleanup and timestamp operations identity-check the exclusively created destination; a detected replacement path is left untouched and reported as `destination-changed`.
- Successful output is synced, independently reopened, parsed, and checked before success is returned.
- Image and animation payload bytes are copied without decoding or re-encoding.
- Runtime processing makes no network request and launches no subprocess.
- Expected failures are returned as typed values.

## Refusals

The engine fails closed on malformed or truncated containers, unknown chunks, trailing data, unsupported formats or WebP features, ambiguous preservation requests, resource-limit violations, aliased source/destination paths, existing or replaced destinations, cancellation, and I/O failures. Orientation preservation accepts only a single TIFF `SHORT` value from 1 through 8; malformed or unsupported representations return `unsupported-feature` before a destination is created.

Node has no portable atomic “unlink only if this inode still matches” operation. Cleanup checks identity immediately before removal, but callers handling actively hostile concurrent writers should use a destination directory those writers cannot modify.

`getCapabilities()` reports the enforced limits: 16 MiB per metadata chunk, 10,000 aggregate RIFF chunks including nested animation chunks, and WebP's 4 GiB-minus-2-byte size ceiling. It also states that compressed codec validation is header-only: the engine preserves VP8/VP8L bytes but is not an image decoder. Animation support means structurally validated `ANIM`/`ANMF` containers whose nested image payloads can be preserved byte-for-byte; it is not an unlimited frame-count claim.

See [capabilities](docs/capabilities.md) for the detailed matrix and [fixture provenance](docs/fixture-provenance.md) for the evidence chain.

## Development

Requires Node.js 22 or newer.

```sh
npm ci
npm run verify
```

Useful focused commands are `npm run typecheck`, `npm test`, `npm run build`, and `npm run check:pack`. Protected releases run the same checks before publishing through npm trusted publishing.

## License

MIT. See [LICENSE](LICENSE).
