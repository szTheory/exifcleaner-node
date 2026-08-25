export interface FixtureChunk {
  readonly fourCc: string;
  readonly data: Buffer;
  readonly padding?: number;
}

export function chunk(fourCc: string, data: Buffer, padding = 0): Buffer {
  const header = Buffer.alloc(8);
  header.write(fourCc, 0, 4, "ascii");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([
    header,
    data,
    ...(data.length % 2 === 1 ? [Buffer.from([padding])] : []),
  ]);
}

export function webp(
  chunks: readonly FixtureChunk[],
  declaredAdjustment = 0,
): Buffer {
  const body = Buffer.concat(
    chunks.map((item) => chunk(item.fourCc, item.data, item.padding)),
  );
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(body.length + 4 + declaredAdjustment, 4);
  header.write("WEBP", 8, 4, "ascii");
  return Buffer.concat([header, body]);
}

function writeUInt24LE(target: Buffer, value: number, offset: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
}

export function vp8x(flags: number, width = 1, height = 1): Buffer {
  const data = Buffer.alloc(10);
  data[0] = flags;
  writeUInt24LE(data, width - 1, 4);
  writeUInt24LE(data, height - 1, 7);
  return data;
}

export function vp8(width = 1, height = 1, data = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(10);
  header[0] = 0x10; // Key frame, version 0, displayable, empty first partition.
  header.set([0x9d, 0x01, 0x2a], 3);
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  return Buffer.concat([header, data]);
}

export function vp8l(
  width = 1,
  height = 1,
  hasAlpha = false,
  data = Buffer.alloc(0),
): Buffer {
  const header = Buffer.alloc(5);
  header[0] = 0x2f;
  const bits =
    ((width - 1) & 0x3fff) |
    (((height - 1) & 0x3fff) << 14) |
    (hasAlpha ? 0x1000_0000 : 0);
  header.writeUInt32LE(bits >>> 0, 1);
  return Buffer.concat([header, data]);
}

export function alpha(width = 1, height = 1, value = 0xff): Buffer {
  return Buffer.concat([Buffer.from([0]), Buffer.alloc(width * height, value)]);
}

export function anim(backgroundColor = 0, loopCount = 0): Buffer {
  const data = Buffer.alloc(6);
  data.writeUInt32LE(backgroundColor >>> 0, 0);
  data.writeUInt16LE(loopCount, 4);
  return data;
}

export interface AnimationFrameOptions {
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly duration?: number;
  readonly dispose?: boolean;
  readonly blend?: boolean;
  readonly chunks?: readonly FixtureChunk[];
}

export function animationFrame({
  x = 0,
  y = 0,
  width = 1,
  height = 1,
  duration = 0,
  dispose = false,
  blend = true,
  chunks = [{ fourCc: "VP8 ", data: vp8(width, height) }],
}: AnimationFrameOptions = {}): Buffer {
  const header = Buffer.alloc(16);
  writeUInt24LE(header, x / 2, 0);
  writeUInt24LE(header, y / 2, 3);
  writeUInt24LE(header, width - 1, 6);
  writeUInt24LE(header, height - 1, 9);
  writeUInt24LE(header, duration, 12);
  header[15] = (dispose ? 1 : 0) | (blend ? 0 : 2);
  return Buffer.concat([
    header,
    ...chunks.map((item) => chunk(item.fourCc, item.data, item.padding)),
  ]);
}

export function exifWithOrientation(
  orientation: number,
  make = "CameraCo",
): Buffer {
  const makeBytes = Buffer.from(`${make}\0`, "ascii");
  const dataOffset = 8 + 2 + 2 * 12 + 4;
  const result = Buffer.alloc(dataOffset + makeBytes.length);
  result.write("II", 0, 2, "ascii");
  result.writeUInt16LE(42, 2);
  result.writeUInt32LE(8, 4);
  result.writeUInt16LE(2, 8);

  result.writeUInt16LE(0x0112, 10);
  result.writeUInt16LE(3, 12);
  result.writeUInt32LE(1, 14);
  result.writeUInt16LE(orientation, 18);

  result.writeUInt16LE(0x010f, 22);
  result.writeUInt16LE(2, 24);
  result.writeUInt32LE(makeBytes.length, 26);
  result.writeUInt32LE(dataOffset, 30);
  result.writeUInt32LE(0, 34);
  makeBytes.copy(result, dataOffset);
  return result;
}

