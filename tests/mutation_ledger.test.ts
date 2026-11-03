// MUT-03 survivor ledger checker (D-13, D-18) with fixtures. Every red case
// asserts a specific problem; the passing cases prove the fixtures are valid.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

interface Mutant {
  id: string;
  mutatorName: string;
  replacement?: string;
  status: string;
  statusReason?: string;
  static?: boolean;
  killedBy?: string[];
  coveredBy?: string[];
  location: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}
interface Report {
  files: Record<
    string,
    { language: string; source: string; mutants: Mutant[] }
  >;
  testFiles?: Record<
    string,
    { source: string; tests: { id: string; name: string }[] }
  >;
}
interface Isobmff3ReportBinding {
  canonicalSha256: string;
  variants: {
    rawSha256: string;
    rawBytes: number;
    fixtures: { path: string; gzipSha256: string; gzipBytes: number }[];
  }[];
  successors: {
    oldAnchor: string;
    finalAnchor: string;
    test: { id: string; file: string; name: string; sourceSha256: string };
  }[];
}
interface Cluster {
  id: string;
  originClusterId?: string;
  group: string;
  file: string;
  mutatorName: string;
  function: string;
  disposition: string;
  count: number;
  keys: string[];
  anchors: string[];
  test?: { file: string; name: string };
  symbol?: string;
  equivalenceClass?: string;
  deletion?: Record<string, unknown>;
  note: string;
}
interface Identity {
  mutantKey(file: string, mutant: Mutant): string;
  anchorKey(file: string, mutant: Mutant, source: string): string;
}
interface Survivor {
  group: string;
  key: string;
  anchorKey: string;
  file: string;
  mutatorName: string;
  function: string;
  status?: string;
}
interface Batch {
  id: string;
  group: string;
  clusters: string[];
  mutants: number;
  files: string[];
}
interface ClusterTools {
  enclosingFunction(source: string, line: number): string;
  clusterSurvivors(survivors: Survivor[]): Cluster[];
  partitionBatches(
    clusters: Cluster[],
    limit?: number,
    maxFiles?: number,
  ): Batch[];
}
interface Checker {
  asReport(parsed: unknown): Report;
  checkLedger(input: {
    ledger: { schemaVersion: number; preTriage: unknown; clusters: Cluster[] };
    preReport?: Report | null;
    finalReport?: Report | null;
    root: string;
    groups: Record<string, { tier: string; globs: string[] }>;
    mode: "pre" | "final";
  }): string[];
}
interface DeletionProof {
  functionBounds(
    source: string,
    name: string,
  ): { start: number; end: number; function: string };
  applyEdits(
    source: string,
    edits: {
      operation?: string;
      function: string;
      before: string;
      after: string;
      occurrence: number;
    }[],
  ): { source: string };
  affectedBy(
    mutant: Mutant,
    source: string,
    edits: { start: number; end: number }[],
  ): boolean;
  validateDeletion(input: {
    row: Cluster;
    root: string;
    currentSource: string;
    finalEntry: { source: string; mutants: Mutant[] } | null;
    finalReport: Report & {
      testFiles?: Record<
        string,
        { source: string; tests: { id: string; name: string }[] }
      >;
    };
    readTest(file: string): string;
    survivors: Survivor[];
    requireFinal: boolean;
  }): {
    problems: string[];
    anchors: { current: string; original: string }[];
    removedMutants: { anchor: string; replacement: string; status: string }[];
    auxiliaryMutants: {
      anchor: string;
      replacement: string;
      status: string;
      killedBy: { file: string; name: string }[];
    }[];
  };
  canonicalReceiptJson(value: unknown): string;
  normalizeReceiptSource(source: string): string;
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = dirname(packageRoot);
const builtRoot = dirname(
  resolve(
    packageRoot,
    JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).exports[
      "."
    ].import,
  ),
);
const liveInputPaths = [
  join(packageRoot, "tools", "mutation", "ledger.json"),
  join(packageRoot, "tools", "mutation", "pre-triage-survivors.json"),
  join(
    workspaceRoot,
    ".planning",
    "phases",
    "67-mutation-baseline",
    "67-SURVIVOR-LEDGER.md",
  ),
  join(packageRoot, "src", "isobmff", "admission.ts"),
  join(builtRoot, "isobmff", "admission.js"),
  join(builtRoot, "isobmff", "admission.js.map"),
  join(builtRoot, "isobmff", "admission.d.ts"),
  join(builtRoot, "isobmff", "admission.d.ts.map"),
  join(packageRoot, "package.json"),
  join(packageRoot, "package-lock.json"),
  join(
    packageRoot,
    "tests",
    "fixtures",
    "mutation",
    "admission-deletion-reports.json.gz",
  ),
  join(
    packageRoot,
    "tests",
    "fixtures",
    "mutation",
    "iloc-boundary-reports.json.gz",
  ),
  join(packageRoot, "reports", "triage", "67-14", "node24-green.json"),
  join(packageRoot, "reports", "triage", "67-14", "red.json"),
  join(packageRoot, "reports", "triage", "67-14", "partial-proof.json"),
  join(packageRoot, "reports", "triage", "67-14", "scope-probe.json"),
  join(packageRoot, "reports", "triage", "67-14", "resume", "batch.json"),
  join(packageRoot, "reports", "triage", "67-14", "resume", "red.json"),
  join(packageRoot, "reports", "triage", "67-14", "resume", "scope-probe.json"),
  join(packageRoot, "reports", "triage", "67-49", "admission-final.json"),
].filter(existsSync);
const liveInputBytes = liveInputPaths.map((path) => readFileSync(path));
function expectLiveInputsUnchanged(): void {
  liveInputPaths.forEach((path, index) =>
    expect(
      readFileSync(path).equals(liveInputBytes[index]!),
      `${path}: live bytes changed`,
    ).toBe(true),
  );
}

const cliFiles = [
  "cluster.mjs",
  "groups.mjs",
  "identity.mjs",
  "ledger-check.mjs",
  "disable-lint.mjs",
  "classes.json",
  "deletion-proof.mjs",
];
const load = async <T>(name: string) =>
  (await import(
    pathToFileURL(join(packageRoot, "tools", "mutation", name)).href
  )) as T;
const identity = await load<Identity>("identity.mjs");
const clusterTools = await load<ClusterTools>("cluster.mjs");
const { checkLedger, asReport } = await load<Checker>("ledger-check.mjs");
const deletionProof = await load<DeletionProof>("deletion-proof.mjs");
const { renderLedger } = await load<LedgerSummary>("ledger-summary.mjs");

const groups = {
  g: { tier: "trust", globs: ["src/a/**"] },
  o: { tier: "orchestration", globs: ["src/o/**"] },
};
const SOURCE = "const a = true;\nconst b = true;\n";
const mutant = (
  id: string,
  line: number,
  column: number,
  status: string,
  extra: Partial<Mutant> = {},
): Mutant => ({
  id,
  mutatorName: "BooleanLiteral",
  replacement: "false",
  status,
  location: {
    start: { line, column },
    end: { line, column: column + 4 },
  },
  ...extra,
});
const reportOf = (
  mutants: Mutant[],
  file = "src/a/x.ts",
  source = SOURCE,
): Report => ({
  files: { [file]: { language: "typescript", source, mutants } },
});
const keyOf = (m: Mutant, file = "src/a/x.ts") => identity.mutantKey(file, m);
const cluster = (id: string, over: Partial<Cluster> = {}): Cluster => ({
  id,
  group: "g",
  file: "src/a/x.ts",
  mutatorName: "BooleanLiteral",
  function: "f",
  disposition: "pending",
  count: 0,
  keys: [],
  anchors: [],
  note: "n",
  ...over,
});
const ledgerOf = (clusters: Cluster[]) => ({
  schemaVersion: 1,
  preTriage: null,
  clusters,
});

// Three trust survivors (a first, b second line, a killed control).
const m1 = mutant("1", 1, 11, "Survived");
const m2 = mutant("2", 2, 11, "NoCoverage");
const m3 = mutant("3", 1, 11, "Survived", {
  mutatorName: "ConditionalExpression",
  replacement: "true",
});
const m4 = mutant("4", 2, 11, "Killed", { mutatorName: "EqualityOperator" });
const pre = reportOf([m1, m2, m3, m4]);

const temporaryRoots: string[] = [];
afterEach(() => {
  try {
    expectLiveInputsUnchanged();
  } finally {
    for (const root of temporaryRoots.splice(0))
      rmSync(root, { recursive: true, force: true });
  }
});
afterAll(expectLiveInputsUnchanged);
function tempRoot(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mut-ledger-")));
  temporaryRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

function cliFixture(files: Record<string, string>): string {
  const root = tempRoot(files);
  const mutationDir = join(root, "tools", "mutation");
  mkdirSync(mutationDir, { recursive: true });
  for (const name of cliFiles) {
    const source = join(packageRoot, "tools", "mutation", name);
    if (existsSync(source)) copyFileSync(source, join(mutationDir, name));
  }
  for (const name of ["cluster.mjs", "ledger-check.mjs"]) {
    const copiedScript = realpathSync(join(mutationDir, name));
    expect(copiedScript.startsWith(`${root}${sep}`)).toBe(true);
    expect(realpathSync(join(dirname(copiedScript), "..", ".."))).toBe(root);
  }
  return root;
}

function runFixture(root: string, script: string, ...args: string[]) {
  const path = realpathSync(join(root, "tools", "mutation", script));
  expect(path.startsWith(`${root}${sep}`)).toBe(true);
  return spawnSync(process.execPath, [path, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

const sha256 = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const phaseVerifierPath = join(
  packageRoot,
  "..",
  ".planning",
  "phases",
  "67-mutation-baseline",
  "67-triage-verify.mjs",
);
const phaseVerifier = (await import(pathToFileURL(phaseVerifierPath).href)) as {
  canonicalAnchor(file: string, mutant: Mutant, source: string): string;
  vitestDeclarationStatus(
    source: string,
    name: string,
  ): "declared" | "absent" | "unsupported" | "ambiguous";
  historicalTestAbsentFromBaseline(
    name: string,
    source: string,
    testFile?: string,
    root?: string,
    baselineSha?: string,
    readBaselineFile?: (file: string) => string,
  ): boolean;
  verifyHistoricalTestImportClosure(
    testFile: string,
    source: string,
    root?: string,
    baselineSha?: string,
    readBaselineFile?: (file: string) => string,
  ): boolean;
  reconcileAnchorMappings(
    proofs: { id: string; anchors: { current: string; original: string }[] }[],
  ): Map<string, string>;
  evaluate(input: {
    clusters: Cluster[];
    survivors: Survivor[];
    report: Report & {
      testFiles: Record<
        string,
        { source: string; tests: { id: string; name: string }[] }
      >;
    };
    mode: "batch";
    readTest(file: string): string;
    symbolAbsent(symbol: string): boolean;
    root: string;
    ledgerClusters?: Cluster[];
    selectedFiles?: string[];
  }): { key: string; status: string }[];
};

interface AdmissionReceiptBundle {
  schema: string;
  provenance: {
    beforeReport: { path: string; sha256: string; bytes: number };
    finalReport: { path: string; sha256: string; bytes: number };
    sources: { finalSourceSha256: string };
    tests: { finalTestSources: Record<string, string> };
    originalBatch: {
      members: number;
      previouslyDisposed: number;
      pendingBefore: number;
    };
    impact: {
      affected: number;
      retained: number;
      removed: number;
      removedDetected: number;
      retainedDetectedSuccessors: unknown[];
    };
  };
  beforeReportRaw: string;
  finalReportRaw: string;
  selectedMembers: Survivor[];
  originalBatchRows: Cluster[];
  clusterRows: Cluster[];
  receipts: Cluster[];
  counterfactuals: {
    executed: boolean;
    exitCode: number;
    unchangedExitCode: number;
    alteredSha256: string;
    expectedDiagnostic: string;
    assertion: string;
  }[];
}

interface IlocBoundaryBundle {
  schema: string;
  provenance: {
    sourceRef: string;
    licenseStatus: string;
    node: string;
    stryker: string;
    beforeReportSha256: string;
    beforeEvidenceSha256: string;
    stageReports: Record<
      "header" | "final",
      {
        reportSha256: string;
        sourceSha256: string;
        normalizedSourceSha256: string;
      }
    >;
    counts: { before: number; header: number; final: number };
  };
  beforeReportRaw: string;
  headerReportRaw: string;
  finalReportRaw: string;
  beforeEvidence: {
    source: string;
    mutants: Mutant[];
    testFiles: Report["testFiles"];
  };
  candidateRows: Cluster[];
  selectedMembers: Survivor[];
}

function loadIlocBoundaryBundle(): {
  bundle: IlocBoundaryBundle;
  beforeReport: Report;
  headerReport: Report;
  finalReport: Report & { testFiles: NonNullable<Report["testFiles"]> };
} {
  const fixturePath = join(
    packageRoot,
    "tests",
    "fixtures",
    "mutation",
    "iloc-boundary-reports.json.gz",
  );
  const bytes = readFileSync(fixturePath);
  expect(sha256(bytes)).toBe(
    "ae6a914a13c299698af479e7ce2c6335db8f7f94f1835d15056a197d5929f401",
  );
  const bundle = JSON.parse(
    gunzipSync(bytes).toString("utf8"),
  ) as IlocBoundaryBundle;
  expect(bundle.schema).toBe("exifcleaner.iloc-boundary-reports.v1");
  expect(bundle.provenance).toMatchObject({
    sourceRef: "cb8eedde27eaa6b2a54cb9f2008d91292a8b3bba",
    licenseStatus:
      "MIT for embedded project source and test excerpts; generated Stryker evidence contains no third-party fixture material",
    node: "24.21.0",
    stryker: "10.1.1",
    beforeReportSha256:
      "62cd1c66845a7707d5cca3c4484fc161139b26daa64875c5bba72ec3582ac502",
    beforeEvidenceSha256:
      "66ab13e3ea1ae914d86e03c841a7a16ce371266e4b7fe5c884383d90a8d691c4",
    counts: { before: 158, header: 158, final: 157 },
  });
  expect(sha256(bundle.beforeReportRaw)).toBe(
    bundle.provenance.beforeReportSha256,
  );
  expect(
    sha256(deletionProof.canonicalReceiptJson(bundle.beforeEvidence)),
  ).toBe(bundle.provenance.beforeEvidenceSha256);
  const beforeReport = JSON.parse(bundle.beforeReportRaw) as Report;
  const headerReport = JSON.parse(bundle.headerReportRaw) as Report;
  const finalReport = JSON.parse(bundle.finalReportRaw) as Report & {
    testFiles: NonNullable<Report["testFiles"]>;
  };
  expect(Object.keys(beforeReport.files)).toEqual(["src/isobmff/iloc.ts"]);
  expect(Object.keys(headerReport.files)).toEqual(["src/isobmff/iloc.ts"]);
  expect(Object.keys(finalReport.files)).toEqual(["src/isobmff/iloc.ts"]);
  expect(beforeReport.files["src/isobmff/iloc.ts"]!.mutants).toHaveLength(158);
  expect(headerReport.files["src/isobmff/iloc.ts"]!.mutants).toHaveLength(158);
  expect(finalReport.files["src/isobmff/iloc.ts"]!.mutants).toHaveLength(157);
  expect(bundle.candidateRows).toHaveLength(4);
  expect(bundle.candidateRows.flatMap((row) => row.keys)).toHaveLength(12);
  expect(bundle.selectedMembers).toHaveLength(12);
  return { bundle, beforeReport, headerReport, finalReport };
}

function loadIsobmff3BatchReport(): { bytes: Buffer; report: Report } {
  const fixturePath = join(
    packageRoot,
    "tests",
    "fixtures",
    "mutation",
    "isobmff-3-multisource-final.json.gz",
  );
  const bytes = readFileSync(fixturePath);
  expect(sha256(bytes)).toBe(
    "75acf56c7337c99043dde6c56903dcd3240998bc0ab33a32ced4442da4a4903c",
  );
  const raw = gunzipSync(bytes);
  expect(sha256(raw)).toBe(
    "1175d7ceeb2aae69d6e375e1b02793cb10c3a91f249d261c6ad98c424a1fe0c6",
  );
  const report = JSON.parse(raw.toString("utf8")) as Report;
  expect(Object.keys(report.files).sort()).toEqual([
    "src/isobmff/brand.ts",
    "src/isobmff/caps.ts",
    "src/isobmff/iloc.ts",
    "src/isobmff/ipma.ts",
  ]);
  expect(sha256(report.files["src/isobmff/iloc.ts"]!.source)).toBe(
    "7201af97a6ec2780dec9d1161f6a3be57ce61b36cead4ec1dfe89c1120069d19",
  );
  expect(report.files["src/isobmff/iloc.ts"]!.mutants).toHaveLength(157);
  expect(
    Object.values(report.files).reduce(
      (n, entry) => n + entry.mutants.length,
      0,
    ),
  ).toBe(349);
  expect(Object.keys(report.testFiles ?? {})).toHaveLength(36);
  expect(
    Object.values(report.testFiles ?? {}).reduce(
      (n, entry) => n + entry.tests.length,
      0,
    ),
  ).toBe(1177);
  return { bytes, report };
}

function loadIsobmff3ReportRegistry(root = packageRoot): {
  rows: Cluster[];
  bindings: Isobmff3ReportBinding[];
} {
  const ledger = JSON.parse(
    readFileSync(join(root, "tools", "mutation", "ledger.json"), "utf8"),
  ) as {
    clusters: Cluster[];
  };
  const rows = ledger.clusters.filter(
    (row) =>
      (row.deletion?.edits as { operation?: string }[] | undefined)?.[0]
        ?.operation === "iloc-header-integer-boundary",
  );
  expect(rows).toHaveLength(2);
  const firstDeletion = rows[0]!.deletion as {
    reportBindings?: Isobmff3ReportBinding[];
  };
  const bindings = firstDeletion.reportBindings;
  expect(Array.isArray(bindings)).toBe(true);
  expect(rows[1]!.deletion?.reportBindings).toEqual(bindings);
  return { rows, bindings: bindings! };
}

function loadRegisteredIsobmff3Reports(root = packageRoot): {
  rows: Cluster[];
  bindings: Isobmff3ReportBinding[];
  reports: {
    binding: Isobmff3ReportBinding;
    variant: Isobmff3ReportBinding["variants"][number];
    fixture: Isobmff3ReportBinding["variants"][number]["fixtures"][number];
    compressed: Buffer;
    raw: Buffer;
    report: Report;
  }[];
} {
  const { rows, bindings } = loadIsobmff3ReportRegistry(root);
  const identities = new Set<string>(),
    rawIdentities = new Set<string>(),
    fixturePaths = new Set<string>();
  const reports = bindings.flatMap((binding) => {
    expect(identities.has(binding.canonicalSha256)).toBe(false);
    identities.add(binding.canonicalSha256);
    expect(binding.variants.length).toBeGreaterThan(0);
    return binding.variants.flatMap((variant) => {
      expect(variant.rawBytes).toBeGreaterThan(0);
      expect(rawIdentities.has(variant.rawSha256)).toBe(false);
      rawIdentities.add(variant.rawSha256);
      expect(variant.fixtures.length).toBeGreaterThan(0);
      return variant.fixtures.map((fixture) => {
        expect(fixture.gzipBytes).toBeGreaterThan(0);
        expect(fixturePaths.has(fixture.path)).toBe(false);
        fixturePaths.add(fixture.path);
        expect(isAbsolute(fixture.path)).toBe(false);
        expect(fixture.path.split(/[\\/]/)).not.toContain("..");
        const fixturePath = resolve(root, fixture.path);
        const fixtureRoot = realpathSync(root);
        assertContained(
          fixtureRoot,
          fixturePath,
          `registered fixture ${fixture.path} escaped product root`,
        );
        assertNoSymlinkComponents(fixtureRoot, fixturePath);
        expect(
          lstatSync(fixturePath).isFile(),
          `${fixture.path} is not a regular file`,
        ).toBe(true);
        const compressed = readFileSync(fixturePath);
        expect(compressed).toHaveLength(fixture.gzipBytes);
        expect(sha256(compressed)).toBe(fixture.gzipSha256);
        const raw = gunzipSync(compressed);
        expect(raw).toHaveLength(variant.rawBytes);
        expect(sha256(raw)).toBe(variant.rawSha256);
        const report = JSON.parse(raw.toString("utf8")) as Report;
        expect(sha256(deletionProof.canonicalReceiptJson(report))).toBe(
          binding.canonicalSha256,
        );
        expect(Object.keys(report.files).sort()).toEqual([
          "src/isobmff/brand.ts",
          "src/isobmff/caps.ts",
          "src/isobmff/iloc.ts",
          "src/isobmff/ipma.ts",
        ]);
        expect(report.files["src/isobmff/iloc.ts"]!.mutants).toHaveLength(157);
        expect(
          Object.values(report.files).reduce(
            (total, entry) => total + entry.mutants.length,
            0,
          ),
        ).toBe(349);
        expect(Object.keys(report.testFiles ?? {})).toHaveLength(36);
        expect(
          Object.values(report.testFiles ?? {}).reduce(
            (total, entry) => total + entry.tests.length,
            0,
          ),
        ).toBe(1177);

        const declared = rows[0]!.deletion!.detectedSuccessors as {
          oldAnchor: string;
          finalAnchor: string;
        }[];
        expect(
          binding.successors
            .map(({ oldAnchor, finalAnchor }) => ({ oldAnchor, finalAnchor }))
            .sort((a, b) => a.oldAnchor.localeCompare(b.oldAnchor)),
        ).toEqual(
          declared
            .map(({ oldAnchor, finalAnchor }) => ({
              oldAnchor,
              finalAnchor,
            }))
            .sort((a, b) => a.oldAnchor.localeCompare(b.oldAnchor)),
        );
        for (const successor of binding.successors) {
          const matching = report.files["src/isobmff/iloc.ts"]!.mutants.filter(
            (mutant) =>
              identity.anchorKey(
                "src/isobmff/iloc.ts",
                mutant,
                report.files["src/isobmff/iloc.ts"]!.source,
              ) === successor.finalAnchor,
          );
          expect(
            matching,
            `registered successor ${successor.finalAnchor}`,
          ).toHaveLength(1);
          const mutant = matching[0]!;
          expect(["Killed", "Timeout"]).toContain(mutant.status);
          expect(mutant.killedBy?.map(String)).toContain(successor.test.id);
          expect(new Set(mutant.killedBy?.map(String)).size).toBe(
            mutant.killedBy?.length,
          );
          const directRows =
            report.testFiles?.[successor.test.file]?.tests.filter(
              (test) =>
                String(test.id) === successor.test.id &&
                test.name === successor.test.name,
            ) ?? [];
          expect(directRows).toHaveLength(1);
          const testSource = report.testFiles?.[successor.test.file]?.source;
          expect(typeof testSource).toBe("string");
          expect(sha256(testSource!)).toBe(successor.test.sourceSha256);
          expect(
            readFileSync(join(packageRoot, successor.test.file), "utf8"),
          ).toBe(testSource);
        }
        return { binding, variant, fixture, compressed, raw, report };
      });
    });
  });
  return { rows, bindings, reports };
}

function materializeIlocBoundaryBundle(
  bundle: IlocBoundaryBundle,
  finalReport: Report & { testFiles: NonNullable<Report["testFiles"]> },
): string {
  const root = tempRoot({});
  const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: packageRoot,
    encoding: "utf8",
  }).trim();
  const writeText = (file: string, content: string | Buffer) => {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  writeText(".git", `gitdir: ${gitDir}\n`);
  writeText(
    "src/isobmff/iloc.ts",
    finalReport.files["src/isobmff/iloc.ts"]!.source,
  );
  for (const [file, entry] of Object.entries(finalReport.testFiles))
    writeText(file, entry.source);
  writeText("reports/mutation/before.json", bundle.beforeReportRaw);
  writeText("reports/mutation/final.json", bundle.finalReportRaw);
  writeText(
    "tools/mutation/pre-triage-survivors.json",
    `${JSON.stringify({ survivors: bundle.selectedMembers })}\n`,
  );
  writeText(
    "tools/mutation/ledger.json",
    `${JSON.stringify({
      schemaVersion: 1,
      preTriage: null,
      clusters: bundle.candidateRows,
    })}\n`,
  );
  writeText(
    "tools/mutation/classes.json",
    readFileSync(
      join(packageRoot, "tools", "mutation", "classes.json"),
      "utf8",
    ),
  );
  writeText(
    "mutation-floors.json",
    readFileSync(join(packageRoot, "mutation-floors.json"), "utf8"),
  );
  return root;
}

function writeIlocCliStage(
  fixture: RealCliFixture,
  bundle: IlocBoundaryBundle,
  stage: "header" | "final",
): string {
  const reportRaw =
    stage === "header" ? bundle.headerReportRaw : bundle.finalReportRaw;
  const report = JSON.parse(reportRaw) as Report & {
    testFiles: NonNullable<Report["testFiles"]>;
  };
  const beforeReportPath = "exifcleaner-node/reports/mutation/before.json";
  const reportPath = `exifcleaner-node/reports/mutation/iloc-${stage}.json`;
  const sourcePath = "exifcleaner-node/src/isobmff/iloc.ts";
  const write = (relativePath: string, content: string | Buffer) => {
    const path = resolve(fixture.root, relativePath);
    assertContained(
      realpathSync(fixture.root),
      path,
      `${relativePath} escaped CLI fixture`,
    );
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) chmodSync(path, 0o644);
    writeFileSync(path, content);
    expect(lstatSync(path).isFile()).toBe(true);
    expect(
      realpathSync(path).startsWith(`${realpathSync(fixture.root)}${sep}`),
    ).toBe(true);
  };
  write(sourcePath, report.files["src/isobmff/iloc.ts"]!.source);
  for (const [file, entry] of Object.entries(report.testFiles))
    write(`exifcleaner-node/${file}`, entry.source);
  write(beforeReportPath, bundle.beforeReportRaw);
  write(reportPath, reportRaw);
  copyWorkspaceRegularFile(
    fixture.root,
    "exifcleaner-node/tests/fixtures/mutation/iloc-boundary-reports.json.gz",
  );
  return reportPath;
}

function overlayIlocCandidateRows(
  ledger: CliLedger,
  candidateRows: Cluster[],
): CliLedger {
  const replacedKeys = new Set(candidateRows.flatMap((row) => row.keys));
  const clusters = ledger.clusters.flatMap((row) => {
    const retained = row.keys
      .map((key, index) => ({ key, anchor: row.anchors?.[index] }))
      .filter(({ key }) => !replacedKeys.has(key));
    if (retained.length === row.keys.length) return [row];
    if (retained.length === 0) return [];
    if (retained.some(({ anchor }) => typeof anchor !== "string"))
      throw new Error(
        `${row.id}: partial candidate overlay cannot retain a key without its frozen anchor`,
      );
    return [
      {
        ...row,
        keys: retained.map(({ key }) => key),
        anchors: retained.map(({ anchor }) => anchor as string),
        count: retained.length,
      },
    ];
  });
  clusters.push(...candidateRows);
  const keys = clusters.flatMap((row) => row.keys);
  if (keys.length !== 1919 || new Set(keys).size !== 1919)
    throw new Error(
      "iloc candidate overlay changed the immutable 1,919-key membership",
    );
  return { ...ledger, clusters };
}

function loadAdmissionReceiptBundle(): {
  bundle: AdmissionReceiptBundle;
  beforeReport: Report;
  finalReport: Report & {
    testFiles: Record<
      string,
      { source: string; tests: { id: string; name: string }[] }
    >;
  };
} {
  const fixturePath = join(
    packageRoot,
    "tests",
    "fixtures",
    "mutation",
    "admission-deletion-reports.json.gz",
  );
  const bundle = JSON.parse(
    gunzipSync(readFileSync(fixturePath)).toString("utf8"),
  ) as AdmissionReceiptBundle;
  expect(bundle.schema).toBe("exifcleaner.admission-deletion-reports.v1");
  expect(sha256(bundle.beforeReportRaw)).toBe(
    bundle.provenance.beforeReport.sha256,
  );
  expect(Buffer.byteLength(bundle.beforeReportRaw)).toBe(
    bundle.provenance.beforeReport.bytes,
  );
  expect(sha256(bundle.finalReportRaw)).toBe(
    bundle.provenance.finalReport.sha256,
  );
  expect(Buffer.byteLength(bundle.finalReportRaw)).toBe(
    bundle.provenance.finalReport.bytes,
  );
  expect(bundle.selectedMembers).toHaveLength(51);
  expect(bundle.clusterRows.flatMap((row) => row.keys)).toHaveLength(51);
  expect(bundle.receipts).toHaveLength(4);
  expect(bundle.provenance.impact).toMatchObject({
    affected: 27,
    retained: 10,
    removed: 17,
    removedDetected: 12,
  });
  expect(bundle.provenance.impact.retainedDetectedSuccessors).toHaveLength(7);
  expect(bundle.counterfactuals).toHaveLength(12);
  for (const counterfactual of bundle.counterfactuals) {
    expect(counterfactual.executed).toBe(true);
    expect(counterfactual.unchangedExitCode).toBe(0);
    expect(counterfactual.exitCode).toBeGreaterThan(0);
    expect(counterfactual.alteredSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(counterfactual.expectedDiagnostic).not.toBe("");
    expect(counterfactual.assertion).not.toBe("");
  }
  const rawRemoved = bundle.receipts[0]!.deletion!.removedMutants as {
    status: string;
  }[];
  expect(
    rawRemoved.reduce<Record<string, number>>((counts, mutant) => {
      counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
      return counts;
    }, {}),
  ).toEqual({ CompileError: 1, Killed: 12, Survived: 4 });
  for (const row of bundle.receipts) {
    expect(row.deletion!.removedMutants as unknown[]).toHaveLength(17);
    expect(row.deletion!.counterfactuals as unknown[]).toHaveLength(12);
  }

  const beforeReport = JSON.parse(bundle.beforeReportRaw) as Report;
  const finalReport = JSON.parse(bundle.finalReportRaw) as Report & {
    testFiles: Record<
      string,
      { source: string; tests: { id: string; name: string }[] }
    >;
  };
  expect(Object.keys(beforeReport.files).sort()).toEqual([
    "src/admission/isobmff-handler.ts",
    "src/isobmff/admission.ts",
  ]);
  expect(Object.keys(finalReport.files).sort()).toEqual(
    Object.keys(beforeReport.files).sort(),
  );
  expect(
    Object.values(beforeReport.files).reduce(
      (n, entry) => n + entry.mutants.length,
      0,
    ),
  ).toBe(426);
  expect(
    Object.values(finalReport.files).reduce(
      (n, entry) => n + entry.mutants.length,
      0,
    ),
  ).toBe(411);
  expect(Object.keys(finalReport.testFiles)).toHaveLength(32);
  expect(sha256(finalReport.files["src/isobmff/admission.ts"]!.source)).toBe(
    bundle.provenance.sources.finalSourceSha256,
  );
  for (const [file, expectedHash] of Object.entries(
    bundle.provenance.tests.finalTestSources,
  ))
    expect(sha256(finalReport.testFiles[file]!.source), file).toBe(
      expectedHash,
    );

  return { bundle, beforeReport, finalReport };
}

function materializeAdmissionReceiptBundle(
  bundle: AdmissionReceiptBundle,
  finalReport: Report,
): string {
  const root = tempRoot({});
  const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: packageRoot,
    encoding: "utf8",
  }).trim();
  writeFileSync(join(root, ".git"), `gitdir: ${gitDir}\n`);
  const writeText = (file: string, content: string) => {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  for (const [file, entry] of Object.entries(finalReport.files))
    writeText(file, entry.source);
  for (const [file, entry] of Object.entries(finalReport.testFiles ?? {}))
    writeText(file, entry.source);
  writeText(bundle.provenance.beforeReport.path, bundle.beforeReportRaw);
  writeText(bundle.provenance.finalReport.path, bundle.finalReportRaw);
  writeText(
    "tools/mutation/pre-triage-survivors.json",
    `${JSON.stringify({ survivors: bundle.selectedMembers })}\n`,
  );
  writeText(
    "tools/mutation/ledger.json",
    `${JSON.stringify({ schemaVersion: 1, preTriage: null, clusters: bundle.clusterRows })}\n`,
  );
  writeText(
    "tools/mutation/classes.json",
    readFileSync(
      join(packageRoot, "tools", "mutation", "classes.json"),
      "utf8",
    ),
  );
  writeText(
    "mutation-floors.json",
    readFileSync(join(packageRoot, "mutation-floors.json"), "utf8"),
  );
  return root;
}

const phaseDir = ".planning/phases/67-mutation-baseline";
const admissionBundlePath =
  "exifcleaner-node/tests/fixtures/mutation/admission-deletion-reports.json.gz";
const admissionReportPath =
  "exifcleaner-node/reports/triage/67-14/resume/batch.json";
const cliScriptPath = `${phaseDir}/67-triage-verify.mjs`;
const cliImportFiles = [
  "exifcleaner-node/tools/mutation/classes.json",
  "exifcleaner-node/tools/mutation/identity.mjs",
  "exifcleaner-node/tools/mutation/disable-lint.mjs",
  "exifcleaner-node/tools/mutation/ledger-summary.mjs",
  "exifcleaner-node/tools/mutation/deletion-proof.mjs",
  "exifcleaner-node/tools/mutation/cluster.mjs",
  "exifcleaner-node/tools/mutation/groups.mjs",
];
const cliHistoryFiles = [
  "67-16-HALTED.md",
  "67-14-HALTED.md",
  "67-14-RESUME-HALTED.md",
  "67-14-CLI-HALTED.md",
  "67-48-PLAN.md",
  "67-49-PLAN.md",
  "67-50-PLAN.md",
  "67-49-SUMMARY.md",
];

function provisionPinnedTypeScriptParser(root: string): void {
  const packageRootPath = "exifcleaner-node/package.json";
  const metadataPath = "exifcleaner-node/node_modules/typescript/package.json";
  const runtimePath =
    "exifcleaner-node/node_modules/typescript/lib/typescript.js";
  if (
    [packageRootPath, metadataPath, runtimePath].every((path) =>
      existsSync(resolve(root, path)),
    )
  )
    return;
  const metadataBytes = readFileSync(resolve(workspaceRoot, metadataPath));
  const runtimeBytes = readFileSync(resolve(workspaceRoot, runtimePath));
  const metadata = JSON.parse(metadataBytes.toString("utf8")) as {
    version?: string;
    main?: string;
  };
  expect(metadata.version).toBe("6.0.3");
  expect(metadata.main).toBe("./lib/typescript.js");
  expect(sha256(metadataBytes)).toBe(
    "9332e97c30d3e53ed54910b89207ed657fb444066484df6e5b6965bf130865e9",
  );
  expect(runtimeBytes).toHaveLength(9_144_216);
  expect(sha256(runtimeBytes)).toBe(
    "569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39",
  );
  for (const path of [packageRootPath, metadataPath, runtimePath]) {
    const destination = resolve(root, path);
    if (existsSync(destination)) {
      expect(readFileSync(destination)).toEqual(
        readFileSync(resolve(workspaceRoot, path)),
      );
    } else copyWorkspaceRegularFile(root, path);
  }
}

interface CliBatch {
  id: string;
  plan: string;
  clusterIds: string[];
  filesModified: string[];
  sourceFiles: string[];
  testFiles: string[];
}
interface CliManifest {
  preTriageSha: string;
  preSha256: string;
  batches: CliBatch[];
}
interface CliLedger {
  schemaVersion: number;
  preTriage: unknown;
  clusters: Cluster[];
}
interface CliBundle extends AdmissionReceiptBundle {
  originalBatchRows: Cluster[];
  selectedMembers: Survivor[];
  clusterRows: Cluster[];
}
interface LedgerSummary {
  renderLedger(ledger: CliLedger): string;
}
interface RealCliFixture {
  root: string;
  productRoot: string;
  manifest: CliManifest;
  bundle: CliBundle;
  ledgerPath: string;
  summaryPath: string;
  reportPath: string;
}

function assertContained(root: string, path: string, label: string): void {
  const rel = relative(root, path);
  expect(
    isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`),
    label,
  ).toBe(false);
}

function assertNoSymlinkComponents(root: string, path: string): void {
  const rel = relative(root, path);
  expect(
    isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`),
    `${path} escapes ${root}`,
  ).toBe(false);
  let cursor = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    expect(
      lstatSync(cursor).isSymbolicLink(),
      `${cursor} contains a symlink component`,
    ).toBe(false);
  }
}

