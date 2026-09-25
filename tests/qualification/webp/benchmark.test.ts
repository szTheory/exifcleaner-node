import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  evidenceGatedIt,
  evidenceGatedTestTitles,
  phase46EvidenceDirectory,
} from "../../support/phase46-evidence.js";

const require = createRequire(import.meta.url);
const projectRoot = dirname(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
);
const benchmark = require("../../../scripts/qualification/benchmark.cjs") as {
  BENCHMARK_THRESHOLDS: {
    medianRatio: number;
    medianSlackNs: number;
    p95Ratio: number;
    p95SlackNs: number;
    peakRssSlackKiB: number;
    slopeSlack: number;
    slopeRangeToleranceBytes: number;
  };
  buildSchedule(
    fixtureIds: readonly string[],
    warmups?: number,
    measurements?: number,
  ): readonly {
    fixtureId: string;
    round: number;
    warmup: boolean;
    version: string;
  }[];
  percentile(values: readonly number[], quantile: number): number;
  performanceP95(values: readonly number[]): number;
  rssSlope(
    aggregates: ReadonlyMap<string, { medianMaxRSSKiB: number }>,
    prefix: string,
  ): number;
  evaluatePair(input: {
    fixtureId?: string;
    baseline: Record<string, number | string>;
    candidate: Record<string, number | string>;
  }): { pass: boolean; failures: readonly string[] };
  INTENDED_OUTPUT_CHANGES: Readonly<
    Record<
      string,
      {
        requirement: string;
        baseline: Record<string, unknown>;
        candidate: Record<string, unknown>;
      }
    >
  >;
  evaluateCancellation(input: Record<string, unknown>): {
    pass: boolean;
    failures: readonly string[];
  };
  exitCodeForMode(
    mode: "report" | "admit",
    pass: boolean,
    failures?: readonly string[],
  ): number;
  generateFixture(record: Record<string, unknown>): Buffer;
  materializeFixture(
    record: Record<string, unknown>,
    destinationPath: string,
  ): { bytes: number; sha256: string };
  loadBenchmarkManifest(): {
    seed: number;
    fixtures: readonly (Record<string, unknown> & {
      targetBytes: number;
      sha256: string;
    })[];
  };
  renderSummary(report: Record<string, unknown>): string;
  parseArguments(args: readonly string[]): Record<string, unknown>;
  DIAGNOSTIC_PROFILE_ID: string;
  validateBaselinePackage(
    packageJson: { name?: unknown; version?: unknown },
    sha256: string,
  ): {
    baselinePackageName: string;
    baselineVersion: string;
    baselineExpectedIdentity: string;
    baselineSha256: string;
  };
  BASELINE_TARBALL_SHA256: string;
};
// Archived Phase 46 ledgers predate KIT-08 and record the pre-KIT-08 sample.webp
// output, so their replays name that epoch explicitly. Live evidence uses the
// validator's strict "current" default (Phase 55 D-16: archived evidence is never
// rewritten).
type CorpusEpoch = "current" | "phase-46";
const PHASE_46_CORPUS_EPOCH: CorpusEpoch = "phase-46";

type PrerequisiteEntry = {
  sha256: string;
  ledger: Record<string, unknown>;
};

const report =
  require("../../../scripts/qualification/benchmark-report.cjs") as {
    performanceP95(values: readonly number[]): number;
    evaluateTiming(input: {
      baselineMedianNs: number;
      candidateMedianNs: number;
      baselineP95Ns: number;
      candidateP95Ns: number;
    }): {
      pass: boolean;
      medianLimitNs: number;
      p95LimitNs: number;
      failures: string[];
    };
    deriveRunScale(input: {
      before: number[];
      after: number[];
      referenceMedianNs: number;
    }): {
      observedCalibrationNs: number;
      runScale: number;
    };
    validateCalibration(input: Record<string, unknown>): void;
    deriveCorrectnessKey(input: Record<string, unknown>): string;
    deriveFinalizationKey(input: Record<string, unknown>): string;
    deriveBlockEstimate(values: readonly number[]): {
      medianNs: number;
      madNs: number;
      madRatio: number;
      centralValues: readonly number[];
      centralRangeRatio: number;
    };
    loadReference(): {
      algorithmId: string;
      observationCount: number;
      workloadUnitCount: number;
      workloadDigest: string;
      workloadResultDigest: string;
      referenceMedianNs: Record<string, number>;
    };
    validateReport(input: Record<string, unknown>): void;
    validatePerformanceP95DiagnosticReport(
      input: Record<string, unknown>,
    ): void;
    derivePerformanceP95DiagnosticView(
      input: Record<string, unknown>,
    ): Record<string, unknown>;
    classifyPerformanceP95DiagnosticFixture(input: {
      observedP95Failure: boolean;
      positiveBlockCount: number;
      positiveCandidateTailCount: number;
    }): "concentrated-tail" | "sustained-candidate" | "mixed" | "unknown";
    actionableBranchForPerformanceP95Diagnostic(
      pattern:
        "concentrated-tail" | "sustained-candidate" | "mixed" | "unknown",
    ): "collector" | "candidate-runtime" | null;
    validatePerformanceP95DiagnosticLedger(
      input: Record<string, unknown>,
    ): void;
    validateInstalledReport(
      input: Record<string, unknown>,
      tuple: string,
      nodeMajor: number,
      candidate: Record<string, unknown>,
      corpusEpoch?: CorpusEpoch,
    ): void;
    hostedLedger(
      filePath: string,
      memoryPath: string,
      windowsPath: string,
      identityCleanupPath: string,
      corpusEpoch?: CorpusEpoch,
    ): void;
    validatePrerequisiteLedgerBindings(
      hosted: Record<string, unknown>,
      prerequisites: Record<string, PrerequisiteEntry>,
    ): void;
    validateFinalCandidateManifest(input: {
      repoRoot: string;
      candidateSha: string;
      repairProofSha: string;
    }): void;
    validateWindowsPublicationDiagnosticLedger(
      input: Record<string, unknown>,
    ): void;
    validateWindowsCancellationDiagnosticLedger(
      input: Record<string, unknown>,
    ): void;
    validateIdentityCleanupLedger(input: Record<string, unknown>): void;
    validateTerminalCleanupRecord(
      input: Record<string, unknown>,
      scenario?: string,
    ): void;
    requireWindowsNativePublicationEvidence(evidence: unknown): {
      primitive: string;
      publication: string;
      collision: string;
      identity: string;
      cleanup: string;
    };
    canonicalJson(value: unknown): string;
    validateP95NullBranchClosure(
      closure: Record<string, unknown>,
      ledger: Record<string, unknown>,
    ): Record<string, unknown>;
  };

type IdentityLedgerValidator = {
  validateIdentityCleanupLedger(input: Record<string, unknown>): void;
  validateInstalledReport(
    input: Record<string, unknown>,
    tuple: string,
    nodeMajor: number,
    candidate: Record<string, unknown>,
  ): void;
  validatePrerequisiteLedgerBindings(
    hosted: Record<string, unknown>,
    prerequisites: Record<string, PrerequisiteEntry>,
  ): void;
  validateTerminalCleanupRecord(
    input: Record<string, unknown>,
    scenario?: string,
  ): void;
  canonicalJson(value: unknown): string;
  requireWindowsNativePublicationEvidence(evidence: unknown): unknown;
  validateFinalCandidateManifest(input: {
    repoRoot: string;
    candidateSha: string;
    repairProofSha: string;
  }): unknown;
  hostedLedger(
    filePath: string,
    memoryPath: string,
    windowsPath: string,
    identityCleanupPath: string,
    corpusEpoch?: CorpusEpoch,
  ): unknown;
};

function loadIdentityLedgerValidator(source: string): IdentityLedgerValidator {
  const filename = join(
    projectRoot,
    "scripts",
    "qualification",
    "benchmark-report.cjs",
  );
  const localRequire = createRequire(filename);
  const freshModule: { exports: unknown } = { exports: {} };
  runInNewContext(source, {
    __dirname: dirname(filename),
    __filename: filename,
    console,
    // `Buffer` and `process` are NOT ambient inside `runInNewContext`, and
    // `validateFinalCandidateManifest` reads git blobs through `Buffer.from`.
    // Without them the mutant harness silently reported every manifest as
    // ABSENT -- a harness defect masquerading as a validator verdict.
    Buffer,
    process,
    module: freshModule,
    exports: freshModule.exports,
    require: localRequire,
  });
  return freshModule.exports as IdentityLedgerValidator;
}

const installedTuples = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "win32-arm64",
] as const;

const installedCandidate = {
  implementationSha: "1".repeat(40),
  tarballSha256: "3".repeat(64),
  corpusManifestSha256: "4".repeat(64),
  nativeManifestSha256: "9".repeat(64),
};

function terminalCleanupRecord(platform: "linux" | "darwin" | "win32") {
  const windows = platform === "win32";
  return {
    schemaVersion: "phase-46-terminal-cleanup/v2",
    abiVersion: "native-publication/v2",
    platform,
    ownership: {
      helperToken: "6".repeat(64),
      captureOwnershipToken: "6".repeat(64),
      terminalOwnershipToken: "6".repeat(64),
      captureCapabilityId: "7".repeat(64),
      terminalCapabilityId: "7".repeat(64),
    },
    capture: {
      result: windows ? "captured" : "unsupported",
      directoryIdentity: windows
        ? { volumeSerialNumber: "0".repeat(16), fileId: "d".repeat(32) }
        : null,
      fileIdentity: windows
        ? { volumeSerialNumber: "0".repeat(16), fileId: "e".repeat(32) }
        : null,
    },
    helper: {
      ownershipToken: "6".repeat(64),
      quiescenceSequence: 1,
      terminalSequence: 4,
    },
    terminal: {
      identityBefore: windows
        ? { volumeSerialNumber: "0".repeat(16), fileId: "e".repeat(32) }
        : null,
      removalIdentity: windows
        ? { volumeSerialNumber: "0".repeat(16), fileId: "f".repeat(32) }
        : null,
      outcome: windows ? "replacement-retained" : "unsupported-retained",
      consumeCount: 1,
      replayCount: 1,
      replayOutcome: "no-action",
    },
    replacement: {
      observationSequence: 2,
      injectionSequence: 3,
      identityBefore: windows
        ? { volumeSerialNumber: "0".repeat(16), fileId: "f".repeat(32) }
        : null,
      sha256Before: "8".repeat(64),
      identityAfter: windows
        ? { volumeSerialNumber: "0".repeat(16), fileId: "f".repeat(32) }
        : null,
      sha256After: "8".repeat(64),
    },
    nativeLifetime: {
      handlesBefore: 2,
      handlesAfter: 2,
      finalizersBefore: 0,
      finalizersAfter: windows ? 1 : 0,
    },
  };
}

function installedReport(
  tuple: (typeof installedTuples)[number],
  nodeMajor: 22 | 24,
) {
  const windows = tuple.startsWith("win32");
  const platform = tuple.split("-")[0] as "linux" | "darwin" | "win32";
  const base = {
    evidenceScope: "final-matching-host",
    hostTuple: tuple,
    nodeVersion: `v${nodeMajor}.0.0`,
    tarball: {
      file: "exifcleaner-node-0.1.1.tgz",
      sha256: installedCandidate.tarballSha256,
    },
    manifestSha256: installedCandidate.corpusManifestSha256,
    propertySeed: 460_046,
    propertyRuns: 25,
    propertyOutputDigest: "5".repeat(64),
    corpusCases: [
      {
        id: "exifcleaner-sample",
        magicAdmission: true,
        sourceSha256:
          "16d1cad79550c1e13f7710032f9bb41f5c36e49d0debe65761f7ee4c333360cd",
        outputSha256:
          "a8e1378cd74e08b2553bf313f676885cc7a6d590cfe79ca1b5f9d49215b5efa3",
        payloadDigests: [
          {
            fourCc: "VP8 ",
            occurrence: 0,
            sha256:
              "1300ec4f408f0960b09a5265851b14e81ac0c120fae6c3d555306df849235697",
          },
        ],
        removedNamespaces: ["EXIF"],
        finalization: windows
          ? "none"
          : "private-empty-stage-directory-remains",
      },
      {
        id: "derived-two-frame-animation",
        magicAdmission: true,
        sourceSha256:
          "eb201feb6be2ed982cb48ccd3ec36f11e799a0ae9b4f2873af4898844c601f80",
        outputSha256:
          "eb201feb6be2ed982cb48ccd3ec36f11e799a0ae9b4f2873af4898844c601f80",
        payloadDigests: [
          {
            fourCc: "ANIM",
            occurrence: 0,
            sha256:
              "ba3e4486d8c5bc4009da061168a88d776a1849bbc2596b474c9b05a9ff44a6c6",
          },
          {
            fourCc: "ANMF",
            occurrence: 0,
            sha256:
              "144759bea1ad5db4c4b1e20e4ffcbadd92ae4737d0559b28e5107871e3d89f96",
          },
          {
            fourCc: "ANMF",
            occurrence: 1,
            sha256:
              "a94c038e055c40ccc62f47ef3c6915fec89258e04d5fb7f5261920601dddef90",
          },
        ],
        removedNamespaces: [],
        finalization: windows
          ? "none"
          : "private-empty-stage-directory-remains",
      },
    ],
    install: {
      command: "npm install --ignore-scripts",
      arguments: [
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "<admitted-tarball>",
      ],
    },
    selectedArtifact: `prebuilds/${tuple}/publication.node`,
    cases: {
      sourcePreserved: true,
      published: true,
      collisionPreserved: true,
      cancellation: {
        code: "aborted",
        nativeWrite: "started",
        fallback: "do-not-fallback",
        finalization: "owned-partial-remains",
        residue: { stageDirectoryExists: true, stageFileExists: true },
        cleanup: terminalCleanupRecord(platform),
      },
      postCommitResidue: windows
        ? "none"
        : "private-empty-stage-directory-remains",
      collisionFinalization: windows
        ? "owned-partial-removed"
        : "owned-partial-remains",
    },
  };
  return windows
    ? {
        ...base,
        windowsPublication: {
          primitive: "CreateHardLinkW",
          linkCalls: 1,
          destinationParentIdentityRechecked: true,
          stageIdentityRechecked: true,
          stageFileIdentityRechecked: true,
          destinationParent: {
            volumeSerialNumber: "0".repeat(16),
            fileId: "a".repeat(32),
          },
          stageDirectory: {
            volumeSerialNumber: "0".repeat(16),
            fileId: "b".repeat(32),
          },
          stageFile: {
            volumeSerialNumber: "0".repeat(16),
            fileId: "c".repeat(32),
          },
          destinationFile: {
            volumeSerialNumber: "0".repeat(16),
            fileId: "c".repeat(32),
          },
        },
      }
    : base;
}

function identityCleanupLedger() {
  return {
    schemaVersion: "phase-46-identity-cleanup-ledger/v1",
    run: {
      id: 123,
      url: "https://github.com/szTheory/exifcleaner-node/actions/runs/123",
      ref: "proof/46-18-repair-abc123",
      headSha: installedCandidate.implementationSha,
    },
    candidate: installedCandidate,
    artifacts: Object.fromEntries(
      installedTuples.map((tuple) => [
        tuple,
        {
          binarySha256: "a".repeat(64),
          auditReportSha256: "b".repeat(64),
          implementationSha: installedCandidate.implementationSha,
        },
      ]),
    ),
    installed: Object.fromEntries(
      installedTuples.map((tuple) => [
        tuple,
        {
          node22: installedReport(tuple, 22),
          node24: installedReport(tuple, 24),
        },
      ]),
    ),
  };
}

function cancellationObservation(reason = "native-write") {
  return {
    reason,
    resultOk: false,
    errorCode: "aborted",
    nativeWrite: reason === "native-write" ? "not-started" : "started",
    fallback: "do-not-fallback",
    finalizationState: "owned-partial-removed",
    beforePublishHookSeen: true,
    cancellationStageCaptured: true,
    cleanupRecordPresent: true,
    cleanupValidation: "accepted",
    residue: { directory: false, file: false },
    keyCounts: {
      result: 2,
      error: 3,
      finalization: 1,
      cancellationStage: 4,
      cleanupRecord: 8,
      residue: 2,
    },
  };
}

function cancellationDiagnosticLedger() {
  const headSha = "d".repeat(40);
  const record = (tuple: "win32-x64" | "win32-arm64") => ({
    tuple,
    nodeMajor: 22,
    job: { name: `installed-${tuple}`, conclusion: "failure" },
    artifact: {
      name: `windows-cancellation-installed-node22-${tuple}`,
      sha256: tuple === "win32-x64" ? "a".repeat(64) : "b".repeat(64),
    },
    diagnostic: {
      schemaVersion: "phase-46-windows-cancellation-diagnostic/v1",
      diagnosticOnly: true,
      tuple,
      nodeMajor: 22,
      observation: cancellationObservation(),
    },
  });
  return {
    schemaVersion: "phase-46-windows-cancellation-diagnostic-ledger/v1",
    diagnosticOnly: true,
    run: {
      repository: "szTheory/exifcleaner-node",
      workflow: ".github/workflows/ci.yml",
      event: "workflow_dispatch",
      attempt: 1,
      id: 123457,
      url: "https://github.com/szTheory/exifcleaner-node/actions/runs/123457",
      ref: `refs/heads/proof/46-27-cancellation-diagnostic-${headSha.slice(0, 7)}`,
      headSha,
    },
    records: {
      "win32-x64": record("win32-x64"),
      "win32-arm64": record("win32-arm64"),
    },
  };
}

function acceptedWindowsPublicationObservation() {
  const identity = {
    keysOk: true,
    volumeLength: 16,
    volumeLowerHex: true,
    fileIdLength: 32,
    fileIdLowerHex: true,
  };
  return {
    status: "accepted",
    reason: "accepted",
    topLevelType: "object",
    topLevelKeys: {
      primitive: true,
      linkCalls: true,
      destinationParentIdentityRechecked: true,
      stageIdentityRechecked: true,
      stageFileIdentityRechecked: true,
      destinationParent: true,
      stageDirectory: true,
      stageFile: true,
      destinationFile: true,
    },
    unexpectedTopLevelKeyCount: 0,
    primitiveIsCreateHardLinkW: true,
    linkCallsIsOne: true,
    destinationParentIdentityRecheckedIsTrue: true,
    stageIdentityRecheckedIsTrue: true,
    stageFileIdentityRecheckedIsTrue: true,
    identities: {
      destinationParent: identity,
      stageDirectory: identity,
      stageFile: identity,
      destinationFile: identity,
    },
    equalities: {
      destinationParentVolumeEqualsStageDirectoryVolume: true,
      stageDirectoryVolumeEqualsStageFileVolume: true,
      stageFileVolumeEqualsDestinationFileVolume: true,
      stageFileIdEqualsDestinationFileId: true,
    },
  };
}

function diagnosticLedger() {
  const record = (tuple: "win32-x64" | "win32-arm64", boundary: string) => ({
    tuple,
    boundary,
    nodeMajor: 22,
    job: {
      name:
        boundary === "matching-host"
          ? `build-audit-${tuple}`
          : `installed-${tuple}`,
      conclusion: "failure",
    },
    artifact: {
      name: `windows-publication-${boundary}-${tuple}`,
      sha256: tuple === "win32-x64" ? "a".repeat(64) : "b".repeat(64),
    },
    observation: {
      ...acceptedWindowsPublicationObservation(),
      status: "rejected",
      reason: "stage-file-id-format",
      identities: {
        ...acceptedWindowsPublicationObservation().identities,
        stageFile: {
          ...acceptedWindowsPublicationObservation().identities.stageFile,
          fileIdLength: 17,
        },
      },
    },
  });
  return {
    schemaVersion: "phase-46-windows-publication-diagnostic-ledger/v1",
    diagnosticOnly: true,
    run: {
      repository: "szTheory/exifcleaner-node",
      workflow: ".github/workflows/ci.yml",
      event: "workflow_dispatch",
      attempt: 1,
      id: 123456,
      url: "https://github.com/szTheory/exifcleaner-node/actions/runs/123456",
      ref: "refs/heads/proof/46-25-windows-diagnostic-ccccccc",
      headSha: "c".repeat(40),
    },
    outcome: "rejection-observed",
    selectedBoundary: "matching-host",
    matchingHost: {
      "win32-x64": record("win32-x64", "matching-host"),
      "win32-arm64": record("win32-arm64", "matching-host"),
    },
    installedNode22: null,
    laterFailures: null,
  };
}

const exactDiagnosticHashes = {
  matchingHost: {
    "win32-x64":
      "d3a83a61db1443f96ad2518bcb0336e71c5855e4ba93b2f77495aa0baf4a2c14",
    "win32-arm64":
      "e757e4aba6b643a3ca75b8fba77a5778792d83fef39cbae7f18ae4e3eec93726",
  },
  installedNode22: {
    "win32-x64":
      "2e13fc5dfbd0baccc69c6305ccc9ef7b5e431d53afb560f081b213a1c999e070",
    "win32-arm64":
      "0111e778fe6b6c89d9afd7b9909ba5059f2d1ac1c87e6ab85f5263421224a88a",
  },
} as const;

function hypothesisRefutedLedger() {
  const record = (
    tuple: "win32-x64" | "win32-arm64",
    boundary: "matching-host" | "installed-node22",
  ) => ({
    tuple,
    boundary,
    nodeMajor: 22,
    job: {
      name:
        boundary === "matching-host"
          ? `build-audit-${tuple}`
          : `installed-${tuple}`,
      conclusion: boundary === "matching-host" ? "success" : "failure",
    },
    artifact: {
      name: `windows-publication-${boundary}-${tuple}`,
      sha256:
        boundary === "matching-host"
          ? exactDiagnosticHashes.matchingHost[tuple]
          : exactDiagnosticHashes.installedNode22[tuple],
    },
    observation: acceptedWindowsPublicationObservation(),
  });
  return {
    schemaVersion: "phase-46-windows-publication-diagnostic-ledger/v1",
    diagnosticOnly: true,
    run: {
      repository: "szTheory/exifcleaner-node",
      workflow: ".github/workflows/ci.yml",
      event: "workflow_dispatch",
      attempt: 1,
      id: 33200060244,
      url: "https://github.com/szTheory/exifcleaner-node/actions/runs/33200060244",
      ref: "refs/heads/proof/46-25-windows-diagnostic-ba1f4c6",
      headSha: "ba1f4c67403daf82c7de996bb210bc0efae8b63e",
    },
    outcome: "hypothesis-refuted",
    selectedBoundary: null,
    matchingHost: {
      "win32-x64": record("win32-x64", "matching-host"),
      "win32-arm64": record("win32-arm64", "matching-host"),
    },
    installedNode22: {
      "win32-x64": record("win32-x64", "installed-node22"),
      "win32-arm64": record("win32-arm64", "installed-node22"),
    },
    laterFailures: {
      "win32-x64": "deterministic-cancellation",
      "win32-arm64": "deterministic-cancellation",
    },
  };
}
const calibration =
  require("../../../scripts/qualification/benchmark-calibration.cjs") as {
    workloadDigest(): string;
    workloadResultDigest(): string;
  };

type BenchmarkReportOptions = {
  nodeMajor?: number;
  candidateSha256?: string;
  platform?: string;
  architecture?: string;
  maxRSSKiB?: (fixtureId: string, version: string) => number;
};

/** The complete schema-v4 hundred-observation benchmark report, extracted
 * verbatim from the manifest-evidence test so the hosted-ledger positive
 * control is built from the same construction `validateReport` already
 * accepts.  Defaults reproduce the original inline values exactly. */
