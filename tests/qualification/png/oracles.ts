import { inflateSync } from "node:zlib";
import { digest, type DifferentialProfile } from "../kit/oracles.js";

export const PNG_EXTENSION = ".png";

/**
 * Walks a PNG chunk stream and returns the sha256 of the first `iCCP` chunk's
 * *decompressed* profile, or undefined when no `iCCP` chunk is present.
 * ExifTool re-deflates the profile it copies back, so a byte comparison of
 * the compressed chunk would fail even when the underlying profile is
 * unchanged -- matching webpRawColorProfileSha256's own rationale.
 */
export function pngRawColorProfileSha256(input: Buffer): string | undefined {
  let offset = 8; // past the 8-byte PNG signature
  while (offset + 8 <= input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.toString("ascii", offset + 4, offset + 8);
    const dataOffset = offset + 8;
    if (dataOffset + length + 4 > input.length) return undefined;
    if (type === "iCCP") {
      const data = input.subarray(dataOffset, dataOffset + length);
      const nul = data.indexOf(0);
      if (nul < 0 || nul + 1 >= data.length) return undefined;
      const compressed = data.subarray(nul + 2);
      try {
        return digest(inflateSync(compressed));
      } catch {
        return undefined;
      }
    }
    offset = dataOffset + length + 4;
    if (type === "IEND") break;
  }
  return undefined;
}

/**
 * The 56-03 tracer's differential profile. `permittedKinds` stays empty --
 * PNG admits no permitted differences yet; Plans 07/09 measure and add the
 * orientation/resolution/color-profile kinds once the handler implements
 * them (D-11, D-02, D-08).
 */
export const pngDifferentialProfile: DifferentialProfile = {
  format: "png",
  extension: PNG_EXTENSION,
  rawColorProfileSha256: pngRawColorProfileSha256,
  permittedKinds: [],
};
