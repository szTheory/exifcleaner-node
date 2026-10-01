# heif-enc fixture recipe (D-22)

Exactly two real-encoder image fixtures live here, both under 10,240 bytes, both produced by
`heif-enc -T` (tiled grid encoding) with a thumbnail (`-t`). Everything below is the literal
command transcript and the measured facts used to pin `tests/isobmff_inventory.test.ts`. No value
here is inferred -- every byte offset, item id, and content type was read back from the real
encoder output with `heif-info`, `exiftool -v2`, and a from-scratch inspector script (not
committed; see "Tooling" below).

## A4: tool versions (quoted, not assumed)

```
$ /opt/homebrew/bin/heif-enc --version
1.19.7
libheif: 1.19.7
plugin path: /opt/homebrew/Cellar/libheif/1.19.7/lib/libheif

$ /opt/homebrew/bin/heif-enc --list-encoders
AVC encoders:
AVIF encoders:
- aom = AOMedia Project AV1 Encoder 3.12.0 [default]
HEIC encoders:
- x265 = x265 HEVC encoder (4.1+1-1d117be) [default]
JPEG encoders:
JPEG 2000 encoders:
JPEG 2000 (HT) encoders:
Uncompressed encoders:
VVIC encoders:

$ perl exiftool_downloads/Image-ExifTool-13.59/exiftool -ver
13.59
```

These match the pinned versions recorded in 61-03-PLAN.md's `<context>` (libheif 1.19.7, x265 4.1,
aom 3.12.0). No version mismatch occurred; the plan's "stop on mismatch" gate was not triggered.

## Checkpoint note: the 128x128/512x512 oversized-tile SIGBUS is a generation bug, not a libheif defect

A previous attempt crashed `heif-enc -T` with SIGBUS inside `extend_to_size_with_zero`. Root cause
(confirmed by the orchestrator before this execution): the scratch tiles were **not** actually
64x64 -- a `sips` center-crop produced 128x128 (and 512x512 in a 256-tile variant) tiles instead.
An oversized tile crashes libheif's tiled encoder instead of producing a clean error. **Fix applied
here:** tiles are generated directly at the target pixel size (see "Tile generation" below) instead
of cropped from a larger source, and every tile's dimensions are asserted with
`sips -g pixelWidth -g pixelHeight` immediately before `heif-enc -T` runs. No cropping step exists
in this recipe at all -- each 64x64 tile is rendered independently from its own pixel-offset
gradient formula, which cannot produce an oversized tile by construction. The assertion step is
kept below as a guard for anyone regenerating these fixtures by hand.

## Tile generation

1. A dependency-free Node script (`node:zlib` `deflateSync`, hand-rolled PNG chunk/CRC32 writer)
   renders four independent 64x64 RGB gradient PNGs directly at tile resolution -- `tile-00-00.png`
   .. `tile-01-01.png` -- each pixel computed from its _global_ (tile-offset-adjusted) coordinate
   against a notional 128x128 full image, so the four tiles visually compose into one gradient
   without ever materializing (or cropping from) a 128x128 source bitmap.
2. Convert each PNG to JPEG: `sips -s format jpeg tile-XX-YY.png --out tile-XX-YY.jpg`.
3. **Guard (checkpoint fix):** assert every tile is exactly 64x64 before encoding:
   ```
   $ sips -g pixelWidth -g pixelHeight tile-00-00.jpg tile-00-01.jpg tile-01-00.jpg tile-01-01.jpg
   ... pixelWidth: 64 / pixelHeight: 64 (all four)
   ```
4. Write Exif + XMP metadata onto all four tiles with ExifTool 13.59, using `-n` on the write side
   (writing `-Orientation=1` **without** `-n` was measured to store raw value 3 ("Rotate 180")
   instead of 1 -- ExifTool's PrintConvInverse path on this build does not round-trip a bare
   numeric string for `Orientation` identically to `-n`'s raw-value path; `-n` is the recipe's
   fixed, verified way to get literal value 1 stored):
   ```
   $ perl exiftool -n -Make="ExifCleanerFixture" -Model="GridTile" -Orientation=1 \
       -XResolution=72 -YResolution=72 -XMP-dc:Title="ExifCleaner Fixture Tile" \
       -overwrite_original tile-00-00.jpg tile-00-01.jpg tile-01-00.jpg tile-01-01.jpg
   ```
