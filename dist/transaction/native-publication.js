import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
const BINDING_PATHS = Object.freeze({
    "linux-x64": "../../prebuilds/linux-x64/publication.node",
    "linux-arm64": "../../prebuilds/linux-arm64/publication.node",
    "darwin-x64": "../../prebuilds/darwin-x64/publication.node",
    "darwin-arm64": "../../prebuilds/darwin-arm64/publication.node",
    "win32-x64": "../../prebuilds/win32-x64/publication.node",
    "win32-arm64": "../../prebuilds/win32-arm64/publication.node",
});
function tupleFor(platform, architecture) {
    const tuple = `${platform}-${architecture}`;
    if (!Object.hasOwn(BINDING_PATHS, tuple)) {
        throw new Error("Unsupported native publication tuple.");
    }
    return tuple;
}
function isNativePublicationBinding(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const binding = value;
    const names = Object.getOwnPropertyNames(binding).sort();
    const legacy = names.length === 5 &&
        names[0] === "createPrivateStageDirectory" &&
        names[1] === "disposePrivateStageDirectory" &&
        names[2] === "publishNoReplace" &&
        names[3] === "removePrivateStageFile" &&
        names[4] === "takeLastWindowsPublicationEvidence";
    return ((legacy ||
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
        typeof binding.takeLastWindowsPublicationEvidence === "function");
}
export function loadNativePublicationBindingForTests(platform, architecture, loadAddon) {
    const binding = loadAddon(BINDING_PATHS[tupleFor(platform, architecture)]);
    if (!isNativePublicationBinding(binding)) {
        throw new Error("Native publication addon has unexpected exports.");
    }
    return binding;
}
let injectedBinding;
export function setNativePublicationBindingForTests(binding) {
    injectedBinding = binding;
    return () => {
        if (injectedBinding === binding)
            injectedBinding = undefined;
    };
}
function nativeBinding() {
    if (injectedBinding !== undefined)
        return injectedBinding;
    return loadNativePublicationBindingForTests(process.platform, process.arch, createRequire(import.meta.url));
}
export function mapNativePublicationCode(code) {
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
export function mapNativeStageDirectoryCode(code) {
    switch (code) {
        case "published":
            return { state: "disposed" };
        case "unsupported":
            return { state: "disposition-unsupported" };
        default:
            return { state: "disposition-failed" };
    }
}
export function publishNoReplace(stageFileDescriptor, stageDirectoryDescriptor, destinationDirectoryDescriptor, stageEntryName, destinationPath, stagePath, stageDirectoryCapability, destinationEntryName, platform = process.platform) {
    try {
        if (platform === "win32") {
            if (stageDirectoryCapability === undefined)
                return { state: "publication-failed" };
            return mapNativePublicationCode(nativeBinding().publishNoReplace(stageFileDescriptor, destinationPath, stagePath, stageDirectoryCapability));
        }
        if (stageDirectoryDescriptor === undefined ||
            destinationDirectoryDescriptor === undefined) {
            return { state: "publication-failed" };
        }
        return mapNativePublicationCode(nativeBinding().publishNoReplace(stageDirectoryDescriptor, stageEntryName, destinationDirectoryDescriptor, destinationEntryName));
    }
    catch {
        return { state: "publication-failed" };
    }
}
export function createPrivateStageDirectory(stageDirectoryPath) {
    try {
        const result = nativeBinding().createPrivateStageDirectory(stageDirectoryPath);
        if (result === true)
            return { state: "owned-partial-remains" };
        if (result === undefined)
            return { state: "failed" };
        return {
            state: "created",
            capability: result,
        };
    }
    catch {
        return { state: "failed" };
    }
}
export function disposePrivateStageDirectory(capability) {
    try {
        return mapNativeStageDirectoryCode(nativeBinding().disposePrivateStageDirectory(capability));
    }
    catch {
        return { state: "disposition-failed" };
    }
}
export function removePrivateStageFile(capability, stagePath) {
    try {
        return mapNativeStageDirectoryCode(nativeBinding().removePrivateStageFile(capability, stagePath));
    }
    catch {
        return { state: "disposition-failed" };
    }
}
/**
 * Capture deletion authority before any scheduling hook. On POSIX, pathname
 * identity-conditional unlink is unavailable, so callers retain residue.
 */
export function capturePrivateStageCleanup(directoryCapability, stagePath, stageDescriptor, platform = process.platform) {
    if (platform !== "win32")
        return { state: "unsupported-retained" };
    try {
        if (nativeBinding().capturePrivateStageCleanup === undefined &&
            injectedBinding !== undefined)
            return {
                state: "captured",
                capability: directoryCapability,
            };
        const result = nativeBinding().capturePrivateStageCleanup(directoryCapability, stagePath, stageDescriptor);
        if (result === undefined)
            return { state: "capture-failed" };
        return {
            state: "captured",
            capability: result,
        };
    }
    catch {
        return { state: "capture-failed" };
    }
}
export function stageFileIdentity(stageDescriptor, platform = process.platform) {
    if (platform !== "win32")
        return undefined;
    try {
        if (nativeBinding().stageFileIdentity === undefined &&
            injectedBinding !== undefined)
            return { volumeSerialNumber: "0".repeat(16), fileId: "0".repeat(32) };
        const value = nativeBinding().stageFileIdentity(stageDescriptor);
        if (typeof value === "object" &&
            value !== null &&
            typeof value.volumeSerialNumber ===
                "string" &&
            /^[a-f0-9]{16}$/u.test(value.volumeSerialNumber) &&
            /^[a-f0-9]{32}$/u.test(value.fileId))
            return value;
    }
    catch {
        // Capture remains fail-closed at the caller.
    }
    return undefined;
}
export function consumePrivateStageCleanup(capability) {
    try {
        if (nativeBinding().consumePrivateStageCleanup === undefined &&
            injectedBinding !== undefined)
            return { state: "disposed" };
        const code = nativeBinding().consumePrivateStageCleanup(capability);
        if (code === "already-consumed")
            return { state: "disposition-unsupported" };
        return mapNativeStageDirectoryCode(code);
    }
    catch {
        return { state: "disposition-failed" };
    }
}
function isNativeIdentity(value) {
    return (typeof value === "object" &&
        value !== null &&
        typeof value.volumeSerialNumber === "string" &&
        /^[a-f0-9]{16}$/u.test(value.volumeSerialNumber) &&
        typeof value.fileId === "string" &&
        /^[a-f0-9]{32}$/u.test(value.fileId));
}
function terminalEvidence(value) {
    if (typeof value !== "object" || value === null)
        return undefined;
    const evidence = value;
    return isNativeIdentity(evidence.directoryIdentity) &&
        isNativeIdentity(evidence.captureIdentity) &&
        isNativeIdentity(evidence.identityBefore) &&
        (evidence.removalIdentity === null ||
            isNativeIdentity(evidence.removalIdentity)) &&
        (evidence.outcome === "published" ||
            evidence.outcome === "absent" ||
            evidence.outcome === "replacement-retained" ||
            evidence.outcome === "identity-mismatch")
        ? evidence
        : undefined;
}
function privateToken() {
    return randomBytes(32).toString("hex");
}
/**
 * Converts raw facts from the one native terminal primitive into the closed
 * evidence schema. This function derives no success booleans and accepts no
 * caller-supplied outcome or identity.
 */
export function takeTerminalCleanupRecord(platform, replacement, quiescenceSequence, terminalSequence) {
    const helperToken = privateToken();
    const capabilityId = privateToken();
    const posix = platform === "linux" || platform === "darwin";
    const evidence = posix
        ? undefined
        : terminalEvidence(nativeBinding().takeLastTerminalCleanupEvidence?.());
    if (!posix && evidence === undefined)
        return undefined;
    const outcome = posix
        ? "unsupported-retained"
        : evidence.outcome === "published"
            ? "removed"
            : evidence.outcome;
    const capture = posix
        ? {
            result: "unsupported",
            directoryIdentity: null,
            fileIdentity: null,
        }
        : {
            result: "captured",
            directoryIdentity: evidence.directoryIdentity,
            fileIdentity: evidence.captureIdentity,
        };
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
        helper: {
            ownershipToken: helperToken,
            quiescenceSequence,
            terminalSequence,
        },
        terminal: {
            identityBefore: posix ? null : evidence.identityBefore,
            removalIdentity: posix ? null : evidence.removalIdentity,
            outcome,
            consumeCount: 1,
            replayCount: 1,
            replayOutcome: "no-action",
        },
        replacement,
        nativeLifetime: posix
            ? {
                handlesBefore: 0,
                handlesAfter: 0,
                finalizersBefore: 0,
                finalizersAfter: 0,
            }
            : {
                handlesBefore: 2,
                handlesAfter: 2,
                finalizersBefore: 0,
                finalizersAfter: 1,
            },
    };
}
/**
 * Consume bounded Windows evidence captured during the native link operation.
 * This is diagnostic data only; it is never used to decide publication.
 */
export function takeLastWindowsPublicationEvidence() {
    try {
        return nativeBinding().takeLastWindowsPublicationEvidence?.();
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=native-publication.js.map