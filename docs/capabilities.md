# Capability Contract

`exifcleaner-node` is pre-1.0. `getCapabilities()` is the machine-readable authority; this document is the complete human-readable `icc-structural-v0.2` policy.

## Supported Surface

| Area         | Contract                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime      | Node.js 22+, ESM                                                                                                                                                         |
| Formats      | WebP, PNG, JPEG, HEIC and AVIF, all detected by magic: WebP by `RIFF` + `WEBP`, PNG by its 8-byte signature, JPEG by `FF D8 FF`, HEIC and AVIF by their `ftyp` brand set |
| Operations   | `getCapabilities`, `inspectFile`, `sanitizeFile`, `classifyFallback`                                                                                                     |
| Metadata     | Inspect EXIF, XMP, ICC; remove EXIF/XMP; remove or structurally preserve ICC                                                                                             |
| Preservation | Orientation, ICC profile, filesystem timestamps when explicitly requested and safely representable                                                                       |
| Resolution   | Capability-gated by `preserves.resolution`; a format reporting `false` (WebP) declines a `preserveResolution: true` request before any write                             |
| Still images | Lossy/lossless and alpha structures that satisfy the supported WebP contract; baseline/extended-sequential/progressive 8-bit JPEG frames                                 |
| Animation    | Recognized container/frame payloads copied byte-for-byte when structure is fully recognized                                                                              |
| Cancellation | Optional `AbortSignal` on inspection and sanitization                                                                                                                    |
| Failures     | Discriminated `MetadataError` returned through `Result`                                                                                                                  |

`NativeFormat` is the format-neutral discriminant (currently
`"webp" | "png" | "jpeg" | "heic" | "avif"`). `FormatCapabilities` is the
format-neutral capability union, currently refined by the supported
`WebpCapabilities`, `PngCapabilities`, `JpegCapabilities`, `HeicCapabilities`
and `AvifCapabilities` shapes. Admission is by magic admission: the
already-open source must begin with `RIFF` + `WEBP`, with PNG's own 8-byte
signature, with a JPEG SOI marker (`FF D8 FF`), or with an ISOBMFF `ftyp` box
whose brands select HEIC or AVIF. It is never enough to carry a matching
extension. The private registry is frozen and contains exactly the five
qualified handlers below; this package exposes no handler registration API.

| `format` | Capabilities       | Magic admission                                        | Media types                | Extensions       | `removes`                            |
| -------- | ------------------ | ------------------------------------------------------ | -------------------------- | ---------------- | ------------------------------------ |
| `webp`   | `WebpCapabilities` | `RIFF` + `WEBP`                                        | `image/webp`               | `.webp`          | `EXIF`, `XMP`, `ICC`                 |
| `png`    | `PngCapabilities`  | the 8-byte PNG signature                               | `image/png`                | `.png`           | `EXIF`, `XMP`, `ICC`, `PNG`, `C2PA`  |
| `jpeg`   | `JpegCapabilities` | `FF D8 FF`                                             | `image/jpeg`               | `.jpg`, `.jpeg`  | `EXIF`, `XMP`, `ICC`, `C2PA`, `JPEG` |
| `heic`   | `HeicCapabilities` | `ftyp` brands include `heic`, `heix`, `heim` or `heis` | `image/heic`, `image/heif` | `.heic`, `.heif` | `EXIF`, `XMP`, `ICC`, `C2PA`         |
| `avif`   | `AvifCapabilities` | `ftyp` brands include `avif`                           | `image/avif`               | `.avif`          | `EXIF`, `XMP`, `ICC`, `C2PA`         |

**Magic admission for ISOBMFF (HEIC and AVIF).** The registry reads a bounded magic buffer
(256 bytes) and classifies the leading `ftyp` box's major brand together with its compatible
brands (`src/isobmff/brand.ts`). The `brands` capability field states the set each format
recognizes: `["heic", "heix", "heim", "heis"]` for HEIC and `["avif"]` for AVIF. A brand set
containing both an AVIF and a HEIC brand, neither, or a sequence brand (`msf1`, `avis`) is not
admitted, and neither is a truncated or malformed `ftyp`. `.heif` is listed only under HEIC. A
`mif1`-only file with no HEIC or AVIF brand is not admitted.

**`validation.container: "full"` for ISOBMFF.** Every box header the engine walks is checked for
framing (size, largesize, parent and file bounds), every item table (`iinf`, `iloc`, `ipma`,
`iref`, `pitm`) is parsed and checked as a graph, and every file-relative extent is bounded by the single `mdat`. Property
payloads in `ipco` are opaque: they are copied byte for byte and never interpreted, except that a
`colr` profile is recognized so that it can be removed. `validation.codecBitstream:
"not-decoded"`: HEVC and AV1 payloads are never decoded. The qualification kit decodes them with
libheif to prove the output renders the same, but the runtime package does not.

HEIC and AVIF `refuses` lists seven classes: `malformed-container`, `resource-limits`,
`image-sequence`, `unknown-boxes`, `unknown-item-types`, `unsupported-features` and
`unsafe-item-layout`. Each refusal is returned before a destination exists. Their `limits` are
`maxMetaBytes` (16,777,216), `maxBoxCount` (65,536), `maxBoxDepth` (8) and
`maxBufferedBytesTotal` (33,554,432). [The ISOBMFF spec note](isobmff.md) maps every internal
decline class to one refusal and records the measured evidence.

## Consumer and Publication Contract

