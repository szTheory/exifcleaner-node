import { defineIsobmffParserSuite } from "../../isobmff-support/qualification-suites.js";
import { avifMetadataGenerator } from "./generators.js";
import { AVIF_EXTENSION } from "./oracles.js";

// QUA-02 / D-28 (62.1-10): every AVIF corpus and generator source and output type, classified
// against the closed lists in docs/isobmff.md. No AVIF record has a pinned default-settings
// refusal (62.1-09).
defineIsobmffParserSuite({
  format: "avif",
  extension: AVIF_EXTENSION,
  generator: avifMetadataGenerator,
  defaultSettingsRefusals: {},
});
