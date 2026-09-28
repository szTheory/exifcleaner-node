# exifcleaner-node

A small, typed metadata inspection and sanitization engine for Node.js.

This project is pre-1.0 and supports **WebP, PNG and JPEG**. It is an evidence-led experiment related to [ExifCleaner issue #303](https://github.com/szTheory/exifcleaner/issues/303), not a complete ExifTool replacement. ExifCleaner should retain ExifTool as the fallback for unsupported formats, features, and refused inputs.

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

- `Inspection`: `{ format: NativeFormat, entries, warnings }`
- `InspectOptions`: `{ signal? }`
- `SanitizeOptions`: `{ sourcePath, destinationPath, preserveOrientation, preserveColorProfile, preserveTimestamps, signal? }`
- `SanitizeResult`: `{ format, destinationPath, removedNamespaces, preserved, warnings, postCommitResidue }`
- `Result<T, MetadataError>`: a discriminated success/failure union
- `MetadataError`: a discriminated expected-failure union

The support contract is stated in format-neutral vocabulary rather than in
WebP-specific fields, so a future format is additive rather than breaking:

- `NativeFormat`: the format tag carried by `Inspection.format` and
  `SanitizeResult.format`. It is currently `"webp" | "png" | "jpeg"`; read it, do
  not assume it.
- `Capabilities` / `FormatCapabilities`: what `getCapabilities()` returns.
  `formats` is a non-empty list of per-format contracts, each stating
  `detection: "magic"` — recognition is by file magic, never by extension.
  `WebpCapabilities`, `PngCapabilities` and `JpegCapabilities` are the
  `FormatCapabilities` members today.
- `FallbackDisposition`: `"safe-to-fallback" | "do-not-fallback"`, the return of
  `classifyFallback`.
- `PostCommitResidue`: the bounded private-stage residue reported on success.

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

- WebP, PNG and JPEG are each detected from file magic, not their extension.
- Both the native path and the ExifTool fallback remove C2PA/JUMBF metadata
  identically (measured parity, not a difference this library introduces): a
  JPEG `APP11` JUMBF/C2PA manifest and a PNG `caBX` chunk are removed by both
  engines, since ExifTool's own `-all=` has deleted JUMBF since version 12.64.
- Native JPEG truncates any trailing data after the primary `EOI` — including
  a Multi-Picture Format (MPF, CIPA DC-007) container, a real Google Motion
  Photo, and a Samsung `SEFH`/`SEFT` embedded-picture trailer — exactly as the
  ExifTool fallback already does; a measured-unsafe MPF secondary image or
  gain-map trailer declines pre-write (`mpf-secondary-image`) instead of
  truncating silently. See [format admission criteria](docs/format-admission.md)
  and `docs/capabilities.md`'s "JPEG trailer truncation" section for the full
  measured decision table.
- The source is never overwritten.
- Output is written in a private same-parent stage and published once through a
  native atomic no-replace operation; an existing destination is never replaced.
- A failed or cancelled post-create operation retains its structured root
  error and reports bounded private-stage residue.
  Pre-publication uncertainty never performs pathname cleanup: Windows may
  dispose an already-open private directory capability only when no stage
  file exists; otherwise residue remains.
- A successful result carries `postCommitResidue`. After the output is
  committed the library removes its own empty private stage directory: POSIX
  performs one non-recursive `rmdir` of the directory it still holds open,
  only while the path still has that directory's identity; Windows disposes
  its opened-directory capability. If that removal does not complete, the
  result is still a success and `postCommitResidue` reports
  `private-empty-stage-directory-remains` with the cause. That private path
  is never exposed and cannot revoke the committed destination.
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

Pre-publication cleanup never relies on pathname identity comparison: an observed
stage replacement is retained untouched rather than removed.

`getCapabilities()` reports the enforced limits: 16 MiB per metadata chunk, 10,000 aggregate RIFF chunks including nested animation chunks, and WebP's 4 GiB-minus-2-byte size ceiling. It also states that compressed codec validation is header-only: the engine preserves VP8/VP8L bytes but is not an image decoder. Animation support means structurally validated `ANIM`/`ANMF` containers whose nested image payloads can be preserved byte-for-byte; it is not an unlimited frame-count claim.

See the [ICC structural policy and complete capability contract](docs/capabilities.md)
for the detailed rule table, [fixture provenance](docs/fixture-provenance.md)
for the evidence chain, the [native prebuild policy](docs/prebuild-policy.md)
for how prebuilds are built, attested, and verified, the
[CI scope and minutes budget](docs/ci-budget.md) for how CI decides what to run and what it costs,
and the [format admission criteria](docs/format-admission.md) for the tiered evidence every
registered format must clear.

## Development

Requires Node.js 22 or newer.

```sh
npm ci
npm run verify
```

`npm run verify` compiles the native publication addon with `npm run build:native`, so it also
needs a C toolchain: Xcode Command Line Tools on macOS, build-essential on Linux, or Visual Studio
Build Tools with the C++ workload on Windows. Prebuilds are not committed — see the
[native prebuild policy](docs/prebuild-policy.md) for why and how consumers verify them.

Useful focused commands are `npm run typecheck`, `npm test`, `npm run build`,
`npm run check:runtime`, and `npm run check:pack`. Protected releases run the
same checks before publishing through npm trusted publishing.

## License

MIT. See [LICENSE](LICENSE).