A consumer submits one semantic request through `sanitizeFile` and receives one
verified `SanitizeResult` or one structured terminal/non-admission
`MetadataError`. On an error, call `classifyFallback` once: only
`phase: "admission"` with `nativeWrite: "not-started"` yields
`"safe-to-fallback"`; every other error yields `"do-not-fallback"`. The safe
disposition permits at most one ExifTool substitute, never another native write,
a retry loop, or a second writer after uncertainty. A `preserveResolution: true`
request against a format whose capability reports `preserves.resolution: false`
declines with `unsupported-feature`/`resolution-preservation` before any
destination exists, and is always `"safe-to-fallback"`.

The transaction completes admission before creating a randomly named,
owner-private same-parent stage. It writes, syncs, reopens, verifies, rechecks the
source, applies requested timestamps, and then performs exactly one platform-native
atomic no-replace publication. A collision after the native write has started is
terminal. A successful result is the only completion signal; the private stage path is never exposed.

Success includes `postCommitResidue`. After the destination is committed, the
library removes its own empty private stage directory: POSIX performs one
non-recursive `rmdir` of the directory it still holds open, only while the
path still has that directory's identity; Windows disposes its
opened-directory capability. In either case the destination is already
committed, and a removal failure cannot revoke success — it is reported as
`private-empty-stage-directory-remains` with the cause. A successful commit
is expected to leave only the destination; any leftover stage is reported
through `postCommitResidue`.

Pre-publication failures retain their root cause and attach one bounded
`owned-partial-remains` finalization when stage residue is uncertain. They never
use a pathname identity check followed by pathname removal. Windows may report
`owned-partial-removed` only after disposing the opaque opened-directory capability
with no stage file present. All finalization outcomes are terminal and
`"do-not-fallback"`; normal diagnostics remain concise and do not expose private
stage paths, inode values, payload bytes, registry internals, or backend-routing
details.

## ICC Structural Preservation Policy

`preserveColorProfile: true` uses policy `icc-structural-v0.2`. It means **preserve if present**: a WebP with no `ICCP` chunk succeeds and reports `preserved.colorProfile: false`. A present admitted `ICCP` chunk is copied byte-for-byte and the reopened destination proves that byte identity. The engine never repairs, normalizes, reserializes, or transforms a profile.

The policy admits only these structural header values:

| Field              | Admitted value                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ICC version        | Classic v2.0–v2.4 or v4.0–v4.4                                                                                                                                                                                                                    |
| Version bytes 8–11 | Byte 8 is `02h` or `04h`; byte 9 has BCD minor digit `0`–`4` and BCD bug-fix digit `0`–`9`; reserved bytes 10–11 are zero. Thus byte 9 is one of `00h`–`09h`, `10h`–`19h`, `20h`–`29h`, `30h`–`39h`, or `40h`–`49h`, never a raw binary interval. |
| Device class       | `scnr` (input) or `mntr` (display)                                                                                                                                                                                                                |
| Data color space   | `RGB `                                                                                                                                                                                                                                            |
| PCS                | `XYZ ` or `Lab `                                                                                                                                                                                                                                  |
| Signature and size | `acsp`; declared size exactly matches the payload; total profile length is four-byte aligned                                                                                                                                                      |
| Date and intent    | Valid creation date; rendering intent 0–3                                                                                                                                                                                                         |
| v2 tail            | Bytes 84–127 are reserved and zero                                                                                                                                                                                                                |
| v4 tail            | Bytes 84–99 are the Profile ID: zero is accepted, otherwise it must match the ICC MD5 conformance procedure. Bytes 100–127 are reserved and zero.                                                                                                 |
| v4 illuminant      | Header D50 PCS illuminant is exactly `0000f6d6 00010000 0000d32d`                                                                                                                                                                                 |

The Profile ID check is an ICC conformance/integrity check, not a cryptographic-security claim.

### Tag Table and Layout Rules

The profile must be at least 132 bytes, contain a nonempty tag table, and stay within both advertised ceilings: at most 16 MiB total profile bytes and at most 4,096 tag records. Counts, table sizes, offsets, and lengths are bounded before use.

Each tag record must have a unique nonzero signature. Its payload must begin after the complete tag table on a four-byte boundary, have a nonzero size of at least the eight-byte type header, lie wholly inside the profile, and have zero type-header reserved bytes. Different tag signatures may share a payload only when `(offset, size)` is exactly identical; partial overlaps, table/header references, zero-sized ranges, and ambiguous sharing are refused.

After exact aliases are collapsed, distinct payload ranges are sorted by physical offset. The first payload must immediately follow the table; every later payload must follow the preceding payload with only the required zero padding (0–3 bytes); and the final padded payload must end exactly at EOF. Gaps, nonzero padding, trailers, and noncanonical layouts are refused.

Tag contents are otherwise opaque. This policy validates the bounded container structure needed to preserve original bytes; it does not interpret a tag's semantic content.

### Outcomes and Refusals

When requested preservation sees a present profile that is malformed, outside the admitted subset, or above a policy limit, sanitization returns before it creates a destination:

```ts
{
  code: "unsupported-feature",
  feature: "color-profile-preservation",
  reason: "invalid" | "unsupported" | "policy-limit",
}
```

Consumers may switch on `code`, `feature`, and `reason`. `detail` is concise diagnostic context only and is not a compatibility contract; do not parse it. This phase establishes only the observably pre-write refusal. Phase 45 owns the canonical fallback disposition. Cancellation and any I/O, verification, cleanup, or file-identity uncertainty remain terminal outcomes.

`preserveColorProfile: false` skips ICC admission, removes the admitted-container `ICCP` content, rebuilds the VP8X ICC bit from retained chunks, reopens the destination, and proves no ICCP remains. This succeeds even when diagnostic ICC inspection reports warnings. Inspection warnings are informational and never authorize requested preservation.

