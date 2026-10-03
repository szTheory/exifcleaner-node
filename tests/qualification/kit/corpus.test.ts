import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getCapabilities } from "../../../dist/index.js";
import {
  APPROVED_CORPUS_LICENSES,
  assertCorpusRecord,
  assertNoticeAttribution,
  materializeRecord,
  runQualificationCase,
  type CorpusRecord,
} from "./corpus.js";

const MANIFEST_PATH = fileURLToPath(
  new URL("../../corpus/manifest.json", import.meta.url),
);
const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REVISION = "b".repeat(40);
const CC_BY_SA_LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0/";
/**
 * Any currently registered format works for these shape-only tests -- never
 * a literal format name, so this file stays format-neutral as the registry
 * grows (KIT-01 D-03).
 */
const SOME_REGISTERED_FORMAT = getCapabilities().formats[0]?.format;
if (SOME_REGISTERED_FORMAT === undefined)
  throw new Error("No registered format available for corpus.test.ts");

/**
 * A minimal, otherwise-valid vendored corpus record -- a plain object (not
 * `CorpusRecord`) so individual tests can mutate it into an invalid shape
 * without fighting the type checker (KIT-10).
 */
function validRecord(): Record<string, unknown> {
  return {
    id: "test-fixture",
    format: SOME_REGISTERED_FORMAT,
    roles: ["differential"],
    localPath: "test-fixture.bin",
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

function provenanceOf(
  record: Record<string, unknown>,
): Record<string, unknown> {
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

  it("rejects CC-BY-SA-4.0 without a noticeId", () => {
    const record = validRecord();
    provenanceOf(record).license = "CC-BY-SA-4.0";
    expect(() => assertCorpusRecord(record)).toThrow(/noticeId/);
  });
});

/**
 * Negative control for the 2026-10-02 maintainer widening: exactly two
 * attribution-requiring classes were added. An unlisted license must still
 * fail closed, and each new class must name a NOTICE stanza.
 */
describe("APPROVED_CORPUS_LICENSES widening (KIT-10/D-13)", () => {
  const ADDED = ["CC-BY-4.0", "LGPL-2.1-only OR BSD-2-Clause"] as const;

  it("still rejects an unlisted license (GPL-3.0-only) on vendored and download-only records", () => {
    expect(APPROVED_CORPUS_LICENSES.has("GPL-3.0-only")).toBe(false);
    const vendored = validRecord();
    provenanceOf(vendored).license = "GPL-3.0-only";
    expect(() => assertCorpusRecord(vendored)).toThrow(/license/);
    const downloadOnly = validDownloadOnlyRecord(Buffer.from("x"));
    provenanceOf(downloadOnly).license = "GPL-3.0-only";
    expect(() => assertCorpusRecord(downloadOnly)).toThrow(/license/);
  });

  it("rejects near-miss spellings of the added classes", () => {
    for (const license of [
      "CC-BY-4",
      "BSD-2-Clause OR LGPL-2.1-only",
      "LGPL-2.1-only",
      "LGPL-2.1-or-later OR BSD-2-Clause",
    ]) {
      const record = validRecord();
      provenanceOf(record).license = license;
      provenanceOf(record).noticeId = "example-notice-id";
      expect(() => assertCorpusRecord(record)).toThrow(/license/);
    }
  });

  for (const license of ADDED) {
    it(`accepts ${license} with a noticeId`, () => {
      expect(APPROVED_CORPUS_LICENSES.has(license)).toBe(true);
      const record = validRecord();
      provenanceOf(record).license = license;
      provenanceOf(record).noticeId = "example-notice-id";
      expect(() => assertCorpusRecord(record)).not.toThrow();
    });

    it(`rejects ${license} without a noticeId`, () => {
      const record = validRecord();
      provenanceOf(record).license = license;
      expect(() => assertCorpusRecord(record)).toThrow(/noticeId/);
    });
  }
});

/**
 * A minimal, otherwise-valid download-only record (KIT-10/D-14): no
 * localPath or generator, an https raw.githubusercontent.com URL carrying
 * the revision, and sha256/bytes matching `bytes` so a materialize test can
 * reuse it directly.
 */
function validDownloadOnlyRecord(bytes: Buffer): Record<string, unknown> {
  return {
    id: "test-download-fixture",
    format: SOME_REGISTERED_FORMAT,
    roles: ["differential"],
    provenance: {
      revision: REVISION,
      url: `https://raw.githubusercontent.com/example/example/${REVISION}/fixture.bin`,
      license: "LicenseRef-default-copyright",
      licenseStatus: "approved",
      kind: "download-only",
    },
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    topology: ["chunk"],
    outcome: { status: "success", removedNamespaces: [] },
    retainedPayloads: [],
    permittedDifferences: [],
  };
}

describe("download-only provenance shape (KIT-10/D-14)", () => {
  const fixtureBytes = Buffer.from("download-only fixture bytes");

  it("accepts a valid download-only record", () => {
    expect(() =>
      assertCorpusRecord(validDownloadOnlyRecord(fixtureBytes)),
    ).not.toThrow();
  });

  it("rejects a download-only record carrying localPath", () => {
    const record = validDownloadOnlyRecord(fixtureBytes);
    record.localPath = "test-fixture.bin";
    expect(() => assertCorpusRecord(record)).toThrow(
      /download-only materializer/,
    );
  });

  it("rejects a download-only record carrying generator", () => {
    const record = validDownloadOnlyRecord(fixtureBytes);
    record.generator = {
      kind: "x-declared-size-plus-one",
      seed: 1,
      sourceCase: "other",
    };
    expect(() => assertCorpusRecord(record)).toThrow(
      /download-only materializer/,
    );
  });

  it("rejects a non-https download-only url", () => {
    const record = validDownloadOnlyRecord(fixtureBytes);
    provenanceOf(record).url =
      `http://raw.githubusercontent.com/example/example/${REVISION}/fixture.bin`;
    expect(() => assertCorpusRecord(record)).toThrow();
  });

  it("rejects a host other than raw.githubusercontent.com", () => {
    const record = validDownloadOnlyRecord(fixtureBytes);
    provenanceOf(record).url =
      `https://example.com/example/${REVISION}/fixture.bin`;
    expect(() => assertCorpusRecord(record)).toThrow(/download-only url/);
  });

  it("rejects a look-alike host (raw.githubusercontent.com.evil.test)", () => {
    const record = validDownloadOnlyRecord(fixtureBytes);
    provenanceOf(record).url =
      `https://raw.githubusercontent.com.evil.test/example/${REVISION}/fixture.bin`;
    expect(() => assertCorpusRecord(record)).toThrow(/download-only url/);
  });

  it("rejects a userinfo form of the host", () => {
    const record = validDownloadOnlyRecord(fixtureBytes);
    provenanceOf(record).url =
      `https://user:pass@raw.githubusercontent.com/example/${REVISION}/fixture.bin`;
    expect(() => assertCorpusRecord(record)).toThrow(/download-only url/);
  });

  it("rejects a path lacking the revision", () => {
    const record = validDownloadOnlyRecord(fixtureBytes);
    provenanceOf(record).url =
      "https://raw.githubusercontent.com/example/example/main/fixture.bin";
    expect(() => assertCorpusRecord(record)).toThrow(/download-only url/);
  });
});

describe("materializeRecord download-only cache (KIT-10/D-14)", () => {
  const cacheDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cacheDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function freshCacheDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "exifcleaner-corpus-cache-"));
    cacheDirs.push(dir);
    return dir;
  }

  it("throws when EXIFCLEANER_CORPUS_CACHE_DIR is unset", async () => {
    const bytes = Buffer.from("cache-dir-unset");
    const record = validDownloadOnlyRecord(bytes) as unknown as CorpusRecord;
    await expect(materializeRecord(record, {})).rejects.toThrow(
      /download cache is not configured/,
    );
  });

  it("throws for a relative cache dir", async () => {
    const bytes = Buffer.from("cache-dir-relative");
    const record = validDownloadOnlyRecord(bytes) as unknown as CorpusRecord;
    await expect(
      materializeRecord(record, {
        EXIFCLEANER_CORPUS_CACHE_DIR: "relative/cache",
      }),
    ).rejects.toThrow();
  });

  it("throws for a cache dir inside the repository", async () => {
    const bytes = Buffer.from("cache-dir-inside-repo");
    const record = validDownloadOnlyRecord(bytes) as unknown as CorpusRecord;
    await expect(
      materializeRecord(record, {
        EXIFCLEANER_CORPUS_CACHE_DIR: join(PROJECT_ROOT, "tests"),
      }),
    ).rejects.toThrow();
  });

  it("throws 'Corpus download cache miss' for a missing cache file", async () => {
    const bytes = Buffer.from("cache-dir-missing-file");
    const record = validDownloadOnlyRecord(bytes) as unknown as CorpusRecord;
    const dir = await freshCacheDir();
    await expect(
      materializeRecord(record, { EXIFCLEANER_CORPUS_CACHE_DIR: dir }),
    ).rejects.toThrow(/Corpus download cache miss: test-download-fixture/);
  });

  it("throws 'Corpus integrity check failed' for wrong bytes", async () => {
    const bytes = Buffer.from("expected-bytes-here");
    const record = validDownloadOnlyRecord(bytes) as unknown as CorpusRecord;
    const dir = await freshCacheDir();
    await writeFile(
      join(dir, record.sha256),
      Buffer.from("wrong-bytes-here!!!!"),
    );
    await expect(
      materializeRecord(record, { EXIFCLEANER_CORPUS_CACHE_DIR: dir }),
    ).rejects.toThrow(/Corpus integrity check failed: test-download-fixture/);
  });

  it("throws 'Corpus integrity check failed' for a truncated cache file", async () => {
    const bytes = Buffer.from("a complete set of expected bytes");
    const record = validDownloadOnlyRecord(bytes) as unknown as CorpusRecord;
    const dir = await freshCacheDir();
    await writeFile(join(dir, record.sha256), bytes.subarray(0, 5));
    await expect(
      materializeRecord(record, { EXIFCLEANER_CORPUS_CACHE_DIR: dir }),
    ).rejects.toThrow(/Corpus integrity check failed: test-download-fixture/);
  });

  it("returns the correct bytes for a correctly cached file", async () => {
    const bytes = Buffer.from("the correct cached bytes");
    const record = validDownloadOnlyRecord(bytes) as unknown as CorpusRecord;
    const dir = await freshCacheDir();
    await writeFile(join(dir, record.sha256), bytes);
    const data = await materializeRecord(record, {
      EXIFCLEANER_CORPUS_CACHE_DIR: dir,
    });
    expect(data.equals(bytes)).toBe(true);
  });

  it("never creates, writes, or deletes anything in the cache directory", async () => {
    const bytes = Buffer.from("materializer-is-read-only");
    const record = validDownloadOnlyRecord(bytes) as unknown as CorpusRecord;
    const dir = await freshCacheDir();
    await writeFile(join(dir, record.sha256), bytes);
    const before = await readdir(dir);
    const statBefore = await stat(join(dir, record.sha256));
    await materializeRecord(record, { EXIFCLEANER_CORPUS_CACHE_DIR: dir });
    // A second call -- including one that fails integrity -- must not touch
    // the directory either.
    await writeFile(join(dir, "wrong.sha"), Buffer.from("unrelated"));
    await rm(join(dir, "wrong.sha"));
    const after = await readdir(dir);
    const statAfter = await stat(join(dir, record.sha256));
    expect(after.sort()).toEqual(before.sort());
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(statAfter.size).toBe(statBefore.size);
  });
});

