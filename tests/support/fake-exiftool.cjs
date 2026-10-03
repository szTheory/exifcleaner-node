#!/usr/bin/env node
"use strict";

/*
 * A stand-in for ExifTool's `-stay_open True -@ -` protocol (62.1-12, D-30),
 * so tests of scripts/qualification/native-vs-exiftool.cjs never need real
 * ExifTool. It reads one argument per stdin line and treats `-execute<N>` as
 * the end of a command. For a `-o <dest> <src>` command it copies <src> to
 * <dest> and answers `{ready<N>}`, the way ExifTool does. `-ver` prints a
 * version. `-stay_open` followed by `False` ends the session.
 *
 * Test knobs (environment):
 * - FAKE_EXIFTOOL_PID_FILE: write this process's pid there once a write
 *   command has arrived (the "mid-file" signal for the interrupt test).
 * - FAKE_EXIFTOOL_HANG=1: never answer a write command (mid-file forever).
 * - FAKE_EXIFTOOL_SKIP_OUTPUT=1: answer `{ready<N>}` without creating <dest>.
 */

const fs = require("node:fs");
const readline = require("node:readline");

const pidFile = process.env.FAKE_EXIFTOOL_PID_FILE;
const hang = process.env.FAKE_EXIFTOOL_HANG === "1";
const skipOutput = process.env.FAKE_EXIFTOOL_SKIP_OUTPUT === "1";

const stayOpenIndex = process.argv.indexOf("-stay_open");
if (
  stayOpenIndex === -1 ||
  process.argv[stayOpenIndex + 1] !== "True" ||
  !process.argv.includes("-@")
) {
  process.stderr.write("fake-exiftool: expected -stay_open True -@ -\n");
  process.exit(2);
}

let args = [];
let closing = false;
const lines = readline.createInterface({ input: process.stdin });

lines.on("line", (line) => {
  if (closing) {
    if (line === "False") process.exit(0);
    closing = false;
  }
  if (line === "-stay_open") {
    closing = true;
    return;
  }
  const execute = /^-execute(\d*)$/u.exec(line);
  if (execute === null) {
    args.push(line);
    return;
  }
  const command = args;
  args = [];
  respond(command, execute[1]);
});

lines.on("close", () => process.exit(0));

function respond(command, number) {
  if (command.includes("-ver")) {
    process.stdout.write(`13.59\n{ready${number}}\n`);
    return;
  }
  const outputIndex = command.indexOf("-o");
  const destination = command[outputIndex + 1];
  const source = command[command.length - 1];
  if (pidFile !== undefined) {
    // Written to a sibling and renamed, so the pid file never exists empty: the interrupt test
    // signals as soon as it exists, and the runner's process-group SIGKILL could otherwise land
    // between writeFileSync's open and write (measured: fakePid read as 0 under full-suite load).
    fs.writeFileSync(`${pidFile}.partial`, String(process.pid));
    fs.renameSync(`${pidFile}.partial`, pidFile);
  }
  if (hang) return;
  if (!skipOutput) fs.copyFileSync(source, destination);
  process.stdout.write(`    1 image files created\n{ready${number}}\n`);
}
