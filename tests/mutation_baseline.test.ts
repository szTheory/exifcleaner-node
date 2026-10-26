// MUT-02/MUT-03 baseline driver: selection and aggregation (D-11, D-14, D-23).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  mutateListForGroup,
  trackedSrc,
  // @ts-expect-error plain ESM tooling script without types
} from "../tools/mutation/baseline.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const floors = JSON.parse(
  readFileSync(join(root, "mutation-floors.json"), "utf8"),
) as { groups: Record<string, unknown> };
const files: string[] = trackedSrc(root);

describe("baseline mutate list", () => {
  it("selects src/io/copy-range.ts for the io group", () => {
    expect(mutateListForGroup("io", floors, files)).toEqual([
      "src/io/copy-range.ts",
    ]);
  });
});