function fullNoticeStanza(
  id: string,
  url: string,
  licenseLine: string = CC_BY_SA_LICENSE_URL,
): string {
  return [
    `[${id}]`,
    "Title: Example Fixture Title",
    "Author: Example Author",
    `Source: ${url}`,
    `License: ${licenseLine}`,
    "Modified: Converted and cropped to a smaller resolution",
    "",
  ].join("\n");
}

function noticeRecord(
  id: string,
  url: string,
  license = "CC-BY-SA-4.0",
): CorpusRecord {
  return {
    id: "cc-by-sa-fixture",
    provenance: { noticeId: id, url, license },
  } as unknown as CorpusRecord;
}

describe("assertNoticeAttribution (KIT-10/D-15)", () => {
  const url = "https://example.com/cc-by-sa-fixture";
  const noticeId = "example-notice-id";

  it("accepts a full, correctly formed stanza", () => {
    const record = noticeRecord(noticeId, url);
    expect(() =>
      assertNoticeAttribution(record, fullNoticeStanza(noticeId, url)),
    ).not.toThrow();
  });

  it("rejects when the Title line is removed", () => {
    const record = noticeRecord(noticeId, url);
    const text = fullNoticeStanza(noticeId, url)
      .split("\n")
      .filter((line) => !line.startsWith("Title:"))
      .join("\n");
    expect(() => assertNoticeAttribution(record, text)).toThrow(/Title/);
  });

  it("rejects when the Author line is removed", () => {
    const record = noticeRecord(noticeId, url);
    const text = fullNoticeStanza(noticeId, url)
      .split("\n")
      .filter((line) => !line.startsWith("Author:"))
      .join("\n");
    expect(() => assertNoticeAttribution(record, text)).toThrow(/Author/);
  });

  it("rejects when the Source line is removed", () => {
    const record = noticeRecord(noticeId, url);
    const text = fullNoticeStanza(noticeId, url)
      .split("\n")
      .filter((line) => !line.startsWith("Source:"))
      .join("\n");
    expect(() => assertNoticeAttribution(record, text)).toThrow(/Source/);
  });

  it("rejects when the License line is removed", () => {
    const record = noticeRecord(noticeId, url);
    const text = fullNoticeStanza(noticeId, url)
      .split("\n")
      .filter((line) => !line.startsWith("License:"))
      .join("\n");
    expect(() => assertNoticeAttribution(record, text)).toThrow(/License/);
  });

  it("rejects when the Modified line is removed", () => {
    const record = noticeRecord(noticeId, url);
    const text = fullNoticeStanza(noticeId, url)
      .split("\n")
      .filter((line) => !line.startsWith("Modified:"))
      .join("\n");
    expect(() => assertNoticeAttribution(record, text)).toThrow(/Modified/);
  });

  it("rejects a Source differing from the record URL", () => {
    const record = noticeRecord(noticeId, url);
    const text = fullNoticeStanza(noticeId, "https://example.com/different");
    expect(() => assertNoticeAttribution(record, text)).toThrow(/Source/);
  });

  it("rejects when no stanza exists for the id", () => {
    const record = noticeRecord(noticeId, url);
    const text = fullNoticeStanza("some-other-id", url);
    expect(() => assertNoticeAttribution(record, text)).toThrow(
      /No NOTICE stanza/,
    );
  });

  it("accepts each added class only with its own License line", () => {
    const lines = {
      "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
      "LGPL-2.1-only OR BSD-2-Clause": "LGPL-2.1-only OR BSD-2-Clause",
    } as const;
    for (const [license, line] of Object.entries(lines)) {
      const record = noticeRecord(noticeId, url, license);
      expect(() =>
        assertNoticeAttribution(record, fullNoticeStanza(noticeId, url, line)),
      ).not.toThrow();
      // The CC BY-SA deed is not a valid License line for either class.
      expect(() =>
        assertNoticeAttribution(record, fullNoticeStanza(noticeId, url)),
      ).toThrow(/License/);
    }
  });

  it("rejects a record whose license needs no attribution", () => {
    const record = noticeRecord(noticeId, url, "MIT");
    expect(() =>
      assertNoticeAttribution(record, fullNoticeStanza(noticeId, url)),
    ).toThrow(/needs no NOTICE attribution/);
  });
});

