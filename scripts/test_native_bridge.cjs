#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const root = resolve(__dirname, "..");
const temporary = mkdtempSync(
  join(tmpdir(), "exifcleaner-native-publication-"),
);
const source = join(root, "native", "publication.c");
const executable = join(
  temporary,
  process.platform === "win32" ? "publication.exe" : "publication",
);
const stage = join(temporary, "stage.bin");
const destination = join(temporary, "destination.bin");

function run(file, args) {
  return execFileSync(file, args, {
    cwd: temporary,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

try {
  if (process.platform === "win32") {
    run("cl", [
      "/nologo",
      "/DPUBLICATION_STANDALONE_TEST",
      source,
      `/Fe:${executable}`,
    ]);
  } else {
    run("cc", [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-DPUBLICATION_STANDALONE_TEST",
      source,
      "-o",
      executable,
    ]);
  }

  writeFileSync(stage, "stage-success", "utf8");
  const success = run(executable, [stage, destination]);
  if (
    !success.includes("published") ||
    readFileSync(destination, "utf8") !== "stage-success" ||
    existsSync(stage)
  ) {
    throw new Error(
      "successful publication did not move the exact stage bytes once",
    );
  }

  writeFileSync(stage, "stage-collision", "utf8");
  writeFileSync(destination, "competitor", "utf8");
  let collision = null;
  try {
    run(executable, [stage, destination]);
  } catch (error) {
    collision = error;
  }
  if (
    collision === null ||
    collision.status !== 10 ||
    readFileSync(destination, "utf8") !== "competitor" ||
    readFileSync(stage, "utf8") !== "stage-collision"
  ) {
    throw new Error(
      "competitor collision changed destination or published the stage",
    );
  }
  console.log("Native publication bridge passed");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
