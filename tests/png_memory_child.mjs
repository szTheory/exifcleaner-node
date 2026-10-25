// PNG-05 / D-28: a real, measured RSS harness for the memory-bound proof. Runs as a
// standalone child process (never imported by a test file directly) so the peak it reports
// is the parser's own, not the vitest worker's. A separate process is necessary but not
// sufficient: on linux `ru_maxrss` (process.resourceUsage().maxRSS) folds in the parent's
// resident set at fork/exec, so a large vitest worker inflates it. Linux therefore reads
// VmHWM from /proc/self/status (a fresh mm at exec, not inherited); darwin and win32 report
// per-process maxRSS. Not collected by vitest.config.ts's `tests/**/*.test.ts` include,
// but is still formatted by `npm run lint` (prettier globs all of `tests/`).
//
// argv: <fixturePath|--idle> <budgetMode: default|infinity> <retainMode: default|view>
//
// - fixturePath: a PNG file to parse. `--idle` skips parsing entirely (the unit-sanity
//   baseline: a child that does nothing but import dist/png/chunks.js and report its own
//   resident memory).
// - budgetMode: "default" passes parsePng's own default BufferedBudget (the real 48 MiB
//   aggregate cap); "infinity" injects `new BufferedBudget(Number.POSITIVE_INFINITY)`, the
//   D-28 negative control that proves the ceiling discriminates when the cap is removed.
// - retainMode: "default" passes parsePng's own default retain (copyWindowedChunk, the real
//   copy-on-buffer fix); "view" injects the identity `(view) => view`, the D-28 negative
//   control that proves the ceiling discriminates when the window-copy fix is removed.
//
// Prints exactly one JSON line to stdout:
//   { outcome: "parsed" | "error", kind, limit, maxRssBytes, peakSource }
// maxRssBytes is this process's own peak in bytes and peakSource names where it came from:
// "VmHWM" (linux, /proc/self/status kB * 1024; the harness fails with exit 2 if it cannot be
// read, never falling back to maxRSS) or "resourceUsage.maxRSS" (every other platform; Node
// documents maxRSS in kilobytes). The idle sanity tests in png_memory.test.ts assert the
// source for the platform and a wide, units-mistake-revealing 16 MiB-256 MiB band.
//
// Exit code is 0 for every completed run (parsed or a caught PngStructureError alike) --
// the JSON line's "outcome" field carries the result. Exit code 2 means the harness itself
// failed before it could measure anything (bad argv, unreadable fixture, an unexpected
// non-PngStructureError throw) -- distinct from a successful "error" outcome so a test
// failure is never confused with a harness bug.

import { readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";

function fail(message) {
  process.stderr.write(`png_memory_child: ${message}\n`);
  process.exit(2);
}

const [fixtureArg, budgetModeArg, retainModeArg] = process.argv.slice(2);

if (fixtureArg === undefined) {
  fail("missing argv[0]: <fixturePath|--idle>");
}
if (budgetModeArg !== "default" && budgetModeArg !== "infinity") {
  fail(
    `invalid budget mode ${JSON.stringify(budgetModeArg)}: expected "default" or "infinity"`,
  );
}
if (retainModeArg !== "default" && retainModeArg !== "view") {
  fail(
    `invalid retain mode ${JSON.stringify(retainModeArg)}: expected "default" or "view"`,
  );
}

const distPath = fileURLToPath(
  new URL("../dist/png/chunks.js", import.meta.url),
);

let parsePng;
let BufferedBudget;
try {
  ({ parsePng, BufferedBudget } = await import(distPath));
} catch (error) {
  fail(
    `failed to import ${distPath}: ${error && error.message ? error.message : String(error)}`,
  );
}

const budget =
  budgetModeArg === "infinity"
    ? new BufferedBudget(Number.POSITIVE_INFINITY)
    : undefined;
const retain = retainModeArg === "view" ? (view) => view : undefined;

let outcome = "parsed";
let kind;
let limit;

if (fixtureArg !== "--idle") {
  let handle;
  let size;
  try {
    handle = await open(fixtureArg, "r");
    ({ size } = await handle.stat());
  } catch (error) {
    fail(
      `failed to open fixture ${fixtureArg}: ${error && error.message ? error.message : String(error)}`,
    );
  }
  try {
    await parsePng(handle, size, undefined, budget, retain);
  } catch (error) {
    if (error && typeof error === "object" && "kind" in error) {
      outcome = "error";
      kind = error.kind;
      limit = error.limit;
    } else {
      await handle.close();
      fail(
        `parsePng threw an unexpected (non-PngStructureError) error: ${error && error.message ? error.message : String(error)}`,
      );
    }
  } finally {
    await handle.close();
  }
}

function ownPeak() {
  if (process.platform === "linux") {
    let status;
    try {
      status = readFileSync("/proc/self/status", "utf8");
    } catch (error) {
      fail(
        `cannot read /proc/self/status: ${error && error.message ? error.message : String(error)}`,
      );
    }
    const match = /^VmHWM:\s+(\d+)\s+kB\s*$/m.exec(status);
    const kilobytes = match === null ? Number.NaN : Number(match[1]);
    if (!Number.isFinite(kilobytes) || kilobytes <= 0) {
      fail("VmHWM missing or unparseable in /proc/self/status");
    }
    return { bytes: kilobytes * 1024, source: "VmHWM" };
  }
  return {
    bytes: process.resourceUsage().maxRSS * 1024,
    source: "resourceUsage.maxRSS",
  };
}

const { bytes: maxRssBytes, source: peakSource } = ownPeak();

process.stdout.write(
  JSON.stringify({ outcome, kind, limit, maxRssBytes, peakSource }) + "\n",
);
