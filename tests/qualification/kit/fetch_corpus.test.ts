import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeRecord, type CorpusRecord } from "./corpus.js";

/**
 * `fetch-corpus.cjs` is CommonJS (Node built-ins and global `fetch` only --
 * no new dependency, per D-24), loaded the same way `webp/oracles.ts` loads
 * `build-oracles.cjs`.
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
