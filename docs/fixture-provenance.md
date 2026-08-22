# Fixture Provenance

Fixtures are evidence, not decorative samples. Any committed binary used to support a privacy or payload-integrity claim must have an origin, immutable revision where possible, license status, digest, and defined role.

## Pinned ExifCleaner Fixture

| Field               | Value                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local role          | Upstream compatibility/evidence fixture for a minimal metadata-bearing WebP                                                                                                |
| Upstream repository | [`szTheory/exifcleaner`](https://github.com/szTheory/exifcleaner)                                                                                                          |
| Upstream commit     | [`ba365b3459b0d87ce255124a5eef819aca603efd`](https://github.com/szTheory/exifcleaner/commit/ba365b3459b0d87ce255124a5eef819aca603efd)                                      |
| Upstream path       | [`tests/e2e/fixtures/sample.webp`](https://github.com/szTheory/exifcleaner/blob/ba365b3459b0d87ce255124a5eef819aca603efd/tests/e2e/fixtures/sample.webp)                   |
| Generator source    | [`tests/e2e/fixtures/generate_fixtures.ts`](https://github.com/szTheory/exifcleaner/blob/ba365b3459b0d87ce255124a5eef819aca603efd/tests/e2e/fixtures/generate_fixtures.ts) |
| Upstream license    | MIT; copyright szTheory; see the [license at the pinned revision](https://github.com/szTheory/exifcleaner/blob/ba365b3459b0d87ce255124a5eef819aca603efd/LICENSE)           |
| Size                | 152 bytes                                                                                                                                                                  |
| SHA-256             | `16d1cad79550c1e13f7710032f9bb41f5c36e49d0debe65761f7ee4c333360cd`                                                                                                         |
| Recorded            | 2026-08-22                                                                                                                                                                 |

The pinned generator creates a minimal 1×1 lossy WebP and then invokes ExifTool with `Artist=Test Author` and `Make=TestCamera`. The resulting committed bytes contain a `VP8X` chunk, a `VP8 ` image chunk, and an `EXIF` chunk. This describes origin; consumers should verify behavior from bytes rather than trust this prose.

### Integrity Check

The test suite reconstructs the exact 152 bytes from a reviewed base64 literal rather than adding a second binary copy. It asserts the byte length and SHA-256 before using the fixture for inspection and payload-preservation checks. To independently reproduce that identity from the pinned upstream checkout:

```sh
shasum -a 256 tests/e2e/fixtures/sample.webp
wc -c tests/e2e/fixtures/sample.webp
```

Expected output identity is the digest and 152-byte size above. A mismatch is an evidence failure; do not update the recorded digest without pinning and reviewing a new upstream revision.

## Generated Fixtures

Repository-generated fixtures are not upstream ExifCleaner evidence. Their provenance record should include:

- generator source path and version-control revision;
- generation parameters and deterministic seed, if any;
- expected RIFF/chunk layout and the invariant it exercises;
- whether the bytes are valid, deliberately malformed, truncated, over-limit, or unsupported;
- SHA-256 when committed as a binary rather than generated during verification.

At minimum, the local matrix needs still lossy/lossless, alpha, ICC, EXIF, XMP, combined metadata, animation, odd-sized payload padding, duplicate metadata, flag inconsistency, malformed size, truncation, trailer, unknown FourCC, abort, destination collision, and payload-mutation negative controls.

## Evidence Limits

The upstream sample proves provenance for one small EXIF-bearing still WebP and checks that its `Make`, `Artist`, and VP8 payload survive the expected inspect/sanitize contract. It does not prove general WebP support, orientation preservation, animation handling, resource safety, or parity with ExifTool. Those claims require the broader generated and adversarial corpus.