function copyWorkspaceRegularFile(root: string, relativePath: string): void {
  expect(relativePath.length).toBeGreaterThan(0);
  expect(isAbsolute(relativePath)).toBe(false);
  expect(relativePath.split(/[\\/]/)).not.toContain("..");
  const source = resolve(workspaceRoot, relativePath);
  const destination = resolve(root, relativePath);
  const sourceRoot = realpathSync(workspaceRoot);
  const fixtureRoot = realpathSync(root);
  assertContained(
    sourceRoot,
    source,
    `source ${relativePath} escaped workspace`,
  );
  assertContained(
    fixtureRoot,
    destination,
    `destination ${relativePath} escaped fixture`,
  );
  assertNoSymlinkComponents(sourceRoot, source);
  expect(
    lstatSync(source).isFile(),
    `${relativePath} is not a regular input`,
  ).toBe(true);
  expect(
    realpathSync(source).startsWith(`${sourceRoot}${sep}`),
    `${relativePath} resolves outside workspace`,
  ).toBe(true);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  assertNoSymlinkComponents(fixtureRoot, destination);
  expect(
    lstatSync(destination).isFile(),
    `${relativePath} was not copied as a regular file`,
  ).toBe(true);
  expect(
    realpathSync(destination).startsWith(`${fixtureRoot}${sep}`),
    `${relativePath} resolves outside fixture`,
  ).toBe(true);
}

function writeFixtureFile(
  root: string,
  relativePath: string,
  content: string | Buffer,
): void {
  const destination = resolve(root, relativePath);
  const fixtureRoot = realpathSync(root);
  assertContained(
    fixtureRoot,
    destination,
    `${relativePath} escaped fixture on write`,
  );
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
  expect(
    lstatSync(destination).isFile(),
    `${relativePath} was not written as a regular file`,
  ).toBe(true);
}

function createRealAdmissionCliFixture(): RealCliFixture {
  const { bundle: loadedBundle } = loadAdmissionReceiptBundle();
  const bundle = loadedBundle as CliBundle;
  const manifest = JSON.parse(
    readFileSync(
      join(workspaceRoot, phaseDir, "67-TRIAGE-BATCHES.json"),
      "utf8",
    ),
  ) as CliManifest;
  const fixtureBytes = readFileSync(join(workspaceRoot, admissionBundlePath));
  expect(sha256(fixtureBytes)).toBe(
    "6b9f4943e0f59e1df1442c1244efe575c7c167cebc5a3704c9843941b9691542",
  );
  expect(bundle.provenance.beforeReport.sha256).toBe(
    "1b664580b7c99f0391ac062d6fed903c919ef008a251e93c4d2b0fc191f88881",
  );
  expect(Buffer.byteLength(bundle.beforeReportRaw)).toBe(1_369_999);
  const selectedBatch = manifest.batches.find(
    (batch) => batch.id === "isobmff-1",
  );
  expect(selectedBatch).toBeDefined();
  const inventoryPaths = [
    ...new Set(manifest.batches.flatMap((batch) => batch.filesModified)),
  ].sort();
  expect(inventoryPaths).toHaveLength(150);
  const evidenceSourcePaths = [
    ...new Set(
      manifest.batches.flatMap((batch) =>
        [...batch.sourceFiles, ...batch.testFiles].map(
          (file) => `exifcleaner-node/${file}`,
        ),
      ),
    ),
  ].sort();

  const root = realpathSync(mkdtempSync(join(tmpdir(), "phase-67-50-cli-")));
  temporaryRoots.push(root);
  for (const path of inventoryPaths) copyWorkspaceRegularFile(root, path);
  for (const path of evidenceSourcePaths) copyWorkspaceRegularFile(root, path);
  copyWorkspaceRegularFile(
    root,
    "exifcleaner-node/tools/mutation/pre-triage-survivors.json",
  );
  copyWorkspaceRegularFile(root, "exifcleaner-node/tools/mutation/ledger.json");
  const planPaths = manifest.batches.map(
    (batch) => `${phaseDir}/67-${String(batch.plan).padStart(2, "0")}-PLAN.md`,
  );
  const schedulePlanPaths = [
    ...Array.from({ length: 32 }, (_, index) => index + 16),
    52,
    53,
    54,
    55,
  ].map((plan) => `${phaseDir}/67-${String(plan).padStart(2, "0")}-PLAN.md`);
  for (const path of new Set([
    ...planPaths,
    ...schedulePlanPaths,
    ...cliHistoryFiles.map((file) => `${phaseDir}/${file}`),
    `${phaseDir}/67-TRIAGE-BATCHES.json`,
    `${phaseDir}/67-GAP-REPAIR-CONTRACT.md`,
    `${phaseDir}/67-CONTEXT.md`,
  ])) {
    if (!existsSync(resolve(workspaceRoot, path))) continue;
    copyWorkspaceRegularFile(root, path);
  }
  copyWorkspaceRegularFile(root, cliScriptPath);
  for (const path of cliImportFiles) copyWorkspaceRegularFile(root, path);

  const batch = selectedBatch!;
  const targetOrigins = new Set(batch.clusterIds);
  const ledgerPath = "exifcleaner-node/tools/mutation/ledger.json";
  const summaryPath = `${phaseDir}/67-SURVIVOR-LEDGER.md`;
  const ledger = JSON.parse(
    readFileSync(resolve(workspaceRoot, ledgerPath), "utf8"),
  ) as CliLedger;
  const untouched = ledger.clusters.filter(
    (row) => !targetOrigins.has(row.originClusterId ?? row.id),
  );
  const candidateLedger: CliLedger = {
    ...ledger,
    clusters: [...untouched, ...bundle.clusterRows].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
  };
  expect(
    candidateLedger.clusters
      .filter((row) => targetOrigins.has(row.originClusterId ?? row.id))
      .flatMap((row) => row.keys)
      .sort(),
  ).toEqual(bundle.selectedMembers.map((member) => member.key).sort());
  writeFixtureFile(
    root,
    ledgerPath,
    `${JSON.stringify(candidateLedger, null, 2)}\n`,
  );
  writeFixtureFile(root, summaryPath, renderLedger(candidateLedger));
  writeFixtureFile(root, admissionBundlePath, fixtureBytes);
  writeFixtureFile(
    root,
    bundle.provenance.beforeReport.path,
    bundle.beforeReportRaw,
  );
  writeFixtureFile(
    root,
    bundle.provenance.finalReport.path,
    bundle.finalReportRaw,
  );
  writeFixtureFile(root, admissionReportPath, bundle.finalReportRaw);

  const liveGitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: packageRoot,
    encoding: "utf8",
  }).trim();
  writeFixtureFile(root, "exifcleaner-node/.git", `gitdir: ${liveGitDir}\n`);

  const fixtureRoot = realpathSync(root);
  const productRoot = realpathSync(resolve(root, "exifcleaner-node"));
  for (const path of [...inventoryPaths, ...evidenceSourcePaths].map((file) =>
    resolve(root, file),
  )) {
    assertNoSymlinkComponents(fixtureRoot, path);
    expect(
      lstatSync(path).isFile(),
      `${path} is not a contained regular inventory copy`,
    ).toBe(true);
    expect(
      realpathSync(path).startsWith(`${fixtureRoot}${sep}`),
      `${path} resolves outside fixture`,
    ).toBe(true);
    chmodSync(path, 0o444);
  }
  const scriptPath = resolve(root, cliScriptPath);
  assertContained(
    fixtureRoot,
    realpathSync(scriptPath),
    "copied verifier escaped fixture",
  );
  assertContained(fixtureRoot, productRoot, "CLI product root escaped fixture");
  return {
    root,
    productRoot,
    manifest,
    bundle,
    ledgerPath,
    summaryPath,
    reportPath: admissionReportPath,
  };
}

function createRealIsobmff3BatchCliFixture(
  reportBytes: Buffer,
): RealCliFixture {
  const fixture = createRealAdmissionCliFixture();
  const report = JSON.parse(gunzipSync(reportBytes).toString("utf8")) as Report;
  for (const file of Object.keys(report.testFiles ?? {})) {
    const relativePath = `exifcleaner-node/${file}`;
    if (!existsSync(resolve(fixture.root, relativePath)))
      copyWorkspaceRegularFile(fixture.root, relativePath);
  }
  const liveLedger = readFileSync(
    join(packageRoot, "tools", "mutation", "ledger.json"),
  );
  const parsedLedger = JSON.parse(liveLedger.toString("utf8")) as {
    clusters: Cluster[];
  };
  const registryRows = parsedLedger.clusters.filter(
    (row) =>
      (row.deletion?.edits as { operation?: string }[] | undefined)?.[0]
        ?.operation === "iloc-header-integer-boundary",
  );
  for (const row of registryRows) {
    const deletion = row.deletion as {
      reportBindings?: Isobmff3ReportBinding[];
    };
    for (const binding of deletion.reportBindings ?? [])
      for (const variant of binding.variants)
        for (const registeredFixture of variant.fixtures)
          copyWorkspaceRegularFile(
            fixture.root,
            `exifcleaner-node/${registeredFixture.path}`,
          );
  }
  const liveSummary = readFileSync(
    join(workspaceRoot, phaseDir, "67-SURVIVOR-LEDGER.md"),
  );
  for (const [relativePath, contents] of [
    [fixture.ledgerPath, liveLedger],
    [fixture.summaryPath, liveSummary],
  ] as const) {
    const path = resolve(fixture.root, relativePath);
    chmodSync(path, 0o644);
    writeFileSync(path, contents);
    chmodSync(path, 0o444);
  }
  fixture.reportPath = "exifcleaner-node/reports/triage/67-16/batch.json";
  writeFixtureFile(fixture.root, fixture.reportPath, gunzipSync(reportBytes));
  return fixture;
}

function setCliGapTest(
  fixture: RealCliFixture,
  key: string,
  testName: string,
): void {
  const ledgerFile = resolve(fixture.root, fixture.ledgerPath);
  chmodSync(ledgerFile, 0o644);
  const ledger = JSON.parse(readFileSync(ledgerFile, "utf8")) as CliLedger;
  const row = ledger.clusters.find((candidate) => candidate.keys.includes(key));
  expect(row, `fixture has a row for ${key}`).toBeDefined();
  row!.test = { file: "tests/isobmff_admission.test.ts", name: testName };
  writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
  const summaryFile = resolve(fixture.root, fixture.summaryPath);
  chmodSync(summaryFile, 0o644);
  writeFileSync(summaryFile, renderLedger(ledger));
  chmodSync(ledgerFile, 0o444);
  chmodSync(summaryFile, 0o444);
}

function runRealCli(
  fixture: RealCliFixture,
  args: string[],
): ReturnType<typeof spawnSync> {
  if (args.includes("--batch")) provisionPinnedTypeScriptParser(fixture.root);
  const script = resolve(fixture.root, cliScriptPath);
  const actualRoot = realpathSync(fixture.root);
  assertContained(
    actualRoot,
    realpathSync(script),
    "CLI script must be inside mkdtemp",
  );
  return spawnSync(process.execPath, [script, ...args], {
    cwd: actualRoot,
    encoding: "utf8",
    env: process.env,
  });
}

function runRealBatchCli(
  fixture: RealCliFixture,
): ReturnType<typeof spawnSync> {
  return runRealCli(fixture, [
    "--batch",
    "isobmff-1",
    "--mode",
    "batch",
    "--report",
    fixture.reportPath,
  ]);
}

function withCliLedgerMutation<T>(
  fixture: RealCliFixture,
  mutate: (ledger: CliLedger) => void,
  action: () => T,
): T {
  const ledgerPath = resolve(fixture.root, fixture.ledgerPath);
  const summaryPath = resolve(fixture.root, fixture.summaryPath);
  const originalLedger = readFileSync(ledgerPath);
  const originalSummary = readFileSync(summaryPath);
  chmodSync(ledgerPath, 0o644);
  chmodSync(summaryPath, 0o644);
  try {
    const ledger = JSON.parse(originalLedger.toString("utf8")) as CliLedger;
    mutate(ledger);
    writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    writeFileSync(summaryPath, renderLedger(ledger));
    chmodSync(ledgerPath, 0o444);
    chmodSync(summaryPath, 0o444);
    return action();
  } finally {
    chmodSync(ledgerPath, 0o644);
    chmodSync(summaryPath, 0o644);
    writeFileSync(ledgerPath, originalLedger);
    writeFileSync(summaryPath, originalSummary);
    chmodSync(ledgerPath, 0o444);
    chmodSync(summaryPath, 0o444);
  }
}

function withCliFileMutation<T>(
  fixture: RealCliFixture,
  relativePath: string,
  mutate: (original: Buffer) => Buffer,
  action: () => T,
): T {
  const path = resolve(fixture.root, relativePath);
  const original = readFileSync(path);
  chmodSync(path, 0o644);
  try {
    writeFileSync(path, mutate(original));
    chmodSync(path, 0o444);
    return action();
  } finally {
    chmodSync(path, 0o644);
    writeFileSync(path, original);
    chmodSync(path, 0o444);
  }
}

function withCliFileRemoval<T>(
  fixture: RealCliFixture,
  relativePath: string,
  action: () => T,
): T {
  const path = resolve(fixture.root, relativePath);
  const retainedPath = `${path}.phase-67-50-removed`;
  renameSync(path, retainedPath);
  try {
    return action();
  } finally {
    renameSync(retainedPath, path);
  }
}

function withCliBundleMutation<T>(
  fixture: RealCliFixture,
  mutate: (bundle: CliBundle) => void,
  action: () => T,
): T {
  return withCliFileMutation(
    fixture,
    admissionBundlePath,
    (original) => {
      const bundle = JSON.parse(
        gunzipSync(original).toString("utf8"),
      ) as CliBundle;
      mutate(bundle);
      return gzipSync(Buffer.from(JSON.stringify(bundle)));
    },
    action,
  );
}

function expectCliRejection(
  result: ReturnType<typeof spawnSync>,
  diagnostic: string,
): void {
  expect(
    result.error,
    `CLI spawn error: ${result.error?.message ?? "none"}`,
  ).toBeUndefined();
  expect(
    result.status,
    `CLI stdout:\n${result.stdout}\nCLI stderr:\n${result.stderr}`,
  ).not.toBe(0);
  expect(result.stderr).toContain(diagnostic);
}

