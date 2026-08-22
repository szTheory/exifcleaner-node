# Stack Research

**Project:** exifcleaner-node  
**Researched:** 2026-08-22  
**Baseline:** ExifCleaner `ba365b3459b0d87ce255124a5eef819aca603efd`

## Recommendation

Use the platform stack already declared by the package: Node.js 22+, TypeScript 5.9, ESM, Vitest, and Node's built-in `Buffer` and `fs/promises` APIs. Keep the runtime dependency set empty for the WebP slice.

| Concern          | Choice                                     | Why                                                                                                              | Confidence |
| ---------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ---------- |
| Binary parsing   | Node `Buffer`                              | Provides bounded little-endian integer reads/writes required by RIFF without a native addon.                     | High       |
| File I/O         | `node:fs/promises` with exclusive open     | Supports source reads, `wx` destination creation, cleanup, reopen verification, and timestamp restoration.       | High       |
| Language         | TypeScript, strict ESM                     | Makes the `Result`/error unions and preservation policy explicit to consumers.                                   | High       |
| Testing          | Vitest + fast-check                        | Use examples for provenance fixtures and properties for chunk size, padding, truncation, and cleanup invariants. | High       |
| Structure checks | madge                                      | Keeps the format core independent from filesystem orchestration and public adapters.                             | Medium     |
| Distribution     | npm trusted publishing from GitHub Actions | OIDC removes long-lived publish tokens and produces provenance for an eligible public package.                   | High       |

## Version Policy

- Honor `package.json` and its lockfile as the implementation source of truth; do not copy versions from research prose.
- Maintain Node 22 as the minimum until a deliberate compatibility decision changes it.
- Keep pre-1.0 changes semver-explicit. The public exports are small enough to review as a contract.

## Avoid

- A WebAssembly/native image codec: v0.1 copies payload bytes and should not decode pixels.
- A general RIFF package: a narrow parser with an allowlist is easier to audit and refuse safely.
- An ExifTool subprocess in the runtime package: it defeats the experiment. ExifTool belongs in differential development evidence, not the production dependency graph.
- Buffering unbounded attacker-controlled sizes: validate declared sizes and configured resource limits before allocation or copying.

## Primary Sources

- [WebP Container Specification](https://developers.google.com/speed/webp/docs/riff_container) — RIFF layout, little-endian sizes, padding, chunk order, metadata chunks, and VP8X feature bits.
- [Node.js Buffer API](https://nodejs.org/api/buffer.html) — bounded little-endian integer operations.
- [Node.js 22 File System API](https://nodejs.org/docs/latest-v22.x/api/fs.html) — exclusive open, file handles, unlink, timestamps, and file I/O.
- [TypeScript module reference](https://www.typescriptlang.org/docs/handbook/modules/reference.html#packagejson-exports) — package export/type resolution.
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) — OIDC requirements and automatic provenance.

## Research Boundary

These sources establish implementation choices; they do not prove the library or release exists. Verification must come from the repository's own checks and published registry evidence in later phases.
