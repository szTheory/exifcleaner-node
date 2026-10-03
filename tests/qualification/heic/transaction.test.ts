import { heicHandler } from "../../../src/admission/heic-handler.js";
import { defineIsobmffTransactionSuite } from "../../isobmff-support/transaction-suite.js";

// QUA-04 / D-26 (62.1-11): every logical transaction fault injected through the REGISTERED HEIC
// handler with the kit's unchanged `applyFaultPlan`, on the provenanced heif-enc grid record and
// (when the download cache is configured; required under CI) the iPhone 13 Pro Max sample, plus
// a mid-copy stage-write on a generated large-mdat fixture and a real verification failure.
defineIsobmffTransactionSuite("heic", heicHandler, [
  "heif-enc-grid-heic",
  "ianare-exif-samples-iphone-13-pro-max",
]);
