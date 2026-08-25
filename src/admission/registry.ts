import type { FileHandle } from "node:fs/promises";
import type { Capabilities, FormatCapabilities } from "../types.js";
import { webpHandler } from "./webp-handler.js";

const HANDLERS = Object.freeze([webpHandler] as const);
const FORMATS = Object.freeze(
  HANDLERS.map((handler) => handler.capability),
) as Capabilities["formats"];
const CAPABILITIES: Capabilities = Object.freeze({ formats: FORMATS });

export type RegisteredHandler = (typeof HANDLERS)[number];

export function getRegisteredCapabilities(): Capabilities {
  return CAPABILITIES;
}

export function getFormatCapabilities(): readonly [
  FormatCapabilities,
  ...FormatCapabilities[],
] {
  return FORMATS;
}

export async function selectHandler(
  handle: FileHandle,
): Promise<RegisteredHandler | undefined> {
  const magic = Buffer.alloc(12);
  const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
  const observed = magic.subarray(0, bytesRead);
  return HANDLERS.find((handler) => handler.matches(observed));
}
