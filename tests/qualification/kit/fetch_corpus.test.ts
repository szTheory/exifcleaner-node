import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { materializeRecord, type CorpusRecord } from "./corpus.js";

/**
 * `fetch-corpus.cjs` is CommonJS (Node built-ins and global `fetch` only --
 * no new dependency, per D-24), loaded the same way an existing
 * per-format `oracles.ts` loads `build-oracles.cjs`.
 */
const require = createRequire(import.meta.url);

interface FetchResult {
  readonly path: string;
  readonly skipped: boolean;
  readonly attempts: number;
}
interface FetchVerifiedOptions {
  readonly cacheDir: string;
  readonly retries?: number;
  readonly backoffMs?: number;
  readonly timeoutMs?: number;
  readonly allowOrigin?: (url: URL) => boolean;
}
interface FetchCorpusModule {
  fetchVerified: (
    entry: { url: string; sha256: string; bytes: number },
    options: FetchVerifiedOptions,
  ) => Promise<FetchResult>;
  fetchManifestDownloads: (
    manifestPath: string,
    options: FetchVerifiedOptions,
  ) => Promise<readonly (FetchResult & { id: string })[]>;
  isAllowedProductionUrl: (url: string) => boolean;
}

const fetchCorpus =
  require("../../../scripts/qualification/fetch-corpus.cjs") as FetchCorpusModule;

const cleanupDirs: string[] = [];
const cleanupServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    cleanupDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function freshDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

type LoopbackHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  requestNumber: number,
) => void;

interface LoopbackServer {
  readonly url: (path?: string) => string;
  readonly requestCount: () => number;
}

/**
 * A `127.0.0.1` fixture server (listening on port 0, closed in `afterEach`)
 * -- no existing analog in this codebase (62.1-PATTERNS "No Analog Found"
 * for the fetch tool). `requestCount()` is what the retry/origin behaviors
 * assert against: "0 requests" proves a rejection happened before any
 * network attempt.
 */
async function startLoopbackServer(
  handler: LoopbackHandler,
): Promise<LoopbackServer> {
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    handler(req, res, count);
  });
  cleanupServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("failed to bind test loopback server");
  const port = address.port;
  return {
    url: (path = "/file") => `http://127.0.0.1:${port}${path}`,
    requestCount: () => count,
  };
}

const LOOPBACK_ORIGIN = (url: URL): boolean => url.hostname === "127.0.0.1";
const FILE_ORIGIN = (url: URL): boolean => url.protocol === "file:";
const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FOURTY_HEX = "a".repeat(40);

function neverCalled(): never {
  throw new Error("test server handler should never be called");
}

