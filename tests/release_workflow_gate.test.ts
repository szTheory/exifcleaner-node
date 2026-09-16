import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  evidenceGatedIt,
  evidenceGatedTestTitles,
  phase46EvidenceDirectory,
} from "./support/phase46-evidence.js";

const require = createRequire(import.meta.url);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const gate = require("../scripts/release_workflow_gate.cjs") as {
  CANONICAL_NATIVE_TUPLES: readonly string[];
  REQUIRED_AUTHORITIES: string[];
  validateExactNativeManifestTuples(
    manifest: readonly Record<string, unknown>[],
  ): Map<string, Record<string, unknown>>;
  validateReleaseGraph(graph: {
    jobs: Record<string, { needs?: string[]; script?: string }>;
  }): void;
};
const benchmarkReport =
  require("../scripts/qualification/benchmark-report.cjs") as {
    validateP95NullBranchClosure(
      closure: Record<string, unknown>,
      ledger: Record<string, unknown>,
    ): Record<string, unknown>;
  };

const authorities = [
  "immutable-sha-evidence",
  "installed-linux-x64",
  "installed-linux-arm64",
  "installed-darwin-x64",
  "installed-darwin-arm64",
  "installed-win32-x64",
  "installed-win32-arm64",
];

type WorkflowJob = { needs?: string[]; script?: string };
type WorkflowGraph = { jobs: Record<string, WorkflowJob> };
type TupleGate = {
  CANONICAL_NATIVE_TUPLES: readonly string[];
  validateExactNativeManifestTuples(
    manifest: readonly Record<string, unknown>[],
  ): Map<string, Record<string, unknown>>;
};
const matchingPath =
  "windows-publication-matching-host-${{ matrix.tuple }}.json";
const installedPath =
  "windows-publication-installed-node22-${{ matrix.tuple }}.json";
const cancellationPath =
  "windows-cancellation-installed-node22-${{ matrix.tuple }}.json";

function validateWindowsDiagnosticWorkflow(workflow: string): void {
  const matchingUpload = workflow.match(
    /if: always\(\) && matrix\.os == 'win32'[\s\S]{0,300}name: windows-publication-matching-host-\$\{\{ matrix\.tuple \}\}[\s\S]{0,200}path: windows-publication-matching-host-\$\{\{ matrix\.tuple \}\}\.json/u,
  );
  const installedUpload = workflow.match(
    /if: always\(\) && matrix\.os == 'win32'[\s\S]{0,300}name: windows-publication-installed-node22-\$\{\{ matrix\.tuple \}\}[\s\S]{0,200}path: windows-publication-installed-node22-\$\{\{ matrix\.tuple \}\}\.json/u,
  );
  const cancellationUpload = workflow.match(
    /if: always\(\) && matrix\.os == 'win32'[\s\S]{0,300}name: windows-cancellation-installed-node22-\$\{\{ matrix\.tuple \}\}[\s\S]{0,200}path: windows-cancellation-installed-node22-\$\{\{ matrix\.tuple \}\}\.json/u,
  );
  if (!matchingUpload || !installedUpload || !cancellationUpload)
    throw new Error("all Windows diagnostic uploads must run always");
  for (const required of [
    "WINDOWS_PUBLICATION_DIAGNOSTIC_PATH",
    "--windows-publication-diagnostic-output",
    matchingPath,
    installedPath,
    "--windows-cancellation-diagnostic-output",
    cancellationPath,
    "win32-x64",
    "win32-arm64",
    "fail-fast: false",
  ])
    if (!workflow.includes(required))
      throw new Error(`Windows diagnostic workflow lacks ${required}`);
  if (/continue-on-error:\s*true|\|\|\s*true/u.test(workflow))
    throw new Error("Windows diagnostic workflow softens a hard failure");
  for (const name of [
    "windows-publication-matching-host-*",
    "windows-publication-installed-node22-*",
    "windows-cancellation-installed-node22-*",
  ])
    if (
      workflow.includes(`pattern: ${name}`) ||
      workflow.includes(`needs: ${name}`)
    )
      throw new Error("diagnostic artifact entered an authority graph");
}

function workflowJob(
  workflow: string,
  jobName: string,
  nextJobName?: string,
): string {
  const start = workflow.indexOf(`\n  ${jobName}:`);
  const end =
    nextJobName === undefined
      ? workflow.length
      : workflow.indexOf(`\n  ${nextJobName}:`, start + 1);
  if (start < 0 || end < 0)
    throw new Error(`workflow job ${jobName} is absent`);
  return workflow.slice(start, end);
}

function immutableEvidenceHeredoc(workflow: string): string {
  const job = workflowJob(
    workflow,
    "immutable-sha-evidence",
    "benchmark-linux",
  );
  const heredoc = job.match(/node - <<'NODE'\n([\s\S]*?)\n\s+NODE/u)?.[1];
  if (heredoc === undefined)
    throw new Error("immutable evidence Node heredoc is absent");
  return heredoc
    .split("\n")
    .map((line) => line.replace(/^ {10}/u, ""))
    .join("\n");
}

function phaseAdmissionHeredoc(workflow: string): string {
  const job = workflowJob(workflow, "phase-46-admission");
  const heredoc = job.match(/node - <<'NODE'\n([\s\S]*?)\n\s+NODE/u)?.[1];
  if (heredoc === undefined)
    throw new Error("phase-46-admission Node heredoc is absent");
  return heredoc
    .split("\n")
    .map((line) => line.replace(/^ {10}/u, ""))
    .join("\n");
}

type PhaseAdmissionScenario = {
  tupleOrder?: string[];
  omitTuple?: string;
  extraTuple?: string;
  substituteTuple?: string;
  malformedTuples?: "array" | "null" | "string";
  malformedItemTuple?: string;
  missingReport?: { tuple: string; key: "node22" | "node24" };
  rawDuplicateTuple?: boolean;
  requiredSourceFragments?: string[];
  sourceAuthority?: string;
  needsFailure?: boolean;
  invalidLedger?: boolean;
  nativeVersion?: number;
  tarballSha256?: string;
  corpusManifestSha256?: string;
  tamperInstalledReport?: {
    tuple: string;
    key: "node22" | "node24";
    property: string;
    value: unknown;
  };
  focusedSeed?: number;
  focusedPropertyRuns?: number;
  focusedAuthority?: unknown;
  focusedVersion?: number;
  focusedTuple?: string;
  focusedNodeVersion?: string;
  focusedManifestSha256?: string;
  envelopeImplementationSha?: string;
  foreignTupleSha?: { tuple: string; value: string };
  ledgerHeadSha?: string;
  ledgerRunId?: string;
  benchmarkFiles?: string[];
  benchmarkOverride?: {
    nodeMajor: 22 | 24;
    property: string;
    value: unknown;
  };
  rejectPhaseAdmissionChild?: boolean;
  rejectOutput?: boolean;
};

type PhaseAdmissionOutcome = {
  ok: boolean;
  pid: number;
  error?: string;
  installedValidations: string[];
  outputWrites: number;
};