## Sanitization Semantics

All three preservation booleans are explicit:

- `preserveOrientation`: preserve only a supported orientation value. The original EXIF block is not retained merely to keep orientation. If a minimal safe representation cannot be proven, the request is refused.
- `preserveColorProfile`: apply the structural policy above when an `ICCP` chunk is present; otherwise report requested-but-absent preservation truthfully.
- `preserveTimestamps`: apply source filesystem `atime and mtime only` to the
  verified destination, then verify the safely representable precision. This
  does not preserve embedded metadata dates, birth time, change time, or source
  atime. The package never restores source atime because doing so would mutate
  the source after a read.

Orientation is supported only when IFD0 contains one TIFF `SHORT`, count 1, with a value from 1 through 8. A malformed EXIF structure, duplicate tag, different TIFF type/count, or out-of-range value returns `unsupported-feature` when preservation is requested. An absent Orientation is not an error.

On success, `removedNamespaces` lists namespaces absent from the destination. When a minimal Orientation-only EXIF block remains, `EXIF` is intentionally not listed. `preserved` reports which requested values were actually present and retained. Neither field substitutes for the engine's post-write verification.

## Machine-Readable Limits

The WebP record returned by `getCapabilities()` exposes these enforced values:

| Field                             | Value                   | Meaning                                                                                      |
| --------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `colorProfile.policy`             | `icc-structural-v0.2`   | Stable name for the structural ICC preservation subset.                                      |
| `colorProfile.preservation`       | `preserve-if-present`   | An absent ICCP is a successful non-preservation outcome.                                     |
| `colorProfile.maxProfileBytes`    | `16777216`              | Maximum admitted ICC profile payload.                                                        |
| `colorProfile.maxTagCount`        | `4096`                  | Maximum admitted ICC tag records.                                                            |
| `limits.maxMetadataBytesPerChunk` | `16777216`              | Maximum buffered size of each ICC, EXIF, or XMP chunk.                                       |
| `limits.maxChunkCount`            | `10000`                 | Aggregate top-level and nested animation chunks accepted during one parse.                   |
| `limits.maxRiffBytes`             | `4294967294`            | WebP's specified maximum whole-file size: 4 GiB minus 2 bytes.                               |
| `animation.boundary`              | `aggregate-chunk-count` | Animation has no separate advertised frame cap; frames and nested chunks consume this limit. |

The `refuses` array machine-reports stable container refusal classes. Consumers should inspect returned `MetadataError.code` and, for ICC preservation, the typed fields above.

## Per-Format Preservation Capabilities

`getCapabilities().formats` is a discriminated union on `format`. Every member's
`preserves` object carries `orientation`, `colorProfile`, `timestamps`, and
`resolution` as required booleans; none of these fields is ever optional.

The meaning of `preserves.resolution` is fixed and does not vary by format:

- `true` means the format's resolution-bearing data (for example PNG's `pHYs`
  chunk, or JPEG's JFIF/EXIF density fields) is always retained or explicitly
  preserved by the handler, so a `preserveResolution: true` request may be
  routed to this native library.
- `false` means the handler cannot honor that request, so a consumer must
  route the request to ExifTool instead.

There is no third state.

WebP reports `resolution: false`. WebP has no dedicated resolution-bearing
chunk in its supported surface, and native WebP resolution preservation is
future work (FUT-01), not a capability of the current handler. PNG reports
`resolution: true`: its `pHYs` chunk is always kept byte-identical when
`preserveResolution: true` (see "## PNG" below). JPEG also reports
`resolution: true`: its JFIF density fields are kept byte-identical, and, when
the source's EXIF also carries its own IFD0 X/YResolution, a minimal IFD0 is
synthesized to carry those same three values forward -- each group is kept
independently with no reconciliation between them, matching ExifTool's own
measured behavior. The one `preserveResolution: true` pre-write decline is a
JFIF segment whose embedded thumbnail is non-empty: a kept JFIF must stay
byte-identical (D-01), and the grouped resolution copy-back would otherwise
recreate a fresh JFIF header without the source's thumbnail bytes, so the
whole request declines and falls back to ExifTool instead of silently losing
the thumbnail (see "## JPEG" below).

HEIC and AVIF report `resolution: true`. When the Exif item describing the primary image carries
`XResolution`, `YResolution` and `ResolutionUnit`, a `preserveResolution: true` request keeps
those values in the minimal Exif item the writer builds. That item contains only the requested
tags (see [the ISOBMFF spec note](isobmff.md), D-13).

Capability-shape changes -- adding a required field to `CommonFormatCapabilities`
or widening the discriminated union with a new format -- are a minor version
bump under this package's semver policy. This shape (the `resolution` field
added in KIT-03) ships as part of `exifcleaner-node@0.3.0`, published once the
PNG and JPEG handlers land in Phases 56 and 57.

The ExifCleaner app reads only `preserves.orientation`, `preserves.colorProfile`,
and `preserves.timestamps` until its own adoption phase; it does not yet read
`preserves.resolution`.

## PNG

PNG admission is a **closed preserve-list**, never a delete-list: a chunk type
that is not on one of three code-defined lists declines the whole source with
a typed pre-write `unsafe-structure` refusal, rather than guessing whether to
keep or strip it.

- **Always kept** (critical): `IHDR`, `PLTE`, `IDAT`, `IEND`.
- **Always kept** (measured against ExifTool `-all=`, `PNG_PRESERVED_CHUNK_TYPES`):
  `tRNS`, `cHRM`, `bKGD`, `sBIT`, `sPLT`, `hIST`, `cICP`, `mDCV`, `cLLI`,
  `sCAL`, `oFFs`, `pCAL`, `sTER`, `iDOT`, `vpAg`.
