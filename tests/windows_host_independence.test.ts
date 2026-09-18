import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const gate = require_("../scripts/check_windows_host_independence.cjs");

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const SECTION_RVA = 0x1000;
const SECTION_RAW = 0x200;
const IMPORT_DESCRIPTOR_SIZE = 20;
const DELAY_DESCRIPTOR_SIZE = 32;

/*
 * A minimal PE32+ image carrying only the two data directories this gate reads.
 * Synthesising it keeps both directions of the assertion executable without
 * committing a multi-megabyte Windows binary as a fixture.
 */
function portableExecutable(options: {
  staticImports?: string[];
  delayImports?: string[];
}): Buffer {
  const staticImports = options.staticImports ?? [];
  const delayImports = options.delayImports ?? [];

  const importTableSize = (staticImports.length + 1) * IMPORT_DESCRIPTOR_SIZE;
  const delayTableSize = delayImports.length
    ? (delayImports.length + 1) * DELAY_DESCRIPTOR_SIZE
    : 0;

  const section = Buffer.alloc(0x400);
  let nameCursor = importTableSize + delayTableSize;
  const place = (name: string): number => {
    section.write(`${name}\0`, nameCursor, "ascii");
    const rva = SECTION_RVA + nameCursor;
    nameCursor += name.length + 1;
    return rva;
  };

  staticImports.forEach((name, index) => {
    section.writeUInt32LE(place(name), index * IMPORT_DESCRIPTOR_SIZE + 12);
  });
  delayImports.forEach((name, index) => {
    section.writeUInt32LE(
      place(name),
      importTableSize + index * DELAY_DESCRIPTOR_SIZE + 4,
    );
  });

  const image = Buffer.alloc(SECTION_RAW + section.length);
  image.write("MZ", 0, "ascii");
  image.writeUInt32LE(0x40, 0x3c);
  image.write("PE\0\0", 0x40, "ascii");

  const coff = 0x44;
  image.writeUInt16LE(0x8664, coff); // machine
  image.writeUInt16LE(1, coff + 2); // section count
  image.writeUInt16LE(0xf0, coff + 16); // optional header size

  const optional = coff + 20;
  image.writeUInt16LE(0x20b, optional); // PE32+
  image.writeUInt32LE(16, optional + 108); // NumberOfRvaAndSizes

  const directories = optional + 112;
  image.writeUInt32LE(SECTION_RVA, directories + 1 * 8); // Import
  image.writeUInt32LE(importTableSize, directories + 1 * 8 + 4);
  if (delayTableSize) {
    image.writeUInt32LE(SECTION_RVA + importTableSize, directories + 13 * 8);
    image.writeUInt32LE(delayTableSize, directories + 13 * 8 + 4);
  }

  const header = optional + 0xf0;
  image.write(".rdata\0\0", header, "ascii");
  image.writeUInt32LE(section.length, header + 8); // virtual size
  image.writeUInt32LE(SECTION_RVA, header + 12);
  image.writeUInt32LE(section.length, header + 16); // raw size
  image.writeUInt32LE(SECTION_RAW, header + 20);

  section.copy(image, SECTION_RAW);
  return image;
}

async function prebuildRoot(images: Record<string, Buffer>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "exifcleaner-host-independence-"));
  roots.push(root);
  for (const [tuple, image] of Object.entries(images)) {
    const directory = join(root, "prebuilds", tuple);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "publication.node"), image);
  }
  return root;
}

describe("Windows host-independence gate", () => {
  it("reads both import directories of a PE32+ image", () => {
    const parsed = gate.readPortableExecutable(
      portableExecutable({
        staticImports: ["KERNEL32.dll", "ADVAPI32.dll"],
        delayImports: ["node.exe"],
      }),
    );

    expect(parsed.staticImports).toEqual(["KERNEL32.dll", "ADVAPI32.dll"]);
    expect(parsed.delayImports).toEqual(["node.exe"]);
  });

  it("admits a prebuild that declares no host dependency", async () => {
    const image = portableExecutable({
      staticImports: ["KERNEL32.dll", "ADVAPI32.dll"],
    });
    const root = await prebuildRoot({
      "win32-x64": image,
      "win32-arm64": image,
    });

    expect(gate.checkPrebuilds(root).failures).toEqual([]);
  });

  /*
   * The defect that crashed the packaged Windows app, traced in
   * .planning 48-WINDOWS-CRASH-ROOTCAUSE.md. Published 0.2.1 carried a static
   * import of the literal name "node.exe" on both arches, which makes the
   * Windows loader map a second Node runtime into an Electron host. The
   * dumpbin-based audit allowlisted that dependency and reported green, so this
   * gate asserts it from the PE itself and from any host.
   */
  it("rejects a static import of the host executable", async () => {
    const image = portableExecutable({
      staticImports: ["KERNEL32.dll", "ADVAPI32.dll", "node.exe"],
    });
    const root = await prebuildRoot({
      "win32-x64": image,
      "win32-arm64": image,
    });
    const { failures } = gate.checkPrebuilds(root);

    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain("win32-x64");
    expect(failures[0]).toContain("node.exe (static)");
    expect(failures[1]).toContain("win32-arm64");
  });

  it("rejects a delay-load descriptor for the host executable", async () => {
    const root = await prebuildRoot({
      "win32-x64": portableExecutable({
        staticImports: ["KERNEL32.dll"],
        delayImports: ["node.exe"],
      }),
      "win32-arm64": portableExecutable({ staticImports: ["KERNEL32.dll"] }),
    });
    const { failures } = gate.checkPrebuilds(root);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("node.exe (delay-load)");
  });

  it("reports a missing or unreadable prebuild rather than passing it", async () => {
    const root = await prebuildRoot({
      "win32-x64": portableExecutable({ staticImports: ["KERNEL32.dll"] }),
    });
    const { failures } = gate.checkPrebuilds(root);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("win32-arm64");
  });
});
