# Format Admission Criteria

Every format `exifcleaner-node` admits — WebP first, PNG and JPEG in Phases 56 and 57, HEIC and AVIF
in Phase 62.1 — must clear
the same eight tiered evidence items before it registers a handler. This document lists what the
shared qualification kit already provides for each item, and what a format must supply on top of
it. `tests/format_admission_doc.test.ts` enforces the item order, the presence of both lines in
every item, that every backticked repository path named below actually exists, that every
identifier attributed to a kit or format module below is a real export of that module (and every
dotted member of it a declared member), and that every other code-shaped backticked identifier is
declared in a module this document cites — so, in that bounded sense, this document cannot drift
from the kit it describes (KIT-06, D-23, WR-08).

## 1. Spec note

A short prose note: the format's structure grammar, which parts carry identifying metadata, and
which parts a sanitize must preserve untouched.

Kit provides: this document's own per-item template, so every format's spec note lands in the same
place with the same two obligations spelled out.

Format supplies: the grammar, the identifying parts, and the preserved parts, written in its own
words in this section when the format is admitted.

**PNG:** an 8-byte signature, then a sequence of length/type/data/CRC chunks: `IHDR` first, `IEND`
last, `IDAT` contiguous. Identifying metadata lives in tEXt, zTXt, iTXt, eXIf, tIME, and
caBX (C2PA), plus any unregistered private ancillary chunk. A sanitize must preserve the critical
chunks (`IHDR`, `PLTE`, `IDAT`, `IEND`), every entry of `PNG_PRESERVED_CHUNK_TYPES` in
`src/admission/png-handler.ts`, and, on request, iCCP (`preserveColorProfile`) and pHYs
(`preserveResolution`).

**JPEG:** an SOI/EOI-bounded ITU-T T.81 marker stream: `classifyMarker` in `src/jpeg/markers.ts`
admits SOI, EOI, SOS, DQT, DHT, DRI, `COM`, every APPn, every restart marker, and only the baseline
and extended/progressive Huffman frames (`JPEG_ADMITTED_SOF_MARKERS`: SOF0, SOF1, SOF2); every other
frame class (lossless SOF3, hierarchical SOF5-7/DHP/EXP, arithmetic-coded, non-T.81, non-8-bit,
DNL) refuses pre-write via one of the twelve `JpegRefusal` literals. Identifying metadata lives in
every APPn segment and `COM`; a sanitize must strip every one of them except the Adobe APP14
segment (D-01, kept byte-identical), and, on request, ICC (`APP2:ICC_PROFILE`, multi-segment,
`preserveColorProfile`), JFIF resolution (`APP0:JFIF`, `preserveResolution`) and EXIF Orientation
(`preserveOrientation`, written only into a minimal synthesized IFD0 -- never the source's own EXIF
bytes). A trailer or an APP2 MPF payload after the primary EOI is truncated at that EOI unless
`classifyTrailerClasses`/`trailerRefusal` (`src/jpeg/trailer.ts`) measures it a `mpf-secondary-image`
refusal (D-13).

## 2. Hostile corpus

A fixture set with provenance, exercising truncation, size overflow, duplicate critical parts,
unknown critical parts and trailing data, plus refusal-class records that must decline rather than
sanitize.

Kit provides: `tests/qualification/kit/corpus.ts` (fixture loading, manifest validation, payload
digesting) and `tests/corpus/manifest.json` (the shared manifest schema: role, provenance and
`permittedDifferences` fields every fixture record carries).

Format supplies: fixtures with their own provenance record (revision, source URL, license status)
and refusal-class records for the malformed cases specific to its container grammar.

**PNG:** `hostileMutationCases` in `tests/qualification/png/generators.ts` covers truncation, a
duplicated critical chunk, an unknown critical chunk, and trailing data; `validGrammarCases` in the
same module pins one keep assertion per `PNG_PRESERVED_CHUNK_TYPES` entry. Real-world fixtures come
from the pinned `libpng-1.6.58` test suite under `tests/corpus/upstream/libpng-1.6.58/`.

