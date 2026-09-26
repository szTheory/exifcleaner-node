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

## Pinned libpng Fixtures (Phase 56)

Fifteen upstream PNG fixtures committed under `tests/corpus/upstream/libpng-1.6.58/`,
sourced from the pinned `libpng-1.6.58` archive (`tests/corpus/tools/manifest.json`,
revision `3061454d980de7d53608f594194cfac722721d2a`, tag `v1.6.58`), licensed
`libpng-2.0`. Each has a `tests/corpus/tools/manifest.json` `fixtures` entry tying its
committed bytes to an exact archive member (T-56-30), and a `tests/corpus/manifest.json`
corpus record. `libpng-1.6.58-rgb-8-srgb` additionally carries the `structural` role
(Plan 09 Task 1's tracer target); the rest carry `differential` (success) or
`negative-control` (refusal), except `libpng-1.6.58-badadler` which is `structural`
only (native never inflates `IDAT`, so its decode oracles do not cover it).

| Fixture ID | Member path | SHA-256 | Bytes | Role(s) | Measured outcome |
| --- | --- | --- | --- | --- | --- |
| `libpng-1.6.58-rgb-8-srgb` | `contrib/testpngs/rgb-8-sRGB.png` | `4f94dfdb92acaeffab3aff43fbaf935fe0e5816566792b56a75a9f8802028e7e` | 772 | differential, structural | success, removes PNG |
| `libpng-1.6.58-rgb-8-1.8` | `contrib/testpngs/rgb-8-1.8.png` | `327589867a6a3a21fe17ffc55b29f34ceb8446cf87bc4435c80aa098d8ae7b4a` | 819 | differential | success, removes PNG |
| `libpng-1.6.58-rgb-8-trns` | `contrib/testpngs/rgb-8-tRNS.png` | `42d6f96da278fa6264a9e267caa4cbfc75ddf0734ef67187e4c4b2d29e2d26fc` | 777 | differential | success, removes PNG |
| `libpng-1.6.58-palette-8-srgb-trns` | `contrib/testpngs/palette-8-sRGB-tRNS.png` | `7e1465ed17f633b6dde5da989a44d910b815ffa78e77892864ab2e2ac56d6261` | 1313 | differential | success, removes PNG |
| `libpng-1.6.58-gray-16-linear-trns` | `contrib/testpngs/gray-16-linear-tRNS.png` | `4f079601662e06fa01dbbfb09a6e0e5d154e084f52e97abc4f9c142ec3aff755` | 744 | differential | success, removes PNG |
| `libpng-1.6.58-rgb-alpha-16-srgb` | `contrib/testpngs/rgb-alpha-16-sRGB.png` | `f287dc434a985a9478aadc0f8fe6c6053899ea61735ec15f41db47816bd184d3` | 1390 | differential | success, removes PNG |
| `libpng-1.6.58-cicp-display-p3-reencoded` | `contrib/testpngs/png-3/cicp-display-p3_reencoded.png` | `e162b7af4677c088f8ae584d1f0cbc852901e020fdfa0f41b54b4e001b7a2d23` | 142 | differential | success, removes nothing (cICP kept) |
| `libpng-1.6.58-basn3p08` | `contrib/pngsuite/basn3p08.png` | `eca1db90338a8481e4d3f2469befa06d7564534e9323b6a8040ed0cdd281d952` | 1286 | differential | success, removes PNG |
| `libpng-1.6.58-ibasn2c08` | `contrib/pngsuite/ibasn2c08.png` | `67ac80581c63559889a9f5d5ba8f70ab1e77d304a2e54b916dd23953bf7d3fc7` | 299 | differential | success, removes nothing |
| `libpng-1.6.58-badadler` | `contrib/testpngs/crashers/badadler.png` | `3614bbe9494f6374567cbf897e022a16abb8edd3f166745ce73a2f472eef6136` | 67 | structural | success (bad zlib Adler in `IDAT` is never inflated natively) |
| `libpng-1.6.58-badcrc` | `contrib/testpngs/crashers/badcrc.png` | `ec5b6a711ea2325404ea56575df2f8a28292e5ef15a950f42a1d39ce06a6a96a` | 67 | negative-control | refused, `malformed-file` (`IDAT` chunk CRC mismatch) |
| `libpng-1.6.58-bad-iccp` | `contrib/testpngs/crashers/bad_iCCP.png` | `0c1ec5ece28d8574e80a3842939e8939f3451c71e8b2e013dcf26a80d292168e` | 321 | negative-control | refused, `malformed-file` (`IHDR` chunk CRC mismatch, no `IEND`) |
| `libpng-1.6.58-empty-ancillary-chunks` | `contrib/testpngs/crashers/empty_ancillary_chunks.png` | `bdc133d532c03cdaa6b6a8188a722c3845d4b2f76e89c63e1c70c1bf6a364be7` | 730 | negative-control | refused, `unsafe-structure` (`bKGD` before `PLTE`) |
| `libpng-1.6.58-huge-itxt-chunk` | `contrib/testpngs/crashers/huge_iTXt_chunk.png` | `cf52cbac99198baf5e72e0d1423de217aa9cff327981356ab20e9b47d32ab0fd` | 57 | negative-control | refused, `malformed-file` (declared length past EOF) |
| `libpng-1.6.58-huge-junk-unsafe-to-copy` | `contrib/testpngs/crashers/huge_juNK_unsafe_to_copy.png` | `8f9ef7f8931919fc8a73d896ff2e3bd5cf233141dc6b7801e4fbe7c0c7b4037b` | 57 | negative-control | refused, `malformed-file` (declared length past EOF) |

Every "measured outcome" above was captured by running the built package's own
`sanitizeFile`/`inspectFile` against the committed bytes (not inferred from the
filename or upstream comments) before the corpus record was written.

## Generated Fixtures

Repository-generated fixtures are not upstream ExifCleaner evidence. Their provenance record should include:

- generator source path and version-control revision;
- generation parameters and deterministic seed, if any;
- expected RIFF/chunk layout and the invariant it exercises;
- whether the bytes are valid, deliberately malformed, truncated, over-limit, or unsupported;
- SHA-256 when committed as a binary rather than generated during verification.

At minimum, the local matrix needs still lossy/lossless, alpha, ICC, EXIF, XMP, combined metadata, animation, odd-sized payload padding, duplicate metadata, flag inconsistency, malformed size, truncation, trailer, unknown FourCC, abort, destination collision, and payload-mutation negative controls.

## Manifest and Promotion Workflow

Release-admission inputs are offline and immutable. CI does not fetch a mutable
corpus, user media, or crash attachments. Every corpus record has one stable,
unique ID and exactly one evidence identity even when another record shares its
roles or digest. An empty manifest, role, accepting direction, rejecting
direction, or required oracle transcript is invalid. Records and reports retain
stable ID order.

Each corpus record declares the fields appropriate to its origin and claim:

- stable `id` and one or more approved `roles`;
- either a bounded `localPath` or a deterministic `generator` with `kind`,
  `seed`, and source-case identity;
- immutable `provenance` revision and URL for external bytes, plus license and
  reviewed license status;
- exact `sha256` and `bytes`;
- expected RIFF `topology` and typed `outcome`;
- `retainedPayloads` and narrowly reviewed `permittedDifferences`; and
- the exact `oracle` transcript when the record supports an external decode,
  structure, animation, or metadata claim.

Benchmark records live under `benchmarks.fixtures` and additionally bind
`kind`, `seed`, `targetBytes`, digest, and expected semantic outcome. Large
benchmark payloads are generated locally from these records rather than checked
in.

A newly discovered failure is quarantined outside the repository first. Do not
retain the original attachment or user media automatically. Minimize the byte
sequence or recreate it with a deterministic generator, review privacy,
ownership, redistribution license, and the single violated invariant, then give
it a stable manifest ID and focused regression assertion. Promotion is a normal
reviewed commit that updates the manifest and evidence; it is never an automatic
corpus synchronization or digest refresh.

## Local Qualification and Focused Replay

Run the bounded local qualification set with one command:

```sh
npm run qualify
```

Failures name the shortest replay and the manifest or fault-ledger ID. Focus one
authority without copying payloads or private paths into logs:

```sh
npm run qualify -- --case exifcleaner-sample --json
npm run qualify -- --oracle libwebp-1.5.0-example
npm run qualify -- --seed 460046
npm run qualify -- --seed 460046 --path 0
npm run qualify -- --fault stage-sync:1:EIO
npm run qualify -- --fault during-bounded-copy
```

External oracle replay is intentionally restricted to the admitted Linux x64
host and first verifies the committed source archives and licenses. A case replay
points to `tests/corpus/manifest.json`; a property replay points to its seed and
path; a transaction replay points to the named fault plan or barrier.

For one paired performance fixture, use explicit packed artifacts:

```sh
npm run benchmark:qualify -- \
  --baseline-tarball /path/to/exifcleaner-node-v0.1.1.tgz \
  --candidate-tarball /path/to/exifcleaner-node-candidate.tgz \
  --fixture still-64k \
  --mode report \
  --output qualification-benchmark.json
```

Use `--mode admit` only for an explicit phase or release decision. Exact
formulas, fixture sizes, environment fields, and non-guarantees are documented
in [WebP Benchmark Admission](benchmark-admission.md).

## Evidence Limits

The upstream sample proves provenance for one small EXIF-bearing still WebP and checks that its `Make`, `Artist`, and VP8 payload survive the expected inspect/sanitize contract. It does not prove general WebP support, orientation preservation, animation handling, resource safety, or parity with ExifTool. Those claims require the broader generated and adversarial corpus.
