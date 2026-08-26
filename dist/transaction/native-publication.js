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
    return (names.length === 3 &&
        names[0] === "createPrivateStageDirectory" &&
        names[1] === "disposePrivateStageDirectory" &&
        names[2] === "publishNoReplace" &&
        typeof binding.publishNoReplace === "function" &&
        typeof binding.createPrivateStageDirectory === "function" &&
        typeof binding.disposePrivateStageDirectory === "function");
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
export function publishNoReplace(stagePath, destinationPath) {
    try {
        return mapNativePublicationCode(nativeBinding().publishNoReplace(stagePath, destinationPath));
    }
    catch {
        return { state: "publication-failed" };
    }
}
export function createPrivateStageDirectory(stageDirectoryPath) {
    try {
        return nativeBinding().createPrivateStageDirectory(stageDirectoryPath);
    }
    catch {
        return undefined;
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
//# sourceMappingURL=native-publication.js.map