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

`src/isobmff/errors.ts` defines the closed internal union `IsobmffDeclineClass` (24 members) and
`DECLINE_CLASS_TO_KIND`, a `satisfies Record<IsobmffDeclineClass, ...>` table mapping each class to
one of the three public `MetadataErrorDetails["code"]` values this engine can report
(`unsupported-format` | `unsafe-structure` | `malformed-file`, D-11/D-12). A new class added
without a kind mapping fails typecheck.

Three classes close structural gaps D-12's own mapping table does not name
(`meta-handler-not-pict`, `unsupported-box-version`, `item-graph-invalid`) -- planner discretion
recorded in 61-CONTEXT.md's "Flagged assumptions"; they add no public type.

Every class is now wired: the framing/top-level/cap classes by `src/isobmff/boxes.ts`/`parse.ts`
(61-04), and the remaining D3/D5 item-level classes by `src/isobmff/items.ts` (61-07, item-graph
validity) and `src/isobmff/admission.ts` (61-08, the D3/D5 removable/surviving rules;
`DECLINE_RULE_ORDER`).

| Class                          | Public code          | Rule source                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `removable-item-in-idat`       | `unsupported-format` | D3: a removable item whose extent lives in `idat` (construction_method 1) is not admitted -- only a _surviving_ grid/`idat` shape is (D-09/D3).                                                                                                                                                                                                                       |
| `construction-method-2`        | `unsupported-format` | D3: any item with `construction_method == 2` (data-reference-indexed) is not admitted.                                                                                                                                                                                                                                                                                |
| `external-data-reference`      | `unsupported-format` | D3: an item with `data_reference_index != 0` (an external file reference) is not admitted.                                                                                                                                                                                                                                                                            |
| `multiple-mdat`                | `unsupported-format` | D3/D5: more than one top-level `mdat` is not admitted. Triggered in `parse.ts` on a second `mdat`.                                                                                                                                                                                                                                                                    |
| `unknown-item-type`            | `unsupported-format` | D3: an item type outside the closed admitted set (D-07's XMP `mime` rule, etc.) is not admitted.                                                                                                                                                                                                                                                                      |
| `sequence-box`                 | `unsupported-format` | D3/D5: a top-level `moov` box indicates a sequence/fragmented file. Triggered in `parse.ts`.                                                                                                                                                                                                                                                                          |
| `sequence-brand`               | `unsupported-format` | D-06/D-18: the `msf1`/`avis` sequence brands are never admitted (brand classification, 61-05+).                                                                                                                                                                                                                                                                       |
| `unknown-meta-child`           | `unsupported-format` | D5: a `meta` child box outside the closed set this engine understands.                                                                                                                                                                                                                                                                                                |
| `top-level-box-not-allowed`    | `unsupported-format` | D5: any top-level box outside `{ftyp, meta, mdat, free, skip}` and the C2PA `uuid`. Triggered in `parse.ts`.                                                                                                                                                                                                                                                          |
| `meta-handler-not-pict`        | `unsupported-format` | Planner-added closure: `meta`'s `hdlr` box must declare handler_type `pict`.                                                                                                                                                                                                                                                                                          |
| `unsupported-box-version`      | `unsupported-format` | Planner-added closure: an `iloc` version > 2, `ipma` version > 1, `infe` version < 2, or `iref`/`pitm` version > 1.                                                                                                                                                                                                                                                   |
| `removable-extent-overlap`     | `unsafe-structure`   | D5: a removable item's extent overlaps a surviving item's extent.                                                                                                                                                                                                                                                                                                     |
| `removable-item-referenced`    | `unsafe-structure`   | D5: a removable item is an `iref` to-target, `pitm`, or `grpl` member (D-08's `cdsc`-from exception does not apply to to-targets).                                                                                                                                                                                                                                    |
| `surviving-zero-length-extent` | `unsafe-structure`   | D-10a: a zero-length extent on a _surviving_ item (the D-10a empty-extent rule only admits this shape for removable items).                                                                                                                                                                                                                                           |
| `surviving-offset-width-zero`  | `unsafe-structure`   | D5: a surviving (construction_method 0) item whose `iloc` offset field width is 0.                                                                                                                                                                                                                                                                                    |
| `cap-meta-bytes`               | `unsafe-structure`   | BMF-05 (PNG D-25 precedent): the declared `meta` payload size exceeds `IsobmffCaps.maxMetaBytes`. Triggered in `IsobmffBudget.checkMetaSize`, checked before the `meta` payload is read.                                                                                                                                                                              |
| `cap-box-count`                | `unsafe-structure`   | BMF-05: the running box count exceeds `IsobmffCaps.maxBoxCount`. Triggered in `IsobmffBudget.countBox`, checked before each box is recorded.                                                                                                                                                                                                                          |
| `cap-box-depth`                | `unsafe-structure`   | BMF-05: a container descent's depth exceeds `IsobmffCaps.maxBoxDepth`. Triggered in `IsobmffBudget.checkDepth`, checked before descending.                                                                                                                                                                                                                            |
| `cap-buffered-bytes`           | `unsafe-structure`   | BMF-05: the aggregate bytes buffered from outside `meta` (Exif/XMP item payload reads) exceeds `IsobmffCaps.maxBufferedBytesTotal`. Triggered in `admitIsobmff` (61-08): `IsobmffBudget.consumeBuffered(extent.length)` runs immediately before each extent's `readExactly` call.                                                                                     |
| `extent-outside-mdat`          | `malformed-file`     | D-10a: an extent's offset is outside the single `mdat` payload (or, for a removable item's emptied extent, outside the file).                                                                                                                                                                                                                                         |
| `meta-not-fullbox`             | `malformed-file`     | D-11: `meta` is not a version-0 `FullBox` -- a QuickTime-style `meta` (no version/flags) or an unsupported `meta` version. Triggered in `parse.ts` via the first-4-payload-bytes-nonzero check.                                                                                                                                                                       |
| `duplicate-meta`               | `malformed-file`     | D5: a second top-level `meta` box. Triggered in `parse.ts`.                                                                                                                                                                                                                                                                                                           |
| `box-framing`                  | `malformed-file`     | ISO/IEC 14496-12 S4.2: a short read, a declared size of 2..7, a `size==1` largesize below 16 bytes or above `Number.MAX_SAFE_INTEGER`, a box extending past its parent or the file, a `size==0` box that is not the top-level `mdat`, a `size==0` box inside any container, or a first top-level box that is not `ftyp`. Triggered throughout `src/isobmff/boxes.ts`. |
| `item-graph-invalid`           | `malformed-file`     | Planner-added closure: a missing or duplicate required item table (`iloc`/`iinf`/`pitm`), a dangling `iref`/`pitm`/`grpl` item reference, or another item-graph inconsistency (61-07).                                                                                                                                                                                |

## Memory caps

Filled in by a later Phase 61 plan.

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
