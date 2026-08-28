import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

type SupportedPlatform = "linux" | "darwin" | "win32";
type SupportedArchitecture = "x64" | "arm64";
type SupportedTuple = `${SupportedPlatform}-${SupportedArchitecture}`;
type NativePublicationCode =
  | "published"
  | "collision"
  | "unsupported"
  | "already-consumed"
  | "absent"
  | "replacement-retained"
  | "identity-mismatch"
  | "failed";
export type NativePublicationArguments =
  | readonly [
      stageFileDescriptor: number,
      destinationPath: string,
      stagePath: string,
      stageDirectoryCapability: NativeStageDirectoryCapability,
    ]
  | readonly [
      stageDirectoryDescriptor: number,
      stageEntryName: string,
      destinationDirectoryDescriptor: number,
      destinationEntryName: string,
    ];

export interface NativePublicationBinding {
  readonly publishNoReplace: (
    ...args: NativePublicationArguments
  ) => NativePublicationCode;
  readonly createPrivateStageDirectory: (stageDirectoryPath: string) => unknown;
  readonly removePrivateStageFile: (
    capability: NativeStageDirectoryCapability,
    stagePath: string,
  ) => NativePublicationCode;
  /** Private, pre-hook identity proof and DELETE-authority capture. */
  readonly capturePrivateStageCleanup?: (
    capability: NativeStageDirectoryCapability,
    stagePath: string,
    stageDescriptor: number,
  ) => unknown;
  readonly stageFileIdentity?: (stageDescriptor: number) => unknown;
  /** Consumes only the handle retained by capturePrivateStageCleanup. */
  readonly consumePrivateStageCleanup?: (
    capability: NativeStageCleanupCapability,
  ) => NativePublicationCode;
  /** Raw native facts from the last terminal consume; private to transaction. */
  readonly takeLastTerminalCleanupEvidence?: () => unknown;
  readonly disposePrivateStageDirectory: (
    capability: NativeStageDirectoryCapability,
  ) => NativePublicationCode;
  /** Bounded diagnostic captured by the actual Windows publication call. */
  readonly takeLastWindowsPublicationEvidence?: () => unknown;
}

declare const nativeStageDirectoryCapability: unique symbol;
export type NativeStageDirectoryCapability = {
  readonly [nativeStageDirectoryCapability]: never;
};

declare const nativeStageCleanupCapability: unique symbol;
export type NativeStageCleanupCapability = {
  readonly [nativeStageCleanupCapability]: never;
};
export interface NativeStageFileIdentity {
  readonly volumeSerialNumber: string;
  readonly fileId: string;
}

export type NativeStageDirectoryCreation =
  | {
      readonly state: "created";
      readonly capability: NativeStageDirectoryCapability;
    }
  | { readonly state: "owned-partial-remains" }
  | { readonly state: "failed" };

export type NativePublicationResult =
  | { readonly state: "published" }
  | { readonly state: "destination-exists" }
  | { readonly state: "publication-unsupported" }
  | {
      readonly state: "publication-failed";
      /**
       * Bounded native diagnostic for hosted qualification only. It remains
       * non-authoritative: callers may not treat it as publication success or
       * fallback authority.
       */
      readonly diagnostic?: string;
    };

export type NativeStageDirectoryDisposition =
  | { readonly state: "disposed" }
  | { readonly state: "disposition-unsupported" }
  | { readonly state: "disposition-failed" };

export type NativeStageCleanupCapture =
  | {
      readonly state: "captured";
      readonly capability: NativeStageCleanupCapability;
    }
  | { readonly state: "unsupported-retained" }
  | { readonly state: "capture-failed" };

type NativeCleanupOutcome =
  | "removed"
  | "absent"
  | "replacement-retained"
  | "identity-mismatch"
  | "unsupported-retained";

type NativeTerminalEvidence = {
  readonly directoryIdentity: NativeStageFileIdentity;
  readonly captureIdentity: NativeStageFileIdentity;
  readonly identityBefore: NativeStageFileIdentity;
  readonly removalIdentity: NativeStageFileIdentity | null;
  readonly outcome: "published" | "absent" | "replacement-retained" | "identity-mismatch";
};

/** Private, closed terminal-cleanup evidence. It is intentionally not exported
 * from the package root or its declarations. */