describe("fetchVerified / fetchManifestDownloads (62.1-04, D-24)", () => {
  it("fetches a download-only manifest record from a loopback server into the cache, and corpus.ts materializes it (tracer)", async () => {
    const content = Buffer.from("tracer-fixture-bytes-62.1-04");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const server = await startLoopbackServer((_req, res) => {
      res.writeHead(200, { "content-length": String(content.length) });
      res.end(content);
    });
    const cacheDir = await freshDir("exifcleaner-fetch-cache-");
    const manifestDir = await freshDir("exifcleaner-fetch-manifest-");
    const manifestPath = join(manifestDir, "manifest.json");
    const record = {
      id: "tracer-download-only",
      format: "heic",
      roles: ["decode"],
      provenance: {
        revision: "a".repeat(40),
        url: server.url(),
        license: "LicenseRef-default-copyright",
        licenseStatus: "approved",
        kind: "download-only",
      },
      sha256,
      bytes: content.length,
      topology: ["mdat"],
      outcome: { status: "success", removedNamespaces: [] },
      retainedPayloads: [],
      permittedDifferences: [],
    };
    await writeFile(
      manifestPath,
      JSON.stringify({ schemaVersion: 1, records: [record] }),
    );

    const results = await fetchCorpus.fetchManifestDownloads(manifestPath, {
      cacheDir,
      allowOrigin: LOOPBACK_ORIGIN,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.skipped).toBe(false);
    expect(server.requestCount()).toBe(1);

    const materialized = await materializeRecord(
      { sha256, bytes: content.length } as unknown as CorpusRecord,
      { EXIFCLEANER_CORPUS_CACHE_DIR: cacheDir },
    );
    expect(materialized.equals(content)).toBe(true);
  });
});

describe("fetchVerified integrity and bounds (62.1-04, D-24)", () => {
  it("rejects a wrong sha256: no cache file and no temp file remain", async () => {
    const content = Buffer.from("wrong-sha-content");
    const wrongSha = createHash("sha256")
      .update(Buffer.from("a-different-payload"))
      .digest("hex");
    const server = await startLoopbackServer((_req, res) => {
      res.writeHead(200, { "content-length": String(content.length) });
      res.end(content);
    });
    const cacheDir = await freshDir("exifcleaner-fetch-cache-");
    await expect(
      fetchCorpus.fetchVerified(
        { url: server.url(), sha256: wrongSha, bytes: content.length },
        { cacheDir, allowOrigin: LOOPBACK_ORIGIN, retries: 1 },
      ),
    ).rejects.toThrow(/integrity/);
    expect(await readdir(cacheDir)).toHaveLength(0);
  });

  it("aborts without retry when more than the declared byte count arrives", async () => {
    const payload = Buffer.from("x".repeat(16));
    const declaredBytes = payload.length - 1;
    const sha256 = createHash("sha256")
      .update(payload.subarray(0, declaredBytes))
      .digest("hex");
    const server = await startLoopbackServer((_req, res) => {
      res.writeHead(200, { "content-length": String(payload.length) });
      res.end(payload);
    });
    const cacheDir = await freshDir("exifcleaner-fetch-cache-");
    await expect(
      fetchCorpus.fetchVerified(
        { url: server.url(), sha256, bytes: declaredBytes },
        { cacheDir, allowOrigin: LOOPBACK_ORIGIN, retries: 3, backoffMs: 1 },
      ),
    ).rejects.toThrow(/declared size/);
    expect(server.requestCount()).toBe(1);
    expect(await readdir(cacheDir)).toHaveLength(0);
  });
});

describe("fetchVerified retry classification (62.1-04, D-24)", () => {
  it("retries HTTP 503 twice and succeeds on the third attempt", async () => {
    const content = Buffer.from("retry-content");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const server = await startLoopbackServer((_req, res, requestNumber) => {
      if (requestNumber < 3) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200, { "content-length": String(content.length) });
      res.end(content);
    });
    const cacheDir = await freshDir("exifcleaner-fetch-cache-");
    const result = await fetchCorpus.fetchVerified(
      { url: server.url(), sha256, bytes: content.length },
      { cacheDir, allowOrigin: LOOPBACK_ORIGIN, retries: 3, backoffMs: 1 },
    );
    expect(result.skipped).toBe(false);
    expect(result.attempts).toBe(3);
    expect(server.requestCount()).toBe(3);
  });

  it("fails a 404 after a single request, with no retry", async () => {
    const server = await startLoopbackServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const cacheDir = await freshDir("exifcleaner-fetch-cache-");
    await expect(
      fetchCorpus.fetchVerified(
        { url: server.url(), sha256: "0".repeat(64), bytes: 1 },
        { cacheDir, allowOrigin: LOOPBACK_ORIGIN, retries: 3, backoffMs: 1 },
      ),
    ).rejects.toThrow(/404/);
    expect(server.requestCount()).toBe(1);
  });
});

