// MUT-03 survivor ledger checker (D-13, D-18) with fixtures. Every red case
// asserts a specific problem; the passing cases prove the fixtures are valid.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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
  testFiles?: Record<string, { source: string; tests: { id: string; name: string }[] }>;
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
  functionBounds(source: string, name: string): { start: number; end: number; function: string };
  applyEdits(source: string, edits: { function: string; before: string; after: string; occurrence: number }[]): { source: string };
  affectedBy(mutant: Mutant, source: string, edits: { start: number; end: number }[]): boolean;
  validateDeletion(input: {
    row: Cluster;
    root: string;
    currentSource: string;
    finalEntry: { source: string; mutants: Mutant[] } | null;
    finalReport: Report & { testFiles?: Record<string, { source: string; tests: { id: string; name: string }[] }> };
    readTest(file: string): string;
    survivors: Survivor[];
    requireFinal: boolean;
  }): { problems: string[]; anchors: { current: string; original: string }[] };
  canonicalReceiptJson(value: unknown): string;
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = dirname(packageRoot);
const liveInputPaths = [
  join(packageRoot, "tools", "mutation", "ledger.json"),
  join(packageRoot, "tools", "mutation", "pre-triage-survivors.json"),
  join(workspaceRoot, ".planning", "phases", "67-mutation-baseline", "67-SURVIVOR-LEDGER.md"),
  join(packageRoot, "src", "isobmff", "admission.ts"),
  join(packageRoot, "dist", "isobmff", "admission.js"),
  join(packageRoot, "dist", "isobmff", "admission.js.map"),
  join(packageRoot, "dist", "isobmff", "admission.d.ts"),
  join(packageRoot, "dist", "isobmff", "admission.d.ts.map"),
  join(packageRoot, "package.json"),
  join(packageRoot, "package-lock.json"),
  join(packageRoot, "tests", "fixtures", "mutation", "admission-deletion-reports.json.gz"),
  join(packageRoot, "reports", "triage", "67-14", "node24-green.json"),
  join(packageRoot, "reports", "triage", "67-14", "resume", "batch.json"),
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
const phaseVerifier = await import(pathToFileURL(phaseVerifierPath).href) as {
  canonicalAnchor(file: string, mutant: Mutant, source: string): string;
  reconcileAnchorMappings(proofs: { id: string; anchors: { current: string; original: string }[] }[]): Map<string, string>;
  evaluate(input: {
    clusters: Cluster[];
    survivors: Survivor[];
    report: Report & { testFiles: Record<string, { source: string; tests: { id: string; name: string }[] }> };
    mode: "batch";
    readTest(file: string): string;
    symbolAbsent(symbol: string): boolean;
    root: string;
  }): unknown[];
};

interface AdmissionReceiptBundle {
  schema: string;
  provenance: {
    beforeReport: { path: string; sha256: string; bytes: number };
    finalReport: { path: string; sha256: string; bytes: number };
    sources: { finalSourceSha256: string };
    tests: { finalTestSources: Record<string, string> };
    originalBatch: { members: number; previouslyDisposed: number; pendingBefore: number };
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

function loadAdmissionReceiptBundle(): {
  bundle: AdmissionReceiptBundle;
  beforeReport: Report;
  finalReport: Report & { testFiles: Record<string, { source: string; tests: { id: string; name: string }[] }> };
} {
  const fixturePath = join(packageRoot, "tests", "fixtures", "mutation", "admission-deletion-reports.json.gz");
  const bundle = JSON.parse(gunzipSync(readFileSync(fixturePath)).toString("utf8")) as AdmissionReceiptBundle;
  expect(bundle.schema).toBe("exifcleaner.admission-deletion-reports.v1");
  expect(sha256(bundle.beforeReportRaw)).toBe(bundle.provenance.beforeReport.sha256);
  expect(Buffer.byteLength(bundle.beforeReportRaw)).toBe(bundle.provenance.beforeReport.bytes);
  expect(sha256(bundle.finalReportRaw)).toBe(bundle.provenance.finalReport.sha256);
  expect(Buffer.byteLength(bundle.finalReportRaw)).toBe(bundle.provenance.finalReport.bytes);
  expect(bundle.selectedMembers).toHaveLength(51);
  expect(bundle.clusterRows.flatMap((row) => row.keys)).toHaveLength(51);
  expect(bundle.receipts).toHaveLength(4);
  expect(bundle.provenance.impact).toMatchObject({ affected: 27, retained: 10, removed: 17, removedDetected: 12 });
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
  const rawRemoved = bundle.receipts[0]!.deletion!.removedMutants as { status: string }[];
  expect(rawRemoved.reduce<Record<string, number>>((counts, mutant) => {
    counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
    return counts;
  }, {})).toEqual({ CompileError: 1, Killed: 12, Survived: 4 });
  for (const row of bundle.receipts) {
    expect((row.deletion!.removedMutants as unknown[])).toHaveLength(17);
    expect((row.deletion!.counterfactuals as unknown[])).toHaveLength(12);
  }

  const beforeReport = JSON.parse(bundle.beforeReportRaw) as Report;
  const finalReport = JSON.parse(bundle.finalReportRaw) as Report & {
    testFiles: Record<string, { source: string; tests: { id: string; name: string }[] }>;
  };
  expect(Object.keys(beforeReport.files).sort()).toEqual([
    "src/admission/isobmff-handler.ts",
    "src/isobmff/admission.ts",
  ]);
  expect(Object.keys(finalReport.files).sort()).toEqual(Object.keys(beforeReport.files).sort());
  expect(Object.values(beforeReport.files).reduce((n, entry) => n + entry.mutants.length, 0)).toBe(426);
  expect(Object.values(finalReport.files).reduce((n, entry) => n + entry.mutants.length, 0)).toBe(411);
  expect(Object.keys(finalReport.testFiles)).toHaveLength(32);
  expect(sha256(finalReport.files["src/isobmff/admission.ts"]!.source)).toBe(bundle.provenance.sources.finalSourceSha256);
  for (const [file, expectedHash] of Object.entries(bundle.provenance.tests.finalTestSources))
    expect(sha256(finalReport.testFiles[file]!.source), file).toBe(expectedHash);

  return { bundle, beforeReport, finalReport };
}

function materializeAdmissionReceiptBundle(bundle: AdmissionReceiptBundle, finalReport: Report): string {
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
  for (const [file, entry] of Object.entries(finalReport.files)) writeText(file, entry.source);
  for (const [file, entry] of Object.entries(finalReport.testFiles ?? {})) writeText(file, entry.source);
  writeText(bundle.provenance.beforeReport.path, bundle.beforeReportRaw);
  writeText(bundle.provenance.finalReport.path, bundle.finalReportRaw);
  writeText("tools/mutation/pre-triage-survivors.json", `${JSON.stringify({ survivors: bundle.selectedMembers })}\n`);
  writeText("tools/mutation/ledger.json", `${JSON.stringify({ schemaVersion: 1, preTriage: null, clusters: bundle.clusterRows })}\n`);
  writeText("tools/mutation/classes.json", readFileSync(join(packageRoot, "tools", "mutation", "classes.json"), "utf8"));
  writeText("mutation-floors.json", readFileSync(join(packageRoot, "mutation-floors.json"), "utf8"));
  return root;
}

const phaseDir = ".planning/phases/67-mutation-baseline";
const admissionBundlePath = "exifcleaner-node/tests/fixtures/mutation/admission-deletion-reports.json.gz";
const admissionReportPath = "exifcleaner-node/reports/triage/67-14/resume/batch.json";
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
  "67-14-HALTED.md",
  "67-14-RESUME-HALTED.md",
  "67-14-CLI-HALTED.md",
  "67-48-PLAN.md",
  "67-49-PLAN.md",
  "67-50-PLAN.md",
  "67-49-SUMMARY.md",
];

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
  expect(isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`), label).toBe(false);
}

function assertNoSymlinkComponents(root: string, path: string): void {
  const rel = relative(root, path);
  expect(isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`), `${path} escapes ${root}`).toBe(false);
  let cursor = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    expect(lstatSync(cursor).isSymbolicLink(), `${cursor} contains a symlink component`).toBe(false);
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
  assertContained(sourceRoot, source, `source ${relativePath} escaped workspace`);
  assertContained(fixtureRoot, destination, `destination ${relativePath} escaped fixture`);
  assertNoSymlinkComponents(sourceRoot, source);
  expect(lstatSync(source).isFile(), `${relativePath} is not a regular input`).toBe(true);
  expect(realpathSync(source).startsWith(`${sourceRoot}${sep}`), `${relativePath} resolves outside workspace`).toBe(true);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  assertNoSymlinkComponents(fixtureRoot, destination);
  expect(lstatSync(destination).isFile(), `${relativePath} was not copied as a regular file`).toBe(true);
  expect(realpathSync(destination).startsWith(`${fixtureRoot}${sep}`), `${relativePath} resolves outside fixture`).toBe(true);
}