5. Re-assert all four tiles are still 64x64 after the ExifTool write (ExifTool does not re-encode
   JPEG pixel data, but the guard is repeated anyway since this is the last step before encoding):
   confirmed 64x64 for all four.

`heif-enc -T` scans the tile's directory for the rest of the 2x2 grid from one filename, so only
`tile-00-00.jpg` is passed on the command line.

## HEIC fixture (x265)

```
$ /opt/homebrew/bin/heif-enc -T tiles/tile-00-00.jpg -t 32 -q 10 -o heif-enc-grid.heic
encoding tiled image, tile size: 64x64 image size: 128x128
encoding tile 1 1 (of 2x2)  encoding tile 1 2 (of 2x2)  encoding tile 2 1 (of 2x2)  encoding tile 2 2 (of 2x2)
```

- **Size:** 4243 bytes (< 10240).
- **SHA-256:** `ae40a80f0a85cd984b9d8b1a2e811e138ac2c8c26f14b77360d62e1e4867bad6`
- `heif-enc` copied the tiles' Exif/XMP onto the output automatically -- **no separate ExifTool
  metadata-injection step was needed** for either fixture (the plan's flagged fallback path was not
  exercised; this is recorded per the plan's "record which" instruction).

### heif-info

```
$ /opt/homebrew/bin/heif-info heif-enc-grid.heic
MIME type: image/heic
main brand: heic
compatible brands: mif1, heic, miaf

image: 128x128 (id=1), primary
  tiles: 2x2, tile size: 64x64
  colorspace: YCbCr, 4:2:0
  bit depth: 8
  thumbnail: 32x32
  color profile: nclx
  alpha channel: no
  depth channel: no
metadata:
  Exif: 178 bytes
  XMP: 2876 bytes
```

### Measured structural facts (heif-info + exiftool -v2 + from-scratch inspector)

| Item | Type   | hidden       | constructionMethod | base_offset | extent length | Notes                                                                            |
| ---- | ------ | ------------ | ------------------ | ----------- | ------------- | -------------------------------------------------------------------------------- |
| 1    | `grid` | no (primary) | 1                  | 0x0         | 0x8 (8)       | grid descriptor, lives in `idat`                                                 |
| 2    | `hvc1` | yes          | 0                  | 0x3d8       | 0x2b (43)     | tile (0,0)                                                                       |
| 3    | `hvc1` | yes          | 0                  | 0x403       | 0x2c (44)     | tile (0,1)                                                                       |
| 4    | `hvc1` | yes          | 0                  | 0x42f       | 0x2a (42)     | tile (1,0)                                                                       |
| 5    | `hvc1` | yes          | 0                  | 0x459       | 0x2a (42)     | tile (1,1)                                                                       |
| 6    | `Exif` | yes          | 0                  | 0x483       | 0xb2 (178)    | matches heif-info's "Exif: 178 bytes"                                            |
| 7    | `mime` | yes          | 0                  | 0x535       | 0xb3c (2876)  | matches heif-info's "XMP: 2876 bytes"; content_type `application/rdf+xml` (D-07) |
| 8    | `hvc1` | no           | 0                  | 0x1071      | 0x22 (34)     | 32x32 thumbnail, referenced by `thmb`                                            |

- `iloc`: version 1; offsetSize 4, lengthSize 4, **baseOffsetSize 4** (not 0 -- `heif-enc` uses the
  `base_offset` field rather than encoding full offsets in the per-extent `offset` field; every
  extent's own `offset` sub-field is `0x0`), indexSize 0.
- `idat`: payload offset 95, length 8 (the grid descriptor: `const_meth=1` item 1 reads this).
- `meta` children, in order: `hdlr pitm idat iloc iinf iprp iref`.
- `ipco` properties (1-indexed): `1:ispe 2:hvcC 3:colr 4:ispe 5:pixi 6:hvcC 7:clap`.
- `ipma`: item 1 -> [1, 5]; items 2-5 -> [2, 3, 4, 5]; item 8 -> [6, 3, 4, 5, 7].
- `iref`: `dimg` 1->{2,3,4,5} (grid references its four tiles), `cdsc` 6->1 (Exif describes
  primary), `cdsc` 7->1 (XMP describes primary), `thmb` 8->1 (item 8 is primary's thumbnail).
- Top-level boxes: `ftyp`(28) `meta`(948) `mdat`(3267, payload offset 984, payload length 3259).
- XMP mime content_type: `application/rdf+xml` (measured; `application/xmp+xml` is not emitted by
  this encoder and is correctly not assumed anywhere in the classifier per D-07).

### ExifTool 13.59 tag baseline (HEIC fixture)

```
$ perl exiftool -a -G1 -s heif-enc-grid.heic
...
[IFD0]          Make                            : ExifCleanerFixture
[IFD0]          Model                           : GridTile
[IFD0]          Orientation                     : Horizontal (normal)
[IFD0]          XResolution                     : 72
[IFD0]          YResolution                     : 72
[ExifIFD]       ColorSpace                      : sRGB
[ExifIFD]       ExifImageWidth                  : 64
[ExifIFD]       ExifImageHeight                 : 64
[XMP-x]         XMPToolkit                      : Image::ExifTool 13.59
[XMP-dc]        Title                           : ExifCleaner Fixture Tile
```

(Orientation reads "Horizontal (normal)" -- i.e. raw value 1 -- confirming the `-n`-write fix in
step 4 above took effect; the Exif/ExifImageWidth/Height values of 64 are the _tile's_ embedded
Exif, since `heif-enc` propagated the first tile's Exif/XMP onto the composite output rather than
re-deriving a primary-image-sized Exif block. This is recorded as a measured fact, not corrected,
since nothing in this plan's must_haves requires `ExifImageWidth`/`Height` to match the primary's
128x128 size.)

## AVIF fixture (aom)

```
$ /opt/homebrew/bin/heif-enc -A -T tiles/tile-00-00.jpg -t 32 -q 10 -o heif-enc-grid.avif
encoding tiled image, tile size: 64x64 image size: 128x128
encoding tile 1 1 (of 2x2)  encoding tile 1 2 (of 2x2)  encoding tile 2 1 (of 2x2)  encoding tile 2 2 (of 2x2)
```

- **Size:** 3997 bytes (< 10240).
- **SHA-256:** `682a1e626c4d8db4f7ccf4a2d5058d0104394f7a08d0a70fad3950bed4b0a85e`

### heif-info

```
$ /opt/homebrew/bin/heif-info heif-enc-grid.avif
MIME type: image/avif
main brand: avif
compatible brands: avif, mif1, miaf

image: 128x128 (id=1), primary
  tiles: 2x2, tile size: 64x64
  colorspace: YCbCr, 4:2:0
  bit depth: 8
  thumbnail: 32x32
  color profile: nclx
  alpha channel: no
  depth channel: no
metadata:
  Exif: 178 bytes
  XMP: 2876 bytes
```

### Measured structural facts

| Item | Type   | hidden       | constructionMethod | base_offset | extent length | Notes                              |
| ---- | ------ | ------------ | ------------------ | ----------- | ------------- | ---------------------------------- |
| 1    | `grid` | no (primary) | 1                  | 0x0         | 0x8 (8)       | grid descriptor, in `idat`         |
| 2    | `av01` | yes          | 0                  | 0x2e7       | 0x2b (43)     | tile (0,0)                         |
| 3    | `av01` | yes          | 0                  | 0x312       | 0x2b (43)     | tile (0,1)                         |
| 4    | `av01` | yes          | 0                  | 0x33d       | 0x2a (42)     | tile (1,0)                         |
| 5    | `av01` | yes          | 0                  | 0x367       | 0x29 (41)     | tile (1,1)                         |
| 6    | `Exif` | yes          | 0                  | 0x390       | 0xb2 (178)    |                                    |
| 7    | `mime` | yes          | 0                  | 0x442       | 0xb3c (2876)  | content_type `application/rdf+xml` |
| 8    | `av01` | no           | 0                  | 0xf7e       | 0x1f (31)     | 32x32 thumbnail, `thmb` target     |

- `iloc`: version 1; offsetSize 4, lengthSize 4, baseOffsetSize 4, indexSize 0 (same shape as the
  HEIC fixture).
- `idat`: payload offset 95, length 8.
- `meta` children, in order: `hdlr pitm idat iloc iinf iprp iref` (identical order to the HEIC
  fixture).
- `ipco` properties (1-indexed): `1:ispe 2:av1C 3:colr 4:ispe 5:pixi 6:ispe` (an `av01` tile type
  is present per the plan's acceptance criteria).
- `iref`: `dimg` 1->{2,3,4,5}, `cdsc` 6->1, `cdsc` 7->1, `thmb` 8->1.
- Top-level boxes: `ftyp`(28) `meta`(707) `mdat`(3262, payload offset 743, payload length 3254).

### ExifTool 13.59 AVIF baseline

```
$ perl exiftool -a -G1 -s heif-enc-grid.avif
...
[IFD0]          Make                            : ExifCleanerFixture
[IFD0]          Model                           : GridTile
[IFD0]          Orientation                     : Horizontal (normal)
[IFD0]          XResolution                     : 72
[IFD0]          YResolution                     : 72
[ExifIFD]       ColorSpace                      : sRGB
[ExifIFD]       ExifImageWidth                  : 64
[ExifIFD]       ExifImageHeight                 : 64
[XMP-x]         XMPToolkit                      : Image::ExifTool 13.59
[XMP-dc]        Title                           : ExifCleaner Fixture Tile
```

Same tag set and values as the HEIC fixture (both encoded from the same tiles).

## `exiftool -all=` structural effect (both fixtures)

Measured by running `exiftool -all= -o <scratch>/out.<ext> <fixture>` and walking the output with
the same inspector used above.

### HEIC `-all=`

- Output size: 1189 bytes (from 4243).
- `iloc` after `-all=`: items 1-5 **unchanged** (same base_offset/length as before). Item 6 (Exif):
  `base_offset 0x483, length 0x0` (**emptied in place**, same base_offset it had before `-all=`).
  Item 7 (mime/XMP): `base_offset 0x483, length 0x0` (**also emptied**, to the _same_ base_offset
  as item 6 -- both collapse to a zero-length extent at the point in `mdat` where the removed bytes
  used to start). Item 8 (thumbnail): `base_offset 0x483, length 0x22` -- **shifted left** from its
  original `0x1071` to close the 3054-byte gap (178 Exif + 2876 XMP) that `-all=` removed from
  `mdat`.
- `mdat` payload shrank from 3259 to 205 bytes (3259 - 178 - 2876 = 205, exactly consistent with
  complete removal, not a size-preserving zero-fill).
- **This is a second, independently measured shape for the D-10a empty-extent rule**, distinct from
  61-01's iPhone measurement: there, the emptied Exif extent stayed in place at its original offset
  while `mdat` shrank around it with no other item moved. Here, `heif-enc`+ExifTool's combination
  _also_ shrinks `mdat`, but additionally shifts a later surviving item (the thumbnail) left to
  close the gap. Both are "in-bounds offset, emptied extent" per D-10a -- the emptied extent's
  `base_offset` (0x483 = 1155) sits within the new, smaller `mdat` payload (file offsets
  [984, 1189)) in both files measured so far. Neither measured file produces the ISO/IEC 14496-12
  "to end of resource" shape; D-10a's citation stands.

### AVIF `-all=`

- Output size: 943 bytes (from 3997).
- Same shape as the HEIC case: items 1-5 unchanged; item 6 (Exif) and item 7 (XMP) both emptied to
  `base_offset 0x390, length 0x0`; item 8 (thumbnail) shifted from `0xf7e` to `0x390`.
- `mdat` payload shrank from 3254 to 200 bytes (3254 - 178 - 2876 = 200).

## Tooling

- `heif-enc`/`heif-info`: `/opt/homebrew/bin/heif-enc`, `/opt/homebrew/bin/heif-info` (Homebrew
  libheif 1.19.7).
- `exiftool`: `perl /Users/jon/projects/exifcleaner/exifcleaner-electron/exiftool_downloads/Image-ExifTool-13.59/exiftool`
  (ExifTool 13.59).
- `sips`: macOS system tool, used only for PNG->JPEG re-encoding (never for cropping -- see the
  checkpoint note above).
- The PNG tile generator and the from-scratch box/item inspector used to produce every number above
  are plain Node scripts kept in scratch, not committed to this repository (they are not test
  support code; `tests/isobmff-support/inventory.ts` is the committed, maintained oracle that reads
  these same fixtures at test time).
