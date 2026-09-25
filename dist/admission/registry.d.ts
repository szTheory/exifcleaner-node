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
//# sourceMappingURL=registry.d.ts.map