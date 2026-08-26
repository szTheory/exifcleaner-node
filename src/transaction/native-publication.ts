import { createRequire } from "node:module";

type SupportedPlatform = "linux" | "darwin" | "win32";
type SupportedArchitecture = "x64" | "arm64";
type SupportedTuple = `${SupportedPlatform}-${SupportedArchitecture}`;
type NativePublicationCode =
  "published" | "collision" | "unsupported" | "failed";

export interface NativePublicationBinding {
  readonly publishNoReplace: (
    stagePath: string,
    destinationPath: string,
  ) => NativePublicationCode;
  readonly createPrivateStageDirectory: () => unknown;
  readonly disposePrivateStageDirectory: (
    capability: NativeStageDirectoryCapability,
  ) => NativePublicationCode;
}

declare const nativeStageDirectoryCapability: unique symbol;
export type NativeStageDirectoryCapability = {
  readonly [nativeStageDirectoryCapability]: never;
};

export type NativePublicationResult =
  | { readonly state: "published" }
  | { readonly state: "destination-exists" }
  | { readonly state: "publication-unsupported" }
  | { readonly state: "publication-failed" };

export type NativeStageDirectoryDisposition =
  | { readonly state: "disposed" }
  | { readonly state: "disposition-unsupported" }
  | { readonly state: "disposition-failed" };

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
  return (
    names.length === 3 &&
    names[0] === "createPrivateStageDirectory" &&
    names[1] === "disposePrivateStageDirectory" &&
    names[2] === "publishNoReplace" &&
    typeof binding.publishNoReplace === "function" &&
    typeof binding.createPrivateStageDirectory === "function" &&
    typeof binding.disposePrivateStageDirectory === "function"
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
  stagePath: string,
  destinationPath: string,
): NativePublicationResult {
  try {
    return mapNativePublicationCode(
      nativeBinding().publishNoReplace(stagePath, destinationPath),
    );
  } catch {
    return { state: "publication-failed" };
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