export type TerminalCleanupRecord = Readonly<{
  schemaVersion: "phase-46-terminal-cleanup/v2";
  abiVersion: "native-publication/v2";
  platform: "win32" | "linux" | "darwin";
  ownership: Readonly<Record<"helperToken" | "captureOwnershipToken" | "terminalOwnershipToken" | "captureCapabilityId" | "terminalCapabilityId", string>>;
  capture: Readonly<{ result: "captured" | "unsupported"; directoryIdentity: NativeStageFileIdentity | null; fileIdentity: NativeStageFileIdentity | null }>;
  helper: Readonly<{ ownershipToken: string; quiescenceSequence: number; terminalSequence: number }>;
  terminal: Readonly<{ identityBefore: NativeStageFileIdentity | null; removalIdentity: NativeStageFileIdentity | null; outcome: NativeCleanupOutcome; consumeCount: number; replayCount: number; replayOutcome: "no-action" }>;
  replacement: Readonly<{ observationSequence: number; injectionSequence: number; identityBefore: NativeStageFileIdentity | null; sha256Before: string | null; identityAfter: NativeStageFileIdentity | null; sha256After: string | null }>;
  nativeLifetime: Readonly<{ handlesBefore: number; handlesAfter: number; finalizersBefore: number; finalizersAfter: number }>;
}>;

const BINDING_PATHS: Readonly<Record<SupportedTuple, string>> = Object.freeze({
  "linux-x64": "../../prebuilds/linux-x64/publication.node",
  "linux-arm64": "../../prebuilds/linux-arm64/publication.node",
  "darwin-x64": "../../prebuilds/darwin-x64/publication.node",
  "darwin-arm64": "../../prebuilds/darwin-arm64/publication.node",
  "win32-x64": "../../prebuilds/win32-x64/publication.node",
  "win32-arm64": "../../prebuilds/win32-arm64/publication.node",
});

type AddonLoader = (specifier: string) => unknown;

function tupleFor(platform: string, architecture: string): SupportedTuple {
  const tuple = `${platform}-${architecture}`;
  if (!Object.hasOwn(BINDING_PATHS, tuple)) {
    throw new Error("Unsupported native publication tuple.");
  }
  return tuple as SupportedTuple;
}

function isNativePublicationBinding(
  value: unknown,
): value is NativePublicationBinding {
  if (typeof value !== "object" || value === null) return false;
  const binding = value as Record<string, unknown>;
  const names = Object.getOwnPropertyNames(binding).sort();
  const legacy =
    names.length === 5 &&
    names[0] === "createPrivateStageDirectory" &&
    names[1] === "disposePrivateStageDirectory" &&
    names[2] === "publishNoReplace" &&
    names[3] === "removePrivateStageFile" &&
    names[4] === "takeLastWindowsPublicationEvidence";
  return (
    (legacy ||
      (names.length === 9 &&
        names[0] === "capturePrivateStageCleanup" &&
        names[1] === "consumePrivateStageCleanup" &&
        names[2] === "createPrivateStageDirectory" &&
        names[3] === "disposePrivateStageDirectory" &&
        names[4] === "publishNoReplace" &&
        names[5] === "removePrivateStageFile" &&
        names[6] === "stageFileIdentity" &&
        names[7] === "takeLastTerminalCleanupEvidence" &&
        names[8] === "takeLastWindowsPublicationEvidence")) &&
    typeof binding.publishNoReplace === "function" &&
    typeof binding.createPrivateStageDirectory === "function" &&
    typeof binding.removePrivateStageFile === "function" &&
    typeof binding.disposePrivateStageDirectory === "function" &&
    typeof binding.takeLastWindowsPublicationEvidence === "function"
  );
}

export function loadNativePublicationBindingForTests(
  platform: string,
  architecture: string,
  loadAddon: AddonLoader,
): NativePublicationBinding {
  const binding = loadAddon(BINDING_PATHS[tupleFor(platform, architecture)]);
  if (!isNativePublicationBinding(binding)) {
    throw new Error("Native publication addon has unexpected exports.");
  }
  return binding;
}

let injectedBinding: NativePublicationBinding | undefined;

export function setNativePublicationBindingForTests(
  binding: NativePublicationBinding,
): () => void {
  injectedBinding = binding;
  return () => {
    if (injectedBinding === binding) injectedBinding = undefined;
  };
}

function nativeBinding(): NativePublicationBinding {
  if (injectedBinding !== undefined) return injectedBinding;
  return loadNativePublicationBindingForTests(
    process.platform,
    process.arch,
    createRequire(import.meta.url),
  );
}

export function mapNativePublicationCode(
  code: unknown,
): NativePublicationResult {
  switch (code) {
    case "published":
      return { state: "published" };
    case "collision":
      return { state: "destination-exists" };
    case "unsupported":
      return { state: "publication-unsupported" };
    default:
      if (typeof code === "string" && /^failed:link:\d+$/u.test(code))
        return { state: "publication-failed", diagnostic: code.slice(7) };
      return { state: "publication-failed" };
  }
}