- **Always removed** (`PNG_REMOVED_CHUNK_TYPES`): `tEXt`, `zTXt`, `iTXt`,
  `eXIf`, `tIME`, `caBX` (C2PA), and -- matching ExifTool's own behavior even
  with color-profile preservation requested -- `gAMA` and `sRGB`. The handler
  never writes a colour chunk of its own; it only removes chunks or copies
  them byte-identically (D-09).
- **Conditional** (`PNG_CONDITIONAL_CHUNK_TYPES`): `iCCP` is kept
  byte-identical in place when `preserveColorProfile: true` (after its
  bounded-inflate profile passes the same `icc-structural-v0.2` policy WebP
  uses), else removed. `pHYs` is kept byte-identical in its original relative
  position when `preserveResolution: true`, else removed. A compressed
  `iCCP`, `zTXt` or `iTXt` field whose zlib stream ends before the chunk data
  does declines pre-write as `malformed-file`, regardless of
  `preserveColorProfile` (CR-01): the PNG spec defines the compressed
  datastream as the entire remainder of the chunk, so trailing bytes make it
  malformed rather than merely oversized, and the handler never re-encodes a
  profile to strip them (D-09).
- **Unregistered private ancillary chunk** (a type in neither the PNG
  extensions registry nor any of the lists above, for example Android's
  `npTc` nine-patch data) is **stripped** as a privacy-reasoned difference
  from ExifTool `-all=`, which keeps it: an opaque payload nobody can audit.
  Its type is recorded so a permitted-difference kind can grant it in the
  differential harness.
- **Registered but unmeasured ancillary chunk** (present in the PNG
  extensions registry but not on any list above, for example `gIFg`, `gIFt`,
  `gIFx`, `dSIG`, `fRAc`, or the deprecated `mDCv`/`cLLi` lower-last-letter
  casing) declines the source with a typed pre-write refusal
  (`unmeasured-registered-chunks` in `refuses`). A future measurement can
  graduate such a type onto one of the lists above; the handler never
  guesses.
