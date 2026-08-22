import type { MetadataEntry, MetadataWarning } from "../types.js";

const ICC_HEADER_BYTES = 128;
const ICC_TAG_COUNT_BYTES = 4;
const ICC_TAG_RECORD_BYTES = 12;
const MAX_ICC_TAG_COUNT = 4_096;

function ascii(payload: Buffer, offset: number, length: number): string {
  return payload
    .toString("ascii", offset, offset + length)
    .replace(/\0+$/u, "");
}

export function parseIcc(payload: Buffer): {
  readonly entries: readonly MetadataEntry[];
  readonly warnings: readonly MetadataWarning[];
} {
  const entries: MetadataEntry[] = [
    { namespace: "ICC", name: "Size", value: payload.length },
  ];
  if (payload.length < ICC_HEADER_BYTES) {
    return {
      entries,
      warnings: [
        {
          code: "metadata-invalid",
          detail: "ICC profile header is truncated.",
        },
      ],
    };
  }
  const declaredSize = payload.readUInt32BE(0);
  entries.push(
    { namespace: "ICC", name: "DeclaredSize", value: declaredSize },
    { namespace: "ICC", name: "CMMType", value: ascii(payload, 4, 4) },
    {
      namespace: "ICC",
      name: "Version",
      value: `${payload[8] ?? 0}.${((payload[9] ?? 0) >> 4).toString(16)}.${((payload[9] ?? 0) & 0x0f).toString(16)}`,
    },
    { namespace: "ICC", name: "DeviceClass", value: ascii(payload, 12, 4) },
    { namespace: "ICC", name: "ColorSpace", value: ascii(payload, 16, 4) },
    { namespace: "ICC", name: "PCS", value: ascii(payload, 20, 4) },
    { namespace: "ICC", name: "Platform", value: ascii(payload, 40, 4) },
    { namespace: "ICC", name: "Manufacturer", value: ascii(payload, 48, 4) },
    { namespace: "ICC", name: "Model", value: ascii(payload, 52, 4) },
    {
      namespace: "ICC",
      name: "RenderingIntent",
      value: payload.readUInt32BE(64),
    },
  );
  const warnings: MetadataWarning[] = [];
  if (ascii(payload, 36, 4) !== "acsp") {
    warnings.push({
      code: "metadata-invalid",
      detail: "ICC profile signature is invalid.",
    });
  }
  if (declaredSize !== payload.length) {
    warnings.push({
      code: "metadata-invalid",
      detail: `ICC profile declares ${declaredSize} bytes but contains ${payload.length}.`,
    });
  }
  if (payload.length === ICC_HEADER_BYTES) {
    warnings.push({
      code: "metadata-invalid",
      detail: "ICC profile has no tag-count field.",
    });
    return { entries, warnings };
  }
  if (payload.length < ICC_HEADER_BYTES + ICC_TAG_COUNT_BYTES) {
    warnings.push({
      code: "metadata-invalid",
      detail: "ICC tag-count field is truncated.",
    });
    return { entries, warnings };
  }
  const tagCount = payload.readUInt32BE(ICC_HEADER_BYTES);
  entries.push({ namespace: "ICC", name: "TagCount", value: tagCount });
  const maximumRepresentable = Math.floor(
    (payload.length - ICC_HEADER_BYTES - ICC_TAG_COUNT_BYTES) /
      ICC_TAG_RECORD_BYTES,
  );
  if (tagCount > MAX_ICC_TAG_COUNT || tagCount > maximumRepresentable) {
    warnings.push({
      code: "metadata-invalid",
      detail: `ICC tag table declares ${tagCount} records but only ${maximumRepresentable} are bounded by the profile.`,
    });
    return { entries, warnings };
  }
  const signatures: string[] = [];
  for (let index = 0; index < tagCount; index += 1) {
    const recordOffset =
      ICC_HEADER_BYTES + ICC_TAG_COUNT_BYTES + index * ICC_TAG_RECORD_BYTES;
    const signature = ascii(payload, recordOffset, 4);
    const dataOffset = payload.readUInt32BE(recordOffset + 4);
    const dataSize = payload.readUInt32BE(recordOffset + 8);
    if (
      dataOffset < ICC_HEADER_BYTES ||
      dataOffset > payload.length - dataSize
    ) {
      warnings.push({
        code: "metadata-invalid",
        detail: `ICC tag ${JSON.stringify(signature)} points outside the profile.`,
      });
      continue;
    }
    signatures.push(signature);
  }
  if (signatures.length > 0) {
    entries.push({
      namespace: "ICC",
      name: "TagSignatures",
      value: signatures,
    });
  }
  return { entries, warnings };
}