describe("fetchVerified production origin rules, no test allowOrigin (62.1-04, D-24)", () => {
  it("rejects a non-https loopback URL before any request (request count 0)", async () => {
    const server = await startLoopbackServer(neverCalled);
    const cacheDir = await freshDir("exifcleaner-fetch-cache-");
    await expect(
      fetchCorpus.fetchVerified(
        { url: server.url(), sha256: "0".repeat(64), bytes: 1 },
        { cacheDir },
      ),
    ).rejects.toThrow(/not permitted/);
    expect(server.requestCount()).toBe(0);
  });

  it.each([
    [
      `https://raw.githubusercontent.com.evil.test/org/repo/${FOURTY_HEX}/file`,
      "look-alike host",
    ],
    [
      `https://user:pass@raw.githubusercontent.com/org/repo/${FOURTY_HEX}/file`,
      "userinfo",
    ],
    [
      "https://raw.githubusercontent.com/org/repo/main/file",
      "no revision in path",
    ],
  ])(
    "rejects %s (%s) before any request -- unroutable from this test host, so request count is proven by isAllowedProductionUrl returning false rather than a loopback counter",
    async (url) => {
      expect(fetchCorpus.isAllowedProductionUrl(url)).toBe(false);
      const cacheDir = await freshDir("exifcleaner-fetch-cache-");
      await expect(
        fetchCorpus.fetchVerified(
          { url, sha256: "0".repeat(64), bytes: 1 },
          { cacheDir },
        ),
      ).rejects.toThrow(/not permitted/);
    },
  );

  it("isAllowedProductionUrl admits a well-formed raw.githubusercontent.com revision URL", () => {
    expect(
      fetchCorpus.isAllowedProductionUrl(
        `https://raw.githubusercontent.com/org/repo/${FOURTY_HEX}/file`,
      ),
    ).toBe(true);
  });
});

describe("fetchVerified cache dir rules (62.1-04, D-24)", () => {
  it("rejects a relative cache dir before any request", async () => {
    const server = await startLoopbackServer(neverCalled);
    await expect(
      fetchCorpus.fetchVerified(
        { url: server.url(), sha256: "0".repeat(64), bytes: 1 },
        { cacheDir: "relative/cache", allowOrigin: LOOPBACK_ORIGIN },
      ),
    ).rejects.toThrow(/absolute/);
    expect(server.requestCount()).toBe(0);
  });

  it("rejects a cache dir inside the repository before any request", async () => {
    const server = await startLoopbackServer(neverCalled);
    const insideRepo = join(
      PROJECT_ROOT,
      "tests",
      "corpus-cache-should-not-exist",
    );
    await expect(
      fetchCorpus.fetchVerified(
        { url: server.url(), sha256: "0".repeat(64), bytes: 1 },
        { cacheDir: insideRepo, allowOrigin: LOOPBACK_ORIGIN },
      ),
    ).rejects.toThrow(/outside the repository/);
    expect(server.requestCount()).toBe(0);
  });
});

describe("fetchVerified idempotent re-run (62.1-04, D-24)", () => {
  it("makes no request and leaves mtime unchanged when a valid cached file exists", async () => {
    const content = Buffer.from("idempotent-content");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const cacheDir = await freshDir("exifcleaner-fetch-cache-");
    const targetPath = join(cacheDir, sha256);
    await writeFile(targetPath, content);
    const before = await stat(targetPath);
    const server = await startLoopbackServer(neverCalled);
    const result = await fetchCorpus.fetchVerified(
      { url: server.url(), sha256, bytes: content.length },
      { cacheDir, allowOrigin: LOOPBACK_ORIGIN },
    );
    expect(result.skipped).toBe(true);
    expect(server.requestCount()).toBe(0);
    const after = await stat(targetPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});

describe("fetchVerified file:// source (62.1-04, D-24)", () => {
  it("fetches a file:// source through the test allowOrigin option", async () => {
    const content = Buffer.from("file-source-content");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const sourceDir = await freshDir("exifcleaner-fetch-source-");
    const sourcePath = join(sourceDir, "source.bin");
    await writeFile(sourcePath, content);
    const cacheDir = await freshDir("exifcleaner-fetch-cache-");
    const result = await fetchCorpus.fetchVerified(
      {
        url: pathToFileURL(sourcePath).toString(),
        sha256,
        bytes: content.length,
      },
      { cacheDir, allowOrigin: FILE_ORIGIN },
    );
    expect(result.skipped).toBe(false);
    const materialized = await materializeRecord(
      { sha256, bytes: content.length } as unknown as CorpusRecord,
      { EXIFCLEANER_CORPUS_CACHE_DIR: cacheDir },
    );
    expect(materialized.equals(content)).toBe(true);
  });
});
