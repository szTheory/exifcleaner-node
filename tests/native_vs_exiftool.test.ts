// Unit tests for scripts/qualification/native-vs-exiftool.cjs (62.1-12, D-30,
// QUA-05). No real ExifTool: the session protocol runs against
// tests/support/fake-exiftool.cjs. The file name deliberately has no
// "benchmark" token; this is a cheap unit test, not a full-scope benchmark.
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(
  packageRoot,
  "scripts",
  "qualification",
  "native-vs-exiftool.cjs",
);
const fakeExifToolPath = join(
  packageRoot,
  "tests",
  "support",
  "fake-exiftool.cjs",
);

interface Session {
  sanitize(source: string, destination: string): Promise<number>;
  version(): Promise<string>;
  close(): Promise<{ code: number | null; signal: string | null }>;
}
const script = require(scriptPath) as {
  openExifToolSession(options: { command: string[] }): Session;
};

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "native-vs-exiftool-test-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("native-vs-exiftool stay_open session", () => {
  it("times one file through one persistent session and closes it cleanly", async () => {
    await withTempDir(async (dir) => {
      const source = join(dir, "source.heic");
      const destination = join(dir, "destination.heic");
      await writeFile(source, Buffer.from("not really a heic"));
      const session = script.openExifToolSession({
        command: [process.execPath, fakeExifToolPath],
      });
      expect(await session.version()).toBe("13.59");
      const elapsed = await session.sanitize(source, destination);
      expect(elapsed).toBeGreaterThan(0);
      expect(existsSync(destination)).toBe(true);
      expect(readFileSync(destination)).toEqual(readFileSync(source));
      expect(await session.close()).toEqual({ code: 0, signal: null });
    });
  });
});
