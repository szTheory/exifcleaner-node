// ISOBMFF-05 / D-23: a real, measured RSS harness, mirroring `tests/png_memory_child.mjs`
// (PNG D-28). Runs as a standalone child process (never imported by a test file directly) so
// the peak it reports is the admission's own, not the vitest worker's. A separate process is
// necessary but not sufficient: on linux `ru_maxrss` (process.resourceUsage().maxRSS) folds in
// the parent's resident set at fork/exec, so a large vitest worker inflates it. Linux therefore
// reads VmHWM from /proc/self/status (a fresh mm at exec, not inherited); darwin and win32
// report per-process maxRSS. Not collected by vitest.config.ts's `tests/**/*.test.ts` include,
// but is still formatted by `npm run lint` (prettier globs all of `tests/`).
//
// argv: <fixturePath|--idle> <capMode: default|no-meta|no-count|no-depth|no-buffered>
//
// - fixturePath: an ISOBMFF file to admit. `--idle` skips admission entirely (the unit-sanity
//   baseline: a child that does nothing but import dist/isobmff/{admission,caps}.js and report
//   its own resident memory).
// - capMode: "default" passes `admitIsobmff` the real, unmodified `DEFAULT_ISOBMFF_CAPS`. Every
//   other mode injects a caps object equal to the default except for exactly one field set to
//   `Number.POSITIVE_INFINITY` -- the D-23 negative control proving the matching cap
//   discriminates when it alone is removed:
//     no-meta     -> maxMetaBytes: Infinity
//     no-count    -> maxBoxCount: Infinity
//     no-depth    -> maxBoxDepth: Infinity
//     no-buffered -> maxBufferedBytesTotal: Infinity
//
// Prints exactly one JSON line to stdout:
//   { outcome: "admitted" | "error" | "crash", declineClass, kind, errorName, maxRssBytes, peakSource }
// maxRssBytes is this process's own peak in bytes and peakSource names where it came from:
// "VmHWM" (linux, /proc/self/status kB * 1024; the harness fails with exit 2 if it cannot be
// read, never falling back to maxRSS) or "resourceUsage.maxRSS" (every other platform; Node
// documents maxRSS in kilobytes). The idle sanity tests in isobmff_memory.test.ts assert the
// source for the platform and a wide, units-mistake-revealing 16 MiB-256 MiB band.
//
// "error" means `admitIsobmff` rejected with a real `IsobmffStructureError` (`declineClass`/
// `kind` recorded, matching the thrown error's own fields). "crash" means it rejected with any
// OTHER kind of throw -- most notably a `RangeError` ("Maximum call stack size exceeded") from
// the no-depth negative control, where removing the depth cap can exhaust the JS call stack
// instead of (or as well as) growing RSS; see isobmff_memory.test.ts and docs/isobmff.md
// "## Memory caps" for which outcome this repo's `no-depth` fixture actually measures.
//
// Exit code is 0 for every completed run (admitted, error, or crash alike) -- the JSON line's
// "outcome" field carries the result. Exit code 2 means the harness itself failed before it
// could measure anything (bad argv, unreadable fixture) -- distinct from a successful "crash"
// outcome so a test failure is never confused with a harness bug.

import { readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";

function fail(message) {
  process.stderr.write(`isobmff_memory_child: ${message}\n`);
  process.exit(2);
}

const [fixtureArg, capModeArg] = process.argv.slice(2);

const CAP_MODES = new Set([
  "default",
  "no-meta",
  "no-count",
  "no-depth",
  "no-buffered",
]);

if (fixtureArg === undefined) {
  fail("missing argv[0]: <fixturePath|--idle>");
}
if (!CAP_MODES.has(capModeArg)) {
  fail(
    `invalid cap mode ${JSON.stringify(capModeArg)}: expected one of ${[...CAP_MODES].join(", ")}`,
  );
}

const admissionPath = fileURLToPath(
  new URL("../dist/isobmff/admission.js", import.meta.url),
);
const capsPath = fileURLToPath(
  new URL("../dist/isobmff/caps.js", import.meta.url),
);

let admitIsobmff;
let DEFAULT_ISOBMFF_CAPS;
try {
  ({ admitIsobmff } = await import(admissionPath));
  ({ DEFAULT_ISOBMFF_CAPS } = await import(capsPath));
} catch (error) {
  fail(
    `failed to import dist/isobmff: ${error && error.message ? error.message : String(error)}`,
  );
}

function capsFor(mode) {
  switch (mode) {
    case "no-meta":
      return {
        ...DEFAULT_ISOBMFF_CAPS,
        maxMetaBytes: Number.POSITIVE_INFINITY,
      };
    case "no-count":
      return {
        ...DEFAULT_ISOBMFF_CAPS,
        maxBoxCount: Number.POSITIVE_INFINITY,
      };
    case "no-depth":
      return {
        ...DEFAULT_ISOBMFF_CAPS,
        maxBoxDepth: Number.POSITIVE_INFINITY,
      };
    case "no-buffered":
      return {
        ...DEFAULT_ISOBMFF_CAPS,
        maxBufferedBytesTotal: Number.POSITIVE_INFINITY,
      };
    default:
      return DEFAULT_ISOBMFF_CAPS;
  }
}

let outcome = "admitted";
let declineClass;
let kind;
let errorName;

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
    await admitIsobmff(handle, size, undefined, capsFor(capModeArg));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "kind" in error &&
      "declineClass" in error
    ) {
      outcome = "error";
      kind = error.kind;
      declineClass = error.declineClass;
    } else {
      outcome = "crash";
      errorName = error && error.name ? error.name : "Unknown";
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
  JSON.stringify({
    outcome,
    declineClass,
    kind,
    errorName,
    maxRssBytes,
    peakSource,
  }) + "\n",
);
