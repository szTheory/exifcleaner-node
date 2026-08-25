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
});
