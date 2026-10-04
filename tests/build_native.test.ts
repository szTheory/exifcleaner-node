import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { replaceFileAtomically } = require("../scripts/build_native.cjs") as {
  replaceFileAtomically(source: string, destination: string): Promise<void>;
};

// On darwin an in-place rewrite of a loaded addon's inode leaves the kernel's cached code
// signature stale and later loads are SIGKILLed, so the publish step must land a new inode.
describe("build_native replaceFileAtomically", () => {
  let root: string;
  let prebuild: string;
  let destination: string;
  let source: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "exifcleaner-build-native-"));
    prebuild = join(root, "prebuilds", "tuple");
    destination = join(prebuild, "publication.node");
    source = join(root, "built.node");
    mkdirSync(prebuild, { recursive: true });
    writeFileSync(destination, Buffer.from("previous addon bytes"));
    writeFileSync(source, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 0]));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("publishes identical bytes on a new inode and leaves the old inode untouched", async () => {
    // A hard link stands in for a process that has the old addon mapped.
    const loadedAlias = join(root, "loaded.node");
    linkSync(destination, loadedAlias);
    const before = statSync(destination);

    await replaceFileAtomically(source, destination);

    expect(readFileSync(destination)).toEqual(readFileSync(source));
    expect(statSync(destination).ino).not.toBe(before.ino);
    expect(readFileSync(loadedAlias).toString()).toBe("previous addon bytes");
    expect(readdirSync(prebuild)).toEqual(["publication.node"]);
  });

  it("creates the destination when none exists", async () => {
    rmSync(destination);
    await replaceFileAtomically(source, destination);
    expect(readFileSync(destination)).toEqual(readFileSync(source));
    expect(readdirSync(prebuild)).toEqual(["publication.node"]);
  });

  it("removes its temporary sibling and keeps the destination when the copy fails", async () => {
    await expect(
      replaceFileAtomically(join(root, "missing.node"), destination),
    ).rejects.toThrow();
    expect(readFileSync(destination).toString()).toBe("previous addon bytes");
    expect(readdirSync(prebuild)).toEqual(["publication.node"]);
  });

  it("removes its temporary sibling when the rename fails", async () => {
    // Renaming a file over a non-empty directory fails on every platform.
    rmSync(destination);
    mkdirSync(destination);
    writeFileSync(join(destination, "occupied"), "x");
    await expect(replaceFileAtomically(source, destination)).rejects.toThrow();
    expect(readdirSync(prebuild)).toEqual(["publication.node"]);
  });
});
