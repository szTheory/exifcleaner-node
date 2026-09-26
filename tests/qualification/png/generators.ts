import { deflateSync } from "node:zlib";
import fc from "fast-check";
import { png, pngChrm, pngChunk, pngIdat, pngIhdr } from "../../fixtures.js";
import {
  canaryArbitrary,
  type FormatGenerator,
  type GeneratedSample,
} from "../kit/generators.js";

/** Plan 10 widens this. */
export type PngMetadataKind = "tEXt" | "zTXt" | "iTXt";

function textChunkData(keyword: string, text: string): Buffer {
  return Buffer.from(`${keyword}\0${text}`, "latin1");
}

function ztxtChunkData(keyword: string, text: string): Buffer {
  return Buffer.concat([
    Buffer.from(`${keyword}\0`, "latin1"),
    Buffer.from([0]), // compression method 0 (zlib, the only defined method)
    deflateSync(Buffer.from(text, "latin1")),
  ]);
}

function itxtChunkData(keyword: string, text: string): Buffer {
  return Buffer.concat([
    Buffer.from(`${keyword}\0`, "latin1"),
    Buffer.from([0, 0]), // compression flag 0 (uncompressed), compression method 0
    Buffer.from([0]), // empty language tag, null-terminated
    Buffer.from([0]), // empty translated keyword, null-terminated
    Buffer.from(text, "utf8"),
  ]);
}

function chunkDataForKind(kind: PngMetadataKind, canary: string): Buffer {
  if (kind === "tEXt") return textChunkData("Comment", canary);
  if (kind === "zTXt") return ztxtChunkData("Comment", canary);
  return itxtChunkData("Comment", canary);
}

/**
 * Plants one canary per PNG text kind into a base of IHDR, cHRM, IDAT and
 * IEND (D-19a/D-20 shape, mirrored from webpMetadataArbitrary). Plan 10
 * widens the kind set and the base fixture.
 */
export function pngMetadataArbitrary(): fc.Arbitrary<
  GeneratedSample<PngMetadataKind>
> {
  return fc
    .constantFrom<PngMetadataKind>("tEXt", "zTXt", "iTXt")
    .chain((kind) => canaryArbitrary<PngMetadataKind>(kind))
    .map((canary): GeneratedSample<PngMetadataKind> => {
      const bytes = png([
        pngChunk("IHDR", pngIhdr()),
        pngChunk("cHRM", pngChrm()),
        pngChunk(canary.kind, chunkDataForKind(canary.kind, canary.canary)),
        pngChunk("IDAT", pngIdat()),
        pngChunk("IEND", Buffer.alloc(0)),
      ]);
      return { bytes, planted: [canary] };
    });
}

export const pngMetadataGenerator: FormatGenerator<PngMetadataKind> =
  Object.freeze({
    format: "png",
    metadataKinds: Object.freeze(["tEXt", "zTXt", "iTXt"] as const),
    arbitrary: pngMetadataArbitrary,
  });