**JPEG:** `hostileMutationCases` in `tests/qualification/jpeg/generators.ts` covers the malformed and
resource-limit refusal classes (truncation, an undefined DQT/DHT table reference, a refused frame
class, and each census-derived cap in `src/jpeg/markers.ts` such as `JPEG_MAX_SEGMENT_COUNT`);
`validGrammarCases` pins one keep assertion per admitted marker/frame combination.
`materializeMutationCase` materializes the recorded cases on demand. Real-world fixtures come from the pinned ExifTool 13.59 `t/images/` corpus under
`tests/corpus/upstream/exiftool-13.59-jpeg/` (the MPF/motion-photo evidence table's real classes:
Google.jpg, AFCP.jpg, ExifTool.jpg, FotoStation.jpg, PhotoMechanic.jpg) and the pinned
`libjpeg-turbo-3.2.0` test images under `tests/corpus/upstream/libjpeg-turbo-3.2.0/`.

## 3. Differential

An ExifTool differential run over the corpus, with a closed, measured permitted-difference list.
Any difference outside that list fails the fixture.

Kit provides: `tests/qualification/kit/oracles.ts` (`runExiftoolDifferential`, the differential
entry point: it runs `comparePermittedDifferences`, then `compareDifferential`, against the
baseline from `runExiftoolReference`; `metadataGroupDisposition` with `EXCLUDED_GROUPS` as the
total ExifTool-group-to-namespace mapping, comparing every group instead of silently dropping
unrecognized ones).

Format supplies: a `DifferentialProfile` (`DifferentialProfile.format`,
`DifferentialProfile.extension`, `DifferentialProfile.rawColorProfileSha256`,
`DifferentialProfile.permittedKinds`; the ExifTool arguments themselves are fixed inside the kit,
not supplied by the format) and, per fixture, the `permittedDifferences` grants in
`tests/corpus/manifest.json` — see [Permitted differences](#permitted-differences) below.

**PNG:** `pngDifferentialProfile` in `tests/qualification/png/oracles.ts` (`PNG_EXTENSION`,
`pngRawColorProfileSha256`, `pngStructuralParts` for the structural extension). gAMA/sRGB are
removed on every request, matching ExifTool `-all=` exactly even with `preserveColorProfile`
requested, so native never disagrees with the fallback on colour-space signalling.

**JPEG:** `jpegDifferentialProfile` in `tests/qualification/jpeg/oracles.ts` (`JPEG_EXTENSION`,
`jpegRawColorProfileSha256`, `jpegStructuralParts` for the structural extension, so a kept-vs-dropped
APP14 Adobe segment registers even though it carries no ExifTool-reported metadata of its own). The
reference is always bare `-all=` (JPEG never passes `tagsFromFileArgs`), matching the app's real
`sanitize()` invocation shape for a JPEG source.

## 4. Properties

Property-based tests whose generators actually emit metadata, so a sanitizer that only copies its
input fails them; coverage floors per metadata kind and per preservation flag, so no arm can pass
by running too rarely to matter.

Kit provides: `tests/qualification/kit/generators.ts` (the `FormatGenerator` interface, canary
planting and absence assertions) and `tests/qualification/kit/floors.ts` (the per-arm coverage
floor bookkeeping and its blocking assertion).

Format supplies: a `FormatGenerator` that plants a unique canary per declared metadata kind, and
the floor counts derived from its own fixed-seed distribution.

**PNG:** `pngMetadataGenerator` and `pngQualificationArbitrary` in
`tests/qualification/png/generators.ts` plant one canary per `PngMetadataKind` arm (text, time,
C2PA, and each preservable structural chunk), sampled at seed `460046`.

**JPEG:** `jpegMetadataGenerator` and `jpegQualificationArbitrary` in
`tests/qualification/jpeg/generators.ts` plant one canary per `JpegMetadataKind` arm (every removed
APPn/COM identifier class, plus `TRAILER` and the preservable `ICC`/`APP1-EXIF` arms), sampled at
seed `460046` with `FC_RUNS=200`; coverage floors are derived across four seeds
(`460046`, `1`, `2`, `3`), never lowered to fit a low measurement.

## 5. Payload identity

Proof that the format's image payload survives sanitize unchanged: either the payload chunk bytes
are identical before and after, or an independent decode oracle agrees on the decoded result.

Kit provides: `tests/qualification/kit/golden.ts` (the permanent golden-hash harness: capture,
compare, and the explicit-reason process for changing a checked-in digest).

Format supplies: either payload chunk identity, keyed by the format's own chunk/segment
vocabulary, or an independent decode oracle it wires in (as WebP does with `dwebp`/`webpinfo`).

**PNG:** `assertPngPayloadIdentity` in `tests/qualification/png/oracles.ts` compares
`pngIdatData`/`pngPayloadDigests` chunk bytes directly, and independently confirms the decoded
result through `runPngDecodeOracle` and `runPngcheck` (the pinned `pngcheck` 4.0.1 authority).

**JPEG:** `assertPayloadIdentity` in `tests/qualification/jpeg/oracles.ts` compares
`jpegPayloadDigests`/`jpegEntropyCodedBytes` scan bytes directly, and independently confirms the
decoded result through the pinned libjpeg-turbo `djpeg`/`rdjpgcom` binaries (`djpegPnm`,
`rdjpgcomText`).

## 6. Fault injection

Fault injection through the shared safe-file transaction, proving a mid-write failure never leaves
a destination or a stray stage file behind.

Kit provides: `tests/qualification/kit/fault-plan.ts` (`isStageFileName`, the shared
staging-directory and staging-file detection used by every registered format).

Format supplies: a handler whose staging file follows the shared `output.<ext>` convention inside
its `.exifcleaner-stage-*` directory, so the kit's fault plan can find and target it without a
per-format code change.

**PNG:** `tests/qualification/png/transaction.test.ts` reuses `isStageFileName` and the shared fault
plan unchanged: every `LOGICAL_OPERATIONS` terminal fault, every named abort barrier, a
post-publication close-target fault, and a structurally complex screenshot-shaped fixture
(iDOT/iCCP/cICP/eXIf) all pass with no PNG-specific code in the shared layer.

**JPEG:** `tests/qualification/jpeg/transaction.test.ts` reuses `jpegHandler.stagingFileName` and the
shared fault plan unchanged: every `LOGICAL_OPERATIONS` terminal fault, post-publication
close-target faults, the capability-disposition residue case, a terminal fault on the
`libjpeg-turbo-testorig` corpus record, every named abort barrier, and a two-destination concurrent
sanitize byte-identity check. Three of JPEG's six abort barriers (after-stage-creation,
during-bounded-copy, after-write-sync) are caught only by `jpegHandler`'s own `isAborted` checks, not
by the shared transaction's independent checks -- proven by a negative control disabling those
checks and re-running the barrier suite (measured 2026-09-27, restored immediately).

