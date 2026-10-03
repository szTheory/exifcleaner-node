# ISOBMFF (HEIC/AVIF) Spec Note

Status: Draft (Phase 61). Finished in Phase 62 (Locked Decision 21).

This note records the measured real-device layout, license basis, the mechanical D-04 stop
gate, and the ExifTool 13.59 HEIC baseline used to design the ISOBMFF reader and admission
classifier. It is the fresh, agent-executed evidence basis for BMF-06; see
`.planning/phases/61-isobmff-reader-and-admission-classifier/61-01-SUMMARY.md` for the full
command transcripts.

## Measured real-device sample

- **Pinned URL:**
  `https://raw.githubusercontent.com/ianare/exif-samples/f0462fcc42f7bad484fe637389b734612d97041f/heic/mobile/iphone_13_pro_max.HEIC`
- **Pinned commit:** `f0462fcc42f7bad484fe637389b734612d97041f`
- **SHA-256:** `e760c80eed310e4f27c092d5487693ca8e104e7cc01d25ba4828deb28f679676`
- **Size:** 2,182,707 bytes

### License basis (D-02)

The upstream repository `ianare/exif-samples` is **archived** and has **no LICENSE file**;
`gh api repos/ianare/exif-samples --jq '{archived: .archived, license: .license}'` reports
`license: null`. The only grant is this verbatim line from the pinned commit's `README.rst`:

> User-contributed images will be released under the Attribution-ShareAlike 4.0 International license.

This note does not describe the repository as cleanly CC-BY-SA; the bytes are **never
committed** to this repository and are compared by sha only.

### Measurement table (fresh scratch-walker run, outside every repository)

| Property                           | Measured value                                                                                                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top-level boxes                    | `ftyp` (40 bytes) / `meta` (3709 bytes) / one `mdat`                                                                                                                                                                         |
| `ftyp`                             | major `heic`; compatible `mif1 MiHE MiPr miaf MiHB heic`                                                                                                                                                                     |
| `meta` children (in order)         | `hdlr dinf pitm iinf iref iprp idat iloc`                                                                                                                                                                                    |
| `meta` total size                  | 3709 bytes                                                                                                                                                                                                                   |
| Items                              | 50 `hvc1`, 1 `grid` (item_ID 49, construction_method 1, in `idat`), 1 `mime` (item_ID 52, construction_method 0, `application/rdf+xml`), 1 `Exif` (item_ID 53, construction_method 0)                                        |
| `iloc`                             | version 1; offset_size 4, length_size 4, base_offset_size 0, index_size 0                                                                                                                                                    |
| Multi-extent items                 | none                                                                                                                                                                                                                         |
| `iref`                             | `dimg` (49 -> 48 hvc1 tiles); `thmb` (50 -> 49); `auxl` (51 -> 49, the HDR gain-map auxiliary image); `cdsc` (52 -> 51, the XMP item describing the aux image); `cdsc` (53 -> 49, the Exif item describing the grid primary) |
| `ipco` property list (index order) | 1 `colr` (`prof`), 2 `hvcC`, 3 `ispe`, 4 `ispe`, 5 `irot`, 6 `pixi`, 7 `hvcC`, 8 `ispe`, 9 `hvcC`, 10 `ispe`, 11 `pixi`, 12 `auxC`                                                                                           |
| `auxC` URN                         | `urn:com:apple:photo:2020:aux:hdrgainmap`                                                                                                                                                                                    |
| `tmap`                             | absent                                                                                                                                                                                                                       |
| XMP `mime` content type            | `application/rdf+xml`                                                                                                                                                                                                        |
| XMP payload start (first 16 bytes) | `<x:xmpmeta xmlns`                                                                                                                                                                                                           |
| XMP item size                      | 363 bytes (a small HDRGainMap-only stub -- see ExifTool baseline below)                                                                                                                                                      |
| `idat` size                        | 16 bytes                                                                                                                                                                                                                     |
| `grpl`                             | absent                                                                                                                                                                                                                       |

Source command transcripts and the full JSON measurement are in `61-01-SUMMARY.md`.

## D-04 gate

The mechanical D-04 stop gate computes `exifConstructionMethods` for every item whose
`item_type` is `Exif`, and gates `pass` iff every value is `0`.

- **Measured value:** `exifConstructionMethods: [0]` (one `Exif` item, item_ID 53, construction_method 0 -- stored file-relative in `mdat`, not `idat`-relative).
- **Gate result: `pass`.**

Because the gate passed, Task 2's `checkpoint:decision` was not triggered (Open Risk 2 does
not materialize for this sample): iPhone-shaped HEIC files store Exif in `mdat`, not `idat`,
so the D3 decline rule for a removable item with `construction_method != 0` does not apply to
this item.

## ExifTool 13.59 baseline (HEIC sample)

`exiftool -ver` printed `13.59`. `exiftool -a -G1 -s -j` against the sample produced tags in
these groups (count of distinct tag names): `Apple` (27), `Composite` (15), `ExifIFD` (33),
`ExifTool` (1), `File` (6), `ICC-header` (16), `ICC_Profile` (10), `IFD0` (9), `Meta` (2),
`QuickTime` (26), `System` (7), `XMP-HDRGainMap` (1), `XMP-x` (1).

Values for the requested identifying tags:

| Tag                          | Value                                              |
| ---------------------------- | -------------------------------------------------- |
| `IFD0:Make`                  | `Apple`                                            |
| `IFD0:Model`                 | `iPhone 13 Pro Max`                                |
| `IFD0:Software`              | `15.2.1`                                           |
| `ExifIFD:DateTimeOriginal`   | `2022:02:16 12:55:41`                              |
| `ExifIFD:OffsetTimeOriginal` | `+01:00`                                           |
| `ExifIFD:LensModel`          | `iPhone 13 Pro Max back triple camera 5.7mm f/1.5` |

**No GPS tags, no body serial** are present: `exiftool -a -G1 -s <sample> | grep -iE 'GPS|SerialNumber'` produced empty output (grep exit code 1), confirmed live during this plan's
own run.

The sample's `mime` (XMP) item is a small 363-byte stub carrying only
`XMP-x:XMPToolkit` and `XMP-HDRGainMap:HDRGainMapVersion` -- the Make/Model/date/lens
identifying data above lives entirely in the `Exif` item, not the XMP item.

### Measured structural effect of `exiftool -all=`

Running `exiftool -all= -o <out> <sample>` on the measured sample and re-running the scratch
walker on the output gives:

- Output file size: 2,180,251 bytes (2,456 bytes smaller than the 2,182,707-byte input --
  exactly the size of the removed Exif extent).
- The `mdat` box shrank from 2,178,958 to 2,176,502 bytes (also exactly 2,456 bytes), and
  remains the last, file-trailing box.
- The `Exif` item's `iloc` extent after the run: `offset: 24943, length: 0` (construction_method
  still 0). **The emptied extent's offset (24943) does NOT equal the output file size
  (2,180,251) or the end of `mdat` (2,180,251).** ExifTool removed the Exif bytes from `mdat`
  (shrinking it) and zero-lengthed the `iloc` extent in place, rather than leaving the extent's
  offset at EOF. This measured shape differs from the D-10/F-HEIC-DECL assumption that an
  ExifTool-emptied extent sits at `offset == EOF`; Phase 62's admission rule for "zero-length
  removable extent" must not assume the offset equals the file size for this container.
- The XMP `mime` item's extent was **not modified at all** by `-all=`: `offset: 24580,
length: 363` is identical before and after. `exiftool -a -G1 -s` on the `-all=` output still
  reports `XMP-x:XMPToolkit` and `XMP-HDRGainMap:HDRGainMapVersion` -- the same two tags present
  before the run. ExifTool's warning `ICC_Profile deleted. Image colors may be affected` was
  also observed; this is `F-HEIC-ICC`, already recorded in `.planning/STATE.md`, and is
  unrelated to the Exif/XMP measurement above.

## Open risk

The following layouts are **unmeasured** and remain open risk; this note does not claim
"plain mode only" coverage, since the one measured sample already carries an `auxl`/`auxC`
HDR gain-map auxiliary item (`urn:com:apple:photo:2020:aux:hdrgainmap`):

- Current-iOS (18+) ISO gain map / `tmap` box layouts.
- Portrait depth/matte auxiliary items.
- Live Photo still frames.

No maintainer device sample is requested for any of these, now or later in this phase
(D-01).

## Grammar

**Status:** pinned for the box header, `ftyp`, `iloc`, `ipma`, `infe`, `iinf`, `iref`, and `pitm`
(the fields this phase's resolver and fixture builder need). Source for every field width below
is the reference decoder **libheif v1.19.7**, read fresh from
`https://raw.githubusercontent.com/strukturag/libheif/v1.19.7/libheif/box.cc` (and `box.h`) during
this plan's execution -- not reproduced from training memory. ISO/IEC 14496-12 clause numbers are
given where the clause is conventionally known for a box of this name, but the **paywalled ISO
text itself was not re-fetched or re-read this session** (consistent with this phase's own
RESEARCH.md Open Question 2 disclosure); libheif's source is the directly-read, citable authority
for every width and conditional below. Where libheif's actual behavior diverges from the ISO
wording, that divergence is called out explicitly and libheif's behavior is normative (it is the
reference decoder real files are checked against).

### Box header (ISO/IEC 14496-12 §4.2, "Box" / "FullBox")

Source: `box.cc` `BoxHeader::parse_header` (l.228-286), `FullBox::parse_full_box_header` (l.429-438).

