import { webpHandler } from "./webp-handler.js";
const HANDLERS = Object.freeze([webpHandler]);
const FORMATS = Object.freeze(HANDLERS.map((handler) => handler.capability));
const CAPABILITIES = Object.freeze({ formats: FORMATS });
export function getRegisteredCapabilities() {
    return CAPABILITIES;
}
export function getFormatCapabilities() {
    return FORMATS;
}
export async function selectHandler(handle) {
    const magic = Buffer.alloc(12);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    const observed = magic.subarray(0, bytesRead);
    return HANDLERS.find((handler) => handler.matches(observed));
}
//# sourceMappingURL=registry.js.map