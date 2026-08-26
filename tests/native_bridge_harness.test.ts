import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const harness = join(packageRoot, "scripts", "test_native_bridge.cjs");

describe("native publication bridge", () => {
  it("publishes once and preserves a competitor-created destination", async () => {
    const result = await execFileAsync(process.execPath, [harness], {
      cwd: packageRoot,
    });

    expect(`${result.stdout}${result.stderr}`).toContain(
      "Native publication bridge passed",
    );
  });
});