| Field             | Width        | Condition                                                                                     | Notes                                                                                                                                                                              |
| ----------------- | ------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `size`            | 32-bit       | always                                                                                        | if `1`, a 64-bit `largesize` follows immediately and `size` is replaced by it (l.238-253); libheif enforces `largesize <= MAX_LARGE_BOX_SIZE` (security limit, not a framing rule) |
| `type`            | 32-bit (4CC) | always                                                                                        |                                                                                                                                                                                    |
| `largesize`       | 64-bit       | only when the 32-bit `size` field read `1`                                                    | big-endian high32/low32 concatenation (l.246-250: `m_size = (high << 32) \| low`)                                                                                                  |
| `usertype`        | 16 bytes     | only when `type == "uuid"`                                                                    | l.258-273                                                                                                                                                                          |
| FullBox `version` | 8-bit        | boxes that are a `FullBox` (ftyp/pitm/iloc/infe/iinf/iref/ipma/meta when not QuickTime-style) | top byte of one 32-bit read: `version = data >> 24`                                                                                                                                |
| FullBox `flags`   | 24-bit       | same boxes                                                                                    | low 24 bits of the same 32-bit read: `flags = data & 0x00FFFFFF`                                                                                                                   |

**`size == 0`** ("box extends to the end of the file", per the ISO §4.2 convention): `BoxHeader::parse_header` stores the literal value `0` with no special-case branch anywhere in the reviewed `box.cc`/`box.h` for this tag -- end-of-file consumption, if implemented, lives outside the function cited here and was not traced further (not needed for this phase's builder, which only has to emit the literal `00000000` bytes a hostile/framing fixture requires).

### `ftyp` (ISO/IEC 14496-12 §4.3 "FileTypeBox")

Source: `box.cc` `Box_ftyp::parse` (l.1083-1103). Not a `FullBox` (no version/flags).

| Field                 | Width             | Notes                                                                                                                         |
| --------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `major_brand`         | 32-bit (4CC)      | l.1085                                                                                                                        |
| `minor_version`       | 32-bit            | l.1086                                                                                                                        |
| `compatible_brands[]` | 32-bit (4CC) each | count derived from the box's own declared size: `(box_size - header_size - 8) / 4` (l.1092-1097), not a separate length field |

### `pitm` (ISO/IEC 14496-12 §8.11.4 "PrimaryItemBox")

Source: `box.cc` `Box_pitm::parse` (l.1288-1305). FullBox, version ∈ {0, 1} (`> 1` is `unsupported_version_error`).

| Field     | v0 width | v1 width |
| --------- | -------- | -------- |
| `item_ID` | 16-bit   | 32-bit   |

### `iloc` (ISO/IEC 14496-12 §8.11.3 "ItemLocationBox")

Source: `box.cc` `Box_iloc::parse` (l.1347-1486), `Box_iloc::read_data` (l.1563-1696). FullBox,
version ∈ {0, 1, 2} (`> 2` is `unsupported_version_error`, l.1352-1354).

| Field                            | Width / presence                                | Notes                                                                                                                                                                                                                                             |
| -------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `offset_size`                    | 4-bit (top nibble of one 16-bit read)           | all versions; `(values4 >> 12) & 0xF`                                                                                                                                                                                                             |
| `length_size`                    | 4-bit                                           | all versions; `(values4 >> 8) & 0xF`                                                                                                                                                                                                              |
| `base_offset_size`               | 4-bit                                           | all versions; `(values4 >> 4) & 0xF`                                                                                                                                                                                                              |
| `index_size` (reserved in v0)    | 4-bit                                           | **only read as `index_size` for v1/v2** (`values4 & 0xF`); in v0 this nibble is still present in the 16-bit word (the word is always read) but libheif leaves `index_size` at its default `0` and never consults the nibble's value (l.1356-1363) |
| `item_count`                     | 16-bit (v0/v1) / 32-bit (v2)                    | l.1365-1370                                                                                                                                                                                                                                       |
| per item: `item_ID`              | 16-bit (v0/v1) / 32-bit (v2)                    | l.1381-1386                                                                                                                                                                                                                                       |
| per item: `construction_method`  | 16-bit field, low 4 bits used (`values4 & 0xF`) | **present only for v1/v2** (`if (version >= 1)`, l.1388-1391); absent entirely in v0                                                                                                                                                              |
| per item: `data_reference_index` | 16-bit                                          | all versions, always read (l.1393)                                                                                                                                                                                                                |
| per item: `base_offset`          | 0 / 32-bit / 64-bit, per `base_offset_size`     | widths outside `{0, 4, 8}` are **silently treated as `0`** -- the code only branches on `== 4` and `== 8` (l.1395-1401); no rejection of e.g. `base_offset_size == 3` is performed in this function                                               |
| per item: `extent_count`         | 16-bit                                          | l.1407, always read regardless of version                                                                                                                                                                                                         |
| per extent: `extent_index`       | 0 / 32-bit / 64-bit, per `index_size`           | only consulted for v1/v2 AND `index_size > 0` (l.1425-1432); same silent-zero-on-unrecognized-width behavior as `base_offset_size`                                                                                                                |
| per extent: `extent_offset`      | 0 / 32-bit / 64-bit, per `offset_size`          | same silent-zero-on-unrecognized-width behavior (l.1443-1449)                                                                                                                                                                                     |
| per extent: `extent_length`      | 0 / 32-bit / 64-bit, per `length_size`          | same silent-zero-on-unrecognized-width behavior (l.1451-1457)                                                                                                                                                                                     |

**Field order within each item record (v1/v2):** `item_ID`, `construction_method` (v≥1 only),
`data_reference_index`, `base_offset`, `extent_count`, then per-extent `(extent_index, extent_offset,
extent_length)` in that order -- `extent_index` is read before `extent_offset`/`extent_length` in
every extent, matching this phase's `must_haves` field-order requirement.

**Widths outside `{0, 4, 8}` (nuance beyond the plan's stated assumption):** `Box_iloc::parse`
does not reject a `base_offset_size`/`offset_size`/`length_size`/`index_size` nibble value outside
`{0, 4, 8}` (e.g. `3`, `5`, `15`) -- it simply falls through both the `== 4` and `== 8` branches and
the field is left at its initialized `0`, silently. Our classifier **still fails closed** on such a
value (per D-18's "fail closed" discipline and this phase's own `unsafe-structure`/`malformed-file`
decline design) rather than mirroring libheif's silent-zero behavior; this is a deliberate,
documented divergence from the reference decoder's exact parse behavior, not a bug in our reading
of it.

**`extent_length == 0` means an empty extent (zero bytes), not "to end of resource" (D-10a):**
`Box_iloc::read_data` (l.1563-1696) computes, for construction_method 0 (file-relative):

```
uint64_t skip_len = std::min(offset, extent.length);
uint64_t read_len = std::min(extent.length - skip_len, size);
...
if (read_len == 0) { continue; }   // l.1640 region -- zero-length extent contributes zero bytes
```

No code path in this function resolves an `extent.length` of `0` against the file size or against
`end of mdat`; it is read, compared via `std::min`, and produces `read_len == 0`, which the loop
skips entirely. ISO/IEC 14496-12 §8.11.3's commonly cited wording for `extent_length == 0` is "the
length of the extent is unspecified; it extends to the end of the referenced container" -- that
wording is **not implemented by libheif v1.19.7** for this box, and this grammar note records the
disagreement per this phase's maintainer-locked resolution (**D-10a**, 2026-10-01): the empty-extent
reading wins everywhere in this codebase's ISOBMFF engine. The measured iPhone sample
(`61-01-SUMMARY.md`) corroborates the empty reading in practice: after `exiftool -all=`, the Exif
item's extent is `offset: 24943, length: 0` **in place inside `mdat`**, not at EOF -- a
zero-length extent that removes zero bytes, exactly as libheif's `read_data` would produce.

### `ipma` (ISO/IEC 14496-12 §8.11.14 "ItemPropertyAssociationBox")

Source: `box.cc` `Box_ipma::parse` (l.2943-2994). FullBox, version ∈ {0, 1} (`> 1` is
`unsupported_version_error`).

| Field                             | Width / presence                                            | Notes                                                                                                          |
| --------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `entry_count`                     | 32-bit                                                      | always (not version-gated)                                                                                     |
| per entry: `item_ID`              | 16-bit (v0) / 32-bit (v≥1)                                  | gated on `get_version() < 1`, i.e. only v0 is 16-bit                                                           |
| per entry: `association_count`    | 8-bit                                                       | always, regardless of flags                                                                                    |
| per association: encoded index    | **1 byte if flags bit 0 is 0; 2 bytes if flags bit 0 is 1** | gated on `get_flags() & 1`, independent of `version` -- this is a flags-bit dimension, not a version dimension |
| per association: `essential` bit  | top bit of the 1- or 2-byte encoded index                   | 1-byte form: `essential = !!(index & 0x80)`; 2-byte form: `essential = !!(index & 0x8000)`                     |
| per association: `property_index` | remaining 7 bits (1-byte form) or 15 bits (2-byte form)     | 1-byte form: `index & 0x7f`; 2-byte form: `index & 0x7fff`                                                     |

**Two independent dimensions, confirmed (Pitfall 7):** `item_ID` width is gated by `version`;
association-index width (and therefore the essential-bit position and `property_index` bit width)
is gated by `flags & 1`, not by `version`. The resolver table must keep these two axes separate.

### `infe` (ISO/IEC 14496-12 §8.11.6.2 "ItemInfoEntry")

Source: `box.cc` `Box_infe::parse` (l.2151-2193). FullBox, version ∈ {0..3} (`> 3` is
`unsupported_version_error`; comment at l.2156 notes "only versions 2,3 are required by HEIF").

| Field                                     | v≤1                    | v≥2                       | Notes                                                                          |
| ----------------------------------------- | ---------------------- | ------------------------- | ------------------------------------------------------------------------------ |
| `item_ID`                                 | 16-bit                 | 16-bit (v2) / 32-bit (v3) | v≤1 always 16-bit; v≥2 splits again on exact version                           |
| `item_protection_index`                   | 16-bit                 | 16-bit                    | read in both branches                                                          |
| `item_name`                               | null-terminated string | null-terminated string    | `read_string()`                                                                |
| `content_type`                            | null-terminated string | absent (see below)        | v≤1 only                                                                       |
| `content_encoding`                        | null-terminated string | absent (see below)        | v≤1 only                                                                       |
| `hidden_item` flag                        | n/a                    | `flags & 1`               | v≥2 only; this is the admission-relevant "hidden" bit (grid tiles, thumbnails) |
| `item_type_4cc`                           | n/a (implicitly 0)     | 32-bit (4CC)              | v≥2 only                                                                       |
| `item_name` (v≥2)                         | --                     | null-terminated string    | read unconditionally after `item_type_4cc`                                     |
| `content_type` / `content_encoding` (v≥2) | --                     | null-terminated strings   | **only when `item_type_4cc == "mime"`**                                        |
| `item_uri_type` (v≥2)                     | --                     | null-terminated string    | **only when `item_type_4cc == "uri "`** (note the trailing space in the 4CC)   |

This is the source for the XMP `mime` item's `content_type` field this phase's classifier reads
(`application/rdf+xml`, D-07) -- it only exists on a v≥2 `infe` whose `item_type_4cc` is `mime`.

### `iinf` (ISO/IEC 14496-12 §8.11.6.1 "ItemInfoBox")

Source: `box.cc` `Box_iinf::parse` (l.2297-2312). FullBox.

| Field         | Width                                     | Notes                                                                    |
| ------------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| `entry_count` | 16-bit (version 0) / 32-bit (version > 0) | `nEntries_size = (version > 0) ? 4 : 2`                                  |
| children      | `entry_count` × `infe` boxes              | if `entry_count == 0`, parsing returns immediately with no children read |

### `iref` (ISO/IEC 14496-12 §8.11.12 "ItemReferenceBox")

Source: `box.cc` `Box_iref::parse` (l.3462-3530). FullBox, version ∈ {0, 1} (`> 1` is
`unsupported_version_error`).

Each `iref` box contains a sequence of `SingleItemTypeReferenceBox` records read until EOF. Each
record is itself a box (its own 4CC _is_ the reference type, e.g. `dimg`, `thmb`, `auxl`, `cdsc`):

| Field                       | Width                          | Notes                                                                 |
| --------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| reference-record box header | per Box header rules above     | the record's `type` (4CC) is the reference type, not a separate field |
| `from_item_ID`              | 16-bit (v0) / 32-bit (v1)      | `read_len = (version == 0) ? 16 : 32`                                 |
| `reference_count`           | 16-bit                         | **always 16-bit regardless of version** -- not gated by `read_len`    |
| `to_item_ID[]`              | 16-bit (v0) / 32-bit (v1) each | same `read_len` as `from_item_ID`; `reference_count` entries          |

`reference_count == 0` is explicitly rejected (`heif_suberror_Unspecified`, "iref box with no
references", l.3485-3488) -- not merely unusual, a hard parse error in the reference decoder.

## Fixtures

Two real `heif-enc -T` fixtures are committed under `tests/isobmff-support/fixtures/` (D-22): a
2x2 grid of 64x64 tiles with a 32x32 thumbnail, Exif and XMP metadata, encoded once with x265
(HEIC) and once with aom (AVIF). The full generation recipe -- tool versions, every command line,
and every measured structural fact -- lives in `tests/isobmff-support/fixtures/RECIPE.md`; this
section is a summary for readers who only need the shape, not the transcript.

| Fixture              | Size       | Encoder                     | SHA-256                                                            |
| -------------------- | ---------- | --------------------------- | ------------------------------------------------------------------ |
| `heif-enc-grid.heic` | 4243 bytes | x265 4.1 (libheif 1.19.7)   | `ae40a80f0a85cd984b9d8b1a2e811e138ac2c8c26f14b77360d62e1e4867bad6` |
| `heif-enc-grid.avif` | 3997 bytes | aom 3.12.0 (libheif 1.19.7) | `682a1e626c4d8db4f7ccf4a2d5058d0104394f7a08d0a70fad3950bed4b0a85e` |

Both fixtures share the same structure: item 1 is the `grid` primary (constructionMethod 1, its 8-
byte descriptor stored in `idat`), items 2-5 are hidden tile items (`hvc1` for HEIC, `av01` for
AVIF), item 6 is a hidden `Exif` item (178 bytes), item 7 is a hidden `mime` item carrying XMP
(2876 bytes), and item 8 is a visible thumbnail referenced by a `thmb` reference. `iref` also
carries a `dimg` reference from the grid to its four tiles and two `cdsc` references (Exif and XMP
both describe the primary -- the D-08 "removable item as the _from_ side of `cdsc`" shape).

**Measured XMP content type (D-07):** both fixtures' `mime` item reports content_type
`application/rdf+xml`, matching the iPhone sample measured in 61-01. Neither fixture emits
`application/xmp+xml`; that content type is still not admitted anywhere in this engine, per D-07's
"only once measured" rule.

**ExifTool 13.59 baseline (both fixtures):** `Make=ExifCleanerFixture`, `Model=GridTile`,
`Orientation=Horizontal (normal)` (raw value 1), `XResolution=72`, `YResolution=72`,
`ColorSpace=sRGB`, `ExifImageWidth=64`, `ExifImageHeight=64` (the tile's own embedded Exif, since
`heif-enc` propagates the first tile's Exif/XMP onto the composite output rather than re-deriving
primary-image-sized Exif), `XMPToolkit=Image::ExifTool 13.59`, `Title=ExifCleaner Fixture Tile`.
Identical tag set and values on both the HEIC and AVIF fixture, since both were encoded from the
same tiles.

**`exiftool -all=` structural effect (both fixtures):** items 1-5 are unchanged; the Exif item (6)
and the XMP item (7) are both emptied to a zero-length extent at the _same_ `base_offset` (the
point in `mdat` where the removed bytes used to begin); the thumbnail item (8) is shifted left to
close the resulting gap. `mdat` shrinks by exactly the removed Exif+XMP byte count (3054 bytes: 178

- 2876. in both files. This is a second, independently measured shape for the D-10a empty-extent
        rule, distinct from 61-01's iPhone measurement (there, the emptied extent stayed at its original
        offset with no other item shifted). Both measured shapes land the emptied extent's offset _within_
        the (possibly shrunk) `mdat` payload bounds -- neither produces the ISO/IEC 14496-12 "to end of
        resource" shape that D-10a's citation says the reference decoder (libheif v1.19.7) does not
        implement. Full before/after offset tables are in RECIPE.md.

**Checkpoint note:** an earlier attempt at generating these fixtures crashed `heif-enc -T` with a
SIGBUS inside libheif's `extend_to_size_with_zero`, on this same pinned libheif/x265/aom build.
Root cause (confirmed before this fixture set was generated): the crashing attempt's tiles were not
actually 64x64 -- a `sips` center-crop step produced oversized tiles (128x128, and separately
512x512 in a 256-px variant), and an oversized tile crashes the tiled encoder instead of producing
a clean error. The recipe used here avoids cropping entirely (each tile is rendered directly at
64x64) and asserts every tile's dimensions with `sips -g pixelWidth -g pixelHeight` immediately
before encoding. This is not a libheif defect and does not change anything about the pinned
toolchain versions.

## Decline classes

`src/isobmff/errors.ts` defines the closed internal union `IsobmffDeclineClass` (26 members) and
`DECLINE_CLASS_TO_KIND`, a `satisfies Record<IsobmffDeclineClass, ...>` table mapping each class to
one of the three public `MetadataErrorDetails["code"]` values this engine can report
(`unsupported-format` | `unsafe-structure` | `malformed-file`, D-11/D-12). A new class added
without a kind mapping fails typecheck.

**D-06 (62-12): a second, coarser public mapping.** `src/isobmff/refusals.ts` defines the seven-
member `HeifRefusal` union (`malformed-container`, `resource-limits`, `image-sequence`,
`unknown-boxes`, `unknown-item-types`, `unsupported-features`, `unsafe-item-layout`) and
`HEIF_REFUSAL_BY_DECLINE_CLASS`, a `satisfies Record<IsobmffDeclineClass, HeifRefusal>` table
mapping every internal class to one of those seven -- this is the literal set the eventual
`HeicCapabilities["refuses"]`/`AvifCapabilities["refuses"]` arrays advertise (62.1-07 wires the
real capability literal). The "Public refusal" column below pins every row.

Three classes close structural gaps D-12's own mapping table does not name
(`meta-handler-not-pict`, `unsupported-box-version`, `item-graph-invalid`) -- planner discretion
recorded in 61-CONTEXT.md's "Flagged assumptions"; they add no public type.

Every class is now wired: the framing/top-level/cap classes by `src/isobmff/boxes.ts`/`parse.ts`
(61-04), and the remaining D3/D5 item-level classes by `src/isobmff/items.ts` (61-07, item-graph
validity) and `src/isobmff/admission.ts` (61-08, the D3/D5 removable/surviving rules;
`DECLINE_RULE_ORDER`).

| Class                          | Public code          | Rule source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `removable-item-in-idat`       | `unsupported-format` | D3: a removable item whose extent lives in `idat` (construction_method 1) is not admitted -- only a _surviving_ grid/`idat` shape is (D-09/D3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `construction-method-2`        | `unsupported-format` | D3: any item with `construction_method == 2` (data-reference-indexed) is not admitted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `external-data-reference`      | `unsupported-format` | D3: an item with `data_reference_index != 0` (an external file reference) is not admitted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `multiple-mdat`                | `unsupported-format` | D3/D5: more than one top-level `mdat` is not admitted. Triggered in `parse.ts` on a second `mdat`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `unknown-item-type`            | `unsupported-format` | D3: an item type outside the closed admitted set (D-07's XMP `mime` rule, etc.) is not admitted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `sequence-box`                 | `unsupported-format` | D3/D5: a top-level `moov` box indicates a sequence/fragmented file. Triggered in `parse.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `sequence-brand`               | `unsupported-format` | D-06/D-18: the `msf1`/`avis` sequence brands are never admitted (brand classification, 61-05+).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `unknown-meta-child`           | `unsupported-format` | D5: a `meta` child box outside the closed set this engine understands.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `top-level-box-not-allowed`    | `unsupported-format` | D5: any top-level box outside `{ftyp, meta, mdat, free, skip}` and the C2PA `uuid`. Triggered in `parse.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `meta-handler-not-pict`        | `unsupported-format` | Planner-added closure: `meta`'s `hdlr` box must declare handler_type `pict`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `unsupported-box-version`      | `unsupported-format` | Planner-added closure: an `iloc` version > 2, `ipma` version > 1, `infe` version < 2, or `iref`/`pitm` version > 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `brand-mismatch`               | `unsupported-format` | **D-09(b) (62-12)**: a handler's own `admit` re-classifies the parsed `ftyp` brand set (`classifyIsobmffBrand` over `admitIsobmff`'s already-parsed `majorBrand`/`compatibleBrands`, never a fresh byte read) and declines when it differs from the handler's own brand -- catches a file swapped between selection (`matches`) and admission, strictly before any write.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `removable-extent-overlap`     | `unsafe-structure`   | D5: a removable item's extent overlaps a surviving item's extent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `removable-item-referenced`    | `unsafe-structure`   | D5: a removable item is an `iref` to-target, `pitm`, or `grpl` member (D-08's `cdsc`-from exception does not apply to to-targets).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `surviving-zero-length-extent` | `unsafe-structure`   | D-10a: a zero-length extent on a _surviving_ item (the D-10a empty-extent rule only admits this shape for removable items).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `surviving-offset-width-zero`  | `unsafe-structure`   | D5: a surviving (construction_method 0) item whose `iloc` offset field width is 0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `cap-meta-bytes`               | `unsafe-structure`   | BMF-05 (PNG D-25 precedent): the declared `meta` payload size exceeds `IsobmffCaps.maxMetaBytes`. Triggered in `IsobmffBudget.checkMetaSize`, checked before the `meta` payload is read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `cap-box-count`                | `unsafe-structure`   | BMF-05: the running box count exceeds `IsobmffCaps.maxBoxCount`. Triggered in `IsobmffBudget.countBox`, checked before each box is recorded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `cap-box-depth`                | `unsafe-structure`   | BMF-05: a container descent's depth exceeds `IsobmffCaps.maxBoxDepth`. Triggered in `IsobmffBudget.checkDepth`, checked before descending.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `cap-buffered-bytes`           | `unsafe-structure`   | BMF-05: the aggregate bytes buffered from outside `meta` (Exif/XMP item payload reads) exceeds `IsobmffCaps.maxBufferedBytesTotal`. Triggered in `admitIsobmff` (61-08): `IsobmffBudget.consumeBuffered(extent.length)` runs immediately before each extent's `readExactly` call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `extent-outside-mdat`          | `malformed-file`     | D-10a: an extent's offset is outside the single `mdat` payload (or, for a removable item's emptied extent, outside the file); also thrown by `admission.ts`'s `addSafeOffsets` when `item.baseOffset + extent.offset` (or `+ extent.length`) exceeds `Number.MAX_SAFE_INTEGER`, even though each operand is individually safe (WR-01, code review 2026-10-01).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `meta-not-fullbox`             | `malformed-file`     | D-11: `meta` is not a version-0 `FullBox` -- a QuickTime-style `meta` (no version/flags) or an unsupported `meta` version. Triggered in `parse.ts` via the first-4-payload-bytes-nonzero check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `duplicate-meta`               | `malformed-file`     | D5: a second top-level `meta` box. Triggered in `parse.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `box-framing`                  | `malformed-file`     | ISO/IEC 14496-12 S4.2: a short read, a declared size of 2..7, a `size==1` largesize below 16 bytes or above `Number.MAX_SAFE_INTEGER`, a box extending past its parent or the file, a `size==0` box that is not the top-level `mdat`, a `size==0` box inside any container, a first top-level box that is not `ftyp`, a second top-level `ftyp` box (WR-03, code review 2026-10-01), or an `iinf` child box too short to carry the single version byte `containerChildOffset` reads to locate its children (CR-01, code review 2026-10-01). Triggered throughout `src/isobmff/boxes.ts` and `src/isobmff/parse.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `item-graph-invalid`           | `malformed-file`     | Planner-added closure: a missing or duplicate required item table (`iloc`/`iinf`/`pitm`), a dangling `iref`/`pitm`/`grpl` item reference, an `iinf` item with no corresponding `iloc` entry at all (WR-02, code review 2026-10-01 -- distinct from a _present_ `iloc` entry with `extent_count 0`, D-10a's legitimate "admitted, emptied" shape), or another item-graph inconsistency (61-07). **D-17 (62-04, closes 61-SECURITY Phase 62 input 2)** extends this class with five further conditions, each checked in `buildItemModel` before any write: (1) an `ipma` entry whose `item_ID` is not declared in `iinf`; (2) an `ipma` association whose property index is 0 or greater than the `ipco` property count; (3) a `grpl` entity_id that is not a declared item; (4) any `meta` child type that appears twice, or a second `ipco`/`ipma` inside `iprp` (closes the `.find()`-silently-uses-the-first-match gap in every meta/iprp lookup); (5) a `dinf`/`dref` entry other than a self-contained `url ` box (`flags & 1`, zero bytes after its own FullBox header) -- **this dref rule is inferred from the 62-01 measurement of the one real iPhone sample's single `url `/flags-1/0-trailing-bytes entry (see "iPhone idat coverage and dref entries" below), not from a corpus.** |
| `offset-rewrite-overflow`      | `unsafe-structure`   | **D-12 (62-05)**: raised from `buildIsobmffOutputPlan`/`checkIsobmffOutputPlan`, strictly before any byte is written, when a rewritten `iloc` base_offset or extent offset would be negative (an item's own extents are declared out of ascending-source-offset order, so its first extent is not actually the smallest once the D-15 mdat union reorders survivors) or does not fit its declared field width, or when the rewritten `mdat` payload length would not fit the source's own header form (a normal/size-zero source must still fit an explicit 32-bit size; widths/header forms are never widened to make a value fit -- D-12). The admitted-but-undeclinable shape this guards against previously surfaced as an uncaught `Buffer.writeUInt32BE` `RangeError`, not a clean decline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Public refusal mapping (D-06, 62-12)

`src/isobmff/refusals.ts`'s `HEIF_REFUSAL_BY_DECLINE_CLASS` (`satisfies Record<IsobmffDeclineClass,
HeifRefusal>`) maps every one of the 26 internal classes above to one of the seven coarse public
`HeifRefusal` literals -- the set the eventual `HeicCapabilities`/`AvifCapabilities["refuses"]`
arrays advertise (62.1-07). A class added without a row here fails typecheck, and
`tests/isobmff_handlers.test.ts` pins every row and that the value set equals exactly these seven
literals.

| Public refusal         | Internal classes                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `malformed-container`  | `box-framing`, `meta-not-fullbox`, `duplicate-meta`, `extent-outside-mdat`, `item-graph-invalid`                                                                    |
| `resource-limits`      | `cap-meta-bytes`, `cap-box-count`, `cap-box-depth`, `cap-buffered-bytes`                                                                                            |
| `image-sequence`       | `sequence-box`, `sequence-brand`                                                                                                                                    |
| `unknown-boxes`        | `top-level-box-not-allowed`, `unknown-meta-child`                                                                                                                   |
| `unknown-item-types`   | `unknown-item-type`                                                                                                                                                 |
| `unsupported-features` | `removable-item-in-idat`, `construction-method-2`, `external-data-reference`, `multiple-mdat`, `meta-handler-not-pict`, `unsupported-box-version`, `brand-mismatch` |
| `unsafe-item-layout`   | `removable-extent-overlap`, `removable-item-referenced`, `surviving-zero-length-extent`, `surviving-offset-width-zero`, `offset-rewrite-overflow`                   |

## Memory caps

`src/isobmff/caps.ts` exports four injectable resource caps (BMF-05), each guarding a distinct
resource so each one can be removed alone in a negative control (D-23):

| Cap                                | Default value | Guards                                                                                             | Checked before                                                                        |
| ---------------------------------- | ------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `ISOBMFF_MAX_META_BYTES`           | 16 MiB        | the single top-level `meta` box's declared payload size                                            | `meta`'s payload is read into memory (`IsobmffBudget.checkMetaSize`)                  |
| `ISOBMFF_MAX_BOX_COUNT`            | 65,536        | the running count of every box recorded, top-level and within `meta`                               | each box header is recorded (`IsobmffBudget.countBox`)                                |
| `ISOBMFF_MAX_BOX_DEPTH`            | 8             | container-nesting depth inside `meta` (`dinf`/`iprp`/`ipco`/`grpl`/`iinf`/`iref`)                  | descending into a nested container (`IsobmffBudget.checkDepth`)                       |
| `ISOBMFF_MAX_BUFFERED_BYTES_TOTAL` | 32 MiB        | the aggregate bytes buffered from outside `meta` (every removable item's own Exif/XMP extent read) | each extent's `readExactly` call (`IsobmffBudget.consumeBuffered`, in `admitIsobmff`) |

**`ISOBMFF_MAX_META_BYTES` vs. the measured real-device sample:** the measured iPhone 13 Pro Max
sample's `meta` box is 3,709 bytes (see the "Measured real-device sample" table above).
`ISOBMFF_MAX_META_BYTES` (16 MiB = 16,777,216 bytes) is approximately 4,524x that measured size
-- comfortably over the 256x headroom floor this phase's own discretion note requires.

**Combined worst case:** a single admitted file's resident working set from this engine's own
buffering is bounded by `ISOBMFF_MAX_META_BYTES + ISOBMFF_MAX_BUFFERED_BYTES_TOTAL` = 16 MiB + 32
MiB = 48 MiB, plus whatever headroom the box-count/depth caps leave for `BoxHeader` bookkeeping
objects (bounded in count, not in declared byte size) -- `mdat`'s own payload is never buffered in
full regardless of its declared size (61-04's 1 GiB sparse-read-log proof; `admitIsobmff` only
ever reads a removable item's own small extents, each individually capped by
`maxBufferedBytesTotal`).

**Every cap is checked before the read or descent it guards, never after** (the "Checked before"
column above; mirrors `BufferedBudget`/`InflateBudget`, `src/png/chunks.ts:548-571, 817-838`).

**Caps are not advertised in `FormatCapabilities.limits` in Phase 61** -- no public type changes
this phase (D-15; 61-CONTEXT.md "Claude's Discretion"). Phase 62 decides whether to surface them
when `heic`/`avif` handlers are registered.

**Measurement method (D-29):** `tests/isobmff_memory.test.ts` + `tests/isobmff_memory_child.mjs`
prove each cap discriminates with a real, measured child-process peak RSS: one fixture per cap,
each declining under the real default caps at or below `ISOBMFF_MEMORY_RSS_CEILING_BYTES`, and
each fixture re-run with that one cap alone raised to `Number.POSITIVE_INFINITY` (every other cap
left at its real default) measuring strictly above the ceiling -- except the box-depth negative
control, which may instead exhaust the JS call stack (a "crash" outcome) rather than grow RSS,
since `walkContainer` recurses once per nesting level; both outcomes prove the depth cap is
load-bearing. No measured RSS figure is published here or in any test/CHANGELOG text (60-CONTEXT
D-29); the recorded figures and the exact ceiling derivation live in
`.planning/phases/61-isobmff-reader-and-admission-classifier/61-11-SUMMARY.md`.

## Admission of the measured sample

`src/isobmff/admission.ts` implements the D3/D5 admission classifier (`classifyIsobmffModel`,
`admitIsobmff`) over the item graph (61-07). Proof against both real `heif-enc -T` fixtures
(`tests/isobmff-support/fixtures/`) and a hand-built, measured-iPhone-shaped file
(grid-in-`idat` primary, hidden tiles via `dimg`, an `hvc1` thumbnail via `thmb`, an `auxl`
`hdrgainmap` target, and `cdsc`-from-item Exif/XMP) lives in `tests/isobmff_admission.test.ts`.

**BMF-06 goal check (fresh, agent-executed, 2026-10-01):** the public iPhone 13 Pro Max sample
(`ianare/exif-samples` @ `f0462fcc42f7bad484fe637389b734612d97041f`,
sha256 `e760c80eed310e4f27c092d5487693ca8e104e7cc01d25ba4828deb28f679676`, 2,182,707 bytes --
re-verified identical to the D-01 pin) is **admitted** by `admitIsobmff` from the built `dist/`
output, with `removableItemIds` exactly `[52, 53]` -- item 52 is the `mime`/`application/rdf+xml`
XMP item, item 53 is `Exif` (matching the item ids the independent inventory walker recorded in
61-03). No bytes of the sample are committed; only its sha is quoted (D-02).

ExifTool 13.59's `-all=` output of the same sample (regenerated fresh in scratch, not reused from a
prior session) is **also admitted**, with `removableItemIds` unchanged (`[52, 53]`) but
`emptiedItemIds` equal to `[53]` only. A direct `exiftool -XMP:all` comparison before/after `-all=`
shows the XMP tags (`XMPToolkit`, `HDRGainMapVersion`) are byte-identical -- **on this real sample,
ExifTool 13.59's `-all=` empties the Exif item in place but does not touch the XMP `mime` item at
all**, leaving its full, non-empty extent exactly as in the source. This is a new measured fact,
distinct from the `heif-enc` synthetic fixtures (61-03), where `-all=` emptied _both_ Exif and XMP
to the same `base_offset`. Both are legitimate, independently measured ExifTool shapes under
D-10a's single rule (a removable item's extents are either admitted whole or admitted emptied); the
amended admission classifier handles both without special-casing either.

Both admitted runs report namespace `ICC` (the primary item's `colr` is colour_type `prof`, a real
embedded ICC profile, not `nclx`) -- consistent with F-HEIC-ICC (`.planning/STATE.md`): ExifTool's
"ICC_Profile deleted" warning on `-all=` never actually removes the `colr` box's structural bytes,
so the cleaned output still carries it.

**Bug found and fixed by this execution-time check (Rule 1):** running the real sample through the
actual engine for the first time (prior plans proved `buildItemModel` only against `heif-enc`
fixtures and the independent inventory walker, never against this file through `src/isobmff/`
itself) surfaced a parser defect: `src/isobmff/items.ts`'s `parseInfe` treated a `mime` item's
`content_encoding` field as mandatory, but ISO/IEC 23008-12 9.2 declares it OPTIONAL -- the real
sample's XMP `infe` box (item 52) ends exactly at `content_type`'s own NUL terminator, with zero
bytes remaining for `content_encoding`. Fixed by only attempting to read `content_encoding` when
bytes remain after `content_type`; an absent field now reads as `undefined`, the same
"no encoding declared" meaning `admission.ts`'s XMP-removable check already gives an explicit empty
string. Every `heif-enc`/builder fixture happened to write an explicit empty `content_encoding`
(one NUL byte), which is why this was never caught before the real-sample proof ran.

## Writer baseline (Phase 62 measurements)

Everything in this section was produced by this plan's own executed commands, in scratch, against
the branch `gsd/phase-62-isobmff-writer` cut from `main` at `cb10772`. No value here is cited from
`62-RESEARCH.md` or an earlier scratch session; each subsection names the command that produced it.
A dependency-free scratch box walker (`walk62.mjs`, outside every repository) parsed top-level
boxes, `meta` children, `iloc`, `iinf`/`infe`, `iref`, `idat`, and `dinf`/`dref` directly from the
raw bytes to produce the figures below.

### heif-enc fixture layout

Measured on both committed fixtures (`tests/isobmff-support/fixtures/heif-enc-grid.heic` and
`.avif`) with the scratch walker, reading `iloc`'s FullBox version and its four packed-nibble
widths directly:

| Fixture            | `iloc` version | `offset_size` | `length_size` | `base_offset_size` | `index_size` |
| ------------------ | -------------- | ------------- | ------------- | ------------------ | ------------ |
| heif-enc-grid.heic | 1              | 4             | 4             | 4                  | 0            |
| heif-enc-grid.avif | 1              | 4             | 4             | 4                  | 0            |

**This supersedes 62-CONTEXT's "heif-enc iloc v0" phrasing.** The fresh measurement reads
`iloc` version **1** on both fixtures, not version 0. (Version 1 is what makes
`construction_method` meaningful per item; a version-0 box would have no per-item construction
method field at all, and item 1 here is a `cm=1` grid item, so version 1 is structurally
necessary and consistent with the byte-level read.)

Exif item (item_ID 6, `infe` type `Exif`, hidden) position relative to its own fixture's `mdat`
payload, computed as `base_offset + extent_offset` minus the `mdat` payload bounds:

| Fixture | Exif item abs offset | extent length | bytes from `mdat` payload start | bytes from `mdat` payload end |
| ------- | -------------------- | ------------- | ------------------------------- | ----------------------------- |
| heic    | 1155                 | 178           | 171                             | 2910                          |
| avif    | 912                  | 178           | 169                             | 2907                          |

The Exif item is not at the tail of `mdat` in either source fixture -- a hidden thumbnail
(`hvc1`, item 8) and a zero-length `mime`/XMP item (item 7) both follow it in `iloc` order, and
item 8's extent is the one that actually reaches the `mdat` payload end (0 bytes remaining).

### ExifTool 13.59 minimal-Exif placement

Produced with `perl exiftool -all= -TagsFromFile @ -Orientation <RESOLUTION_PRESERVE_ARGS> -o
q1.<ext> src.<ext>` (the app's full preserving argument shape,
`exifcleaner-electron/src/infrastructure/exiftool/exiftool_adapter.ts:289-318`, against
`RESOLUTION_PRESERVE_ARGS` from `src/domain/exif/exif.ts:69-78`), then walked with the same
scratch walker:

| Fixture | output item ID | source item ID | ID reused | bytes from `mdat` payload end | first 10 payload bytes (hex) |
| ------- | -------------- | -------------- | --------- | ----------------------------- | ---------------------------- |
| heic    | 6              | 6              | yes       | 34                            | `000000004d4d002a0000`       |
| avif    | 6              | 6              | yes       | 31                            | `000000004d4d002a0000`       |

The Exif item ID is reused in place on both formats, matching 62-CONTEXT D-13's claim. Placement
is **not** at the `mdat` tail on either format -- the (unchanged, still-hidden) thumbnail item
that heif-enc wrote after it in `iloc` order still follows it and is the item whose extent
actually reaches the `mdat` payload end.

**This measurement contradicts 62-CONTEXT's "ExifTool writes prefix `00000006` \"Exif\\0\\0\""
claim.** The first 4 bytes of the payload (the `exif_tiff_header_offset` field) read
`00000000` on both fixtures, immediately followed by the TIFF header `4d4d002a0000...` (`MM`,
big-endian, magic `0x002a`) -- there is no `"Exif\0\0"` prefix and no offset-6 indirection in
this measurement. The TIFF header's IFD0 holds exactly 4 entries: `Orientation` (tag `0x0112`,
value 1), `XResolution`/`YResolution` (tags `0x011A`/`0x011B`, both rational `72/1` at the
trailing offsets `0x3e`/`0x46`), and `ResolutionUnit` (tag `0x0213`, value 1) -- i.e. exactly the
tags the app's preserving argument shape requests, nothing else.

### ExifTool re-run stability

Produced by running the plain-removal form (`-all= -o p1.<ext>`) and the preserving form
(`-all= -TagsFromFile @ -Orientation <RESOLUTION_PRESERVE_ARGS> -o q1.<ext>`) over each fixture,
then re-running the identical command over each result (`p1`→`p2`, `q1`→`q2`) and comparing with
`cmp`:

| Comparison        | Result    |
| ----------------- | --------- |
| heic `p1` vs `p2` | identical |
| heic `q1` vs `q2` | identical |
| avif `p1` vs `p2` | identical |
| avif `q1` vs `q2` | identical |

All four cmp results are byte-identical, confirming ExifTool 13.59's re-run stability on both
HEIC and AVIF under both argument forms used by the app.

### ExifTool and top-level free/skip

Produced by appending a synthetic 16-byte top-level `free` box (payload `0xAB` repeated) and,
separately, a synthetic 16-byte top-level `skip` box (payload `0xCD` repeated) after `mdat` on
copies of both fixtures, then running `perl exiftool -all= -o out.<ext> synth.<ext>` and walking
the result:

| Fixture | Box    | Kept | Payload bytes       | Position relative to `mdat`                            |
| ------- | ------ | ---- | ------------------- | ------------------------------------------------------ |
| heic    | `free` | yes  | `ab` x16, unchanged | moved to **before** `mdat` (between `meta` and `mdat`) |
| heic    | `skip` | yes  | `cd` x16, unchanged | moved to **before** `mdat` (between `meta` and `mdat`) |
| avif    | `free` | yes  | `ab` x16, unchanged | moved to **before** `mdat` (between `meta` and `mdat`) |
| avif    | `skip` | yes  | `cd` x16, unchanged | moved to **before** `mdat` (between `meta` and `mdat`) |

ExifTool 13.59 keeps both top-level `free` and `skip` boxes with their payload bytes untouched,
on both formats. It does **not** preserve their top-level position relative to `mdat`: the
synthetic boxes were appended after `mdat` in the input, and ExifTool's `-all= -o` output
relocates them to immediately before `mdat` (right after `meta`) on every one of the four runs.
This is recorded as input to D-27; it does not by itself decide whether entry (e) (top-level
`free`/`skip` dropped) stays in the permitted-difference list, since ExifTool keeps the boxes --
it only changes their position, which D-27's later plan must account for separately if it adopts
entry (e) at all.

### iPhone idat coverage and dref entries

Produced by fetching the pinned iPhone 13 Pro Max sample to scratch (never committed to any
repository), verifying its hash and size, and walking it with the scratch walker:

```
$ shasum -a 256 iphone.heic
e760c80eed310e4f27c092d5487693ca8e104e7cc01d25ba4828deb28f679676  iphone.heic
$ wc -c iphone.heic
 2182707 iphone.heic
```

Both the sha256 and the byte count match the pinned values exactly.

`idat` payload length: **8 bytes**. Exactly one item uses `construction_method` 1 (idat-relative
addressing): item 49 (`infe` type `grid`, the primary image, not hidden), with one extent at
`idat`-relative offset 0, length 8. That single extent's range `[0, 8)` is the entire `idat`
payload, so:

| Metric                                                   | Value |
| -------------------------------------------------------- | ----- |
| `idat` payload length                                    | 8     |
| bytes claimed by `construction_method 1` extents (union) | 8     |
| unclaimed bytes                                          | 0     |

On this real sample, the `idat` box carries no unclaimed/residue bytes -- every byte is claimed
by the one `cm=1` item's extent. This measurement does not generalize to every possible writer
output; it is recorded here as the measured fact for this one pinned sample, per 62-CONTEXT's
Deferred Ideas item on unclaimed `idat` bytes.

`dinf`/`dref` entries (walked from `meta/dinf/dref`): exactly one entry, type `url `, version 0,
flags `1` (bit 0 set -- self-contained, no location string), with **0 bytes** remaining after
the entry's own FullBox header (`bytesAfterFullBox: 0`). This is consistent with 62-CONTEXT
D-17's inferred dref admission rule (admit only `url ` with `flags & 1` and no location string)
on the one real-world sample measured here.

### Baseline test run

Before any edit on `gsd/phase-62-isobmff-writer` (cut from `main` at `cb10772`), `npm run build &&
npm run build:native` succeeded, and a full `npx vitest run --reporter=json` reported:

| Metric            | Value |
| ----------------- | ----- |
| `numTotalTests`   | 1967  |
| `numPassedTests`  | 1826  |
| `numPendingTests` | 141   |
| `numFailedTests`  | 0     |

## Writer (Phase 62)

`src/isobmff/{plan,rebuild,writer,verify}.ts` implement a full rebuild writer: every admitted
HEIC/AVIF source is parsed once, a complete `IsobmffOutputPlan` is computed and checked before any
byte is written, then the plan's parts are streamed to the destination and the destination is
re-parsed and checked against the source before the engine ever commits it. The engine behind
this section is unreachable from any registered format (`src/admission/{heic,avif}-handler.ts`
exist but are not in `HANDLERS`; see the Decline classes section and `tests/isobmff_handlers.test.ts`)
-- this section documents the writer contract 62.1 and later formats build on, not a shipped
public behavior.

The governing principle, measured against ExifTool 13.59's own re-run stability (see "ExifTool
re-run stability" above): **copy the source's own encoding and change values only.** This is what
makes `clean(clean(x)) == clean(x)` hold by construction (D-19, ISO-06).

### D-11: `iloc` rewrite

The rewritten `iloc` box keeps the source's own `version`, `offset_size`, `length_size`,
`base_offset_size` and `index_size` unchanged -- widths are never widened or narrowed to make a
value fit (see D-12). For a surviving `construction_method 0` item, every extent's new absolute
position is `newAbs = map(oldAbs)`, where `map` resolves a source byte offset through the D-15
merged `mdat` union. If `base_offset_size > 0`, the item's new `base_offset` is
`map(first extent's old absolute offset)` and each extent's own offset field becomes
`map(abs_i) - newBase`; if `base_offset_size == 0`, each extent's offset field is `map(abs_i)`
directly, with no base. `extent_index` and `construction_method` are always copied verbatim, and
a `construction_method 1` (`idat`-relative) record's `iloc` entry is copied byte-for-byte, never
recomputed. The minimal Exif item (D-13) follows the same base/offset split: when
`base_offset_size > 0`, its base is the `mdat` tail position and its one extent offset is 0;
otherwise its one extent offset is the tail position itself, with length equal to its payload
length.

Proven across every admitted `(version, offset_size, length_size, base_offset_size, index_size)`
combination by `tests/isobmff_writer.test.ts`'s "D-11 iloc layout matrix (62-05)" (26 cases).

### D-12: `offset-rewrite-overflow`

A new internal decline class, raised in `buildIsobmffOutputPlan`/`checkIsobmffOutputPlan` strictly
before any byte is written, when: a rewritten base, offset or length does not fit its declared
field width; a relative offset computed under D-11 would go negative (an item's own extents were
declared out of ascending-source-offset order, so the D-15 union reorders them); the rewritten
`mdat` payload length would not fit the source's own header form; or the minimal Exif item needs a
location but the source's `iloc` cannot express one (`offset_size == 0 && base_offset_size == 0`,
or `length_size == 0`). Widths and header forms are never widened to make a value fit -- the file
declines instead. Before this check existed, the admitted-but-undeclinable shape surfaced as an
uncaught `Buffer.writeUInt32BE` `RangeError`, not a clean decline (see "Decline classes" below for
the `offset-rewrite-overflow` row).

Proven end to end (admits, then declines one stage later, zero writes) by
`tests/isobmff_hostile.test.ts`'s `offset-rewrite-overflow` fixture (62-05) and its "D-12 minimal
Exif location (62-07)" describe block, and cross-checked by `tests/isobmff_proof_harness.test.ts`'s
per-class decline loop.

### D-13: minimal Exif item

Source item **k** is the first item, in `iinf` declaration order, that is a non-emptied `Exif`
item whose `cdsc` reference's to-list contains the primary item (`findExifSourceItemId`,
`src/isobmff/admission.ts`). Orientation and resolution are read only from k -- this closes a real
Phase 61 defect where an Exif item on an auxiliary image or thumbnail could stamp its own
Orientation onto the primary (`admission.ts`'s pre-62-03 `found.orientation` fallback, which took
the first Exif item of _any_ item). When a requested preservation tag applies, the writer keeps k
declared **at its own item ID** (never allocating a new one): its `infe` is rebuilt from scratch
(`buildMinimalExifInfe`, `src/isobmff/rebuild.ts`) keeping the source's version and hidden flag but
forcing `item_protection_index` to 0 and `item_name` to empty; its `iloc` entry becomes one new
`construction_method 0` extent at the tail of `mdat` (never `idat` -- D3 declines a removable item
with `construction_method != 0`, so placing k's payload in `idat` would make the writer's own
output decline on re-clean). Exactly one `iref` record from k is rewritten: its **qualifying**
`cdsc` record -- the first, in `iref` order, whose to-list contains the primary (the one that made
it k, per `findExifSourceItemId` above) -- stays in its original slot with its to-list reduced to
`[pitm]`. k may legitimately carry other `iref` records too (another `cdsc` to a different item,
a `thmb`, and so on); every one of those survives **verbatim**, copied byte-for-byte, never
touched by the qualifying-record rewrite (code review 2026-10-02, CR-01: an earlier blanket
`fromItemId === k` rewrite squashed every record from k to `[pitm]`, silently destroying any
unrelated record's real target; admission's Rule 6, `removable-item-referenced`, guarantees every
`iref` to-target is always a surviving item, so a non-qualifying record from k never needs
removed-target handling). The payload is four zero bytes (`exif_tiff_header_offset = 0`, matching
the measured ExifTool 13.59 shape -- see "ExifTool 13.59 minimal-Exif placement" above) followed by
`createMinimalExif(computeIsobmffMinimalExifTags(...))`. Every other removable item loses its
`infe`, `iloc` entry, outgoing `iref` entries and `ipma` entry, exactly as D-14 describes.

Proven on both committed heif-enc fixtures at default settings, and on item-shape/placement
variants (`infe` version/hidden flag, `base_offset_size` 0 vs. 4, `cdsc` to-list reduction,
orientation-only/resolution-only requests, and the empty edges) by
`tests/isobmff_minimal_exif.test.ts`'s "D-13 minimal Exif writer (62-07)" and "D-13 source item k
(62-03)" describe blocks; the k-selection edge cases (ordering, thumbnail-only, emptied,
resolution scope) are proven in the same file's 62-03 describe block. The qualifying-record-only
rewrite (an unrelated second `iref` record from k survives untouched, and a tamper replaying the
pre-fix blanket-rewrite shape is caught by `verifyOutput`) is proven in
`tests/isobmff_writer.test.ts`'s "CR-01 code review fix pass (62-13)" describe block.

