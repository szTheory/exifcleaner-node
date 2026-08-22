# Project Research Summary

**Project:** exifcleaner-node  
**Researched:** 2026-08-22  
**Confidence:** High for the WebP container and Node filesystem design; unproven for implementation behavior until phase verification.

## Key Findings

### Stack

The existing Node 22+, strict TypeScript ESM stack is sufficient. WebP's RIFF structure can be parsed with built-in `Buffer`; safe publication can use built-in filesystem primitives. No runtime parser, codec, native module, network client, or ExifTool dependency is needed for the first slice.

### Expected Features

The minimum credible product is not merely chunk deletion. It needs inspection, explicit preservation controls, truthful capability discovery, typed total failures, exclusive destination handling, failure cleanup, cancellation/limits, byte-identical image/animation payloads, and reopen verification.

### Architecture

Keep byte parsing/policy/writing pure and place filesystem mutation behind a small orchestration layer. Parse and classify the entire file before destination creation. Reopen the completed destination through the parser, then assert metadata, structure, and payload invariants before success.

### Principal Risk

Silent metadata survival is the unacceptable failure. Unknown chunks, trailers, malformed sizes, inconsistent flags, and unsupported preservation cases should be explicit typed refusals. This follows the concern recorded in ExifCleaner issue #303 and the observed WebP workflow-metadata failure in issue #299.

## Implications for Roadmap

1. Build the evidence foundation before feature implementation: provenance, parser corpus, adversarial cases, and oracles.
2. Deliver the complete WebP path as one vertical slice: three public functions, filesystem transaction, parser/policy/writer, and verification.
3. Automate release only after behavioral checks are trustworthy.
4. Finish with consumer-facing capability/refusal documentation and an ExifCleaner fallback boundary.
5. Defer every additional format and any binary-exit claim.

## Decided v0.1 Contract

- Functions: `inspectFile`, `sanitizeFile`, `getCapabilities`.
- `Inspection`: `{ format: "webp", entries, warnings }`.
- `SanitizeOptions`: `sourcePath`, `destinationPath`, `preserveOrientation`, `preserveColorProfile`, `preserveTimestamps`, optional `signal`.
- `SanitizeResult`: `format`, `destinationPath`, `removedNamespaces`, `preserved`, `warnings`.
- All expected outcomes use a discriminated `Result`; all expected failures use a discriminated `MetadataError`.
- Source is never overwritten, destination creation is exclusive, partial output is cleaned, output is reopened and verified, type is detected by magic bytes, payload bytes are preserved, and the runtime performs no network access.
- Malformed/truncated files, unknown chunks/trailers, unsupported formats/features, and resource-limit violations are refused.

## Sources

Primary sources only:

- [WebP Container Specification](https://developers.google.com/speed/webp/docs/riff_container)
- [WebP Container API](https://developers.google.com/speed/webp/docs/container-api)
- [Node.js Buffer API](https://nodejs.org/api/buffer.html)
- [Node.js 22 File System API](https://nodejs.org/docs/latest-v22.x/api/fs.html)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [GitHub package publishing guidance](https://docs.github.com/en/actions/tutorials/publish-packages/publish-nodejs-packages)
- [ExifCleaner issue #303](https://github.com/szTheory/exifcleaner/issues/303)
- [ExifCleaner issue #299](https://github.com/szTheory/exifcleaner/issues/299)
- [ExifCleaner pinned source commit](https://github.com/szTheory/exifcleaner/commit/ba365b3459b0d87ce255124a5eef819aca603efd)

Research links document rationale, not completion evidence. No tests, npm publication, or ExifCleaner integration are claimed here.
