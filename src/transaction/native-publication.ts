import { createRequire } from "node:module";

type SupportedPlatform = "linux" | "darwin" | "win32";
type SupportedArchitecture = "x64" | "arm64";
type SupportedTuple = `${SupportedPlatform}-${SupportedArchitecture}`;
type NativePublicationCode =
  "published" | "collision" | "unsupported" | "already-consumed" | "failed";
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
    identity: NativeStageFileIdentity,
  ) => unknown;
  readonly stageFileIdentity?: (stageDescriptor: number) => unknown;
  /** Consumes only the handle retained by capturePrivateStageCleanup. */
  readonly consumePrivateStageCleanup?: (
    capability: NativeStageCleanupCapability,
  ) => NativePublicationCode;
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
  readonly volumeSerialNumber: number;
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
  | { readonly state: "captured"; readonly capability: NativeStageCleanupCapability }
  | { readonly state: "unsupported-retained" }
  | { readonly state: "capture-failed" };

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
    (legacy || (names.length === 8 &&
    names[0] === "capturePrivateStageCleanup" &&
    names[1] === "consumePrivateStageCleanup" &&
    names[2] === "createPrivateStageDirectory" &&
    names[3] === "disposePrivateStageDirectory" &&
    names[4] === "publishNoReplace" &&
    names[5] === "removePrivateStageFile" &&
    names[6] === "stageFileIdentity" &&
    names[7] === "takeLastWindowsPublicationEvidence")) &&
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
  identity: NativeStageFileIdentity | undefined,
  platform = process.platform,
): NativeStageCleanupCapture {
  if (platform !== "win32" || identity === undefined)
    return { state: "unsupported-retained" };
  try {
    if (nativeBinding().capturePrivateStageCleanup === undefined && injectedBinding !== undefined)
      return { state: "captured", capability: directoryCapability as unknown as NativeStageCleanupCapability };
    const result = nativeBinding().capturePrivateStageCleanup!(
      directoryCapability,
      stagePath,
      identity,
    );
    if (result === undefined) return { state: "capture-failed" };
    return { state: "captured", capability: result as NativeStageCleanupCapability };
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
    if (nativeBinding().stageFileIdentity === undefined && injectedBinding !== undefined)
      return { volumeSerialNumber: 0, fileId: "0".repeat(32) };
    const value = nativeBinding().stageFileIdentity!(stageDescriptor) as unknown;
    if (
      typeof value === "object" && value !== null &&
      typeof (value as NativeStageFileIdentity).volumeSerialNumber === "number" &&
      /^[a-f0-9]{32}$/u.test((value as NativeStageFileIdentity).fileId)
    ) return value as NativeStageFileIdentity;
  } catch {
    // Capture remains fail-closed at the caller.
  }
  return undefined;
}

export function consumePrivateStageCleanup(
  capability: NativeStageCleanupCapability,
): NativeStageDirectoryDisposition {
  try {
    if (nativeBinding().consumePrivateStageCleanup === undefined && injectedBinding !== undefined)
      return { state: "disposed" };
    const code = nativeBinding().consumePrivateStageCleanup!(capability);
    if (code === "already-consumed") return { state: "disposition-unsupported" };
    return mapNativeStageDirectoryCode(code);
  } catch {
    return { state: "disposition-failed" };
  }
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
