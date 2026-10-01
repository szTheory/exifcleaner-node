import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertCorpusRecord } from "./corpus.js";

const MANIFEST_PATH = fileURLToPath(
  new URL("../../corpus/manifest.json", import.meta.url),
);

/**
 * A minimal, otherwise-valid vendored corpus record -- a plain object (not
 * `CorpusRecord`) so individual tests can mutate it into an invalid shape
 * without fighting the type checker (KIT-10).
 */
function validRecord(): Record<string, unknown> {
  return {
    id: "test-fixture",
    format: "webp",
    roles: ["differential"],
    localPath: "sample.webp",
    provenance: {
      revision: "a".repeat(40),
      url: "https://example.com/fixture",
      license: "MIT",
      licenseStatus: "approved",
    },
    sha256: "0".repeat(64),
    bytes: 1,
    topology: ["chunk"],
    outcome: { status: "success", removedNamespaces: [] },
    retainedPayloads: [],
    permittedDifferences: [],
  };
}

function provenanceOf(record: Record<string, unknown>): Record<string, unknown> {
  return record.provenance as Record<string, unknown>;
}

describe("assertCorpusRecord provenance (KIT-10)", () => {
  it("accepts every record in the real manifest, read-only (D-16)", () => {
    const manifest: { records: readonly unknown[] } = JSON.parse(
      readFileSync(MANIFEST_PATH, "utf8"),
    );
    for (const record of manifest.records) {
      expect(() => assertCorpusRecord(record)).not.toThrow();
    }
  });

  it("accepts a minimal valid vendored record", () => {
    expect(() => assertCorpusRecord(validRecord())).not.toThrow();
  });

  it("rejects an unapproved license (Foo-1.0) that the old SPDX-shape regex admitted", () => {
    const record = validRecord();
    provenanceOf(record).license = "Foo-1.0";
    expect(() => assertCorpusRecord(record)).toThrow(/license/);
  });

  it("rejects an OR-disjunction naming an unapproved license (MIT OR Foo-1.0)", () => {
    const record = validRecord();
    provenanceOf(record).license = "MIT OR Foo-1.0";
    expect(() => assertCorpusRecord(record)).toThrow(/license/);
  });

  it("rejects an extra provenance key", () => {
    const record = validRecord();
    provenanceOf(record).mirror = "https://example.com/mirror";
    expect(() => assertCorpusRecord(record)).toThrow(/provenance keys/);
  });

  it("rejects LicenseRef-default-copyright on a vendored record", () => {
    const record = validRecord();
    provenanceOf(record).license = "LicenseRef-default-copyright";
    expect(() => assertCorpusRecord(record)).toThrow(/license/);
  });

  it("rejects an unknown provenance kind", () => {
    const record = validRecord();
    provenanceOf(record).kind = "mirrored";
    expect(() => assertCorpusRecord(record)).toThrow(/provenance kind/);
  });
});