- **`iDOT` adjacency** (Apple's private chunk, D-06): its offsets are
  relative to its own chunk start, so nothing may be inserted or removed
  between `iDOT` and the first `IDAT`. A request that would remove a chunk in
  that span declines with a typed pre-write refusal
  (`unsafe-chunk-adjacency` in `refuses`) instead of writing a stale offset.

### PNG limits

| Member                                 | Value      | Meaning                                                                       |
| -------------------------------------- | ---------- | ----------------------------------------------------------------------------- |
| `limits.maxMetadataBytesPerChunk`      | `16777216` | Maximum on-disk size of any single non-`IDAT` chunk's data (16 MiB).          |
| `limits.maxAncillaryChunkCount`        | `10000`    | Maximum number of non-`IDAT` chunks accepted during one parse.                |
| `limits.maxIdatChunkCount`             | `65536`    | Maximum number of `IDAT` chunks accepted during one parse (CR-02).            |
| `limits.maxInflatedIccBytes`           | `16777216` | Maximum inflated size of an `iCCP` profile (16 MiB, the ICC policy cap).      |
| `limits.maxInflatedTextBytes`          | `16777216` | Maximum inflated size of a `zTXt` or compressed `iTXt` field (16 MiB).        |
| `limits.maxInflatedBytesTotal`         | `50331648` | Aggregate inflated-bytes budget shared across all compressed fields (48 MiB). |
| `limits.maxBufferedMetadataBytesTotal` | `50331648` | Aggregate raw data of all non-IDAT chunks buffered in one parse (48 MiB).     |

`maxIdatChunkCount` is derived from a census of 19,979 real PNGs (the largest
measured 1,786 `IDAT` chunks): 65,536 is 36x that headroom and still admits
512 MiB of image data at libpng's 8 KiB default `IDAT` size, so a file above
the cap falls back to ExifTool (a typed pre-write decline, classified safe)
rather than failing.

### PNG orientation (D-11, D-12, D-13)

`eXIf` is PNG's only orientation source: when `preserveOrientation: true` and
`eXIf` IFD0 tag `0x0112` (Orientation) is valid (1-8), the source `eXIf` is
removed and a minimal `eXIf` -- Orientation only, via `createOrientationExif`,
no writer defaults such as `YCbCrPositioning` -- is inserted immediately after
`IHDR`, always before any `iDOT` and the first `IDAT`. The destination is
re-parsed and the inserted `eXIf` compared byte-for-byte against
`createOrientationExif(orientation)` before publication.

A PNG whose Orientation comes only from an XMP packet (`tiff:Orientation`,
keyword `XML:com.adobe.xmp`) or a legacy ImageMagick raw-EXIF-profile text
chunk (keyword `Raw profile type exif` or `Raw profile type APP1`) -- or
whose non-`eXIf` Orientation disagrees with `eXIf` -- declines orientation
preservation (`unsupported-feature`, `feature: "orientation-preservation"`)
before any write, rather than guessing which source should win: ExifTool's
own pick in that case depends on chunk order, and promoting an XMP-only
Orientation into a fresh `eXIf` would rotate pixels in viewers that
currently display the image unrotated. Both keywords are recognised
regardless of which text chunk type carries them -- `tEXt`, `zTXt`, and
`iTXt` are routed by keyword, not by chunk type (WR-01; measured against
ExifTool 13.59, which honours the same keyword in any of the three). An
agreeing non-`eXIf` Orientation, or a non-`eXIf` block carrying no
Orientation, does not decline. These readers return only a routing value or
its absence -- their bytes never reach the output -- and the raw-EXIF-profile
reader's declared byte count is bounds-checked against the same
text-decompression limit as `tEXt`/`zTXt` (`PNG_MAX_INFLATED_TEXT_BYTES`)
before any hex is decoded, independent of any preservation flag.

### PNG namespace mapping (D-15)

`inspectFile` and `removedNamespaces` report PNG's removable metadata under
the same closed namespace set (`EXIF`, `XMP`, `ICC`, `PNG`, `C2PA`) every
format uses. No entry is produced for `pHYs`, `gAMA`, or `sRGB`, or an
unregistered chunk stripped under D-05 -- those are reported through
`removedNamespaces`/`preserved` only, never as an inspection entry.

| Chunk                                          | Namespace | Entry                                                                                                                         |
| ---------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `eXIf`                                         | `EXIF`    | One entry per decoded EXIF tag (`parseExif`).                                                                                 |
| `iCCP` (inflated)                              | `ICC`     | One entry per decoded ICC field (`parseIcc`).                                                                                 |
| `tEXt`, keyword `XML:com.adobe.xmp`            | `XMP`     | One entry per decoded XMP property (`parseXmp`). Same routing as `iTXt` (WR-01) -- no duplicate `PNG` entry.                  |
| `tEXt`, any other keyword                      | `PNG`     | `{ name: keyword, value: Latin-1 text }`.                                                                                     |
| `zTXt` (inflated), keyword `XML:com.adobe.xmp` | `XMP`     | One entry per decoded XMP property (`parseXmp`). Same routing as `iTXt` (WR-01) -- no duplicate `PNG` entry.                  |
| `zTXt` (inflated), any other keyword           | `PNG`     | `{ name: keyword, value: Latin-1 text }`.                                                                                     |
| `iTXt`, keyword `XML:com.adobe.xmp`            | `XMP`     | One entry per decoded XMP property (`parseXmp`).                                                                              |
| `iTXt`, any other keyword                      | `PNG`     | `{ name: keyword, value: UTF-8 text }`; invalid UTF-8 adds a `metadata-invalid` warning and produces no entry (fatal decode). |
| `tIME`                                         | `PNG`     | `{ name: "ModifyDate", value: "YYYY:MM:DD HH:MM:SS" }`.                                                                       |
| `caBX` (C2PA)                                  | `C2PA`    | `{ name: "JUMBF", value: <byte length of the chunk data> }`. The JUMBF box contents are never parsed.                         |
| `pHYs`, `gAMA`, `sRGB`                         | `PNG`     | No entry -- reported only via `removedNamespaces`/`preserved.resolution`.                                                     |

Every successful PNG sanitize re-parses the staged destination (CRC and chunk
order re-checked), asserts its chunk-type sequence against the plan computed
from admission, and compares every kept chunk byte-for-byte against its
source range before publication. A mismatch is `verification-failed` and the
destination is never published.

## JPEG

JPEG admission is a **closed classification rule** (D-01), never a per-
identifier keep registry: every marker segment maps to exactly one of four
classes, and the handler never guesses which class a segment belongs to.

- **Structural, always kept**: `SOI`, `EOI`, `DQT`, `DHT`, `DRI`, an admitted
  `SOF` (baseline, extended-sequential Huffman, or progressive), and every
  `SOS` plus its entropy-coded scan data -- copied byte-identical, never
  decoded or re-encoded.
- **Always kept**: an `APP14` segment identified `Adobe` -- matching
  ExifTool `-all=`, which also always keeps it.
- **Conditional**: every `APP2` `ICC_PROFILE` segment is kept byte-identical
  and in source order only when `preserveColorProfile: true` (after
  reassembly across sequence numbers passes the same `icc-structural-v0.2`
  policy WebP and PNG use), else all are removed. `APP0` `JFIF` is kept
  byte-identical only when `preserveResolution: true` **and** no `APP14`
  `Adobe` segment is present (D-06); when both are present, `JFIF` is always
  dropped with no decline, since `Adobe`'s presence in ExifTool's own model
  determines which resolution source survives.
- **Always removed**, matching ExifTool `-all=` parity -- no removal here is
  a difference this library introduces: `APP0` `JFXX`, `APP1` `Exif`/`XMP`/
  `ExtendedXMP`, `APP2` `FPXR`/`MPF`, `APP11` (JUMBF/C2PA), `APP13`
  (Photoshop), any non-`Adobe` `APP14`, every other/unknown `APPn`, and every
  `COM`. APP11 JUMBF/C2PA removal is measured parity (D-02): ExifTool 13.59
  `-all=` deletes JUMBF too (deletable since 12.64) -- **both engines remove
  C2PA/JUMBF** identically; this library's removal set matches ExifTool's own
  here, exactly like every other removal in this list.

### JPEG admitted frames and refusals (D-08, D-09, D-10)

Admitted frames are `SOF0` (baseline), `SOF1` (extended-sequential Huffman),
and `SOF2` (progressive), all 8-bit precision only. Every other structural
shape is refused before any write, with a typed pre-write decline
(`refuses`):

| Refusal                       | Kind               | Meaning                                                                    |
| ----------------------------- | ------------------ | -------------------------------------------------------------------------- |
| `malformed-container`         | `malformed-file`   | Bad SOI/EOI/marker/length or an unknown non-`APPn` marker.                 |
| `truncation`                  | `malformed-file`   | The file ends before a declared segment or the primary EOI.                |
| `undefined-table-reference`   | `unsafe-structure` | A scan references a DQT/DHT table slot never defined.                      |
| `lossless-frame`              | `unsafe-structure` | `SOF3` (lossless) is refused.                                              |
| `hierarchical-frame`          | `unsafe-structure` | `SOF5`-`SOF7`, `DHP`, `EXP` (hierarchical) are refused.                    |
| `arithmetic-frame`            | `unsafe-structure` | `SOF9`-`SOF11`, `SOF13`-`SOF15`, `DAC` (arithmetic-coded) are refused.     |
| `non-t81-frame`               | `unsafe-structure` | `JPG`, `JPGn` (including JPEG-LS) fall outside ITU-T T.81 and are refused. |
| `non-8-bit-precision`         | `unsafe-structure` | A frame with sample precision other than 8 bits is refused.                |
| `unsupported-component-count` | `unsafe-structure` | A frame with a component count other than 1, 3, or 4 is refused.           |
| `dnl-marker`                  | `unsafe-structure` | A zero frame height or a `DNL` marker is refused.                          |
| `resource-limits`             | `unsafe-structure` | A census-derived structural cap is exceeded (see below).                   |
| `mpf-secondary-image`         | `unsafe-structure` | A measured-unsafe MPF secondary image or gain-map trailer (see below).     |

### JPEG limits (D-10 census)

| Member                          | Value       | Meaning                                                                         |
| ------------------------------- | ----------- | ------------------------------------------------------------------------------- |
| `limits.maxFileBytes`           | `536870912` | 512 MiB, derived from a 7,187-real-JPEG plus ExifTool-corpus census.            |
| `limits.maxSegmentCount`        | `2048`      | 32x the census's largest observed total segment count (34).                     |
| `limits.maxScanCount`           | `512`       | 32x the census's largest observed SOS-scan count (14).                          |
| `limits.maxTableSegmentCount`   | `512`       | 32x the census's largest observed DQT/DHT segment count (9).                    |
| `limits.maxIccSegments`         | `255`       | ICC.1 Annex B.4's fixed one-byte sequence-number ceiling.                       |
| `limits.maxReassembledIccBytes` | `16777216`  | 16 MiB -- the same ICC policy cap WebP and PNG use.                             |
| `limits.maxExtendedXmpBytes`    | `16777216`  | 16 MiB, mirroring PNG's text-decompression limit (no real-world census signal). |

A file above any of these caps declines pre-write (`resource-limits`,
classified safe-to-fallback) rather than failing outright; ExifTool remains
available for it.

**56-REVIEW WR-02 disposition:** WR-02 flagged that PNG's `parsePng` buffered every non-IDAT
chunk's data with only a per-chunk/aggregate-count bound, not an aggregate-bytes cap. JPEG's own
`parseJpeg` (`src/jpeg/parser.ts`) was written from the start with a bounded 64 KiB read-ahead
window shared across every segment-header, small-segment-data, and marker read in its main loop --
the same fix PNG needed only after the fact (56-12's post-plan `PNG_CHUNK_READ_WINDOW_BYTES` gap
fix) is present in JPEG by construction (57-03), so WR-02 does not recur for JPEG. **PNG's own
WR-02 is now closed (Phase 60, PNG-05):** `parsePng` caps aggregate buffered non-IDAT data at
48 MiB (`BufferedBudget`, `limits.maxBufferedMetadataBytesTotal` above) with a typed
`unsafe-structure` refusal (`chunkType: "*"`, so the iCCP per-chunk remap can never misreport an
aggregate breach), and `copyWindowedChunk` copies every windowed chunk read before it is stored, so
a small chunk no longer retains a reference to a shared 64 KiB read window for the lifetime of the
parse. `tests/png_memory.test.ts` measures real peak RSS (via a child-process harness) against a
test ceiling, with both a cap-removed and a copy-removed negative control.

Within the parse loop, an animation chunk (`acTL`, `fcTL`, `fdAT`) is refused before its data is
ever read (PNG-06), so a malicious or malformed animation chunk cannot reach the buffering path at
all.

### JPEG trailer truncation (D-11) and MPF/motion-photo classification (D-12, D-13)

Anything after the primary `EOI` -- a trailing secondary image, a Multi-
Picture Format (MPF, CIPA DC-007) container, a Google Motion Photo or Adobe
gain-map XMP-linked payload, or a Samsung `SEFH`/`SEFT` embedded-picture
trailer -- is truncated at the primary `EOI`, matching ExifTool `-all=`,
which truncates any trailer regardless of content. A measured-unsafe
`MPF`/gain-map shape declines pre-write instead of truncating silently
(`mpf-secondary-image`); every other measured trailer/MPF class (a malformed
MPF index, a real Google Motion Photo, a Samsung trailer, or a plain
trailer) truncates cleanly. This decision table is populated only from
direct measurement against ExifTool 13.59, never by assumption.

### JPEG orientation and resolution (D-03, D-04, D-05, D-06)

`JpegCapabilities` advertises `preserves.orientation: true` and
`preserves.resolution: true`. When a preserved IFD0 tag (Orientation or
resolution) is requested and present in the source's first `APP1` `Exif`
segment, the sanitized output carries exactly one freshly synthesized `APP1`
`Exif` segment -- a minimal EXIF TIFF holding only the preserved tags -- in
the source Exif segment's own slot. **The source Exif segment itself is
never copied**: no GPS, thumbnail, Make/Model, Artist, or any other IFD0/
ExifIFD tag survives. When no preserved IFD0 tag exists in the source (for
example, a JFIF-only source with `preserveResolution: true`), no EXIF is
created.

- **D-03 (Orientation + resolution synthesis)**: the inserted TIFF equals
  `createMinimalExif({ orientation?, resolution? })` for only the tags that
  were both requested and present. Re-parsing the destination after write
  (`verifyOutput`) recomputes the same expected bytes and asserts an exact
  match, plus that `parseExif` on the destination yields exactly the
  preserved tag set.
- **D-04 (independent resolution sources, no unit conversion)**: with
  `preserveResolution: true`, `APP0` `JFIF` (when kept, D-06) is byte-
  identical and independent of any IFD0 resolution tag -- a JFIF 72 dpi plus
  an IFD0 300 dpi source keeps both unchanged. EXIF resolution is read only
  from the source's own IFD0 `XResolution`/`YResolution`/`ResolutionUnit`;
  no code path derives it from JFIF, SPIFF, or Photoshop values, or maps
  JFIF density units (0/1/2) onto EXIF resolution units (1/2/3). Raw IFD0
  rationals (for example `600/2`) are written unreduced. With
  `preserveResolution: false`, `JFIF` and every IFD0 resolution tag are
  absent from the output.
- **D-06 (APP14 Adobe + JFIF)**: when an `APP14` `Adobe` segment is present,
  `JFIF` is always dropped (matching ExifTool), with no decline; IFD0
  resolution still synthesizes through D-03 when present, so
  `preserved.resolution` is `true` when IFD0 resolution survived and `false`
  when the source's only resolution source was the dropped `JFIF` (both
  outcomes report `removedNamespaces` including `JPEG`).
