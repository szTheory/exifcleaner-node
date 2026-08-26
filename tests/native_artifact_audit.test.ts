import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const audit = require("../scripts/audit_native_artifact.cjs");
const artifacts = require("../scripts/native_artifacts.cjs");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function binary(format: string, machine: string): Buffer {
  if (format === "elf") {
    const result = Buffer.alloc(20);
    result.write("\u007fELF", 0, "ascii");
    result.writeUInt16LE(machine === "x64" ? 62 : 183, 18);
    return result;
  }
  if (format === "macho") {
    const result = Buffer.alloc(8);
    result.writeUInt32BE(0xcffaedfe, 0);
    result.writeUInt32LE(machine === "x64" ? 0x01000007 : 0x0100000c, 4);
    return result;
  }
  const result = Buffer.alloc(128);
  result.write("MZ", 0, "ascii");
  result.writeUInt32LE(64, 60);
  result.write("PE\0\0", 64, "ascii");
  result.writeUInt16LE(machine === "x64" ? 0x8664 : 0xaa64, 68);
  return result;
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "exifcleaner-native-artifacts-"));
  roots.push(root);
  return root;
}

function cleanReport(tuple: string): string {
  if (tuple.startsWith("linux")) {
    return audit.auditLinux(
      " 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]",
      "     1: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND napi_create_string_utf8\n     2: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND renameat2",
    );
  }
  if (tuple.startsWith("darwin")) {
    return audit.auditDarwin(
      "publication.node:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)",
      "                 U _napi_create_string_utf8\n                 U _renamex_np",
    );
  }
  return audit.auditWindows(
    "Image has the following dependencies:\n\n    node.exe\n    KERNEL32.dll\n    ADVAPI32.dll",
    "    KERNEL32.dll\n              CreateFileW\n              HeapAlloc\n    publication.node\n              napi_create_string_utf8",
  );
}

async function cleanManifest(root: string) {
  const reports: Record<string, string> = {};
  for (const record of artifacts.EXACT_ARTIFACTS) {
    const target = join(root, record.path);
    await (
      await import("node:fs/promises")
    ).mkdir(dirname(target), { recursive: true });
    await writeFile(target, binary(record.binaryFormat, record.machine));
    reports[record.tuple] = cleanReport(record.tuple);
  }
  return artifacts.createManifest(root, reports);
}

describe("native compiled artifact audits", () => {
  it.runIf(process.platform === "darwin")(
    "accepts the compiled matching-host artifact",
    () => {
      expect(
        audit.auditHostArtifact(
          join(packageRoot, "prebuilds", "darwin-arm64", "publication.node"),
        ),
      ).toContain('"auditTool":"otool-nm"');
    },
  );

  it("accepts clean readelf, otool/nm, and dumpbin parser fixtures", () => {
    expect(cleanReport("linux-x64")).toContain('"auditTool":"readelf"');
    expect(cleanReport("darwin-arm64")).toContain('"auditTool":"otool-nm"');
    expect(cleanReport("win32-x64")).toContain('"auditTool":"dumpbin"');
  });

  it("locates the native-host dumpbin when Visual Studio leaves it off PATH", () => {
    const x64 =
      "C:\\VS\\VC\\Tools\\MSVC\\14.50.0\\bin\\Hostx64\\x64\\dumpbin.exe";
    const arm64 =
      "C:\\VS\\VC\\Tools\\MSVC\\14.50.0\\bin\\Hostarm64\\arm64\\dumpbin.exe";
    const commands: string[] = [];
    const resolved = audit.resolveDumpbin({
      arch: "arm64",
      env: { VSWHERE_PATH: "C:\\tools\\vswhere.exe" },
      execFile(command: string) {
        commands.push(command);
        if (command === "where.exe") {
          const error = new Error("not found") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return `${x64}\r\n${arm64}\r\n`;
      },
    });

    expect(resolved).toBe(arm64);
    expect(commands).toEqual(["where.exe", "C:\\tools\\vswhere.exe"]);
  });

  it("fails closed when no dumpbin executable is discoverable", () => {
    expect(() =>
      audit.resolveDumpbin({
        env: { VSWHERE_PATH: "C:\\tools\\vswhere.exe" },
        execFile(command: string) {
          if (command === "where.exe") throw new Error("not found");
          return "\r\n";
        },
      }),
    ).toThrow(/did not report a dumpbin executable/i);
  });

  it.each([
    [
      "linux dependency",
      () => audit.auditLinux("Shared library: [libcurl.so.4]", ""),
    ],
    [
      "linux import",
      () => audit.auditLinux("Shared library: [libc.so.6]", " UND socket"),
    ],
    [
      "darwin dependency",
      () => audit.auditDarwin("\t/usr/lib/libobjc.A.dylib", ""),
    ],
    [
      "darwin import",
      () => audit.auditDarwin("\t/usr/lib/libSystem.B.dylib", " U _dlopen"),
    ],
    ["windows dependency", () => audit.auditWindows("WS2_32.dll", "")],
    [
      "windows import",
      () => audit.auditWindows("KERNEL32.dll", "    LoadLibraryW"),
    ],
  ])("rejects forbidden %s", (_name, run) => {
    expect(run).toThrow(/not allowlisted|forbidden/i);
  });

  it("admits exactly six literal paths with hash-bound audit reports", async () => {
    const root = await fixtureRoot();
    const manifest = await cleanManifest(root);

    expect(manifest).toHaveLength(6);
    expect(manifest.map((record: { path: string }) => record.path)).toEqual(
      artifacts.EXACT_ARTIFACTS.map((record: { path: string }) => record.path),
    );
    expect(
      manifest.every(
        (record: { sha256: string; auditReportSha256: string }) =>
          /^[a-f0-9]{64}$/.test(record.sha256) &&
          /^[a-f0-9]{64}$/.test(record.auditReportSha256),
      ),
    ).toBe(true);
  });

  it("rejects missing, duplicate, unexpected, mislabeled, stale, and wrong-machine artifacts", async () => {
    const root = await fixtureRoot();
    const manifest = await cleanManifest(root);
    const missing = manifest.slice(1);
    await expect(artifacts.validateManifest(root, missing)).rejects.toThrow(
      /exactly six/i,
    );
    await expect(
      artifacts.validateManifest(root, [...manifest, manifest[0]]),
    ).rejects.toThrow(/duplicate|exactly six/i);

    const unexpected = join(
      root,
      "prebuilds",
      "linux-ppc64",
      "publication.node",
    );
    await (
      await import("node:fs/promises")
    ).mkdir(dirname(unexpected), { recursive: true });
    await writeFile(unexpected, binary("elf", "x64"));
    await expect(artifacts.validateManifest(root, manifest)).rejects.toThrow(
      /unexpected/i,
    );
    await rm(unexpected);

    const wrongMachine = { ...manifest[0], machine: "arm64" };
    await expect(
      artifacts.validateManifest(root, [wrongMachine, ...manifest.slice(1)]),
    ).rejects.toThrow(/machine/i);
    const staleHash = { ...manifest[0], sha256: digest("stale") };
    await expect(
      artifacts.validateManifest(root, [staleHash, ...manifest.slice(1)]),
    ).rejects.toThrow(/hash/i);
    const staleReport = { ...manifest[0], auditReportSha256: digest("stale") };
    await expect(
      artifacts.validateManifest(root, [staleReport, ...manifest.slice(1)]),
    ).rejects.toThrow(/audit report/i);
  });
});