function writeFixtureFile(root: string, relativePath: string, content: string | Buffer): void {
  const destination = resolve(root, relativePath);
  const fixtureRoot = realpathSync(root);
  assertContained(fixtureRoot, destination, `${relativePath} escaped fixture on write`);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
  expect(lstatSync(destination).isFile(), `${relativePath} was not written as a regular file`).toBe(true);
}

function createRealAdmissionCliFixture(): RealCliFixture {
  const { bundle: loadedBundle } = loadAdmissionReceiptBundle();
  const bundle = loadedBundle as CliBundle;
  const manifest = JSON.parse(readFileSync(join(workspaceRoot, phaseDir, "67-TRIAGE-BATCHES.json"), "utf8")) as CliManifest;
  const fixtureBytes = readFileSync(join(workspaceRoot, admissionBundlePath));
  expect(sha256(fixtureBytes)).toBe("6b9f4943e0f59e1df1442c1244efe575c7c167cebc5a3704c9843941b9691542");
  expect(bundle.provenance.beforeReport.sha256).toBe("1b664580b7c99f0391ac062d6fed903c919ef008a251e93c4d2b0fc191f88881");
  expect(Buffer.byteLength(bundle.beforeReportRaw)).toBe(1_369_999);
  const selectedBatch = manifest.batches.find((batch) => batch.id === "isobmff-1");
  expect(selectedBatch).toBeDefined();
  const inventoryPaths = [...new Set(manifest.batches.flatMap((batch) => batch.filesModified))].sort();
  expect(inventoryPaths).toHaveLength(150);
  const evidenceSourcePaths = [...new Set(manifest.batches.flatMap((batch) =>
    [...batch.sourceFiles, ...batch.testFiles].map((file) => `exifcleaner-node/${file}`)))].sort();

  const root = realpathSync(mkdtempSync(join(tmpdir(), "phase-67-50-cli-")));
  temporaryRoots.push(root);
  for (const path of inventoryPaths) copyWorkspaceRegularFile(root, path);
  for (const path of evidenceSourcePaths) copyWorkspaceRegularFile(root, path);
  copyWorkspaceRegularFile(root, "exifcleaner-node/tools/mutation/pre-triage-survivors.json");
  copyWorkspaceRegularFile(root, "exifcleaner-node/tools/mutation/ledger.json");
  const planPaths = manifest.batches.map((batch) => `${phaseDir}/67-${String(batch.plan).padStart(2, "0")}-PLAN.md`);
  for (const path of [...planPaths, ...cliHistoryFiles.map((file) => `${phaseDir}/${file}`),
    `${phaseDir}/67-TRIAGE-BATCHES.json`, `${phaseDir}/67-GAP-REPAIR-CONTRACT.md`, `${phaseDir}/67-CONTEXT.md`]) {
    if (!existsSync(resolve(workspaceRoot, path))) continue;
    copyWorkspaceRegularFile(root, path);
  }
  copyWorkspaceRegularFile(root, cliScriptPath);
  for (const path of cliImportFiles) copyWorkspaceRegularFile(root, path);

  const batch = selectedBatch!;
  const targetOrigins = new Set(batch.clusterIds);
  const ledgerPath = "exifcleaner-node/tools/mutation/ledger.json";
  const summaryPath = `${phaseDir}/67-SURVIVOR-LEDGER.md`;
  const ledger = JSON.parse(readFileSync(resolve(workspaceRoot, ledgerPath), "utf8")) as CliLedger;
  const untouched = ledger.clusters.filter((row) => !targetOrigins.has(row.originClusterId ?? row.id));
  const candidateLedger: CliLedger = {
    ...ledger,
    clusters: [...untouched, ...bundle.clusterRows].sort((a, b) => a.id.localeCompare(b.id)),
  };
  expect(candidateLedger.clusters.filter((row) => targetOrigins.has(row.originClusterId ?? row.id))
    .flatMap((row) => row.keys).sort()).toEqual(bundle.selectedMembers.map((member) => member.key).sort());
  writeFixtureFile(root, ledgerPath, `${JSON.stringify(candidateLedger, null, 2)}\n`);
  writeFixtureFile(root, summaryPath, renderLedger(candidateLedger));
  writeFixtureFile(root, admissionBundlePath, fixtureBytes);
  writeFixtureFile(root, bundle.provenance.beforeReport.path, bundle.beforeReportRaw);
  writeFixtureFile(root, bundle.provenance.finalReport.path, bundle.finalReportRaw);
  writeFixtureFile(root, admissionReportPath, bundle.finalReportRaw);

  const liveGitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: packageRoot,
    encoding: "utf8",
  }).trim();
  writeFixtureFile(root, "exifcleaner-node/.git", `gitdir: ${liveGitDir}\n`);

  const fixtureRoot = realpathSync(root);
  const productRoot = realpathSync(resolve(root, "exifcleaner-node"));
  for (const path of [...inventoryPaths, ...evidenceSourcePaths].map((file) => resolve(root, file))) {
    assertNoSymlinkComponents(fixtureRoot, path);
    expect(lstatSync(path).isFile(), `${path} is not a contained regular inventory copy`).toBe(true);
    expect(realpathSync(path).startsWith(`${fixtureRoot}${sep}`), `${path} resolves outside fixture`).toBe(true);
    chmodSync(path, 0o444);
  }
  const scriptPath = resolve(root, cliScriptPath);
  assertContained(fixtureRoot, realpathSync(scriptPath), "copied verifier escaped fixture");
  assertContained(fixtureRoot, productRoot, "CLI product root escaped fixture");
  return { root, productRoot, manifest, bundle, ledgerPath, summaryPath, reportPath: admissionReportPath };
}