describe("refusal outcome schema (D-25)", () => {
  function refusedRecord(): Record<string, unknown> {
    return {
      ...validRecord(),
      outcome: {
        status: "refused",
        errorCode: "unsupported-format",
        nativeWrite: "not-started",
        declineClass: "some-decline-class",
      },
    };
  }

  it("accepts unsupported-format with a slug decline class", () => {
    expect(() => assertCorpusRecord(refusedRecord())).not.toThrow();
  });

  it("rejects an unknown error code", () => {
    const record = refusedRecord();
    (record.outcome as Record<string, unknown>).errorCode =
      "unsupported-feature";
    expect(() => assertCorpusRecord(record)).toThrow(/outcome/);
  });

  it("rejects a malformed decline class", () => {
    for (const declineClass of [
      "",
      "Upper-Case",
      "1-leading-digit",
      "has space",
      7,
    ]) {
      const record = refusedRecord();
      (record.outcome as Record<string, unknown>).declineClass = declineClass;
      expect(() => assertCorpusRecord(record)).toThrow(/declineClass/);
    }
  });

  it("rejects an extra refused or success outcome key", () => {
    const refused = refusedRecord();
    (refused.outcome as Record<string, unknown>).reason = "extra";
    expect(() => assertCorpusRecord(refused)).toThrow(/outcome keys/);
    const success = validRecord();
    (success.outcome as Record<string, unknown>).declineClass = "x";
    expect(() => assertCorpusRecord(success)).toThrow(/outcome keys/);
  });
});