### D-14: order

`meta`'s children are emitted in the source's own order; `iinf`, `iloc`, `iref` and `iprp` are
rebuilt in their original slots with entries removed in place (never reordered to a canonical
layout); `hdlr`, `dinf`, `pitm`, `idat` and `grpl` are copied byte-verbatim; box versions are
preserved and entry counts are recomputed (they only shrink); `ftyp` is copied byte-verbatim.
Top-level boxes are never reordered, and `free`/`skip`/the C2PA `uuid` are dropped wherever they
sit -- right after `ftyp`, between `meta` and `mdat`, after `mdat`, or more than once in the same
file.

Proven on a non-default meta-child order (`iinf` before `iloc`, `iref` before `iprp`), verbatim
child bytes, an `iref` box with a dropped record interleaved among surviving ones, every top-level
position for `free`/`skip`/`uuid` (including two at once), an empty-edge source (nothing
removable) and an emptied-item source, by `tests/isobmff_writer.test.ts`'s "D-14 order, verbatim
children, empty iref, top-level positions, empty and emptied sources (62-06)" describe block (16
tests), plus hidden-auxiliary-item removal on both brands in the same file's "ISO-01/ISO-02
removal on builder fixtures (62-06)" describe blocks.

### D-15: `mdat`

The output keeps the source's own `mdat` header form: `largesize` iff the source used one, a
32-bit size iff the source used a normal 32-bit size, and a size-0 source becomes an explicit
32-bit size. The output payload is the union of every surviving `construction_method 0` extent's
byte range, merged in ascending source offset (`buildMergedMdatRanges`/`mapAbsoluteOffset`,
`src/isobmff/plan.ts`) -- touching or overlapping ranges merge into one, written exactly once --
followed by the minimal Exif payload (D-13), if any. Unclaimed source gaps (dead ranges under D3,
and possible hiding places for stale bytes) are dropped, never copied forward. A 32-bit size that
would overflow, or a 16-byte `largesize` header the source did not use, declines under
`offset-rewrite-overflow` (D-12) rather than ever being widened.

