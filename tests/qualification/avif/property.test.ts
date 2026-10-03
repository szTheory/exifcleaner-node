import { defineIsobmffPropertySuite } from "../../isobmff-support/qualification-suites.js";
import { AVIF_EXTENSION } from "./oracles.js";

// QUA-03 / D-28 (62.1-10): AVIF generator samples through the registered handler, the per-brand
// arm floors at seed 460046, and the pure-copy drill.
defineIsobmffPropertySuite({ format: "avif", extension: AVIF_EXTENSION });