function deletionFixture(removeBeforeReport = false) {
  const file = "src/example.mjs";
  const testFile = "tests/rejects-false.mjs";
  const testName = "rejects false input";
  const beforeSource = [
    "export function f(flag) {",
    "  const out = [];",
    "  if (flag) {",
    '    out.push("hit");',
    "  }",
    "  return out;",
    "}",
    "export function other(flag) {",
    "  const out = [];",
    "  if (flag) {",
    '    out.push("other");',
    "  }",
    "  return out;",
    "}",
    "",
  ].join("\n");
  const afterSource = beforeSource.replace("  if (flag) {", "  {");
  const testSource = [
    'import assert from "node:assert/strict";',
    'import { f } from "../src/example.mjs";',
    `// ${testName}`,
    "assert.deepEqual(f(false), []);",
    "",
  ].join("\n");
  const root = tempRoot({
    [file]: beforeSource,
    [testFile]: testSource,
    "tools/mutation/pre-triage-survivors.json": "{}\n",
  });
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Mutation Fixture"], {
    cwd: root,
  });
  execFileSync("git", ["add", file], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "fixture before source"], {
    cwd: root,
  });

  const at = (text: string, needle: string, start = 0) => {
    const index = text.indexOf(needle, start);
    if (index === -1) throw new Error(`fixture text missing: ${needle}`);
    const prefix = text.slice(0, index);
    const lines = prefix.split("\n");
    return { line: lines.length, column: lines.at(-1)!.length + 1 };
  };
  const span = (text: string, needle: string, start = 0) => {
    const point = at(text, needle, start);
    return {
      start: point,
      end: { line: point.line, column: point.column + needle.length },
    };
  };
  const guardStart = beforeSource.indexOf("if (flag)");
  const guardLineStart = beforeSource.indexOf("  if (flag)");
  const guardTrue = mutant("before-true", 3, 7, "Survived", {
    mutatorName: "ConditionalExpression",
    replacement: "true",
  });
  const guardFalse = mutant("before-false", 3, 7, "Killed", {
    mutatorName: "ConditionalExpression",
    replacement: "false",
    killedBy: ["t1"],
  });
  const ancestor = mutant("before-block", 3, 3, "NoCoverage", {
    mutatorName: "BlockStatement",
    replacement: "{}",
    location: {
      start: at(beforeSource, "if (flag)"),
      end: {
        ...at(
          beforeSource,
          "  }\n  return",
          beforeSource.indexOf("if (flag)") + 1,
        ),
        column: 4,
      },
    },
  });
  const sibling = mutant("before-push", 4, 5, "Survived", {
    mutatorName: "MethodExpression",
    replacement: "void 0",
    location: span(beforeSource, 'out.push("hit")'),
  });
  // Keep the original condition at a distinct occurrence in another function.
  expect(guardStart).toBeGreaterThanOrEqual(0);
  expect(guardLineStart).toBeGreaterThanOrEqual(0);
  const beforeMutants = [guardTrue, guardFalse, ancestor, sibling];
  const reportTestFiles = {
    [testFile]: { source: testSource, tests: [{ id: "t1", name: testName }] },
  };
  const evidence = {
    source: beforeSource,
    mutants: beforeMutants,
    testFiles: reportTestFiles,
  };
  const beforeReport = {
    files: {
      [file]: {
        language: "javascript",
        source: beforeSource,
        mutants: beforeMutants,
      },
    },
    testFiles: reportTestFiles,
  };
  const reportBytes = `${JSON.stringify(beforeReport, null, 2)}\n`;
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(join(root, "reports", "before.json"), reportBytes);
  if (removeBeforeReport) rmSync(join(root, "reports", "before.json"));

  const survivors = [guardTrue, sibling].map((entry) => ({
    key: identity.mutantKey(file, entry),
    anchorKey: identity.anchorKey(file, entry, beforeSource),
    file,
    function: "f",
    group: "g",
    mutatorName: entry.mutatorName,
    status: entry.status,
  }));
  writeFileSync(
    join(root, "tools/mutation/pre-triage-survivors.json"),
    JSON.stringify({ survivors }, null, 2),
  );
  const owned = survivors[0]!;
  const testResolved = [{ file: testFile, name: testName }];
  const removedMutants = beforeMutants.slice(0, 2).map((entry) => ({
    anchor: identity.anchorKey(file, entry, beforeSource),
    mutatorName: entry.mutatorName,
    replacement: entry.replacement ?? "",
    location: entry.location,
    status: entry.status,
    killedBy: entry.status === "Killed" ? testResolved : [],
  }));
  const beforeRef = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const receipt = {
    version: 1,
    beforeRef,
    beforeSourceSha256: sha256(beforeSource),
    function: "f",
    edits: [{ function: "f", before: "if (flag) ", after: "", occurrence: 0 }],
    beforeReport: "reports/before.json",
    beforeReportSha256: sha256(reportBytes),
    beforeEvidence: evidence,
    beforeEvidenceSha256: sha256(deletionProof.canonicalReceiptJson(evidence)),
    removedMutants,
    detectedSuccessors: [
      {
        oldAnchor: identity.anchorKey(file, guardFalse, beforeSource),
        finalAnchor: identity.anchorKey(
          file,
          { ...sibling, id: "successor", status: "Killed", killedBy: ["t1"] },
          afterSource,
        ),
        test: { file: testFile, name: testName },
        semanticTrace: "f(false) remains empty after removing the guard",
      },
    ],
    referenceTrace:
      "f writes only within its local branch; the assertion and all callers were checked",
  };
  const row = cluster("scoped-dead", {
    file,
    function: "f",
    mutatorName: "ConditionalExpression",
    disposition: "dead",
    count: 1,
    keys: [owned.key],
    anchors: [owned.anchorKey],
    symbol: "if (flag)",
    deletion: receipt,
  });
  const successor = {
    ...sibling,
    id: "successor",
    status: "Killed",
    killedBy: ["t1"],
  };
  const liveAncestor = {
    ...ancestor,
    id: "live-ancestor",
    status: "Killed",
    location: {
      start: {
        ...at(afterSource, "  {", afterSource.indexOf("  const out") + 1),
        column: 3,
      },
      end: {
        ...at(afterSource, "  }\n  return", afterSource.indexOf("  {")),
        column: 4,
      },
    },
  };
  const finalReport: Report & {
    testFiles: Record<
      string,
      { source: string; tests: { id: string; name: string }[] }
    >;
  } = {
    files: {
      [file]: {
        language: "javascript",
        source: afterSource,
        mutants: [successor, liveAncestor],
      },
    },
    testFiles: reportTestFiles,
  };
  writeFileSync(
    join(root, "tools/mutation/pre-triage-survivors.json"),
    JSON.stringify({ survivors }, null, 2),
  );
  writeFileSync(join(root, file), afterSource);
  const reportPath = join(root, "reports", "final.json");
  writeFileSync(reportPath, `${JSON.stringify(finalReport, null, 2)}\n`);
  return {
    root,
    file,
    testFile,
    testSource,
    beforeSource,
    afterSource,
    beforeMutants,
    evidence,
    reportBytes,
    receipt,
    row,
    survivors,
    finalReport,
    successor,
    reportPath,
    readTest: (path: string) => readFileSync(join(root, path), "utf8"),
  };
}
const covering: [Cluster, Cluster] = [
  cluster("c1", { count: 2, keys: [keyOf(m1), keyOf(m2)] }),
  cluster("c2", { count: 1, keys: [keyOf(m3)] }),
];
const noRoot = "/nonexistent-root";

describe("anchorKey (D-13, D-18)", () => {
  it("survives a line shift that changes mutantKey", () => {
    const shifted = "// inserted\n" + SOURCE;
    const before = m2;
    const after = mutant("2", 3, 11, "NoCoverage");
    expect(identity.anchorKey("f", after, shifted)).toBe(
      identity.anchorKey("f", before, SOURCE),
    );
    expect(identity.mutantKey("f", after)).not.toBe(
      identity.mutantKey("f", before),
    );
  });

  it("differs for the second identical occurrence in the same file", () => {
    const twice = "x(true);\nx(true);\n";
    const first = mutant("1", 1, 3, "Survived");
    const second = mutant("2", 2, 3, "Survived");
    expect(identity.anchorKey("f", first, twice)).not.toBe(
      identity.anchorKey("f", second, twice),
    );
  });

  it("reads the mutated span with 1-based columns", () => {
    expect(identity.anchorKey("f", m1, SOURCE)).toContain("\u0000true\u0000");
  });
});

describe("pre-triage mapping (D-18)", () => {
  it("fails naming the uncovered key when 2 of 3 survivors are mapped", () => {
    const problems = checkLedger({
      ledger: ledgerOf([covering[0]]),
      preReport: pre,
      root: noRoot,
      groups,
      mode: "pre",
    });
    expect(problems).toEqual([
      `${keyOf(m3).replaceAll("\u0000", "|")}: in no cluster`,
    ]);
  });

  it("fails a key that sits in two clusters", () => {
    const problems = checkLedger({
      ledger: ledgerOf([
        covering[0],
        covering[1],
        cluster("c3", { count: 1, keys: [keyOf(m1)] }),
      ]),
      preReport: pre,
      root: noRoot,
      groups,
      mode: "pre",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/: in 2 clusters \(c1, c3\)$/);
  });

  it("fails a cluster whose count differs from its key list", () => {
    const problems = checkLedger({
      ledger: ledgerOf([
        cluster("c1", { count: 3, keys: covering[0].keys }),
        covering[1],
      ]),
      preReport: pre,
      root: noRoot,
      groups,
      mode: "pre",
    });
    expect(problems).toEqual(["c1: count 3 differs from 2 keys"]);
  });

  it("fails a key that is not a survivor of the pre-triage report", () => {
    const problems = checkLedger({
      ledger: ledgerOf([
        ...covering,
        cluster("c4", { count: 1, keys: [keyOf(m4)] }),
      ]),
      preReport: pre,
      root: noRoot,
      groups,
      mode: "pre",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /not a trust survivor of the pre-triage report/,
    );
  });

  it("an empty ledger with a non-empty report is red", () => {
    const problems = checkLedger({
      ledger: ledgerOf([]),
      preReport: pre,
      root: noRoot,
      groups,
      mode: "pre",
    });
    expect(problems).toHaveLength(3);
  });

  it("ignores orchestration-group survivors (positive control)", () => {
    const orchestration = reportOf(
      [mutant("9", 1, 11, "Survived")],
      "src/o/y.ts",
    );
    expect(
      checkLedger({
        ledger: ledgerOf([]),
        preReport: orchestration,
        root: noRoot,
        groups,
        mode: "pre",
      }),
    ).toEqual([]);
  });

  it("passes when every survivor is in exactly one cluster (positive control)", () => {
    expect(
      checkLedger({
        ledger: ledgerOf(covering),
        preReport: pre,
        root: noRoot,
        groups,
        mode: "pre",
      }),
    ).toEqual([]);
  });
});

describe("final mode (D-18)", () => {
  const clean = reportOf([mutant("1", 1, 11, "Killed")]);
  const final = (
    clusters: Cluster[],
    root = noRoot,
    finalReport: Report | null = clean,
  ) =>
    checkLedger({
      ledger: ledgerOf(clusters),
      finalReport,
      root,
      groups,
      mode: "final",
    });

  it("a pending cluster fails", () => {
    expect(final([cluster("c1")])).toEqual(["c1: cluster is pending"]);
  });

  it("a gap row whose test file is missing fails", () => {
    const root = tempRoot({});
    const problems = final(
      [
        cluster("c1", {
          disposition: "gap",
          test: { file: "tests/k.test.ts", name: "kills it" },
        }),
      ],
      root,
    );
    expect(problems).toEqual(["c1: gap test file tests/k.test.ts is missing"]);
  });

  it("a gap row whose file lacks the test name fails", () => {
    const root = tempRoot({ "tests/k.test.ts": 'it("other", () => {});\n' });
    const problems = final(
      [
        cluster("c1", {
          disposition: "gap",
          test: { file: "tests/k.test.ts", name: "kills it" },
        }),
      ],
      root,
    );
    expect(problems).toEqual([
      'c1: gap test tests/k.test.ts does not contain test name "kills it"',
    ]);
  });

  it("a dead row whose symbol is still a word in src fails", () => {
    const root = tempRoot({
      "src/a/x.ts": "export function legacyHelper() {}\n",
    });
    const problems = final(
      [cluster("c1", { disposition: "dead", symbol: "legacyHelper" })],
      root,
    );
    expect(problems).toEqual([
      "c1: dead symbol legacyHelper still appears in src/",
    ]);
  });

  it("a comment-Ignored mutant with no equivalent row fails", () => {
    const ignored = mutant("5", 1, 11, "Ignored", {
      statusReason: "equivalent-arithmetic — same value",
    });
    const problems = final([], noRoot, reportOf([ignored]));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /comment-Ignored mutant matches no equivalent row/,
    );
  });

  it("an equivalent row whose class differs from the disable comment fails", () => {
    const ignored = mutant("5", 1, 11, "Ignored", {
      statusReason: "equivalent-arithmetic — same value",
    });
    const anchor = identity.anchorKey("src/a/x.ts", ignored, SOURCE);
    const problems = final(
      [
        cluster("c1", {
          disposition: "equivalent",
          equivalenceClass: "platform-constant",
          count: 0,
          anchors: [anchor],
        }),
      ],
      noRoot,
      reportOf([ignored]),
    );
    expect(problems).toEqual([
      "c1: equivalenceClass platform-constant differs from the disable comment class equivalent-arithmetic",
    ]);
  });

  it("a Survived trust mutant in the final report fails", () => {
    const problems = final(
      [],
      noRoot,
      reportOf([mutant("1", 1, 11, "Survived")]),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /: Survived in a trust group in the final report$/,
    );
  });

  it("a NoCoverage trust mutant in the final report fails", () => {
    const problems = final(
      [],
      noRoot,
      reportOf([mutant("1", 1, 11, "NoCoverage")]),
    );
    expect(problems[0]).toMatch(/: NoCoverage in a trust group/);
  });

  it("an orchestration-group Survived mutant does not fail (positive control)", () => {
    expect(
      final(
        [],
        noRoot,
        reportOf([mutant("1", 1, 11, "Survived")], "src/o/y.ts"),
      ),
    ).toEqual([]);
  });

  it("a complete fixture passes (positive control)", () => {
    const root = tempRoot({
      "tests/k.test.ts": 'it("kills it", () => {});\n',
      "src/a/x.ts": "export const live = 1;\n",
    });
    const ignored = mutant("5", 1, 11, "Ignored", {
      statusReason: "equivalent-arithmetic — same value",
    });
    const anchor = identity.anchorKey("src/a/x.ts", ignored, SOURCE);
    const report = reportOf([ignored, mutant("6", 2, 11, "Killed")]);
    expect(
      final(
        [
          cluster("c1", {
            disposition: "gap",
            test: { file: "tests/k.test.ts", name: "kills it" },
          }),
          cluster("c2", { disposition: "dead", symbol: "legacyHelper" }),
          cluster("c3", {
            disposition: "equivalent",
            equivalenceClass: "equivalent-arithmetic",
            anchors: [anchor],
          }),
        ],
        root,
        report,
      ),
    ).toEqual([]);
  });
});

describe("committed ledger", () => {
  const ledgerPath = join(packageRoot, "tools", "mutation", "ledger.json");
  const prePath = join(
    packageRoot,
    "tools",
    "mutation",
    "pre-triage-survivors.json",
  );
  const runLiveReadOnly = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [join(packageRoot, "tools", "mutation", "ledger-check.mjs"), ...args],
      { cwd: packageRoot, encoding: "utf8" },
    );

  it("preserves mixed dispositions and exact immutable membership", () => {
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      preTriage: { runId: string; sha: string; survivorCount: number };
      clusters: Cluster[];
    };
    const pre = JSON.parse(readFileSync(prePath, "utf8")) as {
      runId: string;
      sha: string;
      survivorCount: number;
      survivors: Survivor[];
    };
    expect(ledger.preTriage.runId).toMatch(/^\d+$/);
    expect(ledger.preTriage.runId).toBe(pre.runId);
    expect(ledger.preTriage.sha).toBe(pre.sha);
    expect(ledger.preTriage.survivorCount).toBe(pre.survivorCount);
    expect(ledger.clusters.every((c) => c.count === c.keys.length)).toBe(true);
    expect(
      ledger.clusters.every((c) =>
        ["pending", "gap", "equivalent", "dead"].includes(c.disposition),
      ),
    ).toBe(true);
    expect(
      new Set(ledger.clusters.map((c) => c.disposition)).size,
    ).toBeGreaterThan(1);

    const survivorByKey = new Map(pre.survivors.map((s) => [s.key, s]));
    const allKeys = ledger.clusters.flatMap((c) => c.keys);
    const origin = (c: Cluster) => c.originClusterId ?? c.id;
    const expectedOrigin = (s: Survivor) =>
      `${s.group}:${s.file}:${s.function}:${s.mutatorName}`;
    expect(pre.survivors).toHaveLength(1919);
    expect(survivorByKey.size).toBe(1919);
    expect(allKeys).toHaveLength(1919);
    expect(new Set(allKeys).size).toBe(1919);
    expect(new Set(ledger.clusters.map(origin)).size).toBe(586);
    expect(new Set(pre.survivors.map(expectedOrigin)).size).toBe(586);
    for (const row of ledger.clusters) {
      expect(new Set(row.keys).size).toBe(row.keys.length);
      for (const key of row.keys) {
        const survivor = survivorByKey.get(key);
        expect(survivor, `${row.id}: foreign member`).toBeDefined();
        expect(origin(row)).toBe(expectedOrigin(survivor!));
        expect(row.group).toBe(survivor!.group);
        expect(row.file).toBe(survivor!.file);
        expect(row.function).toBe(survivor!.function);
        expect(row.mutatorName).toBe(survivor!.mutatorName);
      }
    }

    const result = runLiveReadOnly("--pre", prePath);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("fails when one survivor is removed from every cluster (negative control)", () => {
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      clusters: Cluster[];
    };
    const victim = ledger.clusters[0];
    expect(victim).toBeDefined();
    // Run the checker library directly on a ledger missing one key.
    const mutated = {
      schemaVersion: 1,
      preTriage: null,
      clusters: ledger.clusters.map((c) =>
        c.id === victim?.id
          ? { ...c, count: c.count - 1, keys: c.keys.slice(1) }
          : c,
      ),
    };
    const pre = JSON.parse(
      readFileSync(
        join(packageRoot, "tools", "mutation", "pre-triage-survivors.json"),
        "utf8",
      ),
    ) as { survivors: Survivor[] };
    const problems = checkLedger({
      ledger: mutated,
      preReport: asReport(pre),
      root: packageRoot,
      groups: JSON.parse(
        readFileSync(join(packageRoot, "mutation-floors.json"), "utf8"),
      ).groups,
      mode: "pre",
    });
    expect(problems.some((p) => /in no cluster/.test(p))).toBe(true);
  });

  it("is red against a non-empty pre-report (empty ledger, non-empty report)", () => {
    const dir = cliFixture({
      "tools/mutation/ledger.json": JSON.stringify(ledgerOf([])),
      "tools/mutation/pre-triage-survivors.json": JSON.stringify({
        survivors: [],
      }),
      "mutation-floors.json": JSON.stringify({
        groups: { g: { tier: "trust", globs: ["src/webp/**"] } },
      }),
      "pre.json": JSON.stringify(
        reportOf([mutant("1", 1, 11, "Survived")], "src/webp/x.ts"),
      ),
    });
    const result = runFixture(dir, "ledger-check.mjs", "--pre", "pre.json");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/in no cluster/);
  });

  it("keeps the real --pre integration read-only", () => {
    const result = runLiveReadOnly("--pre", prePath);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("ledger: ok");
  });

  it("regenerates a triaged fixture twice and after a genuine input permutation", () => {
    const survivors = [m1, m2, m3].map((entry) => ({
      group: "g",
      key: keyOf(entry),
      anchorKey: identity.anchorKey("src/a/x.ts", entry, SOURCE),
      file: "src/a/x.ts",
      mutatorName: entry.mutatorName,
      function: "f",
      location: entry.location,
    }));
    const initialLedger = JSON.stringify({
      schemaVersion: 1,
      preTriage: { runId: "1", sha: "a".repeat(40), survivorCount: 3 },
      clusters: [
        cluster("already-triaged", {
          disposition: "gap",
          count: 1,
          keys: [survivors[0]!.key],
        }),
      ],
    });
    const root = cliFixture({
      "tools/mutation/ledger.json": initialLedger,
      "tools/mutation/pre-triage-survivors.json": JSON.stringify({
        runId: "1",
        sha: "a".repeat(40),
        survivorCount: survivors.length,
        survivors,
      }),
      "mutation-floors.json": JSON.stringify({
        groups: { g: { tier: "trust", globs: ["src/a/**"] } },
      }),
    });
    const run = () => runFixture(root, "cluster.mjs", "cluster");
    const first = run();
    expect(first.status).toBe(0);
    const output = readFileSync(join(root, "tools/mutation/ledger.json"));
    expect(
      (JSON.parse(output.toString()) as { clusters: Cluster[] }).clusters.every(
        (c) => c.disposition === "pending",
      ),
    ).toBe(true);
    expect(output.equals(Buffer.from(initialLedger))).toBe(false);

    const second = run();
    expect(second.status).toBe(0);
    expect(readFileSync(join(root, "tools/mutation/ledger.json"))).toEqual(
      output,
    );

    const prePath = join(root, "tools/mutation/pre-triage-survivors.json");
    const permuted = JSON.parse(readFileSync(prePath, "utf8")) as {
      survivors: Survivor[];
    };
    permuted.survivors.reverse();
    writeFileSync(prePath, `${JSON.stringify(permuted, null, 2)}\n`);
    expect(permuted.survivors).not.toEqual(survivors);
    const afterPermutation = run();
    expect(afterPermutation.status).toBe(0);
    expect(readFileSync(join(root, "tools/mutation/ledger.json"))).toEqual(
      output,
    );
  });
});