Proven by `tests/isobmff_writer.test.ts`'s "D-15 mdat union (62-05)" describe block (9 tests):
canary absence from unclaimed gaps, touching/overlapping-extent merge, removed-extent excision at
a shared boundary, out-of-order extents, and header-form preservation across `largesize`/normal/
size-zero sources.

### D-16: ICC and `ipma` remap

With `preserveColorProfile: false`, every `ipco` property whose type is `colr` and whose
`colour_type` is `prof` or `rICC` is removed -- not only the primary item's own ICC property, but
every such property in the box, regardless of which item associates with it. `ipco` is rebuilt by
concatenating each surviving property's own verbatim byte range in source order
(`rebuildIpco`, `src/isobmff/rebuild.ts`); this degenerates to an exact byte-identical copy when
nothing is removed, so `preserveColorProfile: true` needs no special-cased branch at all. `ipma`
is rebuilt with every association naming a removed property deleted, and every surviving
association's `propertyIndex` remapped `new = old - countRemovedBelow(old)` -- `ipma`'s own
version, flags, essential bits, and any entry that ends up with zero associations are left
untouched. `nclx` `colr` properties are always preserved regardless of the flag.

Proven end to end (full `ipco`/`ipma` rebuild with a primary and a hidden thumbnail both
associating with the removed property) by `tests/isobmff_icc.test.ts`'s "D-16 ICC removal and
ipma remap (62-08)" describe block, including `preserveColorProfile: true` identity, `ipma`
version-0/7-bit and version-1/15-bit (index above 127) width preservation, a zero-association
surviving entry, the highest-index-removed boundary, and the four generator `colr` arms.