## 7. Preservation parity

Preservation parity with the app's own settings surface: orientation, ICC color profile,
filesystem timestamps and resolution, each reported honestly rather than assumed.

Kit provides: `src/admission/handler.ts` (the declared `FormatAdmission`/`FormatHandler` seam every
handler implements) and `CommonFormatCapabilities` in `src/types.ts`
(`CommonFormatCapabilities.preserves.resolution`, a required, never-optional boolean).

Format supplies: an honest `capabilities.preserves` block, including `resolution: false` when the
format cannot honor a preserve-resolution request (the app must then route that request to
ExifTool).

**PNG:** `PngCapabilities` in `src/types.ts` reports `preserves.orientation`, `.colorProfile`,
`.timestamps` and `.resolution` all `true` — PNG can honor every preservation flag, including
`preserveResolution` (unlike WebP, which reports `resolution: false` and declines the request
pre-write). Orientation is written only from eXIf; a non-eXIf source that disagrees with (or is
missing from) eXIf declines rather than guessing.

**JPEG:** `JpegCapabilities` in `src/types.ts` reports `preserves.orientation`, `.colorProfile`,
`.timestamps` and `.resolution` all `true`. Orientation is written into a minimal synthesized IFD0
only, never copying the source's own EXIF Orientation bytes forward, and segment order (not "EXIF
always wins") decides which of a disagreeing EXIF/XMP Orientation value ExifTool would pick — a
JPEG-specific discrepancy from an earlier planning assumption, measured and recorded in
`57-EVIDENCE.md`'s D-05 section. Adobe APP14 present forces JFIF to drop unconditionally
(`preserveResolution` then keeps only the synthesized IFD0 resolution, matching ExifTool's own
"Not creating JFIF in JPEG with Adobe APP14" behavior).

## 8. Rollback