function setCliGapTest(fixture: RealCliFixture, key: string, testName: string): void {
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

function runRealCli(fixture: RealCliFixture, args: string[]): ReturnType<typeof spawnSync> {
  const script = resolve(fixture.root, cliScriptPath);
  const actualRoot = realpathSync(fixture.root);
  assertContained(actualRoot, realpathSync(script), "CLI script must be inside mkdtemp");
  assertContained(actualRoot, realpathSync(fixture.productRoot), "CLI product root must be inside mkdtemp");
  return spawnSync(process.execPath, [script, ...args], {
    cwd: actualRoot,
    encoding: "utf8",
    env: process.env,
  });
}

function runRealBatchCli(fixture: RealCliFixture): ReturnType<typeof spawnSync> {
  return runRealCli(fixture, ["--batch", "isobmff-1", "--mode", "batch", "--report", fixture.reportPath]);
}

function deletionFixture(removeBeforeReport = false) {
  const file = "src/example.mjs";
  const testFile = "tests/rejects-false.mjs";
  const testName = "rejects false input";
  const beforeSource = [
    'export function f(flag) {',
    '  const out = [];',
    '  if (flag) {',
    '    out.push("hit");',
    '  }',
    '  return out;',
    '}',
    'export function other(flag) {',
    '  const out = [];',
    '  if (flag) {',
    '    out.push("other");',
    '  }',
    '  return out;',
    '}',
    '',
  ].join("\n");
  const afterSource = beforeSource.replace("  if (flag) {", "  {");
  const testSource = [
    'import assert from "node:assert/strict";',
    'import { f } from "../src/example.mjs";',
    `// ${testName}`,
    'assert.deepEqual(f(false), []);',
    '',
  ].join("\n");
  const root = tempRoot({
    [file]: beforeSource,
    [testFile]: testSource,
    "tools/mutation/pre-triage-survivors.json": "{}\n",
  });
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Mutation Fixture"], { cwd: root });
  execFileSync("git", ["add", file], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "fixture before source"], { cwd: root });

  const at = (text: string, needle: string, start = 0) => {
    const index = text.indexOf(needle, start);
    if (index === -1) throw new Error(`fixture text missing: ${needle}`);
    const prefix = text.slice(0, index);
    const lines = prefix.split("\n");
    return { line: lines.length, column: lines.at(-1)!.length + 1 };
  };
  const span = (text: string, needle: string, start = 0) => {
    const point = at(text, needle, start);
    return { start: point, end: { line: point.line, column: point.column + needle.length } };
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
    location: { start: at(beforeSource, "if (flag)"), end: { ...at(beforeSource, '  }\n  return', beforeSource.indexOf("if (flag)") + 1), column: 4 } },
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
  const evidence = { source: beforeSource, mutants: beforeMutants, testFiles: reportTestFiles };
  const beforeReport = { files: { [file]: { language: "javascript", source: beforeSource, mutants: beforeMutants } }, testFiles: reportTestFiles };
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
  writeFileSync(join(root, "tools/mutation/pre-triage-survivors.json"), JSON.stringify({ survivors }, null, 2));
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
  const beforeRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
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
    detectedSuccessors: [{
      oldAnchor: identity.anchorKey(file, guardFalse, beforeSource),
      finalAnchor: identity.anchorKey(file, { ...sibling, id: "successor", status: "Killed", killedBy: ["t1"] }, afterSource),
      test: { file: testFile, name: testName },
      semanticTrace: "f(false) remains empty after removing the guard",
    }],
    referenceTrace: "f writes only within its local branch; the assertion and all callers were checked",
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
    location: { start: { ...at(afterSource, "  {", afterSource.indexOf("  const out") + 1), column: 3 }, end: { ...at(afterSource, '  }\n  return', afterSource.indexOf("  {")), column: 4 } },
  };
  const finalReport: Report & { testFiles: Record<string, { source: string; tests: { id: string; name: string }[] }> } = {
    files: { [file]: { language: "javascript", source: afterSource, mutants: [successor, liveAncestor] } },
    testFiles: reportTestFiles,
  };
  writeFileSync(join(root, "tools/mutation/pre-triage-survivors.json"), JSON.stringify({ survivors }, null, 2));
  writeFileSync(join(root, file), afterSource);
  const reportPath = join(root, "reports", "final.json");
  writeFileSync(reportPath, `${JSON.stringify(finalReport, null, 2)}\n`);
  return { root, file, testFile, testSource, beforeSource, afterSource, beforeMutants,
    evidence, reportBytes, receipt, row, survivors, finalReport, successor, reportPath,
    readTest: (path: string) => readFileSync(join(root, path), "utf8") };
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
    expect(new Set(ledger.clusters.map((c) => c.disposition)).size).toBeGreaterThan(1);

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

    const result = runLiveReadOnly(
      "--pre",
      prePath,
    );
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
    expect((JSON.parse(output.toString()) as { clusters: Cluster[] }).clusters.every((c) => c.disposition === "pending")).toBe(true);
    expect(output.equals(Buffer.from(initialLedger))).toBe(false);

    const second = run();
    expect(second.status).toBe(0);
    expect(readFileSync(join(root, "tools/mutation/ledger.json"))).toEqual(output);

    const prePath = join(root, "tools/mutation/pre-triage-survivors.json");
    const permuted = JSON.parse(readFileSync(prePath, "utf8")) as {
      survivors: Survivor[];
    };
    permuted.survivors.reverse();
    writeFileSync(prePath, `${JSON.stringify(permuted, null, 2)}\n`);
    expect(permuted.survivors).not.toEqual(survivors);
    const afterPermutation = run();
    expect(afterPermutation.status).toBe(0);
    expect(readFileSync(join(root, "tools/mutation/ledger.json"))).toEqual(output);
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
    expect(clusterTools.partitionBatches([...clustered].reverse())).toEqual(batches);
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
    expect(source.slice(inspect.start, inspect.end)).toBe('{\n  if (flag) { return "mime"; }\n  return "other";\n}');
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
    expect(() => deletionProof.functionBounds("function choose() {}\nfunction choose() {}", "choose"))
      .toThrow(/function choose is ambiguous/);

    const exact = '  if (flag) { return "mime"; }';
    const edited = deletionProof.applyEdits(source, [{ function: "inspect", before: exact,
      after: "", occurrence: 0 }]);
    expect(edited.source).toContain('return "other";');
    expect(edited.source).toContain("inspect();");
  });

  it("rejects comment/string-only matches and arbitrary substitutions", () => {
    const comment = "function choose() {\n  // const flag = true;\n  const flag = true;\n}\n";
    const string = 'function choose() {\n  const text = "const flag = true;";\n  return text;\n}\n';
    for (const source of [comment, string])
      expect(() => deletionProof.applyEdits(source, [{ function: "choose", before: "const flag = true;",
        after: "", occurrence: 0 }])).toThrow(/not an exact lexical source expression/);

    expect(() => deletionProof.applyEdits("function choose() { return true; }", [{
      function: "choose", before: "return true;", after: "return false;", occurrence: 0,
    }])).toThrow(/non-deletion edit/);
  });

  it("uses half-open overlap so touching deletion endpoints preserve adjacent mutants", () => {
    const source = "abcdef";
    const interval = (start: number, end: number): Mutant => ({
      id: `${start}-${end}`,
      mutatorName: "MethodExpression",
      replacement: "void 0",
      status: "Killed",
      location: { start: { line: 1, column: start + 1 }, end: { line: 1, column: end + 1 } },
    });
    const edit = [{ start: 2, end: 4 }];
    expect(deletionProof.affectedBy(interval(0, 2), source, edit)).toBe(false);
    expect(deletionProof.affectedBy(interval(2, 4), source, edit)).toBe(true);
    expect(deletionProof.affectedBy(interval(4, 6), source, edit)).toBe(false);
  });

  it("coalesces only identical anchor maps and rejects conflicting or non-injective maps", () => {
    const shared = phaseVerifier.reconcileAnchorMappings([
      { id: "receipt-a", anchors: [{ current: "current", original: "original" }] },
      { id: "receipt-b", anchors: [{ current: "current", original: "original" }] },
    ]);
    expect([...shared]).toEqual([["current", "original"]]);
    expect(() => phaseVerifier.reconcileAnchorMappings([
      { id: "receipt-a", anchors: [{ current: "current", original: "original-a" }] },
      { id: "receipt-b", anchors: [{ current: "current", original: "original-b" }] },
    ])).toThrow(/conflicting current-to-original anchor mapping/);
    expect(() => phaseVerifier.reconcileAnchorMappings([
      { id: "receipt-a", anchors: [{ current: "current-a", original: "original" }] },
      { id: "receipt-b", anchors: [{ current: "current-b", original: "original" }] },
    ])).toThrow(/non-injective original anchor mapping/);
    expect(() => phaseVerifier.evaluate({
      clusters: [],
      survivors: [],
      report: { files: {}, testFiles: {} },
      mode: "batch",
      readTest: () => "",
      symbolAbsent: () => false,
      root: "/tmp/empty-mutation-report",
    })).toThrow(/empty mutation report/);
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
  const ledgerFor = (fixture: ReturnType<typeof deletionFixture>, row = fixture.row, reverse = false) =>
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
  const rejectBothConsumers = (fixture: ReturnType<typeof deletionFixture>, row: Cluster,
    finalReport: Report & { testFiles: Record<string, { source: string; tests: { id: string; name: string }[] }> },
    expected: RegExp) => {
    const ledgerProblems = checkLedger({ ledger: ledgerFor(fixture, row), finalReport,
      root: fixture.root, groups, mode: "final" });
    expect(ledgerProblems.join("\n")).toMatch(expected);
    expect(() => phaseVerifier.evaluate({ clusters: [row], survivors: fixture.survivors,
      report: finalReport, mode: "batch", readTest: fixture.readTest,
      symbolAbsent: () => false, root: fixture.root })).toThrow(expected);
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
    expect(checkLedger({ ledger: ledgerFor(fixture), finalReport: fixture.finalReport,
      root: fixture.root, groups, mode: "final" })).toEqual([]);
    expect(checkLedger({ ledger: ledgerFor(fixture, fixture.row, true), finalReport: fixture.finalReport,
      root: fixture.root, groups, mode: "final" })).toEqual([]);
    expect(checkLedger({ ledger: ledgerFor(fixture), root: fixture.root,
      groups, mode: "pre" })).toEqual([]);

    const reordered = structuredClone(fixture.row);
    reordered.deletion!.removedMutants = (reordered.deletion!.removedMutants as unknown[]).toReversed();
    expect(deletionProof.validateDeletion({ ...inputFor(fixture), row: reordered }).problems).toEqual([]);

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
    expect(result[0]).toMatchObject({ key: fixture.row.keys[0], status: "deleted" });
  });

  it("validates embedded evidence when the ignored raw before report is absent", () => {
    const fixture = deletionFixture(true);
    expect(deletionProof.validateDeletion(inputFor(fixture)).problems).toEqual([]);
    expect(checkLedger({ ledger: ledgerFor(fixture), finalReport: fixture.finalReport,
      root: fixture.root, groups, mode: "final" })).toEqual([]);
  });

  it("executes the real false-opposite assertion: original passes and the deleted guard fails", () => {
    const fixture = deletionFixture();
    const assertion = join(fixture.root, fixture.testFile);
    writeFileSync(join(fixture.root, fixture.file), fixture.beforeSource);
    const original = spawnSync(process.execPath, [assertion], { cwd: fixture.root, encoding: "utf8" });
    expect(original.status, original.stderr).toBe(0);
    writeFileSync(join(fixture.root, fixture.file), fixture.afterSource);
    const broken = spawnSync(process.execPath, [assertion], { cwd: fixture.root, encoding: "utf8" });
    expect(broken.status).not.toBe(0);
    expect(broken.stderr).toMatch(/AssertionError/);
  });

  it("fails closed on a shallow file clone, then passes full history after deleting phase-only refs and reports", () => {
    const fixture = deletionFixture();
    execFileSync("git", ["add", "src/example.mjs", "tests/rejects-false.mjs",
      "tools/mutation/pre-triage-survivors.json", "reports/before.json", "reports/final.json"], { cwd: fixture.root });
    execFileSync("git", ["commit", "-q", "-m", "squashed scoped edit"], { cwd: fixture.root });
    execFileSync("git", ["tag", "phase-only-deletion"], { cwd: fixture.root });
    writeFileSync(join(fixture.root, "audit.txt"), "unrelated later commit\n");
    execFileSync("git", ["add", "audit.txt"], { cwd: fixture.root });
    execFileSync("git", ["commit", "-q", "-m", "later audit"], { cwd: fixture.root });

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
    expect(shallow.problems.join("\n")).toMatch(/beforeRef source unavailable .* full history is required/);

    execFileSync("git", ["tag", "-d", "phase-only-deletion"], { cwd: fullRoot, stdio: "ignore" });
    rmSync(join(fullRoot, "reports", "before.json"));
    expect(deletionProof.validateDeletion(withRoot(fullRoot)).problems).toEqual([]);
  });

  it("rejects a restored guard, a changed sibling, a wrong function and stale hashes", () => {
    const fixture = deletionFixture();
    writeFileSync(join(fixture.root, fixture.file), fixture.beforeSource);
    const restored = { ...cloneInput(fixture), currentSource: fixture.beforeSource,
      finalEntry: { ...fixture.finalReport.files[fixture.file]!, source: fixture.beforeSource } };
    expect(deletionProof.validateDeletion(restored).problems.join("\n")).toMatch(/exact ordered edit chain/);

    const changedSibling = fixture.afterSource.replace('out.push("other")', 'out.push("changed")');
    writeFileSync(join(fixture.root, fixture.file), changedSibling);
    const sibling = { ...cloneInput(fixture), currentSource: changedSibling };
    expect(deletionProof.validateDeletion(sibling).problems.join("\n")).toMatch(/exact ordered edit chain/);
    const changedReport = structuredClone(fixture.finalReport);
    changedReport.files[fixture.file]!.source = changedSibling;
    const ledgerRejected = checkLedger({ ledger: ledgerFor(fixture), finalReport: fixture.finalReport,
      root: fixture.root, groups, mode: "final" });
    expect(ledgerRejected.join("\n")).toMatch(/exact ordered edit chain/);
    expect(() => phaseVerifier.evaluate({ clusters: [fixture.row], survivors: fixture.survivors,
      report: changedReport, mode: "batch", readTest: fixture.readTest,
      symbolAbsent: () => false, root: fixture.root })).toThrow(/exact ordered edit chain/);

    writeFileSync(join(fixture.root, fixture.file), fixture.afterSource);

    const wrongFunction = cloneInput(fixture);
    wrongFunction.row.deletion!.function = "other";
    expect(deletionProof.validateDeletion(wrongFunction).problems.join("\n")).toMatch(/does not match owned row/);

    const wrongEditFunction = cloneInput(fixture);
    (wrongEditFunction.row.deletion!.edits as { function: string }[])[0]!.function = "other";
    expect(deletionProof.validateDeletion(wrongEditFunction).problems.join("\n")).toMatch(/required dead symbol/);

    const wrongOccurrence = cloneInput(fixture);
    (wrongOccurrence.row.deletion!.edits as { occurrence: number }[])[0]!.occurrence = 1;
    expect(deletionProof.validateDeletion(wrongOccurrence).problems.join("\n")).toMatch(/occurrence 1 is missing/);

    const otherOnly = fixture.beforeSource.replace(/(export function other[\s\S]*?)  if \(flag\) \{/, "$1  {");
    writeFileSync(join(fixture.root, fixture.file), otherOnly);
    expect(deletionProof.validateDeletion({ ...cloneInput(fixture), currentSource: otherOnly,
      finalEntry: { ...fixture.finalReport.files[fixture.file]!, source: otherOnly } }).problems.join("\n"))
      .toMatch(/exact ordered edit chain/);
    writeFileSync(join(fixture.root, fixture.file), fixture.afterSource);

    const stale = cloneInput(fixture);
    stale.row.deletion!.beforeSourceSha256 = "0".repeat(64);
    expect(deletionProof.validateDeletion(stale).problems.join("\n")).toMatch(/before source hash mismatch/);

    const unavailable = cloneInput(fixture);
    unavailable.row.deletion!.beforeRef = "0000000000000000000000000000000000000000";
    expect(deletionProof.validateDeletion(unavailable).problems.join("\n")).toMatch(/beforeRef source unavailable/);

    const noEdits = cloneInput(fixture);
    noEdits.row.deletion!.edits = [];
    expect(deletionProof.validateDeletion(noEdits).problems.join("\n")).toMatch(/required dead symbol/);
  });

  it("rejects incomplete affected inventory, duplicate edits and a missing detected successor", () => {
    const fixture = deletionFixture();
    const inventory = cloneInput(fixture);
    inventory.row.deletion!.removedMutants = (inventory.row.deletion!.removedMutants as unknown[]).slice(1);
    expect(deletionProof.validateDeletion(inventory).problems.join("\n")).toMatch(/does not exactly account/);
    rejectBothConsumers(fixture, inventory.row, inventory.finalReport, /does not exactly account/);

    const duplicate = cloneInput(fixture);
    duplicate.row.deletion!.edits = [
      ...(duplicate.row.deletion!.edits as unknown[]),
      ...(duplicate.row.deletion!.edits as unknown[]),
    ];
    expect(deletionProof.validateDeletion(duplicate).problems.join("\n")).toMatch(/occurrence 0 is missing|overlaps an earlier edit/);
    rejectBothConsumers(fixture, duplicate.row, duplicate.finalReport,
      /occurrence 0 is missing|overlaps an earlier edit/);

    const counterpart = cloneInput(fixture);
    counterpart.row.deletion!.detectedSuccessors = [];
    expect(deletionProof.validateDeletion(counterpart).problems.join("\n")).toMatch(/exactly one successor or counterfactual/);
    rejectBothConsumers(fixture, counterpart.row, counterpart.finalReport,
      /exactly one successor or counterfactual/);

    const emptyFinal = { ...cloneInput(fixture), finalEntry: null,
      finalReport: { files: {} as Report["files"], testFiles: fixture.finalReport.testFiles } };
    expect(deletionProof.validateDeletion(emptyFinal).problems.join("\n")).toMatch(/final report entry is required/);
    const emptyReport = { files: {} as Report["files"], testFiles: fixture.finalReport.testFiles };
    expect(checkLedger({ ledger: ledgerFor(fixture), finalReport: emptyReport,
      root: fixture.root, groups, mode: "final" }).join("\n")).toMatch(/final report entry is required/);
    expect(() => phaseVerifier.evaluate({ clusters: [fixture.row], survivors: fixture.survivors,
      report: emptyReport, mode: "batch", readTest: fixture.readTest,
      symbolAbsent: () => false, root: fixture.root })).toThrow(/final report entry is required/);

    for (const status of ["Survived", "NoCoverage", "Ignored"]) {
      const invalid = cloneInput(fixture);
      invalid.finalReport.files[fixture.file]!.mutants[0]!.status = status;
      expect(deletionProof.validateDeletion(invalid).problems.join("\n")).toMatch(new RegExp(`detected successor is ${status}`));
      if (status === "Ignored") invalid.finalReport.files[fixture.file]!.mutants[0]!.statusReason = "Ignored using a comment";
      rejectBothConsumers(fixture, invalid.row, invalid.finalReport,
        new RegExp(`detected successor is ${status}`));
    }
    const noKilledBy = cloneInput(fixture);
    noKilledBy.finalReport.files[fixture.file]!.mutants[0]!.killedBy = [];
    expect(deletionProof.validateDeletion(noKilledBy).problems.join("\n")).toMatch(/killedBy does not name the real test/);
    rejectBothConsumers(fixture, noKilledBy.row, noKilledBy.finalReport,
      /killedBy does not name the real test/);

    const staleTest = cloneInput(fixture);
    staleTest.finalReport.testFiles![fixture.testFile]!.source += "// stale report test\n";
    rejectBothConsumers(fixture, staleTest.row, staleTest.finalReport,
      /detected successor test source is absent or stale/);
    const wrongTest = cloneInput(fixture);
    (wrongTest.row.deletion!.detectedSuccessors as { test: { name: string } }[])[0]!.test.name = "missing named assertion";
    rejectBothConsumers(fixture, wrongTest.row, wrongTest.finalReport,
      /detected successor test source is absent or stale/);
  });

  it("rejects altered embedded evidence, stale raw report, missing ownership and ignored opposite", () => {
    const fixture = deletionFixture();
    const evidence = cloneInput(fixture);
    (evidence.row.deletion!.beforeEvidence as { source: string }).source += "// tampered\n";
    expect(deletionProof.validateDeletion(evidence).problems.join("\n")).toMatch(/canonical digest mismatch/);

    const reportHash = cloneInput(fixture);
    reportHash.row.deletion!.beforeReportSha256 = "f".repeat(64);
    expect(deletionProof.validateDeletion(reportHash).problems.join("\n")).toMatch(/retained before report hash mismatch/);

    const changedSlice = cloneInput(fixture);
    const rawPath = join(fixture.root, "reports/before.json");
    const rawReport = JSON.parse(readFileSync(rawPath, "utf8"));
    rawReport.files[fixture.file].source += "// raw-only change\n";
    const changedBytes = `${JSON.stringify(rawReport, null, 2)}\n`;
    writeFileSync(rawPath, changedBytes);
    changedSlice.row.deletion!.beforeReportSha256 = sha256(changedBytes);
    expect(deletionProof.validateDeletion(changedSlice).problems.join("\n")).toMatch(/slice differs from embedded evidence/);
    writeFileSync(rawPath, fixture.reportBytes);

    const membership = cloneInput(fixture);
    membership.row.keys = ["foreign\u0000key"];
    membership.row.count = 1;
    expect(deletionProof.validateDeletion(membership).problems.join("\n")).toMatch(/absent from its immutable origin/);

    const ignored = structuredClone(fixture.finalReport);
    const opposite = ignored.files[fixture.file]!.mutants[1]!;
    opposite.status = "Ignored";
    opposite.statusReason = "Ignored using a comment";
    expect(checkLedger({ ledger: ledgerFor(fixture), finalReport: ignored,
      root: fixture.root, groups, mode: "final" }).join("\n")).toMatch(/comment-Ignored mutant matches no equivalent row/);
    expect(() => phaseVerifier.evaluate({ clusters: [fixture.row], survivors: fixture.survivors,
      report: ignored, mode: "batch", readTest: fixture.readTest, symbolAbsent: () => false,
      root: fixture.root })).toThrow(/comment-Ignored mutant has no valid equivalent owner/);

    const duplicateOwner = { ...structuredClone(fixture.row), id: "scoped-dead-duplicate-owner" };
    const duplicateLedger = ledgerOf([fixture.row, duplicateOwner, gapRowFor(fixture)]);
    expect(checkLedger({ ledger: duplicateLedger, finalReport: fixture.finalReport,
      root: fixture.root, groups, mode: "final" }).join("\n")).toMatch(/in 2 clusters/);
    expect(() => phaseVerifier.evaluate({ clusters: [fixture.row, duplicateOwner],
      survivors: fixture.survivors, report: fixture.finalReport, mode: "batch",
      readTest: fixture.readTest, symbolAbsent: () => false, root: fixture.root })).toThrow(/duplicate owned key/);
  });
});