/**
 * D-25 pins are exact: an unexpected admit, a wrong decline class or a
 * missing class reader is red. Each case rewrites one real record in a temp
 * manifest copy (chosen by shape, never by format name).
 */
describe("runQualificationCase exact refusal pins (D-25)", () => {
  type MutableRecord = Record<string, unknown> & { id: string };
  const realRecords = (
    JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
      records: MutableRecord[];
    }
  ).records;
  const admitted = realRecords.find(
    (record) =>
      typeof record.localPath === "string" &&
      (record.outcome as { status: string }).status === "success",
  );
  const refused = realRecords.find(
    (record) =>
      typeof record.localPath === "string" &&
      (record.outcome as { status: string }).status === "refused",
  );
  if (admitted === undefined || refused === undefined)
    throw new Error("Manifest lacks a vendored success and refused record");
  const noDigests = (): readonly never[] => [];
  let directory: string | undefined;

  afterEach(async () => {
    if (directory !== undefined)
      await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function manifestWith(record: MutableRecord): Promise<string> {
    directory = await mkdtemp(join(tmpdir(), "corpus-pin-"));
    const path = join(directory, "manifest.json");
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 1, records: [record] }),
    );
    return path;
  }

  it("throws when an admitted file is pinned as refused", async () => {
    const manifestPath = await manifestWith({
      ...admitted,
      outcome: {
        status: "refused",
        errorCode: "unsupported-format",
        nativeWrite: "not-started",
      },
    });
    await expect(
      runQualificationCase(admitted.id, {
        payloadDigests: noDigests,
        manifestPath,
      }),
    ).rejects.toThrow(/Expected refusal/);
  });

  it("passes a pinned refusal with the source unchanged and no destination", async () => {
    const manifestPath = await manifestWith(refused);
    const transcript = await runQualificationCase(refused.id, {
      payloadDigests: noDigests,
      manifestPath,
    });
    expect(transcript).toMatchObject({
      status: "refused",
      source: { unchanged: true },
      destination: { state: "absent" },
    });
  });

  it("requires the reader's class to equal a pinned decline class", async () => {
    const manifestPath = await manifestWith({
      ...refused,
      outcome: {
        ...(refused.outcome as object),
        declineClass: "pinned-class",
      },
    });
    const run = (readDeclineClass?: (bytes: Buffer) => string | undefined) =>
      runQualificationCase(refused.id, {
        payloadDigests: noDigests,
        manifestPath,
        ...(readDeclineClass === undefined ? {} : { readDeclineClass }),
      });
    await expect(run()).rejects.toThrow(/No decline-class reader/);
    await expect(run(() => "other-class")).rejects.toThrow(
      /Decline class mismatch/,
    );
    await expect(run(() => undefined)).rejects.toThrow(/measured admitted/);
    await expect(run(() => "pinned-class")).resolves.toMatchObject({
      status: "refused",
    });
  });
});