A test proving that removing the format's handler from the registry declines that format cleanly,
before any write, with a safe fallback — not a partial write or a crash.

Kit provides: `tests/qualification/kit/rollback.test.ts` (the registry rollback proof, run once per
registered handler through the private test seam) — `setRegisteredHandlersForTests` in
`src/admission/registry.ts` — and `tests/qualification/formats.ts` (`QUALIFICATION_FORMATS`, a
compile-time-exhaustive `satisfies Record<NativeFormat, QualificationFormat>` registry: a new
NativeFormat literal fails typecheck until its differential profile, generator and sample all
exist).

Format supplies: a `QUALIFICATION_FORMATS` entry (its differential profile, generator and sample),
so the rollback proof and the compile-time coverage check both include it automatically once it
registers.

**PNG:** registered in `tests/qualification/formats.ts`'s `QUALIFICATION_FORMATS`, so
`tests/qualification/kit/rollback.test.ts`'s registry-removal proof runs for PNG automatically, and
its closing completeness assertion (derived from `QUALIFICATION_FORMATS`, never a literal format
name) fails if PNG's iteration were ever silently skipped.

**JPEG:** registered in `tests/qualification/formats.ts`'s `QUALIFICATION_FORMATS`, so
`tests/qualification/kit/rollback.test.ts`'s registry-removal proof runs for JPEG automatically:
removing `jpegHandler` from `HANDLERS` returns JPEG to `unsupported-format` before any write, then
restoring it accepts the same sample again, with the source unchanged throughout.

## Permitted differences

- **Kinds are code.** A permitted-difference kind is a coordinated code change in
  `tests/qualification/kit/oracles.ts`: its id joins the `PermittedKind` id union, the private
  grant parser accepts its grant syntax, and both `comparePermittedDifferences` and
  `compareDifferential` assert its specific semantic truth (for example, an EXIF `Orientation`
  value staying within `1`-`8`), so a stale or overly broad kind throws rather than silently
  passing. `compareDifferential` counts a grant as explained only by an observed delta in the
  grant's own namespace — an `impliedDifference` in a derived namespace is additional coverage for
  a side effect, never a substitute for the grant's own delta, so a stale grant throws even when an
  implied difference is present. Adding a new kind is a reviewed code change, not a data edit.
- **Grants are per-fixture data.** A fixture admits a kind only through its own
  `permittedDifferences` entry in `tests/corpus/manifest.json`. Granting an existing kind to one
  more fixture is a one-line data change; it never requires touching `oracles.ts`. The live corpus
  differential derives each record's preservation options from its own grants, so granting an
  existing kind really is data-only, exercised the same way a fixture's grant already is.
- **A format admits kinds through its `DifferentialProfile.permittedKinds`.** Each admitted kind
  must cite, in that format's own qualification suite, the title of a test that actually measures
  it — an admitted kind with no measuring test is an unreviewed hole, not evidence.
- **A structural differential covers container parts ExifTool never reports as metadata.** A
  format that opts in to an optional `DifferentialProfile.structuralParts` extractor also gets
  `compareStructuralDifferential` in `tests/qualification/kit/oracles.ts`: it compares the native
  output's and the ExifTool reference's container parts as multisets, and a kind explains a
  native-only or reference-only part exactly like it explains a metadata delta — closed, measured,
  and rejected as stale when no matching delta exists.
- **Fix the engine; don't grant a structural delta.** When native output differs from ExifTool
  only in container structure that no preserved feature needs, change the handler to match
  ExifTool instead of granting the difference. The run with no preservation requested therefore
  admits no permitted kinds at all. When a preservation forces a derived structural value, the
  grant for that preservation also covers that value, exactly and with no new kind. WebP is the
  worked example (KIT-08): the handler drops an empty VP8X header, and the Orientation and ICC
  grants in `tests/qualification/webp/oracles.ts` also cover the exact `RIFF:WebP_Flags` value
  their preservation forces.
- **Anything unlisted fails.** An over-strip (removing metadata ExifTool keeps) fails exactly like
  a metadata leak: the differential run does not distinguish "safer than expected" from "wrong."
