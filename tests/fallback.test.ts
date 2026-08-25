import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyFallback, sanitizeFile } from "../src/index.js";
import type { MetadataError } from "../src/index.js";
import { metadataWebp } from "./fixtures.js";

const admissionDecline = Object.freeze({
  code: "unsupported-format" as const,
  detail: "The source is not supported natively.",
  path: "/tmp/source.webp",
  phase: "admission" as const,
  nativeWrite: "not-started" as const,
}) satisfies MetadataError;

describe("classifyFallback", () => {
  it("authorizes only a deliberate pre-write admission decline", () => {
    expect(classifyFallback(admissionDecline)).toBe("safe-to-fallback");
  });

  it("derives authority from proof fields rather than diagnostics", () => {
    const diagnostics = [
      admissionDecline,
      {
        ...admissionDecline,
        code: "unsafe-structure" as const,
        detail:
          "Unrelated warning text and an extension cannot decide fallback.",
        path: "/tmp/source.any-extension",
      },
      {
        ...admissionDecline,
        code: "unsupported-feature" as const,
        feature: "color-profile-preservation" as const,
        reason: "invalid" as const,
      },
    ] satisfies readonly MetadataError[];

    expect(diagnostics.map(classifyFallback)).toEqual([
      "safe-to-fallback",
      "safe-to-fallback",
      "safe-to-fallback",
    ]);
  });

  it("fails closed for incomplete, terminal, and future proof combinations", () => {
    const errors = [
      { ...admissionDecline, phase: "request" as const },
      { ...admissionDecline, nativeWrite: "started" as const },
      {
        code: "invalid-options" as const,
        detail: "Invalid request.",
        phase: "request" as const,
        nativeWrite: "not-started" as const,
      },
      {
        ...admissionDecline,
        phase: "future" as never,
        nativeWrite: "unknown" as never,
      },
    ] satisfies readonly MetadataError[];

    expect(errors.map(classifyFallback)).toEqual([
      "do-not-fallback",
      "do-not-fallback",
      "do-not-fallback",
      "do-not-fallback",
    ]);
  });

  it("is repeatable and mutation-free for concurrent callers", async () => {
    const snapshot = JSON.stringify(admissionDecline);
    const dispositions = await Promise.all(
      Array.from({ length: 32 }, () =>
        Promise.resolve(classifyFallback(admissionDecline)),
      ),
    );

    expect(dispositions).toEqual(Array(32).fill("safe-to-fallback"));
    expect(JSON.stringify(admissionDecline)).toBe(snapshot);
    expect(Object.isFrozen(admissionDecline)).toBe(true);
  });

  it("records fallback proof truthfully before and after native admission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exifcleaner-fallback-"));
    const sourcePath = join(directory, "source.data");
    const destinationPath = join(directory, "clean.webp");
    await writeFile(sourcePath, "not a WebP file");

    try {
      const admission = await sanitizeFile({
        sourcePath,
        destinationPath,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
      });
      const invalidRequest = await sanitizeFile(null as never);

      expect(admission).toMatchObject({
        ok: false,
        error: { phase: "admission", nativeWrite: "not-started" },
      });
      expect(invalidRequest).toMatchObject({
        ok: false,
        error: { phase: "request", nativeWrite: "not-started" },
      });
      if (!admission.ok)
        expect(classifyFallback(admission.error)).toBe("safe-to-fallback");
      if (!invalidRequest.ok)
        expect(classifyFallback(invalidRequest.error)).toBe("do-not-fallback");
      expect(await readdir(directory)).toEqual(["source.data"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for source, cancellation, and destination collision terminals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exifcleaner-fallback-"));
    const sourcePath = join(directory, "source.webp");
    const destinationPath = join(directory, "clean.webp");
    const missingPath = join(directory, "missing.webp");
    await writeFile(sourcePath, metadataWebp());

    try {
      const missing = await sanitizeFile({
        sourcePath: missingPath,
        destinationPath,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
      });
      const controller = new AbortController();
      controller.abort();
      const cancelled = await sanitizeFile({
        sourcePath,
        destinationPath,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
        signal: controller.signal,
      });
      await writeFile(destinationPath, "pre-existing destination");
      const collision = await sanitizeFile({
        sourcePath,
        destinationPath,
        preserveOrientation: false,
        preserveColorProfile: false,
        preserveTimestamps: false,
      });

      expect(missing).toMatchObject({
        ok: false,
        error: { phase: "source-open", nativeWrite: "not-started" },
      });
      expect(cancelled).toMatchObject({
        ok: false,
        error: { phase: "request", nativeWrite: "not-started" },
      });
      expect(collision).toMatchObject({
        ok: false,
        error: { phase: "transaction", nativeWrite: "not-started" },
      });
      for (const result of [missing, cancelled, collision]) {
        if (!result.ok)
          expect(classifyFallback(result.error)).toBe("do-not-fallback");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
