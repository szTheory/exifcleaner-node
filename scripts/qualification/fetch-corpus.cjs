"use strict";

/**
 * Corpus fetch tool (62.1-04, D-24): populates the local download cache that
 * `tests/qualification/kit/corpus.ts`'s `materializeRecord()` reads
 * `kind: "download-only"` records from (KIT-10/D-14). Download-only bytes
 * are never vendored into this repository or the published npm package --
 * this tool's whole purpose is to put verified bytes into a cache directory
 * that lives outside the repository, named by their own sha256.
 *
 * Node built-ins and the global `fetch` only -- no new dependency. Lives
 * under scripts/, never under src/: the runtime library stays network-free.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");
const { fileURLToPath } = require("node:url");

const projectRoot = path.resolve(__dirname, "../..");
const DEFAULT_MANIFEST_PATH = path.join(
  projectRoot,
  "tests/corpus/manifest.json",
);
const SHA256_RE = /^[a-f0-9]{64}$/;
const REVISION_SEGMENT_RE = /^[a-f0-9]{40}$/;
const PRODUCTION_ALLOWED_HOST = "raw.githubusercontent.com";
const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 500;
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Thrown for failures a retry could plausibly fix: network errors,
 * timeouts, and HTTP 429/5xx. Anything else (bad origin, integrity
 * mismatch, oversized stream, non-429 4xx) is a `NonRetryableError`.
 */
class RetryableError extends Error {}
class NonRetryableError extends Error {}

function isSha256(value) {
  return typeof value === "string" && SHA256_RE.test(value);
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The production origin rule (same rule as corpus.ts's download-only
 * provenance check, generalized since this entry point never receives a
 * declared revision): exact https host, no userinfo, and a 40-hex path
 * segment that looks like a git revision. Exported so tests can assert the
 * rule directly without round-tripping through a real network attempt.
 */
function isAllowedProductionUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname !== PRODUCTION_ALLOWED_HOST) return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  const segments = parsed.pathname.split("/");
  return segments.some((segment) => REVISION_SEGMENT_RE.test(segment));
}

/**
 * The cache directory must be absolute and outside the repository
 * (corpus.ts materializeRecord's rule, KIT-10/D-14) -- checked before any
 * network call, not just before the write.
 */
function assertCacheDir(cacheDir) {
  if (typeof cacheDir !== "string" || cacheDir.length === 0)
    throw new Error("cacheDir must be a non-empty string");
  if (!path.isAbsolute(cacheDir))
    throw new Error("cacheDir must be an absolute path");
  const resolved = path.resolve(cacheDir);
  const fromRoot = path.relative(projectRoot, resolved);
  if (!fromRoot.startsWith(".."))
    throw new Error("cacheDir must be outside the repository");
  return resolved;
}

async function isValidCacheFile(targetPath, bytes, sha256) {
  let stat;
  try {
    stat = await fsp.stat(targetPath);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size !== bytes) return false;
  const data = await fsp.readFile(targetPath);
  return crypto.createHash("sha256").update(data).digest("hex") === sha256;
}

/**
 * Opens a readable stream for one attempt. `file://` sources exist only so
 * tests can exercise the integrity/bounds machinery without a real network
 * call -- production entries are always `https://raw.githubusercontent.com`.
 * Non-2xx/retryable statuses are classified here so the caller never has to
 * inspect a response directly.
 */
async function openAttemptStream(url, timeoutMs) {
  const parsed = new URL(url);
  if (parsed.protocol === "file:") {
    let filePath;
    try {
      filePath = fileURLToPath(parsed);
    } catch (error) {
      throw new NonRetryableError(`invalid file:// URL: ${error.message}`);
    }
    try {
      await fsp.access(filePath, fs.constants.R_OK);
    } catch (error) {
      throw new NonRetryableError(`file not found: ${error.message}`);
    }
    return fs.createReadStream(filePath);
  }

  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new RetryableError(`network error fetching ${url}: ${error.message}`);
  }
  if (response.status === 429 || response.status >= 500) {
    if (response.body !== null) {
      try {
        await response.body.cancel();
      } catch {
        // best effort -- the attempt already failed
      }
    }
    throw new RetryableError(
      `retryable HTTP status ${response.status} fetching ${url}`,
    );
  }
  if (response.status !== 200) {
    if (response.body !== null) {
      try {
        await response.body.cancel();
      } catch {
        // best effort -- the attempt already failed
      }
    }
    throw new NonRetryableError(
      `HTTP status ${response.status} fetching ${url}`,
    );
  }
  if (response.body === null)
    throw new NonRetryableError(`empty response body fetching ${url}`);
  return Readable.fromWeb(response.body);
}

/**
 * Streams one attempt to a temp file in the cache dir, verifying sha256 and
 * byte count as data arrives. Aborts (no retry) the instant more than the
 * declared byte count has arrived -- bounded memory and disk. On any
 * mismatch the temp file is removed and nothing named `<sha256>` exists
 * afterwards; on success it is renamed atomically onto the target path.
 */