function executePhaseAdmissionHeredoc(
  workflow: string,
  scenario: PhaseAdmissionScenario = {},
  heredocOverride?: string,
): PhaseAdmissionOutcome {
  const heredoc = heredocOverride ?? phaseAdmissionHeredoc(workflow);
  const runner = `
    const {createRequire}=require('node:module');
    const {join}=require('node:path');
    const nodeFs=require('node:fs');
    const nodeOs=require('node:os');
    const nodePath=require('node:path');
    const scenario=${JSON.stringify(scenario)};
    const heredoc=${JSON.stringify(heredoc)};
    const packageRoot=${JSON.stringify(packageRoot)};
    const canonical=['linux-x64','linux-arm64','darwin-x64','darwin-arm64','win32-x64','win32-arm64'];
    const tarballSha256=scenario.tarballSha256??'a'.repeat(64), corpusManifestSha256=scenario.corpusManifestSha256??'b'.repeat(64), baselineSha256='c2fc569b553cba360814bcce61d6882a02aba062e6d6da2193323915530a34bf';
    const makeReport=(tuple,nodeMajor)=>({version:1,tuple,nodeMajor,implementationSha:'d'.repeat(40),tarballSha256,corpusManifestSha256,conclusion:'pass'});
    let order=[...(scenario.tupleOrder??canonical)];
    if(scenario.omitTuple) order=order.filter(tuple=>tuple!==scenario.omitTuple);
    if(scenario.substituteTuple) order=order.map((tuple,index)=>index===order.length-1?scenario.substituteTuple:tuple);
    if(scenario.extraTuple) order.push(scenario.extraTuple);
    const runSha=scenario.envelopeImplementationSha??'d'.repeat(40), runId='35030048631';
    const tuples=Object.fromEntries(order.map(tuple=>[tuple,{implementationSha:scenario.foreignTupleSha?.tuple===tuple?scenario.foreignTupleSha.value:runSha,reports:{node22:makeReport(tuple,22),node24:makeReport(tuple,24)}}]));
    if(scenario.malformedItemTuple) tuples[scenario.malformedItemTuple]=null;
    if(scenario.missingReport) delete tuples[scenario.missingReport.tuple]?.reports?.[scenario.missingReport.key];
    if(scenario.tamperInstalledReport) tuples[scenario.tamperInstalledReport.tuple].reports[scenario.tamperInstalledReport.key][scenario.tamperInstalledReport.property]=scenario.tamperInstalledReport.value;
    let tupleContainer=tuples;
    if(scenario.malformedTuples==='array') tupleContainer=[];
    if(scenario.malformedTuples==='null') tupleContainer=null;
    if(scenario.malformedTuples==='string') tupleContainer='six tuples';
    const native={version:scenario.nativeVersion??1,implementationSha:runSha,tarballSha256,corpusManifestSha256,tuples:tupleContainer};
    let nativeBytes=JSON.stringify(native);
    if(scenario.rawDuplicateTuple){
      const entries=canonical.slice(0,-1).map(tuple=>[tuple,tuples[tuple]]);
      entries.push([canonical[0],tuples[canonical[0]]]);
      nativeBytes=\`{"version":1,"tarballSha256":"\${tarballSha256}","corpusManifestSha256":"\${corpusManifestSha256}","tuples":{\${entries.map(([tuple,value])=>\`\${JSON.stringify(tuple)}:\${JSON.stringify(value)}\`).join(',')}}\`;
    }
    const focused={version:scenario.focusedVersion??1,tuple:scenario.focusedTuple??'linux-x64',nodeVersion:scenario.focusedNodeVersion??'v24.11.1',seed:scenario.focusedSeed??460046,propertyRuns:scenario.focusedPropertyRuns??200,authority:scenario.focusedAuthority===undefined?{decoder:'independent'}:scenario.focusedAuthority,manifestSha256:scenario.focusedManifestSha256??corpusManifestSha256};
    const benchmark=(nodeMajor)=>{const report={version:4,warmups:2,measurements:100,elapsedP95Estimator:{retainedObservations:100},collection:{retries:0,discarded:0},environment:{nodeVersion:\`v\${nodeMajor}.0.0\`},pass:true,mode:'admit',baselinePackageName:'exifcleaner-node',baselineVersion:'0.1.1',baselineExpectedIdentity:\`exifcleaner-node@0.1.1#sha256:\${baselineSha256}\`,baselineSha256,candidateSha256:tarballSha256}; if(scenario.benchmarkOverride?.nodeMajor===nodeMajor){const parts=scenario.benchmarkOverride.property.split('.'); let target=report; for(const part of parts.slice(0,-1)) target=target[part]; target[parts.at(-1)]=scenario.benchmarkOverride.value;} return report;};
    const benchmarkFiles=scenario.benchmarkFiles??['benchmark-linux-node22/benchmark-node22.json','benchmark-linux-node22/benchmark-node22.json.md','benchmark-linux-node24/benchmark-node24.json','benchmark-linux-node24/benchmark-node24.json.md'];
    const reads=new Map([
      ['final-native/identity-cleanup-ledger.json',JSON.stringify({schemaVersion:scenario.invalidLedger?'forged-ledger':'phase-46-identity-cleanup-ledger/v1',run:{id:Number(scenario.ledgerRunId??runId),headSha:scenario.ledgerHeadSha??runSha}})],
      ['final-native/admission.json',nativeBytes],
      ['focused/qualification-linux.json',JSON.stringify(focused)],
      ['benchmarks/benchmark-linux-node22/benchmark-node22.json',JSON.stringify(benchmark(22))],
      ['benchmarks/benchmark-linux-node24/benchmark-node24.json',JSON.stringify(benchmark(24))],
    ]);
    const installedValidations=[], writes=[];
    let ledgerValidations=0, phaseAdmissions=0;
    const nativeRequire=createRequire(join(packageRoot,'tests','release_workflow_gate.test.ts'));
    const strictFs={
      readFileSync(path,encoding){
        if(encoding!=='utf8'||!reads.has(path)) throw new Error(\`HARNESS unexpected read \${path} \${encoding}\`);
        return reads.get(path);
      },
      readdirSync(path,options){
        if(path!=='benchmarks'||options?.recursive!==true) throw new Error(\`HARNESS unexpected readdir \${path}\`);
        return nodeFs.readdirSync(path,options);
      },
      writeFileSync(path,bytes){
        if(path!=='phase-46-admission.json'||typeof bytes!=='string') throw new Error(\`HARNESS unexpected write \${path}\`);
        if(scenario.rejectOutput) throw new Error('AUTHORITY aggregate output emission rejected');
        writes.push({path,value:JSON.parse(bytes)});
      },
    };
    const strictBenchmark={
      validateIdentityCleanupLedger(value){
        if(value?.schemaVersion!=='phase-46-identity-cleanup-ledger/v1') throw new Error('AUTHORITY identity cleanup ledger rejected');
        ledgerValidations+=1;
      },
      validateInstalledReport(report,tuple,nodeMajor,candidate){
        if(!canonical.includes(tuple)||report?.tuple!==tuple||report?.nodeMajor!==nodeMajor||report?.tarballSha256!==candidate?.tarballSha256||report?.corpusManifestSha256!==candidate?.corpusManifestSha256) throw new Error(\`AUTHORITY installed report rejected for \${tuple}/node\${nodeMajor}\`);
        installedValidations.push(\`\${tuple}/node\${nodeMajor}\`);
      },
    };
    const strictChildProcess={execFileSync(file,args,options){
      const expected=['scripts/qualification/benchmark-report.cjs','--phase-admission','benchmarks/benchmark-linux-node22/benchmark-node22.json','benchmarks/benchmark-linux-node24/benchmark-node24.json'];
      if(file!==process.execPath||JSON.stringify(args)!==JSON.stringify(expected)||options?.stdio!=='inherit') throw new Error('AUTHORITY phase-admission child invocation rejected');
      if(scenario.rejectPhaseAdmissionChild) throw new Error('AUTHORITY phase-admission child rejected');
      phaseAdmissions+=1;
    }};
    let sourceContractChecked=false;
    const strictRequire=(specifier)=>{
      if(!sourceContractChecked){
        sourceContractChecked=true;
        if((scenario.requiredSourceFragments??[]).some(fragment=>!heredoc.includes(fragment))) throw new Error(\`AUTHORITY source \${scenario.sourceAuthority??'contract'} rejected\`);
      }
      if(specifier==='node:fs') return strictFs;
      if(specifier==='node:path') return nativeRequire('node:path');
      if(specifier==='node:child_process') return strictChildProcess;
      if(specifier==='./scripts/qualification/benchmark-report.cjs') return strictBenchmark;
      if(specifier==='./scripts/release_workflow_gate.cjs') return nativeRequire(join(packageRoot,'scripts','release_workflow_gate.cjs'));
      throw new Error(\`HARNESS unexpected require \${specifier}\`);
    };
    process.env.NEEDS_JSON=JSON.stringify({quality:{result:scenario.needsFailure?'failure':'success'},'qualification-linux':{result:'success'},'immutable-sha-evidence':{result:'success'},'benchmark-linux':{result:'success'}});
    process.env.GITHUB_SHA='d'.repeat(40);
    process.env.GITHUB_RUN_ID=runId;
    const previousCwd=process.cwd();
    const tempRoot=nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(),'phase-46-benchmarks-'));
    nodeFs.mkdirSync(nodePath.join(tempRoot,'benchmarks'),{recursive:true});
    for(const relative of benchmarkFiles){
      const target=nodePath.join(tempRoot,'benchmarks',relative);
      nodeFs.mkdirSync(nodePath.dirname(target),{recursive:true});
      nodeFs.writeFileSync(target,'');
    }
    process.chdir(tempRoot);
    try{
    try{
      new Function('require',heredoc)(strictRequire);
      const expectedValidations=canonical.flatMap(tuple=>[\`\${tuple}/node22\`,\`\${tuple}/node24\`]);
      if(JSON.stringify(installedValidations)!==JSON.stringify(expectedValidations)) throw new Error('AUTHORITY installed validation order/count rejected');
      if(ledgerValidations!==1||phaseAdmissions!==1||writes.length!==1) throw new Error('AUTHORITY aggregate side-effect contract rejected');
      process.stdout.write(JSON.stringify({ok:true,pid:process.pid,installedValidations,outputWrites:writes.length}));
    }catch(error){
      process.stdout.write(JSON.stringify({ok:false,pid:process.pid,error:String(error?.message??error),installedValidations,outputWrites:writes.length}));
    }
    }finally{
      process.chdir(previousCwd);
      nodeFs.rmSync(tempRoot,{recursive:true,force:true});
    }
  `;
  const child = spawnSync(process.execPath, ["--input-type=commonjs"], {
    cwd: packageRoot,
    input: runner,
    encoding: "utf8",
  });
  if (child.error !== undefined) throw child.error;
  if (child.status !== 0 || child.stderr !== "")
    throw new Error(
      `phase admission child failed (${child.status}): ${child.stderr}`,
    );
  return JSON.parse(child.stdout) as PhaseAdmissionOutcome;
}