function completeBenchmarkReport(options: BenchmarkReportOptions = {}) {
  const nodeMajor =
    options.nodeMajor ?? Number(process.versions.node.split(".")[0]);
  const candidateTarballSha256 = options.candidateSha256 ?? "3".repeat(64);
  const reportPlatform = options.platform ?? process.platform;
  const reportArchitecture = options.architecture ?? process.arch;
  const maxRSSKiB = options.maxRSSKiB ?? ((): number => 1);
  const manifest = benchmark.loadBenchmarkManifest();
  const reference = report.loadReference();
  const normalizedNs = reference.referenceMedianNs[String(nodeMajor)];
  if (typeof normalizedNs !== "number")
    throw new Error("current Node major lacks a calibration reference");
  const observations = Array.from(
    { length: reference.observationCount },
    (_, index) => ({
      ordinal: index + 1,
      elapsedNs: normalizedNs * reference.workloadUnitCount,
      unitCount: reference.workloadUnitCount,
      normalizedNs,
      resultDigest: calibration.workloadResultDigest(),
    }),
  );
  const calibrationEvidence = {
    schemaVersion: 2,
    algorithmId: reference.algorithmId,
    nodeMajor,
    observations,
    workloadDigest: calibration.workloadDigest(),
    process: { execPath: process.execPath, clean: true },
  };
  const sample = {
    schemaVersion: 2,
    version: "baseline",
    fixtureId: "",
    packageSha: benchmark.BASELINE_TARBALL_SHA256,
    runToken: "0".repeat(32),
    elapsedNs: 1,
    maxRSSKiB: 1,
    startedRss: 1,
    endedRss: 1,
    outputBytes: 1,
    outputSha256: "1".repeat(64),
    status: "success",
    code: null,
    sourceUnchanged: true,
    destinationAbsent: false,
    finalization: "none",
    finalizationTruthful: true,
    correctnessKey: "",
    finalizationKey: "",
    allocationPhases: [
      "package-load",
      "fixture-materialized",
      "sanitize-complete",
      "correctness-complete",
    ].map((phase) => ({
      phase,
      rss: 1,
      heapUsed: 1,
      external: 1,
      arrayBuffers: 1,
      maxRSSKiB: 1,
    })),
    environment: {
      nodeVersion: `v${nodeMajor}.0.0`,
      platform: reportPlatform,
      architecture: reportArchitecture,
      runner: "test",
      cpu: "test",
    },
  };
  const cancellationSample = {
    code: "aborted",
    destinationAbsent: true,
    finalizationTruthful: true,
    secondWriter: false,
    finalizationStartMs: 0,
    terminalMs: 0,
    finalization: "owned-partial-remains",
  };
  const rawSchedule = benchmark
    .buildSchedule(
      manifest.fixtures.map((fixture) => String(fixture.id)),
      2,
      100,
    )
    .map((entry, index) => ({
      ...entry,
      sample: {
        ...sample,
        version: entry.version,
        fixtureId: entry.fixtureId,
        packageSha:
          entry.version === "baseline"
            ? benchmark.BASELINE_TARBALL_SHA256
            : candidateTarballSha256,
        runToken: index.toString(16).padStart(32, "0"),
        maxRSSKiB: maxRSSKiB(entry.fixtureId, entry.version),
        ...(manifest.fixtures.find((fixture) => fixture.id === entry.fixtureId)
          ?.expected !== "success"
          ? {
              status: manifest.fixtures.find(
                (fixture) => fixture.id === entry.fixtureId,
              )?.expected,
              code:
                manifest.fixtures.find(
                  (fixture) => fixture.id === entry.fixtureId,
                )?.expected === "aborted"
                  ? "aborted"
                  : "refused",
              outputBytes: 0,
              outputSha256: null,
              destinationAbsent: true,
            }
          : {}),
        ...(entry.fixtureId === "cancellation-64m"
          ? { cancellation: cancellationSample }
          : {}),
      },
    }));
  for (const entry of rawSchedule) {
    const fixture = manifest.fixtures.find(
      (item) => item.id === entry.fixtureId,
    )!;
    const finalization =
      fixture.kind === "cancellation"
        ? entry.version === "candidate"
          ? "owned-partial-remains"
          : "not-started"
        : fixture.expected === "success"
          ? entry.version === "candidate"
            ? "private-empty-stage-directory-remains"
            : "none"
          : "not-started";
    entry.sample.finalization = finalization;
    if (entry.sample.cancellation)
      entry.sample.cancellation = {
        ...cancellationSample,
        finalization,
      };
  }
  for (const entry of rawSchedule) {
    entry.sample.correctnessKey = report.deriveCorrectnessKey(entry.sample);
    entry.sample.finalizationKey = report.deriveFinalizationKey(entry.sample);
  }
  const retainedSamples = (fixtureId: string, version: string) =>
    rawSchedule
      .filter(
        (entry) =>
          entry.fixtureId === fixtureId &&
          entry.version === version &&
          !entry.warmup,
      )
      .map((entry) => ({
        ...entry.sample,
        scaledElapsedNs: entry.sample.elapsedNs,
      }));
  const timing = report.evaluateTiming({
    baselineMedianNs: 1,
    candidateMedianNs: 1,
    baselineP95Ns: 1,
    candidateP95Ns: 1,
  });
  const comparisons = manifest.fixtures
    .filter((fixture) => fixture.kind !== "cancellation")
    .map((fixture) => ({
      fixtureId: fixture.id,
      baseline: {
        samples: retainedSamples(String(fixture.id), "baseline"),
        correctnessKey: retainedSamples(String(fixture.id), "baseline")[0]!
          .correctnessKey,
        finalizationKey: retainedSamples(String(fixture.id), "baseline")[0]!
          .finalizationKey,
        medianElapsedNs: 1,
        p95ElapsedNs: 1,
        medianMaxRSSKiB: 1,
        rssSlope: 0,
      },
      candidate: {
        samples: retainedSamples(String(fixture.id), "candidate"),
        correctnessKey: retainedSamples(String(fixture.id), "candidate")[0]!
          .correctnessKey,
        finalizationKey: retainedSamples(String(fixture.id), "candidate")[0]!
          .finalizationKey,
        medianElapsedNs: 1,
        p95ElapsedNs: 1,
        medianMaxRSSKiB: 1,
        rssSlope: 0,
      },
      timing,
      verdict: benchmark.evaluatePair({
        baseline: {
          correctnessKey:
            retainedSamples(String(fixture.id), "baseline")[0]
              ?.correctnessKey ?? "",
          medianElapsedNs: 1,
          p95ElapsedNs: 1,
          medianMaxRSSKiB: 1,
          rssSlope: 0,
        },
        candidate: {
          correctnessKey:
            retainedSamples(String(fixture.id), "candidate")[0]
              ?.correctnessKey ?? "",
          medianElapsedNs: 1,
          p95ElapsedNs: 1,
          medianMaxRSSKiB: 1,
          rssSlope: 0,
        },
      }),
    }));
  // The animation RSS tampers in the hosted-ledger coverage move real sample
  // values, so every derived aggregate and verdict is recomputed from the
  // samples rather than pinned at the default of one.
  for (const comparison of comparisons) {
    for (const side of ["baseline", "candidate"] as const)
      comparison[side].medianMaxRSSKiB = benchmark.percentile(
        comparison[side].samples.map((item) => item.maxRSSKiB),
        0.5,
      );
    comparison.verdict = benchmark.evaluatePair({
      baseline: {
        correctnessKey: comparison.baseline.correctnessKey,
        medianElapsedNs: 1,
        p95ElapsedNs: 1,
        medianMaxRSSKiB: comparison.baseline.medianMaxRSSKiB,
        rssSlope: 0,
      },
      candidate: {
        correctnessKey: comparison.candidate.correctnessKey,
        medianElapsedNs: 1,
        p95ElapsedNs: 1,
        medianMaxRSSKiB: comparison.candidate.medianMaxRSSKiB,
        rssSlope: 0,
      },
    });
  }
  const failures = comparisons.flatMap((comparison) =>
    comparison.verdict.failures.map(
      (failure) => `${comparison.fixtureId}: ${failure}`,
    ),
  );
  const complete = {
    version: 4,
    elapsedP95Estimator: {
      method: "Hyndman-Fan Type 7",
      quantile: 0.95,
      interpolation: "linear",
      retainedObservations: 100,
    },
    mode: "admit",
    pass: failures.length === 0,
    baselinePackageName: "exifcleaner-node",
    baselineVersion: "0.1.1",
    baselineExpectedIdentity: `exifcleaner-node@0.1.1#sha256:${benchmark.BASELINE_TARBALL_SHA256}`,
    calibration: {
      before: calibrationEvidence,
      after: calibrationEvidence,
      reference,
      derived: report.deriveRunScale({
        before: observations.map((item) => item.normalizedNs),
        after: observations.map((item) => item.normalizedNs),
        referenceMedianNs: normalizedNs,
      }),
    },
    baselineSha256: benchmark.BASELINE_TARBALL_SHA256,
    candidateSha256: candidateTarballSha256,
    environment: {
      nodeVersion: `v${nodeMajor}.0.0`,
      platform: reportPlatform,
      architecture: reportArchitecture,
      runner: "test",
      cpu: "test",
    },
    comparisons,
    rawSchedule,
    collection: { retries: 0, discarded: 0 },
    cancellation: {
      sample: cancellationSample,
      verdict: { pass: true, failures: [] },
    },
    failures,
    warmups: 2,
    measurements: 100,
    thresholds: benchmark.BENCHMARK_THRESHOLDS,
  };
  return complete;
}

// ---------------------------------------------------------------------------
// ACCEPTING HOSTED LEDGER (Plan 46-39, D-39 clause (e)).
//
// `hostedLedger` had no positive control at all: its only test spawned the CLI
// over four `{}` stub files and asserted it died on the FIRST clause, so all
// twenty-five of its mutations survived.  Twenty-five rejections are exactly
// what a reject-everything function produces, so the accepting fixture below is
// the enabling step and every negative control in this file depends on it.
//
// The fixture is built from REAL committed artifacts, not invented:
//   * `46-IDENTITY-CLEANUP-EVIDENCE.json` is run 35030048631's real ledger and
//     supplies the run identity, the four-field candidate, and the twelve real
//     installed tuple reports.
//   * `46-NODE22-MEMORY-EVIDENCE.json` supplies `finalizationContracts`.
//   * `46-HOSTED-EVIDENCE.json` is the STRUCTURAL TEMPLATE only: its field
//     vocabulary and its `artifactSha256`, `benchmarks` and `focused` shapes.
//     It is the SUPERSEDED fifteen-measurement v1 ledger and does NOT
//     re-validate against the current hundred-measurement contract.  That is
//     EXPECTED because it predates the schema and is NOT a defect; Plan 46-11
//     replaces it.  Nothing here fixes, regenerates, re-seals or deletes it.
//   * The three `repairs` bindings are the real sha256 digests of the three
//     copied ledger FILES, so the tampers below can substitute file bytes.
//
// ONLY `ref` is synthesized: `hostedLedger` requires the final-proof namespace
// `^proof/46-11-final-[0-9a-f]+$`, which a repair-namespace identity ledger
// cannot carry, so it is derived from the short head sha.
// ---------------------------------------------------------------------------
const evidenceDirectory = phase46EvidenceDirectory;
const PREREQUISITE_LEDGER_FILES = {
  memory: "46-NODE22-MEMORY-EVIDENCE.json",
  windows: "46-WINDOWS-PUBLICATION-EVIDENCE.json",
  identityCleanup: "46-IDENTITY-CLEANUP-EVIDENCE.json",
} as const;

type JsonRecord = Record<string, any>;

const benchmarkReportCache = new Map<string, JsonRecord>();
function cachedBenchmarkReport(options: BenchmarkReportOptions): JsonRecord {
  const key = JSON.stringify([
    options.nodeMajor,
    options.candidateSha256,
    options.platform,
    options.architecture,
    (options as { rssKey?: string }).rssKey ?? "default",
  ]);
  const cached = benchmarkReportCache.get(key);
  if (cached) return structuredClone(cached);
  const built = completeBenchmarkReport(options) as JsonRecord;
  benchmarkReportCache.set(key, built);
  return structuredClone(built);
}

type HostedFixtureOptions = {
  animationBaselineMaxRSSKiB?: number;
  animationCandidateMaxRSSKiB?: number;
};

type HostedFixture = {
  directory: string;
  hostedPath: string;
  memoryPath: string;
  windowsPath: string;
  identityPath: string;
  hosted: JsonRecord;
  memory: JsonRecord;
  identity: JsonRecord;
  writeHosted(value: unknown): void;
  substitutePrerequisite(slot: keyof typeof PREREQUISITE_LEDGER_FILES): void;
  restorePrerequisite(slot: keyof typeof PREREQUISITE_LEDGER_FILES): void;
  validate(): unknown;
  cleanup(): void;
};

function acceptingHostedLedger(
  options: HostedFixtureOptions = {},
): HostedFixture {
  const directory = mkdtempSync(join(tmpdir(), "phase-46-hosted-accepting-"));
  const paths: Record<string, string> = {};
  for (const [slot, file] of Object.entries(PREREQUISITE_LEDGER_FILES)) {
    const target = join(directory, file);
    copyFileSync(join(evidenceDirectory, file), target);
    paths[slot] = target;
  }
  const readLedger = (file: string): JsonRecord =>
    JSON.parse(readFileSync(file, "utf8")) as JsonRecord;
  const memory = readLedger(paths.memory!);
  const windows = readLedger(paths.windows!);
  const identity = readLedger(paths.identityCleanup!);
  const template = readLedger(
    join(evidenceDirectory, "46-HOSTED-EVIDENCE.json"),
  );
  const digestOf = (file: string): string =>
    createHash("sha256").update(readFileSync(file)).digest("hex");
  const candidate = {
    sha: identity.run.headSha,
    tarballSha256: identity.candidate.tarballSha256,
    corpusManifestSha256: identity.candidate.corpusManifestSha256,
    nativeManifestSha256: identity.candidate.nativeManifestSha256,
  };
  const animationRss = {
    baseline: options.animationBaselineMaxRSSKiB ?? 1,
    candidate: options.animationCandidateMaxRSSKiB ?? 1,
  };
  const rssKey = `${animationRss.baseline}:${animationRss.candidate}`;
  const nodeReport = (nodeMajor: 22 | 24): JsonRecord =>
    cachedBenchmarkReport({
      nodeMajor,
      candidateSha256: candidate.tarballSha256,
      platform: "linux",
      architecture: "x64",
      maxRSSKiB: (fixtureId, version) =>
        fixtureId === "animation-alpha-16m"
          ? animationRss[version as "baseline" | "candidate"]
          : 1,
      rssKey,
    } as BenchmarkReportOptions);
  const windowsSummary = {
    primitive: "create-hard-link",
    publication: "pass",
    collision: "pass",
    identity: "pass",
    cleanup: "pass",
  };
  const hosted: JsonRecord = {
    schemaVersion: 2,
    repository: "szTheory/exifcleaner-node",
    workflow: "CI",
    workflowPath: ".github/workflows/ci.yml",
    runId: identity.run.id,
    runUrl: identity.run.url,
    event: "workflow_dispatch",
    // SYNTHESIZED FIELD, and the only one: `hostedLedger` requires the
    // final-proof namespace, which run 35030048631's repair-namespace ledger
    // cannot carry, so it is derived from that run's real short head sha.
    ref: `proof/46-11-final-${String(identity.run.headSha).slice(0, 7)}`,
    headSha: identity.run.headSha,
    conclusion: "success",
    artifactSha256: structuredClone(template.artifactSha256),
    candidate,
    baseline: {
      packageIdentity: "exifcleaner-node@0.1.1",
      tag: "v0.1.1",
      tarballSha256: benchmark.BASELINE_TARBALL_SHA256,
    },
    repairs: {
      memory: {
        sha256: digestOf(paths.memory!),
        runId: memory.runId,
        headSha: memory.headSha,
      },
      windows: {
        sha256: digestOf(paths.windows!),
        runId: windows.runId,
        headSha: windows.headSha,
      },
      identityCleanup: {
        sha256: digestOf(paths.identityCleanup!),
        runId: identity.run.id,
        headSha: identity.run.headSha,
      },
    },
    focused: {
      ...structuredClone(template.focused),
      tuple: "linux-x64",
      nodeMajor: 24,
      seed: 460_046,
      propertyRuns: 200,
      manifestSha256: candidate.corpusManifestSha256,
    },
    tuples: Object.fromEntries(
      installedTuples.map((tuple) => [
        tuple,
        {
          jobName: `installed-${tuple}`,
          conclusion: "success",
          runId: identity.run.id,
          headSha: identity.run.headSha,
          candidateSha: identity.run.headSha,
          candidateTarballSha256: candidate.tarballSha256,
          corpusManifestSha256: candidate.corpusManifestSha256,
          nativeManifestSha256: candidate.nativeManifestSha256,
          artifact: {
            name: `installed-${tuple}`,
            runId: identity.run.id,
            sha256: template.artifactSha256[`installed-${tuple}`],
          },
          nodeMajors: [22, 24],
          reports: {
            node22: structuredClone(identity.installed[tuple].node22),
            node24: structuredClone(identity.installed[tuple].node24),
          },
          ...(tuple.startsWith("win32") ? windowsSummary : {}),
        },
      ]),
    ),
    installedConclusions: 12,
    benchmarks: structuredClone(template.benchmarks),
    finalizationContracts: structuredClone(memory.finalizationContracts),
    node22: nodeReport(22),
    node24: nodeReport(24),
  };
  const hostedPath = join(directory, "hosted.json");
  const fixture: HostedFixture = {
    directory,
    hostedPath,
    memoryPath: paths.memory!,
    windowsPath: paths.windows!,
    identityPath: paths.identityCleanup!,
    hosted,
    memory,
    identity,
    writeHosted(value: unknown): void {
      writeFileSync(hostedPath, JSON.stringify(value));
    },
    substitutePrerequisite(slot): void {
      // A SUBSTITUTED FILE: the bytes change, the hosted ledger's recorded
      // digest does not.  Trailing whitespace keeps the JSON parseable so the
      // rejection is the digest binding rather than a parse failure.
      writeFileSync(paths[slot]!, `${readFileSync(paths[slot]!, "utf8")} `);
    },
    restorePrerequisite(slot): void {
      copyFileSync(
        join(evidenceDirectory, PREREQUISITE_LEDGER_FILES[slot]),
        paths[slot]!,
      );
    },
    validate(): unknown {
      return report.hostedLedger(
        hostedPath,
        paths.memory!,
        paths.windows!,
        paths.identityCleanup!,
        PHASE_46_CORPUS_EPOCH,
      );
    },
    cleanup(): void {
      rmSync(directory, { recursive: true, force: true });
    },
  };
  fixture.writeHosted(hosted);
  return fixture;
}

/** Anchors an expected validator message exactly, so a matcher cannot pass on
 * a different message that merely contains the same fragment.  The message
 * text is held as a plain string so it appears verbatim in this file. */