- **JFIF thumbnail (D-01/JPG-01)**: an `APP0` `JFIF` segment whose
  `Xthumbnail`/`Ythumbnail` are not both zero is never kept byte-identical
  (D-01 forbids editing a kept `JFIF`, and its thumbnail bytes never survive
  the grouped resolution copy-back). With `preserveResolution: true` and no
  `APP14`, such a source declines resolution preservation pre-write
  (`checkOutputPlan`, safe-to-fallback) so the ExifTool route handles it;
  with `preserveResolution: false` the `JFIF` is removed like every other
  `JFIF`.
- **D-05 (EXIF-only orientation, XMP/ExtendedXMP decline)**: the written
  Orientation comes only from EXIF IFD0 `0x0112`. With
  `preserveOrientation: true`, a standard XMP or complete ExtendedXMP
  `tiff:Orientation` that is present while the EXIF Orientation is missing
  or differs, or an ExtendedXMP that cannot be reassembled, declines
  orientation preservation pre-write (`unsupported-feature`,
  `feature: "orientation-preservation"`, `reason: "safe-to-fallback"`); an
  agreeing XMP value, or XMP carrying no Orientation at all, does not
  decline. With `preserveOrientation: false` nothing declines. **Measured
  correction (57-01/57-EVIDENCE.md):** unlike this document's earlier D-05
  prose, ExifTool does not pick EXIF over XMP "regardless of segment
  order" -- whichever of EXIF/XMP appears first in the file wins. The decline
  above is kept regardless: declining always routes the file through the
  real ExifTool fallback, which reproduces whatever ExifTool would have
  written for the actual segment order for free, so no order-awareness is
  needed in the native path.
