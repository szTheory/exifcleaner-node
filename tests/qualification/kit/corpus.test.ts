import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCorpusRecord,
  assertNoticeAttribution,
  materializeRecord,
  type CorpusRecord,
} from "./corpus.js";

const MANIFEST_PATH = fileURLToPath(
  new URL("../../corpus/manifest.json", import.meta.url),
);
const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REVISION = "b".repeat(40);
const CC_BY_SA_LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0/";

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

  it("rejects CC-BY-SA-4.0 without a noticeId", () => {
    const record = validRecord();
    provenanceOf(record).license = "CC-BY-SA-4.0";
    expect(() => assertCorpusRecord(record)).toThrow(/noticeId/);
  });
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
    format: "webp",
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
    record.localPath = "sample.webp";
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
      cacheDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function freshCacheDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "exifcleaner-corpus-cache-"));
    cacheDirs.push(dir);
    return dir;
  }

  it("throws when EXIFCLEANER_CORPUS_CACHE_DIR is unset", async () => {
    const bytes = Buffer.from("cache-dir-unset");
    const record = validDownloadOnlyRecord(
      bytes,
    ) as unknown as CorpusRecord;
    await expect(materializeRecord(record, {})).rejects.toThrow(
      /download cache is not configured/,
    );
  });

  it("throws for a relative cache dir", async () => {
    const bytes = Buffer.from("cache-dir-relative");
    const record = validDownloadOnlyRecord(
      bytes,
    ) as unknown as CorpusRecord;
    await expect(
      materializeRecord(record, {
        EXIFCLEANER_CORPUS_CACHE_DIR: "relative/cache",
      }),
    ).rejects.toThrow();
  });

  it("throws for a cache dir inside the repository", async () => {
    const bytes = Buffer.from("cache-dir-inside-repo");
    const record = validDownloadOnlyRecord(
      bytes,
    ) as unknown as CorpusRecord;
    await expect(
      materializeRecord(record, {
        EXIFCLEANER_CORPUS_CACHE_DIR: join(PROJECT_ROOT, "tests"),
      }),
    ).rejects.toThrow();
  });

  it("throws 'Corpus download cache miss' for a missing cache file", async () => {
    const bytes = Buffer.from("cache-dir-missing-file");
    const record = validDownloadOnlyRecord(
      bytes,
    ) as unknown as CorpusRecord;
    const dir = await freshCacheDir();
    await expect(
      materializeRecord(record, { EXIFCLEANER_CORPUS_CACHE_DIR: dir }),
    ).rejects.toThrow(/Corpus download cache miss: test-download-fixture/);
  });

  it("throws 'Corpus integrity check failed' for wrong bytes", async () => {
    const bytes = Buffer.from("expected-bytes-here");
    const record = validDownloadOnlyRecord(
      bytes,
    ) as unknown as CorpusRecord;
    const dir = await freshCacheDir();
    await writeFile(join(dir, record.sha256), Buffer.from("wrong-bytes-here!!!!"));
    await expect(
      materializeRecord(record, { EXIFCLEANER_CORPUS_CACHE_DIR: dir }),
    ).rejects.toThrow(
      /Corpus integrity check failed: test-download-fixture/,
    );
  });

  it("throws 'Corpus integrity check failed' for a truncated cache file", async () => {
    const bytes = Buffer.from("a complete set of expected bytes");
    const record = validDownloadOnlyRecord(
      bytes,
    ) as unknown as CorpusRecord;
    const dir = await freshCacheDir();
    await writeFile(join(dir, record.sha256), bytes.subarray(0, 5));
    await expect(
      materializeRecord(record, { EXIFCLEANER_CORPUS_CACHE_DIR: dir }),
    ).rejects.toThrow(
      /Corpus integrity check failed: test-download-fixture/,
    );
  });

  it("returns the correct bytes for a correctly cached file", async () => {
    const bytes = Buffer.from("the correct cached bytes");
    const record = validDownloadOnlyRecord(
      bytes,
    ) as unknown as CorpusRecord;
    const dir = await freshCacheDir();
    await writeFile(join(dir, record.sha256), bytes);
    const data = await materializeRecord(record, {
      EXIFCLEANER_CORPUS_CACHE_DIR: dir,
    });
    expect(data.equals(bytes)).toBe(true);
  });

  it("never creates, writes, or deletes anything in the cache directory", async () => {
    const bytes = Buffer.from("materializer-is-read-only");
    const record = validDownloadOnlyRecord(
      bytes,
    ) as unknown as CorpusRecord;
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

function fullNoticeStanza(id: string, url: string): string {
  return [
    `[${id}]`,
    "Title: Example Fixture Title",
    "Author: Example Author",
    `Source: ${url}`,
    `License: ${CC_BY_SA_LICENSE_URL}`,
    "Modified: Converted to PNG and cropped",
    "",
  ].join("\n");
}

function noticeRecord(id: string, url: string): CorpusRecord {
  return {
    id: "cc-by-sa-fixture",
    provenance: { noticeId: id, url },
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
});
