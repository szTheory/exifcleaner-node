<!-- GSD:project-start source:PROJECT.md -->

## Project

**exifcleaner-node**

`exifcleaner-node` is a small, typed Node.js metadata inspection and sanitization engine. Its first pre-1.0 release supports WebP only and exists to prove that a fail-closed, in-process TypeScript implementation can eventually replace selected ExifTool work in ExifCleaner without weakening the app's privacy contract.

**Core Value:** Never create false confidence: either produce a verified sanitized artifact while preserving image data, or refuse without changing the source or leaving a partial destination.

### Constraints

- **Runtime**: Node.js 22 or newer, ESM, TypeScript — matches the package engine and avoids a secondary runtime.
- **Correctness**: Detect content by magic bytes, validate RIFF sizes/padding/feature flags, and reopen the written destination before reporting success.
- **Filesystem safety**: Source and destination differ; destination creation is exclusive; any partial output is cleaned after failure.
- **Payload integrity**: Image and animation payload bytes are copied, not decoded or re-encoded.
- **Privacy**: No network activity, telemetry, or background lookup in the runtime library.
- **Scope**: WebP only and pre-1.0; unsupported formats and uncertain features return typed failures.
- **Evidence**: Every fixture has recorded origin, license status, and digest; upstream references are pinned to immutable SHAs where possible.

<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->

## Technology Stack

## Recommendation

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

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.

<!-- GSD:profile-end -->
