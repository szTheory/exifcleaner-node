import { heicHandler } from "../../../src/admission/heic-handler.js";
import { defineIsobmffTransactionSuite } from "../../isobmff-support/transaction-suite.js";

// QUA-04 / D-26 (62.1-11): every logical transaction fault injected through the REGISTERED HEIC
// handler with the kit's unchanged `applyFaultPlan`, on the provenanced heif-enc grid record.
defineIsobmffTransactionSuite("heic", heicHandler, ["heif-enc-grid-heic"]);
