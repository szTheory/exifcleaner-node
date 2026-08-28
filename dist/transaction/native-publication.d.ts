type NativePublicationCode = "published" | "collision" | "unsupported" | "already-consumed" | "absent" | "replacement-retained" | "identity-mismatch" | "failed";
export type NativePublicationArguments = readonly [
    stageFileDescriptor: number,
    destinationPath: string,
    stagePath: string,
    stageDirectoryCapability: NativeStageDirectoryCapability
] | readonly [
    stageDirectoryDescriptor: number,
    stageEntryName: string,
    destinationDirectoryDescriptor: number,
    destinationEntryName: string
];
export interface NativePublicationBinding {
    readonly publishNoReplace: (...args: NativePublicationArguments) => NativePublicationCode;
    readonly createPrivateStageDirectory: (stageDirectoryPath: string) => unknown;
    readonly removePrivateStageFile: (capability: NativeStageDirectoryCapability, stagePath: string) => NativePublicationCode;
    /** Private, pre-hook identity proof and DELETE-authority capture. */
    readonly capturePrivateStageCleanup?: (capability: NativeStageDirectoryCapability, stagePath: string, stageDescriptor: number) => unknown;
    readonly stageFileIdentity?: (stageDescriptor: number) => unknown;
    /** Consumes only the handle retained by capturePrivateStageCleanup. */
    readonly consumePrivateStageCleanup?: (capability: NativeStageCleanupCapability) => NativePublicationCode;
    /** Raw native facts from the last terminal consume; private to transaction. */
    readonly takeLastTerminalCleanupEvidence?: () => unknown;
    readonly disposePrivateStageDirectory: (capability: NativeStageDirectoryCapability) => NativePublicationCode;
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
export type NativeStageDirectoryCreation = {
    readonly state: "created";
    readonly capability: NativeStageDirectoryCapability;
} | {
    readonly state: "owned-partial-remains";
} | {
    readonly state: "failed";
};
export type NativePublicationResult = {
    readonly state: "published";
} | {
    readonly state: "destination-exists";
} | {
    readonly state: "publication-unsupported";
} | {
    readonly state: "publication-failed";
    /**
     * Bounded native diagnostic for hosted qualification only. It remains
     * non-authoritative: callers may not treat it as publication success or
     * fallback authority.
     */
    readonly diagnostic?: string;
};
export type NativeStageDirectoryDisposition = {
    readonly state: "disposed";
} | {
    readonly state: "disposition-unsupported";
} | {
    readonly state: "disposition-failed";
};
export type NativeStageCleanupCapture = {
    readonly state: "captured";
    readonly capability: NativeStageCleanupCapability;
} | {
    readonly state: "unsupported-retained";
} | {
    readonly state: "capture-failed";
};
type NativeCleanupOutcome = "removed" | "absent" | "replacement-retained" | "identity-mismatch" | "unsupported-retained";
/** Private, closed terminal-cleanup evidence. It is intentionally not exported
 * from the package root or its declarations. */
export type TerminalCleanupRecord = Readonly<{
    schemaVersion: "phase-46-terminal-cleanup/v2";
    abiVersion: "native-publication/v2";
    platform: "win32" | "linux" | "darwin";
    ownership: Readonly<Record<"helperToken" | "captureOwnershipToken" | "terminalOwnershipToken" | "captureCapabilityId" | "terminalCapabilityId", string>>;
    capture: Readonly<{
        result: "captured" | "unsupported";
        directoryIdentity: NativeStageFileIdentity | null;
        fileIdentity: NativeStageFileIdentity | null;
    }>;
    helper: Readonly<{
        ownershipToken: string;
        quiescenceSequence: number;
        terminalSequence: number;
    }>;
    terminal: Readonly<{
        identityBefore: NativeStageFileIdentity | null;
        removalIdentity: NativeStageFileIdentity | null;
        outcome: NativeCleanupOutcome;
        consumeCount: number;
        replayCount: number;
        replayOutcome: "no-action";
    }>;
    replacement: Readonly<{
        observationSequence: number;
        injectionSequence: number;
        identityBefore: NativeStageFileIdentity | null;
        sha256Before: string | null;
        identityAfter: NativeStageFileIdentity | null;
        sha256After: string | null;
    }>;
    nativeLifetime: Readonly<{
        handlesBefore: number;
        handlesAfter: number;
        finalizersBefore: number;
        finalizersAfter: number;
    }>;
}>;
type AddonLoader = (specifier: string) => unknown;
export declare function loadNativePublicationBindingForTests(platform: string, architecture: string, loadAddon: AddonLoader): NativePublicationBinding;
export declare function setNativePublicationBindingForTests(binding: NativePublicationBinding): () => void;
export declare function mapNativePublicationCode(code: unknown): NativePublicationResult;
export declare function mapNativeStageDirectoryCode(code: unknown): NativeStageDirectoryDisposition;
export declare function publishNoReplace(stageFileDescriptor: number, stageDirectoryDescriptor: number | undefined, destinationDirectoryDescriptor: number | undefined, stageEntryName: string, destinationPath: string, stagePath: string, stageDirectoryCapability: NativeStageDirectoryCapability | undefined, destinationEntryName: string, platform?: NodeJS.Platform): NativePublicationResult;
export declare function createPrivateStageDirectory(stageDirectoryPath: string): NativeStageDirectoryCreation;
export declare function disposePrivateStageDirectory(capability: NativeStageDirectoryCapability): NativeStageDirectoryDisposition;
export declare function removePrivateStageFile(capability: NativeStageDirectoryCapability, stagePath: string): NativeStageDirectoryDisposition;
/**
 * Capture deletion authority before any scheduling hook. On POSIX, pathname
 * identity-conditional unlink is unavailable, so callers retain residue.
 */
export declare function capturePrivateStageCleanup(directoryCapability: NativeStageDirectoryCapability, stagePath: string, stageDescriptor: number, platform?: NodeJS.Platform): NativeStageCleanupCapture;
export declare function stageFileIdentity(stageDescriptor: number, platform?: NodeJS.Platform): NativeStageFileIdentity | undefined;
export declare function consumePrivateStageCleanup(capability: NativeStageCleanupCapability): NativeStageDirectoryDisposition;
/**
 * Converts raw facts from the one native terminal primitive into the closed
 * evidence schema. This function derives no success booleans and accepts no
 * caller-supplied outcome or identity.
 */
export declare function takeTerminalCleanupRecord(platform: NodeJS.Platform, replacement: Readonly<{
    observationSequence: number;
    injectionSequence: number;
    identityBefore: NativeStageFileIdentity | null;
    sha256Before: string | null;
    identityAfter: NativeStageFileIdentity | null;
    sha256After: string | null;
}>, quiescenceSequence: number, terminalSequence: number): TerminalCleanupRecord | undefined;
/**
 * Consume bounded Windows evidence captured during the native link operation.
 * This is diagnostic data only; it is never used to decide publication.
 */
export declare function takeLastWindowsPublicationEvidence(): unknown;
export {};
//# sourceMappingURL=native-publication.d.ts.map