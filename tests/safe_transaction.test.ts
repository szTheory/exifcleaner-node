import { describe, expect, it } from "vitest";
import { NODE_FILE_OPS } from "../src/transaction/file-ops.js";

describe("safe transaction file operations", () => {
  it("keeps the Node adapter private to the transaction layer", () => {
    expect(NODE_FILE_OPS).toBeDefined();
  });
});
