// SEC-06 (68-03, D-06/D-07): the ISOBMFF output verifier must not share the writer's minimal-Exif
// tag-set rule. A shared function between writer and verifier lets one mistake pass both, which is
// the failure mode SEC-06 names. Three controls:
//
//  1. a static guard (TypeScript compiler API) that `src/isobmff/verify.ts` has no import,
//     export-from or dynamic import resolving to `plan` or `writer`, with its own negative control
//     on temp-directory copies of verify.ts with the import restored;
//  2. a poisoned-export test: `vi.mock` replaces `computeIsobmffMinimalExifTags` on plan.js by a
//     faulty one. The writer reaches that function through a module-local binding a mock cannot
//     reach, so only a verifier importing it can be fooled (RED on f6e8f3d, RESEARCH C1);
//  3. a wrapped-planner fault: a registry-seam handler hands the real planner an admission with the
//     source resolution removed while the verifier gets the real admission; the writer's output is
//     wrong and the independent verifier must refuse it (permanent writer-error negative control).
// Held on TypeScript 6.x: TS 7.0 drops the JS Compiler API (see public_contract.test.ts).
import * as ts from "typescript";
import {
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormatAdmission } from "../src/admission/handler.js";
import type { RegisteredHandler } from "../src/admission/registry.js";
import { setRegisteredHandlersForTests } from "../src/admission/registry.js";
import { sanitizeFile } from "../src/engine.js";
import { admitIsobmff } from "../src/isobmff/admission.js";
import type { IsobmffAdmission } from "../src/isobmff/admission.js";
import type { MinimalExifTags } from "../src/metadata/exif.js";
import { createMinimalExif, readIfd0Resolution } from "../src/metadata/exif.js";
import { assembleHeif } from "./isobmff-support/hostile.js";
import { createIsobmffWriterHandlerForTests } from "./isobmff-support/test-handler.js";
import {
  inventoryIsobmff,
  readItemExtentBytes,
} from "./isobmff-support/inventory.js";

type TagsFault = (
  real: MinimalExifTags | undefined,
) => MinimalExifTags | undefined;

const planMock = vi.hoisted(() => ({
  fault: undefined as TagsFault | undefined,
}));

vi.mock("../src/isobmff/plan.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/isobmff/plan.js")>();
  return {
    ...actual,
    computeIsobmffMinimalExifTags: (
      ...args: Parameters<typeof actual.computeIsobmffMinimalExifTags>
    ) => {
      const real = actual.computeIsobmffMinimalExifTags(...args);
      return planMock.fault === undefined ? real : planMock.fault(real);
    },
  };
});

const SRC_ISOBMFF = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "src",
  "isobmff",
);
const VERIFY_PATH = join(SRC_ISOBMFF, "verify.ts");

/** Every module specifier verify-style imports can carry: import declarations, export-from
 * declarations and dynamic `import("...")` calls with a string literal argument. */