### D-17: graph-integrity declines

`buildItemModel` (`src/isobmff/items.ts`) declines `item-graph-invalid` at parse time, strictly
before `classifyIsobmffModel` or any write ever runs, for: an `ipma` entry whose `item_ID` was
never declared in `iinf`; an `ipma` association whose property index is 0 or greater than the
`ipco` property count; a `grpl` entity_id that is not a declared item; any `meta` child type that
appears twice, or a second `ipco`/`ipma` inside `iprp` (closing a `.find()`-silently-uses-the-
first-match gap that ran through every one of these lookups); and a `dinf`/`dref` entry other
than a self-contained `url ` box (`flags & 1`, zero bytes after its own FullBox header) -- this
`dref` rule is inferred from the one real iPhone sample's own single, self-contained `dref` entry
(see "iPhone idat coverage and dref entries" above), not measured from a corpus.

Proven, each condition with its own hostile fixture and the full "declines once, zero writes"
pattern (admit, then decline before `writeOutput` ever runs), by `tests/isobmff_hostile.test.ts`'s
"D-17 graph-integrity declines (62-04)" describe block (22 tests); the real, sha-verified iPhone
sample and both committed heif-enc fixtures continue to admit unaffected.

### D-18: `verifyOutput` assertions

Before any sanitize call commits its result, `verifyIsobmffOutput` re-parses the destination with
`parseIsobmff` and runs `classifyIsobmffModel` -- the output must admit. It then recomputes every
expectation independently from the **source** admission and the request flags, never from the
plan's own output bytes (the same discipline the D-13/D-16 checks already establish), and asserts:
the top-level type list equals the source's minus `free`/`skip`/the C2PA `uuid`, with `ftyp` bytes
byte-identical; the surviving item set, `pitm`, and each surviving item's `infe` fields are equal;
`iloc`'s version and all four declared field widths equal the source's; `iref` equals the source's
minus removed entries, with k's to-list reduced to `[pitm]`; each surviving item's property
associations are resolved to `(property bytes, essential bit)` and compared as an **ordered
list**, never by raw index and never as a set; each surviving item's payload is byte-identical,
compared in `COPY_BLOCK_BYTES`-bounded streamed windows through each file's own `iloc`/`idat` --
never a whole-item buffer; there are 0 or 1 Exif items (and if 1, it is k, `construction_method 0`,
the expected payload, `cdsc -> [pitm]`); there are 0 `mime` items; the D-16 ICC rule holds (no
`prof`/`rICC` property anywhere in the output, with a whole-file byte scan for the removed
payload, **and** the whole surviving `ipco` payload -- source properties in order minus the
independently recomputed removed indices -- compared byte for byte against the destination, so a
property no `ipma` entry references at all (an orphan, D-34) is still checked, when
`preserveColorProfile` is false; the whole `ipco` box byte-identical when true);
the destination's own `mdat` payload length equals the union of its own surviving extents
(coverage, recomputed from the destination, never trusted from the plan); and `idat` is
byte-identical.

