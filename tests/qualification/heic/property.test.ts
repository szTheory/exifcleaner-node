import { defineIsobmffPropertySuite } from "../../isobmff-support/qualification-suites.js";
import { HEIC_EXTENSION } from "./oracles.js";

// QUA-03 / D-28 (62.1-10): HEIC generator samples through the registered handler, the per-brand
// arm floors at seed 460046, and the pure-copy drill.
defineIsobmffPropertySuite({ format: "heic", extension: HEIC_EXTENSION });
