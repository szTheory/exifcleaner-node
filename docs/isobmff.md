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

Filled in by a later Phase 61 plan.

## Fixtures

Filled in by a later Phase 61 plan.

## Decline classes

Filled in by a later Phase 61 plan.

## Memory caps

Filled in by a later Phase 61 plan.