- A duplicate Exif segment (a source with more than one `APP1` `Exif`) is
  read from the first Exif slot only, per the same rule every other JPEG
  metadata source uses (first occurrence wins, D-15 analog).

### JPEG namespace mapping and inspection vocabulary (D-15 analog)

`inspectFile` and `removedNamespaces` report JPEG's removable metadata under
the same closed namespace set every format uses, widened by exactly one
member: `JPEG` (reporting removed `JFIF`/`JFXX`, `COM`, `APP13`, `MPF`,
other `APPn`, and trailer data). `EXIF`, `XMP`, `ICC`, and `C2PA` keep their
existing cross-format meanings. Entries are read from buffered payloads
only -- no unbuffered segment payload (for example an unclassified `COM`
among thousands) is read merely to produce an inspection entry.

| Entry name(s)                                                 | Namespace | Source                                                                                                                                    |
| ------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| (tag names from `parseExif`)                                  | `EXIF`    | The first `APP1` `Exif` segment.                                                                                                          |
| (tag names from `parseXmp`)                                   | `XMP`     | The first standard XMP `APP1` packet.                                                                                                     |
| (tag names from `parseIcc`)                                   | `ICC`     | The reassembled `APP2` `ICC_PROFILE` sequence, only when it is a valid profile.                                                           |
| `JFIF:ResolutionUnit`, `JFIF:XResolution`, `JFIF:YResolution` | `JPEG`    | The buffered `APP0` `JFIF` segment's density fields, whether kept or removed.                                                             |
| `JUMBF`                                                       | `C2PA`    | An `APP11` segment; value is the payload byte length.                                                                                     |
| `<MARKER>` or `<MARKER>:<identifier>`                         | `JPEG`    | Every other removable segment (`COM`, `APP13:Photoshop 3.0`, `APP2:MPF`, an unknown `APPn`, and so on); value is the payload byte length. |
| `Trailer`                                                     | `JPEG`    | Bytes after the primary `EOI`, only when the trailer is non-zero length.                                                                  |

An incomplete ExtendedXMP (cannot be reassembled) adds a `metadata-invalid`
warning rather than an entry.

Every successful JPEG sanitize re-parses the staged destination, recomputes
the expected marker sequence and every copied byte range from admission and
the request's flags, independently re-classifies every destination segment
under the same D-01 rule (never merely trusting the write path), and asserts
zero trailer bytes remain. A mismatch is `verification-failed` and the
destination is never published.

## Safety Guarantees

