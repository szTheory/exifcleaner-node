import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const benchmark = require("../../scripts/qualification/benchmark.cjs") as {
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
    warmups: number,
    measurements: number,
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
    baseline: Record<string, number | string>;
    candidate: Record<string, number | string>;
  }): { pass: boolean; failures: readonly string[] };
  evaluateCancellation(input: Record<string, unknown>): {
    pass: boolean;
    failures: readonly string[];
  };
  exitCodeForMode(mode: "report" | "admit", pass: boolean): number;
  generateFixture(record: Record<string, unknown>): Buffer;
  loadBenchmarkManifest(): {
    seed: number;
    fixtures: readonly (Record<string, unknown> & {
      targetBytes: number;
      sha256: string;
    })[];
  };
  renderSummary(report: Record<string, unknown>): string;
  parseArguments(args: readonly string[]): Record<string, unknown>;
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
const report = require("../../scripts/qualification/benchmark-report.cjs") as {
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
  validateInstalledReport(
    input: Record<string, unknown>,
    tuple: string,
    nodeMajor: number,
    candidate: Record<string, unknown>,
  ): void;
  hostedLedger(filePath: string, memoryPath: string, windowsPath: string): void;
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
};

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
  require("../../scripts/qualification/benchmark-calibration.cjs") as {
    workloadDigest(): string;
    workloadResultDigest(): string;
  };

describe("paired benchmark admission", () => {
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
    expect(() =>
      report.validateFinalCandidateManifest({
        repoRoot: projectRoot,
        candidateSha: "0".repeat(40),
        repairProofSha: "0".repeat(40),
      }),
    ).toThrow(/final candidate manifest/i);
  });
  it("rejects incomplete, duplicate, and extra manifest evidence", () => {
    const manifest = benchmark.loadBenchmarkManifest();
    const reference = report.loadReference();
    const nodeMajor = Number(process.versions.node.split(".")[0]);
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
        platform: process.platform,
        architecture: process.arch,
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
              : "3".repeat(64),
          runToken: index.toString(16).padStart(32, "0"),
          ...(manifest.fixtures.find(
            (fixture) => fixture.id === entry.fixtureId,
          )?.expected !== "success"
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
    const complete = {
      version: 4,
      elapsedP95Estimator: {
        method: "Hyndman-Fan Type 7",
        quantile: 0.95,
        interpolation: "linear",
        retainedObservations: 100,
      },
      mode: "admit",
      pass: true,
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
      candidateSha256: "3".repeat(64),
      environment: {
        nodeVersion: `v${nodeMajor}.0.0`,
        platform: process.platform,
        architecture: process.arch,
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
      failures: comparisons.flatMap((comparison) =>
        comparison.verdict.failures.map(
          (failure) => `${comparison.fixtureId}: ${failure}`,
        ),
      ),
      warmups: 2,
      measurements: 100,
      thresholds: benchmark.BENCHMARK_THRESHOLDS,
    };
    expect(() => report.validateReport(complete)).not.toThrow();
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
  });

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
                "a412e742b59ef1161af1410dd98b86c91acf85827a5f671d5f91712a4a282e1f",
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
              finalization: "owned-partial-removed",
              residue: {
                stageDirectoryExists: false,
                stageFileExists: false,
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
            (mutated.cases.cancellation.residue.stageDirectoryExists = true),
          (mutated) =>
            (mutated.cases.cancellation.residue.stageFileExists = true),
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
      schedule.filter(
        (item) => !item.warmup && item.version === "baseline",
      ),
    ).toHaveLength(100);
    expect(
      schedule.filter(
        (item) => !item.warmup && item.version === "candidate",
      ),
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
      failures: ["p95 time threshold exceeded"],
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
    for (const field of [
      "medianElapsedNs",
      "p95ElapsedNs",
      "medianMaxRSSKiB",
      "rssSlope",
    ] as const) {
      const candidate = { ...boundary, [field]: boundary[field] + 1 };
      expect(benchmark.evaluatePair({ baseline, candidate }).pass).toBe(false);
    }
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

  it("keeps report mode informational and admit mode hard-failing", () => {
    expect(benchmark.exitCodeForMode("report", false)).toBe(0);
    expect(benchmark.exitCodeForMode("admit", false)).toBe(1);
    expect(benchmark.exitCodeForMode("admit", true)).toBe(0);
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
      "fifteen measurements",
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
});