Proven on a preservation fixture (`irot`/`imir` essential, `clap`, a thumbnail, a gain-map item
and its auxiliary input, a depth auxiliary item, an Exif item removed) cross-checked against the
independent inventory walker, and shown red on 11 hand-tampered destinations -- one per assertion
plus the association-ordering edge -- by `tests/isobmff_verify.test.ts`'s "D-18 identity proof
(62-09)" describe block. The whole-`ipco`-payload recompute (an orphan property no `ipma` entry
references is corrupted by a plan mutant and caught) is proven by `tests/isobmff_writer.test.ts`'s
"WR-01 code review fix pass (62-13)" describe block.

### D-19: negative controls

Two test-only wrapper factories (`tests/isobmff-support/test-handler.ts`) prove the identity proof
has teeth, through the real engine end to end, never by editing `src/`:
`createFlipOneByteHandler` runs the real `writeOutput` and then flips one byte in a surviving
tile's extent, which `verifyIsobmffOutput` catches before publication; `createPlanMutantHandler`
corrupts the real, already-correct `IsobmffOutputPlan` with one of five named mutants -- the D-11
offset shift skipped, the D-16 `ipma` remap off by one, one D-15 removed range kept in `mdat`, the
D-11 field widths normalized to 8 bytes, and the D-13 minimal Exif item moved to
`construction_method 1`/`idat` -- each shown red, with an identity-mutant control proving the
wrappers are otherwise inert. The `construction_method 1` mutant is additionally shown to decline
on re-clean (`clean(clean(x))` cannot equal `clean(x)` for that defect), the ISO-06 idempotence
claim's negative mirror.

