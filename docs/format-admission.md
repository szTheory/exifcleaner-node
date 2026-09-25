# Format Admission Criteria

Every format `exifcleaner-node` admits — WebP today, PNG and JPEG in Phases 56 and 57 — must clear
the same eight tiered evidence items before it registers a handler. This document lists what the
shared qualification kit already provides for each item, and what a format must supply on top of
it. `tests/format_admission_doc.test.ts` enforces the order, the presence of both lines in every
item, and that every backticked repository path named below actually exists, so this document
cannot drift from the kit it describes (KIT-06, D-23).

## 1. Spec note

A short prose note: the format's structure grammar, which parts carry identifying metadata, and
which parts a sanitize must preserve untouched.

Kit provides: this document's own per-item template, so every format's spec note lands in the same
place with the same two obligations spelled out.

Format supplies: the grammar, the identifying parts, and the preserved parts, written in its own
words in this section when the format is admitted.

## 2. Hostile corpus

A fixture set with provenance, exercising truncation, size overflow, duplicate critical parts,
unknown critical parts and trailing data, plus refusal-class records that must decline rather than
sanitize.

Kit provides: `tests/qualification/kit/corpus.ts` (fixture loading, manifest validation, payload
digesting) and `tests/corpus/manifest.json` (the shared manifest schema: role, provenance and
`permittedDifferences` fields every fixture record carries).

Format supplies: fixtures with their own provenance record (revision, source URL, license status)
and refusal-class records for the malformed cases specific to its container grammar.

## 3. Differential

An ExifTool differential run over the corpus, with a closed, measured permitted-difference list.
Any difference outside that list fails the fixture.

Kit provides: `tests/qualification/kit/oracles.ts` (`comparePermittedDifferences`,
`runExiftoolOracle`, and the total ExifTool-group-to-namespace mapping that compares every group
instead of silently dropping unrecognized ones).

Format supplies: a `DifferentialProfile` (its ExifTool arguments and `permittedKinds`) and, per
fixture, the `permittedDifferences` grants in `tests/corpus/manifest.json` — see
[Permitted differences](#permitted-differences) below.

## 4. Properties

Property-based tests whose generators actually emit metadata, so a sanitizer that only copies its
input fails them; coverage floors per metadata kind and per preservation flag, so no arm can pass
by running too rarely to matter.

Kit provides: `tests/qualification/kit/generators.ts` (the `FormatGenerator` interface, canary
planting and absence assertions) and `tests/qualification/kit/floors.ts` (the per-arm coverage
floor bookkeeping and its blocking assertion).

Format supplies: a `FormatGenerator` that plants a unique canary per declared metadata kind, and
the floor counts derived from its own fixed-seed distribution.

## 5. Payload identity

Proof that the format's image payload survives sanitize unchanged: either the payload chunk bytes
are identical before and after, or an independent decode oracle agrees on the decoded result.

Kit provides: `tests/qualification/kit/golden.ts` (the permanent golden-hash harness: capture,
compare, and the explicit-reason process for changing a checked-in digest).

Format supplies: either payload chunk identity, keyed by the format's own chunk/segment
vocabulary, or an independent decode oracle it wires in (as WebP does with `dwebp`/`webpinfo`).

## 6. Fault injection

Fault injection through the shared safe-file transaction, proving a mid-write failure never leaves
a destination or a stray stage file behind.

Kit provides: `tests/qualification/kit/fault-plan.ts` (`isStageFileName`, the shared
staging-directory and staging-file detection used by every registered format).

Format supplies: a handler whose staging file follows the shared `output.<ext>` convention inside
its `.exifcleaner-stage-*` directory, so the kit's fault plan can find and target it without a
per-format code change.

## 7. Preservation parity

Preservation parity with the app's own settings surface: orientation, ICC color profile,
filesystem timestamps and resolution, each reported honestly rather than assumed.

Kit provides: `src/admission/handler.ts` (the declared `FormatAdmission`/`FormatHandler` seam every
handler implements) and `CommonFormatCapabilities` in `src/types.ts` (the shared `preserves` shape,
with `resolution` as a required, never-optional boolean).

Format supplies: an honest `capabilities.preserves` block, including `resolution: false` when the
format cannot honor a preserve-resolution request (the app must then route that request to
ExifTool).

## 8. Rollback

A test proving that removing the format's handler from the registry declines that format cleanly,
before any write, with a safe fallback — not a partial write or a crash.

Kit provides: `tests/qualification/kit/rollback.test.ts` (the registry rollback proof, run once per
registered handler through the private `setRegisteredHandlersForTests` test seam) and
`tests/qualification/formats.ts` (`QUALIFICATION_FORMATS`, a compile-time-exhaustive
`satisfies Record<NativeFormat, QualificationFormat>` registry: a new `NativeFormat` literal fails
typecheck until its differential profile, generator and sample all exist).

Format supplies: a `QUALIFICATION_FORMATS` entry (its differential profile, generator and sample),
so the rollback proof and the compile-time coverage check both include it automatically once it
registers.

## Permitted differences

- **Kinds are code.** A permitted-difference kind is a case in
  `comparePermittedDifferences` in `tests/qualification/kit/oracles.ts`. Each kind asserts a
  specific semantic truth about the difference (for example, an EXIF `Orientation` value staying
  within `1`-`8`), so a stale or overly broad kind throws rather than silently passing. Adding a
  new kind is a reviewed code change, not a data edit.
- **Grants are per-fixture data.** A fixture admits a kind only through its own
  `permittedDifferences` entry in `tests/corpus/manifest.json`. Granting an existing kind to one
  more fixture is a one-line data change; it never requires touching `oracles.ts`.
- **A format admits kinds through its `DifferentialProfile.permittedKinds`.** Each admitted kind
  must cite, in that format's own qualification suite, the title of a test that actually measures
  it — an admitted kind with no measuring test is an unreviewed hole, not evidence.
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

## CI scoping

A format's Linux qualification suite runs when a change touches its own `src/<format>/**`, its
registered handler, its `tests/qualification/<format>/**` directory, or its fixtures. Any change
under `tests/qualification/kit/**`, or any shared code the kit or every format depends on, runs
**every** format's suite — this is fail-closed by design: an ambiguous or shared-surface change
must never silently skip a format's evidence.

## Evidence tiers

Every registered format runs its full Linux CI gates (items 1 through 8 above) on every change in
its scope. The six-platform build and installed-package matrix, and the paired benchmarks, run
only when the shared transaction, the native addon, packaging, or a release changes — never merely
because a format's own code changed.

## Adding a format checklist

- Add the handler to `HANDLERS` in `src/admission/registry.ts`.
- Add the format's literal to the `NativeFormat` union and its member to the `FormatCapabilities`
  discriminated union.
- Add its `tests/qualification/formats.ts` `QUALIFICATION_FORMATS` entry (its differential profile,
  generator and sample) — typecheck fails on a registered format missing this entry.
- Add its `tests/qualification/<format>/` suites (differential, property, golden or decode-oracle,
  transaction, rollback coverage) and its `tests/corpus/manifest.json` fixture records.
- Note: the first non-WebP corpus record generalizes `tests/qualification/kit/corpus.ts`'s payload
  vocabulary, which is currently WebP-chunk-specific — this is the one allowlisted neutrality
  exception the kit-neutrality scan already documents (`tests/format_neutral_source.test.ts`).