| Guarantee                 | Consequence                                                                                                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source never overwritten  | `sourcePath` remains unchanged on success and failure.                                                                                                                                                                |
| Distinct paths            | Equal or aliased source/destination paths are refused.                                                                                                                                                                |
| Atomic no-replace publish | A pre-existing destination is never replaced; the native publication call is the single success authority.                                                                                                            |
| Stage finalization        | Error cleanup never removes a pathname. Only a Windows opened-directory capability may dispose a directory-only stage. A successful commit removes only the owned empty stage directory it created, after the commit. |
| Full classification first | Unknown/unsupported content is refused before output is accepted as sanitized.                                                                                                                                        |
| Reopen verification       | A write is not success until the destination reparses and satisfies removal, preservation, structure, and payload checks.                                                                                             |
| Payload identity          | Image, animation, and admitted ICC payload chunks are copied without decode/re-encode and compared byte-for-byte where retained.                                                                                      |
| Local operation           | No network calls, telemetry, or subprocesses occur in runtime inspection/sanitization.                                                                                                                                |
| Total expected failures   | Consumers branch on `Result.ok` and `MetadataError.code`, not thrown message strings.                                                                                                                                 |
| Output mode               | Output is created with non-executable ordinary permission bits no more permissive than the source, subject to umask.                                                                                                  |

## Filesystem Boundaries and Non-Guarantees

The private-stage/native no-replace policy prevents replacement of a pre-existing
destination but does not claim atomic rollback or in-place overwrite. A process
crash or power loss may leave private-stage residue. Portable Node cannot promise
universal directory durability or locking. Pre-publication uncertainty deliberately
does not attempt pathname removal, so a concurrent replacement cannot gain cleanup
authority.

The package does not promise or copy birth time, change time, owner/group, ACLs,
xattrs, quarantine/SELinux labels, hard-link topology, sparse allocation, or
other broad filesystem attributes. It does not reproduce exact POSIX modes,
setuid, setgid, sticky, executable bits, ownership, or ACL policy across
platforms. Electron's separately qualified macOS xattr handling is outside this
package.

## Explicit Non-Capabilities

- No CMM, color transform, tag-content grammar validation, class-required-tag matrix, registry validation, full ICC semantic conformance, transform-quality evaluation, or color-correctness claim.
- No GIF, TIFF, AVIF, HEIF, PDF, audio, video, RAW, or sidecar support. No APNG (refused as an animation, FUT-03). JPEG's own admitted surface is bounded to the frames, segments and trailer classes documented under "## JPEG" -- everything outside it refuses.
- No in-place rewrite, no ExifTool command-line compatibility, and no exhaustive tag database.
- No Electron routing, UI control, native-engine switch, or second native format is introduced by this policy.
- Animation is limited to recognized `ANIM`/`ANMF` structures with validated nested `VP8`, `VP8L`, and optional `ALPH` chunks. Unknown nested chunks are refused.
- No promise that every WebP found in the wild is accepted; refusal is part of the privacy contract.
- Codec validation is limited to VP8/VP8L headers and structural consistency. The engine preserves compressed payload bytes but is not an image decoder.
- No claim that ExifCleaner can remove its bundled ExifTool binary.

Warnings never convert an unsafe or unknown condition into success. Portable Node
does not expose an atomic unlink-if-identity-matches primitive, so this contract never
uses identity-check-then-remove cleanup. Concurrent private-stage replacements are
left untouched with bounded residue rather than treated as removable.

## ExifCleaner Integration Boundary

ExifCleaner should consult capabilities and route only verified supported WebP cases to this library. Every other format and any refused WebP remains on the existing ExifTool path. A future adapter and staged rollout require their own evidence; this contract does not silently change the app.

## Automated WebP Qualification

The supported WebP contract is admitted by several independent automated
authorities. No passing layer substitutes for another:

- deterministic grammar and hostile cases prove fail-closed container
  admission, including accepting and rejecting directions;
- transaction fault and barrier cases prove unchanged sources, no-replace
  destinations, at most one writer, bounded cancellation, and truthful terminal
  finalization;
- every successful case is reopened to prove metadata removal or requested
  preservation and byte-identical retained compressed image/animation payloads;
- pinned independent decoding proves the bounded still and animation samples
  remain decodable with the same canvas, timing, and frame evidence;
- a pinned metadata differential proves the expected namespaces are absent or
  preserved with no unreviewed difference;
- the exact packed artifact is installed with scripts disabled and exercised on
  Linux, macOS, and Windows, on x64 and arm64, under Node.js 22 and 24; and
- a fresh-process Linux x64 comparison against packed `v0.1.1` admits the locked
  time, peak-memory, payload-size slope, and cancellation limits documented in
  [WebP Benchmark Admission](benchmark-admission.md).

The final Phase 46 conclusion exists only when the immutable implementation and
tarball identities, corpus manifest, oracle authorities, all twelve installed
platform/runtime conclusions, and both benchmark conclusions agree. Pull
request benchmark reports remain visible but informational; explicit phase and
release admission uses the hard verdict.

These checks establish the behaviors named above for the committed bounded
corpus. They do not convert structural parsing into a decoder, establish color
correctness or browser parity, prove universal WebP conformance, or admit
unknown containers. Refusal remains a supported and intentional result.

## Sources

- [WebP Container Specification](https://developers.google.com/speed/webp/docs/riff_container)
- [ICC.1:2022](https://www.color.org/specifications/ICC.1-2022-05.pdf)
- [ICC v2.4 Minor Revision](https://archive.color.org/files/ICC_Minor_Revision_for_Web.pdf)
- [ExifCleaner issue #303](https://github.com/szTheory/exifcleaner/issues/303)
- [Pinned ExifCleaner baseline](https://github.com/szTheory/exifcleaner/commit/ba365b3459b0d87ce255124a5eef819aca603efd)