**ISO-06 idempotence evidence:** `clean(clean(x))` is byte-equal to `clean(x)` for both committed
heif-enc fixtures under three option sets, one builder fixture per named writer class (hidden
auxiliary metadata plus top-level C2PA, `free`/`skip`, ICC removal, the minimal Exif writer), and
a fixed-seed admitted sample from every one of the 13 non-hazard generator arms; and
`clean(exiftool(x))` is byte-equal to `clean(clean(exiftool(x)))` against a real ExifTool 13.59
run locally, under both measured argument forms (plain `-all=`; the app's preserving
`-all= -TagsFromFile @ -Orientation <RESOLUTION_PRESERVE_ARGS>` form), including the Exif item
identity/prefix check (same item ID, four-zero-byte payload prefix) when ExifTool's own output
carries a non-emptied Exif item.

Proven by `tests/isobmff_negative_controls.test.ts`'s "D-19 flip-one-byte (62-10)" and "D-19
writer mutants (62-10)" describe blocks, and by `tests/isobmff_idempotence.test.ts`'s "ISO-06
clean(clean(x)) (62-11)" and "ISO-06 clean(exiftool(x)) (62-11)" describe blocks.

### D-34: orphaned properties (deferred, recorded only)

`rebuildIpco`'s removal set (D-16) is scoped exactly to ICC `colr` `prof`/`rICC` properties; it
does not prune any other `ipco` property whose associations have all been removed by some other
rule. A property referenced only by a removed item -- for example a `udes` (user description)
property that only a stripped auxiliary item associated with -- therefore survives in `ipco` as
an **orphan**: still present in the box, byte-identical, with zero surviving associations. This is
a named residual, not an oversight: pruning orphaned properties is out of scope for this phase
(62-CONTEXT's Deferred Ideas), and no later plan in this phase reads or removes them. A future
requirement would need to define whether orphan pruning is itself safe (an orphan could in
principle be re-associated by a future edit tool reading the same file) before implementing it.

## Qualification baseline (Phase 62.1 measurements)

Measured 2026-10-02 on branch `gsd/phase-62.1-isobmff-registration` (62.1-01), against the built
`dist/isobmff/admission.js` (`admitIsobmff`) and `dist/isobmff/brand.js`
(`classifyIsobmffBrand`), fresh for this plan. No handler is registered yet (62.1-07); these are
classifier-only measurements over corpus bytes, not Save-as-copy results.

### Nokia heif_conformance admit rate

All 63 files in `nokiatech/heif_conformance` `conformance_files/` at pinned revision
`f17e517f7518984b4450349a88edc09519082c74` were downloaded to the session scratchpad only (never
committed; see the prohibition below) and run through `admitIsobmff`. **Measured admitted: 35 of
63** (no threshold is asserted; this is a measured count, recorded even though it differs by one
from the Phase 62.1 research estimate of 36 of 63 — re-measure, do not copy that number forward).

| Outcome / decline class     | Count |
| --------------------------- | ----- |
| admitted                    | 35    |
| `sequence-box`              | 12    |
| `item-graph-invalid`        | 10    |
| `multiple-mdat`             | 4     |
| `top-level-box-not-allowed` | 2     |

Total: 35 + 12 + 10 + 4 + 2 = 63.

### Curated Nokia subset

A 12-file subset, one per observed decline class plus admitted files of varied structure
(`C034` included per this plan's must-haves), totaling 716,170 bytes (~0.68 MB, under the ~3 MB
budget). This table records identity and expected outcome only -- **no bytes are vendored or
committed by this plan**; 62.1-08 is responsible for the actual download-only corpus manifest
records that cite this table.

| File                 | SHA-256                                                            | Bytes  | Expected outcome                     |
| -------------------- | ------------------------------------------------------------------ | ------ | ------------------------------------ |
| `C041.heic`          | `7a90757b22d3448267f44cc163e19611961e1228cd67a614b6ac8c4144bf082d` | 52191  | decline: `sequence-box`              |
| `C039.heic`          | `507e4fe241b73e098050ac12d6cefe84efbf2acf0d7f8b0b23f23480f6911658` | 112106 | decline: `item-graph-invalid`        |
| `C044.heic`          | `550443448520e724af11734f86d51e50a8e42e3f4b5ed47debc2c5d25fdb3190` | 146457 | decline: `top-level-box-not-allowed` |
| `multilayer005.heic` | `43cd906e0f04e12ceb007e683d637b68c72184f2118a69882e19f286c69f73d2` | 4608   | decline: `multiple-mdat`             |
| `C034.heic`          | `d2d61c040eba858cff05d7804c0999fb8955bcfe3ec99e5fd9f0b90d2dd2fe97` | 112147 | admitted                             |
| `C053.heic`          | `c641d26a9189371f9320827ba035eb05bc241975fdc9e6e60540f52de3feae97` | 14550  | admitted                             |
| `MIAF002.heic`       | `006baff837e3a8736154206f901a6595b0951eb62e282463e7dfc4a33c3da775` | 8837   | admitted                             |
| `MIAF003.heic`       | `499c8ef32ff744f42b06cc89d6404dcc3754043d2251f4b6f8fedf2f6f04a513` | 13826  | admitted                             |
| `multilayer003.heic` | `8e3963d7a0f997ad78be13809cccbe125482c5c961a30a0cb043b6aba0c870cb` | 14512  | admitted                             |
| `C025.heic`          | `8921aa6ccb29aa49a1122c602cdcbecb0a2dcdcae3cd1422631ac794bad72a69` | 19824  | admitted                             |
| `C017.heic`          | `7bd45ec3b278a601d4ba1905964856cf0003b15896adfffe3f645fd83c0417cd` | 60276  | admitted                             |
| `C040.heic`          | `7d9160ff8f2e0f195c870484dee255383f549243ec782d70c3cc9431bc5ec268` | 156836 | admitted                             |

All 12 are HEIC brand (`classifyIsobmffBrand` returns `"heic"` for each). None of these sha256
values match the iPhone sample's sha256
(`e760c80eed310e4f27c092d5487693ca8e104e7cc01d25ba4828deb28f679676`) -- confirmed disjoint by
inspection of the two sets.

### ExifTool 13.59 on signed and free/skip sources

Measured fresh with `perl exiftool -all= -o out.<ext> <fixture>` on both c2patool-signed
fixtures (`tests/corpus/constructed/{heic,avif}/c2pa-signed.heic|avif`) and on copies of
`tests/isobmff-support/fixtures/heif-enc-grid.{heic,avif}` each with a synthetic 16-byte
top-level `free` box (payload `0xAB` x8) and a synthetic 16-byte top-level `skip` box (payload
`0xCD` x8) appended after `mdat`, then walked with a scratch box walker and `exiftool -v2`.

**C2PA `uuid` box:** on both signed fixtures, ExifTool 13.59's `-all=` **drops the top-level C2PA
`uuid` box entirely** -- neither `signed-out.heic` nor `signed-out.avif` has any `uuid` box; the
output top-level order is `ftyp meta mdat` on both (down from `ftyp uuid meta mdat`). **This does
not trigger the plan's maintainer-decision gate** (D-15/D-27 would require a stop if ExifTool
_kept_ the uuid; it does not).