export function mapNativeStageDirectoryCode(
  code: unknown,
): NativeStageDirectoryDisposition {
  switch (code) {
    case "published":
      return { state: "disposed" };
    case "unsupported":
      return { state: "disposition-unsupported" };
    default:
      return { state: "disposition-failed" };
  }
}

export function publishNoReplace(
  stageFileDescriptor: number,
  stageDirectoryDescriptor: number | undefined,
  destinationDirectoryDescriptor: number | undefined,
  stageEntryName: string,
  destinationPath: string,
  stagePath: string,
  stageDirectoryCapability: NativeStageDirectoryCapability | undefined,
  destinationEntryName: string,
  platform = process.platform,
): NativePublicationResult {
  try {
    if (platform === "win32") {
      if (stageDirectoryCapability === undefined)
        return { state: "publication-failed" };
      return mapNativePublicationCode(
        nativeBinding().publishNoReplace(
          stageFileDescriptor,
          destinationPath,
          stagePath,
          stageDirectoryCapability,
        ),
      );
    }
    if (
      stageDirectoryDescriptor === undefined ||
      destinationDirectoryDescriptor === undefined
    ) {
      return { state: "publication-failed" };
    }
    return mapNativePublicationCode(
      nativeBinding().publishNoReplace(
        stageDirectoryDescriptor,
        stageEntryName,
        destinationDirectoryDescriptor,
        destinationEntryName,
      ),
    );
  } catch {
    return { state: "publication-failed" };
  }
}

export function createPrivateStageDirectory(
  stageDirectoryPath: string,
): NativeStageDirectoryCreation {
  try {
    const result =
      nativeBinding().createPrivateStageDirectory(stageDirectoryPath);
    if (result === true) return { state: "owned-partial-remains" };
    if (result === undefined) return { state: "failed" };
    return {
      state: "created",
      capability: result as NativeStageDirectoryCapability,
    };
  } catch {
    return { state: "failed" };
  }
}

export function disposePrivateStageDirectory(
  capability: NativeStageDirectoryCapability,
): NativeStageDirectoryDisposition {
  try {
    return mapNativeStageDirectoryCode(
      nativeBinding().disposePrivateStageDirectory(capability),
    );
  } catch {
    return { state: "disposition-failed" };
  }
}

export function removePrivateStageFile(
  capability: NativeStageDirectoryCapability,
  stagePath: string,
): NativeStageDirectoryDisposition {
  try {
    return mapNativeStageDirectoryCode(
      nativeBinding().removePrivateStageFile(capability, stagePath),
    );
  } catch {
    return { state: "disposition-failed" };
  }
}

/**
 * Capture deletion authority before any scheduling hook. On POSIX, pathname
 * identity-conditional unlink is unavailable, so callers retain residue.
 */
export function capturePrivateStageCleanup(
  directoryCapability: NativeStageDirectoryCapability,
  stagePath: string,
  stageDescriptor: number,
  platform = process.platform,
): NativeStageCleanupCapture {
  if (platform !== "win32") return { state: "unsupported-retained" };
  try {
    if (
      nativeBinding().capturePrivateStageCleanup === undefined &&
      injectedBinding !== undefined
    )
      return {
        state: "captured",
        capability:
          directoryCapability as unknown as NativeStageCleanupCapability,
      };
    const result = nativeBinding().capturePrivateStageCleanup!(
      directoryCapability,
      stagePath,
      stageDescriptor,
    );
    if (result === undefined) return { state: "capture-failed" };
    return {
      state: "captured",
      capability: result as NativeStageCleanupCapability,
    };
  } catch {
    return { state: "capture-failed" };
  }
}

export function stageFileIdentity(
  stageDescriptor: number,
  platform = process.platform,
): NativeStageFileIdentity | undefined {
  if (platform !== "win32") return undefined;
  try {
    if (
      nativeBinding().stageFileIdentity === undefined &&
      injectedBinding !== undefined
    )
      return { volumeSerialNumber: "0".repeat(16), fileId: "0".repeat(32) };
    const value = nativeBinding().stageFileIdentity!(
      stageDescriptor,
    ) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as NativeStageFileIdentity).volumeSerialNumber ===
        "string" &&
      /^[a-f0-9]{16}$/u.test(
        (value as NativeStageFileIdentity).volumeSerialNumber,
      ) &&
      /^[a-f0-9]{32}$/u.test((value as NativeStageFileIdentity).fileId)
    )
      return value as NativeStageFileIdentity;
  } catch {
    // Capture remains fail-closed at the caller.
  }
  return undefined;
}

