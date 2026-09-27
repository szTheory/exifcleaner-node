import fc from "fast-check";
import { minimalJpeg } from "../../fixtures.js";
import {
  canaryArbitrary,
  type FormatGenerator,
  type GeneratedSample,
  type PlantedCanary,
} from "../kit/generators.js";
import { appSegment, spliceSegments } from "./fixtures.js";

// JPEG's qualification-kit property generator (57-05 tracer slice). Plants
// exactly one canary per drawn kind into a real, parseable `minimalJpeg()`.
// 57-11 widens `JpegMetadataKind` as later plans admit more JPEG metadata
// surfaces (APP1 Exif, APP2 ICC, APP11 C2PA, ...).

/** `COM`: a plain-text comment segment. `APP13`: a Photoshop 3.0 Image
 * Resources segment (content opaque to admission, D-01). `APP1-XMP`: a
 * standard XMP packet. */
export type JpegMetadataKind = "COM" | "APP13" | "APP1-XMP";

const ALL_METADATA_KINDS: readonly JpegMetadataKind[] = [
  "COM",
  "APP13",
  "APP1-XMP",
];

function segmentForKind(kind: JpegMetadataKind, canary: string): Buffer {
  switch (kind) {
    case "COM":
      return appSegment(0xfe, Buffer.from(canary, "ascii"));
    case "APP13":
      return appSegment(
        0xed,
        Buffer.concat([
          Buffer.from("Photoshop 3.0\0", "ascii"),
          Buffer.from(canary, "ascii"),
        ]),
      );
    case "APP1-XMP":
      return appSegment(
        0xe1,
        Buffer.concat([
          Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii"),
          Buffer.from(
            `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:format="image/jpeg"><dc:description>${canary}</dc:description></rdf:Description></rdf:RDF></x:xmpmeta>`,
            "utf8",
          ),
        ]),
      );
  }
}

export function jpegMetadataArbitrary(): fc.Arbitrary<
  GeneratedSample<JpegMetadataKind>
> {
  return fc
    .uniqueArray(fc.constantFrom(...ALL_METADATA_KINDS), {
      minLength: 1,
      maxLength: ALL_METADATA_KINDS.length,
    })
    .chain((kinds) =>
      fc.tuple(...kinds.map((kind) => canaryArbitrary<JpegMetadataKind>(kind))),
    )
    .map((planted: readonly PlantedCanary<JpegMetadataKind>[]) => {
      const segments = planted.map((item) =>
        segmentForKind(item.kind, item.canary),
      );
      const bytes = spliceSegments(minimalJpeg({ components: 3 }), segments);
      return { bytes, planted };
    });
}

export const jpegMetadataGenerator: FormatGenerator<JpegMetadataKind> =
  Object.freeze({
    format: "jpeg",
    metadataKinds: Object.freeze(ALL_METADATA_KINDS),
    arbitrary: (): fc.Arbitrary<GeneratedSample<JpegMetadataKind>> =>
      jpegMetadataArbitrary(),
  });