describe("real admission scoped deletion receipt proof", () => {
  it("validates the measured four-edit chain through both real consumers", () => {
    const { bundle, finalReport } = loadAdmissionReceiptBundle();
    const root = materializeAdmissionReceiptBundle(bundle, finalReport);
    const groups = JSON.parse(readFileSync(join(root, "mutation-floors.json"), "utf8"))
      .groups as Record<string, { tier: string; globs: string[] }>;
    const receiptFile = "src/isobmff/admission.ts";
    const entry = finalReport.files[receiptFile]!;
    const readTest = (file: string) => readFileSync(join(root, file), "utf8");

    const receiptProofs = bundle.receipts.map((row) => deletionProof.validateDeletion({
      row,
      root,
      currentSource: entry.source,
      finalEntry: entry,
      finalReport,
      readTest,
      survivors: bundle.selectedMembers,
      requireFinal: true,
    }));
    for (const [index, proof] of receiptProofs.entries()) {
      expect(proof.problems, bundle.receipts[index]!.id).toEqual([]);
      expect(proof.anchors).toHaveLength(entry.mutants.length);
      expect(new Set(proof.anchors.map((pair) => pair.current)).size).toBe(proof.anchors.length);
      expect(new Set(proof.anchors.map((pair) => pair.original)).size).toBe(proof.anchors.length);
    }
    const firstMapping = receiptProofs[0]!.anchors;
    for (const proof of receiptProofs.slice(1)) expect(proof.anchors).toEqual(firstMapping);

    const tests = new Map(Object.entries(finalReport.testFiles).flatMap(([file, testFile]) =>
      testFile.tests.map((test) => [String(test.id), { file, name: test.name }] as const)));
    for (const row of bundle.clusterRows.filter((candidate) =>
      candidate.disposition === "gap" && candidate.file === receiptFile)) {
      for (const key of row.keys) {
        const member = bundle.selectedMembers.find((candidate) => candidate.key === key)!;
        const pair = firstMapping.find((candidate) => candidate.original === member.anchorKey)!;
        const current = entry.mutants.filter((mutant) =>
          phaseVerifier.canonicalAnchor(receiptFile, mutant, entry.source) === pair.current);
        expect(current, `${row.id}: mapped final anchor`).toHaveLength(1);
        const killers = (current[0]!.killedBy ?? []).map((id) => tests.get(String(id))).filter(Boolean);
        expect(killers.some((test) => test!.file === row.test?.file &&
          (test!.name === row.test?.name || test!.name.endsWith(` > ${row.test?.name}`))),
        `${row.id}: row test ${JSON.stringify(row.test)} does not name mapped report mutant ${current[0]!.id} killers ${JSON.stringify(killers)}`).toBe(true);
      }
    }

    const ledgerProblems = checkLedger({
      ledger: { schemaVersion: 1, preTriage: null, clusters: bundle.clusterRows },
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
    expect(proof.map((item) => item.key).sort()).toEqual(bundle.selectedMembers.map((member) => member.key).sort());
    expect(proof.filter((item) => item.status === "Killed")).toHaveLength(32);
    expect(proof.filter((item) => item.status === "Ignored")).toHaveLength(15);
    expect(proof.filter((item) => item.status === "deleted")).toHaveLength(4);

    const prior = new Map(bundle.originalBatchRows.flatMap((row) =>
      row.disposition === "pending" ? [] : row.keys.map((key) => [key, row.disposition] as const)));
    expect(prior.size).toBe(bundle.provenance.originalBatch.previouslyDisposed);
    const proofByKey = new Map(proof.map((item) => [item.key, item.status]));
    for (const [key, disposition] of prior) {
      expect(proofByKey.get(key), key).toBe(disposition === "gap" ? "Killed" : "Ignored");
    }

    const firstOwned = bundle.clusterRows.find((row) => row.disposition !== "dead")!;
    const duplicateOwner = { ...structuredClone(firstOwned), id: `${firstOwned.id}:duplicate-owner` };
    const duplicateRows = [firstOwned, duplicateOwner,
      ...bundle.clusterRows.filter((row) => row.id !== firstOwned.id)];
    expect(() => phaseVerifier.evaluate({
      clusters: duplicateRows,
      survivors: bundle.selectedMembers,
      report: finalReport,
      mode: "batch",
      readTest,
      symbolAbsent: () => false,
      root,
    })).toThrow(/duplicate owned key/);

    const permutedRows = bundle.clusterRows.toReversed().map((row) => {
      const copy = structuredClone(row);
      copy.keys.reverse();
      copy.anchors.reverse();
      for (const field of ["removedMutants", "detectedSuccessors", "counterfactuals"]) {
        const values = copy.deletion?.[field];
        if (Array.isArray(values)) copy.deletion![field] = values.toReversed();
      }
      return copy;
    });
    const permutedReport = structuredClone(finalReport);
    permutedReport.files = Object.fromEntries(Object.entries(permutedReport.files).toReversed().map(([file, value]) =>
      [file, { ...value, mutants: value.mutants.toReversed() }]));
    permutedReport.testFiles = Object.fromEntries(Object.entries(permutedReport.testFiles).toReversed().map(([file, value]) =>
      [file, { ...value, tests: value.tests.toReversed() }]));
    const reordered = phaseVerifier.evaluate({
      clusters: permutedRows,
      survivors: bundle.selectedMembers.toReversed(),
      report: permutedReport,
      mode: "batch",
      readTest,
      symbolAbsent: () => false,
      root,
    }) as { key: string; status: string }[];
    expect(reordered.map((item) => [item.key, item.status]).sort(([a], [b]) => a!.localeCompare(b!)))
      .toEqual(proof.map((item) => [item.key, item.status]).sort(([a], [b]) => a!.localeCompare(b!)));

    const equivalentAnchors = new Set(bundle.clusterRows
      .filter((row) => row.disposition === "equivalent")
      .flatMap((row) => row.anchors));
    const commentIgnored = entry.mutants.filter((mutant) => mutant.status === "Ignored" &&
      mutant.static !== true && !String(mutant.statusReason ?? "").startsWith("error-message:"));
    expect(commentIgnored).toHaveLength(15);
    for (const mutant of commentIgnored)
      expect(equivalentAnchors.has(identity.anchorKey(receiptFile, mutant, entry.source)), mutant.id).toBe(true);
  }, 30_000);
});

describe("real admission batch CLI provenance", () => {
  it("preflights the full inventory and accepts the measured 51-member batch through main", () => {
    const fixture = createRealAdmissionCliFixture();
    const inventory = runRealCli(fixture, ["--inventory"]);
    expect(inventory.error, `inventory subprocess error: ${inventory.error?.message ?? "none"}`).toBeUndefined();
    expect(inventory.status, `inventory stdout:\n${inventory.stdout}\ninventory stderr:\n${inventory.stderr}`).toBe(0);
    expect(inventory.stdout).toContain("32 batches, 586 clusters, 1919 members");

    const selected = fixture.bundle.selectedMembers.find((member) =>
      member.file === "src/isobmff/admission.ts" && member.function === "classifyIsobmffModel" &&
      member.mutatorName === "MethodExpression" && member.key.includes("item.extents.some"));
    expect(selected, "frozen gap-02 member is present").toBeDefined();
    const currentRow = fixture.bundle.clusterRows.find((row) => row.keys.includes(selected!.key));
    const historicalRow = fixture.bundle.originalBatchRows.find((row) => row.keys.includes(selected!.key));
    expect(currentRow?.test?.name).toBe("admits a removable item with extent_count 0 as emptied");
    expect(historicalRow?.test?.name).toBe("classifyIsobmffModel ConditionalExpression MethodExpression: a zero removable extent never overlaps and does not empty a mixed item");

    const preBaselineKiller = runRealBatchCli(fixture);
    expect(preBaselineKiller.status, `actual CLI stderr:\n${preBaselineKiller.stderr}`).not.toBe(0);
    expect(preBaselineKiller.stderr).toContain("named killing test was not added after the baseline");

    setCliGapTest(fixture, selected!.key, historicalRow!.test!.name);
    const provenancePathControl = runRealBatchCli(fixture);
    expect(provenancePathControl.status, `actual CLI stderr:\n${provenancePathControl.stderr}`).not.toBe(0);
    expect(provenancePathControl.stderr).toContain("receipt source: path escapes root");

    setCliGapTest(fixture, selected!.key, currentRow!.test!.name);
    const positive = runRealBatchCli(fixture);
    expect({ status: positive.status, signal: positive.signal, error: positive.error?.message ?? null },
      `real CLI stdout:\n${positive.stdout}\nreal CLI stderr:\n${positive.stderr}`).toMatchObject({
        status: 0,
        signal: null,
        error: null,
      });
    const proof = JSON.parse(positive.stdout ?? "{}") as { batch: string; mode: string; members: number; proof: { status: string }[] };
    expect(proof).toMatchObject({ batch: "isobmff-1", mode: "batch", members: 51 });
    expect(proof.proof.filter((member) => member.status === "Killed")).toHaveLength(32);
    expect(proof.proof.filter((member) => member.status === "Ignored")).toHaveLength(15);
    expect(proof.proof.filter((member) => member.status === "deleted")).toHaveLength(4);
    expect(proof.proof.map((member) => member.status).sort()).toHaveLength(51);
  }, 60_000);
});