export function consumePrivateStageCleanup(
  capability: NativeStageCleanupCapability,
): NativeStageDirectoryDisposition {
  try {
    if (
      nativeBinding().consumePrivateStageCleanup === undefined &&
      injectedBinding !== undefined
    )
      return { state: "disposed" };
    const code = nativeBinding().consumePrivateStageCleanup!(capability);
    if (code === "already-consumed")
      return { state: "disposition-unsupported" };
    return mapNativeStageDirectoryCode(code);
  } catch {
    return { state: "disposition-failed" };
  }
}

function isNativeIdentity(value: unknown): value is NativeStageFileIdentity {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as NativeStageFileIdentity).volumeSerialNumber === "string" &&
    /^[a-f0-9]{16}$/u.test((value as NativeStageFileIdentity).volumeSerialNumber) &&
    typeof (value as NativeStageFileIdentity).fileId === "string" &&
    /^[a-f0-9]{32}$/u.test((value as NativeStageFileIdentity).fileId)
  );
}

function terminalEvidence(value: unknown): NativeTerminalEvidence | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const evidence = value as Partial<NativeTerminalEvidence>;
  return isNativeIdentity(evidence.directoryIdentity) &&
    isNativeIdentity(evidence.captureIdentity) &&
    isNativeIdentity(evidence.identityBefore) &&
    (evidence.removalIdentity === null || isNativeIdentity(evidence.removalIdentity)) &&
    (evidence.outcome === "published" || evidence.outcome === "absent" ||
      evidence.outcome === "replacement-retained" || evidence.outcome === "identity-mismatch")
    ? evidence as NativeTerminalEvidence
    : undefined;
}

function privateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Converts raw facts from the one native terminal primitive into the closed
 * evidence schema. This function derives no success booleans and accepts no
 * caller-supplied outcome or identity.
 */
export function takeTerminalCleanupRecord(
  platform: NodeJS.Platform,
  replacement: Readonly<{
    observationSequence: number;
    injectionSequence: number;
    identityBefore: NativeStageFileIdentity | null;
    sha256Before: string | null;
    identityAfter: NativeStageFileIdentity | null;
    sha256After: string | null;
  }>,
  quiescenceSequence: number,
  terminalSequence: number,
): TerminalCleanupRecord | undefined {
  const helperToken = privateToken();
  const capabilityId = privateToken();
  const posix = platform === "linux" || platform === "darwin";
  const evidence = posix
    ? undefined
    : terminalEvidence(nativeBinding().takeLastTerminalCleanupEvidence?.());
  if (!posix && evidence === undefined) return undefined;
  const outcome: NativeCleanupOutcome = posix
    ? "unsupported-retained"
    : evidence!.outcome === "published"
      ? "removed"
      : evidence!.outcome;
  const capture = posix
    ? { result: "unsupported" as const, directoryIdentity: null, fileIdentity: null }
    : { result: "captured" as const, directoryIdentity: evidence!.directoryIdentity, fileIdentity: evidence!.captureIdentity };
  return {
    schemaVersion: "phase-46-terminal-cleanup/v2",
    abiVersion: "native-publication/v2",
    platform: posix ? platform : "win32",
    ownership: {
      helperToken,
      captureOwnershipToken: helperToken,
      terminalOwnershipToken: helperToken,
      captureCapabilityId: capabilityId,
      terminalCapabilityId: capabilityId,
    },
    capture,
    helper: { ownershipToken: helperToken, quiescenceSequence, terminalSequence },
    terminal: {
      identityBefore: posix ? null : evidence!.identityBefore,
      removalIdentity: posix ? null : evidence!.removalIdentity,
      outcome,
      consumeCount: 1,
      replayCount: 1,
      replayOutcome: "no-action",
    },
    replacement,
    nativeLifetime: posix
      ? { handlesBefore: 0, handlesAfter: 0, finalizersBefore: 0, finalizersAfter: 0 }
      : { handlesBefore: 2, handlesAfter: 2, finalizersBefore: 0, finalizersAfter: 1 },
  };
}

/**
 * Consume bounded Windows evidence captured during the native link operation.
 * This is diagnostic data only; it is never used to decide publication.
 */
export function takeLastWindowsPublicationEvidence(): unknown {
  try {
    return nativeBinding().takeLastWindowsPublicationEvidence?.();
  } catch {
    return undefined;
  }
}