export function xmpPacket(value = "private workflow"): Buffer {
  return Buffer.from(
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:format="image/webp"><dc:description>${value}</dc:description></rdf:Description></rdf:RDF></x:xmpmeta>`,
    "utf8",
  );
}

export interface IccProfileFixtureOptions {
  readonly deviceClass?: "scnr" | "mntr";
  readonly colorSpace?: "RGB ";
  readonly pcs?: "XYZ " | "Lab ";
}

export type IccProfileMutation = "signature";

export function iccProfileV4({
  deviceClass = "mntr",
  colorSpace = "RGB ",
  pcs = "XYZ ",
}: IccProfileFixtureOptions = {}): Buffer {
  const profile = Buffer.alloc(152);
  profile.writeUInt32BE(profile.length, 0);
  profile.write("TEST", 4, 4, "ascii");
  profile[8] = 4;
  profile[9] = 0x40;
  profile.write(deviceClass, 12, 4, "ascii");
  profile.write(colorSpace, 16, 4, "ascii");
  profile.write(pcs, 20, 4, "ascii");
  profile.writeUInt16BE(2024, 24);
  profile.writeUInt16BE(2, 26);
  profile.writeUInt16BE(29, 28);
  profile.writeUInt16BE(12, 30);
  profile.writeUInt16BE(34, 32);
  profile.writeUInt16BE(56, 34);
  profile.write("acsp", 36, 4, "ascii");
  profile.write("APPL", 40, 4, "ascii");
  profile.write("TEST", 48, 4, "ascii");
  profile.write("MODL", 52, 4, "ascii");
  profile.writeUInt32BE(0, 64);
  profile.writeUInt32BE(0x0000_f6d6, 68);
  profile.writeUInt32BE(0x0001_0000, 72);
  profile.writeUInt32BE(0x0000_d32d, 76);
  profile.writeUInt32BE(1, 128);
  profile.write("rTRC", 132, 4, "ascii");
  profile.writeUInt32BE(144, 136);
  profile.writeUInt32BE(8, 140);
  profile.write("curv", 144, 4, "ascii");
  return profile;
}

export function iccProfileV2(): Buffer {
  const profile = iccProfileV4();
  profile[8] = 2;
  profile[9] = 0x40;
  profile.fill(0, 84, 128);
  return profile;
}

export function mutateIccProfile(
  profile: Buffer,
  mutation: IccProfileMutation,
): Buffer {
  const result = Buffer.from(profile);
  if (mutation === "signature") result.write("nope", 36, 4, "ascii");
  return result;
}

export function iccProfile(): Buffer {
  return iccProfileV4();
}

export function metadataWebp(imagePayload = vp8()): Buffer {
  return webp([
    { fourCc: "VP8X", data: vp8x(0x2c) },
    { fourCc: "ICCP", data: iccProfile() },
    { fourCc: "VP8 ", data: imagePayload },
    { fourCc: "EXIF", data: exifWithOrientation(6) },
    { fourCc: "XMP ", data: xmpPacket() },
  ]);
}

export function readChunks(file: Buffer): readonly FixtureChunk[] {
  const chunks: FixtureChunk[] = [];
  let offset = 12;
  while (offset < file.length) {
    const fourCc = file.toString("ascii", offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    const data = file.subarray(offset + 8, offset + 8 + size);
    chunks.push({ fourCc, data });
    offset += 8 + size + (size & 1);
  }
  return chunks;
}