describe("pre-triage survivors and clustering (D-17, D-18)", () => {
  const pre = JSON.parse(
    readFileSync(
      join(packageRoot, "tools", "mutation", "pre-triage-survivors.json"),
      "utf8",
    ),
  ) as {
    runId: string;
    sha: string;
    survivorCount: number;
    survivors: Survivor[];
  };

  it("records the run, the SHA and a consistent count", () => {
    expect(pre.runId).toMatch(/^\d+$/);
    expect(pre.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(pre.survivors).toHaveLength(pre.survivorCount);
    expect(pre.survivors.every((s) => s.function !== "")).toBe(true);
  });

  it("puts every webp survivor in exactly one cluster (tracer)", () => {
    const webp = pre.survivors.filter((s) => s.group === "webp");
    expect(webp.length).toBeGreaterThan(0);
    const clusters = clusterTools.clusterSurvivors(webp);
    expect(clusters.length).toBeGreaterThan(0);
    const keys = clusters.flatMap((c) => c.keys);
    expect(keys.toSorted()).toEqual(webp.map((s) => s.key).toSorted());
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("determinism and partition (D-22)", () => {
  const pre = JSON.parse(
    readFileSync(
      join(packageRoot, "tools", "mutation", "pre-triage-survivors.json"),
      "utf8",
    ),
  ) as { survivors: Survivor[] };
  const shuffled = (list: Survivor[]) =>
    [...list].sort((a, b) =>
      a.anchorKey.split("").reverse().join("") <
      b.anchorKey.split("").reverse().join("")
        ? -1
        : 1,
    );

  it("clusters a permuted survivor list to the same ledger", () => {
    const a = clusterTools.clusterSurvivors(pre.survivors);
    expect(clusterTools.clusterSurvivors(pre.survivors)).toEqual(a);
    const permuted = shuffled(pre.survivors);
    expect(permuted).not.toEqual(pre.survivors);
    expect(JSON.stringify(clusterTools.clusterSurvivors(permuted))).toBe(
      JSON.stringify(a),
    );
  });

  it("keeps pure clustering and partitioning deterministic", () => {
    const clustered = clusterTools.clusterSurvivors(pre.survivors);
    expect(clusterTools.clusterSurvivors(pre.survivors)).toEqual(clustered);
    const batches = clusterTools.partitionBatches(clustered);
    expect(clusterTools.partitionBatches([...clustered].reverse())).toEqual(
      batches,
    );
  });

  const fake = (file: string, fn: string, n: number, group = "g"): Cluster => ({
    ...cluster(`${group}:${file}:${fn}:M`, {
      group,
      file,
      function: fn,
      count: 1,
    }),
    keys: Array.from(
      { length: 1 },
      (_, i) =>
        `${file}\u0000M\u0000\u0000${n * 100 + i}\u00000\u0000${n * 100 + i}\u00001`,
    ),
  });
  const many = (file: string, count: number, perFn = 1) =>
    Array.from({ length: count }, (_, i) =>
      fake(file, `f${String(Math.floor(i / perFn)).padStart(3, "0")}`, i),
    ).map((c, i) => ({ ...c, id: `${c.id}${i}` }));

  it("never splits a file below the limit across batches and caps at 25", () => {
    const clusters = [
      ...many("src/a.ts", 20),
      ...many("src/b.ts", 20),
      ...many("src/c.ts", 20),
    ];
    const batches = clusterTools.partitionBatches(clusters);
    expect(batches.map((b) => b.clusters.length)).toEqual([20, 20, 20]);
    expect(batches.map((b) => b.id)).toEqual(["g-1", "g-2", "g-3"]);
    expect(batches.every((b) => b.files.length === 1)).toBe(true);
  });

  it("splits a single over-limit file at function boundaries", () => {
    const batches = clusterTools.partitionBatches(many("src/big.ts", 40, 10));
    expect(batches.map((b) => b.clusters.length)).toEqual([20, 20]);
    expect(batches[0]?.clusters.every((id) => /f00[01]/.test(id))).toBe(true);
  });

  it("caps a batch at four src files", () => {
    const clusters = ["a", "b", "c", "d", "e", "f"].flatMap((f) =>
      many(`src/${f}.ts`, 1),
    );
    const batches = clusterTools.partitionBatches(clusters);
    expect(batches.map((b) => b.files.length)).toEqual([4, 2]);
  });
});

describe("deletion proof lexical and interval controls", () => {
  it("selects one named body across declarations, calls, arrows, generators and methods", () => {
    const source = [
      "export function inspect(flag) {",
      '  if (flag) { return "mime"; }',
      '  return "other";',
      "}",
      "inspect();",
      "export async function load(flag: boolean): boolean { return flag; }",
      "export function* values() { yield 1; }",
      "export const arrow = async (flag) => { return flag; };",
      "class Worker { run(flag) { return flag; } }",
      "const toolbox = { work(flag) { return flag; } };",
      "",
    ].join("\n");
    const inspect = deletionProof.functionBounds(source, "inspect");
    expect(source.slice(inspect.start, inspect.end)).toBe(
      '{\n  if (flag) { return "mime"; }\n  return "other";\n}',
    );
    const forms: [string, string][] = [
      ["load", "{ return flag; }"],
      ["values", "{ yield 1; }"],
      ["arrow", "{ return flag; }"],
      ["run", "{ return flag; }"],
      ["work", "{ return flag; }"],
    ];
    for (const [name, body] of forms) {
      const bounds = deletionProof.functionBounds(source, name);
      expect(source.slice(bounds.start, bounds.end), name).toBe(body);
    }
    expect(() =>
      deletionProof.functionBounds(
        "function choose() {}\nfunction choose() {}",
        "choose",
      ),
    ).toThrow(/function choose is ambiguous/);

    const exact = '  if (flag) { return "mime"; }';
    const edited = deletionProof.applyEdits(source, [
      { function: "inspect", before: exact, after: "", occurrence: 0 },
    ]);
    expect(edited.source).toContain('return "other";');
    expect(edited.source).toContain("inspect();");
  });

  it("rejects comment/string-only matches and arbitrary substitutions", () => {
    const comment =
      "function choose() {\n  // const flag = true;\n  const flag = true;\n}\n";
    const string =
      'function choose() {\n  const text = "const flag = true;";\n  return text;\n}\n';
    for (const source of [comment, string])
      expect(() =>
        deletionProof.applyEdits(source, [
          {
            function: "choose",
            before: "const flag = true;",
            after: "",
            occurrence: 0,
          },
        ]),
      ).toThrow(/not an exact lexical source expression/);

    expect(() =>
      deletionProof.applyEdits("function choose() { return true; }", [
        {
          function: "choose",
          before: "return true;",
          after: "return false;",
          occurrence: 0,
        },
      ]),
    ).toThrow(/non-deletion edit/);

    const conditional =
      "function parse() {\n  if (kind) {\n    keep();\n  }\n}\n";
    const retainedBody = deletionProof.applyEdits(conditional, [
      {
        function: "parse",
        before: "if (kind) {\n    keep();\n  }",
        after: "    keep();",
        occurrence: 0,
      },
    ]);
    expect(retainedBody.source).toContain("keep();");
  });

  it("uses half-open overlap so touching deletion endpoints preserve adjacent mutants", () => {
    const source = "abcdef";
    const interval = (start: number, end: number): Mutant => ({
      id: `${start}-${end}`,
      mutatorName: "MethodExpression",
      replacement: "void 0",
      status: "Killed",
      location: {
        start: { line: 1, column: start + 1 },
        end: { line: 1, column: end + 1 },
      },
    });
    const edit = [{ start: 2, end: 4 }];
    expect(deletionProof.affectedBy(interval(0, 2), source, edit)).toBe(false);
    expect(deletionProof.affectedBy(interval(2, 4), source, edit)).toBe(true);
    expect(deletionProof.affectedBy(interval(4, 6), source, edit)).toBe(false);
  });

  it("coalesces only identical anchor maps and rejects conflicting or non-injective maps", () => {
    const shared = phaseVerifier.reconcileAnchorMappings([
      {
        id: "receipt-a",
        anchors: [{ current: "current", original: "original" }],
      },
      {
        id: "receipt-b",
        anchors: [{ current: "current", original: "original" }],
      },
    ]);
    expect([...shared]).toEqual([["current", "original"]]);
    expect(() =>
      phaseVerifier.reconcileAnchorMappings([
        {
          id: "receipt-a",
          anchors: [{ current: "current", original: "original-a" }],
        },
        {
          id: "receipt-b",
          anchors: [{ current: "current", original: "original-b" }],
        },
      ]),
    ).toThrow(/conflicting current-to-original anchor mapping/);
    expect(() =>
      phaseVerifier.reconcileAnchorMappings([
        {
          id: "receipt-a",
          anchors: [{ current: "current-a", original: "original" }],
        },
        {
          id: "receipt-b",
          anchors: [{ current: "current-b", original: "original" }],
        },
      ]),
    ).toThrow(/non-injective original anchor mapping/);
    expect(() =>
      phaseVerifier.evaluate({
        clusters: [],
        survivors: [],
        report: { files: {}, testFiles: {} },
        mode: "batch",
        readTest: () => "",
        symbolAbsent: () => false,
        root: "/tmp/empty-mutation-report",
      }),
    ).toThrow(/empty mutation report/);
  });
});

describe("scoped deletion receipt proof (D-18, D-21)", () => {
  const gapRowFor = (fixture: ReturnType<typeof deletionFixture>) => {
    const sibling = fixture.survivors[1]!;
    return cluster("independent-gap", {
      group: "g",
      file: fixture.file,
      function: "f",
      mutatorName: sibling.mutatorName,
      disposition: "gap",
      count: 1,
      keys: [sibling.key],
      anchors: [sibling.anchorKey],
      test: { file: fixture.testFile, name: "rejects false input" },
    });
  };
  const ledgerFor = (
    fixture: ReturnType<typeof deletionFixture>,
    row = fixture.row,
    reverse = false,
  ) =>
    ledgerOf(reverse ? [gapRowFor(fixture), row] : [row, gapRowFor(fixture)]);
  const inputFor = (fixture: ReturnType<typeof deletionFixture>) => ({
    row: fixture.row,
    root: fixture.root,
    currentSource: fixture.afterSource,
    finalEntry: fixture.finalReport.files[fixture.file]!,
    finalReport: fixture.finalReport,
    readTest: fixture.readTest,
    survivors: fixture.survivors,
    requireFinal: true,
  });
  const cloneInput = (fixture: ReturnType<typeof deletionFixture>) => ({
    ...inputFor(fixture),
    row: structuredClone(fixture.row),
    finalEntry: structuredClone(fixture.finalReport.files[fixture.file]!),
    finalReport: structuredClone(fixture.finalReport),
    survivors: structuredClone(fixture.survivors),
  });
  const rejectBothConsumers = (
    fixture: ReturnType<typeof deletionFixture>,
    row: Cluster,
    finalReport: Report & {
      testFiles: Record<
        string,
        { source: string; tests: { id: string; name: string }[] }
      >;
    },
    expected: RegExp,
  ) => {
    const ledgerProblems = checkLedger({
      ledger: ledgerFor(fixture, row),
      finalReport,
      root: fixture.root,
      groups,
      mode: "final",
    });
    expect(ledgerProblems.join("\n")).toMatch(expected);
    expect(() =>
      phaseVerifier.evaluate({
        clusters: [row],
        survivors: fixture.survivors,
        report: finalReport,
        mode: "batch",
        readTest: fixture.readTest,
        symbolAbsent: () => false,
        root: fixture.root,
      }),
    ).toThrow(expected);
  };

  it("proves an exact function-local deletion in both consumers and preserves mapped siblings", () => {
    const fixture = deletionFixture();
    const proof = deletionProof.validateDeletion(inputFor(fixture));
    expect(proof.problems).toEqual([]);
    expect(proof.anchors).toHaveLength(2);
    expect(fixture.afterSource).toContain("export function other(flag)");
    expect(fixture.afterSource).toContain("  if (flag) {");

    const problems = checkLedger({
      ledger: ledgerFor(fixture),
      finalReport: fixture.finalReport,
      root: fixture.root,
      groups,
      mode: "final",
    });
    expect(problems).toEqual([]);
    expect(
      checkLedger({
        ledger: ledgerFor(fixture),
        finalReport: fixture.finalReport,
        root: fixture.root,
        groups,
        mode: "final",
      }),
    ).toEqual([]);
    expect(
      checkLedger({
        ledger: ledgerFor(fixture, fixture.row, true),
        finalReport: fixture.finalReport,
        root: fixture.root,
        groups,
        mode: "final",
      }),
    ).toEqual([]);
    expect(
      checkLedger({
        ledger: ledgerFor(fixture),
        root: fixture.root,
        groups,
        mode: "pre",
      }),
    ).toEqual([]);

    const reordered = structuredClone(fixture.row);
    reordered.deletion!.removedMutants = (
      reordered.deletion!.removedMutants as unknown[]
    ).toReversed();
    expect(
      deletionProof.validateDeletion({ ...inputFor(fixture), row: reordered })
        .problems,
    ).toEqual([]);

    const result = phaseVerifier.evaluate({
      clusters: [fixture.row],
      survivors: fixture.survivors,
      report: fixture.finalReport,
      mode: "batch",
      readTest: fixture.readTest,
      symbolAbsent: () => false,
      root: fixture.root,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      key: fixture.row.keys[0],
      status: "deleted",
    });
  });

  it("validates embedded evidence when the ignored raw before report is absent", () => {
    const fixture = deletionFixture(true);
    expect(deletionProof.validateDeletion(inputFor(fixture)).problems).toEqual(
      [],
    );
    expect(
      checkLedger({
        ledger: ledgerFor(fixture),
        finalReport: fixture.finalReport,
        root: fixture.root,
        groups,
        mode: "final",
      }),
    ).toEqual([]);
  });

  it("executes the real false-opposite assertion: original passes and the deleted guard fails", () => {
    const fixture = deletionFixture();
    const assertion = join(fixture.root, fixture.testFile);
    writeFileSync(join(fixture.root, fixture.file), fixture.beforeSource);
    const original = spawnSync(process.execPath, [assertion], {
      cwd: fixture.root,
      encoding: "utf8",
    });
    expect(original.status, original.stderr).toBe(0);
    writeFileSync(join(fixture.root, fixture.file), fixture.afterSource);
    const broken = spawnSync(process.execPath, [assertion], {
      cwd: fixture.root,
      encoding: "utf8",
    });
    expect(broken.status).not.toBe(0);
    expect(broken.stderr).toMatch(/AssertionError/);
  });

  it("fails closed on a shallow file clone, then passes full history after deleting phase-only refs and reports", () => {
    const fixture = deletionFixture();
    execFileSync(
      "git",
      [
        "add",
        "src/example.mjs",
        "tests/rejects-false.mjs",
        "tools/mutation/pre-triage-survivors.json",
        "reports/before.json",
        "reports/final.json",
      ],
      { cwd: fixture.root },
    );
    execFileSync("git", ["commit", "-q", "-m", "squashed scoped edit"], {
      cwd: fixture.root,
    });
    execFileSync("git", ["tag", "phase-only-deletion"], { cwd: fixture.root });
    writeFileSync(join(fixture.root, "audit.txt"), "unrelated later commit\n");
    execFileSync("git", ["add", "audit.txt"], { cwd: fixture.root });
    execFileSync("git", ["commit", "-q", "-m", "later audit"], {
      cwd: fixture.root,
    });

    const holder = tempRoot({});
    const shallowRoot = join(holder, "shallow");
    const fullRoot = join(holder, "full");
    const url = pathToFileURL(fixture.root).href;
    execFileSync("git", ["clone", "-q", "--depth=2", url, shallowRoot]);
    execFileSync("git", ["clone", "-q", url, fullRoot]);
    const withRoot = (root: string) => ({
      ...inputFor(fixture),
      root,
      currentSource: readFileSync(join(root, fixture.file), "utf8"),
      finalEntry: fixture.finalReport.files[fixture.file]!,
      readTest: (path: string) => readFileSync(join(root, path), "utf8"),
    });
    const shallow = deletionProof.validateDeletion(withRoot(shallowRoot));
    expect(shallow.problems.join("\n")).toMatch(
      /beforeRef source unavailable .* full history is required/,
    );

    execFileSync("git", ["tag", "-d", "phase-only-deletion"], {
      cwd: fullRoot,
      stdio: "ignore",
    });
    rmSync(join(fullRoot, "reports", "before.json"));
    expect(deletionProof.validateDeletion(withRoot(fullRoot)).problems).toEqual(
      [],
    );
  });

  it("rejects a restored guard, a changed sibling, a wrong function and stale hashes", () => {
    const fixture = deletionFixture();
    writeFileSync(join(fixture.root, fixture.file), fixture.beforeSource);
    const restored = {
      ...cloneInput(fixture),
      currentSource: fixture.beforeSource,
      finalEntry: {
        ...fixture.finalReport.files[fixture.file]!,
        source: fixture.beforeSource,
      },
    };
    expect(
      deletionProof.validateDeletion(restored).problems.join("\n"),
    ).toMatch(/exact ordered edit chain/);

    const changedSibling = fixture.afterSource.replace(
      'out.push("other")',
      'out.push("changed")',
    );
    writeFileSync(join(fixture.root, fixture.file), changedSibling);
    const sibling = { ...cloneInput(fixture), currentSource: changedSibling };
    expect(deletionProof.validateDeletion(sibling).problems.join("\n")).toMatch(
      /exact ordered edit chain/,
    );
    const changedReport = structuredClone(fixture.finalReport);
    changedReport.files[fixture.file]!.source = changedSibling;
    const ledgerRejected = checkLedger({
      ledger: ledgerFor(fixture),
      finalReport: fixture.finalReport,
      root: fixture.root,
      groups,
      mode: "final",
    });
    expect(ledgerRejected.join("\n")).toMatch(/exact ordered edit chain/);
    expect(() =>
      phaseVerifier.evaluate({
        clusters: [fixture.row],
        survivors: fixture.survivors,
        report: changedReport,
        mode: "batch",
        readTest: fixture.readTest,
        symbolAbsent: () => false,
        root: fixture.root,
      }),
    ).toThrow(/exact ordered edit chain/);

    writeFileSync(join(fixture.root, fixture.file), fixture.afterSource);

    const wrongFunction = cloneInput(fixture);
    wrongFunction.row.deletion!.function = "other";
    expect(
      deletionProof.validateDeletion(wrongFunction).problems.join("\n"),
    ).toMatch(/does not match owned row/);

    const wrongEditFunction = cloneInput(fixture);
    (
      wrongEditFunction.row.deletion!.edits as { function: string }[]
    )[0]!.function = "other";
    expect(
      deletionProof.validateDeletion(wrongEditFunction).problems.join("\n"),
    ).toMatch(/required dead symbol/);

    const wrongOccurrence = cloneInput(fixture);
    (
      wrongOccurrence.row.deletion!.edits as { occurrence: number }[]
    )[0]!.occurrence = 1;
    expect(
      deletionProof.validateDeletion(wrongOccurrence).problems.join("\n"),
    ).toMatch(/occurrence 1 is missing/);

    const otherOnly = fixture.beforeSource.replace(
      /(export function other[\s\S]*?)  if \(flag\) \{/,
      "$1  {",
    );
    writeFileSync(join(fixture.root, fixture.file), otherOnly);
    expect(
      deletionProof
        .validateDeletion({
          ...cloneInput(fixture),
          currentSource: otherOnly,
          finalEntry: {
            ...fixture.finalReport.files[fixture.file]!,
            source: otherOnly,
          },
        })
        .problems.join("\n"),
    ).toMatch(/exact ordered edit chain/);
    writeFileSync(join(fixture.root, fixture.file), fixture.afterSource);

    const stale = cloneInput(fixture);
    stale.row.deletion!.beforeSourceSha256 = "0".repeat(64);
    expect(deletionProof.validateDeletion(stale).problems.join("\n")).toMatch(
      /before source hash mismatch/,
    );

    const unavailable = cloneInput(fixture);
    unavailable.row.deletion!.beforeRef =
      "0000000000000000000000000000000000000000";
    expect(
      deletionProof.validateDeletion(unavailable).problems.join("\n"),
    ).toMatch(/beforeRef source unavailable/);

    const noEdits = cloneInput(fixture);
    noEdits.row.deletion!.edits = [];
    expect(deletionProof.validateDeletion(noEdits).problems.join("\n")).toMatch(
      /required dead symbol/,
    );
  });

  it("rejects incomplete affected inventory, duplicate edits and a missing detected successor", () => {
    const fixture = deletionFixture();
    const inventory = cloneInput(fixture);
    inventory.row.deletion!.removedMutants = (
      inventory.row.deletion!.removedMutants as unknown[]
    ).slice(1);
    expect(
      deletionProof.validateDeletion(inventory).problems.join("\n"),
    ).toMatch(/does not exactly account/);
    rejectBothConsumers(
      fixture,
      inventory.row,
      inventory.finalReport,
      /does not exactly account/,
    );

    const duplicate = cloneInput(fixture);
    duplicate.row.deletion!.edits = [
      ...(duplicate.row.deletion!.edits as unknown[]),
      ...(duplicate.row.deletion!.edits as unknown[]),
    ];
    expect(
      deletionProof.validateDeletion(duplicate).problems.join("\n"),
    ).toMatch(/occurrence 0 is missing|overlaps an earlier edit/);
    rejectBothConsumers(
      fixture,
      duplicate.row,
      duplicate.finalReport,
      /occurrence 0 is missing|overlaps an earlier edit/,
    );

    const counterpart = cloneInput(fixture);
    counterpart.row.deletion!.detectedSuccessors = [];
    expect(
      deletionProof.validateDeletion(counterpart).problems.join("\n"),
    ).toMatch(/exactly one successor or counterfactual/);
    rejectBothConsumers(
      fixture,
      counterpart.row,
      counterpart.finalReport,
      /exactly one successor or counterfactual/,
    );

    const emptyFinal = {
      ...cloneInput(fixture),
      finalEntry: null,
      finalReport: {
        files: {} as Report["files"],
        testFiles: fixture.finalReport.testFiles,
      },
    };
    expect(
      deletionProof.validateDeletion(emptyFinal).problems.join("\n"),
    ).toMatch(/final report entry is required/);
    const emptyReport = {
      files: {} as Report["files"],
      testFiles: fixture.finalReport.testFiles,
    };
    expect(
      checkLedger({
        ledger: ledgerFor(fixture),
        finalReport: emptyReport,
        root: fixture.root,
        groups,
        mode: "final",
      }).join("\n"),
    ).toMatch(/final report entry is required/);
    expect(() =>
      phaseVerifier.evaluate({
        clusters: [fixture.row],
        survivors: fixture.survivors,
        report: emptyReport,
        mode: "batch",
        readTest: fixture.readTest,
        symbolAbsent: () => false,
        root: fixture.root,
      }),
    ).toThrow(/final report entry is required/);

    for (const status of ["Survived", "NoCoverage", "Ignored"]) {
      const invalid = cloneInput(fixture);
      invalid.finalReport.files[fixture.file]!.mutants[0]!.status = status;
      expect(
        deletionProof.validateDeletion(invalid).problems.join("\n"),
      ).toMatch(new RegExp(`detected successor is ${status}`));
      if (status === "Ignored")
        invalid.finalReport.files[fixture.file]!.mutants[0]!.statusReason =
          "Ignored using a comment";
      rejectBothConsumers(
        fixture,
        invalid.row,
        invalid.finalReport,
        new RegExp(`detected successor is ${status}`),
      );
    }
    const noKilledBy = cloneInput(fixture);
    noKilledBy.finalReport.files[fixture.file]!.mutants[0]!.killedBy = [];
    expect(
      deletionProof.validateDeletion(noKilledBy).problems.join("\n"),
    ).toMatch(/killedBy does not name the real test/);
    rejectBothConsumers(
      fixture,
      noKilledBy.row,
      noKilledBy.finalReport,
      /killedBy does not name the real test/,
    );

    const staleTest = cloneInput(fixture);
    staleTest.finalReport.testFiles![fixture.testFile]!.source +=
      "// stale report test\n";
    rejectBothConsumers(
      fixture,
      staleTest.row,
      staleTest.finalReport,
      /detected successor test source is absent or stale/,
    );
    const wrongTest = cloneInput(fixture);
    (
      wrongTest.row.deletion!.detectedSuccessors as { test: { name: string } }[]
    )[0]!.test.name = "missing named assertion";
    rejectBothConsumers(
      fixture,
      wrongTest.row,
      wrongTest.finalReport,
      /detected successor test source is absent or stale/,
    );
  });

  it("rejects altered embedded evidence, stale raw report, missing ownership and ignored opposite", () => {
    const fixture = deletionFixture();
    const evidence = cloneInput(fixture);
    (evidence.row.deletion!.beforeEvidence as { source: string }).source +=
      "// tampered\n";
    expect(
      deletionProof.validateDeletion(evidence).problems.join("\n"),
    ).toMatch(/canonical digest mismatch/);

    const reportHash = cloneInput(fixture);
    reportHash.row.deletion!.beforeReportSha256 = "f".repeat(64);
    expect(
      deletionProof.validateDeletion(reportHash).problems.join("\n"),
    ).toMatch(/retained before report hash mismatch/);

    const changedSlice = cloneInput(fixture);
    const rawPath = join(fixture.root, "reports/before.json");
    const rawReport = JSON.parse(readFileSync(rawPath, "utf8"));
    rawReport.files[fixture.file].source += "// raw-only change\n";
    const changedBytes = `${JSON.stringify(rawReport, null, 2)}\n`;
    writeFileSync(rawPath, changedBytes);
    changedSlice.row.deletion!.beforeReportSha256 = sha256(changedBytes);
    expect(
      deletionProof.validateDeletion(changedSlice).problems.join("\n"),
    ).toMatch(/slice differs from embedded evidence/);
    writeFileSync(rawPath, fixture.reportBytes);

    const membership = cloneInput(fixture);
    membership.row.keys = ["foreign\u0000key"];
    membership.row.count = 1;
    expect(
      deletionProof.validateDeletion(membership).problems.join("\n"),
    ).toMatch(/absent from its immutable origin/);

    const ignored = structuredClone(fixture.finalReport);
    const opposite = ignored.files[fixture.file]!.mutants[1]!;
    opposite.status = "Ignored";
    opposite.statusReason = "Ignored using a comment";
    expect(
      checkLedger({
        ledger: ledgerFor(fixture),
        finalReport: ignored,
        root: fixture.root,
        groups,
        mode: "final",
      }).join("\n"),
    ).toMatch(/comment-Ignored mutant matches no equivalent row/);
    expect(() =>
      phaseVerifier.evaluate({
        clusters: [fixture.row],
        survivors: fixture.survivors,
        report: ignored,
        mode: "batch",
        readTest: fixture.readTest,
        symbolAbsent: () => false,
        root: fixture.root,
      }),
    ).toThrow(/comment-Ignored mutant has no valid equivalent owner/);

    const duplicateOwner = {
      ...structuredClone(fixture.row),
      id: "scoped-dead-duplicate-owner",
    };
    const duplicateLedger = ledgerOf([
      fixture.row,
      duplicateOwner,
      gapRowFor(fixture),
    ]);
    expect(
      checkLedger({
        ledger: duplicateLedger,
        finalReport: fixture.finalReport,
        root: fixture.root,
        groups,
        mode: "final",
      }).join("\n"),
    ).toMatch(/in 2 clusters/);
    expect(() =>
      phaseVerifier.evaluate({
        clusters: [fixture.row, duplicateOwner],
        survivors: fixture.survivors,
        report: fixture.finalReport,
        mode: "batch",
        readTest: fixture.readTest,
        symbolAbsent: () => false,
        root: fixture.root,
      }),
    ).toThrow(/duplicate owned key/);
  });
});

describe("real iloc boundary receipt", () => {
  it("admits the exact typed header integer-boundary operation", () => {
    const source = [
      "function parseIloc(payload) {",
      "  if (payload.length < 2) {",
      "    throw new Error('too short');",
      "  }",
      "  return payload.length;",
      "}",
      "",
    ].join("\n");
    const edit = {
      operation: "iloc-header-integer-boundary",
      function: "parseIloc",
      before: "payload.length < 2",
      after: "payload.length <= 1",
      occurrence: 0,
    };

    expect(() => deletionProof.applyEdits(source, [edit])).not.toThrow();
    expect(deletionProof.applyEdits(source, [edit]).source).toContain(
      "payload.length <= 1",
    );
    expect(() =>
      deletionProof.applyEdits(source, [
        { ...edit, after: "payload.length <= 0" },
      ]),
    ).toThrow(/non-deletion edit/);
  });

  it("proves both real receipts through validation, evaluate, and ledger checks without claiming a global final pass", () => {
    const { bundle, finalReport } = loadIlocBoundaryBundle();
    const root = materializeIlocBoundaryBundle(bundle, finalReport);
    const finalEntry = finalReport.files["src/isobmff/iloc.ts"]!;
    const readTest = (file: string) => readFileSync(join(root, file), "utf8");
    const deadRows = bundle.candidateRows.filter(
      (row) => row.disposition === "dead",
    );
    const proofs = deadRows.map((row) =>
      deletionProof.validateDeletion({
        row,
        root,
        currentSource: finalEntry.source,
        finalEntry,
        finalReport,
        readTest,
        survivors: bundle.selectedMembers,
        requireFinal: true,
      }),
    );

    expect(deadRows).toHaveLength(2);
    for (const [index, proof] of proofs.entries()) {
      expect(proof.problems, deadRows[index]!.id).toEqual([]);
      expect(proof.anchors).toHaveLength(154);
      expect(proof.removedMutants).toHaveLength(4);
      expect(proof.auxiliaryMutants).toHaveLength(3);
      expect(
        proof.anchors.some((pair) =>
          pair.original.includes("payload.length <= 2"),
        ),
      ).toBe(false);
      expect(
        proof.anchors.some((pair) => pair.original.includes("indexSize >= 0")),
      ).toBe(false);
      expect(
        proof.auxiliaryMutants.every(
          (mutant) => mutant.status === "Killed" && mutant.killedBy.length > 0,
        ),
      ).toBe(true);
      expect(
        proof.auxiliaryMutants
          .map((mutant) =>
            deletionProof.normalizeReceiptSource(mutant.replacement),
          )
          .sort(),
      ).toEqual([
        "indexSize === 0",
        "payload.length < 1",
        "payload.length > 1",
      ]);
      expect(
        proof.removedMutants
          .filter((mutant) => mutant.status === "Killed")
          .map((mutant) => mutant.replacement)
          .sort(),
      ).toEqual(["indexSize <= 0", "payload.length >= 2"]);
    }
    expect(proofs[0]!.anchors).toEqual(proofs[1]!.anchors);
    expect(
      proofs[0]!.removedMutants.filter((mutant) => mutant.status === "Killed"),
    ).toHaveLength(2);

    const scopedLedger = {
      schemaVersion: 1,
      preTriage: null,
      clusters: bundle.candidateRows,
    };
    const scopedGroups = {
      isobmff: { tier: "trust", globs: ["src/isobmff/**"] },
    };
    expect(
      checkLedger({
        ledger: scopedLedger,
        finalReport,
        root,
        groups: scopedGroups,
        mode: "pre",
      }),
    ).toEqual([]);

    const evaluated = phaseVerifier.evaluate({
      clusters: bundle.candidateRows,
      survivors: bundle.selectedMembers,
      report: finalReport,
      mode: "batch",
      readTest,
      symbolAbsent: () => true,
      root,
      ledgerClusters: bundle.candidateRows,
      selectedFiles: ["src/isobmff/iloc.ts"],
    });
    expect(evaluated).toHaveLength(12);
    expect(
      evaluated.filter((member) => member.status === "deleted"),
    ).toHaveLength(2);
    expect(
      evaluated.filter((member) => member.status === "Ignored"),
    ).toHaveLength(10);
    const outerConditionals = finalEntry.mutants.filter(
      (mutant) =>
        mutant.mutatorName === "ConditionalExpression" &&
        ["true", "false"].includes(mutant.replacement ?? "") &&
        mutant.status === "Killed" &&
        mutant.location.start.line === 233,
    );
    const outerLogical = finalEntry.mutants.filter(
      (mutant) =>
        mutant.mutatorName === "LogicalOperator" &&
        deletionProof.normalizeReceiptSource(mutant.replacement ?? "") ===
          "layout.hasIndexSize ||\nindexSize !== 0" &&
        mutant.status === "Killed",
    );
    expect(outerConditionals).toHaveLength(2);
    expect(outerLogical).toHaveLength(1);
    expect(
      [...outerConditionals, ...outerLogical].every(
        (mutant) => (mutant.killedBy ?? []).length > 0,
      ),
    ).toBe(true);

    const fullFixture = createRealAdmissionCliFixture();
    writeIlocCliStage(fullFixture, bundle, "final");
    const fullLedger = JSON.parse(
      readFileSync(
        join(packageRoot, "tools", "mutation", "ledger.json"),
        "utf8",
      ),
    ) as CliLedger;
    const candidateOverlay = overlayIlocCandidateRows(
      fullLedger,
      bundle.candidateRows,
    );
    const floors = JSON.parse(
      readFileSync(join(packageRoot, "mutation-floors.json"), "utf8"),
    ) as {
      groups: Record<string, { tier: string; globs: string[] }>;
    };
    expect(candidateOverlay.clusters.flatMap((row) => row.keys)).toHaveLength(
      1919,
    );
    const fullFinalProblems = checkLedger({
      ledger: candidateOverlay,
      finalReport,
      root: fullFixture.productRoot,
      groups: floors.groups,
      mode: "final",
    });
    const targetReceiptIds = new Set(deadRows.map((row) => row.id));
    expect(
      fullFinalProblems.filter((problem) =>
        [...targetReceiptIds].some((id) => problem.startsWith(`${id}:`)),
      ),
    ).toEqual([]);
    const survivorSuffix = ": Survived in a trust group in the final report";
    const actualSurvivors = fullFinalProblems
      .filter((problem) => problem.endsWith(survivorSuffix))
      .sort();
    const expectedSurvivors = finalEntry.mutants
      .filter((mutant) => ["Survived", "NoCoverage"].includes(mutant.status))
      .map(
        (mutant) =>
          `${identity.mutantKey("src/isobmff/iloc.ts", mutant).replaceAll("\u0000", "|")}${survivorSuffix}`,
      )
      .sort();
    expect(expectedSurvivors).toHaveLength(7);
    expect(actualSurvivors).toEqual(expectedSurvivors);

    const expectedPreexistingIncomplete = candidateOverlay.clusters
      .flatMap((row) => {
        if (row.disposition === "pending")
          return [`${row.id}: cluster is pending`];
        if (row.disposition === "dead" && row.file !== "src/isobmff/iloc.ts")
          return [
            `${row.id}: final report entry is required for scoped deletion proof`,
          ];
        if (row.disposition === "gap") {
          const file = row.test?.file;
          const name = row.test?.name;
          const path =
            typeof file === "string"
              ? join(fullFixture.productRoot, file)
              : null;
          if (path === null || !existsSync(path))
            return [`${row.id}: gap test file ${file} is missing`];
          if (
            typeof name !== "string" ||
            name === "" ||
            !readFileSync(path, "utf8").includes(name)
          )
            return [
              `${row.id}: gap test ${file} does not contain test name ${JSON.stringify(name)}`,
            ];
        }
        return [];
      })
      .sort();
    expect(
      fullFinalProblems
        .filter((problem) => !actualSurvivors.includes(problem))
        .sort(),
    ).toEqual(expectedPreexistingIncomplete);
  }, 30_000);

  it("accepts the real header and final candidate stages through the copied read-only CLI", () => {
    const { bundle } = loadIlocBoundaryBundle();
    const packetPath =
      "exifcleaner-node/tests/fixtures/mutation/iloc-boundary-reports.json.gz";

    const headerFixture = createRealAdmissionCliFixture();
    const headerReportPath = writeIlocCliStage(headerFixture, bundle, "header");
    const header = runRealCli(headerFixture, [
      "--iloc-candidate",
      "--report",
      headerReportPath,
      "--stage",
      "header",
      "--packet",
      packetPath,
    ]);
    expect(String(header.error?.message ?? header.stderr)).toBe("");
    expect(header.status, String(header.stdout)).toBe(0);
    const headerProof = JSON.parse(String(header.stdout)) as {
      mode: string;
      stage: string;
      originalKeys: string[];
      auxiliary: { replacement: string; status: string; killedBy: unknown[] }[];
    };
    expect(headerProof).toMatchObject({
      mode: "candidate-only",
      stage: "header",
    });
    expect(
      headerProof.originalKeys.some((key) =>
        key.includes("payload.length <= 2"),
      ),
    ).toBe(true);
    expect(
      headerProof.originalKeys.some((key) => key.includes("indexSize >= 0")),
    ).toBe(true);
    expect(
      headerProof.auxiliary.map(({ replacement, status }) => ({
        replacement,
        status,
      })),
    ).toEqual(
      expect.arrayContaining([
        { replacement: "payload.length < 1", status: "Killed" },
        { replacement: "payload.length > 1", status: "Killed" },
      ]),
    );
    expect(
      headerProof.auxiliary.every((mutant) => mutant.killedBy.length > 0),
    ).toBe(true);

    const finalFixture = createRealAdmissionCliFixture();
    const finalReportPath = writeIlocCliStage(finalFixture, bundle, "final");
    const finalArgs = [
      "--iloc-candidate",
      "--report",
      finalReportPath,
      "--stage",
      "final",
      "--packet",
      packetPath,
    ];
    const final = runRealCli(finalFixture, finalArgs);
    expect(String(final.error?.message ?? final.stderr)).toBe("");
    expect(final.status, String(final.stdout)).toBe(0);
    const finalProof = JSON.parse(String(final.stdout)) as {
      mode: string;
      stage: string;
      reportSha256: string;
      sourceSha256: string;
      mappedPerReceipt: number;
      originalKeys: string[];
      receipts: {
        id: string;
        keys: string[];
        mapped: number;
        removed: { anchor: string; status: string }[];
        auxiliary: {
          anchor: string;
          replacement: string;
          status: string;
          killedBy: unknown[];
        }[];
      }[];
      batchProof: Record<string, unknown>[];
    };
    expect(finalProof.stage).toBe("final");
    expect(finalProof.mappedPerReceipt).toBe(154);
    expect(finalProof.receipts).toHaveLength(2);
    expect(
      finalProof.receipts.every(
        (receipt) =>
          receipt.removed.length === 4 &&
          receipt.auxiliary.length === 3 &&
          receipt.auxiliary.every(
            (mutant) =>
              mutant.status === "Killed" && mutant.killedBy.length > 0,
          ),
      ),
    ).toBe(true);
    expect(finalProof.batchProof).toHaveLength(12);
    expect(
      finalProof.batchProof.filter((member) => member.status === "deleted"),
    ).toHaveLength(2);
    expect(
      finalProof.batchProof.filter((member) => member.status === "Ignored"),
    ).toHaveLength(10);

    const permuted = withCliFileMutation(
      finalFixture,
      packetPath,
      (original) => {
        const packet = JSON.parse(
          gunzipSync(original).toString("utf8"),
        ) as IlocBoundaryBundle;
        packet.candidateRows = [...packet.candidateRows]
          .reverse()
          .map((row) => {
            const anchors = row.anchors ?? [];
            if (anchors.length === 0)
              return { ...row, keys: [...row.keys].reverse() };
            const pairs = row.keys
              .map((key, index) => ({ key, anchor: anchors[index]! }))
              .reverse();
            return {
              ...row,
              keys: pairs.map((pair) => pair.key),
              anchors: pairs.map((pair) => pair.anchor),
            };
          });
        packet.selectedMembers.reverse();
        return gzipSync(Buffer.from(JSON.stringify(packet)));
      },
      () => runRealCli(finalFixture, finalArgs),
    );
    expect(String(permuted.error?.message ?? permuted.stderr)).toBe("");
    expect(permuted.status, String(permuted.stdout)).toBe(0);
    const permutedProof = JSON.parse(
      String(permuted.stdout),
    ) as typeof finalProof;
    const compareText = (left: string, right: string) =>
      left < right ? -1 : left > right ? 1 : 0;
    const normalizeProof = (proof: typeof finalProof) => ({
      mode: proof.mode,
      stage: proof.stage,
      reportSha256: proof.reportSha256,
      sourceSha256: proof.sourceSha256,
      mappedPerReceipt: proof.mappedPerReceipt,
      originalKeys: [...proof.originalKeys].sort(),
      receipts: proof.receipts
        .map((receipt) => ({
          ...receipt,
          keys: [...receipt.keys].sort(),
          removed: [...receipt.removed].sort((left, right) =>
            compareText(left.anchor, right.anchor),
          ),
          auxiliary: [...receipt.auxiliary].sort((left, right) =>
            compareText(left.anchor, right.anchor),
          ),
        }))
        .sort((left, right) => compareText(left.id, right.id)),
      batchProof: proof.batchProof
        .map((member) => JSON.stringify(member))
        .sort(),
    });
    expect(normalizeProof(permutedProof)).toEqual(normalizeProof(finalProof));

    expectCliRejection(
      runRealCli(finalFixture, [
        "--iloc-candidate",
        "--report",
        finalReportPath,
        "--stage",
        "other",
        "--packet",
        packetPath,
      ]),
      "stage must be header or final",
    );
    expectCliRejection(
      withCliFileRemoval(finalFixture, packetPath, () =>
        runRealCli(finalFixture, finalArgs),
      ),
      "ENOENT",
    );
    expectCliRejection(
      withCliFileMutation(
        finalFixture,
        finalReportPath,
        (original) => Buffer.concat([original, Buffer.from("\n")]),
        () => runRealCli(finalFixture, finalArgs),
      ),
      "report bytes differ from the retained actual Stryker report",
    );
    expectCliRejection(
      withCliFileRemoval(finalFixture, finalReportPath, () =>
        runRealCli(finalFixture, finalArgs),
      ),
      "ENOENT",
    );
    expectCliRejection(
      withCliFileMutation(
        finalFixture,
        "exifcleaner-node/src/isobmff/iloc.ts",
        (original) => Buffer.concat([original, Buffer.from("\n")]),
        () => runRealCli(finalFixture, finalArgs),
      ),
      "report source differs from the contained candidate copy",
    );
    expectCliRejection(
      withCliFileMutation(
        finalFixture,
        packetPath,
        (original) => {
          const packet = JSON.parse(
            gunzipSync(original).toString("utf8"),
          ) as IlocBoundaryBundle;
          packet.provenance.stageReports.final.sourceSha256 = "0".repeat(64);
          return gzipSync(Buffer.from(JSON.stringify(packet)));
        },
        () => runRealCli(finalFixture, finalArgs),
      ),
      "packet bindings differ from actual Stryker evidence",
    );
    expectCliRejection(
      withCliFileMutation(
        finalFixture,
        packetPath,
        (original) => {
          const packet = JSON.parse(
            gunzipSync(original).toString("utf8"),
          ) as IlocBoundaryBundle;
          packet.candidateRows[0]!.keys[0] = "forged original key";
          return gzipSync(Buffer.from(JSON.stringify(packet)));
        },
        () => runRealCli(finalFixture, finalArgs),
      ),
      "row inventory differs from the pinned four-row, 12-key candidate",
    );
    expectCliRejection(
      withCliFileMutation(
        finalFixture,
        packetPath,
        (original) => {
          const packet = JSON.parse(
            gunzipSync(original).toString("utf8"),
          ) as IlocBoundaryBundle;
          packet.selectedMembers[0]!.key = "forged immutable key";
          return gzipSync(Buffer.from(JSON.stringify(packet)));
        },
        () => runRealCli(finalFixture, finalArgs),
      ),
      "immutable member inventory differs from the pinned 12 original keys",
    );
  }, 45_000);

  it("rejects widened or stale receipts through both consumers and preserves order-independent proof", () => {
    const { bundle, finalReport } = loadIlocBoundaryBundle();
    const root = materializeIlocBoundaryBundle(bundle, finalReport);
    const finalEntry = finalReport.files["src/isobmff/iloc.ts"]!;
    const readTest = (file: string) => readFileSync(join(root, file), "utf8");
    const deadIndex = bundle.candidateRows.findIndex(
      (row) => row.disposition === "dead",
    );
    const makeInput = (row: Cluster, report = finalReport) => ({
      row,
      root,
      currentSource: report.files["src/isobmff/iloc.ts"]!.source,
      finalEntry: report.files["src/isobmff/iloc.ts"]!,
      finalReport: report,
      readTest,
      survivors: bundle.selectedMembers,
      requireFinal: true,
    });
    const rejectThroughConsumers = (
      row: Cluster,
      report: typeof finalReport,
      pattern: RegExp,
    ) => {
      const rows = structuredClone(bundle.candidateRows);
      rows[deadIndex] = row;
      const groups = { isobmff: { tier: "trust", globs: ["src/isobmff/**"] } };
      expect(
        checkLedger({
          ledger: { schemaVersion: 1, preTriage: null, clusters: rows },
          finalReport: report,
          root,
          groups,
          mode: "pre",
        }).join("\n"),
      ).toMatch(pattern);
      expect(() =>
        phaseVerifier.evaluate({
          clusters: rows,
          survivors: bundle.selectedMembers,
          report,
          mode: "batch",
          readTest,
          symbolAbsent: () => true,
          root,
          ledgerClusters: rows,
          selectedFiles: ["src/isobmff/iloc.ts"],
        }),
      ).toThrow(pattern);
    };
    const base = bundle.candidateRows[deadIndex]!;

    const widened = structuredClone(base);
    const widenedEdit = (widened.deletion!.edits as { after: string }[])[0]!;
    widenedEdit.after = "payload.length <= 0";
    expect(
      deletionProof.validateDeletion(makeInput(widened)).problems.join("\n"),
    ).toMatch(/exact ordered two-operation chain/);
    rejectThroughConsumers(
      widened,
      finalReport,
      /exact ordered two-operation chain/,
    );

    const wrongFile = structuredClone(base);
    wrongFile.file = "src/isobmff/admission.ts";
    expect(
      deletionProof.validateDeletion(makeInput(wrongFile)).problems.join("\n"),
    ).toMatch(/restricted to src\/isobmff\/iloc\.ts/);

    const wrongFunction = structuredClone(base);
    wrongFunction.function = "classifyIloc";
    expect(
      deletionProof
        .validateDeletion(makeInput(wrongFunction))
        .problems.join("\n"),
    ).toMatch(/receipt function does not match owned row/);

    const wrongOccurrence = structuredClone(base);
    (
      wrongOccurrence.deletion!.edits as { occurrence: number }[]
    )[0]!.occurrence = 1;
    expect(
      deletionProof
        .validateDeletion(makeInput(wrongOccurrence))
        .problems.join("\n"),
    ).toMatch(/exact ordered two-operation chain/);

    const wrongLayoutToken = structuredClone(base);
    (wrongLayoutToken.deletion!.edits as { before: string }[])[1]!.before =
      "if (layout.hasIndexSize || indexSize > 0)";
    expect(
      deletionProof
        .validateDeletion(makeInput(wrongLayoutToken))
        .problems.join("\n"),
    ).toMatch(/exact ordered two-operation chain/);

    const emptyOwner = structuredClone(base);
    emptyOwner.keys = [];
    emptyOwner.count = 0;
    expect(
      deletionProof.validateDeletion(makeInput(emptyOwner)).problems.join("\n"),
    ).toMatch(/single-key children of the immutable origin/);

    const duplicateOwner = structuredClone(base);
    duplicateOwner.keys = [base.keys[0]!, base.keys[0]!];
    duplicateOwner.count = 2;
    expect(
      deletionProof
        .validateDeletion(makeInput(duplicateOwner))
        .problems.join("\n"),
    ).toMatch(/single-key children of the immutable origin/);

    const wrongOrigin = structuredClone(base);
    wrongOrigin.originClusterId = "forged-origin";
    expect(
      deletionProof
        .validateDeletion(makeInput(wrongOrigin))
        .problems.join("\n"),
    ).toMatch(/single-key children of the immutable origin/);

    const staleSource = structuredClone(base);
    staleSource.deletion!.beforeSourceSha256 = "0".repeat(64);
    expect(
      deletionProof
        .validateDeletion(makeInput(staleSource))
        .problems.join("\n"),
    ).toMatch(/before source hash mismatch/);

    const missingAffected = structuredClone(base);
    (missingAffected.deletion!.removedMutants as unknown[]).pop();
    expect(
      deletionProof
        .validateDeletion(makeInput(missingAffected))
        .problems.join("\n"),
    ).toMatch(/removedMutants does not exactly account/);

    const missingSuccessor = structuredClone(base);
    missingSuccessor.deletion!.detectedSuccessors = [];
    expect(
      deletionProof
        .validateDeletion(makeInput(missingSuccessor))
        .problems.join("\n"),
    ).toMatch(/exactly one successor or counterfactual/);

    const missingKiller = structuredClone(finalReport);
    const headerOpposite = missingKiller.files[
      "src/isobmff/iloc.ts"
    ]!.mutants.find((mutant) => mutant.replacement === "payload.length > 1")!;
    headerOpposite.killedBy = [];
    expect(
      deletionProof
        .validateDeletion(makeInput(base, missingKiller))
        .problems.join("\n"),
    ).toMatch(/unresolved killedBy test evidence/);

    const staleTest = structuredClone(finalReport);
    staleTest.testFiles["tests/isobmff_writer.test.ts"]!.source +=
      "// stale candidate source\n";
    expect(
      deletionProof
        .validateDeletion(makeInput(base, staleTest))
        .problems.join("\n"),
    ).toMatch(/final test source is absent or stale/);

    const permuted = structuredClone(finalReport);
    permuted.files["src/isobmff/iloc.ts"]!.mutants.reverse();
    for (const entry of Object.values(permuted.testFiles))
      entry.tests.reverse();
    const proof = deletionProof.validateDeletion(makeInput(base, permuted));
    expect(proof.problems).toEqual([]);
    expect(
      proof.anchors.map((pair) => `${pair.current}\n${pair.original}`).sort(),
    ).toEqual(
      deletionProof
        .validateDeletion(makeInput(base))
        .anchors.map((pair) => `${pair.current}\n${pair.original}`)
        .sort(),
    );
    expect(finalEntry.mutants).toHaveLength(157);
  }, 30_000);
});

describe("copied Phase 67 schedule inventory controls", () => {
  it("accepts the exact live prerequisite schedule without plan metadata normalization", () => {
    const fixture = createRealAdmissionCliFixture();
    expect(
      existsSync(
        resolve(
          fixture.root,
          "exifcleaner-node/node_modules/typescript/lib/typescript.js",
        ),
      ),
    ).toBe(false);
    const schedulePlanPaths = [
      ...Array.from({ length: 32 }, (_, index) => index + 16),
      52,
      53,
      54,
      55,
    ].map((plan) => `${phaseDir}/67-${String(plan).padStart(2, "0")}-PLAN.md`);
    for (const path of schedulePlanPaths) {
      expect(readFileSync(resolve(fixture.root, path))).toEqual(
        readFileSync(resolve(workspaceRoot, path)),
      );
    }

    const result = runRealCli(fixture, ["--inventory"]);
    expect(
      result.error,
      `CLI spawn error: ${result.error?.message ?? "none"}`,
    ).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "triage inventory: 32 batches, 586 clusters, 1919 members",
    );
  }, 30_000);

  it("rejects copied wave and predecessor drift for Plans53, 54, 55, 16 and 17", () => {
    const fixture = createRealAdmissionCliFixture();
    const controls = [
      { plan: 53, field: "wave", diagnostic: "67-53: wrong wave" },
      { plan: 53, field: "dependency", diagnostic: "67-53: wrong predecessor" },
      { plan: 54, field: "wave", diagnostic: "67-54: wrong wave" },
      { plan: 54, field: "dependency", diagnostic: "67-54: wrong predecessor" },
      { plan: 55, field: "wave", diagnostic: "67-55: wrong wave" },
      { plan: 55, field: "dependency", diagnostic: "67-55: wrong predecessor" },
      { plan: 16, field: "wave", diagnostic: "67-16: wrong wave" },
      { plan: 16, field: "dependency", diagnostic: "67-16: wrong predecessor" },
      { plan: 17, field: "wave", diagnostic: "67-17: wrong wave" },
      { plan: 17, field: "dependency", diagnostic: "67-17: wrong predecessor" },
    ] as const;

    for (const control of controls) {
      const relativePath = `${phaseDir}/67-${String(control.plan).padStart(2, "0")}-PLAN.md`;
      const liveBytes = readFileSync(resolve(workspaceRoot, relativePath));
      const copiedPath = resolve(fixture.root, relativePath);
      const result = withCliFileMutation(
        fixture,
        relativePath,
        (original) => {
          const source = original.toString("utf8");
          const matcher =
            control.field === "wave"
              ? /^wave: \d+$/m
              : /^depends_on: \["67-\d+"\]$/m;
          const changed = source.replace(
            matcher,
            control.field === "wave" ? "wave: 999" : 'depends_on: ["67-99"]',
          );
          expect(changed).not.toBe(source);
          return Buffer.from(changed);
        },
        () => runRealCli(fixture, ["--inventory"]),
      );
      expectCliRejection(result, control.diagnostic);
      expect(readFileSync(copiedPath)).toEqual(liveBytes);
      expect(readFileSync(resolve(workspaceRoot, relativePath))).toEqual(
        liveBytes,
      );
    }
  }, 60_000);
});

describe("real isobmff-3 multi-source final report", () => {
  it("registers report-specific successor evidence on both iloc receipts", () => {
    const ledger = JSON.parse(
      readFileSync(
        join(packageRoot, "tools", "mutation", "ledger.json"),
        "utf8",
      ),
    ) as {
      clusters: Cluster[];
    };
    const receipts = ledger.clusters.filter(
      (row) =>
        (row.deletion?.edits as { operation?: string }[] | undefined)?.[0]
          ?.operation === "iloc-header-integer-boundary",
    );
    expect(receipts).toHaveLength(2);
    for (const row of receipts) {
      const deletion = row.deletion as { reportBindings?: unknown[] };
      const reportBindings = deletion.reportBindings;
      expect(
        Array.isArray(reportBindings),
        `${row.id} reportBindings`,
      ).toBe(true);
      expect(reportBindings!.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("proves every registered report fixture through both receipts and the copied batch CLI", () => {
    const { rows, reports } = loadRegisteredIsobmff3Reports();
    const survivors = JSON.parse(
      readFileSync(
        join(packageRoot, "tools", "mutation", "pre-triage-survivors.json"),
        "utf8",
      ),
    ).survivors as Survivor[];
    expect(reports.length).toBeGreaterThanOrEqual(2);
    for (const registered of reports) {
      const {
        binding,
        variant,
        fixture: reportFixture,
        report,
      } = registered;
      const cliFixture = createRealIsobmff3BatchCliFixture(
        registered.compressed,
      );
      const reportPath = resolve(cliFixture.root, cliFixture.reportPath);
      const copiedReport = JSON.parse(
        readFileSync(reportPath, "utf8"),
      ) as Report;
      expect(deletionProof.canonicalReceiptJson(copiedReport)).toBe(
        deletionProof.canonicalReceiptJson(report),
      );
      const finalEntry = copiedReport.files["src/isobmff/iloc.ts"]!;
      const readTest = (file: string) =>
        readFileSync(join(cliFixture.productRoot, file), "utf8");
      for (const row of rows) {
        const proof = deletionProof.validateDeletion({
          row,
          root: cliFixture.productRoot,
          currentSource: finalEntry.source,
          finalEntry,
          finalReport: copiedReport as Report & {
            testFiles: NonNullable<Report["testFiles"]>;
          },
          readTest,
          survivors,
          requireFinal: true,
        });
        expect(proof.problems, `${reportFixture.path} / ${row.id}`).toEqual([]);
      }

      const result = runRealCli(cliFixture, [
        "--batch",
        "isobmff-3",
        "--mode",
        "batch",
        "--report",
        cliFixture.reportPath,
      ]);
      expect(
        result.error,
        `CLI spawn error: ${result.error?.message ?? "none"}`,
      ).toBeUndefined();
      expect(
        result.status,
        `CLI stdout:\n${result.stdout}\nCLI stderr:\n${result.stderr}`,
      ).toBe(0);
      const output = JSON.parse(String(result.stdout)) as {
        batch: string;
        mode: string;
        reportSha256: string;
        clusters: number;
        members: number;
        proof: { key: string; status: string }[];
      };
      const batch = cliFixture.manifest.batches.find(
        (candidate) => candidate.id === "isobmff-3",
      )!;
      const copiedLedger = JSON.parse(
        readFileSync(resolve(cliFixture.root, cliFixture.ledgerPath), "utf8"),
      ) as CliLedger;
      const selectedRows = copiedLedger.clusters.filter((row) =>
        batch.clusterIds.includes(row.originClusterId ?? row.id),
      );
      const expectedKeys = selectedRows.flatMap((row) => row.keys).sort();
      expect(batch.clusterIds).toHaveLength(15);
      expect(
        new Set(selectedRows.map((row) => row.originClusterId ?? row.id)).size,
      ).toBe(15);
      expect(Object.keys(report.files).sort()).toEqual(
        batch.sourceFiles.slice().sort(),
      );
      expect(output).toMatchObject({
        batch: "isobmff-3",
        mode: "batch",
        reportSha256: variant.rawSha256,
        clusters: selectedRows.length,
        members: 45,
      });
      expect(output.proof).toHaveLength(45);
      expect(output.proof.map((member) => member.key).sort()).toEqual(
        expectedKeys,
      );
      expect(binding.canonicalSha256).toBe(
        sha256(deletionProof.canonicalReceiptJson(report)),
      );
    }
  }, 60_000);

  it("discovers added registry rows and refuses missing registered fixture bytes", () => {
    const { rows, bindings } = loadIsobmff3ReportRegistry();
    const disposableRoot = tempRoot({});
    const ledger = JSON.parse(
      readFileSync(
        join(packageRoot, "tools", "mutation", "ledger.json"),
        "utf8",
      ),
    ) as {
      clusters: Cluster[];
    };
    const disposableRows = ledger.clusters.filter(
      (row) =>
        (row.deletion?.edits as { operation?: string }[] | undefined)?.[0]
          ?.operation === "iloc-header-integer-boundary",
    );
    for (const row of disposableRows) {
      const deletion = row.deletion as {
        reportBindings: Isobmff3ReportBinding[];
      };
      const added = structuredClone(bindings[0]!);
      added.canonicalSha256 = "f".repeat(64);
      added.variants[0]!.rawSha256 = "e".repeat(64);
      added.variants[0]!.fixtures[0]!.path =
        "tests/fixtures/mutation/added-registry-entry.json.gz";
      deletion.reportBindings.push(added);
    }
    writeFixtureFile(
      disposableRoot,
      "tools/mutation/ledger.json",
      `${JSON.stringify(ledger, null, 2)}\n`,
    );
    const discovered = loadIsobmff3ReportRegistry(disposableRoot);
    expect(discovered.rows).toHaveLength(rows.length);
    expect(discovered.bindings).toHaveLength(bindings.length + 1);
    expect(() => loadRegisteredIsobmff3Reports(disposableRoot)).toThrow();
  });

  it("rejects missing, duplicate, unknown, stale, substituted and escaped report bindings", () => {
    const { rows, reports } = loadRegisteredIsobmff3Reports();
    const registered = reports[0]!;
    const fixture = createRealIsobmff3BatchCliFixture(registered.compressed);
    const survivors = JSON.parse(
      readFileSync(
        join(packageRoot, "tools", "mutation", "pre-triage-survivors.json"),
        "utf8",
      ),
    ).survivors as Survivor[];
    const report = registered.report as Report & {
      testFiles: NonNullable<Report["testFiles"]>;
    };
    const finalEntry = report.files["src/isobmff/iloc.ts"]!;
    const makeInput = (row: Cluster, productRoot = fixture.productRoot) => ({
      row,
      root: productRoot,
      currentSource: finalEntry.source,
      finalEntry,
      finalReport: report,
      readTest: (file: string) => readFileSync(join(productRoot, file), "utf8"),
      survivors,
      requireFinal: true,
    });
    const bindingIndex = (row: Cluster) =>
      (
        row.deletion as { reportBindings: Isobmff3ReportBinding[] }
      ).reportBindings.findIndex(
        (binding) =>
          binding.canonicalSha256 === registered.binding.canonicalSha256,
      );

    const empty = structuredClone(rows[0]!);
    (
      empty.deletion as { reportBindings: Isobmff3ReportBinding[] }
    ).reportBindings = [];
    expect(
      deletionProof.validateDeletion(makeInput(empty)).problems.join("\n"),
    ).toMatch(/no committed report-specific bindings/);

    const missing = structuredClone(rows[0]!);
    (
      missing.deletion as { reportBindings: Isobmff3ReportBinding[] }
    ).reportBindings.splice(bindingIndex(missing), 1);
    expect(
      deletionProof.validateDeletion(makeInput(missing)).problems.join("\n"),
    ).toMatch(/selects 0 committed report-specific bindings/);

    const duplicate = structuredClone(rows[0]!);
    const duplicateBindings = (
      duplicate.deletion as { reportBindings: Isobmff3ReportBinding[] }
    ).reportBindings;
    duplicateBindings.push(
      structuredClone(duplicateBindings[bindingIndex(duplicate)]!),
    );
    expect(
      deletionProof.validateDeletion(makeInput(duplicate)).problems.join("\n"),
    ).toMatch(/duplicate report identity/);

    const unknown = structuredClone(rows[0]!);
    (
      unknown.deletion as { reportBindings: Isobmff3ReportBinding[] }
    ).reportBindings[bindingIndex(unknown)]!.canonicalSha256 = "0".repeat(64);
    expect(
      deletionProof.validateDeletion(makeInput(unknown)).problems.join("\n"),
    ).toMatch(/selects 0 committed report-specific bindings/);

    const staleRawDigest = structuredClone(rows[0]!);
    const staleBinding = (
      staleRawDigest.deletion as { reportBindings: Isobmff3ReportBinding[] }
    ).reportBindings[bindingIndex(staleRawDigest)]!;
    staleBinding.variants[0]!.rawSha256 = "0".repeat(64);
    expect(
      deletionProof
        .validateDeletion(makeInput(staleRawDigest))
        .problems.join("\n"),
    ).toMatch(/registered report fixture raw bytes or digest mismatch/);

    const changedBytesFixture = createRealIsobmff3BatchCliFixture(
      registered.compressed,
    );
    const changedBytes = structuredClone(rows[0]!);
    const changedBytesBinding = (
      changedBytes.deletion as { reportBindings: Isobmff3ReportBinding[] }
    ).reportBindings[bindingIndex(changedBytes)]!;
    const changedBytesPath = join(
      changedBytesFixture.productRoot,
      changedBytesBinding.variants[0]!.fixtures[0]!.path,
    );
    const changedCompressed = readFileSync(changedBytesPath);
    const lastByteIndex = changedCompressed.length - 1;
    changedCompressed[lastByteIndex] = changedCompressed[lastByteIndex]! ^ 1;
    writeFileSync(changedBytesPath, changedCompressed);
    expect(
      deletionProof
        .validateDeletion(
          makeInput(changedBytes, changedBytesFixture.productRoot),
        )
        .problems.join("\n"),
    ).toMatch(/registered report fixture compressed bytes or digest mismatch/);

    const changedContentFixture = createRealIsobmff3BatchCliFixture(
      registered.compressed,
    );
    const changedContent = structuredClone(rows[0]!);
    const changedContentBinding = (
      changedContent.deletion as { reportBindings: Isobmff3ReportBinding[] }
    ).reportBindings[bindingIndex(changedContent)]!;
    const changedContentVariant = changedContentBinding.variants[0]!;
    const changedContentFixtureRecord = changedContentVariant.fixtures[0]!;
    const changedReport = structuredClone(report);
    changedReport.files["src/isobmff/iloc.ts"]!.source += "\n";
    const changedRaw = Buffer.from(JSON.stringify(changedReport));
    const changedGzip = gzipSync(changedRaw, { level: 9 });
    writeFileSync(
      join(changedContentFixture.productRoot, changedContentFixtureRecord.path),
      changedGzip,
    );
    changedContentVariant.rawBytes = changedRaw.length;
    changedContentVariant.rawSha256 = sha256(changedRaw);
    changedContentFixtureRecord.gzipBytes = changedGzip.length;
    changedContentFixtureRecord.gzipSha256 = sha256(changedGzip);
    expect(
      deletionProof
        .validateDeletion(
          makeInput(changedContent, changedContentFixture.productRoot),
        )
        .problems.join("\n"),
    ).toMatch(
      /registered fixture does not match the complete supplied report identity/,
    );

    const wrongDirect = structuredClone(rows[0]!);
    const wrongBinding = (
      wrongDirect.deletion as { reportBindings: Isobmff3ReportBinding[] }
    ).reportBindings[bindingIndex(wrongDirect)]!;
    const firstOldAnchor = wrongBinding.successors[0]!.oldAnchor;
    const first = wrongBinding.successors.find(
      (successor) => successor.oldAnchor === firstOldAnchor,
    )!;
    const actualMutant = finalEntry.mutants.find(
      (mutant) =>
        identity.anchorKey("src/isobmff/iloc.ts", mutant, finalEntry.source) ===
        first.finalAnchor,
    )!;
    const killed = new Set((actualMutant.killedBy ?? []).map(String));
    const unrelated = Object.entries(report.testFiles).flatMap(
      ([file, entry]) =>
        entry.tests
          .filter((test) => !killed.has(String(test.id)))
          .map((test) => ({
            id: String(test.id),
            file,
            name: test.name,
            sourceSha256: sha256(entry.source),
          })),
    )[0]!;
    first.test = unrelated;
    expect(
      deletionProof
        .validateDeletion(makeInput(wrongDirect))
        .problems.join("\n"),
    ).toMatch(/detected successor killedBy does not name the real test/);

    const traversal = structuredClone(rows[0]!);
    (
      traversal.deletion as { reportBindings: Isobmff3ReportBinding[] }
    ).reportBindings[bindingIndex(traversal)]!.variants[0]!.fixtures[0]!.path =
      "../../outside.json.gz";
    expect(
      deletionProof.validateDeletion(makeInput(traversal)).problems.join("\n"),
    ).toMatch(/unsafe relative path/);

    const evidencePath = join(
      fixture.productRoot,
      "tests",
      "fixtures",
      "mutation",
      "a1-report-escape.json.gz",
    );
    const outsideRoot = mkdtempSync(
      join(tmpdir(), "exifcleaner-a1-report-escape-"),
    );
    const outside = join(outsideRoot, "outside.json.gz");
    writeFileSync(outside, registered.compressed);
    try {
      symlinkSync(outside, evidencePath);
      const escaped = structuredClone(rows[0]!);
      (
        escaped.deletion as { reportBindings: Isobmff3ReportBinding[] }
      ).reportBindings[bindingIndex(escaped)]!.variants[0]!.fixtures[0]!.path =
        "tests/fixtures/mutation/a1-report-escape.json.gz";
      expect(
        deletionProof.validateDeletion(makeInput(escaped)).problems.join("\n"),
      ).toMatch(/symlink escapes root/);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects stale and malformed evidence independently through the copied batch CLI", () => {
    const { bytes } = loadIsobmff3BatchReport();
    const fixture = createRealIsobmff3BatchCliFixture(bytes);
    const resealReportProvenance = (report: Report, raw: Buffer) => {
      const canonicalSha256 = sha256(
        deletionProof.canonicalReceiptJson(report),
      );
      const reportFixturePath = `tests/fixtures/mutation/a1-negative-control-${canonicalSha256.slice(0, 12)}.json.gz`;
      const compressed = gzipSync(raw, { level: 9 });
      writeFixtureFile(
        fixture.root,
        `exifcleaner-node/${reportFixturePath}`,
        compressed,
      );
      const ledgerPath = resolve(fixture.root, fixture.ledgerPath);
      chmodSync(ledgerPath, 0o644);
      const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as CliLedger;
      const rows = ledger.clusters.filter(
        (row) =>
          (row.deletion?.edits as { operation?: string }[] | undefined)?.[0]
            ?.operation === "iloc-header-integer-boundary",
      );
      expect(rows).toHaveLength(2);
      const binding = {
        canonicalSha256,
        variants: [
          {
            rawSha256: sha256(raw),
            rawBytes: raw.length,
            fixtures: [
              {
                path: reportFixturePath,
                gzipSha256: sha256(compressed),
                gzipBytes: compressed.length,
              },
            ],
          },
        ],
        successors: (
          rows[0]!.deletion as { reportBindings: Isobmff3ReportBinding[] }
        ).reportBindings[0]!.successors,
      } satisfies Isobmff3ReportBinding;
      for (const row of rows) {
        const deletion = row.deletion as {
          reportBindings: Isobmff3ReportBinding[];
        };
        deletion.reportBindings = [
          ...deletion.reportBindings.filter(
            (existing) => existing.canonicalSha256 !== canonicalSha256,
          ),
          structuredClone(binding),
        ];
      }
      writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
      chmodSync(ledgerPath, 0o444);
    };
    const runReportMutation = (mutate: (report: Report) => void) =>
      withCliFileMutation(
        fixture,
        fixture.reportPath,
        (original) => {
          const report = JSON.parse(original.toString("utf8")) as Report;
          mutate(report);
          const raw = Buffer.from(JSON.stringify(report));
          resealReportProvenance(report, raw);
          return raw;
        },
        () =>
          runRealCli(fixture, [
            "--batch",
            "isobmff-3",
            "--mode",
            "batch",
            "--report",
            fixture.reportPath,
          ]),
      );

    const sourcePath = "exifcleaner-node/src/isobmff/iloc.ts";
    const oldExplanation = "validated nibble width is nonnegative";
    const newExplanation = "the validated nibble width cannot be negative";
    const updateExplanation = (source: string) => {
      expect(source).toContain(
        "// Stryker disable next-line ConditionalExpression: redundant-guard-after-typed-check",
      );
      expect(source).toContain(oldExplanation);
      const updated = source.replace(oldExplanation, newExplanation);
      expect(updated).not.toBe(source);
      return updated;
    };
    let changedSource = "";
    const equivalentCommentOnly = withCliFileMutation(
      fixture,
      sourcePath,
      (original) => {
        changedSource = updateExplanation(original.toString("utf8"));
        return Buffer.from(changedSource);
      },
      () =>
        runReportMutation((report) => {
          const entry = report.files["src/isobmff/iloc.ts"]!;
          const updated = updateExplanation(entry.source);
          expect(updated).toBe(changedSource);
          entry.source = updated;
        }),
    );
    expectCliRejection(
      equivalentCommentOnly,
      "iloc final evidence differs from the measured 157-mutant source stage",
    );

    expectCliRejection(
      runReportMutation((report) => {
        report.files["src/isobmff/iloc.ts"]!.source +=
          "\n// stale report source\n";
      }),
      "src/isobmff/iloc.ts: stale report source",
    );

    expectCliRejection(
      runReportMutation((report) => {
        const removed = report.files["src/isobmff/iloc.ts"]!.mutants.pop();
        expect(removed).toBeDefined();
      }),
      "iloc final evidence differs from the measured 157-mutant source stage",
    );

    expectCliRejection(
      runReportMutation((report) => {
        const testFile = report.testFiles?.["tests/isobmff_writer.test.ts"];
        expect(testFile).toBeDefined();
        testFile!.source += "\n// stale current test source\n";
      }),
      "iloc final test source is absent or stale",
    );

    expectCliRejection(
      runReportMutation((report) => {
        const tests = report.testFiles?.["tests/isobmff_writer.test.ts"]?.tests;
        expect(tests && tests.length).toBeGreaterThan(1);
        tests![1]!.id = tests![0]!.id;
      }),
      "iloc final test table has an empty, unnamed or duplicate row",
    );

    expectCliRejection(
      runReportMutation((report) => {
        const mutants = report.files["src/isobmff/iloc.ts"]!.mutants;
        const detected = mutants.find(
          (mutant) =>
            mutant.status === "Killed" && (mutant.killedBy?.length ?? 0) > 0,
        );
        expect(detected).toBeDefined();
        detected!.killedBy = [];
      }),
      "has unresolved killedBy test evidence",
    );

    expect(readFileSync(join(fixture.root, fixture.reportPath))).toEqual(
      gunzipSync(bytes),
    );
    const fixturePath = join(
      packageRoot,
      "tests",
      "fixtures",
      "mutation",
      "isobmff-3-multisource-final.json.gz",
    );
    expect(sha256(readFileSync(fixturePath))).toBe(
      "75acf56c7337c99043dde6c56903dcd3240998bc0ab33a32ced4442da4a4903c",
    );
  }, 120_000);
});

describe("phase verifier Vitest declaration paths", () => {
  const withVitest = (source: string) =>
    /^\s*import\b/m.test(source)
      ? source
      : `import { describe, it } from "vitest";\n${source}`;
  const declarationStatus = (source: string, name: string) =>
    phaseVerifier.vitestDeclarationStatus(withVitest(source), name);
  const historicalTestAbsentFromBaseline = (name: string, source: string) =>
    phaseVerifier.historicalTestAbsentFromBaseline(name, withVitest(source));

  it("recognizes a fully qualified nested static suite and case path", () => {
    const source = `describe("outer suite", () => {
  describe("inner suite", () => {
    it("case title", () => {});
  });
});
`;
    const name = "outer suite > inner suite > case title";
    expect(declarationStatus(source, name)).toBe("declared");
    expect(historicalTestAbsentFromBaseline(name, source)).toBe(false);
  });

  it("recognizes only imported Vitest registration aliases and namespace calls", () => {
    const aliased = `import { describe as group, it as caseTest } from "vitest";
group("suite", () => { caseTest("alias case", () => {}); });`;
    expect(declarationStatus(aliased, "suite > alias case")).toBe("declared");
    const namespaced = `import * as vitest from "vitest";
vitest.describe("suite", () => { vitest.it("namespace case", () => {}); });`;
    expect(declarationStatus(namespaced, "suite > namespace case")).toBe(
      "declared",
    );
    const unbound = `describe("suite", () => { it("global case", () => {}); });`;
    expect(
      phaseVerifier.vitestDeclarationStatus(unbound, "suite > global case"),
    ).toBe("unsupported");
    const shadowed = withVitest(
      `describe("suite", (it) => { it("shadowed case", () => {}); });`,
    );
    expect(declarationStatus(shadowed, "suite > shadowed case")).toBe(
      "unsupported",
    );
  });

  it("does not match a case title under a different suite or a missing/renamed title", () => {
    const source = `describe("right suite", () => { it("case title", () => {}); });`;
    expect(declarationStatus(source, "wrong suite > case title")).toBe(
      "absent",
    );
    expect(declarationStatus(source, "right suite > missing title")).toBe(
      "absent",
    );
    expect(declarationStatus(source, "right suite > renamed title")).toBe(
      "absent",
    );
  });

  it("ignores labels that appear only in comments and string contents", () => {
    const source = `// describe("suite", () => { it("case", () => {}); });
const sample = 'describe("suite", () => { it("case", () => {}); });';`;
    expect(declarationStatus(source, "suite > case")).toBe("absent");
  });

  it("does not treat regex contents after a closing parenthesis as declarations", () => {
    const source = `describe("suite", () => {
  if (true) /it("phantom case", () => {})/;
});`;
    expect(declarationStatus(source, "suite > phantom case")).toBe("absent");
  });

  it("ignores uncalled helper declarations and fails closed inside control flow", () => {
    const source = `describe("suite", () => {
  function unusedHelper() { it("helper-only case", () => {}); }
  if (false) { it("conditional case", () => {}); }
});`;
    expect(declarationStatus(source, "suite > helper-only case")).toBe(
      "absent",
    );
    expect(declarationStatus(source, "suite > conditional case")).toBe(
      "unsupported",
    );
  });

  it("fails closed when a called helper contains a suite registration", () => {
    const source = `describe("suite", () => {
  function registerHelper() { it("helper case", () => {}); }
  registerHelper();
});`;
    expect(declarationStatus(source, "suite > helper case")).toBe(
      "unsupported",
    );
  });

  it("fails closed for getter-triggered registration and tagged-template calls", () => {
    const getter = `describe("suite", () => {
  const value = { get register() { it("getter case", () => {}); return true; } };
  value.register;
});`;
    expect(declarationStatus(getter, "suite > getter case")).toBe(
      "unsupported",
    );

    const setter = `describe("suite", () => {
  const value = { set register(next) { it("setter case", () => {}); } };
  value.register = true;
});`;
    expect(declarationStatus(setter, "suite > setter case")).toBe(
      "unsupported",
    );

    const destructuredGetter = `describe("suite", () => {
  const { register } = { get register() { it("destructured getter case", () => {}); return true; } };
});`;
    expect(
      declarationStatus(destructuredGetter, "suite > destructured getter case"),
    ).toBe("unsupported");

    const assignedDestructuredGetter = `describe("suite", () => {
  let register;
  ({ register } = { get register() { it("assigned destructured getter case", () => {}); return true; } });
});`;
    expect(
      declarationStatus(
        assignedDestructuredGetter,
        "suite > assigned destructured getter case",
      ),
    ).toBe("unsupported");

    const aliasedDestructuredGetter = `describe("suite", () => {
  const value = { get register() { it("aliased destructured getter case", () => {}); return true; } };
  const { register } = value;
});`;
    expect(
      declarationStatus(
        aliasedDestructuredGetter,
        "suite > aliased destructured getter case",
      ),
    ).toBe("unsupported");

    const assignedAliasedDestructuredGetter = `describe("suite", () => {
  const value = { get register() { it("assigned aliased getter case", () => {}); return true; } };
  let register;
  ({ register } = value);
});`;
    expect(
      declarationStatus(
        assignedAliasedDestructuredGetter,
        "suite > assigned aliased getter case",
      ),
    ).toBe("unsupported");

    const dynamicAccessor = `describe("suite", () => {
  const key = registrationKey;
  const getter = { get register() { return true; } };
  const setter = { set register(next) {} };
  getter[key];
  setter[key] = true;
});`;
    expect(
      declarationStatus(
        dynamicAccessor,
        "suite > possible accessor registration",
      ),
    ).toBe("unsupported");

    const computedAccessor = `describe("suite", () => {
  const key = registrationKey;
  const value = { get [key]() { return true; } };
  value.register;
});`;
    expect(
      declarationStatus(
        computedAccessor,
        "suite > possible computed accessor registration",
      ),
    ).toBe("unsupported");

    const tagged = `function register(value) { it(value, () => {}); }
describe("suite", () => { register\`tagged case\`; });`;
    expect(declarationStatus(tagged, "suite > tagged case")).toBe(
      "unsupported",
    );
  });

  it("requires a statically recognized callback for a named case", () => {
    const source = `describe("suite", () => { it("case title", caseBody); });`;
    expect(declarationStatus(source, "suite > case title")).toBe("unsupported");
  });

  it("fails closed when an invoked inline callback contains a suite registration", () => {
    const source = `describe("suite", () => {
  cases.forEach(() => it("callback case", () => {}));
});`;
    expect(declarationStatus(source, "suite > callback case")).toBe(
      "unsupported",
    );
  });

  it("fails closed for unknown registration-time helpers and supports Vitest options overloads", () => {
    const helper = withVitest(
      `describe("suite", () => { registrationHarness.registerTests(); });`,
    );
    expect(declarationStatus(helper, "suite > imported helper case")).toBe(
      "unsupported",
    );
    const options = withVitest(`describe("suite", () => {
  it("options before callback", { timeout: 100 }, () => {});
  it("timeout after callback", () => {}, 200);
});`);
    expect(declarationStatus(options, "suite > options before callback")).toBe(
      "declared",
    );
    expect(declarationStatus(options, "suite > timeout after callback")).toBe(
      "declared",
    );
    const invalidCallback = withVitest(
      `describe("suite", () => { it("numeric callback", 42); });`,
    );
    expect(declarationStatus(invalidCallback, "suite > numeric callback")).toBe(
      "unsupported",
    );
    const invalidOptionsOrder = withVitest(`describe("suite", () => {
  it("deprecated options order", () => {}, { timeout: 100 });
});`);
    expect(
      declarationStatus(
        invalidOptionsOrder,
        "suite > deprecated options order",
      ),
    ).toBe("unsupported");
    const identifierOptions = withVitest(`describe("suite", () => {
  it("identifier callback and inline callback", callbackIdentifier, () => {});
});`);
    expect(
      declarationStatus(
        identifierOptions,
        "suite > identifier callback and inline callback",
      ),
    ).toBe("unsupported");

    const computedOptions = withVitest(`describe("suite", () => {
  const options = { [it("computed option registration", () => {})]: 1 };
  it("outer options case", options, () => {});
});`);
    expect(
      declarationStatus(
        computedOptions,
        "suite > computed option registration",
      ),
    ).toBe("unsupported");
    expect(
      declarationStatus(computedOptions, "suite > outer options case"),
    ).toBe("unsupported");

    const getterOptions = withVitest(`describe("suite", () => {
  const options = { get timeout() { it("getter option registration", () => {}); return 100; } };
  it("outer getter options case", options, () => {});
});`);
    expect(
      declarationStatus(getterOptions, "suite > getter option registration"),
    ).toBe("unsupported");
  });

  it("allows only unshadowed path and URL builtins in registration-time initializers", () => {
    const namedImports = `import { describe, it } from "vitest";
import { dirname as pathDirname, join as pathJoin } from "node:path";
import { fileURLToPath as toPath } from "node:url";
const fixturePath = pathJoin(pathDirname(toPath(import.meta.url)), "fixture");
describe("suite", () => { it("present case", () => {}); });`;
    expect(declarationStatus(namedImports, "suite > present case")).toBe(
      "declared",
    );
    expect(declarationStatus(namedImports, "suite > absent case")).toBe(
      "absent",
    );

    const namespaceImport = `import { describe, it } from "vitest";
import * as path from "node:path";
const fixturePath = path.join("fixtures", "heic");
describe("suite", () => { it("present case", () => {}); });`;
    expect(declarationStatus(namespaceImport, "suite > absent case")).toBe(
      "absent",
    );

    const shadowed = `import { describe, it } from "vitest";
import { join as pathJoin } from "node:path";
describe("suite", () => {
  const pathJoin = registrationHarness;
  pathJoin("fixture");
  it("present case", () => {});
});`;
    expect(declarationStatus(shadowed, "suite > present case")).toBe(
      "unsupported",
    );

    const branchShadow = `import { describe, it } from "vitest";
import { join as pathJoin } from "node:path";
describe("suite", () => {
  if (true) {
    const pathJoin = registrationHarness;
    pathJoin("fixture");
  }
  it("present case", () => {});
});`;
    expect(declarationStatus(branchShadow, "suite > absent case")).toBe(
      "unsupported",
    );

    const hoistedPathAlias = `import { describe, it } from "vitest";
import { join as pathJoin } from "node:path";
describe("suite", () => {
  if (true) { var pathJoin = registrationHarness; }
  pathJoin("fixture");
  it("present case", () => {});
});`;
    expect(declarationStatus(hoistedPathAlias, "suite > absent case")).toBe(
      "unsupported",
    );
  });

  it("fails closed for side-effect imports and registration-capable constructors", () => {
    const sideEffectImport = `import { describe, it } from "vitest";
import "./register-tests.js";
describe("suite", () => { it("present case", () => {}); });`;
    expect(declarationStatus(sideEffectImport, "suite > absent case")).toBe(
      "unsupported",
    );
    expect(() =>
      historicalTestAbsentFromBaseline("suite > absent case", sideEffectImport),
    ).toThrow(/historical test declaration path is unsupported/);
    const constructor = withVitest(`describe("suite", () => {
  new RegistrationHarness();
  it("present case", () => {});
});`);
    expect(declarationStatus(constructor, "suite > absent case")).toBe(
      "unsupported",
    );
  });

  it("requires the pinned import closure before proving historical absence", () => {
    const vitestOnly = `import { describe, it, expect } from "vitest";
describe("suite", () => { it("present case", () => { expect(true).toBe(true); }); });`;
    expect(
      historicalTestAbsentFromBaseline("suite > absent case", vitestOnly),
    ).toBe(false);

    const namedApplicationImport = `import { registerHarness } from "../src/test-support.js";
import { describe, it } from "vitest";
describe("suite", () => { it("present case", () => {}); });`;
    expect(
      declarationStatus(namedApplicationImport, "suite > present case"),
    ).toBe("declared");
    expect(
      historicalTestAbsentFromBaseline(
        "suite > absent case",
        namedApplicationImport,
      ),
    ).toBe(false);

    const typeOnlyImport = `import type { TestSupport } from "../src/test-support.js";
import { describe, it } from "vitest";
describe("suite", () => { it("present case", () => {}); });`;
    expect(
      historicalTestAbsentFromBaseline("suite > absent case", typeOnlyImport),
    ).toBe(false);
  });

  it("checks pinned historical import source hashes and edge membership", () => {
    const baselineSha = "b0158fcf775a29cfa61e4409495ae293d83b3a2f";
    const testFile = "tests/isobmff_admission.test.ts";
    const readBaselineFile = (file: string) =>
      execFileSync("git", ["show", `${baselineSha}:${file}`], {
        cwd: packageRoot,
        encoding: "utf8",
      });
    const source = readBaselineFile(testFile);
    expect(
      phaseVerifier.verifyHistoricalTestImportClosure(
        testFile,
        source,
        packageRoot,
        baselineSha,
        readBaselineFile,
      ),
    ).toBe(true);
    expect(
      phaseVerifier.historicalTestAbsentFromBaseline(
        "classifyIsobmffModel ConditionalExpression MethodExpression: a zero removable extent never overlaps and does not empty a mixed item",
        source,
        testFile,
        packageRoot,
        baselineSha,
      ),
    ).toBe(true);

    expect(() =>
      phaseVerifier.verifyHistoricalTestImportClosure(
        testFile,
        `${source}\nimport \"./unlisted-registration-helper.js\";`,
        packageRoot,
        baselineSha,
        readBaselineFile,
      ),
    ).toThrow(/unlisted imported module/);

    expect(() =>
      phaseVerifier.verifyHistoricalTestImportClosure(
        testFile,
        source,
        packageRoot,
        baselineSha,
        (file) =>
          file === "src/isobmff/admission.ts"
            ? `${readBaselineFile(file)}\n// changed historical import member\n`
            : readBaselineFile(file),
      ),
    ).toThrow(/pinned historical source SHA-256 differs/);
  });

  it("allows only unshadowed global Buffer.alloc in registration-time data initializers", () => {
    const globalBuffer =
      withVitest(`const SIMPLE_PRIMARY = { payload: Buffer.alloc(4) };
describe("suite", () => { it("present case", () => {}); });`);
    expect(declarationStatus(globalBuffer, "suite > present case")).toBe(
      "declared",
    );
    expect(declarationStatus(globalBuffer, "suite > absent case")).toBe(
      "absent",
    );

    const shadowedBuffer = withVitest(`describe("suite", () => {
  const Buffer = registrationHarness;
  Buffer.alloc(4);
  it("present case", () => {});
});`);
    expect(declarationStatus(shadowedBuffer, "suite > present case")).toBe(
      "unsupported",
    );
    const importedBuffer = `import { describe, it } from "vitest";
import { Buffer } from "node:buffer";
const SIMPLE_PRIMARY = Buffer.alloc(4);
describe("suite", () => { it("present case", () => {}); });`;
    expect(declarationStatus(importedBuffer, "suite > present case")).toBe(
      "unsupported",
    );
    const hoistedBuffer =
      withVitest(`if (true) { var Buffer = registrationHarness; }
const SIMPLE_PRIMARY = Buffer.alloc(4);
describe("suite", () => { it("present case", () => {}); });`);
    expect(declarationStatus(hoistedBuffer, "suite > present case")).toBe(
      "unsupported",
    );

    const reassignedAllocation = withVitest(`Buffer.alloc = () => {
  it("registered from reassigned Buffer", () => {});
  return Buffer.from([]);
};
describe("suite", () => { Buffer.alloc(4); });`);
    expect(
      declarationStatus(
        reassignedAllocation,
        "suite > registered from reassigned Buffer",
      ),
    ).toBe("unsupported");

    const reassignedGlobal =
      withVitest(`Buffer = { alloc: () => it("registered from reassigned global", () => {}) };
describe("suite", () => { Buffer.alloc(4); });`);
    expect(
      declarationStatus(
        reassignedGlobal,
        "suite > registered from reassigned global",
      ),
    ).toBe("unsupported");

    const reassignedAlias = withVitest(`const B = Buffer;
B.alloc = () => {
  it("registered from Buffer alias", () => {});
  return Buffer.from([]);
};
describe("suite", () => { Buffer.alloc(4); });`);
    expect(
      declarationStatus(
        reassignedAlias,
        "suite > registered from Buffer alias",
      ),
    ).toBe("unsupported");

    const globalObjectAlias = withVitest(`const g = globalThis;
g.Buffer = { alloc: () => it("registered from global alias", () => {}) };
describe("suite", () => { Buffer.alloc(4); });`);
    expect(
      declarationStatus(
        globalObjectAlias,
        "suite > registered from global alias",
      ),
    ).toBe("unsupported");

    const dynamicBufferMember = withVitest(`const method = "alloc";
Buffer[method] = () => it("registered from dynamic Buffer member", () => {});
describe("suite", () => { Buffer.alloc(4); });`);
    expect(
      declarationStatus(
        dynamicBufferMember,
        "suite > registered from dynamic Buffer member",
      ),
    ).toBe("unsupported");

    const dynamicGlobalMember = withVitest(`const key = "Buffer";
globalThis[key] = { alloc: () => it("registered from dynamic global member", () => {}) };
describe("suite", () => { Buffer.alloc(4); });`);
    expect(
      declarationStatus(
        dynamicGlobalMember,
        "suite > registered from dynamic global member",
      ),
    ).toBe("unsupported");

    const destructuredBufferAlias =
      withVitest(`const { Buffer: B } = globalThis;
B.alloc = () => it("registered from destructured Buffer alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        destructuredBufferAlias,
        "suite > registered from destructured Buffer alias",
      ),
    ).toBe("unsupported");

    const destructuredBufferWrite =
      withVitest(`({ alloc: globalThis.Buffer.alloc } = {
  alloc: () => it("registered from destructuring assignment", () => {}),
});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        destructuredBufferWrite,
        "suite > registered from destructuring assignment",
      ),
    ).toBe("unsupported");

    const assignedBufferAlias = withVitest(`let B;
B = Buffer;
B.alloc = () => it("registered from assigned Buffer alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        assignedBufferAlias,
        "suite > registered from assigned Buffer alias",
      ),
    ).toBe("unsupported");

    const assignedGlobalAlias = withVitest(`let g;
g = globalThis;
g.Buffer = { alloc: () => it("registered from assigned global alias", () => {}) };
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        assignedGlobalAlias,
        "suite > registered from assigned global alias",
      ),
    ).toBe("unsupported");

    const assignedDestructuredBufferAlias = withVitest(`let B;
({ Buffer: B } = globalThis);
B.alloc = () => it("registered from assigned destructured Buffer alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        assignedDestructuredBufferAlias,
        "suite > registered from assigned destructured Buffer alias",
      ),
    ).toBe("unsupported");

    const arrayBindingBufferAlias = withVitest(`const [B] = [Buffer];
B.alloc = () => it("registered from array binding alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        arrayBindingBufferAlias,
        "suite > registered from array binding alias",
      ),
    ).toBe("unsupported");

    const arrayAssignmentBufferAlias = withVitest(`let B;
[B] = [Buffer];
B.alloc = () => it("registered from array assignment alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        arrayAssignmentBufferAlias,
        "suite > registered from array assignment alias",
      ),
    ).toBe("unsupported");

    const conditionalArrayBindingAlias =
      withVitest(`const [B] = flag ? [Buffer] : [Buffer];
B.alloc = () => it("registered from conditional array binding alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        conditionalArrayBindingAlias,
        "suite > registered from conditional array binding alias",
      ),
    ).toBe("unsupported");

    const conditionalArrayAssignmentAlias = withVitest(`let B;
[B] = flag ? [Buffer] : [Buffer];
B.alloc = () => it("registered from conditional array assignment alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        conditionalArrayAssignmentAlias,
        "suite > registered from conditional array assignment alias",
      ),
    ).toBe("unsupported");

    const conditionalBufferAlias = withVitest(`const B = flag ? Buffer : Buffer;
B.alloc = () => it("registered from conditional alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        conditionalBufferAlias,
        "suite > registered from conditional alias",
      ),
    ).toBe("unsupported");

    const dynamicGlobalBufferAlias = withVitest(`const g = globalThis;
const B = g[key];
B.alloc = () => it("registered from dynamic global Buffer alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        dynamicGlobalBufferAlias,
        "suite > registered from dynamic global Buffer alias",
      ),
    ).toBe("unsupported");

    const arrayDefaultBufferAlias = withVitest(`const [B = Buffer] = [];
B.alloc = () => it("registered from array default alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        arrayDefaultBufferAlias,
        "suite > registered from array default alias",
      ),
    ).toBe("unsupported");

    const objectDefaultBufferAlias = withVitest(`const { B = Buffer } = {};
B.alloc = () => it("registered from object default alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        objectDefaultBufferAlias,
        "suite > registered from object default alias",
      ),
    ).toBe("unsupported");

    const nestedObjectBufferAlias = withVitest(`const holder = { Buffer };
holder.Buffer.alloc = () => it("registered from nested object alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        nestedObjectBufferAlias,
        "suite > registered from nested object alias",
      ),
    ).toBe("unsupported");

    const nestedArrayBufferAlias = withVitest(`const holder = [Buffer];
holder[0].alloc = () => it("registered from nested array alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        nestedArrayBufferAlias,
        "suite > registered from nested array alias",
      ),
    ).toBe("unsupported");

    const restBufferAlias = withVitest(`const { ...holder } = globalThis;
holder.Buffer.alloc = () => it("registered from rest Buffer alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        restBufferAlias,
        "suite > registered from rest Buffer alias",
      ),
    ).toBe("unsupported");

    const objectPropertyBufferAlias =
      withVitest(`const { Buffer: B } = { Buffer };
B.alloc = () => it("registered from object property Buffer alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        objectPropertyBufferAlias,
        "suite > registered from object property Buffer alias",
      ),
    ).toBe("unsupported");

    const renamedObjectPropertyBufferAlias =
      withVitest(`const { x: B } = { x: Buffer };
B.alloc = () => it("registered from renamed object property alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        renamedObjectPropertyBufferAlias,
        "suite > registered from renamed object property alias",
      ),
    ).toBe("unsupported");

    const unknownObjectBufferAlias =
      withVitest(`const { x: B } = importedObject;
B.alloc = () => it("registered from unknown object alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        unknownObjectBufferAlias,
        "suite > registered from unknown object alias",
      ),
    ).toBe("unsupported");

    for (const moduleName of ["node:buffer", "buffer"]) {
      const importedBufferAlias =
        withVitest(`import { Buffer as B } from "${moduleName}";
B.alloc = () => it("registered from imported Buffer alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
      expect(
        declarationStatus(
          importedBufferAlias,
          "suite > registered from imported Buffer alias",
        ),
      ).toBe("unsupported");
    }

    const namespaceBufferAlias =
      withVitest(`import * as bufferModule from "node:buffer";
bufferModule.Buffer.alloc = () => it("registered from namespace Buffer alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        namespaceBufferAlias,
        "suite > registered from namespace Buffer alias",
      ),
    ).toBe("unsupported");

    for (const moduleName of ["node:buffer", "buffer"]) {
      const defaultBufferModuleAlias =
        withVitest(`import bufferModule from "${moduleName}";
bufferModule.Buffer.alloc = () => it("registered from default Buffer module alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
      expect(
        declarationStatus(
          defaultBufferModuleAlias,
          "suite > registered from default Buffer module alias",
        ),
      ).toBe("unsupported");

      const chainedDefaultBufferModuleAlias =
        withVitest(`import bufferModule from "${moduleName}";
const alias = bufferModule;
alias.Buffer.alloc = () => it("registered from chained default Buffer module alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
      expect(
        declarationStatus(
          chainedDefaultBufferModuleAlias,
          "suite > registered from chained default Buffer module alias",
        ),
      ).toBe("unsupported");

      const moduleBufferConstructorAlias =
        withVitest(`import bufferModule from "${moduleName}";
const B = bufferModule.Buffer;
B.alloc = () => it("registered from module Buffer constructor alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
      expect(
        declarationStatus(
          moduleBufferConstructorAlias,
          "suite > registered from module Buffer constructor alias",
        ),
      ).toBe("unsupported");

      const destructuredModuleBufferAlias =
        withVitest(`import bufferModule from "${moduleName}";
const { Buffer: B } = bufferModule;
B.alloc = () => it("registered from destructured module Buffer alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
      expect(
        declarationStatus(
          destructuredModuleBufferAlias,
          "suite > registered from destructured module Buffer alias",
        ),
      ).toBe("unsupported");

      const dynamicDefaultModuleWrite =
        withVitest(`import bufferModule from "${moduleName}";
bufferModule[key].alloc = () => it("registered from dynamic default module path", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
      expect(
        declarationStatus(
          dynamicDefaultModuleWrite,
          "suite > registered from dynamic default module path",
        ),
      ).toBe("unsupported");

      const dynamicDefaultModuleAlias =
        withVitest(`import bufferModule from "${moduleName}";
const B = bufferModule[key];
B.alloc = () => it("registered from dynamic default module alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
      expect(
        declarationStatus(
          dynamicDefaultModuleAlias,
          "suite > registered from dynamic default module alias",
        ),
      ).toBe("unsupported");
    }

    const namespaceModuleAlias =
      withVitest(`import * as nodeBuffer from "node:buffer";
const alias = nodeBuffer;
alias.Buffer.alloc = () => it("registered from chained namespace Buffer alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        namespaceModuleAlias,
        "suite > registered from chained namespace Buffer alias",
      ),
    ).toBe("unsupported");

    const dynamicNamespaceModuleWrite =
      withVitest(`import * as nodeBuffer from "node:buffer";
nodeBuffer[key].alloc = () => it("registered from dynamic namespace module path", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        dynamicNamespaceModuleWrite,
        "suite > registered from dynamic namespace module path",
      ),
    ).toBe("unsupported");

    const dynamicAliasedNamespaceModuleWrite =
      withVitest(`import * as nodeBuffer from "node:buffer";
const alias = nodeBuffer;
alias[key].alloc = () => it("registered from dynamic aliased namespace path", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        dynamicAliasedNamespaceModuleWrite,
        "suite > registered from dynamic aliased namespace path",
      ),
    ).toBe("unsupported");

    const dynamicNamespaceBufferAlias =
      withVitest(`import * as nodeBuffer from "node:buffer";
const B = nodeBuffer[key];
B.alloc = () => it("registered from dynamic namespace Buffer alias", () => {});
describe("suite", () => { Buffer.alloc(1); });`);
    expect(
      declarationStatus(
        dynamicNamespaceBufferAlias,
        "suite > registered from dynamic namespace Buffer alias",
      ),
    ).toBe("unsupported");

    const bufferInstanceIsNotConstructor = withVitest(`function ignored() {
  const B = Buffer.from([]);
  B.alloc = () => {};
}
const payload = Buffer.alloc(4);
describe("suite", () => { it("present case", () => {}); });`);
    expect(
      declarationStatus(bufferInstanceIsNotConstructor, "suite > present case"),
    ).toBe("declared");
  });

  it("uses cooked template escapes and removes escaped line continuations", () => {
    const source = [
      'describe("suite", () => {',
      "  it(`joined" + "\\" + "\n" + " title`, () => {});",
      "  it(`line" + "\\n" + "feed`, () => {});",
      "});",
    ].join("\n");
    expect(declarationStatus(source, "suite > joined title")).toBe("declared");
    expect(declarationStatus(source, "suite > line\nfeed")).toBe("declared");
    expect(declarationStatus(source, "suite > line feed")).toBe("absent");
  });

  it("uses cooked CRLF, U+2028, and U+2029 template line-ending semantics", () => {
    const crlf = "  it(`crlf\\" + "\r\n" + "joined`, () => {});";
    const lineSeparator = "  it(`line\\" + "\u2028" + "joined`, () => {});";
    const paragraphSeparator =
      "  it(`paragraph\\" + "\u2029" + "joined`, () => {});";
    const rawCrlf = "  it(`raw\r\nline`, () => {});";
    const source = `describe("suite", () => {\n${crlf}\n${lineSeparator}\n${paragraphSeparator}\n${rawCrlf}\n});`;
    expect(declarationStatus(source, "suite > crlfjoined")).toBe("declared");
    expect(declarationStatus(source, "suite > linejoined")).toBe("declared");
    expect(declarationStatus(source, "suite > paragraphjoined")).toBe(
      "declared",
    );
    expect(declarationStatus(source, "suite > raw\nline")).toBe("declared");
  });

  it("fails closed when multiple unresolved template expressions could match", () => {
    const source =
      'describe("suite", () => { it(`prefix ${first} middle ${second} suffix`, () => {}); });';
    expect(declarationStatus(source, "suite > prefix A middle B suffix")).toBe(
      "unsupported",
    );
  });

  it("fails closed when a static title contains the suite path delimiter", () => {
    const source = 'describe("suite", () => { it("case > tail", () => {}); });';
    expect(declarationStatus(source, "suite > case > tail")).toBe(
      "unsupported",
    );
  });

  it("fails closed for dynamic titles and duplicate fully qualified paths", () => {
    const dynamic = `describe("suite", () => { it(caseName, () => {}); });`;
    expect(declarationStatus(dynamic, "suite > case")).toBe("unsupported");
    const tableDriven = `describe("suite", () => {
  it.each(["a", "b"])("case %s", () => {});
  it("unrelated static case", () => {});
});`;
    expect(declarationStatus(tableDriven, "suite > case a")).toBe(
      "unsupported",
    );
    expect(
      declarationStatus(tableDriven, "suite > unrelated static case"),
    ).toBe("declared");
    const dynamicSuite =
      'describe(`suite ${suffix}`, () => { it("case", () => {}); });';
    expect(declarationStatus(dynamicSuite, "suite named > case")).toBe(
      "unsupported",
    );
    const staticLoop = [
      'describe("suite", () => {',
      "  for (const version of [0, 1, 2] as const) {",
      "    it(`v${version} case`, () => {});",
      "  }",
      "});",
    ].join("\n");
    expect(declarationStatus(staticLoop, "suite > v1 case")).toBe("declared");
    const duplicate = `describe("suite", () => {
  it("case", () => {});
  it("case", () => {});
});`;
    expect(declarationStatus(duplicate, "suite > case")).toBe("ambiguous");
  });

  it("does not treat skipped or todo registrations as named killers", () => {
    const skippedCases = withVitest(`describe("suite", () => {
  it.skip("skipped case", () => {});
  it.todo("todo case");
  it("runnable case", () => {});
});`);
    expect(declarationStatus(skippedCases, "suite > skipped case")).toBe(
      "unsupported",
    );
    expect(declarationStatus(skippedCases, "suite > todo case")).toBe(
      "unsupported",
    );
    expect(declarationStatus(skippedCases, "suite > runnable case")).toBe(
      "declared",
    );

    const skippedSuite = withVitest(`describe.skip("skipped suite", () => {
  it("descendant case", () => {});
});`);
    expect(
      declarationStatus(skippedSuite, "skipped suite > descendant case"),
    ).toBe("unsupported");
  });
});

describe("first isobmff-3 successor attribution (D-13)", () => {
  type SuccessorReceipt = Cluster & {
    deletion?: {
      detectedSuccessors?: {
        oldAnchor?: string;
        finalAnchor?: string;
        test?: { file?: string; name?: string };
      }[];
      reportBindings?: Isobmff3ReportBinding[];
    };
  };

  const identity = {
    file: "src/isobmff/iloc.ts",
    mutatorName: "EqualityOperator",
    replacement: "payload.length > 1",
    location: {
      start: { line: 133, column: 7 },
      end: { line: 133, column: 26 },
    },
  };
  const expectedKiller = {
    file: "tests/isobmff_writer.test.ts",
    name: "tracer: heif-enc-grid.heic rebuild (62-02) > rebuilds heif-enc-grid.heic end to end: removes Exif/XMP, preserves every surviving item byte-identical, leaks none of the removed payload, and re-admits",
  };
  const previousWrongKiller = {
    file: "tests/isobmff_iloc.test.ts",
    name: "iloc boundary preservation > v0 payload length 0 keeps the typed framing refusal",
  };

  function loadAttributionEvidence() {
    const { report } = loadIsobmff3BatchReport();
    const ilocEntry = report.files[identity.file]!;
    const selectedMutants = ilocEntry.mutants.filter(
      (mutant) =>
        mutant.mutatorName === identity.mutatorName &&
        mutant.replacement === identity.replacement &&
        mutant.location.start.line === identity.location.start.line &&
        mutant.location.start.column === identity.location.start.column &&
        mutant.location.end.line === identity.location.end.line &&
        mutant.location.end.column === identity.location.end.column,
    );
    expect(selectedMutants).toHaveLength(1);
    const selectedMutant = selectedMutants[0]!;
    const killedBy = new Set((selectedMutant.killedBy ?? []).map(String));
    const resolvedKills = Object.entries(report.testFiles ?? {}).flatMap(
      ([file, entry]) =>
        entry.tests
          .filter((test) => killedBy.has(String(test.id)))
          .map((test) => ({ file, name: test.name })),
    );
    expect(resolvedKills).toEqual([expectedKiller]);

    const finalAnchor = phaseVerifier.canonicalAnchor(
      identity.file,
      selectedMutant,
      ilocEntry.source,
    );
    const ledgerPath = join(packageRoot, "tools", "mutation", "ledger.json");
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      clusters: SuccessorReceipt[];
    };
    const receipts = ledger.clusters
      .filter((row) =>
        row.deletion?.detectedSuccessors?.some(
          (successor) => successor.finalAnchor === finalAnchor,
        ),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    expect(receipts).toHaveLength(2);
    const survivors = JSON.parse(
      readFileSync(
        join(packageRoot, "tools", "mutation", "pre-triage-survivors.json"),
        "utf8",
      ),
    ).survivors as Survivor[];
    const readTest = (file: string) =>
      readFileSync(join(packageRoot, file), "utf8");
    return { report, ilocEntry, finalAnchor, receipts, survivors, readTest };
  }

  function validateReceipt(
    receipt: SuccessorReceipt,
    input: ReturnType<typeof loadAttributionEvidence>,
  ) {
    return deletionProof.validateDeletion({
      row: receipt,
      root: packageRoot,
      currentSource: input.ilocEntry.source,
      finalEntry: input.ilocEntry,
      finalReport: input.report as Report & {
        testFiles: NonNullable<Report["testFiles"]>;
      },
      readTest: input.readTest,
      survivors: input.survivors,
      requireFinal: true,
    });
  }

  it("binds both first-successor receipts to the report's direct named killer", () => {
    const input = loadAttributionEvidence();
    const canonicalSha256 = sha256(
      deletionProof.canonicalReceiptJson(input.report),
    );

    for (const receipt of input.receipts) {
      const successors = receipt.deletion!.detectedSuccessors!;
      expect(successors).toHaveLength(2);
      const binding = receipt.deletion!.reportBindings!.find(
        (entry) => entry.canonicalSha256 === canonicalSha256,
      )!;
      expect(binding).toBeDefined();
      const reportFirst = binding.successors.find(
        (successor) => successor.finalAnchor === input.finalAnchor,
      )!;
      expect({
        file: reportFirst.test.file,
        name: reportFirst.test.name,
      }).toEqual(expectedKiller);
      const second = successors.find(
        (successor) => successor.finalAnchor !== input.finalAnchor,
      )!;
      const [file, mutatorName, replacement, ...location] =
        second.finalAnchor!.split("\0");
      const entry = input.report.files[file!]!;
      const secondMatches = entry.mutants.filter(
        (mutant) =>
          mutant.mutatorName === mutatorName &&
          mutant.replacement === replacement &&
          phaseVerifier.canonicalAnchor(file!, mutant, entry.source) ===
            second.finalAnchor &&
          location.length > 0,
      );
      expect(secondMatches).toHaveLength(1);
      const secondIds = new Set((secondMatches[0]!.killedBy ?? []).map(String));
      const secondKills = Object.entries(input.report.testFiles ?? {}).flatMap(
        ([testFile, testEntry]) =>
          testEntry.tests
            .filter((test) => secondIds.has(String(test.id)))
            .map((test) => ({ file: testFile, name: test.name })),
      );
      expect(second.test).toEqual(secondKills[0]);
      expect(secondKills.length).toBeGreaterThan(0);
      const reportSecond = binding.successors.find(
        (successor) => successor.oldAnchor === second.oldAnchor,
      )!;
      expect(secondIds).toContain(reportSecond.test.id);
      expect({
        file: reportSecond.test.file,
        name: reportSecond.test.name,
      }).toEqual(secondKills[0]);
      expect(validateReceipt(receipt, input).problems).toEqual([]);
    }
  });

  it("rejects the fresh report's killer when validating the immutable historical report", () => {
    const input = loadAttributionEvidence();
    const canonicalSha256 = sha256(
      deletionProof.canonicalReceiptJson(input.report),
    );
    const wrongTestRow = input.report.testFiles?.[
      previousWrongKiller.file
    ]?.tests.find((test) => test.name === previousWrongKiller.name);
    expect(wrongTestRow).toBeDefined();
    const sourceSha256 = sha256(
      input.report.testFiles![previousWrongKiller.file]!.source,
    );
    for (const receipt of structuredClone(input.receipts)) {
      const binding = receipt.deletion!.reportBindings!.find(
        (entry) => entry.canonicalSha256 === canonicalSha256,
      )!;
      const first = binding.successors.find(
        (successor) => successor.finalAnchor === input.finalAnchor,
      )!;
      first.test = {
        ...previousWrongKiller,
        id: wrongTestRow!.id,
        sourceSha256,
      };
      expect(validateReceipt(receipt, input).problems.join("\n")).toMatch(
        /detected successor killedBy does not name the real test/,
      );
    }
  }, 10_000);

  it("rejects first-successor bindings borrowed in either report direction", () => {
    const { rows, reports } = loadRegisteredIsobmff3Reports();
    const survivors = JSON.parse(
      readFileSync(
        join(packageRoot, "tools", "mutation", "pre-triage-survivors.json"),
        "utf8",
      ),
    ).survivors as Survivor[];
    const reportIdentities = [
      ...new Map(
        reports.map((entry) => [entry.binding.canonicalSha256, entry]),
      ).values(),
    ];
    expect(reportIdentities.length).toBeGreaterThanOrEqual(2);
    const firstOldAnchor = (
      rows[0]!.deletion!.detectedSuccessors as { oldAnchor: string }[]
    )[0]!.oldAnchor;
    let rejectedCrossBindings = 0;
    for (const registered of reportIdentities) {
      const canonicalSha256 = registered.binding.canonicalSha256;
      const firstReceipt = structuredClone(rows[0]!) as SuccessorReceipt;
      const selected = firstReceipt.deletion!.reportBindings!.find(
        (entry) => entry.canonicalSha256 === canonicalSha256,
      )!;
      for (const other of reportIdentities.filter(
        (entry) => entry.binding.canonicalSha256 !== canonicalSha256,
      )) {
        const first = selected.successors.find(
          (successor) => successor.oldAnchor === firstOldAnchor,
        )!;
        const wrongSuccessor = other.binding.successors.find(
          (candidate) => candidate.oldAnchor === firstOldAnchor,
        )!;
        if (
          deletionProof.canonicalReceiptJson(wrongSuccessor.test) ===
          deletionProof.canonicalReceiptJson(first.test)
        )
          continue;
        first.test = structuredClone(wrongSuccessor.test);

        const cliFixture = createRealIsobmff3BatchCliFixture(
          registered.compressed,
        );
        const report = registered.report;
        const finalEntry = report.files["src/isobmff/iloc.ts"]!;
        const proof = deletionProof.validateDeletion({
          row: firstReceipt,
          root: cliFixture.productRoot,
          currentSource: finalEntry.source,
          finalEntry,
          finalReport: report as Report & {
            testFiles: NonNullable<Report["testFiles"]>;
          },
          readTest: (file) =>
            readFileSync(join(cliFixture.productRoot, file), "utf8"),
          survivors,
          requireFinal: true,
        });
        const wrongTestEntry = report.testFiles?.[first.test.file];
        const wrongNamedTests =
          wrongTestEntry?.tests.filter(
            (test) =>
              String(test.id) === first.test.id &&
              test.name === first.test.name,
          ) ?? [];
        const wrongTestPath = join(
          cliFixture.productRoot,
          first.test.file,
        );
        const wrongTestSource = existsSync(wrongTestPath)
          ? readFileSync(wrongTestPath, "utf8")
          : null;
        const wrongBindingReachesDirectKill =
          wrongNamedTests.length === 1 &&
          wrongTestSource !== null &&
          wrongTestEntry?.source === wrongTestSource &&
          sha256(wrongTestSource) === first.test.sourceSha256;
        expect(proof.problems.join("\n")).toMatch(
          wrongBindingReachesDirectKill
            ? /detected successor killedBy does not name the real test/
            : /detected successor test source is absent or stale/,
        );
        rejectedCrossBindings++;
      }
    }
    expect(rejectedCrossBindings).toBeGreaterThanOrEqual(2);
  }, 60_000);
});

describe("real admission scoped deletion receipt proof", () => {
  it("validates the measured four-edit chain through both real consumers", () => {
    const { bundle, finalReport } = loadAdmissionReceiptBundle();
    const root = materializeAdmissionReceiptBundle(bundle, finalReport);
    const groups = JSON.parse(
      readFileSync(join(root, "mutation-floors.json"), "utf8"),
    ).groups as Record<string, { tier: string; globs: string[] }>;
    const receiptFile = "src/isobmff/admission.ts";
    const entry = finalReport.files[receiptFile]!;
    const readTest = (file: string) => readFileSync(join(root, file), "utf8");

    const receiptProofs = bundle.receipts.map((row) =>
      deletionProof.validateDeletion({
        row,
        root,
        currentSource: entry.source,
        finalEntry: entry,
        finalReport,
        readTest,
        survivors: bundle.selectedMembers,
        requireFinal: true,
      }),
    );
    for (const [index, proof] of receiptProofs.entries()) {
      expect(proof.problems, bundle.receipts[index]!.id).toEqual([]);
      expect(proof.anchors).toHaveLength(entry.mutants.length);
      expect(new Set(proof.anchors.map((pair) => pair.current)).size).toBe(
        proof.anchors.length,
      );
      expect(new Set(proof.anchors.map((pair) => pair.original)).size).toBe(
        proof.anchors.length,
      );
    }
    const firstMapping = receiptProofs[0]!.anchors;
    for (const proof of receiptProofs.slice(1))
      expect(proof.anchors).toEqual(firstMapping);

    const tests = new Map(
      Object.entries(finalReport.testFiles).flatMap(([file, testFile]) =>
        testFile.tests.map(
          (test) => [String(test.id), { file, name: test.name }] as const,
        ),
      ),
    );
    for (const row of bundle.clusterRows.filter(
      (candidate) =>
        candidate.disposition === "gap" && candidate.file === receiptFile,
    )) {
      for (const key of row.keys) {
        const member = bundle.selectedMembers.find(
          (candidate) => candidate.key === key,
        )!;
        const pair = firstMapping.find(
          (candidate) => candidate.original === member.anchorKey,
        )!;
        const current = entry.mutants.filter(
          (mutant) =>
            phaseVerifier.canonicalAnchor(receiptFile, mutant, entry.source) ===
            pair.current,
        );
        expect(current, `${row.id}: mapped final anchor`).toHaveLength(1);
        const killers = (current[0]!.killedBy ?? [])
          .map((id) => tests.get(String(id)))
          .filter(Boolean);
        expect(
          killers.some(
            (test) =>
              test!.file === row.test?.file &&
              (test!.name === row.test?.name ||
                test!.name.endsWith(` > ${row.test?.name}`)),
          ),
          `${row.id}: row test ${JSON.stringify(row.test)} does not name mapped report mutant ${current[0]!.id} killers ${JSON.stringify(killers)}`,
        ).toBe(true);
      }
    }

    const ledgerProblems = checkLedger({
      ledger: {
        schemaVersion: 1,
        preTriage: null,
        clusters: bundle.clusterRows,
      },
      finalReport,
      root,
      groups,
      mode: "final",
    });
    expect(ledgerProblems).toEqual([]);

    const proof = phaseVerifier.evaluate({
      clusters: bundle.clusterRows,
      survivors: bundle.selectedMembers,
      report: finalReport,
      mode: "batch",
      readTest,
      symbolAbsent: () => false,
      root,
    }) as { key: string; status: string }[];
    expect(proof).toHaveLength(51);
    expect(proof.map((item) => item.key).sort()).toEqual(
      bundle.selectedMembers.map((member) => member.key).sort(),
    );
    expect(proof.filter((item) => item.status === "Killed")).toHaveLength(32);
    expect(proof.filter((item) => item.status === "Ignored")).toHaveLength(15);
    expect(proof.filter((item) => item.status === "deleted")).toHaveLength(4);

    const prior = new Map(
      bundle.originalBatchRows.flatMap((row) =>
        row.disposition === "pending"
          ? []
          : row.keys.map((key) => [key, row.disposition] as const),
      ),
    );
    expect(prior.size).toBe(bundle.provenance.originalBatch.previouslyDisposed);
    const proofByKey = new Map(proof.map((item) => [item.key, item.status]));
    for (const [key, disposition] of prior) {
      expect(proofByKey.get(key), key).toBe(
        disposition === "gap" ? "Killed" : "Ignored",
      );
    }

    const firstOwned = bundle.clusterRows.find(
      (row) => row.disposition !== "dead",
    )!;
    const duplicateOwner = {
      ...structuredClone(firstOwned),
      id: `${firstOwned.id}:duplicate-owner`,
    };
    const duplicateRows = [
      firstOwned,
      duplicateOwner,
      ...bundle.clusterRows.filter((row) => row.id !== firstOwned.id),
    ];
    expect(() =>
      phaseVerifier.evaluate({
        clusters: duplicateRows,
        survivors: bundle.selectedMembers,
        report: finalReport,
        mode: "batch",
        readTest,
        symbolAbsent: () => false,
        root,
      }),
    ).toThrow(/duplicate owned key/);

    const permutedRows = bundle.clusterRows.toReversed().map((row) => {
      const copy = structuredClone(row);
      copy.keys.reverse();
      copy.anchors.reverse();
      for (const field of [
        "removedMutants",
        "detectedSuccessors",
        "counterfactuals",
      ]) {
        const values = copy.deletion?.[field];
        if (Array.isArray(values)) copy.deletion![field] = values.toReversed();
      }
      return copy;
    });
    const permutedReport = structuredClone(finalReport);
    permutedReport.files = Object.fromEntries(
      Object.entries(permutedReport.files)
        .toReversed()
        .map(([file, value]) => [
          file,
          { ...value, mutants: value.mutants.toReversed() },
        ]),
    );
    permutedReport.testFiles = Object.fromEntries(
      Object.entries(permutedReport.testFiles)
        .toReversed()
        .map(([file, value]) => [
          file,
          { ...value, tests: value.tests.toReversed() },
        ]),
    );
    const reordered = phaseVerifier.evaluate({
      clusters: permutedRows,
      survivors: bundle.selectedMembers.toReversed(),
      report: permutedReport,
      mode: "batch",
      readTest,
      symbolAbsent: () => false,
      root,
    }) as { key: string; status: string }[];
    expect(
      reordered
        .map((item) => [item.key, item.status])
        .sort(([a], [b]) => a!.localeCompare(b!)),
    ).toEqual(
      proof
        .map((item) => [item.key, item.status])
        .sort(([a], [b]) => a!.localeCompare(b!)),
    );

    const equivalentAnchors = new Set(
      bundle.clusterRows
        .filter((row) => row.disposition === "equivalent")
        .flatMap((row) => row.anchors),
    );
    const commentIgnored = entry.mutants.filter(
      (mutant) =>
        mutant.status === "Ignored" &&
        mutant.static !== true &&
        !String(mutant.statusReason ?? "").startsWith("error-message:"),
    );
    expect(commentIgnored).toHaveLength(15);
    for (const mutant of commentIgnored)
      expect(
        equivalentAnchors.has(
          identity.anchorKey(receiptFile, mutant, entry.source),
        ),
        mutant.id,
      ).toBe(true);
  }, 30_000);
});

describe("real admission batch CLI provenance", () => {
  it("preflights the full inventory and accepts the measured 51-member batch through main", () => {
    const fixture = createRealAdmissionCliFixture();
    const inventory = runRealCli(fixture, ["--inventory"]);
    expect(
      inventory.error,
      `inventory subprocess error: ${inventory.error?.message ?? "none"}`,
    ).toBeUndefined();
    expect(
      inventory.status,
      `inventory stdout:\n${inventory.stdout}\ninventory stderr:\n${inventory.stderr}`,
    ).toBe(0);
    expect(inventory.stdout).toContain(
      "32 batches, 586 clusters, 1919 members",
    );

    const selected = fixture.bundle.selectedMembers.find(
      (member) =>
        member.file === "src/isobmff/admission.ts" &&
        member.function === "classifyIsobmffModel" &&
        member.mutatorName === "MethodExpression" &&
        member.key.includes("item.extents.some"),
    );
    expect(selected, "frozen gap-02 member is present").toBeDefined();
    const currentRow = fixture.bundle.clusterRows.find((row) =>
      row.keys.includes(selected!.key),
    );
    const historicalRow = fixture.bundle.originalBatchRows.find((row) =>
      row.keys.includes(selected!.key),
    );
    expect(currentRow?.test?.name).toBe(
      "admits a removable item with extent_count 0 as emptied",
    );
    expect(historicalRow?.test?.name).toBe(
      "classifyIsobmffModel ConditionalExpression MethodExpression: a zero removable extent never overlaps and does not empty a mixed item",
    );

    const preBaselineKiller = runRealBatchCli(fixture);
    expect(
      preBaselineKiller.status,
      `actual CLI stdout:\n${preBaselineKiller.stdout}\nactual CLI stderr:\n${preBaselineKiller.stderr}`,
    ).toBe(0);
    const historicalProof = JSON.parse(
      String(preBaselineKiller.stdout ?? "{}"),
    ) as {
      proof: {
        key: string;
        killedBy: { file: string; name: string }[];
        historicalAddedTest?: { file: string; name: string };
      }[];
    };
    const provenMember = historicalProof.proof.find(
      (item) => item.key === selected!.key,
    );
    expect(
      provenMember?.killedBy.some(
        (test) =>
          test.file === "tests/isobmff_admission.test.ts" &&
          test.name.endsWith(
            " > admits a removable item with extent_count 0 as emptied",
          ),
      ),
    ).toBe(true);
    expect(provenMember?.historicalAddedTest).toMatchObject({
      test: {
        file: historicalRow!.test!.file,
        name: historicalRow!.test!.name,
      },
      status: "Killed",
      reportSha256:
        "1b664580b7c99f0391ac062d6fed903c919ef008a251e93c4d2b0fc191f88881",
    });

    const ordinaryGap = fixture.bundle.clusterRows.find(
      (row) => row.disposition === "gap" && !row.keys.includes(selected!.key),
    );
    expect(
      ordinaryGap,
      "another gap retains the ordinary baseline-added current-killer route",
    ).toBeDefined();
    const ordinaryProof = historicalProof.proof.find(
      (item) => item.key === ordinaryGap!.keys[0],
    );
    expect(
      ordinaryProof?.killedBy.some(
        (test) =>
          test.file === ordinaryGap!.test!.file &&
          (test.name === ordinaryGap!.test!.name ||
            test.name.endsWith(` > ${ordinaryGap!.test!.name}`)),
      ),
    ).toBe(true);
    expect(ordinaryProof?.historicalAddedTest).toBeUndefined();

    setCliGapTest(fixture, selected!.key, historicalRow!.test!.name);
    const provenancePathControl = runRealBatchCli(fixture);
    expect(
      provenancePathControl.status,
      `actual CLI stderr:\n${provenancePathControl.stderr}`,
    ).not.toBe(0);
    expect(provenancePathControl.stderr).toContain("does not name");

    setCliGapTest(fixture, selected!.key, currentRow!.test!.name);
    const positive = runRealBatchCli(fixture);
    expect(
      {
        status: positive.status,
        signal: positive.signal,
        error: positive.error?.message ?? null,
      },
      `real CLI stdout:\n${positive.stdout}\nreal CLI stderr:\n${positive.stderr}`,
    ).toMatchObject({
      status: 0,
      signal: null,
      error: null,
    });
    const proof = JSON.parse(String(positive.stdout ?? "{}")) as {
      batch: string;
      mode: string;
      members: number;
      proof: { key: string; status: string }[];
    };
    expect(proof).toMatchObject({
      batch: "isobmff-1",
      mode: "batch",
      members: 51,
    });
    expect(
      proof.proof.filter((member) => member.status === "Killed"),
    ).toHaveLength(32);
    expect(
      proof.proof.filter((member) => member.status === "Ignored"),
    ).toHaveLength(15);
    expect(
      proof.proof.filter((member) => member.status === "deleted"),
    ).toHaveLength(4);
    expect(proof.proof.map((member) => member.status).sort()).toHaveLength(51);
    expect(proof.proof.map((member) => member.key).sort()).toEqual(
      fixture.bundle.selectedMembers.map((member) => member.key).sort(),
    );
  }, 60_000);

  it("accepts reordered current report data while archived historical bytes stay pinned", () => {
    const fixture = createRealAdmissionCliFixture();
    const reordered = withCliFileMutation(
      fixture,
      fixture.reportPath,
      (bytes) => {
        const report = JSON.parse(bytes.toString("utf8")) as Report;
        report.files = Object.fromEntries(
          Object.entries(report.files)
            .toReversed()
            .map(([file, entry]) => [
              file,
              { ...entry, mutants: entry.mutants.toReversed() },
            ]),
        );
        report.testFiles = Object.fromEntries(
          Object.entries(report.testFiles ?? {})
            .toReversed()
            .map(([file, entry]) => [
              file,
              { ...entry, tests: entry.tests.toReversed() },
            ]),
        );
        return Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
      },
      () => runRealBatchCli(fixture),
    );

    expect(
      reordered.error,
      `CLI spawn error: ${reordered.error?.message ?? "none"}`,
    ).toBeUndefined();
    expect(
      reordered.status,
      `CLI stdout:\n${reordered.stdout}\nCLI stderr:\n${reordered.stderr}`,
    ).toBe(0);
    const proof = JSON.parse(String(reordered.stdout ?? "{}")) as {
      reportSha256: string;
      members: number;
      proof: { status: string }[];
    };
    expect(proof.members).toBe(51);
    expect(
      proof.proof.filter((member) => member.status === "Killed"),
    ).toHaveLength(32);
    expect(
      proof.proof.filter((member) => member.status === "Ignored"),
    ).toHaveLength(15);
    expect(
      proof.proof.filter((member) => member.status === "deleted"),
    ).toHaveLength(4);
    expect(proof.reportSha256).not.toBe(
      fixture.bundle.provenance.finalReport.sha256,
    );
  }, 60_000);

  it("rejects a product-root symlink that resolves outside the disposable workspace", () => {
    const fixture = createRealAdmissionCliFixture();
    const productPath = resolve(fixture.root, "exifcleaner-node");
    const retainedCopy = resolve(
      fixture.root,
      "exifcleaner-node-copied-inputs",
    );
    const escapedRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "phase-67-50-escaped-root-")),
    );
    temporaryRoots.push(escapedRoot);
    const escapedMutationTools = join(escapedRoot, "tools", "mutation");
    mkdirSync(escapedMutationTools, { recursive: true });
    for (const file of [
      "classes.json",
      "identity.mjs",
      "disable-lint.mjs",
      "ledger-summary.mjs",
      "deletion-proof.mjs",
      "cluster.mjs",
      "groups.mjs",
    ])
      copyFileSync(
        join(packageRoot, "tools", "mutation", file),
        join(escapedMutationTools, file),
      );
    for (const file of ["ledger.json", "pre-triage-survivors.json"])
      copyFileSync(
        join(packageRoot, "tools", "mutation", file),
        join(escapedMutationTools, file),
      );
    renameSync(productPath, retainedCopy);
    symlinkSync(escapedRoot, productPath, "dir");

    const result = runRealCli(fixture, ["--inventory"]);
    expectCliRejection(result, "CLI product root symlink escapes workspace");
  }, 60_000);

  it("rejects single-change provenance, inventory, source and ownership failures through main", () => {
    const fixture = createRealAdmissionCliFixture();
    const member = fixture.bundle.selectedMembers.find(
      (candidate) =>
        candidate.file === "src/isobmff/admission.ts" &&
        candidate.function === "classifyIsobmffModel" &&
        candidate.mutatorName === "MethodExpression" &&
        candidate.key.includes("item.extents.some"),
    );
    expect(member).toBeDefined();
    const originalRow = fixture.bundle.originalBatchRows.find((row) =>
      row.keys.includes(member!.key),
    );
    const selectedRow = fixture.bundle.clusterRows.find((row) =>
      row.keys.includes(member!.key),
    );
    expect(originalRow?.test).toBeDefined();
    expect(selectedRow?.test).toBeDefined();

    const corruptions: { name: string; mutate(bundle: CliBundle): void }[] = [
      {
        name: "wrong historical key",
        mutate: (bundle) => {
          bundle.originalBatchRows.find((row) =>
            row.keys.includes(member!.key),
          )!.keys[0] += ":forged";
        },
      },
      {
        name: "wrong historical origin",
        mutate: (bundle) => {
          bundle.originalBatchRows.find((row) =>
            row.keys.includes(member!.key),
          )!.originClusterId = "isobmff:forged-origin";
        },
      },
      {
        name: "wrong historical test",
        mutate: (bundle) => {
          bundle.originalBatchRows.find((row) =>
            row.keys.includes(member!.key),
          )!.test!.name = "forged historical test";
        },
      },
      {
        name: "baseline-present historical test",
        mutate: (bundle) => {
          bundle.originalBatchRows.find((row) =>
            row.keys.includes(member!.key),
          )!.test!.name =
            "admits a removable item with extent_count 0 as emptied";
        },
      },
      {
        name: "missing historical killedBy with coveredBy only",
        mutate: (bundle) => {
          const report = JSON.parse(bundle.beforeReportRaw) as Report;
          const entry = report.files[member!.file]!;
          const matches = entry.mutants.filter(
            (candidate) =>
              phaseVerifier.canonicalAnchor(
                member!.file,
                candidate,
                entry.source,
              ) === member!.anchorKey,
          );
          expect(matches).toHaveLength(1);
          const mutantRecord = matches[0]!;
          mutantRecord.coveredBy = [...(mutantRecord.killedBy ?? [])];
          mutantRecord.killedBy = [];
          bundle.beforeReportRaw = JSON.stringify(report);
        },
      },
      {
        name: "changed historical raw digest",
        mutate: (bundle) => {
          bundle.beforeReportRaw += " ";
        },
      },
    ];
    for (const corruption of corruptions) {
      const result = withCliBundleMutation(fixture, corruption.mutate, () =>
        runRealBatchCli(fixture),
      );
      expectCliRejection(
        result,
        "historical bundle digest differs from the audited admission evidence",
      );
    }

    const currentReportWithoutKiller = withCliFileMutation(
      fixture,
      fixture.reportPath,
      (bytes) => {
        const report = JSON.parse(bytes.toString("utf8")) as Report;
        const entry = report.files[member!.file]!;
        const matches = entry.mutants.filter(
          (candidate) =>
            phaseVerifier.canonicalAnchor(
              member!.file,
              candidate,
              entry.source,
            ) === member!.anchorKey,
        );
        expect(matches).toHaveLength(1);
        matches[0]!.killedBy = [];
        return Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
      },
      () => runRealBatchCli(fixture),
    );
    expectCliRejection(currentReportWithoutKiller, "does not name");

    const staleTest = withCliFileMutation(
      fixture,
      "exifcleaner-node/tests/isobmff_admission.test.ts",
      (bytes) =>
        Buffer.concat([bytes, Buffer.from("\n// fixture-only stale source\n")]),
      () => runRealBatchCli(fixture),
    );
    expectCliRejection(
      staleTest,
      "historical/current named test sources are stale or differ",
    );

    const staleSource = withCliFileMutation(
      fixture,
      "exifcleaner-node/src/isobmff/admission.ts",
      (bytes) =>
        Buffer.concat([bytes, Buffer.from("\n// fixture-only stale source\n")]),
      () => runRealBatchCli(fixture),
    );
    expectCliRejection(staleSource, "stale report source");

    const missingHistoricalBundle = withCliFileRemoval(
      fixture,
      admissionBundlePath,
      () => runRealBatchCli(fixture),
    );
    expectCliRejection(missingHistoricalBundle, "ENOENT");

    const missingCurrentReport = withCliFileRemoval(
      fixture,
      fixture.reportPath,
      () => runRealBatchCli(fixture),
    );
    expectCliRejection(missingCurrentReport, "ENOENT");

    const wrongKey = withCliLedgerMutation(
      fixture,
      (ledger) => {
        const row = ledger.clusters.find((candidate) =>
          candidate.keys.includes(member!.key),
        )!;
        row.keys[row.keys.indexOf(member!.key)] = `${member!.key}:forged`;
      },
      () => runRealBatchCli(fixture),
    );
    expectCliRejection(wrongKey, "member moved to another measured origin");

    const wrongOrigin = withCliLedgerMutation(
      fixture,
      (ledger) => {
        const row = ledger.clusters.find((candidate) =>
          candidate.keys.includes(member!.key),
        )!;
        row.originClusterId = "isobmff:forged-origin";
      },
      () => runRealBatchCli(fixture),
    );
    expectCliRejection(
      wrongOrigin,
      "pre/ledger measured-origin totals drifted",
    );

    const missingMember = withCliLedgerMutation(
      fixture,
      (ledger) => {
        const row = ledger.clusters.find((candidate) =>
          candidate.keys.includes(member!.key),
        )!;
        row.keys.splice(row.keys.indexOf(member!.key), 1);
      },
      () => runRealBatchCli(fixture),
    );
    expectCliRejection(missingMember, "immutable membership changed");

    const duplicateMember = withCliLedgerMutation(
      fixture,
      (ledger) => {
        const row = ledger.clusters.find((candidate) =>
          candidate.keys.includes(member!.key),
        )!;
        row.keys.push(row.keys[0]!);
      },
      () => runRealBatchCli(fixture),
    );
    expectCliRejection(duplicateMember, "immutable membership changed");

    const wrongCurrentKiller = withCliLedgerMutation(
      fixture,
      (ledger) => {
        const row = ledger.clusters.find((candidate) =>
          candidate.keys.includes(member!.key),
        )!;
        row.test = {
          file: originalRow!.test!.file,
          name: originalRow!.test!.name,
        };
      },
      () => runRealBatchCli(fixture),
    );
    expectCliRejection(wrongCurrentKiller, "does not name");

    const escapingReceipt = withCliLedgerMutation(
      fixture,
      (ledger) => {
        const row = ledger.clusters.find(
          (candidate) => candidate.disposition === "dead",
        )!;
        row.deletion!["beforeReport"] = "../outside.json";
      },
      () => runRealBatchCli(fixture),
    );
    expectCliRejection(escapingReceipt, "beforeReport: unsafe relative path");

    const summaryDrift = withCliFileMutation(
      fixture,
      fixture.summaryPath,
      (bytes) => Buffer.concat([bytes, Buffer.from("\nfixture-only drift\n")]),
      () => runRealBatchCli(fixture),
    );
    expectCliRejection(summaryDrift, "generated summary drift");
  }, 120_000);

  it("fails inventory on a missing non-target path and requires a fresh complete fixture", () => {
    const missingFixture = createRealAdmissionCliFixture();
    const requiredPath = "exifcleaner-node/src/webp/riff.ts";
    const owner = missingFixture.manifest.batches.find((batch) =>
      batch.filesModified.includes(requiredPath),
    );
    expect(
      owner,
      "the non-target riff source is manifest-derived inventory",
    ).toBeDefined();
    const copiedPath = resolve(missingFixture.root, requiredPath);
    expect(
      realpathSync(copiedPath).startsWith(
        `${realpathSync(missingFixture.root)}${sep}`,
      ),
    ).toBe(true);
    rmSync(copiedPath);
    const missingResult = runRealBatchCli(missingFixture);
    expectCliRejection(
      missingResult,
      `${owner!.id}: ungrounded file ${requiredPath}`,
    );

    const rebuiltFixture = createRealAdmissionCliFixture();
    const rebuiltInventory = runRealCli(rebuiltFixture, ["--inventory"]);
    expect(
      rebuiltInventory.error,
      `inventory spawn error: ${rebuiltInventory.error?.message ?? "none"}`,
    ).toBeUndefined();
    expect(
      rebuiltInventory.status,
      `inventory stdout:\n${rebuiltInventory.stdout}\ninventory stderr:\n${rebuiltInventory.stderr}`,
    ).toBe(0);
    expect(rebuiltInventory.stdout).toContain(
      "32 batches, 586 clusters, 1919 members",
    );
  }, 120_000);

  it("rejects a realpath symlink escape while allowing ordinary resolved fixture paths", () => {
    const fixture = createRealAdmissionCliFixture();
    const sourcePath = resolve(fixture.productRoot, "src/isobmff/admission.ts");
    const retainedSource = resolve(
      fixture.productRoot,
      "src/isobmff/admission.fixture-copy.ts",
    );
    const outsideSource = resolve(
      fixture.root,
      "phase-67-50-outside-source.ts",
    );
    renameSync(sourcePath, retainedSource);
    writeFileSync(outsideSource, "fixture-only path target\n");
    symlinkSync(outsideSource, sourcePath);
    const escaped = runRealBatchCli(fixture);
    expectCliRejection(escaped, "symlink or path escapes root");

    const ordinary = createRealAdmissionCliFixture();
    const accepted = runRealBatchCli(ordinary);
    expect(
      accepted.error,
      `ordinary CLI spawn error: ${accepted.error?.message ?? "none"}`,
    ).toBeUndefined();
    expect(
      accepted.status,
      `ordinary CLI stdout:\n${accepted.stdout}\nordinary CLI stderr:\n${accepted.stderr}`,
    ).toBe(0);
  }, 120_000);
});