function anchoredMessage(message: string): RegExp {
  return new RegExp(
    `^${message.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
    "u",
  );
}

/** The refs CI and releases actually supply, plus a repair-namespace ref and a
 * full ref.  D-39 (a) relocated the proof-branch constraint OUT of
 * `validateIdentityCleanupLedger`; `hostedLedger` is its one remaining home,
 * so all four are rejected there. */
const RELOCATED_HOSTED_REF_REJECTIONS = [
  "main",
  "v4.1.0",
  "proof/46-18-repair-dd1b6a1",
  "refs/heads/proof/46-11-final-dd1b6a1",
] as const;

/** `runId`, `headSha` and the candidate tarball digest are each read by several
 * clauses, so a tamper aimed at ONE clause must stay consistent everywhere
 * else; otherwise a later clause rejects first and the control proves nothing
 * about the clause it names. */
function setHostedRunId(hosted: JsonRecord, runId: number): void {
  hosted.runId = runId;
  for (const tuple of Object.values(hosted.tuples as JsonRecord)) {
    (tuple as JsonRecord).runId = runId;
    ((tuple as JsonRecord).artifact as JsonRecord).runId = runId;
  }
}

function setHostedHeadSha(hosted: JsonRecord, headSha: string): void {
  hosted.headSha = headSha;
  (hosted.candidate as JsonRecord).sha = headSha;
  for (const tuple of Object.values(hosted.tuples as JsonRecord)) {
    (tuple as JsonRecord).headSha = headSha;
    (tuple as JsonRecord).candidateSha = headSha;
  }
}

function setCandidateTarball(hosted: JsonRecord, digest: string): void {
  (hosted.candidate as JsonRecord).tarballSha256 = digest;
  for (const tuple of Object.values(hosted.tuples as JsonRecord)) {
    (tuple as JsonRecord).candidateTarballSha256 = digest;
    for (const key of ["node22", "node24"])
      (
        ((tuple as JsonRecord).reports as JsonRecord)[key] as JsonRecord
      ).tarball.sha256 = digest;
  }
}

/** A benchmark report whose environment is carried consistently by every child
 * sample, so `validateReport` accepts it and the hosted platform/architecture
 * binding is the only clause that can reject. */
function foreignEnvironmentReport(
  hosted: JsonRecord,
  environment: { platform?: string; architecture?: string },
): JsonRecord {
  return cachedBenchmarkReport({
    nodeMajor: 22,
    candidateSha256: (hosted.candidate as JsonRecord).tarballSha256 as string,
    platform: environment.platform ?? "linux",
    architecture: environment.architecture ?? "x64",
  });
}

const TUPLE_BINDING_TAMPERS: ((hosted: JsonRecord) => void)[] = [
  (hosted) => (hosted.tuples["linux-x64"].jobName = "installed-linux-arm64"),
  (hosted) => (hosted.tuples["linux-x64"].conclusion = "failure"),
  (hosted) => (hosted.tuples["linux-x64"].runId = 1),
  (hosted) => (hosted.tuples["linux-x64"].headSha = "b".repeat(40)),
  (hosted) => (hosted.tuples["linux-x64"].candidateSha = "b".repeat(40)),
  (hosted) =>
    (hosted.tuples["linux-x64"].candidateTarballSha256 = "7".repeat(64)),
  (hosted) =>
    (hosted.tuples["linux-x64"].corpusManifestSha256 = "7".repeat(64)),
  (hosted) =>
    (hosted.tuples["linux-x64"].nativeManifestSha256 = "7".repeat(64)),
  (hosted) =>
    (hosted.tuples["linux-x64"].artifact.name = "installed-linux-arm64"),
  (hosted) => (hosted.tuples["linux-x64"].artifact.runId = 1),
  (hosted) => (hosted.tuples["linux-x64"].artifact.sha256 = "7".repeat(64)),
  (hosted) => (hosted.tuples["linux-x64"].nodeMajors = [22]),
];

// ---------------------------------------------------------------------------
// SYNTHETIC FINAL-CANDIDATE REPOSITORY (Plan 46-39, D-39 clause (e)).
//
// `validateFinalCandidateManifest` was tested only on its ABSENT path, behind a
// matcher five different messages satisfy, so eight mutations survived.  A real
// repository under `mkdtemp` is sufficient because the validator shells out
// through `git -C repoRoot`, so the positive control below is built the way the
// gate is actually driven rather than stubbed.
// ---------------------------------------------------------------------------
const FINAL_CANDIDATE_MANIFEST_PATH = "native/phase-46-final-candidate.json";
const FINAL_AUTHORITY_PATHS: readonly (readonly [string, string])[] = [
  ["nativeSource", "native/publication.c"],
  ["nativeAuditManifest", "scripts/audit_native_source.cjs"],
  ["nativeAuditAuthority", "scripts/audit_native_artifact.cjs"],
  [
    "calibrationReference",
    "scripts/qualification/benchmark-calibration-reference.json",
  ],
  ["calibrationAlgorithm", "scripts/qualification/benchmark-calibration.cjs"],
] as const;
const FINAL_TREE_MEMBER_FILES = [
  "src/index.ts",
  "src/webp/riff.ts",
  "dist/index.js",
] as const;

type ManifestRepositoryOptions = {
  /** Applied to the manifest object BEFORE serialization, so the committed
   * bytes stay canonical and the tamper reaches the clause it names. */
  manifestOverride?: (manifest: JsonRecord) => void;
  /** Replaces the canonical serialization, for the canonical-bytes tamper. */
  serialize?: (manifest: JsonRecord) => string;
  /** Extra paths committed alongside the manifest in the candidate commit. */
  extraCandidateFiles?: Record<string, string>;
  /** Commits the extra files INSTEAD of the manifest. */
  omitManifest?: boolean;
  /** Inserts a commit between the repair proof and the candidate. */
  insertIntermediateCommit?: boolean;
  /** Commits no `src/` or `dist/` files at all, so the repository-derived
   * member list is empty. */
  omitTreeFiles?: boolean;
};

type ManifestRepository = {
  root: string;
  candidateSha: string;
  repairProofSha: string;
  manifest: JsonRecord;
  cleanup(): void;
};

function finalCandidateRepository(
  options: ManifestRepositoryOptions = {},
): ManifestRepository {
  const root = mkdtempSync(join(tmpdir(), "phase-46-final-candidate-"));
  const run = (...args: string[]): string =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  const write = (relative: string, contents: string): void => {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(join(root, relative), contents);
  };
  // A deterministic local identity and a fixed default branch, so nothing
  // depends on the developer's global git configuration.
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  run("config", "user.email", "phase-46@example.invalid");
  run("config", "user.name", "Phase 46");
  run("config", "commit.gpgsign", "false");
  run("config", "core.autocrlf", "false");
  for (const [key, authorityPath] of FINAL_AUTHORITY_PATHS)
    write(authorityPath, `// ${key} authority fixture\n`);
  if (!options.omitTreeFiles)
    for (const member of FINAL_TREE_MEMBER_FILES)
      write(member, `// ${member} fixture\n`);
  run("add", "-A");
  run("commit", "-q", "-m", "repair proof");
  const repairProofSha = run("rev-parse", "HEAD").trim();
  const blobDigest = (relative: string): string =>
    createHash("sha256")
      .update(
        execFileSync(
          "git",
          ["-C", root, "show", `${repairProofSha}:${relative}`],
          {
            encoding: "buffer",
          },
        ),
      )
      .digest("hex");
  const members = (options.omitTreeFiles ? [] : [...FINAL_TREE_MEMBER_FILES])
    .map((path) => ({ path, sha256: blobDigest(path) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest: JsonRecord = {
    schemaVersion: "phase-46-final-candidate/v1",
    phase: 46,
    repairParentSha: repairProofSha,
    ...Object.fromEntries(
      FINAL_AUTHORITY_PATHS.map(([key, authorityPath]) => [
        key,
        { path: authorityPath, sha256: blobDigest(authorityPath) },
      ]),
    ),
    sourceDistTree: {
      algorithm: "phase-46-source-dist-tree/v1",
      included: ["src", "dist"],
      excluded: [],
      members,
      sha256: createHash("sha256")
        .update(`${report.canonicalJson(members)}\n`)
        .digest("hex"),
    },
  };
  options.manifestOverride?.(manifest);
  if (options.insertIntermediateCommit) {
    write("native/intermediate.txt", "intermediate\n");
    run("add", "native/intermediate.txt");
    run("commit", "-q", "-m", "intermediate");
  }
  const staged: string[] = [];
  if (!options.omitManifest) {
    write(
      FINAL_CANDIDATE_MANIFEST_PATH,
      options.serialize
        ? options.serialize(manifest)
        : `${report.canonicalJson(manifest)}\n`,
    );
    staged.push(FINAL_CANDIDATE_MANIFEST_PATH);
  }
  for (const [relative, contents] of Object.entries(
    options.extraCandidateFiles ?? {},
  )) {
    write(relative, contents);
    staged.push(relative);
  }
  run("add", ...staged);
  run("commit", "-q", "-m", "final candidate");
  return {
    root,
    candidateSha: run("rev-parse", "HEAD").trim(),
    repairProofSha,
    manifest,
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("paired benchmark admission", () => {
  // ALWAYS RUNS, including in a hosted checkout where the gated tests below are
  // skipped.  The titles are LITERAL strings, deliberately not derived from the
  // same values `evidenceGatedIt` registers, so a change cannot move both sides
  // silently — the discipline Plan 46-42 applied to `focusedAuthorityMessages`.
  // Gating a seventh test in this file, or ungating one of these six, fails
  // here until the list below is updated on purpose.
  it("pins the evidence-gated test registry for this file", () => {
    const pinned = [
      "rejects every hosted ledger clause tamper it can reach",
      "resolves each shared-message hosted ledger clause with a conjunct mutant",
      "binds the hosted ledger clause on animation samples and RSS behaviorally",
      "accepts a hosted ledger built from run 35030048631 real artifacts",
      "accepts only exact short repair and final identity-ledger refs",
      "validateP95NullBranchClosure accepts only a null-branch closure bound to the real sealed ledger and rejects any overclaim or identity mismatch",
    ];
    expect(pinned).toHaveLength(6);
    expect([...evidenceGatedTestTitles()].sort()).toEqual([...pinned].sort());
  });

  evidenceGatedIt(
    "rejects every hosted ledger clause tamper it can reach",
    async () => {
      // D-39 clause (e): `hostedLedger` was 100% unexercised.  Every assertion
      // below is a SEPARATE tamper carrying that clause's anchored exact message,
      // driven over `structuredClone`d copies of the accepting fixture above.
      const fixture = acceptingHostedLedger();
      try {
        const rejects = (
          mutate: (hosted: JsonRecord) => void,
          message: string,
        ): void => {
          const clone = structuredClone(fixture.hosted) as JsonRecord;
          mutate(clone);
          fixture.writeHosted(clone);
          expect(() => fixture.validate()).toThrow(anchoredMessage(message));
        };
        const identityInvalid = "hosted run identity is invalid";

        // RUN IDENTITY --------------------------------------------------------
        rejects((hosted) => (hosted.schemaVersion = 3), identityInvalid);
        rejects(
          (hosted) => (hosted.repository = "szTheory/exifcleaner-electron"),
          identityInvalid,
        );
        rejects((hosted) => (hosted.workflow = "Release"), identityInvalid);
        rejects(
          (hosted) => (hosted.workflowPath = ".github/workflows/release.yml"),
          identityInvalid,
        );
        rejects((hosted) => (hosted.event = "push"), identityInvalid);
        rejects((hosted) => (hosted.conclusion = "failure"), identityInvalid);
        rejects((hosted) => setHostedRunId(hosted, 1.5), identityInvalid);
        rejects(
          (hosted) =>
            (hosted.runUrl =
              "http://github.com/szTheory/exifcleaner-node/actions/runs/1"),
          identityInvalid,
        );
        // The relocated proof-branch constraint (D-39 (a)): `hostedLedger` is the
        // constraint's one remaining home, so the refs CI and releases supply are
        // rejected HERE even though the identity ledger now accepts them.
        for (const ref of RELOCATED_HOSTED_REF_REJECTIONS)
          rejects((hosted) => (hosted.ref = ref), identityInvalid);
        rejects(
          (hosted) => setHostedHeadSha(hosted, `${hosted.headSha as string}zz`),
          identityInvalid,
        );
        rejects(
          (hosted) => (hosted.candidate.sha = "b".repeat(40)),
          identityInvalid,
        );

        // ARTIFACT MAP --------------------------------------------------------
        const artifactMapIncomplete = "hosted artifact map is incomplete";
        rejects(
          (hosted) => delete hosted.artifactSha256["final-native-admission"],
          artifactMapIncomplete,
        );
        rejects(
          (hosted) =>
            (hosted.artifactSha256["extra-artifact"] = "7".repeat(64)),
          artifactMapIncomplete,
        );
        rejects(
          (hosted) =>
            (hosted.artifactSha256["final-native-admission"] = "not-a-digest"),
          artifactMapIncomplete,
        );

        // BENCHMARK BINDING ---------------------------------------------------
        const benchmarkBindingInvalid = "hosted benchmark binding is invalid";
        rejects(
          (hosted) => setCandidateTarball(hosted, "7".repeat(64)),
          benchmarkBindingInvalid,
        );
        rejects(
          (hosted) => (hosted.baseline.tarballSha256 = "7".repeat(64)),
          benchmarkBindingInvalid,
        );
        rejects(
          (hosted) =>
            (hosted.node22 = foreignEnvironmentReport(hosted, {
              platform: "darwin",
            })),
          benchmarkBindingInvalid,
        );
        rejects(
          (hosted) =>
            (hosted.node22 = foreignEnvironmentReport(hosted, {
              architecture: "arm64",
            })),
          benchmarkBindingInvalid,
        );
        rejects(
          (hosted) =>
            (hosted.benchmarks.node22.artifactSha256 = "7".repeat(64)),
          benchmarkBindingInvalid,
        );

        // FOCUSED ADMISSION AUTHORITY -----------------------------------------
        const focusedInvalid = "focused admission authority is invalid";
        rejects(
          (hosted) => (hosted.focused.tuple = "win32-x64"),
          focusedInvalid,
        );
        rejects((hosted) => (hosted.focused.nodeMajor = 22), focusedInvalid);
        rejects((hosted) => (hosted.focused.seed = 460_047), focusedInvalid);
        rejects((hosted) => (hosted.focused.propertyRuns = 25), focusedInvalid);
        rejects(
          (hosted) => delete hosted.focused.oracleAuthority,
          focusedInvalid,
        );
        rejects(
          (hosted) => (hosted.focused.manifestSha256 = "7".repeat(64)),
          focusedInvalid,
        );
        // The exact surviving mutation the D-39 sweep reported by name: the
        // twelve-installed-conclusion count could be deleted with nothing red.
        rejects((hosted) => (hosted.installedConclusions = 13), focusedInvalid);

        // TUPLE SET AND REPORT MAP --------------------------------------------
        rejects(
          (hosted) => delete hosted.tuples["win32-arm64"],
          "installed tuple set is incomplete",
        );
        rejects(
          (hosted) => (hosted.tuples["linux-riscv64"] = {}),
          "installed tuple set is incomplete",
        );
        rejects(
          (hosted) => delete hosted.tuples["linux-x64"].reports.node24,
          "installed report map is incomplete",
        );
        rejects(
          (hosted) => (hosted.tuples["linux-x64"].reports.node20 = {}),
          "installed report map is incomplete",
        );

        // TUPLE BINDING -------------------------------------------------------
        const tupleBindingInvalid = "installed tuple binding is invalid";
        for (const mutate of TUPLE_BINDING_TAMPERS)
          rejects(mutate, tupleBindingInvalid);

        // WINDOWS PUBLICATION AUTHORITY ---------------------------------------
        rejects(
          (hosted) => (hosted.tuples["win32-x64"].cleanup = "fail"),
          "Windows publication authority is invalid",
        );

        // FINALIZATION CONTRACTS ----------------------------------------------
        rejects(
          (hosted) => (hosted.finalizationContracts = { baseline: {} }),
          "version-specific finalization contracts mismatch",
        );

        // PREREQUISITE BINDINGS, DRIVEN THROUGH THE FILES ----------------------
        // The bytes of a copied prerequisite ledger FILE are altered while the
        // hosted ledger's recorded digest is left alone, so `sha256File` is
        // genuinely exercised rather than a constant being compared to a
        // constant.
        fixture.writeHosted(fixture.hosted);
        for (const slot of ["memory", "windows", "identityCleanup"] as const) {
          fixture.substitutePrerequisite(slot);
          expect(() => fixture.validate()).toThrow(
            anchoredMessage(
              `prerequisite ledger binding is invalid: ${slot}.sha256`,
            ),
          );
          fixture.restorePrerequisite(slot);
        }
        expect(() => fixture.validate()).not.toThrow();

        // ANIMATION RSS CEILING -----------------------------------------------
        // The ceiling VALUE is read from the validator and is not changed here.
        // Both sides are raised together so the baseline-relative bound and the
        // per-report peak-RSS verdict stay satisfied and the ceiling is the only
        // clause that can fire.
        const ceiling = acceptingHostedLedger({
          animationBaselineMaxRSSKiB: 200_000,
          animationCandidateMaxRSSKiB: 200_000,
        });
        try {
          expect(() => ceiling.validate()).toThrow(
            anchoredMessage("Node 22 animation RSS authority is invalid"),
          );
        } finally {
          ceiling.cleanup();
        }
      } finally {
        fixture.cleanup();
      }
    },
    180_000,
  );
  evidenceGatedIt(
    "resolves each shared-message hosted ledger clause with a conjunct mutant",
    async () => {
      // `hostedLedger` bundles roughly ten clauses behind the single message
      // `hosted run identity is invalid`, so an anchored message matcher alone
      // cannot say WHICH clause rejected.  For every clause that shares a thrown
      // message with a sibling, a fresh-VM mutant replaces exactly that conjunct
      // with a constant-false term and must make that clause's tamper STOP
      // rejecting while a sibling tamper keeps rejecting.
      const source = await readFile(
        join(projectRoot, "scripts", "qualification", "benchmark-report.cjs"),
        "utf8",
      );
      const fixture = acceptingHostedLedger();
      try {
        const validateWith = (validator: IdentityLedgerValidator): unknown =>
          validator.hostedLedger(
            fixture.hostedPath,
            fixture.memoryPath,
            fixture.windowsPath,
            fixture.identityPath,
            PHASE_46_CORPUS_EPOCH,
          );
        const mutantFor = (
          conjunct: string,
          replacement = "false",
        ): IdentityLedgerValidator => {
          expect(source.split(conjunct).length - 1).toBe(1);
          const mutated = source.replace(conjunct, replacement);
          expect(mutated).not.toBe(source);
          return loadIdentityLedgerValidator(mutated);
        };
        const writeTampered = (mutate: (hosted: JsonRecord) => void): void => {
          const clone = structuredClone(fixture.hosted) as JsonRecord;
          mutate(clone);
          fixture.writeHosted(clone);
        };
        const resolves = (
          conjunct: string,
          tamper: (hosted: JsonRecord) => void,
          sibling: (hosted: JsonRecord) => void,
          replacement = "false ||",
        ): void => {
          const mutant = mutantFor(conjunct, replacement);
          writeTampered(tamper);
          expect(() => fixture.validate()).toThrow();
          expect(() => validateWith(mutant)).not.toThrow();
          writeTampered(sibling);
          expect(() => validateWith(mutant)).toThrow();
        };

        // RUN IDENTITY ---------------------------------------------------------
        const repositoryTamper = (hosted: JsonRecord): void => {
          hosted.repository = "szTheory/exifcleaner-electron";
        };
        const eventTamper = (hosted: JsonRecord): void => {
          hosted.event = "push";
        };
        const runIdentityClauses: [string, (hosted: JsonRecord) => void][] = [
          [
            "ledger.schemaVersion !== 2 ||",
            (hosted) => (hosted.schemaVersion = 3),
          ],
          [
            'ledger.repository !== "szTheory/exifcleaner-node" ||',
            repositoryTamper,
          ],
          [
            'ledger.workflow !== "CI" ||',
            (hosted) => (hosted.workflow = "Release"),
          ],
          [
            'ledger.workflowPath !== ".github/workflows/ci.yml" ||',
            (hosted) => (hosted.workflowPath = ".github/workflows/release.yml"),
          ],
          ['ledger.event !== "workflow_dispatch" ||', eventTamper],
          [
            'ledger.conclusion !== "success" ||',
            (hosted) => (hosted.conclusion = "failure"),
          ],
          [
            "!Number.isSafeInteger(ledger.runId) ||",
            (hosted) => setHostedRunId(hosted, 1.5),
          ],
          [
            '!/^https:\\/\\//.test(ledger.runUrl ?? "") ||',
            (hosted) => (hosted.runUrl = "http://example.invalid/runs/1"),
          ],
          [
            '!/^[a-f0-9]{40}$/.test(ledger.headSha ?? "") ||',
            (hosted) =>
              setHostedHeadSha(hosted, `${hosted.headSha as string}zz`),
          ],
        ];
        for (const [conjunct, tamper] of runIdentityClauses)
          resolves(
            conjunct,
            tamper,
            tamper === repositoryTamper ? eventTamper : repositoryTamper,
          );
        // The candidate/head-sha equality is the LAST conjunct of the clause and
        // carries no trailing `||`.
        resolves(
          "ledger.candidate?.sha !== ledger.headSha",
          (hosted) => (hosted.candidate.sha = "b".repeat(40)),
          repositoryTamper,
          "false",
        );
        // The relocated proof-branch ref check: one conjunct, four rejections.
        // Its mutant must make ALL FOUR accept, which is what proves the four
        // rejections are that clause and not some later gate.
        const refMutant = mutantFor(
          '!/^proof\\/46-11-final-[0-9a-f]+$/.test(ledger.ref ?? "") ||',
          "false ||",
        );
        for (const ref of RELOCATED_HOSTED_REF_REJECTIONS) {
          writeTampered((hosted) => (hosted.ref = ref));
          expect(() => fixture.validate()).toThrow(
            anchoredMessage("hosted run identity is invalid"),
          );
          expect(() => validateWith(refMutant)).not.toThrow();
        }
        writeTampered(repositoryTamper);
        expect(() => validateWith(refMutant)).toThrow();

        // ARTIFACT MAP ---------------------------------------------------------
        const artifactKeySetConjunct = `Object.keys(ledger.artifactSha256 ?? {})
      .sort()
      .join(",") !== artifacts.sort().join(",") ||`;
        const artifactDigestConjunct =
          "artifacts.some((name) => !SHA256.test(ledger.artifactSha256[name]))";
        const extraArtifactKey = (hosted: JsonRecord): void => {
          hosted.artifactSha256["extra-artifact"] = "7".repeat(64);
        };
        const nonDigestArtifact = (hosted: JsonRecord): void => {
          hosted.artifactSha256["final-native-admission"] = "not-a-digest";
        };
        resolves(artifactKeySetConjunct, extraArtifactKey, nonDigestArtifact);
        resolves(
          artifactDigestConjunct,
          nonDigestArtifact,
          extraArtifactKey,
          "false",
        );
        // A MISSING key trips BOTH conjuncts, so neither single mutant flips it.
        // The pair is resolved jointly: with both conjuncts false the missing key
        // is accepted, which is the honest statement of what covers it.
        const bothArtifactConjunctsFalse = loadIdentityLedgerValidator(
          source
            .replace(artifactKeySetConjunct, "false ||")
            .replace(artifactDigestConjunct, "false"),
        );
        writeTampered(
          (hosted) => delete hosted.artifactSha256["final-native-admission"],
        );
        expect(() => fixture.validate()).toThrow(
          anchoredMessage("hosted artifact map is incomplete"),
        );
        expect(() => validateWith(bothArtifactConjunctsFalse)).not.toThrow();

        // BENCHMARK BINDING ----------------------------------------------------
        const baselineDigestTamper = (hosted: JsonRecord): void => {
          hosted.baseline.tarballSha256 = "7".repeat(64);
        };
        resolves(
          "report.candidateSha256 !== ledger.candidate.tarballSha256 ||",
          (hosted) => setCandidateTarball(hosted, "7".repeat(64)),
          baselineDigestTamper,
        );
        resolves(
          "report.baselineSha256 !== ledger.baseline?.tarballSha256 ||",
          baselineDigestTamper,
          (hosted) =>
            (hosted.benchmarks.node22.artifactSha256 = "7".repeat(64)),
        );
        resolves(
          'report.environment.platform !== "linux" ||',
          (hosted) =>
            (hosted.node22 = foreignEnvironmentReport(hosted, {
              platform: "darwin",
            })),
          baselineDigestTamper,
        );
        resolves(
          'report.environment.architecture !== "x64" ||',
          (hosted) =>
            (hosted.node22 = foreignEnvironmentReport(hosted, {
              architecture: "arm64",
            })),
          baselineDigestTamper,
        );
        resolves(
          `ledger.artifactSha256[\`benchmark-linux-node\${nodeMajor}\`] !==
        ledger.benchmarks?.[\`node\${nodeMajor}\`]?.artifactSha256`,
          (hosted) =>
            (hosted.benchmarks.node22.artifactSha256 = "7".repeat(64)),
          baselineDigestTamper,
          "false",
        );

        // FOCUSED ADMISSION AUTHORITY -----------------------------------------
        const focusedTupleTamper = (hosted: JsonRecord): void => {
          hosted.focused.tuple = "win32-x64";
        };
        const focusedSeedTamper = (hosted: JsonRecord): void => {
          hosted.focused.seed = 460_047;
        };
        const focusedClauses: [string, (hosted: JsonRecord) => void, string][] =
          [
            [
              'ledger.focused?.tuple !== "linux-x64" ||',
              focusedTupleTamper,
              "false ||",
            ],
            [
              "ledger.focused?.nodeMajor !== 24 ||",
              (hosted) => (hosted.focused.nodeMajor = 22),
              "false ||",
            ],
            [
              "ledger.focused?.seed !== 460046 ||",
              focusedSeedTamper,
              "false ||",
            ],
            [
              "ledger.focused?.propertyRuns !== 200 ||",
              (hosted) => (hosted.focused.propertyRuns = 25),
              "false ||",
            ],
            [
              "!ledger.focused?.oracleAuthority ||",
              (hosted) => delete hosted.focused.oracleAuthority,
              "false ||",
            ],
            [
              "ledger.focused.manifestSha256 !== ledger.candidate.corpusManifestSha256 ||",
              (hosted) => (hosted.focused.manifestSha256 = "7".repeat(64)),
              "false ||",
            ],
            [
              "ledger.installedConclusions !== 12",
              (hosted) => (hosted.installedConclusions = 13),
              "false",
            ],
          ];
        for (const [conjunct, tamper, replacement] of focusedClauses)
          resolves(
            conjunct,
            tamper,
            tamper === focusedTupleTamper
              ? focusedSeedTamper
              : focusedTupleTamper,
            replacement,
          );

        // TUPLE SET ------------------------------------------------------------
        // An EXTRA tuple is resolved by the key-set conjunct.  A MISSING tuple is
        // caught by the report-map clause even with the key-set conjunct removed,
        // so the key-set conjunct is not what covers it; that is stated rather
        // than papered over.
        const tupleKeySetConjunct = `Object.keys(ledger.tuples ?? {})
      .sort()
      .join(",") !== tuples.sort().join(",")`;
        const tupleKeySetMutant = mutantFor(tupleKeySetConjunct, "false");
        writeTampered((hosted) => (hosted.tuples["linux-riscv64"] = {}));
        expect(() => fixture.validate()).toThrow(
          anchoredMessage("installed tuple set is incomplete"),
        );
        expect(() => validateWith(tupleKeySetMutant)).not.toThrow();
        writeTampered((hosted) => delete hosted.tuples["win32-arm64"]);
        expect(() => validateWith(tupleKeySetMutant)).toThrow(
          anchoredMessage("installed report map is incomplete"),
        );

        // TUPLE BINDING --------------------------------------------------------
        const tupleBindingConjuncts = [
          "item?.jobName !== `installed-${tuple}` ||",
          'item?.conclusion !== "success" ||',
          "item?.runId !== ledger.runId ||",
          "item?.headSha !== ledger.headSha ||",
          "item?.candidateSha !== ledger.headSha ||",
          "item?.candidateTarballSha256 !== ledger.candidate.tarballSha256 ||",
          "item?.corpusManifestSha256 !== ledger.candidate.corpusManifestSha256 ||",
          "item?.nativeManifestSha256 !== ledger.candidate.nativeManifestSha256 ||",
          "item?.artifact?.name !== `installed-${tuple}` ||",
          "item.artifact?.runId !== ledger.runId ||",
          "item.artifact?.sha256 !== ledger.artifactSha256[`installed-${tuple}`] ||",
          "JSON.stringify(item.nodeMajors) !== JSON.stringify([22, 24])",
        ];
        expect(tupleBindingConjuncts).toHaveLength(
          TUPLE_BINDING_TAMPERS.length,
        );
        for (const [index, conjunct] of tupleBindingConjuncts.entries())
          resolves(
            conjunct,
            TUPLE_BINDING_TAMPERS[index]!,
            TUPLE_BINDING_TAMPERS[(index + 1) % TUPLE_BINDING_TAMPERS.length]!,
            index === tupleBindingConjuncts.length - 1 ? "false" : "false ||",
          );

        // WINDOWS PUBLICATION AUTHORITY ---------------------------------------
        const windowsMutant = mutantFor(
          'tuple.startsWith("win32") &&',
          "false &&",
        );
        writeTampered(
          (hosted) => (hosted.tuples["win32-x64"].cleanup = "fail"),
        );
        expect(() => fixture.validate()).toThrow(
          anchoredMessage("Windows publication authority is invalid"),
        );
        expect(() => validateWith(windowsMutant)).not.toThrow();

        // FINALIZATION CONTRACTS ----------------------------------------------
        const finalizationMutant = mutantFor(
          `JSON.stringify(ledger.finalizationContracts) !==
    JSON.stringify(memory.finalizationContracts)`,
          "false",
        );
        writeTampered(
          (hosted) => (hosted.finalizationContracts = { baseline: {} }),
        );
        expect(() => fixture.validate()).toThrow(
          anchoredMessage("version-specific finalization contracts mismatch"),
        );
        expect(() => validateWith(finalizationMutant)).not.toThrow();

        // PREREQUISITE FILE DIGESTS -------------------------------------------
        // The surviving `sha256File` mutation the sweep reported: a binding that
        // compares the hosted ledger's OWN recorded digest to itself cannot
        // detect a substituted file.  Each slot gets its own mutant so the three
        // bindings are resolved separately, and a combined mutant makes all
        // three substitutions accept.
        fixture.writeHosted(fixture.hosted);
        const slots = ["memory", "windows", "identityCleanup"] as const;
        const digestCallSite = (slot: (typeof slots)[number]): string =>
          slot === "identityCleanup"
            ? "sha256File(identityCleanupPath)"
            : `sha256File(${slot}Path)`;
        for (const slot of slots) {
          const selfBoundDigest = loadIdentityLedgerValidator(
            source.replace(
              digestCallSite(slot),
              `ledger.repairs.${slot}.sha256`,
            ),
          );
          fixture.substitutePrerequisite(slot);
          expect(() => fixture.validate()).toThrow(
            anchoredMessage(
              `prerequisite ledger binding is invalid: ${slot}.sha256`,
            ),
          );
          expect(() => validateWith(selfBoundDigest)).not.toThrow();
          for (const sibling of slots.filter((other) => other !== slot)) {
            fixture.substitutePrerequisite(sibling);
            expect(() => validateWith(selfBoundDigest)).toThrow(
              anchoredMessage(
                `prerequisite ledger binding is invalid: ${sibling}.sha256`,
              ),
            );
            fixture.restorePrerequisite(sibling);
          }
          fixture.restorePrerequisite(slot);
        }
        const allDigestsSelfBound = loadIdentityLedgerValidator(
          slots.reduce(
            (text, slot) =>
              text.replace(
                digestCallSite(slot),
                `ledger.repairs.${slot}.sha256`,
              ),
            source,
          ),
        );
        for (const slot of slots) fixture.substitutePrerequisite(slot);
        expect(() => fixture.validate()).toThrow(
          anchoredMessage(
            "prerequisite ledger binding is invalid: memory.sha256",
          ),
        );
        expect(() => validateWith(allDigestsSelfBound)).not.toThrow();
        for (const slot of slots) fixture.restorePrerequisite(slot);
      } finally {
        fixture.cleanup();
      }
    },
    600_000,
  );
  evidenceGatedIt(
    "binds the hosted ledger clause on animation samples and RSS behaviorally",
    async () => {
      // D-39.  This file previously asserted the hundred-sample contract by
      // READING `benchmark-report.cjs` as a string and matching a regular
      // expression against it.  The sweep kept that source text byte-identical,
      // appended a short always-false conjunction that made the check
      // unreachable, and the suite stayed green: a check passing while
      // inspecting something ADJACENT to the behavior.  That assertion is
      // DELETED, not supplemented -- leaving it beside a behavioral assertion
      // would preserve the illusion that the text matcher is doing work.
      //
      // Replacing it behaviorally also MEASURED where the contract is enforced,
      // and the honest answer is not where the text matcher looked.  Findings
      // are recorded as executable assertions rather than prose so they cannot
      // drift.
      const source = await readFile(
        join(projectRoot, "scripts", "qualification", "benchmark-report.cjs"),
        "utf8",
      );
      const fixture = acceptingHostedLedger();
      try {
        const validateWith = (validator: IdentityLedgerValidator): unknown =>
          validator.hostedLedger(
            fixture.hostedPath,
            fixture.memoryPath,
            fixture.windowsPath,
            fixture.identityPath,
            PHASE_46_CORPUS_EPOCH,
          );
        const mutate = (conjunct: string, replacement: string): string => {
          expect(source.split(conjunct).length - 1).toBe(1);
          return source.replace(conjunct, replacement);
        };
        const animationOf = (hosted: JsonRecord): JsonRecord =>
          (hosted.node22.comparisons as JsonRecord[]).find(
            (item) => item.fixtureId === "animation-alpha-16m",
          )! as JsonRecord;
        const writeTampered = (apply: (hosted: JsonRecord) => void): void => {
          const clone = structuredClone(fixture.hosted) as JsonRecord;
          apply(clone);
          fixture.writeHosted(clone);
        };

        // HUNDRED SAMPLES, PER SIDE.  Each side is asserted separately.
        const hundredSampleConjuncts = `animation.baseline.samples.length !== 100 ||
    animation.candidate.samples.length !== 100 ||`;
        const withoutHundredSampleClauses = loadIdentityLedgerValidator(
          mutate(hundredSampleConjuncts, ""),
        );
        for (const side of ["baseline", "candidate"] as const) {
          writeTampered((hosted) =>
            (animationOf(hosted)[side] as JsonRecord).samples.pop(),
          );
          expect(() => fixture.validate()).toThrow(
            anchoredMessage(
              "comparison samples are not bound to retained raw evidence",
            ),
          );
          // NOT COVERED, stated plainly: the hosted ledger's own hundred-sample
          // conjuncts are UNREACHABLE.  `validateReport` runs first inside
          // `hostedLedger` and already binds each comparison side to exactly the
          // hundred retained raw samples, so removing BOTH hosted conjuncts
          // changes nothing.  They are redundant defence in depth, and no tamper
          // can make them the clause that rejects.
          expect(() => validateWith(withoutHundredSampleClauses)).toThrow(
            anchoredMessage(
              "comparison samples are not bound to retained raw evidence",
            ),
          );
        }

        // THE ANIMATION COMPARISON ITSELF is likewise pinned by `validateReport`,
        // so the `!animation` guard is unreachable for the same reason.
        writeTampered((hosted) => {
          hosted.node22.comparisons = (
            hosted.node22.comparisons as JsonRecord[]
          ).filter((item) => item.fixtureId !== "animation-alpha-16m");
        });
        expect(() => fixture.validate()).toThrow(
          anchoredMessage("comparison evidence set is incomplete"),
        );

        // RSS CEILING: REACHABLE, and resolved by its own conjunct mutant.  Both
        // sides are raised together so the baseline-relative bound and the
        // per-report peak-RSS verdict stay satisfied.  The ceiling VALUE is read
        // from the validator and is not changed.
        const ceiling = acceptingHostedLedger({
          animationBaselineMaxRSSKiB: 200_000,
          animationCandidateMaxRSSKiB: 200_000,
        });
        try {
          expect(() => ceiling.validate()).toThrow(
            anchoredMessage("Node 22 animation RSS authority is invalid"),
          );
          const withoutCeiling = loadIdentityLedgerValidator(
            mutate(
              `percentile(
      animation.candidate.samples.map((sample) => sample.maxRSSKiB),
      0.5,
    ) > 153500 ||`,
              "false ||",
            ),
          );
          expect(() =>
            withoutCeiling.hostedLedger(
              ceiling.hostedPath,
              ceiling.memoryPath,
              ceiling.windowsPath,
              ceiling.identityPath,
              PHASE_46_CORPUS_EPOCH,
            ),
          ).not.toThrow();
        } finally {
          ceiling.cleanup();
        }

        // BASELINE-RELATIVE BOUND: NOT COVERED, stated plainly.  The hosted
        // clause bounds the candidate animation RSS median at the baseline
        // median plus 16384 KiB, but `benchmark.evaluatePair` applies the
        // IDENTICAL relation with the identical `peakRssSlackKiB` slack inside
        // `validateReport`, so any ledger that trips the hosted bound has
        // already produced a non-passing report and is rejected by
        // `phaseAdmissionReports` first.  The clause therefore cannot be made
        // the rejecting clause, and its control does not flip under its own
        // conjunct mutant.  It is redundant defence in depth, not lethal, and is
        // reported as not covered rather than quietly counted.
        const slope = acceptingHostedLedger({
          animationBaselineMaxRSSKiB: 1,
          animationCandidateMaxRSSKiB: 20_000,
        });
        try {
          expect(() => slope.validate()).toThrow(
            anchoredMessage("Node benchmark admission is incomplete"),
          );
          const withoutSlopeBound = loadIdentityLedgerValidator(
            mutate(
              `percentile(
      animation.candidate.samples.map((sample) => sample.maxRSSKiB),
      0.5,
    ) >
      percentile(
        animation.baseline.samples.map((sample) => sample.maxRSSKiB),
        0.5,
      ) +
        16384`,
              "false",
            ),
          );
          expect(() =>
            withoutSlopeBound.hostedLedger(
              slope.hostedPath,
              slope.memoryPath,
              slope.windowsPath,
              slope.identityPath,
              PHASE_46_CORPUS_EPOCH,
            ),
          ).toThrow(anchoredMessage("Node benchmark admission is incomplete"));
        } finally {
          slope.cleanup();
        }

        // MODE AND PASS: NOT COVERED, stated plainly.  `phaseAdmissionReports`
        // runs before the hosted binding clause and applies the same two
        // requirements, so the hosted `report.mode !== "admit"` and
        // `report.pass !== true` conjuncts can never be the rejecting clause.
        writeTampered((hosted) => (hosted.node22.mode = "report"));
        expect(() => fixture.validate()).toThrow(
          anchoredMessage("Node benchmark admission is incomplete"),
        );
        const withoutModeAndPass = loadIdentityLedgerValidator(
          mutate(
            `report.mode !== "admit" ||
      report.pass !== true ||`,
            "",
          ),
        );
        expect(() => validateWith(withoutModeAndPass)).toThrow(
          anchoredMessage("Node benchmark admission is incomplete"),
        );
      } finally {
        fixture.cleanup();
      }
    },
    300_000,
  );
  evidenceGatedIt(
    "accepts a hosted ledger built from run 35030048631 real artifacts",
    () => {
      // POSITIVE CONTROL.  Until this is green every hosted-ledger rejection in
      // this file is indistinguishable from what a reject-everything function
      // produces, which is exactly the state D-39 clause (e) reported.
      const fixture = acceptingHostedLedger();
      try {
        expect(() => fixture.validate()).not.toThrow();
        const accepted = fixture.validate() as Record<string, unknown>;
        expect(accepted.runId).toBe(fixture.identity.run.id);
        expect(accepted.headSha).toBe(fixture.identity.run.headSha);
        expect(accepted.installedConclusions).toBe(12);
      } finally {
        fixture.cleanup();
      }
    },
  );
  evidenceGatedIt(
    "accepts only exact short repair and final identity-ledger refs",
    async () => {
      // D-39 (a), a TAKEN decision.  The proof-branch namespace constraint has
      // been RELOCATED out of `validateIdentityCleanupLedger`.  `ci.yml:310`
      // builds this ledger from `GITHUB_REF_NAME` and `release.yml` delegates to
      // `ci.yml` on `v*` tags, so demanding a proof branch here made continuous
      // integration on the default branch and the ENTIRE publish path
      // unreachable; every green run in repository history is on a proof branch,
      // which is why it was never observed.  `hostedLedger` already carries its
      // own `^proof/46-11-final-[0-9a-f]+$` check and is now the constraint's
      // new and only home, so final admission still requires a proof ref -- that
      // is asserted positively at the end of this test.
      //
      // D-34 SURVIVES the relocation: GitHub supplies the SHORT `GITHUB_REF_NAME`
      // and full refs are still rejected, along with empty, whitespace-bearing
      // and slash-shaped values.  Both directions are explicit lists.
      const base = {
        schemaVersion: "phase-46-identity-cleanup-ledger/v1",
        run: {
          id: 123,
          url: "https://github.com/szTheory/exifcleaner-node/actions/runs/123",
          ref: "proof/46-18-repair-abc123",
          headSha: "a".repeat(40),
        },
        candidate: {
          implementationSha: "a".repeat(40),
          tarballSha256: "b".repeat(64),
          corpusManifestSha256: "c".repeat(64),
          nativeManifestSha256: "d".repeat(64),
        },
        artifacts: {},
        installed: {},
      };
      const acceptedRefs = [
        "main",
        "v4.1.0",
        "proof/46-18-repair-dd1b6a1",
        "proof/46-11-final-1c6fcfb",
        "proof/46-25-windows-diagnostic-abc123",
      ];
      const rejectedRefs = [
        "refs/heads/main",
        "refs/tags/v4.1.0",
        "refs/heads/proof/46-18-repair-abc123",
        "",
        "   ",
        "main branch",
        "/main",
        "main/",
        "proof//46-18-repair-abc123",
      ];
      for (const ref of acceptedRefs) {
        try {
          report.validateIdentityCleanupLedger({
            ...base,
            run: { ...base.run, ref },
          });
          throw new Error("partial identity ledger unexpectedly validated");
        } catch (error) {
          expect(String(error)).toMatch(/artifacts/u);
        }
      }
      for (const ref of rejectedRefs)
        expect(() =>
          report.validateIdentityCleanupLedger({
            ...base,
            run: { ...base.run, ref },
          }),
        ).toThrow("identity cleanup ledger run/candidate binding is invalid");

      const source = await readFile(
        join(projectRoot, "scripts", "qualification", "benchmark-report.cjs"),
        "utf8",
      );
      const assertRefAuthority = (candidate: {
        validateIdentityCleanupLedger(input: Record<string, unknown>): void;
      }): void => {
        for (const ref of acceptedRefs) {
          try {
            candidate.validateIdentityCleanupLedger({
              ...base,
              run: { ...base.run, ref },
            });
            throw new Error("partial identity ledger unexpectedly validated");
          } catch (error) {
            if (!/artifacts/u.test(String(error)))
              throw new Error(`accepted identity ref was rejected: ${ref}`);
          }
        }
        for (const ref of rejectedRefs) {
          try {
            candidate.validateIdentityCleanupLedger({
              ...base,
              run: { ...base.run, ref },
            });
            throw new Error("invalid identity ref unexpectedly validated");
          } catch (error) {
            if (!/run\/candidate binding is invalid/u.test(String(error)))
              throw new Error(
                `invalid identity ref reached later gates: ${ref}`,
              );
          }
        }
      };
      expect(() =>
        assertRefAuthority(loadIdentityLedgerValidator(source)),
      ).not.toThrow();
      // The two namespace mutants this test used to carry are gone with the
      // namespace rule; these two mutate the SHORT-REF rule that replaced it --
      // one admits full refs, one admits the empty string.  Each must be killed.
      const mutations = [
        source.replace("/^refs\\//u.test(ledger.run.ref) ||", "false ||"),
        source.replace(
          "!/^[\\w.\\-][\\w.\\-/]*$/u.test(ledger.run.ref) ||",
          "!/^[\\w.\\-/]*$/u.test(ledger.run.ref) ||",
        ),
      ];
      for (const mutation of mutations) {
        expect(mutation).not.toBe(source);
        expect(() =>
          assertRefAuthority(loadIdentityLedgerValidator(mutation)),
        ).toThrow();
      }

      // THE CONSTRAINT IS STILL ENFORCED WHERE IT BELONGS.  The accepting hosted
      // ledger rejects `main`, a version tag, a repair-namespace ref and a full
      // ref, and a conjunct mutant of the hosted ref check makes all four accept.
      const fixture = acceptingHostedLedger();
      try {
        const hostedRefConjunct =
          '!/^proof\\/46-11-final-[0-9a-f]+$/.test(ledger.ref ?? "") ||';
        expect(source.split(hostedRefConjunct).length - 1).toBe(1);
        const withoutHostedRefLock = loadIdentityLedgerValidator(
          source.replace(hostedRefConjunct, "false ||"),
        );
        for (const ref of RELOCATED_HOSTED_REF_REJECTIONS) {
          const clone = structuredClone(fixture.hosted) as JsonRecord;
          clone.ref = ref;
          fixture.writeHosted(clone);
          expect(() => fixture.validate()).toThrow(
            anchoredMessage("hosted run identity is invalid"),
          );
          expect(() =>
            withoutHostedRefLock.hostedLedger(
              fixture.hostedPath,
              fixture.memoryPath,
              fixture.windowsPath,
              fixture.identityPath,
              PHASE_46_CORPUS_EPOCH,
            ),
          ).not.toThrow();
        }
      } finally {
        fixture.cleanup();
      }
    },
    120_000,
  );

  it("covers the renamed windows native publication evidence gate", async () => {
    // D-39 (e).  Two different functions were named
    // `requireWindowsPublicationEvidence`: this one in `benchmark-report.cjs`
    // and an unrelated one in `scripts/package_smoke.cjs`.  They are NOT the
    // same function and are not related by import -- unlike
    // `validateTerminalCleanupRecord`, which `package_smoke.cjs` genuinely
    // imports from this module.  `package_smoke.test.ts` tested the
    // package-smoke copy while READING as coverage of this one, and mutations
    // to this copy survived.  Converging the two was rejected:
    // `scripts/package_smoke.cjs` is outside this plan's ownership and the two
    // have genuinely different contracts -- this one validates a raw hosted
    // evidence object and returns a five-field summary, the other validates an
    // installed-smoke value and throws a `rejected:`-worded message.  This one
    // is therefore RENAMED to match the `Windows native publication evidence`
    // wording of every message it already throws, and exported so it can be
    // covered directly.
    const source = await readFile(
      join(projectRoot, "scripts", "qualification", "benchmark-report.cjs"),
      "utf8",
    );
    const evidence = (): JsonRecord =>
      structuredClone(
        (installedReport("win32-x64", 22) as JsonRecord)
          .windowsPublication as JsonRecord,
      );
    const inconsistent =
      "Windows native publication evidence is incomplete or inconsistent";

    // POSITIVE CONTROL: the five-field summary with its expected values.
    expect(report.requireWindowsNativePublicationEvidence(evidence())).toEqual({
      primitive: "create-hard-link",
      publication: "pass",
      collision: "pass",
      identity: "pass",
      cleanup: "pass",
    });

    // ABSENT.
    for (const absent of [undefined, null, "CreateHardLinkW"])
      expect(() =>
        report.requireWindowsNativePublicationEvidence(absent),
      ).toThrow(
        anchoredMessage("Windows native publication evidence is absent"),
      );

    // ONE TAMPER PER CLAUSE, each with its own conjunct mutant.  The
    // recheck-boolean and link-call tampers are the surviving mutations the
    // D-39 sweep reported by name.
    const clauses: {
      label: string;
      conjunct: string;
      replacement: string;
      tampers: ((value: JsonRecord) => void)[];
    }[] = [
      {
        label: "primitive",
        conjunct: 'evidence.primitive !== "CreateHardLinkW" ||',
        replacement: "false ||",
        tampers: [(value) => (value.primitive = "MoveFileExW")],
      },
      {
        label: "linkCalls",
        conjunct: "evidence.linkCalls !== 1 ||",
        replacement: "false ||",
        tampers: [
          (value) => (value.linkCalls = 0),
          (value) => (value.linkCalls = 2),
        ],
      },
      {
        label: "destinationParentIdentityRechecked",
        conjunct: "evidence.destinationParentIdentityRechecked !== true ||",
        replacement: "false ||",
        tampers: [
          (value) => (value.destinationParentIdentityRechecked = false),
        ],
      },
      {
        label: "stageIdentityRechecked",
        conjunct: "evidence.stageIdentityRechecked !== true ||",
        replacement: "false ||",
        tampers: [(value) => (value.stageIdentityRechecked = false)],
      },
      {
        label: "stageFileIdentityRechecked",
        conjunct: "evidence.stageFileIdentityRechecked !== true ||",
        replacement: "false ||",
        tampers: [(value) => (value.stageFileIdentityRechecked = false)],
      },
      {
        label: "identity shape",
        conjunct: `identities.some(
      (identity) =>
        typeof identity !== "object" ||
        identity === null ||
        typeof identity.volumeSerialNumber !== "string" ||
        !/^[a-f0-9]{16}$/.test(identity.volumeSerialNumber) ||
        typeof identity.fileId !== "string" ||
        !/^[a-f0-9]{32}$/.test(identity.fileId),
    ) ||`,
        replacement: "false ||",
        tampers: [
          // Malformed but MUTUALLY CONSISTENT, so the single-volume-serial and
          // stage/destination conjuncts stay satisfied and the shape conjunct
          // is the only one that can fire.
          (value) => {
            for (const key of [
              "destinationParent",
              "stageDirectory",
              "stageFile",
              "destinationFile",
            ])
              (value[key] as JsonRecord).volumeSerialNumber = "z".repeat(16);
          },
          (value) => {
            value.stageFile.fileId = "z".repeat(32);
            value.destinationFile.fileId = "z".repeat(32);
          },
        ],
      },
      {
        label: "single volume serial",
        conjunct: `new Set(identities.map((identity) => identity.volumeSerialNumber)).size !==
      1 ||`,
        replacement: "false ||",
        tampers: [
          (value) =>
            (value.destinationParent.volumeSerialNumber = "1".repeat(16)),
        ],
      },
      {
        label: "stage/destination file identity",
        conjunct:
          "evidence.stageFile.fileId !== evidence.destinationFile.fileId",
        replacement: "false",
        tampers: [(value) => (value.stageFile.fileId = "9".repeat(32))],
      },
    ];
    const siblingTamper = (value: JsonRecord): void => {
      value.primitive = "MoveFileExW";
    };
    const alternateSibling = (value: JsonRecord): void => {
      value.stageIdentityRechecked = false;
    };
    for (const clause of clauses) {
      expect(source.split(clause.conjunct).length - 1).toBe(1);
      const mutated = source.replace(clause.conjunct, clause.replacement);
      expect(mutated).not.toBe(source);
      const mutant = loadIdentityLedgerValidator(mutated);
      for (const tamper of clause.tampers) {
        const tampered = evidence();
        tamper(tampered);
        expect(() =>
          report.requireWindowsNativePublicationEvidence(tampered),
        ).toThrow(anchoredMessage(inconsistent));
        expect(() =>
          mutant.requireWindowsNativePublicationEvidence(
            structuredClone(tampered),
          ),
        ).not.toThrow();
      }
      const sibling = evidence();
      (clause.label === "primitive" ? alternateSibling : siblingTamper)(
        sibling,
      );
      expect(() =>
        mutant.requireWindowsNativePublicationEvidence(sibling),
      ).toThrow(anchoredMessage(inconsistent));
    }

    // The package-smoke copy and its test stay untouched; its distinct
    // `rejected:` message vocabulary keeps the two unambiguous, and no two
    // functions in the repository now share the name.
    expect(source).not.toContain("requireWindowsPublicationEvidence");
  }, 120_000);

  it("accepts only one exact two-tuple cancellation diagnostic run", () => {
    const ledger = cancellationDiagnosticLedger();
    expect(() =>
      report.validateWindowsCancellationDiagnosticLedger(ledger),
    ).not.toThrow();

    const mutations = [
      { ...ledger, diagnosticOnly: false },
      { ...ledger, admission: false },
      { ...ledger, productSuccess: false },
      { ...ledger, retry: 0 },
      { ...ledger, run: { ...ledger.run, event: "push" } },
      { ...ledger, run: { ...ledger.run, attempt: 2 } },
      { ...ledger, run: { ...ledger.run, ref: "refs/heads/main" } },
      {
        ...ledger,
        records: { "win32-x64": ledger.records["win32-x64"] },
      },
      {
        ...ledger,
        records: {
          ...ledger.records,
          "win32-x64": {
            ...ledger.records["win32-x64"],
            tuple: "win32-arm64",
          },
        },
      },
      {
        ...ledger,
        records: {
          ...ledger.records,
          "win32-x64": {
            ...ledger.records["win32-x64"],
            artifact: {
              ...ledger.records["win32-x64"].artifact,
              sha256: "unhashed",
            },
          },
        },
      },
      {
        ...ledger,
        records: {
          ...ledger.records,
          "win32-x64": {
            ...ledger.records["win32-x64"],
            job: {
              ...ledger.records["win32-x64"].job,
              conclusion: "success",
            },
          },
        },
      },
      {
        ...ledger,
        records: {
          ...ledger.records,
          "win32-x64": {
            ...ledger.records["win32-x64"],
            diagnostic: {
              ...ledger.records["win32-x64"].diagnostic,
              path: "C:\\private\\cancel.webp",
            },
          },
        },
      },
    ];
    for (const mutation of mutations)
      expect(() =>
        report.validateWindowsCancellationDiagnosticLedger(mutation),
      ).toThrow();
  });

  it("rejects accepted-only, mixed, extra, and arbitrary cancellation payloads", () => {
    const ledger = cancellationDiagnosticLedger();
    const acceptedOnly = structuredClone(ledger);
    for (const record of Object.values(acceptedOnly.records)) {
      record.diagnostic.observation = cancellationObservation("accepted");
      record.diagnostic.observation.nativeWrite = "started";
    }
    const mixed = structuredClone(ledger);
    mixed.records["win32-arm64"].diagnostic.tuple = "win32-x64";
    const extra = structuredClone(ledger);
    Object.assign(extra.records, { "win32-x86": extra.records["win32-x64"] });
    const arbitrary = structuredClone(ledger);
    arbitrary.records["win32-x64"].diagnostic.observation.errorCode =
      "arbitrary-message-sentinel";
    for (const mutation of [acceptedOnly, mixed, extra, arbitrary])
      expect(() =>
        report.validateWindowsCancellationDiagnosticLedger(mutation),
      ).toThrow();
  });

  it("accepts exact run 33200060244 only as publication hypothesis-refuted", () => {
    const ledger = hypothesisRefutedLedger();
    expect(() =>
      report.validateWindowsPublicationDiagnosticLedger(ledger),
    ).not.toThrow();

    const mutations = [
      { ...ledger, outcome: "rejection-observed" },
      { ...ledger, selectedBoundary: "installed-node22" },
      { ...ledger, laterFailures: null },
      {
        ...ledger,
        laterFailures: {
          ...ledger.laterFailures,
          "win32-arm64": "installed-smoke",
        },
      },
      { ...ledger, run: { ...ledger.run, attempt: 2 } },
      { ...ledger, run: { ...ledger.run, id: 33200060245 } },
      { ...ledger, run: { ...ledger.run, headSha: "0".repeat(40) } },
      {
        ...ledger,
        installedNode22: {
          ...ledger.installedNode22,
          "win32-x64": {
            ...ledger.installedNode22["win32-x64"],
            job: {
              ...ledger.installedNode22["win32-x64"].job,
              conclusion: "success",
            },
          },
        },
      },
      {
        ...ledger,
        installedNode22: {
          ...ledger.installedNode22,
          "win32-arm64": {
            ...ledger.installedNode22["win32-arm64"],
            observation: {
              ...diagnosticLedger().matchingHost["win32-arm64"].observation,
            },
          },
        },
      },
      {
        ...ledger,
        matchingHost: {
          ...ledger.matchingHost,
          "win32-x64": {
            ...ledger.matchingHost["win32-x64"],
            artifact: {
              ...ledger.matchingHost["win32-x64"].artifact,
              sha256: "f".repeat(64),
            },
          },
        },
      },
      { ...ledger, productSuccess: false },
      { ...ledger, admission: false },
      { ...ledger, retry: 0 },
    ];
    for (const mutation of mutations)
      expect(() =>
        report.validateWindowsPublicationDiagnosticLedger(mutation),
      ).toThrow();
  });

  it("accepts only one complete diagnostic-only Windows boundary", () => {
    const ledger = diagnosticLedger();
    expect(() =>
      report.validateWindowsPublicationDiagnosticLedger(ledger),
    ).not.toThrow();

    const installed = {
      "win32-x64": {
        ...ledger.matchingHost["win32-x64"],
        boundary: "installed-node22",
        job: { name: "installed-win32-x64", conclusion: "failure" },
        artifact: {
          name: "windows-publication-installed-node22-win32-x64",
          sha256: "d".repeat(64),
        },
      },
      "win32-arm64": {
        ...ledger.matchingHost["win32-arm64"],
        boundary: "installed-node22",
        job: { name: "installed-win32-arm64", conclusion: "success" },
        artifact: {
          name: "windows-publication-installed-node22-win32-arm64",
          sha256: "e".repeat(64),
        },
        observation: acceptedWindowsPublicationObservation(),
      },
    };
    const installedLedger = {
      ...ledger,
      selectedBoundary: "installed-node22",
      matchingHost: Object.fromEntries(
        Object.entries(ledger.matchingHost).map(([tuple, value]) => [
          tuple,
          {
            ...value,
            job: { ...value.job, conclusion: "success" },
            observation: acceptedWindowsPublicationObservation(),
          },
        ]),
      ),
      installedNode22: installed,
    };
    expect(() =>
      report.validateWindowsPublicationDiagnosticLedger(installedLedger),
    ).not.toThrow();
  });

  it("rejects partial, mixed, raw, unbound, or authority-claiming diagnostics", () => {
    const base = diagnosticLedger();
    const mutations = [
      { ...base, diagnosticOnly: false },
      { ...base, admission: true },
      { ...base, run: { ...base.run, event: "push" } },
      { ...base, run: { ...base.run, headSha: "d".repeat(40) } },
      {
        ...base,
        matchingHost: { "win32-x64": base.matchingHost["win32-x64"] },
      },
      { ...base, installedNode22: base.matchingHost },
      {
        ...base,
        matchingHost: {
          ...base.matchingHost,
          "win32-x64": {
            ...base.matchingHost["win32-x64"],
            artifact: {
              ...base.matchingHost["win32-x64"].artifact,
              sha256: "unhashed",
            },
          },
        },
      },
      {
        ...base,
        matchingHost: {
          ...base.matchingHost,
          "win32-x64": {
            ...base.matchingHost["win32-x64"],
            observation: {
              ...base.matchingHost["win32-x64"].observation,
              reason: "unknown-reason",
            },
          },
        },
      },
      {
        ...base,
        matchingHost: {
          ...base.matchingHost,
          "win32-x64": {
            ...base.matchingHost["win32-x64"],
            observation: {
              ...base.matchingHost["win32-x64"].observation,
              rawValue: "C:\\private\\image.webp",
            },
          },
        },
      },
    ];
    for (const mutation of mutations)
      expect(() =>
        report.validateWindowsPublicationDiagnosticLedger(mutation),
      ).toThrow();

    const noRejection = diagnosticLedger();
    noRejection.matchingHost = Object.fromEntries(
      Object.entries(noRejection.matchingHost).map(([tuple, value]) => [
        tuple,
        {
          ...value,
          job: { ...value.job, conclusion: "success" },
          observation: acceptedWindowsPublicationObservation(),
        },
      ]),
    ) as typeof noRejection.matchingHost;
    expect(() =>
      report.validateWindowsPublicationDiagnosticLedger(noRejection),
    ).toThrow();
  });
  it("fails closed when a final candidate manifest is absent", () => {
    // Tightened from a case-insensitive fragment matcher, which FIVE different
    // messages satisfied, to an anchored exact matcher.
    expect(() =>
      report.validateFinalCandidateManifest({
        repoRoot: projectRoot,
        candidateSha: "0".repeat(40),
        repairProofSha: "0".repeat(40),
      }),
    ).toThrow(anchoredMessage("final candidate manifest is absent"));
  });

  it("rejects every windows terminal cleanup relation tamper", async () => {
    // D-39 clause (e).  The win32 branch was POSITIVE-ONLY: eleven mutations
    // survived, including the relation requiring an INSTALLED Windows record
    // to preserve the replacement -- the single relation that makes Windows
    // installed-smoke cleanup evidence mean anything.
    const source = await readFile(
      join(projectRoot, "scripts", "qualification", "benchmark-report.cjs"),
      "utf8",
    );
    const mutantFor = (
      original: string,
      replacement: string,
    ): IdentityLedgerValidator => {
      expect(source.split(original).length - 1).toBe(1);
      const mutated = source.replace(original, replacement);
      expect(mutated).not.toBe(source);
      return loadIdentityLedgerValidator(mutated);
    };
    const serial = "0".repeat(16);
    const identity = (fileId: string): JsonRecord => ({
      volumeSerialNumber: serial,
      fileId: fileId.repeat(32),
    });
    const retained = (): JsonRecord =>
      terminalCleanupRecord("win32") as unknown as JsonRecord;
    const removed = (): JsonRecord => {
      const record = retained();
      record.terminal.outcome = "removed";
      record.terminal.identityBefore = identity("e");
      record.terminal.removalIdentity = identity("e");
      return record;
    };
    const absent = (): JsonRecord => {
      const record = retained();
      record.terminal.outcome = "absent";
      record.terminal.identityBefore = null;
      record.terminal.removalIdentity = null;
      return record;
    };

    // THREE OUTCOME POSITIVE CONTROLS, each proved acceptable where permitted.
    expect(() =>
      report.validateTerminalCleanupRecord(retained(), "installed"),
    ).not.toThrow();
    for (const build of [retained, removed, absent])
      expect(() =>
        report.validateTerminalCleanupRecord(build(), "control"),
      ).not.toThrow();

    const rejects = (record: JsonRecord, message: string): void =>
      expect(() =>
        report.validateTerminalCleanupRecord(record, "control"),
      ).toThrow(anchoredMessage(message));

    // THE INSTALLED-SCENARIO RELATION, asserted against BOTH non-preserving
    // outcomes, with a conjunct mutant that makes both accept.
    for (const build of [removed, absent])
      expect(() =>
        report.validateTerminalCleanupRecord(build(), "installed"),
      ).toThrow(
        anchoredMessage(
          "installed Windows record did not preserve the replacement",
        ),
      );
    const withoutInstalledRelation = mutantFor(
      `    if (scenario === "installed" && !replacementOutcome)
      throw new Error(
        "installed Windows record did not preserve the replacement",
      );
`,
      "",
    );
    for (const build of [removed, absent])
      expect(() =>
        withoutInstalledRelation.validateTerminalCleanupRecord(
          build(),
          "installed",
        ),
      ).not.toThrow();

    // SHAPE RELATIONS, each tampered separately with its anchored message.
    const captureNotAuthentic = retained();
    captureNotAuthentic.capture.result = "unsupported";
    rejects(captureNotAuthentic, "Windows capture is not authentic");
    const shapeRelations: [string, (record: JsonRecord) => void][] = [
      [
        "captured directory identity",
        (record) => (record.capture.directoryIdentity.fileId = "z".repeat(32)),
      ],
      [
        "captured file identity",
        (record) => (record.capture.fileIdentity.fileId = "z".repeat(32)),
      ],
      [
        "terminal identity before",
        (record) => (record.terminal.identityBefore.fileId = "z".repeat(32)),
      ],
      [
        "terminal removal identity",
        (record) =>
          (record.terminal.removalIdentity.volumeSerialNumber = "z".repeat(16)),
      ],
      [
        "replacement identity before",
        (record) => (record.replacement.identityBefore.fileId = "z".repeat(32)),
      ],
      [
        "replacement identity after",
        (record) => (record.replacement.identityAfter.fileId = "z".repeat(32)),
      ],
    ];
    for (const [label, tamper] of shapeRelations) {
      const record = retained();
      tamper(record);
      rejects(record, `${label} is not a Windows FileIdInfo identity`);
    }

    // THE SURVIVOR PROOF: five identity relations plus the digest pair, all
    // behind ONE message, so each is resolved by its own conjunct mutant that
    // makes only its own control accept.
    const survivorCondition = `        !sameCleanupIdentity(terminal.identityBefore, capture.fileIdentity) ||
        !sameCleanupIdentity(
          terminal.removalIdentity,
          replacement.identityBefore,
        ) ||
        sameCleanupIdentity(terminal.removalIdentity, capture.fileIdentity) ||
        !sameCleanupIdentity(
          replacement.identityBefore,
          replacement.identityAfter,
        ) ||
        !SHA256.test(replacement.sha256Before) ||
        replacement.sha256Before !== replacement.sha256After
`;
    expect(source.split(survivorCondition).length - 1).toBe(1);
    const survivorRelations: [string, string, (record: JsonRecord) => void][] =
      [
        [
          "terminal identity before equals the captured file identity",
          "        !sameCleanupIdentity(terminal.identityBefore, capture.fileIdentity) ||\n",
          (record) => (record.terminal.identityBefore = identity("1")),
        ],
        [
          "removal identity equals the replacement identity before",
          "        !sameCleanupIdentity(\n          terminal.removalIdentity,\n          replacement.identityBefore,\n        ) ||\n",
          (record) => (record.terminal.removalIdentity = identity("2")),
        ],
        [
          "removal identity differs from the captured file identity",
          "        sameCleanupIdentity(terminal.removalIdentity, capture.fileIdentity) ||\n",
          (record) => {
            record.terminal.removalIdentity = identity("e");
            record.replacement.identityBefore = identity("e");
            record.replacement.identityAfter = identity("e");
          },
        ],
        [
          "replacement identities are equal",
          "        !sameCleanupIdentity(\n          replacement.identityBefore,\n          replacement.identityAfter,\n        ) ||\n",
          (record) => (record.replacement.identityAfter = identity("3")),
        ],
        [
          "replacement digest is well formed",
          "        !SHA256.test(replacement.sha256Before) ||\n",
          (record) => {
            record.replacement.sha256Before = "not-a-digest";
            record.replacement.sha256After = "not-a-digest";
          },
        ],
        [
          "replacement digests are equal",
          "        replacement.sha256Before !== replacement.sha256After\n",
          (record) => (record.replacement.sha256After = "4".repeat(64)),
        ],
      ];
    for (const [, , tamper] of survivorRelations) {
      const record = retained();
      tamper(record);
      rejects(record, "Windows replacement survivor proof is invalid");
    }
    for (const [label, conjunct, tamper] of survivorRelations) {
      const remainder = survivorCondition.replace(
        conjunct,
        conjunct.trimEnd().endsWith("||") ? "" : "        false\n",
      );
      expect(remainder).not.toBe(survivorCondition);
      const mutant = loadIdentityLedgerValidator(
        source.replace(survivorCondition, remainder),
      );
      const own = retained();
      tamper(own);
      expect(() =>
        mutant.validateTerminalCleanupRecord(own, "control"),
      ).not.toThrow();
      for (const [siblingLabel, , siblingTamper] of survivorRelations) {
        if (siblingLabel === label) continue;
        const sibling = retained();
        siblingTamper(sibling);
        expect(() =>
          mutant.validateTerminalCleanupRecord(sibling, "control"),
        ).toThrow(
          anchoredMessage("Windows replacement survivor proof is invalid"),
        );
      }
    }

    // REMOVED AND ABSENT OUTCOMES, AND THE UNKNOWN OUTCOME.
    const removedCondition = `        !sameCleanupIdentity(terminal.identityBefore, capture.fileIdentity) ||
        !sameCleanupIdentity(terminal.removalIdentity, capture.fileIdentity)
`;
    const removedRelations: [string, (record: JsonRecord) => void][] = [
      [
        "        !sameCleanupIdentity(terminal.identityBefore, capture.fileIdentity) ||\n",
        (record) => (record.terminal.identityBefore = identity("1")),
      ],
      [
        "        !sameCleanupIdentity(terminal.removalIdentity, capture.fileIdentity)\n",
        (record) => (record.terminal.removalIdentity = identity("2")),
      ],
    ];
    for (const [conjunct, tamper] of removedRelations) {
      const record = removed();
      tamper(record);
      rejects(record, "Windows removal identity is invalid");
      const remainder = removedCondition.replace(
        conjunct,
        conjunct.trimEnd().endsWith("||") ? "" : "        false\n",
      );
      expect(remainder).not.toBe(removedCondition);
      const mutant = loadIdentityLedgerValidator(
        source.replace(removedCondition, remainder),
      );
      const own = removed();
      tamper(own);
      expect(() =>
        mutant.validateTerminalCleanupRecord(own, "control"),
      ).not.toThrow();
    }
    for (const field of ["identityBefore", "removalIdentity"] as const) {
      const record = absent();
      record.terminal[field] = identity("e");
      rejects(record, "Windows absent identity is invalid");
    }
    const unknownOutcome = absent();
    unknownOutcome.terminal.outcome = "vanished";
    rejects(unknownOutcome, "Windows terminal outcome is invalid");

    // NATIVE LIFETIME BALANCE.
    for (const tamper of [
      (record: JsonRecord) => (record.nativeLifetime.handlesAfter = 3),
      (record: JsonRecord) => (record.nativeLifetime.finalizersAfter = 0),
    ]) {
      const record = retained();
      tamper(record);
      rejects(record, "Windows native lifetime is imbalanced");
    }

    // THE POSIX BRANCH IS NOT WEAKENED.
    for (const platform of ["linux", "darwin"] as const) {
      const posix = (): JsonRecord =>
        terminalCleanupRecord(platform) as unknown as JsonRecord;
      expect(() =>
        report.validateTerminalCleanupRecord(posix(), "installed"),
      ).not.toThrow();
      for (const tamper of [
        (record: JsonRecord) => (record.capture.result = "captured"),
        (record: JsonRecord) => (record.capture.fileIdentity = identity("e")),
        (record: JsonRecord) => (record.nativeLifetime.finalizersAfter = 1),
      ]) {
        const record = posix();
        tamper(record);
        rejects(record, "POSIX retained cleanup record is invalid");
      }
    }
  }, 300_000);

  it("rejects every final candidate manifest clause tamper", async () => {
    // D-39 clause (e).  The sweep reported eight surviving mutations here
    // because only the absent path was tested, behind a matcher five different
    // messages satisfy.  Each tamper below is SEPARATE and names that clause's
    // anchored exact message; every clause sharing a message with a sibling is
    // resolved by a fresh-VM conjunct mutant.
    const source = await readFile(
      join(projectRoot, "scripts", "qualification", "benchmark-report.cjs"),
      "utf8",
    );
    const mutantFor = (
      conjunct: string,
      replacement: string,
    ): IdentityLedgerValidator => {
      expect(source.split(conjunct).length - 1).toBe(1);
      const mutated = source.replace(conjunct, replacement);
      expect(mutated).not.toBe(source);
      return loadIdentityLedgerValidator(mutated);
    };
    const drive = (
      options: ManifestRepositoryOptions,
      assertion: (call: () => unknown) => void,
      validator: {
        validateFinalCandidateManifest(input: {
          repoRoot: string;
          candidateSha: string;
          repairProofSha: string;
        }): unknown;
      } = report,
    ): void => {
      const repository = finalCandidateRepository(options);
      try {
        assertion(() =>
          validator.validateFinalCandidateManifest({
            repoRoot: repository.root,
            candidateSha: repository.candidateSha,
            repairProofSha: repository.repairProofSha,
          }),
        );
      } finally {
        repository.cleanup();
      }
    };
    const rejects = (
      options: ManifestRepositoryOptions,
      message: string,
    ): void =>
      drive(options, (call) => expect(call).toThrow(anchoredMessage(message)));
    const acceptsUnder = (
      options: ManifestRepositoryOptions,
      validator: IdentityLedgerValidator,
    ): void => drive(options, (call) => expect(call).not.toThrow(), validator);

    // SHA SHAPE, before any git call, for both arguments separately.
    for (const shas of [
      { candidateSha: "z".repeat(40), repairProofSha: "0".repeat(40) },
      { candidateSha: "0".repeat(40), repairProofSha: "0".repeat(39) },
    ])
      expect(() =>
        report.validateFinalCandidateManifest({
          repoRoot: projectRoot,
          ...shas,
        }),
      ).toThrow(anchoredMessage("final candidate manifest SHA is invalid"));

    // CANONICAL BYTES.  The committed bytes differ from the canonical
    // serialization ONLY by key order, which is the behavioral proof that the
    // key sort is load-bearing at the gate.  This closes the deferral Plan
    // 46-38 recorded.
    const keyOrderOnly: ManifestRepositoryOptions = {
      serialize: (manifest) =>
        `${JSON.stringify(Object.fromEntries(Object.entries(manifest).reverse()))}\n`,
    };
    rejects(keyOrderOnly, "final candidate manifest bytes are not canonical");
    acceptsUnder(
      keyOrderOnly,
      mutantFor(
        '  if (!bytes.equals(Buffer.from(`${canonicalJson(manifest)}\\n`, "utf8")))\n    throw new Error("final candidate manifest bytes are not canonical");\n',
        "",
      ),
    );

    // COMMIT DIFF EXACTNESS.
    const twoFileCommit: ManifestRepositoryOptions = {
      extraCandidateFiles: { "native/extra.txt": "extra\n" },
    };
    rejects(twoFileCommit, "final candidate manifest commit diff is not exact");
    rejects(
      { ...twoFileCommit, omitManifest: true },
      "final candidate manifest is absent",
    );
    acceptsUnder(
      twoFileCommit,
      mutantFor(
        "if (diff.length !== 1 || diff[0] !== manifestPath)",
        "if (false)",
      ),
    );

    // REPAIR PARENT: the RECORDED value and the ACTUAL ancestry are asserted
    // separately so neither can substitute for the other.
    const repairParentInvalid =
      "final candidate manifest repair parent is invalid";
    const repairParentClauses: [string, ManifestRepositoryOptions, string][] = [
      [
        '    manifest.schemaVersion !== "phase-46-final-candidate/v1" ||\n',
        {
          manifestOverride: (manifest) =>
            (manifest.schemaVersion = "phase-46-final-candidate/v2"),
        },
        "",
      ],
      [
        "    manifest.phase !== 46 ||\n",
        { manifestOverride: (manifest) => (manifest.phase = 45) },
        "",
      ],
      [
        "    manifest.repairParentSha !== repairProofSha\n",
        {
          manifestOverride: (manifest) =>
            (manifest.repairParentSha = "0".repeat(40)),
        },
        "    false\n",
      ],
    ];
    for (const [conjunct, options, replacement] of repairParentClauses) {
      rejects(options, repairParentInvalid);
      acceptsUnder(options, mutantFor(conjunct, replacement));
    }
    rejects(
      { insertIntermediateCommit: true },
      "final candidate manifest does not directly follow repair proof",
    );
    acceptsUnder(
      { insertIntermediateCommit: true },
      mutantFor("  if (parent !== repairProofSha)", "  if (false)"),
    );

    // AUTHORITY TRIPLE, one tamper per entry per direction.  The digests of the
    // fixture's own tree members are reused so a path tamper leaves the
    // recorded digest CONSISTENT with the file it now names; otherwise the
    // digest conjunct fires too and the path conjunct cannot be resolved.
    const treeMemberDigest = (manifest: JsonRecord, path: string): string =>
      ((manifest.sourceDistTree as JsonRecord).members as JsonRecord[]).find(
        (member) => member.path === path,
      )!.sha256 as string;
    for (const [key] of FINAL_AUTHORITY_PATHS) {
      const wrongPath: ManifestRepositoryOptions = {
        manifestOverride: (manifest) =>
          (manifest[key] = {
            path: "src/index.ts",
            sha256: treeMemberDigest(manifest, "src/index.ts"),
          }),
      };
      const wrongDigest: ManifestRepositoryOptions = {
        manifestOverride: (manifest) =>
          ((manifest[key] as JsonRecord).sha256 = "7".repeat(64)),
      };
      rejects(wrongPath, `final authority ${key} is invalid`);
      rejects(wrongDigest, `final authority ${key} is invalid`);
    }
    // The authority loop is shared by all five entries, so one mutant per
    // conjunct resolves the whole triple.
    const nativeSourcePath: ManifestRepositoryOptions = {
      manifestOverride: (manifest) =>
        (manifest.nativeSource = {
          path: "src/index.ts",
          sha256: treeMemberDigest(manifest, "src/index.ts"),
        }),
    };
    acceptsUnder(
      nativeSourcePath,
      mutantFor("      value.path !== expectedPath ||\n", ""),
    );
    acceptsUnder(
      {
        manifestOverride: (manifest) =>
          ((manifest.nativeSource as JsonRecord).sha256 = "7".repeat(64)),
      },
      mutantFor(
        "      sha256FileFromBytes(gitBlob(repoRoot, candidateSha, value.path)) !==\n        value.sha256\n",
        "      false\n",
      ),
    );
    // A MALFORMED authority digest trips the shape conjunct AND the digest
    // comparison, so neither single mutant flips it; the pair is resolved
    // jointly, which is the honest statement of what covers it.
    const malformedAuthorityDigest: ManifestRepositoryOptions = {
      manifestOverride: (manifest) =>
        ((manifest.nativeSource as JsonRecord).sha256 = "not-a-digest"),
    };
    rejects(
      malformedAuthorityDigest,
      "final authority nativeSource is invalid",
    );
    acceptsUnder(
      malformedAuthorityDigest,
      loadIdentityLedgerValidator(
        source
          .replace("      !SHA256.test(value.sha256) ||\n", "")
          .replace(
            "      sha256FileFromBytes(gitBlob(repoRoot, candidateSha, value.path)) !==\n        value.sha256\n",
            "      false\n",
          ),
      ),
    );

    // SOURCE AND DIST TREE CONTRACT.
    const treeContractInvalid =
      "final candidate source/dist tree contract is invalid";
    const treeOf = (manifest: JsonRecord): JsonRecord =>
      manifest.sourceDistTree as JsonRecord;
    const treeContractClauses: [string, ManifestRepositoryOptions][] = [
      [
        '    tree.algorithm !== "phase-46-source-dist-tree/v1" ||\n',
        {
          manifestOverride: (manifest) =>
            (treeOf(manifest).algorithm = "phase-46-source-dist-tree/v2"),
        },
      ],
      [
        '    JSON.stringify(tree.included) !== JSON.stringify(["src", "dist"]) ||\n',
        {
          manifestOverride: (manifest) => (treeOf(manifest).included = ["src"]),
        },
      ],
      [
        "    JSON.stringify(tree.excluded) !== JSON.stringify([]) ||\n",
        {
          manifestOverride: (manifest) =>
            (treeOf(manifest).excluded = ["src/skip.ts"]),
        },
      ],
    ];
    for (const [conjunct, options] of treeContractClauses) {
      rejects(options, treeContractInvalid);
      acceptsUnder(options, mutantFor(conjunct, ""));
    }
    // A malformed tree digest and a non-array member list each trip the
    // contract clause AND the digest clause, so each is resolved by the PAIR.
    const malformedTreeDigest: ManifestRepositoryOptions = {
      manifestOverride: (manifest) =>
        (treeOf(manifest).sha256 = "not-a-digest"),
    };
    const nonArrayMembers: ManifestRepositoryOptions = {
      manifestOverride: (manifest) => (treeOf(manifest).members = {}),
    };
    rejects(malformedTreeDigest, treeContractInvalid);
    rejects(nonArrayMembers, treeContractInvalid);
    const treeDigestComparison = `    tree.sha256 !==
      sha256FileFromBytes(Buffer.from(\`\${canonicalJson(members)}\\n\`))\n`;
    acceptsUnder(
      malformedTreeDigest,
      loadIdentityLedgerValidator(
        source
          .replace("    !SHA256.test(tree.sha256) ||\n", "")
          .replace(treeDigestComparison, "    false\n"),
      ),
    );
    acceptsUnder(
      nonArrayMembers,
      loadIdentityLedgerValidator(
        source
          .replace("    !Array.isArray(tree.members)\n", "    false\n")
          .replace(
            "    JSON.stringify(tree.members) !== JSON.stringify(members) ||\n",
            "",
          ),
      ),
    );

    // SOURCE AND DIST TREE DIGEST, including the tree-members comparison the
    // sweep reported surviving.
    const treeDigestInvalid =
      "final candidate source/dist tree digest is invalid";
    rejects({ omitTreeFiles: true }, treeDigestInvalid);
    acceptsUnder(
      { omitTreeFiles: true },
      mutantFor("    !members.length ||\n", ""),
    );
    const omittedMember: ManifestRepositoryOptions = {
      manifestOverride: (manifest) =>
        (treeOf(manifest).members = (
          treeOf(manifest).members as JsonRecord[]
        ).slice(1)),
    };
    const wrongMemberDigest: ManifestRepositoryOptions = {
      manifestOverride: (manifest) =>
        ((treeOf(manifest).members as JsonRecord[])[0]!.sha256 = "7".repeat(
          64,
        )),
    };
    rejects(omittedMember, treeDigestInvalid);
    rejects(wrongMemberDigest, treeDigestInvalid);
    const membersComparisonMutant = mutantFor(
      "    JSON.stringify(tree.members) !== JSON.stringify(members) ||\n",
      "",
    );
    acceptsUnder(omittedMember, membersComparisonMutant);
    acceptsUnder(wrongMemberDigest, membersComparisonMutant);
    const wrongTreeDigest: ManifestRepositoryOptions = {
      manifestOverride: (manifest) =>
        (treeOf(manifest).sha256 = "7".repeat(64)),
    };
    rejects(wrongTreeDigest, treeDigestInvalid);
    acceptsUnder(
      wrongTreeDigest,
      mutantFor(treeDigestComparison, "    false\n"),
    );
  }, 300_000);

  it("accepts a canonical final candidate manifest in a synthetic repository", () => {
    // POSITIVE CONTROL.  Until this is green the tampers that follow are
    // indistinguishable from what a reject-everything function produces, which
    // is the state the D-39 sweep reported for this gate.
    const repository = finalCandidateRepository();
    try {
      expect(() =>
        report.validateFinalCandidateManifest({
          repoRoot: repository.root,
          candidateSha: repository.candidateSha,
          repairProofSha: repository.repairProofSha,
        }),
      ).not.toThrow();
    } finally {
      repository.cleanup();
    }
  }, 60_000);
  it("rejects incomplete, duplicate, and extra manifest evidence", () => {
    const reference = report.loadReference();
    const complete = completeBenchmarkReport();
    const { comparisons, rawSchedule } = complete;
    expect(() => report.validateReport(complete)).not.toThrow();

    const diagnosticFixtureIds = [
      "metadata-still-1m",
      "metadata-still-16m",
      "animation-alpha-16m",
      "still-1m",
      "still-16m",
      "still-64m",
      "cancellation-64m",
    ] as const;
    expect(benchmark.DIAGNOSTIC_PROFILE_ID).toBe(
      "phase-46-performance-p95-diagnostic/v1",
    );
    expect(
      benchmark.parseArguments([
        "--baseline-tarball",
        "baseline.tgz",
        "--candidate-tarball",
        "candidate.tgz",
        "--profile",
        benchmark.DIAGNOSTIC_PROFILE_ID,
        "--mode",
        "report",
      ]),
    ).toMatchObject({
      profile: benchmark.DIAGNOSTIC_PROFILE_ID,
      fixture: undefined,
      mode: "report",
    });
    for (const arguments_ of [
      [
        "--baseline-tarball",
        "baseline.tgz",
        "--candidate-tarball",
        "candidate.tgz",
        "--profile",
        "caller-selected",
      ],
      [
        "--baseline-tarball",
        "baseline.tgz",
        "--candidate-tarball",
        "candidate.tgz",
        "--profile",
        benchmark.DIAGNOSTIC_PROFILE_ID,
        "--fixture",
        "still-1m",
      ],
      [
        "--baseline-tarball",
        "baseline.tgz",
        "--candidate-tarball",
        "candidate.tgz",
        "--profile",
        benchmark.DIAGNOSTIC_PROFILE_ID,
        "--mode",
        "admit",
      ],
    ])
      expect(() => benchmark.parseArguments(arguments_)).toThrow();

    const makeDiagnosticReport = (major: 22 | 24) => {
      const diagnostic = structuredClone(complete);
      const diagnosticReferenceMedian =
        reference.referenceMedianNs[String(major)];
      if (typeof diagnosticReferenceMedian !== "number")
        throw new Error("diagnostic Node major lacks a calibration reference");
      const diagnosticObservations = Array.from(
        { length: reference.observationCount },
        (_, index) => ({
          ordinal: index + 1,
          elapsedNs: diagnosticReferenceMedian * reference.workloadUnitCount,
          unitCount: reference.workloadUnitCount,
          normalizedNs: diagnosticReferenceMedian,
          resultDigest: calibration.workloadResultDigest(),
        }),
      );
      const diagnosticCalibration = {
        schemaVersion: 2,
        algorithmId: reference.algorithmId,
        nodeMajor: major,
        observations: diagnosticObservations,
        workloadDigest: calibration.workloadDigest(),
        process: { execPath: process.execPath, clean: true },
      };
      diagnostic.mode = "report";
      diagnostic.environment.nodeVersion = `v${major}.0.0`;
      diagnostic.calibration = {
        before: diagnosticCalibration,
        after: diagnosticCalibration,
        reference,
        derived: report.deriveRunScale({
          before: diagnosticObservations.map((item) => item.normalizedNs),
          after: diagnosticObservations.map((item) => item.normalizedNs),
          referenceMedianNs: diagnosticReferenceMedian,
        }),
      };
      diagnostic.rawSchedule = diagnosticFixtureIds
        .flatMap((fixtureId) =>
          diagnostic.rawSchedule.filter(
            (entry) => entry.fixtureId === fixtureId,
          ),
        )
        .map((entry, index) => ({
          ...entry,
          sample: {
            ...entry.sample,
            runToken: `${major === 22 ? "2" : "4"}${index
              .toString(16)
              .padStart(31, "0")}`,
            environment: { ...diagnostic.environment },
          },
        }));
      const retained = (fixtureId: string, version: string) =>
        diagnostic.rawSchedule
          .filter(
            (entry) =>
              entry.fixtureId === fixtureId &&
              entry.version === version &&
              !entry.warmup,
          )
          .map((entry) => ({
            ...entry.sample,
            scaledElapsedNs:
              entry.sample.elapsedNs * diagnostic.calibration.derived.runScale,
          }));
      diagnostic.comparisons = diagnosticFixtureIds
        .filter((fixtureId) => fixtureId !== "cancellation-64m")
        .map((fixtureId) =>
          diagnostic.comparisons.find(
            (comparison) => comparison.fixtureId === fixtureId,
          )!,
        )
        .map((comparison) => ({
          ...comparison,
          baseline: {
            ...comparison.baseline,
            samples: retained(String(comparison.fixtureId), "baseline"),
          },
          candidate: {
            ...comparison.candidate,
            samples: retained(String(comparison.fixtureId), "candidate"),
          },
        }));
      diagnostic.cancellation = {
        sample: diagnostic.rawSchedule.find(
          (entry) =>
            entry.fixtureId === "cancellation-64m" &&
            entry.version === "candidate" &&
            !entry.warmup,
        )!.sample.cancellation!,
        verdict: { pass: true, failures: [] },
      };
      diagnostic.failures = [];
      diagnostic.pass = true;
      return diagnostic;
    };
    const node22Diagnostic = makeDiagnosticReport(22);
    const node24Diagnostic = makeDiagnosticReport(24);
    expect(node22Diagnostic.rawSchedule).toHaveLength(1_428);
    expect(() =>
      report.validatePerformanceP95DiagnosticReport(node22Diagnostic),
    ).not.toThrow();
    expect(() => report.validateReport(node22Diagnostic)).toThrow();
    for (const mutate of [
      (value: typeof node22Diagnostic) => value.rawSchedule.pop(),
      (value: typeof node22Diagnostic) =>
        value.rawSchedule.splice(
          0,
          2,
          value.rawSchedule[1]!,
          value.rawSchedule[0]!,
        ),
      (value: typeof node22Diagnostic) => (value.measurements = 99),
      (value: typeof node22Diagnostic) => (value.warmups = 1),
      (value: typeof node22Diagnostic) =>
        (value.elapsedP95Estimator.method = "nearest-rank"),
      (value: typeof node22Diagnostic) => (value.thresholds.p95Ratio = 1.36),
      (value: typeof node22Diagnostic) => (value.collection.retries = 1),
      (value: typeof node22Diagnostic) =>
        (value.cancellation.verdict.pass = false),
      (value: typeof node22Diagnostic) =>
        (value.environment.runner = "substituted"),
      (value: typeof node22Diagnostic) =>
        (value.calibration.derived.runScale = 2),
    ]) {
      const mutation = structuredClone(node22Diagnostic);
      mutate(mutation);
      expect(() =>
        report.validatePerformanceP95DiagnosticReport(mutation),
      ).toThrow();
    }

    expect(
      report.classifyPerformanceP95DiagnosticFixture({
        observedP95Failure: true,
        positiveBlockCount: 1,
        positiveCandidateTailCount: 6,
      }),
    ).toBe("concentrated-tail");
    expect(
      report.classifyPerformanceP95DiagnosticFixture({
        observedP95Failure: true,
        positiveBlockCount: 9,
        positiveCandidateTailCount: 6,
      }),
    ).toBe("sustained-candidate");
    expect(
      report.classifyPerformanceP95DiagnosticFixture({
        observedP95Failure: true,
        positiveBlockCount: 5,
        positiveCandidateTailCount: 4,
      }),
    ).toBe("mixed");
    expect(
      report.classifyPerformanceP95DiagnosticFixture({
        observedP95Failure: false,
        positiveBlockCount: 0,
        positiveCandidateTailCount: 0,
      }),
    ).toBe("unknown");
    expect(
      ["concentrated-tail", "sustained-candidate", "mixed", "unknown"].map(
        (pattern) =>
          report.actionableBranchForPerformanceP95Diagnostic(
            pattern as
              "concentrated-tail" | "sustained-candidate" | "mixed" | "unknown",
          ),
      ),
    ).toEqual(["collector", "candidate-runtime", null, null]);

    const reportBytes = (value: unknown) =>
      `${JSON.stringify(value, null, 2)}\n`;
    const reportSha = (value: unknown) =>
      createHash("sha256").update(reportBytes(value)).digest("hex");
    const node22View =
      report.derivePerformanceP95DiagnosticView(node22Diagnostic);
    const node24View =
      report.derivePerformanceP95DiagnosticView(node24Diagnostic);
    const headSha = "a".repeat(40);
    const ledger = {
      schemaVersion: "phase-46-performance-p95-diagnostic-ledger/v1",
      diagnosticOnly: true,
      run: {
        repository: "szTheory/exifcleaner-node",
        workflow: ".github/workflows/ci.yml",
        event: "workflow_dispatch",
        attempt: 1,
        id: 123456789,
        url: "https://github.com/szTheory/exifcleaner-node/actions/runs/123456789",
        ref: `refs/heads/diagnostic/46-p95-${headSha.slice(0, 7)}`,
        headSha,
      },
      packages: {
        baseline: {
          name: "exifcleaner-node",
          version: "0.1.1",
          expectedIdentity: `exifcleaner-node@0.1.1#sha256:${benchmark.BASELINE_TARBALL_SHA256}`,
          sha256: benchmark.BASELINE_TARBALL_SHA256,
        },
        candidate: { sha256: "3".repeat(64) },
      },
      artifacts: {
        node22: {
          job: { name: "diagnostic (22)", conclusion: "success" },
          artifact: {
            name: "performance-p95-diagnostic-node-22",
            sha256: "5".repeat(64),
          },
          report: {
            file: "qualification-benchmark-node-22.json",
            sha256: reportSha(node22Diagnostic),
          },
          summary: {
            file: "qualification-benchmark-node-22.json.md",
            sha256: "6".repeat(64),
          },
        },
        node24: {
          job: { name: "diagnostic (24)", conclusion: "success" },
          artifact: {
            name: "performance-p95-diagnostic-node-24",
            sha256: "7".repeat(64),
          },
          report: {
            file: "qualification-benchmark-node-24.json",
            sha256: reportSha(node24Diagnostic),
          },
          summary: {
            file: "qualification-benchmark-node-24.json.md",
            sha256: "8".repeat(64),
          },
        },
        envelope: {
          name: "performance-p95-diagnostic-envelope",
          sha256: "9".repeat(64),
        },
      },
      reports: { node22: node22Diagnostic, node24: node24Diagnostic },
      derived: { node22: node22View, node24: node24View },
      pattern: "unknown",
      actionableBranch: null,
    };
    expect(() =>
      report.validatePerformanceP95DiagnosticLedger(ledger),
    ).not.toThrow();
    for (const mutate of [
      (value: typeof ledger) => (value.diagnosticOnly = false),
      (value: typeof ledger) => (value.run.attempt = 2),
      (value: typeof ledger) => (value.run.event = "push"),
      (value: typeof ledger) =>
        (value.run.workflow = ".github/workflows/performance-diagnostic.yml"),
      (value: typeof ledger) => (value.run.headSha = "b".repeat(40)),
      (value: typeof ledger) =>
        (value.run.ref = "refs/heads/diagnostic/46-p95-substitute"),
      (value: typeof ledger) =>
        (value.reports.node24.candidateSha256 = "4".repeat(64)),
      (value: typeof ledger) =>
        (value.artifacts.node22.report.sha256 = "0".repeat(64)),
      (value: typeof ledger) =>
        (value.derived.node22 = structuredClone(value.derived.node24)),
      (value: typeof ledger) => (value.pattern = "concentrated-tail"),
      (value: typeof ledger) =>
        (value.actionableBranch = "collector" as unknown as null),
      (value: typeof ledger) => Object.assign(value, { admission: false }),
      (value: typeof ledger) =>
        Object.assign(value.artifacts.node22, { retry: 0 }),
    ]) {
      const mutation = structuredClone(ledger);
      mutate(mutation);
      expect(() =>
        report.validatePerformanceP95DiagnosticLedger(mutation),
      ).toThrow();
    }
    for (const incomplete of [
      { ...complete, comparisons: [], rawSchedule: [] },
      { ...complete, comparisons: comparisons.slice(1) },
      { ...complete, comparisons: [...comparisons, comparisons[0]] },
      { ...complete, rawSchedule: rawSchedule.slice(1) },
      { ...complete, rawSchedule: [...rawSchedule, rawSchedule[0]] },
      { ...complete, cancellation: undefined },
    ])
      expect(() => report.validateReport(incomplete)).toThrow();
    const rawSubstitution = structuredClone(complete);
    rawSubstitution.rawSchedule[0]!.sample.fixtureId = "still-1m";
    expect(() => report.validateReport(rawSubstitution)).toThrow();
    const rawRecordExtraField = structuredClone(complete);
    Object.assign(rawRecordExtraField.rawSchedule[0]!, { forged: true });
    expect(() => report.validateReport(rawRecordExtraField)).toThrow(
      "raw schedule record fields are not exact",
    );
    const comparisonSubstitution = structuredClone(complete);
    comparisonSubstitution.comparisons[0]!.baseline.samples[0] = {
      ...comparisonSubstitution.comparisons[0]!.baseline.samples[0]!,
      runToken: "f".repeat(32),
    };
    expect(() => report.validateReport(comparisonSubstitution)).toThrow();
    for (const mutate of [
      (mutated: typeof complete) =>
        delete (mutated as Partial<typeof complete>).elapsedP95Estimator,
      (mutated: typeof complete) =>
        Object.assign(mutated.elapsedP95Estimator, { unexpected: true }),
      (mutated: typeof complete) =>
        (mutated.elapsedP95Estimator.method = "nearest-rank"),
      (mutated: typeof complete) =>
        (mutated.elapsedP95Estimator.interpolation = "nearest-rank"),
      (mutated: typeof complete) =>
        (mutated.elapsedP95Estimator.quantile = "0.95" as unknown as number),
      (mutated: typeof complete) =>
        (mutated.elapsedP95Estimator.retainedObservations = 15),
      (mutated: typeof complete) =>
        (mutated.elapsedP95Estimator.retainedObservations = 99),
      (mutated: typeof complete) =>
        (mutated.elapsedP95Estimator.retainedObservations = 101),
      (mutated: typeof complete) => (mutated.version = 3),
      (mutated: typeof complete) => (mutated.measurements = 15),
      (mutated: typeof complete) => (mutated.measurements = 99),
      (mutated: typeof complete) => (mutated.measurements = 101),
      (mutated: typeof complete) => (mutated.collection.retries = 1),
      (mutated: typeof complete) => (mutated.collection.discarded = 1),
      (mutated: typeof complete) =>
        mutated.comparisons[0]!.baseline.samples.pop(),
      (mutated: typeof complete) =>
        (mutated.comparisons[0]!.baseline.samples[0]!.scaledElapsedNs = 2),
      (mutated: typeof complete) =>
        (mutated.comparisons[0]!.baseline.p95ElapsedNs = 2),
    ]) {
      const mutated = structuredClone(complete);
      mutate(mutated);
      expect(() => report.validateReport(mutated)).toThrow();
    }
    for (const mutate of [
      (mutated: typeof complete) => mutated.rawSchedule.pop(),
      (mutated: typeof complete) =>
        mutated.rawSchedule.push(mutated.rawSchedule[0]!),
      (mutated: typeof complete) =>
        mutated.rawSchedule.splice(
          0,
          2,
          mutated.rawSchedule[1]!,
          mutated.rawSchedule[0]!,
        ),
    ]) {
      const mutated = structuredClone(complete);
      mutate(mutated);
      expect(() => report.validateReport(mutated)).toThrow();
    }
    for (const [field, value] of [
      ["outputSha256", "f".repeat(64)],
      ["status", "refused"],
      ["code", "different-error"],
      ["finalization", "arbitrary-residue"],
      ["finalizationTruthful", false],
    ] as const) {
      const preservedKey = structuredClone(complete);
      (preservedKey.rawSchedule[0]!.sample as Record<string, unknown>)[field] =
        value;
      expect(() => report.validateReport(preservedKey)).toThrow();
    }
    const finalizationMutation = structuredClone(complete);
    finalizationMutation.rawSchedule[0]!.sample.finalization =
      "arbitrary-residue";
    finalizationMutation.rawSchedule[0]!.sample.correctnessKey =
      report.deriveCorrectnessKey(finalizationMutation.rawSchedule[0]!.sample);
    expect(() => report.validateReport(finalizationMutation)).toThrow();
    for (const mutate of [
      (mutated: typeof complete) => (mutated.pass = false),
      (mutated: typeof complete) => (mutated.failures = ["forged failure"]),
      (mutated: typeof complete) =>
        (mutated.comparisons[0]!.verdict.pass = false),
      (mutated: typeof complete) =>
        (mutated.comparisons[0]!.candidate.samples[0]!.maxRSSKiB = 1 + 16_385),
      (mutated: typeof complete) =>
        Object.assign(mutated, { unexpected: true }),
    ]) {
      const mutated = structuredClone(complete);
      mutate(mutated);
      expect(() => report.validateReport(mutated)).toThrow();
    }
  }, 20_000);

  evidenceGatedIt(
    "validateP95NullBranchClosure accepts only a null-branch closure bound to the real sealed ledger and rejects any overclaim or identity mismatch",
    async () => {
      // The real sealed ledger is ~14 MB; each mutation case re-validates it in
      // full via validatePerformanceP95DiagnosticLedger (~0.5s), so 18 calls
      // exceed the default 5s test timeout.
      const ledgerPath = join(
        phase46EvidenceDirectory,
        "46-PERFORMANCE-P95-DIAGNOSTIC.json",
      );
      const ledgerBytes = await readFile(ledgerPath, "utf8");
      const ledger = JSON.parse(ledgerBytes) as Record<string, unknown> & {
        pattern: string;
        actionableBranch: string | null;
      };
      expect(ledger.actionableBranch).toBeNull();
      const ledgerSha256 = createHash("sha256")
        .update(`${JSON.stringify(ledger, null, 2)}\n`)
        .digest("hex");
      const sourceTipHeadSha = "1a7cd0a6f0a2a5da0a259652dc24318db689f02e";
      const closure = {
        schemaVersion: "phase-46-p95-null-branch-closure/v1",
        diagnosticOnly: true,
        ledger: {
          file: "46-PERFORMANCE-P95-DIAGNOSTIC.json",
          sha256: ledgerSha256,
        },
        pattern: ledger.pattern,
        actionableBranch: null,
        sourceTip: { headSha: sourceTipHeadSha },
        claim: {
          established:
            "Run 35014506364 (Node 22 and Node 24) recorded report.pass === true on both Node majors; every fixture, including the three that failed p95 in run 33223033591, returned attribution of control or unknown.",
          notEstablished:
            "This one clean run does not establish that the earlier tail failures were noise, flaky, or environmental; no such causal claim is made.",
        },
        nextGate: {
          owner: "46-26",
          authority:
            "Plan 46-26's whole exact-six admission run re-measures p95 independently under unchanged schema-v4/Type-7/100-sample/D-23 rigor; that run's own benchmark gate is the deciding WEBP-06 evidence for this cycle, not this diagnostic or this closure.",
          onFailure:
            "If the admission run's p95 gate rejects any fixture, admission halts again; no blind retry or threshold change is authorized, and a new diagnostic-only run (Plan-46-32-shaped) is required before any further repair or dispatch attempt.",
        },
      };
      expect(() =>
        report.validateP95NullBranchClosure(closure, ledger),
      ).not.toThrow();

      const nonNullLedger = structuredClone(ledger);
      nonNullLedger.actionableBranch = "collector";
      nonNullLedger.pattern = "concentrated-tail";
      expect(() =>
        report.validateP95NullBranchClosure(closure, nonNullLedger),
      ).toThrow();

      for (const mutate of [
        (value: typeof closure) =>
          (value.actionableBranch = "collector" as unknown as null),
        (value: typeof closure) => (value.ledger.sha256 = "0".repeat(64)),
        (value: typeof closure) => (value.ledger.file = "wrong-file.json"),
        (value: typeof closure) => (value.sourceTip.headSha = "b".repeat(40)),
        (value: typeof closure) =>
          (value.pattern = value.pattern === "unknown" ? "mixed" : "unknown"),
        (value: typeof closure) => Object.assign(value, { unexpected: true }),
        (value: typeof closure) =>
          (value.claim.notEstablished =
            "one clean run settles nothing further"),
        (value: typeof closure) => (value.nextGate.owner = "46-99"),
        (value: typeof closure) =>
          (value.nextGate.onFailure = "investigate further"),
        (value: typeof closure) =>
          (value.claim.established = `${value.claim.established} This was flaky.`),
        (value: typeof closure) =>
          (value.claim.established = `${value.claim.established} likely noise.`),
        (value: typeof closure) =>
          (value.claim.established = `${value.claim.established} environmental factors.`),
        (value: typeof closure) =>
          (value.claim.established = `${value.claim.established} a transient blip.`),
        (value: typeof closure) =>
          (value.claim.established = `${value.claim.established} confirmed clean.`),
        (value: typeof closure) =>
          (value.claim.established = `${value.claim.established} proven safe.`),
        (value: typeof closure) =>
          (value.claim.established = `${value.claim.established} a non-issue.`),
      ]) {
        const mutation = structuredClone(closure);
        mutate(mutation);
        expect(() =>
          report.validateP95NullBranchClosure(mutation, ledger),
        ).toThrow();
      }
    },
    30_000,
  );

  it("binds every installed finalization and cancellation contract field on Windows", () => {
    const candidate = {
      tarballSha256: "3".repeat(64),
      corpusManifestSha256: "4".repeat(64),
    };
    const windowsPublication = {
      primitive: "CreateHardLinkW",
      linkCalls: 1,
      destinationParentIdentityRechecked: true,
      stageIdentityRechecked: true,
      stageFileIdentityRechecked: true,
      destinationParent: {
        volumeSerialNumber: "0000000000000000",
        fileId: "a".repeat(32),
      },
      stageDirectory: {
        volumeSerialNumber: "0000000000000000",
        fileId: "b".repeat(32),
      },
      stageFile: {
        volumeSerialNumber: "0000000000000000",
        fileId: "c".repeat(32),
      },
      destinationFile: {
        volumeSerialNumber: "0000000000000000",
        fileId: "c".repeat(32),
      },
    };
    for (const nodeMajor of [22, 24]) {
      for (const tuple of ["win32-x64", "win32-arm64"]) {
        const installed = {
          evidenceScope: "final-matching-host",
          hostTuple: tuple,
          nodeVersion: `v${nodeMajor}.0.0`,
          tarball: {
            file: "exifcleaner-node-0.1.1.tgz",
            sha256: candidate.tarballSha256,
          },
          manifestSha256: candidate.corpusManifestSha256,
          propertySeed: 460_046,
          propertyRuns: 25,
          propertyOutputDigest: "5".repeat(64),
          corpusCases: [
            {
              id: "exifcleaner-sample",
              magicAdmission: true,
              sourceSha256:
                "16d1cad79550c1e13f7710032f9bb41f5c36e49d0debe65761f7ee4c333360cd",
              outputSha256:
                "a8e1378cd74e08b2553bf313f676885cc7a6d590cfe79ca1b5f9d49215b5efa3",
              payloadDigests: [
                {
                  fourCc: "VP8 ",
                  occurrence: 0,
                  sha256:
                    "1300ec4f408f0960b09a5265851b14e81ac0c120fae6c3d555306df849235697",
                },
              ],
              removedNamespaces: ["EXIF"],
              finalization: "none",
            },
            {
              id: "derived-two-frame-animation",
              magicAdmission: true,
              sourceSha256:
                "eb201feb6be2ed982cb48ccd3ec36f11e799a0ae9b4f2873af4898844c601f80",
              outputSha256:
                "eb201feb6be2ed982cb48ccd3ec36f11e799a0ae9b4f2873af4898844c601f80",
              payloadDigests: [
                {
                  fourCc: "ANIM",
                  occurrence: 0,
                  sha256:
                    "ba3e4486d8c5bc4009da061168a88d776a1849bbc2596b474c9b05a9ff44a6c6",
                },
                {
                  fourCc: "ANMF",
                  occurrence: 0,
                  sha256:
                    "144759bea1ad5db4c4b1e20e4ffcbadd92ae4737d0559b28e5107871e3d89f96",
                },
                {
                  fourCc: "ANMF",
                  occurrence: 1,
                  sha256:
                    "a94c038e055c40ccc62f47ef3c6915fec89258e04d5fb7f5261920601dddef90",
                },
              ],
              removedNamespaces: [],
              finalization: "none",
            },
          ],
          install: {
            command: "npm install --ignore-scripts",
            arguments: [
              "--ignore-scripts",
              "--no-audit",
              "--no-fund",
              "<admitted-tarball>",
            ],
          },
          selectedArtifact: `prebuilds/${tuple}/publication.node`,
          cases: {
            sourcePreserved: true,
            published: true,
            collisionPreserved: true,
            cancellation: {
              code: "aborted",
              nativeWrite: "started",
              fallback: "do-not-fallback",
              finalization: "owned-partial-remains",
              residue: {
                stageDirectoryExists: true,
                stageFileExists: true,
              },
              cleanup: {
                schemaVersion: "phase-46-terminal-cleanup/v2",
                abiVersion: "native-publication/v2",
                platform: "win32",
                ownership: {
                  helperToken: "6".repeat(64),
                  captureOwnershipToken: "6".repeat(64),
                  terminalOwnershipToken: "6".repeat(64),
                  captureCapabilityId: "7".repeat(64),
                  terminalCapabilityId: "7".repeat(64),
                },
                capture: {
                  result: "captured",
                  directoryIdentity: {
                    volumeSerialNumber: "0000000000000000",
                    fileId: "d".repeat(32),
                  },
                  fileIdentity: {
                    volumeSerialNumber: "0000000000000000",
                    fileId: "e".repeat(32),
                  },
                },
                helper: {
                  ownershipToken: "6".repeat(64),
                  quiescenceSequence: 1,
                  terminalSequence: 4,
                },
                terminal: {
                  identityBefore: {
                    volumeSerialNumber: "0000000000000000",
                    fileId: "e".repeat(32),
                  },
                  removalIdentity: {
                    volumeSerialNumber: "0000000000000000",
                    fileId: "f".repeat(32),
                  },
                  outcome: "replacement-retained",
                  consumeCount: 1,
                  replayCount: 1,
                  replayOutcome: "no-action",
                },
                replacement: {
                  observationSequence: 2,
                  injectionSequence: 3,
                  identityBefore: {
                    volumeSerialNumber: "0000000000000000",
                    fileId: "f".repeat(32),
                  },
                  sha256Before: "8".repeat(64),
                  identityAfter: {
                    volumeSerialNumber: "0000000000000000",
                    fileId: "f".repeat(32),
                  },
                  sha256After: "8".repeat(64),
                },
                nativeLifetime: {
                  handlesBefore: 2,
                  handlesAfter: 2,
                  finalizersBefore: 0,
                  finalizersAfter: 1,
                },
              },
            },
            postCommitResidue: "none",
            collisionFinalization: "owned-partial-removed",
          },
          windowsPublication,
        };
        expect(() =>
          report.validateInstalledReport(
            installed,
            tuple,
            nodeMajor,
            candidate,
          ),
        ).not.toThrow();
        // The corpus epoch is exact in both directions: live evidence (the
        // default) rejects the archived pre-KIT-08 sample output, a Phase 46
        // replay rejects the current one, and an unknown epoch is refused.
        const sampleCase = installed.corpusCases.find(
          (corpusCase) => corpusCase.id === "exifcleaner-sample",
        )!;
        const withPhase46Sample = structuredClone(installed);
        withPhase46Sample.corpusCases.find(
          (corpusCase) => corpusCase.id === "exifcleaner-sample",
        )!.outputSha256 =
          "a412e742b59ef1161af1410dd98b86c91acf85827a5f671d5f91712a4a282e1f";
        expect(sampleCase.outputSha256).not.toBe(
          withPhase46Sample.corpusCases.find(
            (corpusCase) => corpusCase.id === "exifcleaner-sample",
          )!.outputSha256,
        );
        expect(() =>
          report.validateInstalledReport(
            withPhase46Sample,
            tuple,
            nodeMajor,
            candidate,
          ),
        ).toThrow(anchoredMessage("installed corpus case is invalid"));
        expect(() =>
          report.validateInstalledReport(
            withPhase46Sample,
            tuple,
            nodeMajor,
            candidate,
            PHASE_46_CORPUS_EPOCH,
          ),
        ).not.toThrow();
        expect(() =>
          report.validateInstalledReport(
            installed,
            tuple,
            nodeMajor,
            candidate,
            PHASE_46_CORPUS_EPOCH,
          ),
        ).toThrow(anchoredMessage("installed corpus case is invalid"));
        expect(() =>
          report.validateInstalledReport(
            installed,
            tuple,
            nodeMajor,
            candidate,
            "unknown" as CorpusEpoch,
          ),
        ).toThrow(anchoredMessage("installed corpus epoch is invalid"));
        const mutations: readonly ((mutated: typeof installed) => void)[] = [
          (mutated) => delete (mutated as Partial<typeof installed>).install,
          (mutated) =>
            delete (mutated as Partial<typeof installed>).propertySeed,
          (mutated) =>
            delete (mutated as Partial<typeof installed>).propertyRuns,
          (mutated) =>
            delete (mutated as Partial<typeof installed>).propertyOutputDigest,
          (mutated) =>
            delete (mutated as Partial<typeof installed>).corpusCases,
          (mutated) => delete (mutated as Partial<typeof installed>).tarball,
          (mutated) => Object.assign(mutated, { unexpected: "extra-field" }),
          (mutated) =>
            Object.assign(mutated.tarball, { unexpected: "extra-field" }),
          (mutated) => (mutated.install.arguments[0] = "--foreground-scripts"),
          (mutated) => (mutated.propertySeed = 1),
          (mutated) => (mutated.propertyRuns = 24),
          (mutated) => (mutated.propertyOutputDigest = "invalid"),
          (mutated) => (mutated.corpusCases[0]!.sourceSha256 = "invalid"),
          (mutated) => (mutated.corpusCases[0]!.id = "different-case"),
          (mutated) =>
            Object.assign(mutated.corpusCases[0]!, {
              unexpected: "extra-field",
            }),
          (mutated) => (mutated.cases.sourcePreserved = false),
          (mutated) => (mutated.cases.published = false),
          (mutated) => (mutated.cases.collisionPreserved = false),
          (mutated) => (mutated.cases.cancellation.code = "refused"),
          (mutated) => (mutated.cases.cancellation.nativeWrite = "not-started"),
          (mutated) => (mutated.cases.cancellation.fallback = "fallback"),
          (mutated) => (mutated.cases.cancellation.finalization = "none"),
          (mutated) =>
            (mutated.cases.cancellation.residue.stageDirectoryExists = false),
          (mutated) =>
            (mutated.cases.cancellation.residue.stageFileExists = false),
          (mutated) =>
            (mutated.cases.postCommitResidue =
              "private-empty-stage-directory-remains"),
          (mutated) => (mutated.cases.collisionFinalization = "none"),
          (mutated) =>
            Object.assign(mutated.cases, { unexpected: "extra-field" }),
          (mutated) =>
            Object.assign(mutated.cases.cancellation, {
              unexpected: "extra-field",
            }),
          (mutated) =>
            Object.assign(mutated.windowsPublication, {
              unexpected: "extra-field",
            }),
          (mutated) =>
            Object.assign(mutated.windowsPublication.stageFile, {
              unexpected: "extra-field",
            }),
          ...["00000000", 1, "A".repeat(16), "0".repeat(17)].map(
            (serial) => (mutated: typeof installed) => {
              mutated.windowsPublication.destinationParent.volumeSerialNumber =
                serial as string;
            },
          ),
          ...["a".repeat(31), "A".repeat(32), 1].map(
            (fileId) => (mutated: typeof installed) => {
              mutated.windowsPublication.stageFile.fileId = fileId as string;
            },
          ),
        ];
        for (const mutate of mutations) {
          const mutated = structuredClone(installed);
          mutate(mutated);
          expect(() =>
            report.validateInstalledReport(
              mutated,
              tuple,
              nodeMajor,
              candidate,
            ),
          ).toThrow();
        }
      }
    }
  });

  it("keeps cancellation retention independent from platform collision finalization", () => {
    const ledger = identityCleanupLedger();
    expect(() => report.validateIdentityCleanupLedger(ledger)).not.toThrow();

    for (const tuple of installedTuples) {
      for (const nodeMajor of [22, 24] as const) {
        const installed = installedReport(tuple, nodeMajor);
        expect(() =>
          report.validateInstalledReport(
            installed,
            tuple,
            nodeMajor,
            installedCandidate,
          ),
        ).not.toThrow();

        const mutations = [
          (mutated: ReturnType<typeof installedReport>) => {
            mutated.cases.cancellation.finalization = "owned-partial-removed";
          },
          (mutated: ReturnType<typeof installedReport>) => {
            mutated.cases.cancellation.residue.stageDirectoryExists = false;
          },
          (mutated: ReturnType<typeof installedReport>) => {
            mutated.cases.cancellation.residue.stageFileExists = false;
          },
          (mutated: ReturnType<typeof installedReport>) => {
            mutated.cases.collisionFinalization = tuple.startsWith("win32")
              ? "owned-partial-remains"
              : "owned-partial-removed";
          },
        ];
        for (const mutate of mutations) {
          const mutated = structuredClone(installed);
          mutate(mutated);
          expect(() =>
            report.validateInstalledReport(
              mutated,
              tuple,
              nodeMajor,
              installedCandidate,
            ),
          ).toThrow("installed report contract is invalid");
        }
      }
    }
  });

  it("kills fresh validator mutants that recouple or weaken installed authorities", async () => {
    const source = await readFile(
      join(projectRoot, "scripts", "qualification", "benchmark-report.cjs"),
      "utf8",
    );
    const directOrder = [
      "win32-x64",
      "win32-arm64",
      "linux-x64",
      "linux-arm64",
      "darwin-x64",
      "darwin-arm64",
    ] as const;
    const assertInstalledAuthority = (validator: {
      validateIdentityCleanupLedger(input: Record<string, unknown>): void;
      validateInstalledReport(
        input: Record<string, unknown>,
        tuple: string,
        nodeMajor: number,
        candidate: Record<string, unknown>,
      ): void;
    }): void => {
      validator.validateIdentityCleanupLedger(identityCleanupLedger());
      for (const tuple of directOrder) {
        for (const nodeMajor of [22, 24] as const)
          validator.validateInstalledReport(
            installedReport(tuple, nodeMajor),
            tuple,
            nodeMajor,
            installedCandidate,
          );
      }

      const negativeCases = [
        (mutated: ReturnType<typeof installedReport>) => {
          mutated.cases.cancellation.residue.stageDirectoryExists = false;
        },
        (mutated: ReturnType<typeof installedReport>) => {
          mutated.cases.cancellation.residue.stageFileExists = false;
        },
      ];
      for (const mutate of negativeCases) {
        const mutated = installedReport("win32-x64", 22);
        mutate(mutated);
        try {
          validator.validateInstalledReport(
            mutated,
            "win32-x64",
            22,
            installedCandidate,
          );
        } catch {
          continue;
        }
        throw new Error("weakened cancellation residue was admitted");
      }
    };

    expect(() =>
      assertInstalledAuthority(loadIdentityLedgerValidator(source)),
    ).not.toThrow();

    const mutations = [
      source.replace(
        'const expectedCancellationFinalization = "owned-partial-remains";',
        'const expectedCancellationFinalization = "owned-partial-removed";',
      ),
      source.replace(
        "report.cases.cancellation.residue.stageDirectoryExists !==\n      expectedCancellationResidue ||",
        "false ||",
      ),
      source.replace(
        "report.cases.cancellation.residue.stageFileExists !==\n      expectedCancellationResidue ||",
        "false ||",
      ),
      source.replace(
        'const expectedCollisionFinalization = windows\n    ? "owned-partial-removed"\n    : "owned-partial-remains";',
        "const expectedCollisionFinalization = expectedCancellationFinalization;",
      ),
      source.replace(
        'const expectedCollisionFinalization = windows\n    ? "owned-partial-removed"\n    : "owned-partial-remains";',
        'const expectedCollisionFinalization = "owned-partial-removed";',
      ),
    ];
    for (const mutation of mutations) {
      expect(mutation).not.toBe(source);
      expect(() =>
        assertInstalledAuthority(loadIdentityLedgerValidator(mutation)),
      ).toThrow();
    }
  });

  it("uses the fixed v2 robust block estimator at every threshold in both drift directions", () => {
    const nextUp = (value: number): number => {
      const bytes = new ArrayBuffer(8);
      const view = new DataView(bytes);
      view.setFloat64(0, value);
      view.setBigUint64(0, view.getBigUint64(0) + 1n);
      return view.getFloat64(0);
    };
    const stable = Array<number>(15).fill(100);
    const clustered = [
      100, 100, 100, 100, 100, 100, 100, 100, 110, 110, 110, 110, 110, 110, 110,
    ];
    expect(report.deriveBlockEstimate(clustered)).toMatchObject({
      medianNs: 100,
      madRatio: 0,
      centralRangeRatio: 1.1,
    });
    const madBoundary = [
      90, 90, 90, 90, 90, 90, 90, 100, 110, 110, 110, 110, 110, 110, 110,
    ];
    expect(report.deriveBlockEstimate(madBoundary).madRatio).toBe(0.1);
    expect(
      report.deriveBlockEstimate([
        ...Array<number>(7).fill(89.999999),
        100,
        ...Array<number>(7).fill(110.000001),
      ]).madRatio,
    ).toBeGreaterThan(0.1);
    const rangeBoundary = [
      100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 120, 120, 120, 120,
    ];
    expect(report.deriveBlockEstimate(rangeBoundary).centralRangeRatio).toBe(
      1.2,
    );
    expect(
      report.deriveBlockEstimate([
        ...Array<number>(11).fill(100),
        ...Array<number>(4).fill(120.000001),
      ]).centralRangeRatio,
    ).toBeGreaterThan(1.2);
    const driftDirections: readonly (readonly [number[], number[]])[] = [
      [Array<number>(15).fill(110), stable],
      [stable, Array<number>(15).fill(110)],
    ];
    for (const [before, after] of driftDirections) {
      expect(() =>
        report.deriveRunScale({ before, after, referenceMedianNs: 100 }),
      ).not.toThrow();
      const above = Array<number>(15).fill(110.000001);
      expect(() =>
        report.deriveRunScale({
          before: before[0] === 110 ? above : before,
          after: after[0] === 110 ? above : after,
          referenceMedianNs: 100,
        }),
      ).toThrow(/drift/);
    }
  });

  it("uses one common calibration scale that cancels a global runner factor", () => {
    const referenceMedianNs = 100;
    const normal = report.deriveRunScale({
      before: Array<number>(15).fill(100),
      after: Array<number>(15).fill(100),
      referenceMedianNs,
    });
    const slowerRunner = report.deriveRunScale({
      before: Array<number>(15).fill(200),
      after: Array<number>(15).fill(200),
      referenceMedianNs,
    });
    expect(100 * normal.runScale).toBe(200 * slowerRunner.runScale);
    expect(120 * normal.runScale).toBe(240 * slowerRunner.runScale);
  });

  it("uses the exact D-23 Math.max boundaries and rejects one nanosecond over", () => {
    const factor = report.evaluateTiming({
      baselineMedianNs: 100_000_000,
      candidateMedianNs: 120_000_000,
      baselineP95Ns: 100_000_000,
      candidateP95Ns: 135_000_000,
    });
    expect(factor).toMatchObject({
      pass: true,
      medianLimitNs: 120_000_000,
      p95LimitNs: 135_000_000,
    });
    expect(
      report.evaluateTiming({
        baselineMedianNs: 100_000_000,
        candidateMedianNs: 120_000_001,
        baselineP95Ns: 100_000_000,
        candidateP95Ns: 135_000_000,
      }).pass,
    ).toBe(false);
    const slack = report.evaluateTiming({
      baselineMedianNs: 10_000_000,
      candidateMedianNs: 25_000_000,
      baselineP95Ns: 10_000_000,
      candidateP95Ns: 40_000_000,
    });
    expect(slack).toMatchObject({
      pass: true,
      medianLimitNs: 25_000_000,
      p95LimitNs: 40_000_000,
    });
    expect(
      report.evaluateTiming({
        baselineMedianNs: 10_000_000,
        candidateMedianNs: 25_000_001,
        baselineP95Ns: 10_000_000,
        candidateP95Ns: 40_000_000,
      }).pass,
    ).toBe(false);
  });

  it("fails closed for calibration drift, side-specific fields, and malformed authority output", () => {
    const authority = {
      schemaVersion: 2,
      algorithmId: "exifcleaner-run-calibration-v2",
      nodeMajor: Number(process.versions.node.split(".")[0]),
      observations: Array.from({ length: 15 }, (_, index) => ({
        ordinal: index + 1,
        elapsedNs: 1600,
        unitCount: 16,
        normalizedNs: 100,
        resultDigest:
          "1fb16f4fce034ffb35f65fb1a99037506fb35ead6fb81232c2a6243c83940dbb",
      })),
      workloadDigest: calibration.workloadDigest(),
      process: { execPath: process.execPath, clean: true },
    };
    expect(() => report.validateCalibration(authority)).not.toThrow();
    expect(() =>
      report.validateCalibration({ ...authority, candidateCalibration: 1 }),
    ).toThrow();
    expect(() =>
      report.validateCalibration({ ...authority, observations: [] }),
    ).toThrow();
    expect(() =>
      report.deriveRunScale({
        before: Array<number>(15).fill(100),
        after: Array<number>(15).fill(111),
        referenceMedianNs: 100,
      }),
    ).toThrow();
  });
  it("alternates baseline/candidate in fresh-child order with locked 2/100 counts", () => {
    const schedule = benchmark.buildSchedule(["still-64k"]);
    expect(schedule).toHaveLength(204);
    expect(schedule.filter((item) => item.warmup)).toHaveLength(4);
    expect(schedule.filter((item) => !item.warmup)).toHaveLength(200);
    expect(
      schedule.filter((item) => !item.warmup && item.version === "baseline"),
    ).toHaveLength(100);
    expect(
      schedule.filter((item) => !item.warmup && item.version === "candidate"),
    ).toHaveLength(100);
    expect(schedule.slice(0, 8).map((item) => item.version)).toEqual([
      "baseline",
      "candidate",
      "candidate",
      "baseline",
      "baseline",
      "candidate",
      "candidate",
      "baseline",
    ]);
  });

  it("calculates locked nearest-rank percentiles", () => {
    expect(benchmark.percentile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(benchmark.percentile([5, 1, 4, 2, 3], 0.95)).toBe(5);
  });

  it("uses independent Type 7 elapsed p95 at n=100 without changing nearest-rank authorities", () => {
    const unsorted = Array.from({ length: 100 }, (_, index) =>
      index % 2 === 0 ? 100 - index / 2 : (index + 1) / 2,
    );
    const original = [...unsorted];
    expect(benchmark.performanceP95(unsorted)).toBeCloseTo(95.05, 12);
    expect(report.performanceP95(unsorted)).toBeCloseTo(95.05, 12);
    expect(unsorted).toEqual(original);
    expect(benchmark.percentile(unsorted, 0.95)).toBe(95);
    const calibrationBlock = [
      15, 1, 14, 2, 13, 3, 12, 4, 11, 5, 10, 6, 9, 7, 8,
    ];
    expect(report.deriveBlockEstimate(calibrationBlock)).toMatchObject({
      medianNs: 8,
      madNs: 4,
    });
    expect(
      benchmark.percentile(
        [
          115, 101, 114, 102, 113, 103, 112, 104, 111, 105, 110, 106, 109, 107,
          108,
        ],
        0.5,
      ),
    ).toBe(108);

    for (const invalid of [
      [],
      Array<number>(100).fill(0),
      [...Array<number>(99).fill(1), Number.NaN],
      [...Array<number>(99).fill(1), Number.POSITIVE_INFINITY],
      Array<number>(15).fill(1),
      Array<number>(99).fill(1),
      Array<number>(101).fill(1),
    ]) {
      expect(() => benchmark.performanceP95(invalid)).toThrow();
      expect(() => report.performanceP95(invalid)).toThrow();
    }
  });

  it("still rejects a 100-sample Type 7 tail above the unchanged D-23 limit", () => {
    const baseline = Array<number>(100).fill(100_000_000);
    const candidate = [
      ...Array<number>(94).fill(100_000_000),
      ...Array<number>(6).fill(135_000_001),
    ];
    const baselineP95Ns = benchmark.performanceP95(baseline);
    const candidateP95Ns = benchmark.performanceP95(candidate);
    expect(candidateP95Ns).toBe(135_000_001);
    expect(
      report.evaluateTiming({
        baselineMedianNs: 100_000_000,
        candidateMedianNs: 100_000_000,
        baselineP95Ns,
        candidateP95Ns,
      }),
    ).toMatchObject({
      pass: false,
      p95LimitNs: 135_000_000,
      failures: ["p95 threshold exceeded"],
    });
  });

  it("calculates byte-per-byte RSS slope after the locked 4 MiB tolerance", () => {
    const mib = 1024 * 1024;
    const slope = benchmark.rssSlope(
      new Map([
        ["still-1m", { medianMaxRSSKiB: (100 * mib) / 1024 }],
        ["still-16m", { medianMaxRSSKiB: (105 * mib) / 1024 }],
        ["still-64m", { medianMaxRSSKiB: (110 * mib) / 1024 }],
      ]),
      "still",
    );
    expect(slope).toBe((6 * mib) / (63 * mib));
  });

  it("passes exact performance boundaries and fails one-unit exceedance", () => {
    expect(benchmark.BENCHMARK_THRESHOLDS).toEqual({
      medianRatio: 1.2,
      medianSlackNs: 15_000_000,
      p95Ratio: 1.35,
      p95SlackNs: 30_000_000,
      peakRssSlackKiB: 16_384,
      slopeSlack: 0.1,
      slopeRangeToleranceBytes: 4 * 1024 * 1024,
    });
    const baseline = {
      correctnessKey: "same",
      medianElapsedNs: 100_000_000,
      p95ElapsedNs: 100_000_000,
      medianMaxRSSKiB: 100_000,
      rssSlope: 0.2,
    };
    const boundary = {
      correctnessKey: "same",
      medianElapsedNs: 120_000_000,
      p95ElapsedNs: 135_000_000,
      medianMaxRSSKiB: 116_384,
      rssSlope: 0.3,
    };
    expect(benchmark.evaluatePair({ baseline, candidate: boundary })).toEqual({
      pass: true,
      failures: [],
    });
    // p95 is deliberately absent from this list: it is measured and recorded but does not
    // gate the verdict. Every other authority must still fail one nanosecond past its limit.
    for (const field of [
      "medianElapsedNs",
      "medianMaxRSSKiB",
      "rssSlope",
    ] as const) {
      const candidate = { ...boundary, [field]: boundary[field] + 1 };
      expect(benchmark.evaluatePair({ baseline, candidate }).pass).toBe(false);
    }
  });

  it("records a p95 excursion without gating the verdict on it", () => {
    const baseline = {
      correctnessKey: "same",
      medianElapsedNs: 100_000_000,
      p95ElapsedNs: 100_000_000,
      medianMaxRSSKiB: 100_000,
      rssSlope: 0.2,
    };
    // 9x the baseline p95 -- far past `max(p95Ratio * base, base + p95SlackNs)`. On shared CI
    // runners this magnitude is produced by scheduler preemption on a byte-identical candidate,
    // so it must not fail an admit run.
    const noisyTail = { ...baseline, p95ElapsedNs: 900_000_000 };
    expect(benchmark.evaluatePair({ baseline, candidate: noisyTail })).toEqual({
      pass: true,
      failures: [],
    });

    // The excursion is still recorded, because the phase-46 p95 diagnostic reads it from
    // `timing.failures` to tell a sustained candidate regression from a concentrated tail.
    // Dropping it there would blind that classification.
    expect(
      report.evaluateTiming({
        baselineMedianNs: 100_000_000,
        candidateMedianNs: 100_000_000,
        baselineP95Ns: 100_000_000,
        candidateP95Ns: 900_000_000,
      }).failures,
    ).toEqual(["p95 threshold exceeded"]);

    // A median regression alongside the same noisy tail must still fail, and must report only
    // the authority that actually gates.
    expect(
      benchmark.evaluatePair({
        baseline,
        candidate: { ...noisyTail, medianElapsedNs: 200_000_000 },
      }),
    ).toEqual({ pass: false, failures: ["median threshold exceeded"] });
  });

  it("fails correctness before considering numeric performance", () => {
    const result = benchmark.evaluatePair({
      baseline: {
        correctnessKey: "baseline-output",
        medianElapsedNs: 100,
        p95ElapsedNs: 100,
        medianMaxRSSKiB: 100,
        rssSlope: 0,
      },
      candidate: {
        correctnessKey: "different-output",
        medianElapsedNs: 1,
        p95ElapsedNs: 1,
        medianMaxRSSKiB: 1,
        rssSlope: 0,
      },
    });
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain("correctness");
  });

  it("binds each pinned KIT-08 pair to measured output, not to itself", async () => {
    // Baseline side: the key every retained 0.1.1 sample carried in CI run 36170788638
    // (benchmark-linux-node22 and -node24 artifacts). The published tarball is pinned by digest,
    // so this cannot drift without the baseline itself changing.
    const baselineKey =
      "f38e73058d0a048134f1e6d0121903ec369e7cd6e61c01eca1d44e3ab6366777";
    // Advancing the baseline invalidates the measured key above, so it must revisit the pins.
    expect(benchmark.BASELINE_TARBALL_SHA256).toBe(
      "c2fc569b553cba360814bcce61d6882a02aba062e6d6da2193323915530a34bf",
    );
    // Candidate side: sanitize each generated fixture through this build, exactly as the
    // benchmark child does, and require the pinned payload.
    const { sanitizeFile } = await import("../../../dist/index.js");
    const manifest = benchmark.loadBenchmarkManifest();
    const sandbox = mkdtempSync(join(tmpdir(), "benchmark-kit08-"));
    try {
      for (const [fixtureId, change] of Object.entries(
        benchmark.INTENDED_OUTPUT_CHANGES,
      )) {
        expect(report.deriveCorrectnessKey(change.baseline)).toBe(baselineKey);
        const record = manifest.fixtures.find((item) => item.id === fixtureId);
        if (record === undefined) throw new Error(`missing ${fixtureId}`);
        const sourcePath = join(sandbox, `${fixtureId}.webp`);
        const destinationPath = join(sandbox, `${fixtureId}.clean.webp`);
        benchmark.materializeFixture(record, sourcePath);
        const sourceDigest = createHash("sha256")
          .update(readFileSync(sourcePath))
          .digest("hex");
        const result = await sanitizeFile({
          sourcePath,
          destinationPath,
          preserveOrientation: false,
          preserveColorProfile: false,
          preserveTimestamps: false,
        });
        const output = readFileSync(destinationPath);
        expect({
          status: result.ok ? "success" : "refused",
          code: result.ok ? null : result.error.code,
          outputBytes: output.length,
          outputSha256: createHash("sha256").update(output).digest("hex"),
          sourceUnchanged:
            createHash("sha256")
              .update(readFileSync(sourcePath))
              .digest("hex") === sourceDigest,
          destinationAbsent: false,
        }).toEqual(change.candidate);
        rmSync(sourcePath);
        rmSync(destinationPath);
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("admits only the exact pinned KIT-08 output change, and only on its fixtures", () => {
    const changes = benchmark.INTENDED_OUTPUT_CHANGES;
    const fixtureIds = new Set(
      benchmark.loadBenchmarkManifest().fixtures.map((fixture) => fixture.id),
    );
    expect(Object.keys(changes)).toEqual([
      "metadata-still-64k",
      "metadata-still-1m",
      "metadata-still-16m",
    ]);
    const performance = {
      medianElapsedNs: 100,
      p95ElapsedNs: 100,
      medianMaxRSSKiB: 100,
      rssSlope: 0,
    };
    for (const [fixtureId, change] of Object.entries(changes)) {
      expect(fixtureIds.has(fixtureId)).toBe(true);
      expect(change.requirement).toBe("KIT-08");
      // 0.1.1 writes RIFF + VP8X(flags=0) + VP8; the candidate writes simple-format RIFF + VP8.
      expect(change.baseline).toMatchObject({
        status: "success",
        outputBytes: 48,
      });
      expect(change.candidate).toMatchObject({
        status: "success",
        outputBytes: 30,
      });
      const baselineKey = report.deriveCorrectnessKey(change.baseline);
      const candidateKey = report.deriveCorrectnessKey(change.candidate);
      const pair = (baseline: string, candidate: string, id = fixtureId) =>
        benchmark.evaluatePair({
          fixtureId: id,
          baseline: { ...performance, correctnessKey: baseline },
          candidate: { ...performance, correctnessKey: candidate },
        });
      expect(pair(baselineKey, candidateKey)).toEqual({
        pass: true,
        failures: [],
      });
      const mismatch = { pass: false, failures: ["correctness mismatch"] };
      // Byte equality still passes, so archived pre-fix admission evidence keeps validating.
      // A current-build regression to the old bytes is caught by the measured-output test.
      expect(pair(baselineKey, baselineKey)).toEqual({
        pass: true,
        failures: [],
      });
      expect(pair(candidateKey, baselineKey)).toEqual(mismatch);
      expect(pair(baselineKey, "0".repeat(64))).toEqual(mismatch);
      expect(pair("0".repeat(64), candidateKey)).toEqual(mismatch);
      // Every other correctness field is bound, not only the bytes.
      for (const field of [
        "status",
        "code",
        "sourceUnchanged",
        "destinationAbsent",
      ])
        expect(
          pair(
            baselineKey,
            report.deriveCorrectnessKey({
              ...change.candidate,
              [field]:
                field === "status"
                  ? "refused"
                  : field === "code"
                    ? "x"
                    : !change.candidate[field],
            }),
          ),
        ).toEqual(mismatch);
      // The same pair on an unlisted fixture, or with no fixture named, stays a mismatch.
      expect(pair(baselineKey, candidateKey, "still-1m")).toEqual(mismatch);
      expect(
        benchmark.evaluatePair({
          baseline: { ...performance, correctnessKey: baselineKey },
          candidate: { ...performance, correctnessKey: candidateKey },
        }),
      ).toEqual(mismatch);
      expect(pair(baselineKey, candidateKey, "__proto__")).toEqual(mismatch);
    }
  });

  it("enforces exact cancellation and truthful-finalization boundaries", () => {
    const boundary = {
      code: "aborted",
      destinationAbsent: true,
      finalizationTruthful: true,
      secondWriter: false,
      finalizationStartMs: 250,
      terminalMs: 2_000,
    };
    expect(benchmark.evaluateCancellation(boundary)).toEqual({
      pass: true,
      failures: [],
    });
    for (const field of ["finalizationStartMs", "terminalMs"] as const)
      expect(
        benchmark.evaluateCancellation({
          ...boundary,
          [field]: boundary[field] + 0.001,
        }).pass,
      ).toBe(false);
    expect(
      benchmark.evaluateCancellation({
        ...boundary,
        finalization: "truthful-residue",
      }).pass,
    ).toBe(true);
    expect(
      benchmark.evaluateCancellation({ ...boundary, secondWriter: true }).pass,
    ).toBe(false);
  });

  it("binds every deterministic fixture to the committed manifest", () => {
    const manifest = benchmark.loadBenchmarkManifest();
    expect(manifest.seed).toBe(460_070);
    expect(manifest.fixtures).toHaveLength(12);
    for (const record of manifest.fixtures) {
      const fixture = benchmark.generateFixture(record);
      expect(fixture).toHaveLength(record.targetBytes);
      expect(createHash("sha256").update(fixture).digest("hex")).toBe(
        record.sha256,
      );
    }
  });

  it("keeps the 16 MiB animation fixture bounded and retains the additive Node 22 ceiling", async () => {
    const manifest = benchmark.loadBenchmarkManifest();
    const animation = manifest.fixtures.find(
      (fixture) => fixture.id === "animation-alpha-16m",
    );
    expect(animation).toMatchObject({
      targetBytes: 16 * 1024 * 1024,
      sha256:
        "73fc89a949c4632c4797d10fd10ef7abeec1f35e7ba5959918bd4d580fba5908",
    });
    expect(benchmark.BENCHMARK_THRESHOLDS.peakRssSlackKiB).toBe(16_384);
    expect(153_500).toBeLessThanOrEqual(
      137_116 + benchmark.BENCHMARK_THRESHOLDS.peakRssSlackKiB,
    );
    const child = await readFile(
      join(projectRoot, "scripts", "qualification", "benchmark-child.cjs"),
      "utf8",
    );
    expect(child).toContain("materializeFixture");
    expect(child).toContain('const crypto = require("node:crypto")');
    expect(child).toContain("package-load");
    expect(child).toContain("fixture-materialized");
    expect(child).toContain("sanitize-complete");
    expect(child).toContain("correctness-complete");
    expect(child).not.toContain("generateFixture(options.fixture)");
    expect(child).not.toMatch(/readFileSync\(destinationPath\)/u);
    expect(child).not.toMatch(/readFileSync\(sourcePath\)/u);
    expect(child).not.toMatch(/global\.gc|process\.gc/u);
  });

  it("uses a bounded MiB payload I/O window to avoid hundreds of scheduler-sensitive file operations", async () => {
    const riff = await readFile(
      join(projectRoot, "src", "webp", "riff.ts"),
      "utf8",
    );
    const handler = await readFile(
      join(projectRoot, "src", "admission", "webp-handler.ts"),
      "utf8",
    );
    expect(riff).toContain("export const COPY_BLOCK_BYTES = 1024 * 1024");
    expect(riff).not.toContain("COPY_BLOCK_BYTES = 64 * 1024");
    expect(handler).toContain("const left = await sourceHandle.read(");
    expect(handler).toContain("const right = await destinationHandle.read(");
    expect(handler).not.toContain("const [left, right] = await Promise.all");
  });

  it("requires explicit packed baseline/candidate inputs and fresh child execution", async () => {
    expect(() => benchmark.parseArguments([])).toThrow("--baseline-tarball");
    const source = await readFile(
      join(projectRoot, "scripts", "qualification", "benchmark.cjs"),
      "utf8",
    );
    expect(source).toContain("benchmark-child.cjs");
    expect(source).toContain("spawnSync");
    expect(source).not.toMatch(/git\s+(?:show|checkout)|checkout source/u);
  });

  it("rejects a baseline package whose installed name is not exifcleaner-node", () => {
    expect(() =>
      benchmark.validateBaselinePackage(
        {
          name: "impostor-package",
          version: "0.1.1",
        },
        "a".repeat(64),
      ),
    ).toThrow("Baseline package name is not exifcleaner-node");
  });

  it("rejects a baseline package whose installed version is not exactly 0.1.1", () => {
    expect(() =>
      benchmark.validateBaselinePackage(
        {
          name: "exifcleaner-node",
          version: "0.1.2",
        },
        "a".repeat(64),
      ),
    ).toThrow("Baseline package is not v0.1.1");
  });

  it("rejects a repacked baseline with the trusted name and version", () => {
    expect(() =>
      benchmark.validateBaselinePackage(
        {
          name: "exifcleaner-node",
          version: "0.1.1",
        },
        "0".repeat(64),
      ),
    ).toThrow("Baseline tarball digest does not match the trusted artifact");
  });

  it("emits the complete digest-bound baseline identity contract", () => {
    expect(
      benchmark.validateBaselinePackage(
        {
          name: "exifcleaner-node",
          version: "0.1.1",
        },
        benchmark.BASELINE_TARBALL_SHA256,
      ),
    ).toEqual({
      baselinePackageName: "exifcleaner-node",
      baselineVersion: "0.1.1",
      baselineExpectedIdentity: `exifcleaner-node@0.1.1#sha256:${benchmark.BASELINE_TARBALL_SHA256}`,
      baselineSha256: benchmark.BASELINE_TARBALL_SHA256,
    });
  });

  it("keeps report-mode timing informational and fails correctness in either mode", () => {
    expect(benchmark.exitCodeForMode("report", false)).toBe(0);
    expect(benchmark.exitCodeForMode("admit", false)).toBe(1);
    expect(benchmark.exitCodeForMode("admit", true)).toBe(0);
    // Output bytes are deterministic, so a correctness mismatch fails report mode too; timing
    // noise stays report-only.
    expect(
      benchmark.exitCodeForMode("report", false, [
        "metadata-still-1m: correctness mismatch",
      ]),
    ).toBe(1);
    expect(
      benchmark.exitCodeForMode("report", false, [
        "still-1m: median threshold exceeded",
      ]),
    ).toBe(0);
    expect(
      benchmark.exitCodeForMode("admit", false, [
        "still-1m: correctness mismatch",
      ]),
    ).toBe(1);
    const summary = benchmark.renderSummary({
      pass: false,
      baselineSha256: "a".repeat(64),
      candidateSha256: "b".repeat(64),
      failures: ["median threshold"],
    });
    expect(summary).toContain("NOT ADMITTED");
    expect(summary).toContain("median threshold");
    expect(summary).not.toMatch(/awesome|celebrat|blazing/iu);
  });

  it("publishes the locked baseline, formulas, replay, and bounded claims", async () => {
    const documentation = await readFile(
      join(projectRoot, "docs", "benchmark-admission.md"),
      "utf8",
    );
    const normalized = documentation.replace(/\s+/gu, " ");
    for (const claim of [
      "packed `v0.1.1` baseline",
      "100 measurements per version",
      "evidence adequacy, not a pass waiver",
      "baseline median × 1.20",
      "baseline p95 × 1.35",
      "16 MiB",
      "250 ms",
      "2 seconds",
      "--fixture still-64k",
      "Node.js 22 and 24",
      "does not prove decoder or color correctness",
    ])
      expect(normalized).toContain(claim);
  });

  it("rejects every hosted ledger prerequisite binding divergence", async () => {
    const fixture = () => {
      const memory = { runId: 4242, headSha: "a".repeat(40) };
      const windows = { runId: 5353, headSha: "b".repeat(40) };
      const identity = identityCleanupLedger();
      const digests = {
        memory: "1".repeat(64),
        windows: "2".repeat(64),
        identityCleanup: "3".repeat(64),
      };
      return {
        hosted: {
          repairs: {
            memory: {
              sha256: digests.memory,
              runId: memory.runId,
              headSha: memory.headSha,
            },
            windows: {
              sha256: digests.windows,
              runId: windows.runId,
              headSha: windows.headSha,
            },
            identityCleanup: {
              sha256: digests.identityCleanup,
              runId: identity.run.id,
              headSha: identity.run.headSha,
            },
          },
        },
        prerequisites: {
          memory: { sha256: digests.memory, ledger: memory },
          windows: { sha256: digests.windows, ledger: windows },
          identityCleanup: {
            sha256: digests.identityCleanup,
            ledger: identity,
          },
        },
      };
    };

    // POSITIVE CONTROL: every slot matches and the identity-cleanup ledger is
    // valid, so a function that merely rejects everything cannot pass here.
    const positive = structuredClone(fixture());
    expect(() =>
      report.validatePrerequisiteLedgerBindings(
        positive.hosted,
        positive.prerequisites,
      ),
    ).not.toThrow();

    // CONTROL A: identity-cleanup runId mismatch.
    const controlA = structuredClone(fixture());
    controlA.hosted.repairs.identityCleanup.runId = 999_999;
    expect(() =>
      report.validatePrerequisiteLedgerBindings(
        controlA.hosted,
        controlA.prerequisites,
      ),
    ).toThrow(
      /^prerequisite ledger binding is invalid: identityCleanup\.runId$/u,
    );

    // CONTROL B: identity-cleanup headSha mismatch.
    const controlB = structuredClone(fixture());
    controlB.hosted.repairs.identityCleanup.headSha = "e".repeat(40);
    expect(() =>
      report.validatePrerequisiteLedgerBindings(
        controlB.hosted,
        controlB.prerequisites,
      ),
    ).toThrow(
      /^prerequisite ledger binding is invalid: identityCleanup\.headSha$/u,
    );

    // CONTROL C: the supplied identity-cleanup ledger fails the shared
    // validator on its own terms, so the shared validator's own message is
    // thrown and no binding reason is reached.
    const controlC = structuredClone(fixture());
    delete (
      controlC.prerequisites.identityCleanup.ledger.installed as Record<
        string,
        unknown
      >
    )["win32-arm64"];
    expect(() =>
      report.validatePrerequisiteLedgerBindings(
        controlC.hosted,
        controlC.prerequisites,
      ),
    ).toThrow(
      /^identity cleanup ledger installed fields are not exact and ordered$/u,
    );
    expect(() =>
      report.validatePrerequisiteLedgerBindings(
        controlC.hosted,
        controlC.prerequisites,
      ),
    ).not.toThrow(/prerequisite ledger binding is invalid/u);

    // CONTROL D: the identity-cleanup slot is absent entirely.
    const controlD = structuredClone(fixture());
    delete (controlD.hosted.repairs as Record<string, unknown>).identityCleanup;
    expect(() =>
      report.validatePrerequisiteLedgerBindings(
        controlD.hosted,
        controlD.prerequisites,
      ),
    ).toThrow(
      /^prerequisite ledger binding is invalid: identityCleanup\.missing$/u,
    );

    // CONTROL E: identity-cleanup file digest mismatch.
    const controlE = structuredClone(fixture());
    controlE.hosted.repairs.identityCleanup.sha256 = "7".repeat(64);
    expect(() =>
      report.validatePrerequisiteLedgerBindings(
        controlE.hosted,
        controlE.prerequisites,
      ),
    ).toThrow(
      /^prerequisite ledger binding is invalid: identityCleanup\.sha256$/u,
    );

    // CONTROL F: the existing memory arm still rejects a digest mismatch.
    const controlF = structuredClone(fixture());
    controlF.hosted.repairs.memory.sha256 = "8".repeat(64);
    expect(() =>
      report.validatePrerequisiteLedgerBindings(
        controlF.hosted,
        controlF.prerequisites,
      ),
    ).toThrow(/^prerequisite ledger binding is invalid: memory\.sha256$/u);

    // CONTROL G: the existing memory arm still rejects a runId mismatch.
    const controlG = structuredClone(fixture());
    controlG.hosted.repairs.memory.runId = 1;
    expect(() =>
      report.validatePrerequisiteLedgerBindings(
        controlG.hosted,
        controlG.prerequisites,
      ),
    ).toThrow(/^prerequisite ledger binding is invalid: memory\.runId$/u);

    // CONTROL H: the existing memory arm still rejects a headSha mismatch.
    const controlH = structuredClone(fixture());
    controlH.hosted.repairs.memory.headSha = "c".repeat(40);
    expect(() =>
      report.validatePrerequisiteLedgerBindings(
        controlH.hosted,
        controlH.prerequisites,
      ),
    ).toThrow(/^prerequisite ledger binding is invalid: memory\.headSha$/u);

    // CONTROL I: the existing Windows arm still rejects a digest mismatch.
    const controlI = structuredClone(fixture());
    controlI.hosted.repairs.windows.sha256 = "9".repeat(64);
    expect(() =>
      report.validatePrerequisiteLedgerBindings(
        controlI.hosted,
        controlI.prerequisites,
      ),
    ).toThrow(/^prerequisite ledger binding is invalid: windows\.sha256$/u);

    // CONTROL J: the existing Windows arm still rejects a runId mismatch.
    const controlJ = structuredClone(fixture());
    controlJ.hosted.repairs.windows.runId = 2;
    expect(() =>
      report.validatePrerequisiteLedgerBindings(
        controlJ.hosted,
        controlJ.prerequisites,
      ),
    ).toThrow(/^prerequisite ledger binding is invalid: windows\.runId$/u);

    // CONTROL K: the existing Windows arm still rejects a headSha mismatch.
    const controlK = structuredClone(fixture());
    controlK.hosted.repairs.windows.headSha = "d".repeat(40);
    expect(() =>
      report.validatePrerequisiteLedgerBindings(
        controlK.hosted,
        controlK.prerequisites,
      ),
    ).toThrow(/^prerequisite ledger binding is invalid: windows\.headSha$/u);

    // DELEGATION MUTANT: the binding must CALL validateIdentityCleanupLedger,
    // so mutating that validator's completeness constant in a fresh VM copy
    // must change the binding's outcome. A reimplementation cannot move.
    const source = await readFile(
      join(projectRoot, "scripts", "qualification", "benchmark-report.cjs"),
      "utf8",
    );
    const pristine = loadIdentityLedgerValidator(source);
    const pristineFixture = structuredClone(fixture());
    expect(() =>
      pristine.validatePrerequisiteLedgerBindings(
        pristineFixture.hosted,
        pristineFixture.prerequisites,
      ),
    ).not.toThrow();
    const mutatedSource = source.replace(
      "observed.size !== 12",
      "observed.size !== 13",
    );
    expect(mutatedSource).not.toBe(source);
    const mutant = loadIdentityLedgerValidator(mutatedSource);
    const mutantFixture = structuredClone(fixture());
    expect(() =>
      mutant.validatePrerequisiteLedgerBindings(
        mutantFixture.hosted,
        mutantFixture.prerequisites,
      ),
    ).toThrow(/^identity cleanup ledger is incomplete$/u);

    // DISPATCH: the four-flag eight-argument form parses ledgers; the removed
    // three-flag six-argument form exits at usage and parses nothing.
    const stubDirectory = mkdtempSync(join(tmpdir(), "phase-46-hosted-"));
    try {
      const script = join(
        projectRoot,
        "scripts",
        "qualification",
        "benchmark-report.cjs",
      );
      const stub = (name: string): string => {
        const file = join(stubDirectory, `${name}.json`);
        writeFileSync(file, "{}");
        return file;
      };
      const threeFlagArguments = [
        script,
        "--hosted-ledger",
        stub("hosted"),
        "--memory-ledger",
        stub("memory"),
        "--windows-ledger",
        stub("windows"),
      ];
      const accepted = spawnSync(
        process.execPath,
        [...threeFlagArguments, "--identity-cleanup-ledger", stub("identity")],
        { encoding: "utf8" },
      );
      const acceptedText = `${accepted.stdout}${accepted.stderr}`;
      expect(acceptedText).toContain("hosted run identity is invalid");
      expect(acceptedText).not.toMatch(/^usage:/mu);

      const rejected = spawnSync(process.execPath, threeFlagArguments, {
        encoding: "utf8",
      });
      const rejectedText = `${rejected.stdout}${rejected.stderr}`;
      expect(rejectedText).toMatch(/^usage:/mu);
      expect(rejectedText).not.toContain("hosted run identity is invalid");
    } finally {
      rmSync(stubDirectory, { recursive: true, force: true });
    }
  });

  it("shared validator primitives enforce key order, canonical key sorting, and digest anchoring", async () => {
    // D-39 clause (e): the read-only mutation sweep killed only 28 of 78 source
    // mutations.  Three shared primitives every admission validator builds on
    // were unprotected: `orderedKeys` survived having its key-sequence
    // comparison replaced by a sorted comparison, `canonicalJson` survived
    // losing its `.sort()`, and `SHA256` survived losing its `^`/`$` anchors.
    // Each assertion below pairs a POSITIVE control with the exact surviving
    // mutation, because negative controls without a positive control are
    // satisfied by a reject-everything implementation.
    const source = await readFile(
      join(projectRoot, "scripts", "qualification", "benchmark-report.cjs"),
      "utf8",
    );
    const unmutated = loadIdentityLedgerValidator(source);

    // ORDERED KEYS ---------------------------------------------------------
    // The expected messages are held as plain strings and anchored at use, so
    // the exact message text appears verbatim in this file rather than in a
    // regex-escaped form a reviewer or a grep gate would miss.
    const orderedFieldsMessage =
      "terminal cleanup record fields are not exact and ordered";
    const anchored = (message: string): RegExp =>
      new RegExp(`^${message}$`, "u");
    const cleanupRecord = terminalCleanupRecord("win32");
    expect(() =>
      report.validateTerminalCleanupRecord(structuredClone(cleanupRecord)),
    ).not.toThrow();
    const reversedRecord = Object.fromEntries(
      Object.entries(structuredClone(cleanupRecord)).reverse(),
    );
    // The reversal changes ONLY key order: the sorted key lists are identical,
    // so `exactKeys` semantics alone cannot reject the reversed record.
    expect(Object.keys(reversedRecord).sort()).toEqual(
      Object.keys(cleanupRecord).sort(),
    );
    expect(Object.keys(reversedRecord)).not.toEqual(Object.keys(cleanupRecord));
    expect(() => report.validateTerminalCleanupRecord(reversedRecord)).toThrow(
      anchored(orderedFieldsMessage),
    );
    expect(() =>
      unmutated.validateTerminalCleanupRecord(structuredClone(reversedRecord)),
    ).toThrow(anchored(orderedFieldsMessage));
    const orderingMutant = source.replace(
      "JSON.stringify(Object.keys(value)) !== JSON.stringify(expected)",
      "JSON.stringify([...Object.keys(value)].sort()) !== JSON.stringify([...expected].sort())",
    );
    expect(orderingMutant).not.toBe(source);
    expect(() =>
      loadIdentityLedgerValidator(orderingMutant).validateTerminalCleanupRecord(
        structuredClone(reversedRecord),
      ),
    ).not.toThrow();

    // CANONICAL JSON -------------------------------------------------------
    const forwardOrder = { alpha: 1, beta: { gamma: 2, delta: 3 } };
    const reverseOrder = { beta: { delta: 3, gamma: 2 }, alpha: 1 };
    expect(Object.keys(reverseOrder)).not.toEqual(Object.keys(forwardOrder));
    expect(report.canonicalJson(forwardOrder)).toBe(
      report.canonicalJson(reverseOrder),
    );
    expect(report.canonicalJson(reverseOrder)).toBe(
      '{"alpha":1,"beta":{"delta":3,"gamma":2}}',
    );
    const sortMutant = source.replace(
      "Object.keys(value)\n      .sort()\n      .map(",
      "Object.keys(value)\n      .map(",
    );
    expect(sortMutant).not.toBe(source);
    const mutantCanonicalJson =
      loadIdentityLedgerValidator(sortMutant).canonicalJson;
    expect(mutantCanonicalJson(forwardOrder)).not.toBe(
      mutantCanonicalJson(reverseOrder),
    );

    // SHA256 ANCHORS -------------------------------------------------------
    const anchoredDigest = "a1b2c3d4".repeat(8);
    const appendedDigest = `${anchoredDigest}zz`;
    const prependedDigest = `zz${anchoredDigest}`;
    // The fixture's own discriminating power is established before it is used.
    expect(anchoredDigest).toMatch(/^[a-f0-9]{64}$/u);
    for (const padded of [appendedDigest, prependedDigest]) {
      expect(padded).not.toMatch(/^[a-f0-9]{64}$/u);
      expect(padded).toMatch(/[a-f0-9]{64}/u);
    }
    const ledgerWithDigest = (digest: string): Record<string, unknown> =>
      JSON.parse(
        JSON.stringify(identityCleanupLedger())
          .split(installedCandidate.tarballSha256)
          .join(digest),
      ) as Record<string, unknown>;
    const recordWithToken = (token: string): Record<string, unknown> =>
      JSON.parse(
        JSON.stringify(terminalCleanupRecord("win32"))
          .split("6".repeat(64))
          .join(token),
      ) as Record<string, unknown>;
    const ledgerBindingMessage =
      "identity cleanup ledger run/candidate binding is invalid";
    const ownershipBindingMessage =
      "terminal cleanup ownership/capability binding is invalid";
    expect(ledgerBindingMessage).not.toBe(ownershipBindingMessage);
    expect(() =>
      report.validateIdentityCleanupLedger(ledgerWithDigest(anchoredDigest)),
    ).not.toThrow();
    expect(() =>
      report.validateTerminalCleanupRecord(recordWithToken(anchoredDigest)),
    ).not.toThrow();
    expect(() =>
      report.validateIdentityCleanupLedger(ledgerWithDigest(appendedDigest)),
    ).toThrow(anchored(ledgerBindingMessage));
    expect(() =>
      report.validateIdentityCleanupLedger(ledgerWithDigest(prependedDigest)),
    ).toThrow(anchored(ledgerBindingMessage));
    expect(() =>
      report.validateTerminalCleanupRecord(recordWithToken(appendedDigest)),
    ).toThrow(anchored(ownershipBindingMessage));
    const anchorMutant = source.replace(
      "const SHA256 = /^[a-f0-9]{64}$/;",
      "const SHA256 = /[a-f0-9]{64}/;",
    );
    expect(anchorMutant).not.toBe(source);
    const unanchored = loadIdentityLedgerValidator(anchorMutant);
    for (const padded of [appendedDigest, prependedDigest]) {
      expect(() =>
        unmutated.validateIdentityCleanupLedger(ledgerWithDigest(padded)),
      ).toThrow(anchored(ledgerBindingMessage));
      expect(() =>
        unanchored.validateIdentityCleanupLedger(ledgerWithDigest(padded)),
      ).not.toThrow();
      expect(() =>
        unmutated.validateTerminalCleanupRecord(recordWithToken(padded)),
      ).toThrow(anchored(ownershipBindingMessage));
      expect(() =>
        unanchored.validateTerminalCleanupRecord(recordWithToken(padded)),
      ).not.toThrow();
    }
  });
});
