type NativePublicationCode = "published" | "collision" | "unsupported" | "failed";
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
    readonly disposePrivateStageDirectory: (capability: NativeStageDirectoryCapability) => NativePublicationCode;
}
declare const nativeStageDirectoryCapability: unique symbol;
export type NativeStageDirectoryCapability = {
    readonly [nativeStageDirectoryCapability]: never;
};
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
type AddonLoader = (specifier: string) => unknown;
export declare function loadNativePublicationBindingForTests(platform: string, architecture: string, loadAddon: AddonLoader): NativePublicationBinding;
export declare function setNativePublicationBindingForTests(binding: NativePublicationBinding): () => void;
export declare function mapNativePublicationCode(code: unknown): NativePublicationResult;
export declare function mapNativeStageDirectoryCode(code: unknown): NativeStageDirectoryDisposition;
export declare function publishNoReplace(stageFileDescriptor: number, stageDirectoryDescriptor: number | undefined, destinationDirectoryDescriptor: number | undefined, stageEntryName: string, destinationPath: string, stagePath: string, stageDirectoryCapability: NativeStageDirectoryCapability | undefined, destinationEntryName: string, platform?: NodeJS.Platform): NativePublicationResult;
export declare function createPrivateStageDirectory(stageDirectoryPath: string): NativeStageDirectoryCreation;
export declare function disposePrivateStageDirectory(capability: NativeStageDirectoryCapability): NativeStageDirectoryDisposition;
export declare function removePrivateStageFile(capability: NativeStageDirectoryCapability, stagePath: string): NativeStageDirectoryDisposition;
export {};
//# sourceMappingURL=native-publication.d.ts.map