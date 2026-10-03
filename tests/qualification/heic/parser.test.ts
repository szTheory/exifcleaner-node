import { defineIsobmffParserSuite } from "../../isobmff-support/qualification-suites.js";
import { heicMetadataGenerator } from "./generators.js";
import { HEIC_DEFAULT_SETTINGS_REFUSALS, HEIC_EXTENSION } from "./oracles.js";

// QUA-02 / D-28 (62.1-10): every HEIC corpus and generator source and output type, classified
// against the closed lists in docs/isobmff.md.
defineIsobmffParserSuite({
  format: "heic",
  extension: HEIC_EXTENSION,
  generator: heicMetadataGenerator,
  defaultSettingsRefusals: HEIC_DEFAULT_SETTINGS_REFUSALS,
});
