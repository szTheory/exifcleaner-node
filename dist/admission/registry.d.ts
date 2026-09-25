import type { FileHandle } from "node:fs/promises";
import type { Capabilities, FormatCapabilities } from "../types.js";
import type { RegisteredHandler } from "./handler.js";
export type { RegisteredHandler };
export declare function getRegisteredCapabilities(): Capabilities;
export declare function getFormatCapabilities(): readonly [
    FormatCapabilities,
    ...FormatCapabilities[]
];
export declare function selectHandler(handle: FileHandle): Promise<RegisteredHandler | undefined>;
/**
 * Private test seam, not public API (not exported from src/index.ts or the
 * package exports map): installs `handlers` as the active registry and
 * returns a restore closure that resets to the default `HANDLERS` list, but
 * only if the active list is still the one this call installed -- so nested
 * or out-of-order restores never clobber a different test's installation.
 */
export declare function setRegisteredHandlersForTests(handlers: readonly RegisteredHandler[]): () => void;
/**
 * Private test seam, not public API: returns the default registered-handler
 * list so a test can iterate every handler this build ships, independent of
 * whatever the active registry currently is.
 */
export declare function registeredHandlersForTests(): readonly RegisteredHandler[];
//# sourceMappingURL=registry.d.ts.map