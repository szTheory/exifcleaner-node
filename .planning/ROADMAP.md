# Roadmap: exifcleaner-node

## Milestone v0.1: WebP Proof

Prove one narrow format end to end, distribute it safely, and leave consumers with a truthful boundary. This milestone does not replace ExifTool in ExifCleaner.

### Phase 1: Evidence Foundation

**Goal:** Establish reproducible fixtures and oracles capable of disproving unsafe WebP behavior before implementation claims begin.  
**Mode:** mvp  
**Requirements:** EVID-01, EVID-02, EVID-03  
**UI hint:** no

**Success Criteria:**

1. The pinned ExifCleaner fixture can be retrieved from commit `ba365b3…`, matches the recorded 152-byte size and SHA-256, and has documented MIT provenance.
2. Generated/adversarial cases cover the supported WebP structures and every declared refusal class without being mislabeled as upstream fixtures.
3. Verification oracles detect changed image/animation payload bytes, surviving forbidden metadata, source mutation, and a partial destination after failure.

### Phase 2: WebP Vertical Slice

**Goal:** Deliver the complete fail-closed WebP inspection and sanitization path through the public Node API.  
**Mode:** mvp  
**Requirements:** API-01, API-02, API-03, API-04, API-05, WEBP-01, WEBP-02, WEBP-03, WEBP-04, WEBP-05, WEBP-06, WEBP-07, SAFE-01, SAFE-02, SAFE-03, SAFE-04, SAFE-05, SAFE-06, SAFE-07  
**UI hint:** no

**Success Criteria:**

1. A consumer can inspect a valid WebP by magic bytes and receive typed metadata entries or exhaustively handle a typed failure.
2. A consumer can sanitize to a new, exclusively created destination with explicit orientation, ICC, and timestamp preservation choices.
3. Successful output has forbidden metadata removed, requested supported values preserved, and image/animation payload chunks byte-identical; the reopened output independently verifies those facts.
4. Every malformed, unknown, unsupported, over-limit, cancelled, aliased-path, or I/O case refuses without changing the source, overwriting an existing destination, or retaining partial output.
5. `getCapabilities()` reports exactly this WebP-only contract and runtime processing performs no network, subprocess, or native-code work.

### Phase 3: Automated Release

**Goal:** Make a package release a gated, provenance-bearing consequence of repository verification.  
**Mode:** mvp  
**Requirements:** REL-01, REL-02, REL-03, REL-04  
**UI hint:** no

**Success Criteria:**

1. Pull requests and main use the repository's defined verification command on the supported Node runtime.
2. A trusted tag with a matching package version can build and inspect the exact package contents before publish.
3. npm authentication uses repository-bound OIDC with provenance and no stored long-lived npm write token.
4. Untrusted events, mismatched versions/tags, or failed verification cannot reach publication.

### Phase 4: Consumer Readiness

**Goal:** Give early adopters a stable-enough typed entry point and an unambiguous statement of what v0.1 can and cannot protect.  
**Mode:** mvp  
**Requirements:** CONS-01, CONS-02, CONS-03, CONS-04  
**UI hint:** no

**Success Criteria:**

1. The packed artifact exposes ESM JavaScript and declarations for `inspectFile`, `sanitizeFile`, `getCapabilities`, and their public types on Node 22+.
2. A fresh reader can identify the WebP-only/pre-1.0 boundary, every guarantee/refusal, and why ExifCleaner must retain its ExifTool fallback.
3. The public example handles both branches of `Result` and never suggests source overwrite or unsupported formats.
4. Every copied fixture is traceable and generated fixtures are clearly distinguished from upstream evidence.

## Dependency Order

```text
Phase 1 evidence
      ↓
Phase 2 WebP slice
      ↓
Phase 3 release ──→ Phase 4 consumer readiness
```

Phase 4 may refine documentation alongside Phase 3, but milestone completion requires the package surface and release contract to agree.

## Future Milestones

### Format Graduation

Choose formats from measured ExifCleaner/user need. Each candidate requires its own specification study, provenance corpus, differential evidence, preservation contract, refusal policy, and fallback integration. Supporting one format creates no presumption that the next format is safe.

### ExifCleaner Adoption

Integrate behind the existing metadata-engine boundary. Route only capability-confirmed WebP cases to this package; retain ExifTool for every other format and any refused case while production evidence accumulates.

### Binary Exit

Removing ExifTool is a separate, late decision. It requires equivalent-or-better evidence for the app's required format portfolio, performance/resource measurements, migration and rollback plans, and no unresolved privacy regressions. v0.1 supplies one data point, not that conclusion.

## Progress

| Phase                  | Status      | Requirements | Progress |
| ---------------------- | ----------- | ------------ | -------- |
| 1. Evidence Foundation | Complete    | 3            | 100%     |
| 2. WebP Vertical Slice | Complete    | 19           | 100%     |
| 3. Automated Release   | In progress | 4            | 75%      |
| 4. Consumer Readiness  | Complete    | 4            | 100%     |

---

_Created: 2026-08-22_  
_Last updated: 2026-08-22 after implementation and hosted verification_
