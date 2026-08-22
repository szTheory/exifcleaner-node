#!/usr/bin/env node

const { readFileSync } = require("node:fs");

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const version = packageJson.version;

if (typeof version !== "string" || version === "0.0.0") {
  throw new Error(
    `Refusing to release placeholder package version ${JSON.stringify(version)}`,
  );
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Package version is not a publishable semver: ${version}`);
}

if (process.env.EVENT_NAME === "push") {
  if (process.env.REF_PROTECTED !== "true") {
    throw new Error(
      "Release tags must be protected by a GitHub repository ruleset",
    );
  }
  const expectedRef = `refs/tags/v${version}`;
  if (process.env.RELEASE_REF !== expectedRef) {
    throw new Error(
      `Release tag must exactly match package.json: expected ${expectedRef}, got ${process.env.RELEASE_REF}`,
    );
  }
}

console.log(`Release guard accepted ${packageJson.name}@${version}`);