- **PNG's four kinds**, all declared in `pngDifferentialProfile.permittedKinds`
  (`tests/qualification/png/oracles.ts`): `EXIF:Orientation`, `ICC_Profile:RawProfile` (with an
  `impliedDifference` in the `PNG` namespace for the re-deflated iCCP profile name), and
  `Resolution:Preserved` (namespace `PNG_RESOLUTION_GROUP`) all cite
  `PNG_PRESERVATION_MEASUREMENT_TITLE`; `Structure:UnregisteredAncillaryStripped` cites
  `PNG_UNREGISTERED_STRIP_MEASUREMENT_TITLE`.
- **JPEG's three kinds** (D-07's own must-have forbids a fourth), all declared in
  `jpegDifferentialProfile.permittedKinds` (`tests/qualification/jpeg/oracles.ts`):
  `EXIF:Orientation` and `ICC_Profile:RawProfile` cite `JPEG_PRESERVATION_MEASUREMENT_TITLE`;
  `Resolution:Preserved` (namespace `JFIF`, with an `impliedDifference` in the `EXIF` namespace for
  the D-07 synthesized-IFD0-resolution side effect) cites `JPEG_RESOLUTION_MEASUREMENT_TITLE`. D-06
  (Adobe APP14 present, JFIF unconditionally dropped) does not grant `Resolution:Preserved` — that
  case is proven by a direct structural-projection assertion instead of the generic grant mechanism,
  since the output correctly carries zero JFIF entries and the generic comparator would otherwise
  reject a correct drop as a preservation failure.

## CI scoping

A format's Linux qualification suite runs when a change touches its own `src/<format>/**`, its
registered handler, its `tests/qualification/<format>/**` directory, or its fixtures. Any change
under `tests/qualification/kit/**`, or any shared code the kit or every format depends on, runs
**every** format's suite — this is fail-closed by design: an ambiguous or shared-surface change
must never silently skip a format's evidence.

**JPEG** is a qualified format in `scripts/classify_ci_scope.cjs`; its own per-format path rules
scope `src/jpeg/**`, `src/admission/jpeg-handler.ts`, `tests/qualification/jpeg/**`,
`tests/jpeg*.test.ts`, and its two pinned corpus directories
(`tests/corpus/upstream/libjpeg-turbo-3.2.0/`,
`tests/corpus/upstream/exiftool-13.59-jpeg/`). A change matching none or more than one format's
rules — or a tag push, or a non-PR/push event — widens to JPEG's own qualification env list plus
every other qualified format's suite, never silently narrowing.

## Evidence tiers

Every registered format runs its full Linux CI gates (items 1 through 8 above) on every change in
its scope. The six-platform build and installed-package matrix, and the paired benchmarks, run
only when the shared transaction, the native addon, packaging, or a release changes — never merely
because a format's own code changed.

## Adding a format checklist

- Add the handler to the `HANDLERS` array in `src/admission/registry.ts`.
- Add the format's literal to the `NativeFormat` union and its member to the `FormatCapabilities`
  discriminated union.
- Add its `tests/qualification/formats.ts` `QUALIFICATION_FORMATS` entry (its differential profile,
  generator and sample) — typecheck fails on a registered format missing this entry.
- Add its `tests/qualification/<format>/` suites (differential, property, golden or decode-oracle,
  transaction, rollback coverage) and its `tests/corpus/manifest.json` fixture records.
- Note: the first non-WebP corpus record generalizes `tests/qualification/kit/corpus.ts`'s payload
  vocabulary, which is currently WebP-chunk-specific — this is the one allowlisted neutrality
  exception the kit-neutrality scan already documents (`tests/format_neutral_source.test.ts`).

**PNG and JPEG both completed this checklist** (Phases 56 and 57): each has its `HANDLERS`
registration, its `NativeFormat`/`FormatCapabilities` member, its `QUALIFICATION_FORMATS` entry, its
full `tests/qualification/<format>/` suite, and its own `tests/corpus/manifest.json` fixture
records.

**HEIC and AVIF completed it in Phase 62.1**, registered together in one commit with their
`QUALIFICATION_FORMATS` entries and rollback proof. Their suites are `tests/qualification/heic/`
and `tests/qualification/avif/`. Their ExifTool differential uses the shared ISOBMFF comparison
in `tests/isobmff-support/differential.ts`, with one closed permitted-difference list per format
recorded in `docs/isobmff.md`.
