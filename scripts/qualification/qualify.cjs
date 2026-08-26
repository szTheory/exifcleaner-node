const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const args = process.argv.slice(2);
const caseIndex = args.indexOf("--case");
const caseId = caseIndex >= 0 ? args[caseIndex + 1] : undefined;
const json = args.includes("--json");

if (
  caseId === undefined ||
  args.length !== (json ? 3 : 2) ||
  args[caseIndex + 1]?.startsWith("-")
) {
  process.stderr.write(
    "Usage: node scripts/qualification/qualify.cjs --case <id> [--json]\\n",
  );
  process.exitCode = 2;
} else {
  const moduleUrl = pathToFileURL(
    resolve(__dirname, "../../tests/qualification/corpus.ts"),
  ).href;
  const program = `import { runQualificationCase } from ${JSON.stringify(moduleUrl)}; const result = await runQualificationCase(${JSON.stringify(caseId)}); process.stdout.write(JSON.stringify(result) + "\\n");`;
  const completed = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", program],
    {
      cwd: resolve(__dirname, "../.."),
      encoding: "utf8",
    },
  );
  if (completed.stdout) process.stdout.write(completed.stdout);
  if (completed.stderr) process.stderr.write(completed.stderr);
  process.exitCode = completed.status ?? 1;
}