function executeProductionTupleStage(
  workflow: string,
  manifest: readonly Record<string, unknown>[],
): { tuples: string[]; mappedTuples: string[] } {
  const heredoc = immutableEvidenceHeredoc(workflow);
  const tupleStage = heredoc.split(" const candidate=")[0];
  if (tupleStage === heredoc)
    throw new Error("immutable evidence tuple stage boundary is absent");
  return runInNewContext(
    `${tupleStage}; ({tuples:[...tuples],mappedTuples:[...byTuple.keys()]})`,
    {
      require(specifier: string) {
        if (specifier === "node:fs")
          return {
            readFileSync(path: string) {
              if (path === "admitted/tarball.sha256")
                return `${"a".repeat(64)}  candidate.tgz\n`;
              if (path === "admitted/native-manifest.json")
                return JSON.stringify(manifest);
              if (path === "tests/corpus/manifest.json") return "{}";
              throw new Error(`unexpected tuple-stage read: ${path}`);
            },
          };
        if (specifier === "node:path" || specifier === "node:crypto")
          return require(specifier);
        if (specifier === "./scripts/release_workflow_gate.cjs") return gate;
        if (specifier === "./scripts/qualification/benchmark-report.cjs")
          return { validateIdentityCleanupLedger() {} };
        throw new Error(`unexpected tuple-stage require: ${specifier}`);
      },
    },
  ) as { tuples: string[]; mappedTuples: string[] };
}

function validateImmutableEvidenceWorkflow(workflow: string): void {
  const heredoc = immutableEvidenceHeredoc(workflow);
  for (const required of [
    "CANONICAL_NATIVE_TUPLES:tuples,validateExactNativeManifestTuples",
    "const byTuple=validateExactNativeManifestTuples(manifest)",
    "ref:process.env.GITHUB_REF_NAME",
    "for(const tuple of tuples)",
    "record.sha256",
    "record.auditReportSha256",
    "implementationSha:process.env.GITHUB_SHA",
    "validateIdentityCleanupLedger(ledger)",
    "['node-22.json','node-24.json']",
  ])
    if (!heredoc.includes(required))
      throw new Error(`immutable evidence workflow lacks ${required}`);
  if (heredoc.includes("ref:process.env.GITHUB_REF,"))
    throw new Error("immutable evidence workflow serializes a full ref");

  const canonical = [
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "win32-x64",
    "win32-arm64",
  ];
  const manifest = [...canonical].reverse().map((tuple) => ({
    tuple,
    sha256: "a".repeat(64),
    auditReportSha256: "b".repeat(64),
  }));
  const result = executeProductionTupleStage(workflow, manifest);
  if (
    result.tuples.join(",") !== canonical.join(",") ||
    result.mappedTuples.join(",") !== canonical.join(",")
  )
    throw new Error("immutable evidence workflow lost canonical tuple order");
}

function loadTupleGate(source: string): TupleGate {
  const freshModule: { exports: unknown } = { exports: {} };
  runInNewContext(source, {
    console,
    module: freshModule,
    exports: freshModule.exports,
    require,
  });
  return freshModule.exports as TupleGate;
}

