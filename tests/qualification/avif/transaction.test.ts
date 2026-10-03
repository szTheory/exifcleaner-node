import { avifHandler } from "../../../src/admission/avif-handler.js";
import { defineIsobmffTransactionSuite } from "../../isobmff-support/transaction-suite.js";

// QUA-04 / D-26 (62.1-11): every logical transaction fault injected through the REGISTERED AVIF
// handler with the kit's unchanged `applyFaultPlan`, on the provenanced heif-enc grid record, plus
// a mid-copy stage-write on a generated large-mdat fixture and a real verification failure.
defineIsobmffTransactionSuite("avif", avifHandler, ["heif-enc-grid-avif"]);
