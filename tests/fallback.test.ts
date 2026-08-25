import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyFallback, sanitizeFile } from "../src/index.js";
import type { FallbackDisposition, MetadataError } from "../src/index.js";
import { metadataWebp } from "./fixtures.js";

function metadataError<T extends MetadataError>(error: T): T {
  return error;
}

const admissionDecline = Object.freeze(
  metadataError({
    code: "unsupported-format",
    detail: "The source is not supported natively.",
    path: "/tmp/source.webp",
    phase: "admission",
    nativeWrite: "not-started",
  }),
);

const allMetadataErrors = [
  metadataError({
    code: "aborted",
    detail: "Cancelled.",
    phase: "request",
    nativeWrite: "not-started",
  }),
  metadataError({
    code: "invalid-options",
    detail: "Invalid request.",
    phase: "request",
    nativeWrite: "not-started",
  }),
  metadataError({
    code: "not-found",
    detail: "Missing source.",
    path: "/tmp/missing.webp",
    cause: { code: "ENOENT", message: "missing" },
    phase: "source-open",
    nativeWrite: "not-started",
  }),
  admissionDecline,
  metadataError({
    code: "malformed-file",
    detail: "Malformed source.",
    path: "/tmp/source.weird",
    phase: "admission",
    nativeWrite: "not-started",
  }),
  metadataError({
    code: "unsafe-structure",
    detail: "Unsafe source.",
    path: "/tmp/source.webp",
    phase: "admission",
    nativeWrite: "not-started",
  }),
  metadataError({
    code: "unsupported-feature",
    detail: "Orientation cannot be retained.",
    path: "/tmp/source.webp",
    feature: "orientation-preservation",
    phase: "admission",
    nativeWrite: "not-started",
  }),
  metadataError({
    code: "unsupported-feature",
    detail: "Color profile cannot be retained.",
    path: "/tmp/source.webp",
    feature: "color-profile-preservation",
    reason: "policy-limit",
    phase: "admission",
    nativeWrite: "not-started",
  }),
  metadataError({
    code: "source-changed",
    detail: "Source changed.",
    path: "/tmp/source.webp",
    phase: "transaction",
    nativeWrite: "started",
  }),
  metadataError({
    code: "destination-exists",
    detail: "Destination exists.",
    path: "/tmp/clean.webp",
    cause: { message: "EEXIST" },
    phase: "transaction",
    nativeWrite: "not-started",
  }),
  metadataError({
    code: "destination-changed",
    detail: "Destination changed.",
    path: "/tmp/clean.webp",
    phase: "transaction",
    nativeWrite: "started",
  }),
  metadataError({
    code: "read-failed",
    detail: "Read failed.",
    path: "/tmp/source.webp",
    cause: { message: "EIO" },
    phase: "transaction",
    nativeWrite: "started",
  }),
  metadataError({
    code: "write-failed",
    detail: "Write failed.",
    path: "/tmp/clean.webp",
    cause: { message: "ENOSPC" },
    phase: "transaction",
    nativeWrite: "started",
  }),
  metadataError({
    code: "verification-failed",
    detail: "Verification failed.",
    path: "/tmp/clean.webp",
    cause: { message: "mismatch" },
    phase: "transaction",
    nativeWrite: "started",
  }),
  metadataError({
    code: "cleanup-failed",
    detail: "Cleanup failed.",
    path: "/tmp/clean.webp",
    cause: { message: "EPERM" },
    phase: "transaction",
    nativeWrite: "started",
  }),
] as const;

type ListedCode = (typeof allMetadataErrors)[number]["code"];
type MissingMetadataErrorCode = Exclude<MetadataError["code"], ListedCode>;
const allMetadataErrorCodesAreClassified: MissingMetadataErrorCode extends never
  ? true
  : never = true;

type ListedUnsupportedFeature = Extract<
  (typeof allMetadataErrors)[number],
  { readonly code: "unsupported-feature" }
>["feature"];
type MissingUnsupportedFeature = Exclude<
  Extract<MetadataError, { readonly code: "unsupported-feature" }>["feature"],
  ListedUnsupportedFeature
>;
const allUnsupportedFeaturesAreClassified: MissingUnsupportedFeature extends never
  ? true
  : never = true;