async function streamAttempt(readable, cacheDir, sha256, bytes, targetPath) {
  const tempPath = path.join(
    cacheDir,
    `${sha256}.partial-${crypto.randomBytes(8).toString("hex")}`,
  );
  const hash = crypto.createHash("sha256");
  let total = 0;
  const writeStream = fs.createWriteStream(tempPath, { flags: "wx" });

  try {
    await new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        readable.destroy();
        writeStream.destroy();
        rejectPromise(error);
      };
      readable.on("data", (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > bytes) {
          fail(
            new NonRetryableError("downloaded bytes exceed the declared size"),
          );
          return;
        }
        hash.update(chunk);
        if (!writeStream.write(chunk)) readable.pause();
      });
      writeStream.on("drain", () => {
        if (!settled) readable.resume();
      });
      readable.on("error", (error) => {
        fail(new RetryableError(`stream error: ${error.message}`));
      });
      writeStream.on("error", (error) => {
        fail(error);
      });
      readable.on("end", () => {
        if (settled) return;
        settled = true;
        writeStream.end(() => resolvePromise());
      });
    });
  } catch (error) {
    // `fail` destroys the write stream, but its async open may still be in flight on another
    // threadpool thread: removing the temp path before the stream has closed lets that open
    // re-create the file afterwards and leak a `.partial-*` into the cache dir. Wait for close.
    if (!writeStream.closed) {
      await new Promise((resolveClose) =>
        writeStream.once("close", resolveClose),
      );
    }
    await fsp.rm(tempPath, { force: true });
    throw error;
  }

  if (total !== bytes || hash.digest("hex") !== sha256) {
    await fsp.rm(tempPath, { force: true });
    throw new NonRetryableError("corpus fetch integrity check failed");
  }

  await fsp.rename(tempPath, targetPath);
}

/**
 * Fetches one entry (`{ url, sha256, bytes }`) into `options.cacheDir`,
 * verified and retried. `options.allowOrigin`, when provided, is a
 * predicate `(url: URL) => boolean` that REPLACES the production origin
 * rule -- it exists only so tests can admit `file://`/loopback sources; the
 * default admits only `https://raw.githubusercontent.com/<...>/<40-hex
 * revision>/...`.
 */
async function fetchVerified(entry, options = {}) {
  const {
    cacheDir,
    retries = DEFAULT_RETRIES,
    backoffMs = DEFAULT_BACKOFF_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    allowOrigin,
  } = options;

  if (typeof entry?.url !== "string" || entry.url.length === 0)
    throw new Error("entry.url must be a non-empty string");
  if (!isSha256(entry.sha256))
    throw new Error("entry.sha256 must be a 64-character hex sha256");
  if (!isPositiveInteger(entry.bytes))
    throw new Error("entry.bytes must be a positive integer");

  const resolvedCacheDir = assertCacheDir(cacheDir);
  const targetPath = path.join(resolvedCacheDir, entry.sha256);

  // Idempotent re-run (corpus.ts materializeRecord's own cache contract):
  // an existing file that already verifies is kept untouched, no request.
  if (await isValidCacheFile(targetPath, entry.bytes, entry.sha256))
    return { path: targetPath, skipped: true, attempts: 0 };

  const originAllowed =
    typeof allowOrigin === "function"
      ? allowOrigin(new URL(entry.url))
      : isAllowedProductionUrl(entry.url);
  if (!originAllowed)
    throw new NonRetryableError(
      `URL origin not permitted for corpus fetch: ${entry.url}`,
    );

  await fsp.mkdir(resolvedCacheDir, { recursive: true });

  let attempt = 0;
  let lastError;
  while (attempt < retries) {
    attempt += 1;
    try {
      const readable = await openAttemptStream(entry.url, timeoutMs);
      await streamAttempt(
        readable,
        resolvedCacheDir,
        entry.sha256,
        entry.bytes,
        targetPath,
      );
      return { path: targetPath, skipped: false, attempts: attempt };
    } catch (error) {
      if (!(error instanceof RetryableError) || attempt >= retries) throw error;
      lastError = error;
      await sleep(backoffMs * attempt);
    }
  }
  throw lastError;
}

function isObjectLike(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a `tests/corpus/manifest.json`-shaped JSON file and fetches every
 * `provenance.kind === "download-only"` record by its `provenance.url`,
 * `sha256` and `bytes` -- the exact fields `materializeRecord()`'s
 * download-only branch verifies against.
 */
async function fetchManifestDownloads(manifestPath, options = {}) {
  const raw = await fsp.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  const records = Array.isArray(manifest?.records) ? manifest.records : [];
  const downloadOnly = records.filter(
    (record) =>
      isObjectLike(record) &&
      isObjectLike(record.provenance) &&
      record.provenance.kind === "download-only",
  );

  const results = [];
  for (const record of downloadOnly) {
    try {
      const result = await fetchVerified(
        {
          url: record.provenance.url,
          sha256: record.sha256,
          bytes: record.bytes,
        },
        options,
      );
      results.push({ id: record.id, ...result });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to fetch corpus record "${record.id}": ${detail}`,
      );
    }
  }
  return results;
}

function parseCliArgs(argv) {
  let cacheDir;
  let manifestPath = DEFAULT_MANIFEST_PATH;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--cache") {
      cacheDir = argv[i + 1];
      i += 1;
    } else if (arg === "--manifest") {
      manifestPath = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (cacheDir === undefined)
    throw new Error(
      "Usage: fetch-corpus.cjs --cache <absolute dir> [--manifest <path>]",
    );
  return { cacheDir, manifestPath };
}

async function main(argv) {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  try {
    const results = await fetchManifestDownloads(args.manifestPath, {
      cacheDir: args.cacheDir,
    });
    process.stdout.write(
      `fetch-corpus: fetched ${results.length} download-only record(s) into ${args.cacheDir}\n`,
    );
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`fetch-corpus: ${detail}\n`);
    return 1;
  }
}

module.exports = {
  fetchVerified,
  fetchManifestDownloads,
  isAllowedProductionUrl,
  RetryableError,
  NonRetryableError,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
