import { describe, expect, it } from "vitest";
import { classifyFallback } from "../src/index.js";
import type { MetadataError } from "../src/index.js";

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
        detail: "Unrelated warning text and an extension cannot decide fallback.",
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
      { code: "invalid-options" as const, detail: "Invalid request." },
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
});