describe("classifyFallback", () => {
  it("keeps every finalization residue terminal and pure", async () => {
    const terminalErrors = [
      metadataError({
        code: "write-failed",
        detail: "Write failed.",
        path: "/tmp/clean.webp",
        phase: "transaction",
        nativeWrite: "started",
        finalization: { state: "owned-partial-removed" },
      }),
      metadataError({
        code: "write-failed",
        detail: "Write failed.",
        path: "/tmp/clean.webp",
        phase: "transaction",
        nativeWrite: "started",
        finalization: { state: "already-missing" },
      }),
      metadataError({
        code: "write-failed",
        detail: "Write failed.",
        path: "/tmp/clean.webp",
        phase: "transaction",
        nativeWrite: "started",
        finalization: { state: "replaced-and-left-untouched" },
      }),
      metadataError({
        code: "write-failed",
        detail: "Write failed.",
        path: "/tmp/clean.webp",
        phase: "transaction",
        nativeWrite: "started",
        finalization: {
          state: "owned-partial-remains",
          cause: { code: "EPERM", message: "denied" },
        },
      }),
    ] as const;
    const snapshots = terminalErrors.map((error) => JSON.stringify(error));

    const dispositions = await Promise.all(
      Array.from({ length: 16 }, () =>
        Promise.all(terminalErrors.map(classifyFallback)),
      ),
    );

    expect(dispositions.flat()).toEqual(Array(64).fill("do-not-fallback"));
    expect(terminalErrors.map((error) => JSON.stringify(error))).toEqual(
      snapshots,
    );
  });

  it("classifies every current MetadataError variant and every public proof pairing", () => {
    expect(allMetadataErrorCodesAreClassified).toBe(true);
    expect(allUnsupportedFeaturesAreClassified).toBe(true);
    expect(
      allMetadataErrors.map((error) => ({
        code: error.code,
        disposition: classifyFallback(error),
      })),
    ).toEqual([
      { code: "aborted", disposition: "do-not-fallback" },
      { code: "invalid-options", disposition: "do-not-fallback" },
      { code: "not-found", disposition: "do-not-fallback" },
      { code: "unsupported-format", disposition: "safe-to-fallback" },
      { code: "malformed-file", disposition: "safe-to-fallback" },
      { code: "unsafe-structure", disposition: "safe-to-fallback" },
      { code: "unsupported-feature", disposition: "safe-to-fallback" },
      { code: "unsupported-feature", disposition: "safe-to-fallback" },
      { code: "source-changed", disposition: "do-not-fallback" },
      { code: "destination-exists", disposition: "do-not-fallback" },
      { code: "destination-changed", disposition: "do-not-fallback" },
      { code: "read-failed", disposition: "do-not-fallback" },
      { code: "write-failed", disposition: "do-not-fallback" },
      { code: "verification-failed", disposition: "do-not-fallback" },
      { code: "cleanup-failed", disposition: "do-not-fallback" },
    ]);

    const proofVariants = [
      ["request", "not-started", "do-not-fallback"],
      ["request", "started", "do-not-fallback"],
      ["source-open", "not-started", "do-not-fallback"],
      ["source-open", "started", "do-not-fallback"],
      ["admission", "not-started", "safe-to-fallback"],
      ["admission", "started", "do-not-fallback"],
      ["transaction", "not-started", "do-not-fallback"],
      ["transaction", "started", "do-not-fallback"],
    ] as const satisfies readonly (readonly [
      MetadataError["phase"],
      MetadataError["nativeWrite"],
      FallbackDisposition,
    ])[];

    for (const [phase, nativeWrite, disposition] of proofVariants) {
      expect(
        classifyFallback(
          metadataError({ ...admissionDecline, phase, nativeWrite }),
        ),
      ).toBe(disposition);
    }
  });

  it("authorizes only a deliberate pre-write admission decline", () => {
    expect(classifyFallback(admissionDecline)).toBe("safe-to-fallback");
  });

  it("derives authority from proof fields rather than diagnostics", () => {
    const diagnostics = [
      admissionDecline,
      metadataError({
        ...admissionDecline,
        code: "unsafe-structure",
        detail:
          "Unrelated warning text and an extension cannot decide fallback.",
        path: "/tmp/source.any-extension",
      }),
      metadataError({
        ...admissionDecline,
        code: "unsupported-feature",
        feature: "color-profile-preservation",
        reason: "invalid",
      }),
    ] as const satisfies readonly MetadataError[];

    expect(diagnostics.map(classifyFallback)).toEqual([
      "safe-to-fallback",
      "safe-to-fallback",
      "safe-to-fallback",
    ]);
  });

  it("fails closed for incomplete, terminal, and future proof combinations", () => {
    const errors = [
      metadataError({ ...admissionDecline, phase: "request" }),
      metadataError({ ...admissionDecline, nativeWrite: "started" }),
      metadataError({
        code: "invalid-options",
        detail: "Invalid request.",
        phase: "request",
        nativeWrite: "not-started",
      }),
      {
        ...admissionDecline,
        phase: "future" as never,
        nativeWrite: "unknown" as never,
      },
    ] as const satisfies readonly MetadataError[];

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

  it("ignores code-compatible diagnostics and exposes only the locked binary vocabulary", async () => {
    const variants = [
      metadataError({
        ...admissionDecline,
        detail: "Different detail.",
        path: "/tmp/renamed.data",
      }),
      metadataError({
        ...admissionDecline,
        detail: "Different detail.",
        path: "/tmp/renamed.data",
        code: "malformed-file",
      }),
      metadataError({
        ...admissionDecline,
        detail: "Different detail.",
        path: "/tmp/renamed.data",
        code: "unsupported-feature",
        feature: "orientation-preservation",
      }),
    ].map((error) => Object.freeze(error));
    const snapshots = variants.map((error) => JSON.stringify(error));
    const outcomes = await Promise.all(
      Array.from({ length: 16 }, () =>
        Promise.all(variants.map(classifyFallback)),
      ),
    );
    const [declaration, readme, capabilities] = await Promise.all([
      readFile(new URL("../dist/types.d.ts", import.meta.url), "utf8"),
      readFile(new URL("../README.md", import.meta.url), "utf8"),
      readFile(new URL("../docs/capabilities.md", import.meta.url), "utf8"),
    ]);

    expect(outcomes.flat()).toEqual(Array(48).fill("safe-to-fallback"));
    expect(variants.map((error) => JSON.stringify(error))).toEqual(snapshots);
    expect(variants.every(Object.isFrozen)).toBe(true);
    expect(`${declaration}\n${readme}\n${capabilities}`).not.toMatch(
      /retryable/i,
    );
    expect([
      "safe-to-fallback",
      "do-not-fallback",
    ] satisfies FallbackDisposition[]).toHaveLength(2);
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