function importSpecifiers(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      specifiers.push((node.arguments[0] as ts.StringLiteral).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

/** The specifiers resolving to the writer's own modules: the last path segment, minus `.js` or
 * `.ts`, is `plan` or `writer`. */
function writerSideSpecifiers(sourceText: string, fileName: string): string[] {
  return importSpecifiers(sourceText, fileName).filter((specifier) => {
    const last = specifier.split("/").pop() ?? "";
    const base = last.replace(/\.(js|ts)$/u, "");
    return base === "plan" || base === "writer";
  });
}

const directories: string[] = [];
afterEach(async () => {
  planMock.fault = undefined;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "exifcleaner-verifier-indep-"),
  );
  directories.push(directory);
  return directory;
}

/** verify.ts with any static plan/writer import line removed, so each negative control starts from
 * a copy the guard accepts and flags only what the control itself restores. */
async function cleanVerifyText(): Promise<string> {
  const text = await readFile(VERIFY_PATH, "utf8");
  return text.replace(/^import [^;]*from "\.\/(plan|writer)\.js";\n/gmu, "");
}

describe("SEC-06 guard 1: verify.ts import tree is flat of plan and writer", () => {
  it("verify.ts has no import, export-from or dynamic import of plan or writer", async () => {
    const text = await readFile(VERIFY_PATH, "utf8");
    // The helper must see imports at all (a broken helper would pass vacuously).
    expect(importSpecifiers(text, VERIFY_PATH)).toContain(
      "../metadata/exif.js",
    );
    expect(writerSideSpecifiers(text, VERIFY_PATH)).toEqual([]);
  });

  it("negative control: a temp copy of verify.ts with the static plan import restored is flagged", async () => {
    const text = await cleanVerifyText();
    const directory = await freshDirectory();
    const copyPath = join(directory, "verify.ts");
    await writeFile(
      copyPath,
      `import { computeIsobmffMinimalExifTags } from "./plan.js";\n${text}`,
    );
    const copy = await readFile(copyPath, "utf8");
    expect(writerSideSpecifiers(copy, copyPath)).toEqual(["./plan.js"]);
  });

  it("negative control: a temp copy with a dynamic import of ./writer.js and an export-from plan is flagged", async () => {
    const text = await cleanVerifyText();
    const directory = await freshDirectory();
    const copyPath = join(directory, "verify.ts");
    await writeFile(
      copyPath,
      `${text}\nexport async function lateWriter() { return import("./writer.js"); }\n` +
        `export { buildIsobmffOutputPlan } from "./plan";\n`,
    );
    const copy = await readFile(copyPath, "utf8");
    expect(writerSideSpecifiers(copy, copyPath)).toEqual([
      "./writer.js",
      "./plan",
    ]);
  });

  it("negative control: unrelated specifiers and comments mentioning plan are not flagged", () => {
    const source =
      `// import { x } from "./plan.js";\n` +
      `import { y } from "./planner-notes.js";\n` +
      `import { z } from "../metadata/exif.js";\n`;
    expect(writerSideSpecifiers(source, "synthetic.ts")).toEqual([]);
  });
});

function resolutionOf(x: number, y: number) {
  return {
    x: { numerator: x, denominator: 1 },
    y: { numerator: y, denominator: 1 },
    unit: 2,
  };
}

const PRIMARY_PAYLOAD = Buffer.from("primary-bytes", "ascii");
const SOURCE_TAGS: MinimalExifTags = {
  orientation: 3,
  resolution: resolutionOf(200, 100),
};

/** A HEIC with one primary `hvc1` item and one hidden Exif item (id 2, `cdsc` to the primary)
 * carrying orientation 3 and a 200x100 resolution at unit 2. `twoPass` resolves real offsets. */
function buildExifFixture(): Buffer {
  const exifPayload = Buffer.concat([
    Buffer.alloc(4),
    createMinimalExif(SOURCE_TAGS),
  ]);
  return assembleHeif({
    primaryItemId: 1,
    items: [
      {
        itemId: 1,
        itemType: "hvc1",
        extents: [{ relOffset: 0, length: PRIMARY_PAYLOAD.length }],
      },
      {
        itemId: 2,
        itemType: "Exif",
        hidden: true,
        extents: [
          { relOffset: PRIMARY_PAYLOAD.length, length: exifPayload.length },
        ],
      },
    ],
    refs: [{ type: "cdsc", fromItemId: 2, toItemIds: [1] }],
    mdatPayload: Buffer.concat([PRIMARY_PAYLOAD, exifPayload]),
    ilocWidths: { offsetSize: 4, lengthSize: 4, baseOffsetSize: 4 },
    twoPass: true,
  });
}

const FLAGS = {
  preserveOrientation: true,
  preserveColorProfile: true,
  preserveTimestamps: false,
  preserveResolution: true,
} as const;

async function writeSource(bytes: Buffer) {
  const directory = await freshDirectory();
  const sourcePath = join(directory, "source.heic");
  await writeFile(sourcePath, bytes);
  return {
    directory,
    sourcePath,
    destinationPath: join(directory, "destination.heic"),
  };
}

describe("SEC-06 guard 2: a poisoned plan.js export does not reach the verifier", () => {
  const FAULTS: readonly (readonly [string, TagsFault])[] = [
    [
      "drops the resolution",
      (real) =>
        real === undefined ? real : { orientation: real.orientation! },
    ],
    [
      "drops the orientation",
      (real) => (real === undefined ? real : { resolution: real.resolution! }),
    ],
    [
      "swaps the orientation value 3 for 6",
      (real) => (real === undefined ? real : { ...real, orientation: 6 }),
    ],
  ];

  it.each(FAULTS)(
    "the faulty export that %s leaves sanitizeFile ok with the correct tags written",
    async (_name, fault) => {
      const bytes = buildExifFixture();
      const { directory, sourcePath, destinationPath } =
        await writeSource(bytes);
      const restore = setRegisteredHandlersForTests([
        createIsobmffWriterHandlerForTests("heic"),
      ]);
      planMock.fault = fault;
      try {
        const sanitized = await sanitizeFile({
          sourcePath,
          destinationPath,
          ...FLAGS,
        });
        expect(
          sanitized.ok,
          sanitized.ok ? "ok" : JSON.stringify(sanitized.error),
        ).toBe(true);
        if (!sanitized.ok) throw new Error("unreachable");

        expect((await readdir(directory)).sort()).toEqual([
          "destination.heic",
          "source.heic",
        ]);
        const destinationBytes = await readFile(destinationPath);
        const inventory = inventoryIsobmff(destinationBytes);
        const exifItem = inventory.items.find((item) => item.id === 2)!;
        const payload = readItemExtentBytes(
          destinationBytes,
          inventory,
          exifItem,
        );
        // The writer used its own module-local rule, so the output is the correct one.
        expect(
          payload.equals(
            Buffer.concat([Buffer.alloc(4), createMinimalExif(SOURCE_TAGS)]),
          ),
        ).toBe(true);
        expect(readIfd0Resolution(payload.subarray(4))).toEqual(
          resolutionOf(200, 100),
        );
        const handle = await open(destinationPath, "r");
        try {
          const admission = await admitIsobmff(handle, destinationBytes.length);
          expect(admission.orientation).toEqual({ status: "valid", value: 3 });
        } finally {
          await handle.close();
        }
        expect((await readFile(sourcePath)).equals(bytes)).toBe(true);
      } finally {
        planMock.fault = undefined;
        restore();
      }
    },
  );

  it("control: with no fault installed the same request succeeds", async () => {
    const bytes = buildExifFixture();
    const { sourcePath, destinationPath } = await writeSource(bytes);
    const restore = setRegisteredHandlersForTests([
      createIsobmffWriterHandlerForTests("heic"),
    ]);
    try {
      const sanitized = await sanitizeFile({
        sourcePath,
        destinationPath,
        ...FLAGS,
      });
      expect(sanitized.ok).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("SEC-06 control 3: a wrapped planner fault is caught by the independent verifier", () => {
  it("a planner that loses the source resolution is refused: verification-failed, nothing published, source preserved", async () => {
    const bytes = buildExifFixture();
    const { directory, sourcePath, destinationPath } = await writeSource(bytes);
    const inner = createIsobmffWriterHandlerForTests("heic");
    const faulty: RegisteredHandler = Object.freeze({
      ...inner,
      buildOutputPlan(
        admission: FormatAdmission,
        preserveOrientation: boolean,
        preserveColorProfile: boolean,
        preserveResolution: boolean,
        orientation: number | undefined,
      ): unknown {
        // Only the planner sees the damaged admission; the verifier is handed the real one.
        const damaged: IsobmffAdmission = {
          ...(admission as IsobmffAdmission),
          sourceResolution: undefined,
        };
        return inner.buildOutputPlan(
          damaged,
          preserveOrientation,
          preserveColorProfile,
          preserveResolution,
          orientation,
        );
      },
    });
    const restore = setRegisteredHandlersForTests([faulty]);
    try {
      const sanitized = await sanitizeFile({
        sourcePath,
        destinationPath,
        ...FLAGS,
      });
      expect(sanitized.ok).toBe(false);
      if (sanitized.ok) throw new Error("unreachable");
      expect(sanitized.error.code).toBe("verification-failed");
      // Nothing published: the directory holds the source and at most the unpublished staging file.
      const listing = await readdir(directory);
      expect(listing).toContain("source.heic");
      expect(listing).not.toContain("destination.heic");
      for (const entry of listing) {
        if (entry === "source.heic") continue;
        expect(entry.startsWith(".exifcleaner-stage-")).toBe(true);
      }
      expect((await readFile(sourcePath)).equals(bytes)).toBe(true);
    } finally {
      restore();
    }
  });
});