**`free`/`skip` boxes (grid fixtures):** ExifTool 13.59 **keeps** both boxes on both formats,
payload bytes unchanged (`ab` x8 / `cd` x8), but **relocates** them from after `mdat` (the input
position) to immediately **before** `mdat` (between `meta` and `mdat`) on every one of the four
runs (heic free, heic skip, avif free, avif skip). This matches, independently re-measured here,
the identical free/skip relocation finding already recorded above under "ExifTool and top-level
free/skip" (Phase 62 writer baseline) -- same relocation direction, same byte preservation, now
confirmed on a second fixture pair.

**Exif item extent / minimal Exif (signed fixtures, plain `-all=`):** on both signed fixtures,
plain `-all=` (no `-TagsFromFile`/preserving arguments) **empties the Exif item to 0 bytes** --
`exiftool -v2` shows `Item 2: ... len=0x0` and the tag dump (`-a -G1 -s`) on the output has no
`[IFD0]`/`[ExifIFD]` group at all. This is the plain-removal form, not the app's preserving form
(`-TagsFromFile @ -Orientation <RESOLUTION_PRESERVE_ARGS>`, already measured above under
"ExifTool 13.59 minimal-Exif placement" against the heif-enc-grid fixtures, where the preserving
form writes a minimal Exif reusing the source item ID). With plain `-all=` alone there is no
minimal Exif at all, so there is no `YCbCrPositioning` tag or any other Exif tag to check --
confirmed absent along with every other Exif tag.

### iPhone sample record

Downloaded `ianare/exif-samples` `heic/mobile/iphone_13_pro_max.HEIC` at pinned revision
`f0462fcc42f7bad484fe637389b734612d97041f` to the session scratchpad only (never committed).

| Property               | Value                                                              |
| ---------------------- | ------------------------------------------------------------------ |
| SHA-256                | `e760c80eed310e4f27c092d5487693ca8e104e7cc01d25ba4828deb28f679676` |
| Bytes                  | 2,182,707                                                          |
| `classifyIsobmffBrand` | `"heic"`                                                           |
| `admitIsobmff` outcome | admitted (0 top-level removable boxes; no C2PA uuid)               |

Matches the sha256 and byte size pinned in 61-CONTEXT D-01 exactly, re-confirming the file at
this revision is unchanged since Phase 61's measurement. License basis is recorded verbatim in
`tests/corpus/NOTICE` under `[ianare-exif-samples-iphone-13-pro-max]` per 61-CONTEXT D-02 (quote
the README.rst grant line; do not describe the repository as clean CC-BY-SA).

### Deviation: link-u license attribution (D-24 NOTICE)

This plan's must-haves assumed all three D-24 link-u files are CC-BY-SA-4.0. Fresh measurement
against the link-u repository's own `README.md` at the pinned revision
(`c666a368b73006246694919b5dbcc078317af6cc`) found this is **not** true for two of the three:

| File                                                       | Assumed license | Measured license (README.md, per-image credit)                                        |
| ---------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------- |
| `plum-blossom-small.profile0.8bpc.yuv420.alpha-full.avif`  | CC-BY-SA-4.0    | **CC-BY 4.0** (Ryo Hirafuji, @ledyba-z)                                               |
| `plum-blossom-small.profile0.10bpc.yuv420.alpha-full.avif` | CC-BY-SA-4.0    | **CC-BY 4.0** (Ryo Hirafuji, @ledyba-z)                                               |
| `red-at-12-oclock-with-color-profile-lossy.avif`           | CC-BY-SA-4.0    | **GNU LGPL v2.1 or 2-clause BSD** (Tony Payne), not a Creative Commons license at all |

The repository's root `LICENSE.txt` is CC-BY-SA-4.0, but the README explicitly states "Most
images are licensed under CC-BY-SA 4.0, but some files are licensed different license. Please
check" and credits these two specific images under different, per-image licenses. `tests/corpus/
NOTICE` has been written with the **measured, accurate** per-file licenses (not the plan's
assumed CC-BY-SA-4.0) to avoid committing false attribution -- a correctness/compliance
requirement this project treats as non-negotiable (no completion claim without fresh executable
evidence; no untraced causal/legal claims). **This plan's Task 2 verify command
`grep -c '^License: https://creativecommons.org/licenses/by-sa/4.0/$' tests/corpus/NOTICE` is
expected to return 0, not >= 3, as a direct consequence** -- the gate's assumption was wrong, not
the measurement. This is flagged for a maintainer/62.1-05 decision: either (a) add `CC-BY-4.0`
and an LGPL-2.1-or-BSD-2-Clause-equivalent class to `APPROVED_CORPUS_LICENSES` in
`tests/qualification/kit/corpus.ts` so these exact files can be vendored under their true
licenses in 62.1-08, or (b) select different link-u fixtures that are genuinely CC-BY-SA-4.0 for
the same structural role (alpha-plane and ICC-profile coverage). No manifest record is written in
this plan either way (prohibited by this plan's must-haves).