function validateTupleGateAuthority(candidate: TupleGate): void {
  const canonical = [
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "win32-x64",
    "win32-arm64",
  ];
  const records = canonical.map((tuple) => ({ tuple }));
  const byTuple = candidate.validateExactNativeManifestTuples(
    [...records].reverse(),
  );
  if (
    candidate.CANONICAL_NATIVE_TUPLES.join(",") !== canonical.join(",") ||
    [...byTuple.keys()].join(",") !== canonical.join(",")
  )
    throw new Error("tuple gate canonical authority changed");
  for (const invalid of [
    records.slice(1),
    [...records.slice(0, -1), records[0]!],
    [...records.slice(0, -1), { tuple: "linux-riscv64" }],
  ]) {
    let rejected = false;
    try {
      candidate.validateExactNativeManifestTuples(invalid);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("tuple gate accepted softened membership");
  }
}

function validateBenchmarkWorkflow(workflow: string): void {
  const benchmarkJob = workflowJob(
    workflow,
    "benchmark-linux",
    "phase-46-admission",
  );
  const admissionJob = workflowJob(workflow, "phase-46-admission");
  const freshContract =
    "report.version!==4||report.warmups!==2||report.measurements!==100||report.elapsedP95Estimator?.retainedObservations!==100||report.collection?.retries!==0||report.collection?.discarded!==0";
  for (const required of [
    "node: [22, 24]",
    "npm run benchmark:qualify -- --baseline-tarball",
    "node scripts/qualification/benchmark-report.cjs --validate-report",
    freshContract,
  ])
    if (!benchmarkJob.includes(required))
      throw new Error(`benchmark producer job lacks ${required}`);
  for (const forbidden of [
    /BENCHMARK_(?:MEASUREMENTS|SAMPLES|RETRIES)/u,
    /--(?:measurements|samples|retries)\b/u,
    /timeout-minutes:/u,
    /continue-on-error:\s*true/u,
    /for\s+attempt\b|while\s+.*attempt|retry\s+vote|outlier/u,
  ])
    if (forbidden.test(benchmarkJob))
      throw new Error("benchmark producer contains a sample shortcut");
  for (const required of [
    "- benchmark-linux",
    "benchmark-linux-node22/benchmark-node22.json",
    "benchmark-linux-node24/benchmark-node24.json",
    "const benchmarkReports=files.map",
    freshContract,
    "--phase-admission',...files.map",
    "majors.join(',')!=='22,24'",
    "reportVersion:report.version",
    "retainedObservationCount:report.elapsedP95Estimator.retainedObservations",
  ])
    if (!admissionJob.includes(required))
      throw new Error(`benchmark aggregate lacks ${required}`);
}

function greenGraph(): WorkflowGraph {
  return {
    jobs: {
      "native-admission": {
        script: "uses ci.yml immutable SHA admitted tarball",
      },
      ...Object.fromEntries(
        authorities.map((authority) => [
          authority,
          {
            needs: ["native-admission"],
            script:
              authority === "immutable-sha-evidence"
                ? "admission.json implementationSha tarballSha256"
                : `admission.json ${authority.replace("installed-", "")} implementationSha tarballSha256`,
          },
        ]),
      ),
      publish: {
        needs: authorities,
        script: "npm publish admitted/exifcleaner-node.tgz --access public",
      },
    },
  };
}

describe("release workflow authority gate", () => {
  it("executes the real final-admission heredoc in isolated children for exact-six permutations and invalid envelopes", () => {
    const workflow = readFileSync(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const canonical = [...gate.CANONICAL_NATIVE_TUPLES];
    const valid = [{}].map((scenario) =>
      executePhaseAdmissionHeredoc(workflow, scenario),
    );

    for (const tupleOrder of [
      [...canonical].reverse(),
      [...canonical.slice(2), ...canonical.slice(0, 2)],
    ]) {
      const permuted = executePhaseAdmissionHeredoc(workflow, { tupleOrder });
      expect(permuted.ok).toBe(false);
      expect(permuted.error).toBe("installed tuple traversal is not canonical");
      expect(permuted.error).not.toMatch(/^HARNESS|SyntaxError/u);
      expect(permuted.outputWrites).toBe(0);
    }
    for (const outcome of valid) {
      expect(outcome.ok, outcome.error).toBe(true);
      expect(outcome.installedValidations).toEqual(
        canonical.flatMap((tuple) => [`${tuple}/node22`, `${tuple}/node24`]),
      );
      expect(outcome.outputWrites).toBe(1);
    }

    const invalid = [
      { omitTuple: "win32-arm64" },
      { extraTuple: "linux-riscv64" },
      { substituteTuple: "linux-riscv64" },
      { malformedTuples: "array" as const },
      { malformedTuples: "null" as const },
      { malformedTuples: "string" as const },
      { malformedItemTuple: "darwin-arm64" },
      { missingReport: { tuple: "linux-x64", key: "node22" as const } },
      { rawDuplicateTuple: true },
    ].map((scenario) => executePhaseAdmissionHeredoc(workflow, scenario));
    for (const outcome of invalid) {
      expect(outcome.ok).toBe(false);
      expect(outcome.outputWrites).toBe(0);
    }
    expect(
      new Set([...valid, ...invalid].map((outcome) => outcome.pid)).size,
    ).toBe(valid.length + invalid.length);
  });

  it("compares the benchmark artifact file set against a real directory tree", () => {
    const workflow = readFileSync(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const expected = [
      "benchmark-linux-node22/benchmark-node22.json",
      "benchmark-linux-node22/benchmark-node22.json.md",
      "benchmark-linux-node24/benchmark-node24.json",
      "benchmark-linux-node24/benchmark-node24.json.md",
    ];

    const accept = executePhaseAdmissionHeredoc(workflow, {
      benchmarkFiles: [...expected],
    });
    expect(accept.ok, accept.error).toBe(true);
    expect(accept.outputWrites).toBe(1);

    const stray = executePhaseAdmissionHeredoc(workflow, {
      benchmarkFiles: [...expected, "benchmark-linux-node22/stray.json"],
    });
    expect(stray.ok).toBe(false);
    expect(stray.error).toMatch(/benchmark artifact file set is not exact/u);
    expect(stray.error).not.toMatch(/^HARNESS|SyntaxError/u);
    expect(stray.outputWrites).toBe(0);

    const missing = executePhaseAdmissionHeredoc(workflow, {
      benchmarkFiles: expected.filter(
        (file) => file !== "benchmark-linux-node24/benchmark-node24.json.md",
      ),
    });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/benchmark artifact file set is not exact/u);
    expect(missing.error).not.toMatch(/^HARNESS|SyntaxError/u);
    expect(missing.outputWrites).toBe(0);
  });

  it("rejects every non-tuple authority failure before aggregate output in isolated children", () => {
    const workflow = readFileSync(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const cases: PhaseAdmissionScenario[] = [
      { needsFailure: true },
      { invalidLedger: true },
      { nativeVersion: 2 },
      { tarballSha256: "not-a-sha" },
      { corpusManifestSha256: "not-a-sha" },
      {
        tamperInstalledReport: {
          tuple: "linux-x64",
          key: "node22",
          property: "tarballSha256",
          value: "f".repeat(64),
        },
      },
      { focusedSeed: 46 },
      { focusedPropertyRuns: 199 },
      { focusedAuthority: null },
      {
        benchmarkFiles: [
          "benchmark-linux-node22/benchmark-node22.json",
          "benchmark-linux-node24/benchmark-node24.json",
        ],
      },
      { benchmarkOverride: { nodeMajor: 22, property: "version", value: 3 } },
      {
        benchmarkOverride: {
          nodeMajor: 22,
          property: "measurements",
          value: 99,
        },
      },
      {
        benchmarkOverride: {
          nodeMajor: 22,
          property: "elapsedP95Estimator.retainedObservations",
          value: 99,
        },
      },
      {
        benchmarkOverride: {
          nodeMajor: 22,
          property: "collection.retries",
          value: 1,
        },
      },
      {
        benchmarkOverride: {
          nodeMajor: 22,
          property: "collection.discarded",
          value: 1,
        },
      },
      {
        benchmarkOverride: {
          nodeMajor: 22,
          property: "environment.nodeVersion",
          value: "v24.0.0",
        },
      },
      {
        benchmarkOverride: {
          nodeMajor: 24,
          property: "candidateSha256",
          value: "f".repeat(64),
        },
      },
      { rejectPhaseAdmissionChild: true },
      { rejectOutput: true },
    ];
    const outcomes = cases.map((scenario) =>
      executePhaseAdmissionHeredoc(workflow, scenario),
    );
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false);
      expect(outcome.error).not.toMatch(/^HARNESS|SyntaxError/u);
      expect(outcome.outputWrites).toBe(0);
    }
    expect(new Set(outcomes.map((outcome) => outcome.pid)).size).toBe(
      outcomes.length,
    );
  });

  it("executes no-op-guarded final-admission source mutants in isolated children and rejects each named authority", () => {
    const workflow = readFileSync(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const heredoc = phaseAdmissionHeredoc(workflow);
    const mutations = [
      {
        authority: "shared tuple import",
        from: "const {CANONICAL_NATIVE_TUPLES:tuples,validateExactNativeManifestTuples}=require('./scripts/release_workflow_gate.cjs')",
        to: "const tuples=['linux-x64','linux-arm64','darwin-x64','darwin-arm64','win32-x64','win32-arm64'],validateExactNativeManifestTuples=records=>new Map(records.map(record=>[record.tuple,record]))",
      },
      {
        authority: "exact tuple validator",
        from: "validateExactNativeManifestTuples(producerTuples.map(tuple=>({tuple,value:native.tuples[tuple]})))",
        to: "new Map(producerTuples.map(tuple=>[tuple,{tuple,value:native.tuples[tuple]}]))",
      },
      {
        authority: "asymmetric tuple sort",
        from: "native.tuples===null||typeof native.tuples!=='object'||Array.isArray(native.tuples)",
        to: "Object.prototype.toString.call(native.tuples)!=='[object Object]'||JSON.stringify(Object.keys(native.tuples).sort())!==JSON.stringify(tuples)",
      },
      {
        authority: "canonical tuple result",
        from: "JSON.stringify(producerTuples)!==JSON.stringify(tuples)",
        to: "JSON.stringify([...byTuple.keys()])!==JSON.stringify(tuples)",
      },
      {
        authority: "canonical tuple traversal",
        from: "for(const [tuple,record] of byTuple)",
        to: "for(const [tuple,record] of Object.entries(native.tuples).map(([tuple,value])=>[tuple,{tuple,value}]))",
      },
      {
        authority: "validated tuple map consumption",
        from: "const item=record.value",
        to: "const item=native.tuples[tuple]",
      },
      {
        authority: "native admission version",
        from: "native.version!==1",
        to: "false",
      },
      {
        authority: "native tarball SHA",
        from: "!sha(native.tarballSha256)",
        to: "false",
      },
      {
        authority: "native corpus SHA",
        from: "!sha(native.corpusManifestSha256)",
        to: "false",
      },
      {
        authority: "identity cleanup ledger",
        from: "validateIdentityCleanupLedger(ledger)",
        to: "void ledger",
      },
      {
        authority: "exact installed report map",
        from: "JSON.stringify(Object.keys(item.reports??{}).sort())!==JSON.stringify(['node22','node24'])",
        to: "false",
      },
      {
        authority: "twelve installed reports",
        from: "reports.length!==2*tuples.length",
        to: "false",
      },
      {
        authority: "focused seed",
        from: "focused.seed!==460046",
        to: "false",
      },
      {
        authority: "focused property runs",
        from: "focused.propertyRuns!==200",
        to: "false",
      },
      {
        authority: "focused oracle",
        from: "typeof focused.authority!=='object'",
        to: "false",
      },
      {
        authority: "focused oracle emptiness",
        from: "Object.keys(focused.authority).length===0",
        to: "false",
      },
      {
        authority: "focused conclusion version",
        from: "focused.version!==1",
        to: "false",
      },
      {
        authority: "focused tuple",
        from: "focused.tuple!=='linux-x64'",
        to: "false",
      },
      {
        authority: "focused Node major",
        from: "!/^v24\\./.test(focused.nodeVersion??'')",
        to: "false",
      },
      {
        authority: "focused corpus digest binding",
        from: "focused.manifestSha256!==native.corpusManifestSha256",
        to: "false",
      },
      {
        authority: "producer tuple key order",
        from: "const producerTuples=Object.keys(native.tuples)",
        to: "const producerTuples=[...tuples]",
      },
      {
        authority: "envelope report count",
        from: "envelopeReportCount!==2*tuples.length",
        to: "false",
      },
      {
        authority: "envelope run binding",
        from: "native.implementationSha!==process.env.GITHUB_SHA",
        to: "false",
      },
      {
        authority: "per-tuple run binding",
        from: "item.implementationSha!==process.env.GITHUB_SHA",
        to: "false",
      },
      {
        authority: "identity cleanup ledger run binding",
        from: "ledger.run?.headSha!==process.env.GITHUB_SHA||String(ledger.run?.id)!==String(process.env.GITHUB_RUN_ID)",
        to: "false",
      },
      {
        authority: "exact benchmark files",
        from: "JSON.stringify(actualBenchmarkFiles)!==JSON.stringify(expectedBenchmarkFiles)",
        to: "false",
      },
      {
        authority: "benchmark schema v4",
        from: "report.version!==4",
        to: "false",
      },
      {
        authority: "benchmark sample count",
        from: "report.measurements!==100",
        to: "false",
      },
      {
        authority: "benchmark retained observations",
        from: "report.elapsedP95Estimator?.retainedObservations!==100",
        to: "false",
      },
      {
        authority: "benchmark retry exclusion",
        from: "report.collection?.retries!==0",
        to: "false",
      },
      {
        authority: "benchmark discard exclusion",
        from: "report.collection?.discarded!==0",
        to: "false",
      },
      {
        authority: "benchmark Node major",
        from: "Number(report.environment?.nodeVersion?.match(/^v(\\d+)/)?.[1])!==[22,24][index]",
        to: "false",
      },
      {
        authority: "benchmark package digest",
        from: "report.candidateSha256!==native.tarballSha256",
        to: "false",
      },
      {
        authority: "upstream needs graph",
        from: "Object.values(needs).some(value=>value.result!=='success')",
        to: "false",
      },
      {
        authority: "phase admission child",
        from: "require('node:child_process').execFileSync(process.execPath,['scripts/qualification/benchmark-report.cjs','--phase-admission',...files.map(file=>path.join('benchmarks',file))],{stdio:'inherit'})",
        to: "void 0",
      },
      {
        authority: "aggregate output emission",
        from: "fs.writeFileSync('phase-46-admission.json'",
        to: "void ('phase-46-admission.json'",
      },
    ];
    const outcomes = mutations.map(({ authority, from, to }) => {
      const mutation = heredoc.replace(from, to);
      expect(mutation, authority).not.toBe(heredoc);
      const outcome = executePhaseAdmissionHeredoc(
        workflow,
        {
          requiredSourceFragments: [from],
          sourceAuthority: authority,
        },
        mutation,
      );
      expect(outcome.ok, authority).toBe(false);
      expect(outcome.error).toBe(`AUTHORITY source ${authority} rejected`);
      expect(outcome.outputWrites).toBe(0);
      return outcome;
    });
    expect(new Set(outcomes.map((outcome) => outcome.pid)).size).toBe(
      outcomes.length,
    );
  });

  it("accepts a permuted exact-six manifest through the production immutable tuple stage", () => {
    const workflow = readFileSync(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const canonical = [
      "linux-x64",
      "linux-arm64",
      "darwin-x64",
      "darwin-arm64",
      "win32-x64",
      "win32-arm64",
    ];
    const manifest = [...canonical].reverse().map((tuple) => ({
      tuple,
      sha256: "a".repeat(64),
      auditReportSha256: "b".repeat(64),
    }));

    expect(executeProductionTupleStage(workflow, manifest)).toEqual({
      tuples: canonical,
      mappedTuples: canonical,
    });
  });

  it("canonicalizes exact-six manifest permutations and rejects malformed membership", () => {
    const canonical = [...gate.CANONICAL_NATIVE_TUPLES];
    const records = canonical.map((tuple) => ({ tuple, marker: tuple }));
    const permutations = [
      records,
      [...records].reverse(),
      [...records.slice(2), ...records.slice(0, 2)],
      [
        records[5]!,
        records[0]!,
        records[3]!,
        records[1]!,
        records[4]!,
        records[2]!,
      ],
    ];
    for (const manifest of permutations) {
      const byTuple = gate.validateExactNativeManifestTuples(manifest);
      expect([...byTuple.keys()]).toEqual(canonical);
      expect([...byTuple.values()].map((record) => record.tuple)).toEqual(
        canonical,
      );
    }
    expect(Object.isFrozen(gate.CANONICAL_NATIVE_TUPLES)).toBe(true);

    const invalid: unknown[] = [
      records.slice(1),
      [...records, { tuple: "linux-riscv64" }],
      [...records.slice(0, -1), records[0]],
      [...records.slice(0, -1), { tuple: "linux-riscv64" }],
      [...records.slice(0, -1), { tuple: 22 }],
      [...records.slice(0, -1), {}],
      [...records.slice(0, -1), null],
      [...records.slice(0, -1), []],
      { records },
    ];
    for (const manifest of invalid)
      expect(() =>
        gate.validateExactNativeManifestTuples(
          manifest as readonly Record<string, unknown>[],
        ),
      ).toThrow();
  });

  it("fails closed when immutable tuple authority wiring is mutated", () => {
    const workflow = readFileSync(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    expect(() => validateImmutableEvidenceWorkflow(workflow)).not.toThrow();
    const mutations = [
      workflow.replace(
        "const byTuple=validateExactNativeManifestTuples(manifest)",
        "const byTuple=new Map(manifest.map(record=>[record.tuple,record]))",
      ),
      workflow.replace(
        "CANONICAL_NATIVE_TUPLES:tuples,validateExactNativeManifestTuples",
        "CANONICAL_NATIVE_TUPLES:tuples",
      ),
      workflow.replace("GITHUB_REF_NAME", "GITHUB_REF"),
    ];
    for (const mutation of mutations) {
      expect(mutation).not.toBe(workflow);
      expect(() => validateImmutableEvidenceWorkflow(mutation)).toThrow();
    }
  });

  it("executes every tuple-helper mutation in a fresh VM and rejects softening", () => {
    const source = readFileSync(
      join(packageRoot, "scripts", "release_workflow_gate.cjs"),
      "utf8",
    );
    expect(() =>
      validateTupleGateAuthority(loadTupleGate(source)),
    ).not.toThrow();
    const mutations = [
      ...[
        "linux-x64",
        "linux-arm64",
        "darwin-x64",
        "darwin-arm64",
        "win32-x64",
        "win32-arm64",
      ].map((tuple) => source.replace(`"${tuple}"`, `"${tuple}-forged"`)),
      source.replace(
        "if (JSON.stringify(actualTuples) !== JSON.stringify(expectedTuples))",
        "if (manifest.length !== CANONICAL_NATIVE_TUPLES.length)",
      ),
      source.replace(
        "return new Map(\n    CANONICAL_NATIVE_TUPLES.map((tuple) => [tuple, observed.get(tuple)]),\n  );",
        "return observed;",
      ),
    ];
    for (const mutation of mutations) {
      expect(mutation).not.toBe(source);
      expect(() =>
        validateTupleGateAuthority(loadTupleGate(mutation)),
      ).toThrow();
    }
  });

  it("keeps complete Windows diagnostics outside every authority path", () => {
    const workflow = readFileSync(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    expect(() => validateWindowsDiagnosticWorkflow(workflow)).not.toThrow();
    const mutations = [
      workflow.replace(
        "if: always() && matrix.os == 'win32'",
        "if: matrix.os == 'win32'",
      ),
      workflow.replaceAll(
        "if: always() && matrix.os == 'win32'",
        "if: matrix.os == 'win32'",
      ),
      workflow.replace(
        "WINDOWS_PUBLICATION_DIAGNOSTIC_PATH",
        "WINDOWS_PUBLICATION_LATE_PATH",
      ),
      workflow.replace(
        "--windows-publication-diagnostic-output",
        "--ignored-output",
      ),
      workflow.replaceAll("win32-x64", "win32-x86"),
      workflow.replaceAll("win32-arm64", "win32-arm"),
      workflow.replaceAll(matchingPath, "renamed-matching.json"),
      workflow.replaceAll(installedPath, "renamed-installed.json"),
      workflow.replaceAll(cancellationPath, "renamed-cancellation.json"),
      workflow.replace(
        "--windows-cancellation-diagnostic-output",
        "--ignored-cancellation-output",
      ),
      `${workflow}\n# pattern: windows-publication-matching-host-*`,
      `${workflow}\n# needs: windows-publication-installed-node22-*`,
      `${workflow}\n# pattern: windows-cancellation-installed-node22-*`,
      `${workflow}\n# needs: windows-cancellation-installed-node22-*`,
      `${workflow}\ncontinue-on-error: true`,
      `${workflow}\n# || true`,
    ];
    for (const mutation of mutations)
      expect(() => validateWindowsDiagnosticWorkflow(mutation)).toThrow();

    const nativeTest = readFileSync(
      join(packageRoot, "tests", "native_publication.test.ts"),
      "utf8",
    );
    expect(nativeTest).toMatch(
      /const observation = smokeHelper\.classifyWindowsPublicationEvidence\([\s\S]{0,160}binding\.takeLastWindowsPublicationEvidence\(\)[\s\S]{0,900}await writeFile\([\s\S]{0,900}expect\(observation\)\.toMatchObject/u,
    );
    expect(nativeTest).toContain(
      "expect(binding.takeLastWindowsPublicationEvidence()).toBeUndefined()",
    );
    const packageSmoke = readFileSync(
      join(packageRoot, "scripts", "package_smoke.cjs"),
      "utf8",
    );
    expect(packageSmoke).toMatch(
      /if \(windowsCancellationDiagnosticOutput !== undefined\)[\s\S]{0,1200}writeFileSync\([\s\S]{0,1200}if \(observation\.reason !== "accepted"\)[\s\S]{0,200}throw new Error\("Installed deterministic cancellation contract failed"\)/u,
    );
  });
  it("makes the raw identity-cleanup ledger a non-optional CI authority", () => {
    const workflow = readFileSync(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    for (const required of [
      "validateIdentityCleanupLedger",
      "identity-cleanup-ledger.json",
      "--ignore-scripts",
      "fail-fast: false",
      "implementation.sha",
      "auditReportSha256",
      "linux-x64",
      "linux-arm64",
      "darwin-x64",
      "darwin-arm64",
      "win32-x64",
      "win32-arm64",
    ])
      expect(workflow).toContain(required);
    for (const forbidden of ["npm install --foreground-scripts", "retry vote"])
      expect(workflow).not.toContain(forbidden);
  });
  it("makes exact version-4 100-sample reports a hard hosted authority", () => {
    const workflow = readFileSync(
      join(packageRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    expect(() => validateBenchmarkWorkflow(workflow)).not.toThrow();
    const mutations = [
      workflow.replace("report.version!==4", "report.version!==3"),
      workflow.replace("report.measurements!==100", "report.measurements!==15"),
      workflow.replace(
        "report.elapsedP95Estimator?.retainedObservations!==100",
        "report.elapsedP95Estimator?.retainedObservations!==99",
      ),
      workflow.replace(
        "report.collection?.retries!==0",
        "report.collection?.retries!==1",
      ),
      workflow.replace(
        "report.collection?.discarded!==0",
        "report.collection?.discarded!==1",
      ),
      workflow.replace("node: [22, 24]", "node: [24]"),
      workflow.replace(
        "node scripts/qualification/benchmark-report.cjs --validate-report",
        "cp replacement.json benchmark-node${{ matrix.node }}.json #",
      ),
      workflow.replace(
        "const benchmarkReports=files.map",
        "const replacementReports=files.map",
      ),
      workflow.replace("      - benchmark-linux\n", ""),
      workflow.replace(
        "  benchmark-linux:\n    name:",
        "  benchmark-linux:\n    timeout-minutes: 1\n    name:",
      ),
      workflow.replace(
        "npm run benchmark:qualify --",
        "BENCHMARK_MEASUREMENTS=99 npm run benchmark:qualify --",
      ),
      workflow.replace(
        "npm run benchmark:qualify --",
        "for attempt in 1 2; do npm run benchmark:qualify --",
      ),
    ];
    for (const mutation of mutations) {
      expect(mutation).not.toBe(workflow);
      expect(() => validateBenchmarkWorkflow(mutation)).toThrow();
    }
  });
  it("accepts the production graph only with all immutable installed authorities", () => {
    expect(() => gate.validateReleaseGraph(greenGraph())).not.toThrow();
  });

  it.each(authorities)("rejects missing %s authority", (authority) => {
    const graph = greenGraph();
    const publish = graph.jobs.publish!;
    publish.needs = (publish.needs ?? []).filter((name) => name !== authority);
    expect(() => gate.validateReleaseGraph(graph)).toThrow(/authority|needs/i);
  });

  it("rejects bypass, mutable identity, digest substitution, rebuild, cycles, and unknown needs", () => {
    for (const mutate of [
      (graph: ReturnType<typeof greenGraph>) => {
        graph.jobs.publish!.needs = [];
      },
      (graph: ReturnType<typeof greenGraph>) => {
        graph.jobs["immutable-sha-evidence"]!.script = "latest run";
      },
      (graph: ReturnType<typeof greenGraph>) => {
        graph.jobs["installed-linux-x64"]!.script =
          "admission.json implementationSha otherDigest";
      },
      (graph: ReturnType<typeof greenGraph>) => {
        graph.jobs["installed-linux-x64"]!.script += " npm run build";
      },
      (graph: ReturnType<typeof greenGraph>) => {
        graph.jobs["native-admission"]!.needs = ["publish"];
      },
      (graph: ReturnType<typeof greenGraph>) => {
        graph.jobs.publish!.needs = ["not-a-job"];
      },
      (graph: ReturnType<typeof greenGraph>) => {
        graph.jobs.publish!.script = "npm publish package-local.tgz";
      },
    ]) {
      const graph = greenGraph();
      mutate(graph);
      expect(() => gate.validateReleaseGraph(graph)).toThrow();
    }
  });
});

describe("p95 null-branch closure gate (46-33)", () => {
  const closurePath = join(
    phase46EvidenceDirectory,
    "46-P95-NULL-BRANCH-CLOSURE.json",
  );
  const ledgerPath = join(
    phase46EvidenceDirectory,
    "46-PERFORMANCE-P95-DIAGNOSTIC.json",
  );

  // ALWAYS RUNS, including in a hosted checkout where the gated test below is
  // skipped.  The title is a LITERAL string, deliberately not derived from the
  // value `evidenceGatedIt` registers.
  it("pins the evidence-gated test registry for this file", () => {
    const pinned = [
      "seals a real null-branch closure record bound to the sealed ledger and fails closed on drift (null-branch closure)",
    ];
    expect(pinned).toHaveLength(1);
    expect([...evidenceGatedTestTitles()].sort()).toEqual([...pinned].sort());
  });

  evidenceGatedIt(
    "seals a real null-branch closure record bound to the sealed ledger and fails closed on drift (null-branch closure)",
    () => {
      const closure = JSON.parse(readFileSync(closurePath, "utf8")) as {
        ledger: { sha256: string };
        sourceTip: { headSha: string };
        claim: { established: string; notEstablished: string };
      };
      const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
        actionableBranch: string | null;
      };
      expect(ledger.actionableBranch).toBeNull();
      expect(() =>
        benchmarkReport.validateP95NullBranchClosure(closure, ledger),
      ).not.toThrow();

      const wrongLedgerSha256 = structuredClone(closure);
      wrongLedgerSha256.ledger.sha256 = "0".repeat(64);
      expect(() =>
        benchmarkReport.validateP95NullBranchClosure(wrongLedgerSha256, ledger),
      ).toThrow();

      const wrongHeadSha = structuredClone(closure);
      wrongHeadSha.sourceTip.headSha = "b".repeat(40);
      expect(() =>
        benchmarkReport.validateP95NullBranchClosure(wrongHeadSha, ledger),
      ).toThrow();

      for (const term of [
        "flaky",
        "noise",
        "environmental",
        "transient",
        "confirmed",
        "proven",
        "non-issue",
      ]) {
        const reinjected = structuredClone(closure);
        reinjected.claim.established = `${reinjected.claim.established} This was ${term}.`;
        expect(() =>
          benchmarkReport.validateP95NullBranchClosure(reinjected, ledger),
        ).toThrow();
      }
    },
    30_000,
  );
});

const focusedConclusionStep =
  "      - name: Record focused qualification conclusion";
const focusedHeredocOpener = "node - <<'NODE'";

function qualificationConclusionProducer(workflow: string): string {
  const job = workflowJob(workflow, "qualification-linux", "identity-prebuild");
  if (!job.includes(focusedConclusionStep))
    throw new Error("focused qualification conclusion step is absent");
  const openers = job.split(focusedHeredocOpener).length - 1;
  if (openers !== 1)
    throw new Error(
      `qualification-linux must hold exactly one Node heredoc, found ${openers}`,
    );
  const heredoc = job.match(/node - <<'NODE'\n([\s\S]*?)\n\s+NODE/u)?.[1];
  if (heredoc === undefined)
    throw new Error("qualification-linux Node heredoc is absent");
  return heredoc
    .split("\n")
    .map((line) => line.replace(/^ {10}/u, ""))
    .join("\n");
}

type ProducerOutcome = {
  status: number;
  wroteConclusion: boolean;
  conclusion: Record<string, unknown> | null;
  errorLine: string | null;
};

function executeConclusionProducer(
  body: string,
  bindings: Readonly<Record<string, string>>,
): ProducerOutcome {
  const cwd = mkdtempSync(join(tmpdir(), "focused-authority-"));
  try {
    mkdirSync(join(cwd, "tests", "corpus"), { recursive: true });
    copyFileSync(
      join(packageRoot, "tests", "corpus", "manifest.json"),
      join(cwd, "tests", "corpus", "manifest.json"),
    );
    writeFileSync(
      join(cwd, "oracle-authority.json"),
      JSON.stringify({ "offline-oracle": "stub" }),
    );
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.FC_SEED;
    delete env.FC_RUNS;
    Object.assign(env, bindings);
    const child = spawnSync(process.execPath, ["-"], {
      cwd,
      env,
      input: body,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (child.error !== undefined) throw child.error;
    if (child.signal !== null)
      throw new Error(`conclusion producer was killed by ${child.signal}`);
    if (child.status === null)
      throw new Error("conclusion producer never exited");
    if (/^HARNESS|SyntaxError/u.test(`${child.stdout}${child.stderr}`))
      throw new Error(
        `conclusion producer failed structurally: ${child.stderr}`,
      );
    const conclusionPath = join(cwd, "qualification-linux.json");
    const wroteConclusion = existsSync(conclusionPath);
    return {
      status: child.status,
      wroteConclusion,
      conclusion: wroteConclusion
        ? (JSON.parse(readFileSync(conclusionPath, "utf8")) as Record<
            string,
            unknown
          >)
        : null,
      errorLine:
        child.stderr
          .split("\n")
          .map((line) => line.trim())
          .find((line) => /^Error: /u.test(line)) ?? null,
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const focusedAuthorityMessages = {
  FC_SEED: {
    absent: "Error: focused FC_SEED authority is absent",
    notPositiveDecimal:
      "Error: focused FC_SEED authority is not a positive decimal integer",
    notSafeInteger: "Error: focused FC_SEED authority is not a safe integer",
  },
  FC_RUNS: {
    absent: "Error: focused FC_RUNS authority is absent",
    notPositiveDecimal:
      "Error: focused FC_RUNS authority is not a positive decimal integer",
    notSafeInteger: "Error: focused FC_RUNS authority is not a safe integer",
  },
} as const;

const focusedRejections: readonly {
  label: string;
  bindings: Record<string, string>;
  errorLine: string;
}[] = [
  {
    label: "absent FC_SEED",
    bindings: { FC_RUNS: "200" },
    errorLine: focusedAuthorityMessages.FC_SEED.absent,
  },
  {
    label: "empty FC_SEED",
    bindings: { FC_SEED: "", FC_RUNS: "200" },
    errorLine: focusedAuthorityMessages.FC_SEED.notPositiveDecimal,
  },
  {
    label: "whitespace-only FC_SEED",
    bindings: { FC_SEED: "   ", FC_RUNS: "200" },
    errorLine: focusedAuthorityMessages.FC_SEED.notPositiveDecimal,
  },
  {
    label: "whitespace-padded FC_SEED",
    bindings: { FC_SEED: " 200 ", FC_RUNS: "200" },
    errorLine: focusedAuthorityMessages.FC_SEED.notPositiveDecimal,
  },
  {
    label: "non-numeric FC_SEED",
    bindings: { FC_SEED: "abc", FC_RUNS: "200" },
    errorLine: focusedAuthorityMessages.FC_SEED.notPositiveDecimal,
  },
  {
    label: "negative FC_SEED",
    bindings: { FC_SEED: "-5", FC_RUNS: "200" },
    errorLine: focusedAuthorityMessages.FC_SEED.notPositiveDecimal,
  },
  {
    label: "zero FC_SEED",
    bindings: { FC_SEED: "0", FC_RUNS: "200" },
    errorLine: focusedAuthorityMessages.FC_SEED.notPositiveDecimal,
  },
  {
    label: "fractional FC_SEED",
    bindings: { FC_SEED: "1.5", FC_RUNS: "200" },
    errorLine: focusedAuthorityMessages.FC_SEED.notPositiveDecimal,
  },
  {
    label: "hexadecimal FC_SEED",
    bindings: { FC_SEED: "0x10", FC_RUNS: "200" },
    errorLine: focusedAuthorityMessages.FC_SEED.notPositiveDecimal,
  },
  {
    label: "exponential FC_SEED",
    bindings: { FC_SEED: "1e3", FC_RUNS: "200" },
    errorLine: focusedAuthorityMessages.FC_SEED.notPositiveDecimal,
  },
  {
    label: "leading-zero FC_SEED",
    bindings: { FC_SEED: "0200", FC_RUNS: "200" },
    errorLine: focusedAuthorityMessages.FC_SEED.notPositiveDecimal,
  },
  {
    label: "explicitly-signed FC_SEED",
    bindings: { FC_SEED: "+200", FC_RUNS: "200" },
    errorLine: focusedAuthorityMessages.FC_SEED.notPositiveDecimal,
  },
  {
    label: "beyond-safe-integer FC_SEED",
    bindings: { FC_SEED: "12345678901234567890123", FC_RUNS: "200" },
    errorLine: focusedAuthorityMessages.FC_SEED.notSafeInteger,
  },
  {
    label: "empty FC_RUNS beside a valid FC_SEED",
    bindings: { FC_SEED: "460046", FC_RUNS: "" },
    errorLine: focusedAuthorityMessages.FC_RUNS.notPositiveDecimal,
  },
];

const focusedClauseMutants: readonly {
  id: string;
  description: string;
  from: string;
  to: string;
  killedBy: string;
}[] = [
  {
    id: "M1",
    description: "digit class relaxed to admit empty, zero and leading zero",
    from: "/^[1-9][0-9]*$/u.test(raw)",
    to: "/^[0-9]*$/u.test(raw)",
    killedBy: "empty FC_SEED",
  },
  {
    id: "M2",
    description: "pattern unanchored",
    from: "/^[1-9][0-9]*$/u.test(raw)",
    to: "/[1-9][0-9]*/u.test(raw)",
    killedBy: "whitespace-padded FC_SEED",
  },
  {
    id: "M3",
    description: "absent clause deleted",
    from: "if(typeof raw!=='string')throw new Error(`focused ${name} authority is absent`);",
    to: "",
    killedBy: "absent FC_SEED",
  },
  {
    id: "M4",
    description: "safe-integer clause deleted",
    from: "if(!Number.isSafeInteger(value))throw new Error(`focused ${name} authority is not a safe integer`);",
    to: "",
    killedBy: "beyond-safe-integer FC_SEED",
  },
];

describe("focused qualification conclusion producer authority gate (46-42)", () => {
  const workflow = readFileSync(
    join(packageRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  let positiveControl: ProducerOutcome;

  beforeAll(() => {
    positiveControl = executeConclusionProducer(
      qualificationConclusionProducer(workflow),
      { FC_SEED: "460046", FC_RUNS: "200" },
    );
  }, 60_000);

  it("holds exactly one conclusion producer heredoc, located by step name rather than line number", () => {
    const body = qualificationConclusionProducer(workflow);
    expect(body).toContain("readAuthority('FC_SEED')");
    expect(body).toContain("readAuthority('FC_RUNS')");
    expect(body).toContain("qualification-linux.json");
    expect(body.split("\n")).toHaveLength(1);
  });

  it("accepts the real focused seed and run authority and records them unchanged (positive control)", () => {
    expect(positiveControl.status).toBe(0);
    expect(positiveControl.errorLine).toBeNull();
    expect(positiveControl.wroteConclusion).toBe(true);
    expect(positiveControl.conclusion).toMatchObject({
      version: 1,
      seed: 460046,
      propertyRuns: 200,
      tuple: `${process.platform}-${process.arch}`,
      nodeVersion: process.version,
    });
    expect(
      typeof (positiveControl.conclusion as { manifestSha256: unknown })
        .manifestSha256,
    ).toBe("string");
  }, 60_000);

  it.each(focusedRejections)(
    "rejects $label on its own anchored message and writes no conclusion",
    ({ bindings, errorLine }) => {
      expect(positiveControl.status).toBe(0);
      expect(positiveControl.conclusion).toMatchObject({
        seed: 460046,
        propertyRuns: 200,
      });
      const outcome = executeConclusionProducer(
        qualificationConclusionProducer(workflow),
        bindings,
      );
      expect(outcome.status).not.toBe(0);
      expect(outcome.errorLine).toBe(errorLine);
      expect(outcome.wroteConclusion).toBe(false);
      expect(outcome.conclusion).toBeNull();
    },
    60_000,
  );

  it("kills every clause mutant with the rejection case named for it", () => {
    expect(positiveControl.status).toBe(0);
    const body = qualificationConclusionProducer(workflow);
    const survivors: string[] = [];
    for (const mutant of focusedClauseMutants) {
      expect(body.split(mutant.from)).toHaveLength(2);
      const scenario = focusedRejections.find(
        (candidate) => candidate.label === mutant.killedBy,
      );
      if (scenario === undefined)
        throw new Error(`mutant ${mutant.id} names no known rejection case`);
      const outcome = executeConclusionProducer(
        body.replace(mutant.from, mutant.to),
        scenario.bindings,
      );
      const stillRejectsIdentically =
        outcome.status !== 0 &&
        outcome.wroteConclusion === false &&
        outcome.errorLine === scenario.errorLine;
      if (stillRejectsIdentically)
        survivors.push(`${mutant.id} (${mutant.description})`);
    }
    expect(survivors).toStrictEqual([]);
  }, 60_000);
});
