# ISOBMFF corpus fixture recipe (Phase 62.1, D-24)

Two c2patool-signed fixtures, produced once at dev time and committed. c2patool itself is never
installed by any script CI runs; it is a pinned GitHub release asset downloaded into the session
scratchpad for this one signing session and never committed. Everything below is the literal
command transcript and measured facts, following the format of
`tests/isobmff-support/fixtures/RECIPE.md`.

## Tool versions (quoted, not assumed)

```
$ /opt/homebrew/bin/heif-enc --version
1.19.7
libheif: 1.19.7

$ perl exiftool_downloads/Image-ExifTool-13.59/exiftool -ver
13.59

$ c2patool --version
c2patool 0.27.22
```

## c2patool release asset (D-24, T-62.1-02)

- **Release:** `contentauth/c2pa-rs` tag `c2patool-v0.27.22`, asset
  `c2patool-v0.27.22-universal-apple-darwin.zip`.
- **Asset SHA-256:** `d064ca72e599c74e5fdc2ed04b47d6cb62210a2b14db589d078c2ec27c98d3df`
- Downloaded with `gh release download c2patool-v0.27.22 --repo contentauth/c2pa-rs --pattern
  "c2patool-v0.27.22-universal-apple-darwin.zip"` into the session scratchpad only. The binary and
  zip are never committed to this repository and no package.json/CI step references them.
- Signing used the release's own bundled sample test certificate and private key
  (`sample/es256_certs.pem`, `sample/es256_private.key`) — the default development
  signing identity c2patool documents; `c2patool --version` prints `c2patool 0.27.22`
  before use, confirming the pinned version.

## Input image (shared base for both fixtures)

1. A dependency-free Node script (`node:zlib` `deflateSync`, hand-rolled PNG chunk/CRC32 writer)
   renders one 64x64 RGB gradient PNG (`base.png`), each pixel computed directly from its (x, y)
   coordinate — no cropping step.
2. Convert to JPEG: `sips -s format jpeg base.png --out base.jpg`. Confirmed 64x64 with
   `sips -g pixelWidth -g pixelHeight base.jpg`.
3. Write Exif (Orientation=1, Artist) and an XMP packet (XMP-dc:Title) with ExifTool 13.59, using
   `-n` for the Orientation write (same fixed, verified pattern as
   `tests/isobmff-support/fixtures/RECIPE.md`):
   ```
   $ perl exiftool -n -Orientation=1 -Artist="ExifCleaner Test" \
       -XMP-dc:Title="C2PA Signed Fixture" -overwrite_original base.jpg
   ```

## HEIC fixture (plain heif-enc, no `-T`, no thumbnail)

```
$ /opt/homebrew/bin/heif-enc base.jpg -t 0 -q 50 -o plain.heic
```

- `heif-info plain.heic` confirms a single primary item (64x64, id=1), `metadata: Exif: 114 bytes,
  XMP: 2871 bytes` — carries exactly one Exif item and one XMP item, no grid/tiling, no thumbnail.
- Top-level boxes of `plain.heic` (scratch walker): `ftyp`(28) `meta`(478) `mdat`(3102).

### Signing (c2patool, built-in test certificate)

Manifest (`manifest.json`, minimal, claim generator `exifcleaner-node-test`):

```json
{
  "claim_generator_info": [{ "name": "exifcleaner-node-test", "version": "0.0.0" }],
  "title": "exifcleaner-node test fixture",
  "assertions": [{ "label": "c2pa.actions", "data": { "actions": [{ "action": "c2pa.created" }] } }]
}
```

```
$ c2patool plain.heic -m manifest.json -o signed.heic --force
```

c2patool used its bundled default development certificate (`es256_certs.pem`/`es256_private.key`
from its own `sample/` directory — no certificate files were passed explicitly, c2patool selected
its built-in default and printed "Using default private key and signing certificate. This is only
valid for development."). Signing succeeded; `validation_state` is `Invalid` only because the test
certificate is untrusted and the `c2pa.created` action lacks a `digitalSourceType` (both expected
for a throwaway dev-signed fixture, not a fixture-generation defect) — `claimSignature.validated`
and `assertion.bmffHash.match` both report success.

- **Output:** `tests/corpus/constructed/heic/c2pa-signed.heic`
- **Size:** 17120 bytes
- **SHA-256:** `2e5868a05c42f45d3696a6dda33c4050a1ddffc717eab503d89ee57feb127ffd`

### Top-level box walk (signed.heic)

| Box    | Offset | Length | Notes                                                         |
| ------ | ------ | ------ | -------------------------------------------------------------- |
| `ftyp` | 0      | 28     |                                                                  |
| `uuid` | 28     | 13512  | C2PA uuid extension `d8fec3d6-1b0e-483c-9297-5828877ec481` — placed right after `ftyp` (c2pa-rs convention) |
| `meta` | 13540  | 478    | unchanged from `plain.heic`                                     |
| `mdat` | 14018  | 3102   | unchanged from `plain.heic`                                     |

### `admitIsobmff` result (dist/isobmff/admission.js, D-24/ISO-02 basis)

Measured with a scratch Node script importing the built `dist/isobmff/admission.js` and calling
`admitIsobmff(handle, size)` directly on `signed.heic`:

```json
{
  "removableTopLevel": [{ "offset": 28, "length": 13512 }],
  "removableItemIds": [2, 3],
  "survivingItemIds": [1],
  "emptiedItemIds": []
}
```

Admitted (no decline thrown). The top-level C2PA `uuid` box is detected and measured at offset 28,
length 13512 — immediately after `ftyp`, matching the box walk above. Items 2 and 3 (Exif and XMP)
are classified removable; item 1 (the primary image) survives.

## Tooling

- `heif-enc`/`heif-info`: `/opt/homebrew/bin/heif-enc`, `/opt/homebrew/bin/heif-info` (Homebrew
  libheif 1.19.7).
- `exiftool`: `perl /Users/jon/projects/exifcleaner/exifcleaner-electron/exiftool_downloads/Image-ExifTool-13.59/exiftool`
  (ExifTool 13.59).
- `c2patool`: release binary, downloaded once into the session scratchpad (see above), never
  committed.
- `sips`: macOS system tool, used only for PNG->JPEG re-encoding.
- The PNG generator and the top-level box walker/`admitIsobmff` runner used above are plain Node
  scripts kept in scratch, not committed to this repository.

<!-- AVIF fixture appended in 62.1-01 Task 2 -->

