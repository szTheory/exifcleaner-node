import { webpHandler } from "./webp-handler.js";
const HANDLERS = Object.freeze([webpHandler]);
// Private test seam (mirrors setNativePublicationBindingForTests in
// src/transaction/native-publication.ts): lets a test roll a handler out of
// the active registry to prove the rollback-decline path, without adding any
// public API. `activeHandlers` is the list every read path below consults;
// the frozen default `HANDLERS` above is never mutated.
let activeHandlers = HANDLERS;
let cachedFormats;
function currentFormats() {
    if (cachedFormats?.handlers === activeHandlers)
        return cachedFormats.formats;
    const formats = Object.freeze(activeHandlers.map((handler) => handler.capability));
    cachedFormats = { handlers: activeHandlers, formats };
    return formats;
}
export function getRegisteredCapabilities() {
    return Object.freeze({ formats: currentFormats() });
}
export function getFormatCapabilities() {
    return currentFormats();
}
export async function selectHandler(handle) {
    const magic = Buffer.alloc(12);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    const observed = magic.subarray(0, bytesRead);
    return activeHandlers.find((handler) => handler.matches(observed));
}
/**
 * Private test seam, not public API (not exported from src/index.ts or the
 * package exports map): installs `handlers` as the active registry and
 * returns a restore closure that resets to the default `HANDLERS` list, but
 * only if the active list is still the one this call installed -- so nested
 * or out-of-order restores never clobber a different test's installation.
 */
export function setRegisteredHandlersForTests(handlers) {
    const installed = Object.freeze([...handlers]);
    activeHandlers = installed;
    return () => {
        if (activeHandlers === installed)
            activeHandlers = HANDLERS;
    };
}
/**
 * Private test seam, not public API: returns the default registered-handler
 * list so a test can iterate every handler this build ships, independent of
 * whatever the active registry currently is.
 */
export function registeredHandlersForTests() {
    return HANDLERS;
}
//# sourceMappingURL=registry.js.map