// Commit-bound, function-scoped deletion receipts (D-18/D-21). Builtins only.
//
// validateDeletion returns one stable contract for both consumers:
//   { problems: string[], edits: validated edit records[], anchors: [{current, original}],
//     removedMutants: canonical affected records[] }
// `anchors` only contains uniquely mapped live mutants. A missing mapping is
// never evidence of deletion; callers must consult `problems` and the exact
// removed-mutant inventory.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { anchorKey, mutantKey } from "./identity.mjs";
import { enclosingFunction } from "./cluster.mjs";

const DIRECTIVE = /^\s*\/\/ Stryker (?:disable|restore)\b/;
const DETECTED = new Set(["Killed", "Timeout"]);
const ISOBMFF_ADMISSION_BASE = "cb8eedde27eaa6b2a54cb9f2008d91292a8b3bba";
const ILOC_BOUNDARY_BASE = "cb8eedde27eaa6b2a54cb9f2008d91292a8b3bba";
const ILOC_BOUNDARY_SOURCE_SHA256 =
  "3771d0e23a5f8c1b5dc3859ec5024b205366752f170858e362744e586e8aa338";
const ILOC_BOUNDARY_BEFORE_REPORT_SHA256 =
  "62cd1c66845a7707d5cca3c4484fc161139b26daa64875c5bba72ec3582ac502";
const ILOC_BOUNDARY_BEFORE_EVIDENCE_SHA256 =
  "66ab13e3ea1ae914d86e03c841a7a16ce371266e4b7fe5c884383d90a8d691c4";
const ILOC_BOUNDARY_FINAL_SOURCE_SHA256 =
  "7201af97a6ec2780dec9d1161f6a3be57ce61b36cead4ec1dfe89c1120069d19";
const ILOC_BOUNDARY_DIRECTIVE =
  "// Stryker disable next-line ConditionalExpression: redundant-guard-after-typed-check — validated nibble width is nonnegative; zero-width reads consume no bytes and preserve position.";
const ILOC_HEADER_KEY = [
  "src/isobmff/iloc.ts",
  "EqualityOperator",
  "payload.length <= 2",
  133,
  7,
  133,
  25,
].join("\0");
const ILOC_INDEX_KEY = [
  "src/isobmff/iloc.ts",
  "EqualityOperator",
  "indexSize >= 0",
  226,
  34,
  226,
  47,
].join("\0");
const ILOC_INDEX_TRUE_KEY = [
  "src/isobmff/iloc.ts",
  "ConditionalExpression",
  "true",
  226,
  34,
  226,
  47,
].join("\0");
const ILOC_BOUNDARY_EDITS = Object.freeze([
  Object.freeze({
    operation: "iloc-header-integer-boundary",
    function: "parseIloc",
    before: "payload.length < 2",
    after: "payload.length <= 1",
    occurrence: 0,
  }),
  Object.freeze({
    operation: "iloc-index-nonzero-boundary",
    function: "parseIloc",
    before: "if (layout.hasIndexSize && indexSize > 0)",
    after:
      "if (\n        layout.hasIndexSize &&\n        indexSize !== 0\n      )",
    occurrence: 0,
  }),
]);
const ISOBMFF3_SOURCE_FILES = Object.freeze([
  "src/isobmff/brand.ts",
  "src/isobmff/caps.ts",
  "src/isobmff/iloc.ts",
  "src/isobmff/ipma.ts",
]);
const hex256 = /^[a-f0-9]{64}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};
const normalizeDirectives = (source) =>
  source
    .split("\n")
    .filter((line) => !DIRECTIVE.test(line))
    .join("\n");
const show = (key) => String(key).replaceAll("\u0000", "|");

function safeRelative(root, relative, label) {
  if (
    typeof relative !== "string" ||
    relative === "" ||
    isAbsolute(relative) ||
    relative.split(/[\\/]/).includes("..")
  )
    throw new Error(`${label}: unsafe relative path`);
  const path = resolve(root, relative);
  if (path !== root && !path.startsWith(`${root}${sep}`))
    throw new Error(`${label}: path escapes root`);
  if (existsSync(path)) {
    const actual = realpathSync(path),
      base = realpathSync(root);
    if (actual !== base && !actual.startsWith(`${base}${sep}`))
      throw new Error(`${label}: symlink escapes root`);
    return actual;
  }
  return path;
}

function gitSource(root, ref, file) {
  if (
    typeof ref !== "string" ||
    ref === "" ||
    ref.startsWith("-") ||
    ref.includes("\0")
  )
    throw new Error("beforeRef is missing or invalid");
  const safeFile = file.replaceAll("\\", "/");
  if (
    !safeFile ||
    safeFile.startsWith("/") ||
    safeFile.split("/").includes("..")
  )
    throw new Error("receipt file path is unsafe");
  try {
    return execFileSync("git", ["show", `${ref}:${safeFile}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `beforeRef source unavailable (${ref}:${safeFile}); full history is required and no fetch fallback is allowed`,
    );
  }
}

// Mask comments and literals while preserving every UTF-16 offset. This small
// lexical pass is sufficient to select brace-delimited function bodies without
// mistaking braces in strings/comments for syntax; it intentionally fails closed
// when a named body cannot be selected uniquely.
function maskNonCode(source) {
  const chars = source.split("");
  let quote = null,
    lineComment = false,
    blockComment = false,
    escaped = false;
  for (let i = 0; i < chars.length; i++) {
    const c = source[i],
      n = source[i + 1];
    if (lineComment) {
      if (c === "\n") lineComment = false;
      else chars[i] = " ";
      continue;
    }
    if (blockComment) {
      if (c === "*" && n === "/") {
        chars[i] = chars[i + 1] = " ";
        i++;
        blockComment = false;
      } else if (c !== "\n") chars[i] = " ";
      continue;
    }
    if (quote !== null) {
      if (c !== "\n") chars[i] = " ";
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && n === "/") {
      chars[i] = chars[i + 1] = " ";
      i++;
      lineComment = true;
      continue;
    }
    if (c === "/" && n === "*") {
      chars[i] = chars[i + 1] = " ";
      i++;
      blockComment = true;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      chars[i] = " ";
    }
  }
  return chars.join("");
}

function matching(mask, open, left = "{", right = "}") {
  let depth = 0;
  for (let i = open; i < mask.length; i++) {
    if (mask[i] === left) depth++;
    else if (mask[i] === right && --depth === 0) return i;
  }
  return -1;
}

export function functionBounds(source, name) {
  if (!/^[A-Za-z_$][\w$]*$/.test(name))
    throw new Error(`invalid function name ${JSON.stringify(name)}`);
  const mask = maskNonCode(source);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = new RegExp(`\\b${escaped}\\b`, "g");
  const containers = [];
  const stack = [];
  for (let at = 0; at < mask.length; at++) {
    if (mask[at] === "{") {
      const boundary = Math.max(
        mask.lastIndexOf("}", at - 1),
        mask.lastIndexOf(";", at - 1),
      );
      const prefix = mask.slice(boundary + 1, at);
      const kind =
        /\bclass\s+[A-Za-z_$][\w$]*(?:\s+extends\b[\s\S]*)?\s*$/.test(prefix)
          ? "class"
          : /(?:=|:|\breturn|\(|,)\s*$/.test(prefix)
            ? "object"
            : "block";
      stack.push(kind);
      containers[at] = stack.at(-1);
    } else if (mask[at] === "}") {
      stack.pop();
    }
  }

  const bodyAfterParameters = (at) => {
    const suffix = mask.slice(at + name.length);
    if (!/^\s*\(/.test(suffix)) return -1;
    const paren = suffix.indexOf("(");
    const close = matching(suffix, paren, "(", ")");
    if (close < 0) return -1;
    const rest = suffix.slice(close + 1);
    const body = /^(?:\s*)(?::[^{}]*?)?\s*\{/.exec(rest);
    return body ? at + name.length + close + 1 + body[0].lastIndexOf("{") : -1;
  };

  const arrowBody = (at) => {
    const prefix = mask.slice(Math.max(0, at - 120), at);
    if (!/\b(?:const|let|var)\s+$/.test(prefix)) return -1;
    let rest = mask.slice(at + name.length);
    const assignment = /^\s*=\s*(?:async\s+)?/.exec(rest);
    if (!assignment) return -1;
    rest = rest.slice(assignment[0].length);
    let afterParameters;
    if (rest.startsWith("(")) {
      const close = matching(rest, 0, "(", ")");
      if (close < 0) return -1;
      afterParameters = rest.slice(close + 1);
    } else {
      const parameter = /^[A-Za-z_$][\w$]*/.exec(rest);
      if (!parameter) return -1;
      afterParameters = rest.slice(parameter[0].length);
    }
    const body = /^\s*=>\s*\{/.exec(afterParameters);
    if (!body) return -1;
    return (
      at +
      name.length +
      assignment[0].length +
      rest.length -
      afterParameters.length +
      body[0].lastIndexOf("{")
    );
  };

  const bodies = [];
  for (const m of mask.matchAll(token)) {
    const at = m.index;
    const prefix = mask.slice(Math.max(0, at - 80), at);
    let body = -1;
    if (/\bfunction\s*\*?\s*$/.test(prefix)) body = bodyAfterParameters(at);
    else {
      body = arrowBody(at);
      if (
        body < 0 &&
        containers[mask.lastIndexOf("{", at - 1)] &&
        ["class", "object"].includes(containers[mask.lastIndexOf("{", at - 1)])
      ) {
        const boundary = Math.max(
          mask.lastIndexOf("{", at - 1),
          mask.lastIndexOf("}", at - 1),
          mask.lastIndexOf(",", at - 1),
          mask.lastIndexOf(";", at - 1),
        );
        const memberPrefix = mask.slice(boundary + 1, at);
        if (
          /^\s*(?:(?:async|static|public|private|protected|readonly|override|abstract|get|set)\s+)*\*?\s*$/.test(
            memberPrefix,
          )
        )
          body = bodyAfterParameters(at);
      }
    }
    if (body < 0 || mask[body] !== "{") continue;
    const end = matching(mask, body);
    if (end < 0) continue;
    bodies.push({ start: body, end: end + 1, function: name });
  }
  if (bodies.length !== 1)
    throw new Error(
      `function ${name} is ${bodies.length === 0 ? "missing" : "ambiguous"}`,
    );
  return bodies[0];
}

export function applyEdits(source, edits) {
  let current = source;
  const validated = [];
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index];
    const operationIndex = ILOC_BOUNDARY_EDITS.findIndex(
      (allowed) =>
        allowed.operation === edit?.operation &&
        allowed.function === edit?.function &&
        allowed.before === edit?.before &&
        allowed.after === edit?.after &&
        allowed.occurrence === edit?.occurrence,
    );
    const closedIlocEdit = operationIndex !== -1;
    const deleteOnly =
      edit?.operation === undefined &&
      typeof edit?.before === "string" &&
      typeof edit?.after === "string" &&
      (edit.after === "" ||
        (edit.before.includes(edit.after) &&
          edit.before.indexOf(edit.after) ===
            edit.before.lastIndexOf(edit.after)));
    if (
      !edit ||
      typeof edit.function !== "string" ||
      typeof edit.before !== "string" ||
      edit.before === "" ||
      typeof edit.after !== "string" ||
      edit.before === edit.after ||
      !(deleteOnly || closedIlocEdit) ||
      !Number.isInteger(edit.occurrence) ||
      edit.occurrence < 0
    )
      throw new Error(`edit ${index}: empty, ambiguous or non-deletion edit`);
    const bounds = functionBounds(current, edit.function);
    const body = current.slice(bounds.start, bounds.end);
    const positions = [];
    let from = 0,
      at;
    while ((at = body.indexOf(edit.before, from)) !== -1) {
      positions.push(bounds.start + at);
      from = at + Math.max(1, edit.before.length);
    }
    if (positions.length <= edit.occurrence)
      throw new Error(
        `edit ${index}: exact expression occurrence ${edit.occurrence} is missing`,
      );
    const selected = positions[edit.occurrence];
    const lexical = maskNonCode(current).slice(
      selected,
      selected + edit.before.length,
    );
    const lexicalPattern = maskNonCode(edit.before);
    if (
      !/\S/.test(lexicalPattern) ||
      lexical.replace(/\s/g, "") !== lexicalPattern.replace(/\s/g, "")
    )
      throw new Error(
        `edit ${index}: selected occurrence is not an exact lexical source expression`,
      );
    const originalStart = mapOffsetToOriginal(selected, validated, "start");
    if (originalStart === null)
      throw new Error(
        `edit ${index}: overlaps or edits previously inserted text`,
      );
    if (
      source.slice(originalStart, originalStart + edit.before.length) !==
      edit.before
    )
      throw new Error(
        `edit ${index}: exact text does not correspond to the pinned before source`,
      );
    for (const prior of validated) {
      const delta = edit.after.length - edit.before.length;
      if (selected + edit.before.length <= prior.currentStart) {
        prior.currentStart += delta;
        prior.currentEnd += delta;
        prior.currentAfterEnd += delta;
      } else if (
        selected < prior.currentEnd &&
        selected + edit.before.length > prior.currentStart
      ) {
        throw new Error(`edit ${index}: overlaps an earlier edit`);
      }
    }
    current =
      current.slice(0, selected) +
      edit.after +
      current.slice(selected + edit.before.length);
    validated.push({
      ...edit,
      start: originalStart,
      end: originalStart + edit.before.length,
      originalStart,
      stageStart: selected,
      currentStart: selected,
      currentEnd: selected + edit.before.length,
      currentAfterEnd: selected + edit.after.length,
    });
  }
  return { source: current, edits: validated };
}

function mapOffsetToOriginal(offset, priorEdits, boundary = "start") {
  let at = offset;
  for (let i = priorEdits.length - 1; i >= 0; i--) {
    const edit = priorEdits[i];
    const afterStart = edit.stageStart;
    const afterEnd = afterStart + edit.after.length;
    if (at < afterStart) continue;
    if (at <= afterEnd) {
      if (edit.operation !== undefined) {
        if (at === afterStart) return edit.originalStart;
        if (at === afterEnd) return edit.originalEnd;
        return null;
      }
      if (edit.after === "") {
        if (at !== afterStart) return null;
        return boundary === "start" ? edit.end : edit.start;
      }
      const index = edit.before.indexOf(edit.after);
      if (index === -1 || edit.before.indexOf(edit.after, index + 1) !== -1)
        return null;
      return (
        edit.originalStart +
        index +
        Math.min(at - afterStart, edit.after.length)
      );
    }
    at += edit.before.length - edit.after.length;
  }
  return at;
}

function pointAt(source, offset) {
  const prefix = source.slice(0, offset);
  const line = prefix.split("\n");
  return { line: line.length, column: line.at(-1).length + 1 };
}

function offsetAt(source, point) {
  const lines = source.split("\n");
  if (
    !point ||
    !Number.isInteger(point.line) ||
    !Number.isInteger(point.column) ||
    point.line < 1 ||
    point.column < 1 ||
    point.line > lines.length ||
    point.column > lines[point.line - 1].length + 1
  )
    throw new Error("mutant location is outside source bounds");
  let offset = point.column - 1;
  for (let i = 0; i < point.line - 1; i++) offset += lines[i].length + 1;
  return offset;
}

function toNormalizedLocation(source, location) {
  const lines = source.split("\n");
  const removedBefore = (line) =>
    lines.slice(0, line - 1).filter((item) => DIRECTIVE.test(item)).length;
  return {
    start: {
      ...location.start,
      line: location.start.line - removedBefore(location.start.line),
    },
    end: {
      ...location.end,
      line: location.end.line - removedBefore(location.end.line),
    },
  };
}

function evidenceParts(evidence, file) {
  if (!evidence || typeof evidence !== "object")
    throw new Error("beforeEvidence is missing");
  if (typeof evidence.source === "string" && Array.isArray(evidence.mutants))
    return {
      source: evidence.source,
      mutants: evidence.mutants,
      testFiles: evidence.testFiles ?? {},
    };
  const entry = evidence.files?.[file];
  if (entry && typeof entry.source === "string" && Array.isArray(entry.mutants))
    return {
      source: entry.source,
      mutants: entry.mutants,
      testFiles: evidence.testFiles ?? {},
    };
  throw new Error(
    "beforeEvidence must contain the complete file source and mutant table",
  );
}

function resolvedTests(report, mutant) {
  const byId = new Map();
  for (const [file, entry] of Object.entries(report.testFiles ?? {}))
    for (const test of entry.tests ?? [])
      byId.set(String(test.id), { file, name: test.name });
  return (mutant.killedBy ?? [])
    .map((id) => byId.get(String(id)))
    .filter(Boolean)
    .map(({ file, name }) => ({ file, name }))
    .sort(
      (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name),
    );
}

function referencedTests(report, mutants) {
  const ids = new Set(
    mutants.flatMap((mutant) => (mutant.killedBy ?? []).map(String)),
  );
  const files = {};
  for (const [file, entry] of Object.entries(report.testFiles ?? {})) {
    const tests = (entry.tests ?? []).filter((test) =>
      ids.has(String(test.id)),
    );
    if (tests.length) files[file] = { ...entry, tests };
  }
  return files;
}

function rawRecord(file, mutant, source, report) {
  const normalizedLocation = toNormalizedLocation(source, mutant.location);
  return {
    anchor: anchorKey(
      file,
      { ...mutant, location: normalizedLocation },
      normalizeDirectives(source),
    ),
    mutatorName: mutant.mutatorName,
    replacement: mutant.replacement ?? "",
    location: mutant.location,
    status: mutant.status,
    ...(mutant.statusReason === undefined
      ? {}
      : { statusReason: mutant.statusReason }),
    killedBy: resolvedTests(report, mutant),
  };
}

function assertIlocBeforeEvidence(evidence, survivors) {
  const file = "src/isobmff/iloc.ts";
  if (!Array.isArray(survivors) || evidence.mutants.length !== 158)
    throw new Error(
      "iloc before evidence is not the complete 158-mutant file report",
    );
  const normalizedSource = normalizeDirectives(evidence.source);
  const records = evidence.mutants.map((mutant) => {
    const location = toNormalizedLocation(evidence.source, mutant.location);
    return {
      mutant,
      key: mutantKey(file, { ...mutant, location }),
      anchor: anchorKey(file, { ...mutant, location }, normalizedSource),
    };
  });
  const unique = (predicate, label) => {
    const found = records.filter(predicate);
    if (found.length !== 1)
      throw new Error(
        `iloc before evidence has ${found.length} ${label} records`,
      );
    return found[0];
  };
  const requireSnapshotMember = (key, anchor, label) => {
    const matches = survivors.filter((member) => member.key === key);
    if (
      matches.length !== 1 ||
      matches[0].anchorKey !== anchor ||
      matches[0].status !== "Survived"
    )
      throw new Error(
        `iloc ${label} does not match its immutable original survivor`,
      );
  };
  const headerSurvivor = unique(
    (record) =>
      record.key === ILOC_HEADER_KEY && record.mutant.status === "Survived",
    "header equality survivor",
  );
  const indexSurvivor = unique(
    (record) =>
      record.key === ILOC_INDEX_KEY && record.mutant.status === "Survived",
    "index equality survivor",
  );
  requireSnapshotMember(
    ILOC_HEADER_KEY,
    headerSurvivor.anchor,
    "header equality key",
  );
  requireSnapshotMember(
    ILOC_INDEX_KEY,
    indexSurvivor.anchor,
    "index equality key",
  );
  const indexTrue = unique(
    (record) =>
      record.key === ILOC_INDEX_TRUE_KEY &&
      record.anchor ===
        [file, "ConditionalExpression", "true", "indexSize > 0", 0].join(
          "\0",
        ) &&
      record.mutant.status === "Survived",
    "inner ConditionalExpression survivor",
  );
  requireSnapshotMember(
    ILOC_INDEX_TRUE_KEY,
    indexTrue.anchor,
    "inner ConditionalExpression key",
  );
  unique(
    (record) =>
      record.mutant.mutatorName === "EqualityOperator" &&
      record.mutant.replacement === "payload.length >= 2" &&
      record.mutant.status === "Killed",
    "detected header opposite",
  );
  unique(
    (record) =>
      record.mutant.mutatorName === "EqualityOperator" &&
      record.mutant.replacement === "indexSize <= 0" &&
      record.mutant.status === "Killed",
    "detected index opposite",
  );
  for (const replacement of ["true", "false"])
    unique(
      (record) =>
        record.mutant.mutatorName === "ConditionalExpression" &&
        record.mutant.replacement === replacement &&
        record.anchor ===
          [
            file,
            "ConditionalExpression",
            replacement,
            "layout.hasIndexSize && indexSize > 0",
            0,
          ].join("\0") &&
        record.mutant.status === "Killed",
      `detected outer ${replacement} condition`,
    );
  unique(
    (record) =>
      record.mutant.mutatorName === "LogicalOperator" &&
      record.mutant.replacement === "layout.hasIndexSize || indexSize > 0" &&
      record.mutant.status === "Killed",
    "detected outer logical operator",
  );
}

function assertIlocFinalEvidence(finalEntry, finalReport, root, readTest) {
  if (
    !finalReport.files?.["src/isobmff/iloc.ts"] ||
    finalReport.files["src/isobmff/iloc.ts"] !== finalEntry ||
    hash(finalEntry.source ?? "") !== ILOC_BOUNDARY_FINAL_SOURCE_SHA256 ||
    (finalEntry.mutants ?? []).length !== 157
  )
    throw new Error(
      "iloc final evidence differs from the measured 157-mutant source stage",
    );
  const lines = String(finalEntry.source ?? "").split("\n");
  const directiveLines = lines.flatMap((line, index) =>
    line.trim() === ILOC_BOUNDARY_DIRECTIVE ? [index] : [],
  );
  if (
    directiveLines.length !== 1 ||
    lines[directiveLines[0] + 1]?.trim() !== "indexSize !== 0"
  )
    throw new Error(
      "iloc final evidence lacks the exact next-line ConditionalExpression directive",
    );
  const testIds = new Map();
  for (const [file, entry] of Object.entries(finalReport.testFiles ?? {})) {
    if (
      typeof entry.source !== "string" ||
      entry.source.length === 0 ||
      !Array.isArray(entry.tests)
    )
      throw new Error(`iloc final test evidence is incomplete for ${file}`);
    const path = safeRelative(root, file, "iloc final test");
    const source = readTest ? readTest(file) : readFileSync(path, "utf8");
    if (source !== entry.source)
      throw new Error(`iloc final test source is absent or stale for ${file}`);
    for (const test of entry.tests) {
      if (
        !test?.id ||
        typeof test.name !== "string" ||
        test.name.trim() === "" ||
        testIds.has(String(test.id))
      )
        throw new Error(
          `iloc final test table has an empty, unnamed or duplicate row in ${file}`,
        );
      testIds.set(String(test.id), { file, name: test.name });
    }
  }
  for (const mutant of finalEntry.mutants ?? [])
    if (DETECTED.has(mutant.status)) {
      if (
        !Array.isArray(mutant.killedBy) ||
        mutant.killedBy.some((id) => String(id).trim() === "") ||
        new Set(mutant.killedBy.map(String)).size !== mutant.killedBy.length
      )
        throw new Error(
          `iloc final ${mutant.status} mutant ${mutant.id} has empty or duplicate killedBy IDs`,
        );
      const killedBy = (mutant.killedBy ?? [])
        .map((id) => testIds.get(String(id)))
        .filter(Boolean);
      if (
        killedBy.length === 0 ||
        killedBy.length !== (mutant.killedBy ?? []).length
      )
        throw new Error(
          `iloc final ${mutant.status} mutant ${mutant.id} has unresolved killedBy test evidence`,
        );
    }
}

function readCommittedReportFixture(root, relative, label) {
  const path = safeRelative(root, relative, label);
  const base = realpathSync(root);
  const expected = resolve(base, relative);
  if (path !== expected)
    throw new Error(`${label}: fixture path contains a symlink component`);
  const stat = lstatSync(expected);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${label}: fixture is not a regular contained file`);
  return readFileSync(expected);
}

function selectIlocReportBinding(receipt, finalReport, root) {
  const reportFiles = Object.keys(finalReport?.files ?? {}).sort();
  if (reportFiles.length === 1 && reportFiles[0] === "src/isobmff/iloc.ts")
    return null;
  if (canonical(reportFiles) !== canonical([...ISOBMFF3_SOURCE_FILES].sort()))
    throw new Error(
      "iloc final report is not the complete measured isobmff-3 source inventory",
    );

  const bindings = receipt.reportBindings;
  if (!Array.isArray(bindings) || bindings.length === 0)
    throw new Error(
      "iloc final report has no committed report-specific bindings",
    );
  const canonicalIds = new Set(),
    fixturePaths = new Set();
  for (const binding of bindings) {
    if (
      !binding ||
      typeof binding !== "object" ||
      !hex256.test(binding.canonicalSha256 ?? "") ||
      !Array.isArray(binding.variants) ||
      binding.variants.length === 0 ||
      !Array.isArray(binding.successors)
    )
      throw new Error("iloc report-specific binding is malformed");
    if (canonicalIds.has(binding.canonicalSha256))
      throw new Error(
        "iloc report-specific registry has a duplicate report identity",
      );
    canonicalIds.add(binding.canonicalSha256);
    const rawIds = new Set();
    for (const variant of binding.variants) {
      if (
        !variant ||
        !hex256.test(variant.rawSha256 ?? "") ||
        !Number.isSafeInteger(variant.rawBytes) ||
        variant.rawBytes < 1 ||
        !Array.isArray(variant.fixtures) ||
        variant.fixtures.length === 0 ||
        rawIds.has(variant.rawSha256)
      )
        throw new Error(
          "iloc report-specific raw variant is malformed or duplicated",
        );
      rawIds.add(variant.rawSha256);
      for (const fixture of variant.fixtures) {
        if (
          !fixture ||
          typeof fixture.path !== "string" ||
          !hex256.test(fixture.gzipSha256 ?? "") ||
          !Number.isSafeInteger(fixture.gzipBytes) ||
          fixture.gzipBytes < 1 ||
          fixturePaths.has(fixture.path)
        )
          throw new Error(
            "iloc report-specific fixture registration is malformed or duplicated",
          );
        fixturePaths.add(fixture.path);
      }
    }
  }

  const actualCanonicalSha256 = hash(canonical(finalReport));
  const matches = bindings.filter(
    (binding) => binding.canonicalSha256 === actualCanonicalSha256,
  );
  if (matches.length !== 1)
    throw new Error(
      `iloc report identity selects ${matches.length} committed report-specific bindings`,
    );
  const binding = matches[0];
  for (const variant of binding.variants)
    for (const fixture of variant.fixtures) {
      const compressed = readCommittedReportFixture(
        root,
        fixture.path,
        "iloc report fixture",
      );
      if (
        compressed.length !== fixture.gzipBytes ||
        hash(compressed) !== fixture.gzipSha256
      )
        throw new Error(
          "iloc registered report fixture compressed bytes or digest mismatch",
        );
      let raw;
      try {
        raw = gunzipSync(compressed);
      } catch {
        throw new Error(
          "iloc registered report fixture is not valid gzip evidence",
        );
      }
      if (raw.length !== variant.rawBytes || hash(raw) !== variant.rawSha256)
        throw new Error(
          "iloc registered report fixture raw bytes or digest mismatch",
        );
      let parsed;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new Error(
          "iloc registered report fixture is not valid report JSON",
        );
      }
      if (
        hash(canonical(parsed)) !== binding.canonicalSha256 ||
        canonical(parsed) !== canonical(finalReport)
      )
        throw new Error(
          "iloc registered fixture does not match the complete supplied report identity",
        );
    }

  const declared = receipt.detectedSuccessors;
  if (!Array.isArray(declared) || declared.length === 0)
    throw new Error(
      "iloc receipt has no detected successors for report-specific attribution",
    );
  const declaredByOld = new Map();
  for (const successor of declared) {
    if (
      !successor ||
      typeof successor.oldAnchor !== "string" ||
      typeof successor.finalAnchor !== "string" ||
      declaredByOld.has(successor.oldAnchor)
    )
      throw new Error(
        "iloc receipt has a malformed or duplicate detected successor",
      );
    declaredByOld.set(successor.oldAnchor, successor);
  }
  if (binding.successors.length !== declared.length)
    throw new Error(
      "iloc report-specific binding does not cover every declared detected successor",
    );
  const byOld = new Map();
  for (const successor of binding.successors) {
    const expected = declaredByOld.get(successor?.oldAnchor);
    const test = successor?.test;
    if (
      !expected ||
      expected.finalAnchor !== successor.finalAnchor ||
      byOld.has(successor.oldAnchor) ||
      !test ||
      typeof test.id !== "string" ||
      test.id.trim() === "" ||
      typeof test.file !== "string" ||
      test.file.trim() === "" ||
      typeof test.name !== "string" ||
      test.name.trim() === "" ||
      !hex256.test(test.sourceSha256 ?? "")
    )
      throw new Error(
        "iloc report-specific successor identity or direct-test binding is malformed",
      );
    byOld.set(successor.oldAnchor, successor);
  }
  if (
    byOld.size !== declaredByOld.size ||
    [...declaredByOld.keys()].some((key) => !byOld.has(key))
  )
    throw new Error(
      "iloc report-specific binding omits a declared detected successor",
    );
  return { ...binding, successorsByOld: byOld };
}

export function affectedBy(mutant, source, edits) {
  let start, end;
  try {
    const location = toNormalizedLocation(source, mutant.location);
    start = offsetAt(normalizeDirectives(source), location.start);
    end = offsetAt(normalizeDirectives(source), location.end);
  } catch {
    return false;
  }
  return edits.some((edit) => start < edit.end && end > edit.start);
}

function mapFinalOffsetToBefore(offset, edits, boundary) {
  return mapOffsetToOriginal(offset, edits, boundary);
}

function validateIlocOperationChain(row, receipt, beforeSource) {
  const usesIlocOperation = (receipt.edits ?? []).some(
    (edit) =>
      typeof edit?.operation === "string" && edit.operation.startsWith("iloc-"),
  );
  if (!usesIlocOperation) return false;
  if (
    row.file !== "src/isobmff/iloc.ts" ||
    row.function !== "parseIloc" ||
    row.mutatorName !== "EqualityOperator" ||
    row.disposition !== "dead"
  )
    throw new Error(
      "iloc boundary operations are restricted to parseIloc EqualityOperator dead rows",
    );
  if (receipt.beforeRef !== ILOC_BOUNDARY_BASE)
    throw new Error(
      `iloc boundary receipts must use permanent beforeRef ${ILOC_BOUNDARY_BASE}`,
    );
  if (hash(normalizeDirectives(beforeSource)) !== ILOC_BOUNDARY_SOURCE_SHA256)
    throw new Error(
      "iloc boundary source differs from the pinned ancestor after directive normalization",
    );
  if (receipt.beforeReportSha256 !== ILOC_BOUNDARY_BEFORE_REPORT_SHA256)
    throw new Error(
      "iloc boundary before report digest is not the retained full-file Stryker report",
    );
  if (
    !Array.isArray(receipt.edits) ||
    receipt.edits.length !== ILOC_BOUNDARY_EDITS.length ||
    receipt.edits.some(
      (edit, index) =>
        canonical(edit) !== canonical(ILOC_BOUNDARY_EDITS[index]),
    )
  )
    throw new Error(
      "iloc boundary receipt must contain the exact ordered two-operation chain",
    );
  if (
    row.count !== 1 ||
    row.keys?.length !== 1 ||
    row.originClusterId !==
      [row.group, row.file, row.function, row.mutatorName].join(":") ||
    row.id === row.originClusterId
  )
    throw new Error(
      "iloc boundary dead rows must be single-key children of the immutable origin",
    );
  const keyBySymbol = {
    "payload.length < 2": ILOC_HEADER_KEY,
    "indexSize > 0": ILOC_INDEX_KEY,
  };
  if (keyBySymbol[row.symbol] !== row.keys[0])
    throw new Error(
      "iloc boundary dead row does not own its exact frozen comparison key",
    );
  return true;
}

function currentTestEvidence({ mutant, report, root, readTest, label }) {
  if (!DETECTED.has(mutant.status)) return;
  const resolved = resolvedTests(report, mutant);
  if (
    resolved.length === 0 ||
    resolved.length !== (mutant.killedBy ?? []).length
  )
    throw new Error(`${label} has unresolved killedBy test evidence`);
  for (const test of resolved) {
    const path = safeRelative(root, test.file, `${label} test`);
    const source = readTest ? readTest(test.file) : readFileSync(path, "utf8");
    if (
      typeof source !== "string" ||
      source.length === 0 ||
      test.name.trim() === "" ||
      report.testFiles?.[test.file]?.source !== source
    )
      throw new Error(`${label} killedBy test source is absent or stale`);
  }
}

function sourceSpan(source, mutant) {
  const location = toNormalizedLocation(source, mutant.location);
  const normalizedSource = normalizeDirectives(source);
  return normalizedSource.slice(
    offsetAt(normalizedSource, location.start),
    offsetAt(normalizedSource, location.end),
  );
}

function ilocAuxiliaryMutants({
  file,
  finalEntry,
  finalReport,
  edits,
  root,
  readTest,
}) {
  const source = finalEntry.source ?? "";
  const normalized = normalizeDirectives(source);
  const sites = edits.map((edit) => {
    if (edit.operation === "iloc-header-integer-boundary")
      return {
        operation: edit.operation,
        start: edit.currentStart,
        end: edit.currentStart + edit.after.length,
        expression: edit.after,
        replacements: new Set(["payload.length < 1", "payload.length > 1"]),
        expectedCount: 2,
      };
    const expression = "indexSize !== 0";
    const relativeStart = edit.after.indexOf(expression);
    if (
      relativeStart < 0 ||
      edit.after.indexOf(expression, relativeStart + 1) !== -1
    )
      throw new Error(
        "iloc index operation no longer contains one exact nonzero comparison",
      );
    return {
      operation: edit.operation,
      start: edit.currentStart + relativeStart,
      end: edit.currentStart + relativeStart + expression.length,
      expression,
      replacements: new Set(["indexSize === 0"]),
      expectedCount: 1,
    };
  });
  const found = sites.map(() => []);
  for (const mutant of finalEntry.mutants ?? []) {
    if (mutant.mutatorName !== "EqualityOperator") continue;
    const location = toNormalizedLocation(source, mutant.location);
    const start = offsetAt(normalized, location.start),
      end = offsetAt(normalized, location.end);
    for (let index = 0; index < sites.length; index++) {
      const site = sites[index];
      if (start >= site.start && end <= site.end) {
        const replacement = normalizeDirectives(mutant.replacement ?? "");
        if (
          start !== site.start ||
          end !== site.end ||
          !site.replacements.has(replacement)
        )
          throw new Error(
            `unexpected iloc auxiliary EqualityOperator at ${site.operation}`,
          );
        currentTestEvidence({
          mutant,
          report: finalReport,
          root,
          readTest,
          label: `${site.operation} auxiliary EqualityOperator`,
        });
        if (!DETECTED.has(mutant.status))
          throw new Error(
            `${site.operation} auxiliary EqualityOperator is ${mutant.status}`,
          );
        found[index].push(rawRecord(file, mutant, source, finalReport));
      }
    }
  }
  for (let index = 0; index < sites.length; index++)
    if (found[index].length !== sites[index].expectedCount)
      throw new Error(
        `${sites[index].operation} emitted ${found[index].length} auxiliary EqualityOperators; expected ${sites[index].expectedCount}`,
      );
  const records = found.flat().sort((a, b) => a.anchor.localeCompare(b.anchor));
  if (new Set(records.map((record) => record.anchor)).size !== records.length)
    throw new Error("duplicate iloc auxiliary current mutant");
  return records;
}

function mapIlocSemanticCounterpart({
  mutant,
  finalEntry,
  finalReport,
  evidence,
  edits,
  root,
  readTest,
}) {
  const source = finalEntry.source ?? "";
  const normalizedSource = normalizeDirectives(source);
  const currentSpan = sourceSpan(source, mutant);
  const sites = [
    {
      operation: "iloc-header-integer-boundary",
      currentSpan: "payload.length <= 1",
      oldSpan: "payload.length < 2",
      oldReplacement: (replacement) => replacement,
    },
    {
      operation: "iloc-index-nonzero-boundary",
      currentSpan: "indexSize !== 0",
      oldSpan: "indexSize > 0",
      oldReplacement: (replacement) => replacement,
    },
    {
      operation: "iloc-index-nonzero-boundary",
      currentSpan: "layout.hasIndexSize &&\n        indexSize !== 0",
      oldSpan: "layout.hasIndexSize && indexSize > 0",
      oldReplacement: () => "layout.hasIndexSize || indexSize > 0",
    },
  ];
  const location = toNormalizedLocation(source, mutant.location);
  const from = offsetAt(normalizedSource, location.start),
    to = offsetAt(normalizedSource, location.end);
  const intersectsEdit = edits.some(
    (edit) => from < edit.currentAfterEnd && to > edit.currentStart,
  );
  const site = sites.find(
    (candidate) =>
      edits.some(
        (edit) =>
          edit.operation === candidate.operation &&
          edit.after.includes(candidate.currentSpan) &&
          from >= edit.currentStart &&
          to <= edit.currentAfterEnd,
      ) && currentSpan === candidate.currentSpan,
  );
  if (!site) {
    if (
      intersectsEdit &&
      ["ConditionalExpression", "LogicalOperator"].includes(mutant.mutatorName)
    )
      throw new Error(
        `iloc ${mutant.mutatorName} has no explicit closed-site semantic counterpart`,
      );
    return null;
  }
  const logical =
    mutant.mutatorName === "LogicalOperator" &&
    site.operation === "iloc-index-nonzero-boundary" &&
    site.currentSpan === "layout.hasIndexSize &&\n        indexSize !== 0";
  const conditional =
    mutant.mutatorName === "ConditionalExpression" &&
    ["true", "false"].includes(mutant.replacement);
  if (!logical && !conditional) return null;
  if (
    logical &&
    normalizeDirectives(mutant.replacement ?? "") !==
      "layout.hasIndexSize ||\nindexSize !== 0"
  )
    throw new Error(
      "iloc logical-or candidate differs from the exact nonzero-index counterpart",
    );
  const expectedOldReplacement = logical
    ? site.oldReplacement(mutant.replacement)
    : (mutant.replacement ?? "");
  const beforeSource = normalizeDirectives(evidence.source);
  const oldMatches = evidence.mutants.filter(
    (old) =>
      old.mutatorName === mutant.mutatorName &&
      (old.replacement ?? "") === expectedOldReplacement &&
      sourceSpan(evidence.source, old) === site.oldSpan,
  );
  if (oldMatches.length !== 1)
    throw new Error(
      `iloc ${mutant.mutatorName} ${JSON.stringify(currentSpan)} counterpart to ${JSON.stringify(site.oldSpan)} has ${oldMatches.length} exact pinned originals`,
    );
  const old = oldMatches[0];
  const oldLocation = toNormalizedLocation(evidence.source, old.location);
  const original = anchorKey(
    "src/isobmff/iloc.ts",
    { ...old, location: oldLocation },
    beforeSource,
  );
  const current = rawRecord(
    "src/isobmff/iloc.ts",
    mutant,
    source,
    finalEntry,
  ).anchor;
  currentTestEvidence({
    mutant,
    report: finalReport,
    root,
    readTest,
    label: `iloc ${mutant.mutatorName} semantic counterpart`,
  });
  const isSuppressedInnerTrue =
    site.currentSpan === "indexSize !== 0" &&
    mutant.mutatorName === "ConditionalExpression" &&
    mutant.replacement === "true" &&
    old.status === "Survived" &&
    mutant.status === "Ignored" &&
    /^redundant-guard-after-typed-check — \S/.test(
      String(mutant.statusReason ?? ""),
    );
  if (isSuppressedInnerTrue)
    return {
      current,
      original,
      semanticPair: "index-size-nonnegative-conditional-true",
    };
  if (mutant.status === "Ignored")
    throw new Error(
      "only the inner index-size ConditionalExpression true may be comment-Ignored",
    );
  if (old.status !== mutant.status)
    throw new Error(
      `iloc ${mutant.mutatorName} exact counterpart status changed from ${old.status} to ${mutant.status}`,
    );
  return {
    current,
    original,
    semanticPair: logical
      ? "index-size-nonnegative-logical-or"
      : site.operation,
  };
}

/** Validate one `row.deletion`; no writes, fetches or network operations occur. */
export function validateDeletion({
  row,
  root,
  currentSource = null,
  finalEntry = null,
  finalReport = null,
  readTest = null,
  survivors = null,
  requireFinal = false,
}) {
  const problems = [],
    anchors = [],
    validatedEdits = [],
    removedMutants = [],
    auxiliaryMutants = [];
  const fail = (message) =>
    problems.push(`${row?.id ?? "dead row"}: ${message}`);
  try {
    const receipt = row?.deletion;
    if (!receipt || receipt.version !== 1)
      throw new Error("missing version-1 deletion receipt");
    if (typeof row.file !== "string" || receipt.function !== row.function)
      throw new Error("receipt function does not match owned row");
    if (
      row.file === "src/isobmff/admission.ts" &&
      receipt.beforeRef !== ISOBMFF_ADMISSION_BASE
    )
      throw new Error(
        `isobmff admission receipts must use permanent beforeRef ${ISOBMFF_ADMISSION_BASE}`,
      );
    if (
      typeof row.symbol !== "string" ||
      row.symbol === "" ||
      !receipt.edits?.some(
        (edit) =>
          edit.function === row.function && edit.before.includes(row.symbol),
      )
    )
      throw new Error(
        "required dead symbol is not named by its scoped function edit",
      );
    const usesIlocOperation = (receipt.edits ?? []).some(
      (edit) =>
        typeof edit?.operation === "string" &&
        edit.operation.startsWith("iloc-"),
    );
    if (usesIlocOperation && row.file !== "src/isobmff/iloc.ts")
      throw new Error(
        "iloc boundary operations are restricted to src/isobmff/iloc.ts",
      );
    const trackedPath = safeRelative(root, row.file, "receipt source");
    const beforeSource = gitSource(root, receipt.beforeRef, row.file);
    const ilocBoundary = validateIlocOperationChain(row, receipt, beforeSource);
    if (
      !hex256.test(receipt.beforeSourceSha256 ?? "") ||
      hash(beforeSource) !== receipt.beforeSourceSha256
    )
      throw new Error("before source hash mismatch");
    const evidence = evidenceParts(receipt.beforeEvidence, row.file);
    const evidenceDigest = hash(canonical(receipt.beforeEvidence));
    if (
      !hex256.test(receipt.beforeEvidenceSha256 ?? "") ||
      evidenceDigest !== receipt.beforeEvidenceSha256
    )
      throw new Error("beforeEvidence canonical digest mismatch");
    if (ilocBoundary) {
      if (receipt.beforeEvidenceSha256 !== ILOC_BOUNDARY_BEFORE_EVIDENCE_SHA256)
        throw new Error(
          "iloc boundary embedded evidence digest is not the retained full-file Stryker evidence",
        );
      assertIlocBeforeEvidence(evidence, survivors);
    }
    if (
      normalizeDirectives(evidence.source) !== normalizeDirectives(beforeSource)
    )
      throw new Error("embedded source differs from authoritative git source");
    if (
      hash(normalizeDirectives(beforeSource)) !==
      hash(normalizeDirectives(evidence.source))
    )
      throw new Error("normalized source hash mismatch");
    const expectedReportPath = safeRelative(
      root,
      receipt.beforeReport,
      "beforeReport",
    );
    if (!hex256.test(receipt.beforeReportSha256 ?? ""))
      throw new Error("before report hash is invalid");
    if (existsSync(expectedReportPath)) {
      const bytes = readFileSync(expectedReportPath);
      if (hash(bytes) !== receipt.beforeReportSha256)
        throw new Error("retained before report hash mismatch");
      const report = JSON.parse(bytes.toString("utf8"));
      const slice = report.files?.[row.file];
      if (
        !slice ||
        canonical(slice) !==
          canonical({
            source: evidence.source,
            mutants: evidence.mutants,
            ...(slice.language === undefined
              ? {}
              : { language: slice.language }),
          })
      )
        throw new Error(
          "retained before report slice differs from embedded evidence",
        );
      if (
        canonical(referencedTests(report, slice.mutants ?? [])) !==
        canonical(evidence.testFiles ?? {})
      )
        throw new Error(
          "retained before report test evidence differs from embedded evidence",
        );
    }
    if (!Array.isArray(receipt.edits) || receipt.edits.length === 0)
      throw new Error("receipt has no edits");
    const applied = applyEdits(
      normalizeDirectives(beforeSource),
      receipt.edits,
    );
    const diskSource = readFileSync(trackedPath, "utf8");
    if (typeof currentSource !== "string") currentSource = diskSource;
    else if (
      normalizeDirectives(currentSource) !== normalizeDirectives(diskSource)
    )
      throw new Error("current source differs from working tree");
    const normalizedCurrent = normalizeDirectives(currentSource);
    if (applied.source !== normalizedCurrent)
      throw new Error("current source differs from exact ordered edit chain");
    if (
      finalEntry &&
      normalizeDirectives(finalEntry.source ?? "") !== normalizedCurrent
    )
      throw new Error("final report source differs from current source");
    if (
      typeof receipt.referenceTrace !== "string" ||
      receipt.referenceTrace.trim() === ""
    )
      throw new Error("referenceTrace is empty");
    validatedEdits.push(...applied.edits);

    const affected = evidence.mutants.filter((mutant) =>
      affectedBy(mutant, evidence.source, applied.edits),
    );
    const candidateRecords = affected
      .map((mutant) =>
        rawRecord(row.file, mutant, evidence.source, {
          testFiles: evidence.testFiles,
        }),
      )
      .sort(
        (a, b) =>
          a.anchor.localeCompare(b.anchor) || a.status.localeCompare(b.status),
      );
    for (const mutant of affected)
      if (DETECTED.has(mutant.status)) {
        const resolved = resolvedTests(
          { testFiles: evidence.testFiles },
          mutant,
        );
        if (
          resolved.length === 0 ||
          resolved.length !== (mutant.killedBy ?? []).length
        )
          throw new Error(
            `affected detected mutant ${show(anchorKey(row.file, mutant, evidence.source))} has unresolved killedBy test evidence`,
          );
      }
    if (!Array.isArray(receipt.removedMutants))
      throw new Error("removedMutants inventory is missing");
    const claimed = [...receipt.removedMutants].sort(
      (a, b) =>
        String(a.anchor).localeCompare(String(b.anchor)) ||
        String(a.status).localeCompare(String(b.status)),
    );
    const owned = new Set(row.keys ?? []);
    if (owned.size !== (row.keys ?? []).length)
      throw new Error("duplicate owned key");
    const ownedEvidence = new Map();
    if (survivors) {
      for (const key of owned) {
        const members = survivors.filter((candidate) => candidate.key === key);
        const member = members[0];
        if (
          members.length !== 1 ||
          !member ||
          member.file !== row.file ||
          member.function !== row.function ||
          member.mutatorName !== row.mutatorName ||
          member.group !== row.group
        )
          throw new Error(
            `owned key ${show(key)} is absent from its immutable origin`,
          );
        const rowOrigin = row.originClusterId;
        const memberOrigin = [
          member.group,
          member.file,
          member.function,
          member.mutatorName,
        ].join(":");
        if (rowOrigin !== undefined && rowOrigin !== memberOrigin)
          throw new Error(
            `owned key ${show(key)} has different immutable origin metadata`,
          );
        const candidates = evidence.mutants.filter(
          (mutant) =>
            mutantKey(row.file, {
              ...mutant,
              location: toNormalizedLocation(evidence.source, mutant.location),
            }) === key,
        );
        if (candidates.length !== 1)
          throw new Error(
            `owned key ${show(key)} has ${candidates.length} directive-normalized report matches`,
          );
        const old = candidates[0];
        const normalizedAnchor = anchorKey(
          row.file,
          {
            ...old,
            location: toNormalizedLocation(evidence.source, old.location),
          },
          normalizeDirectives(evidence.source),
        );
        if (normalizedAnchor !== member.anchorKey)
          throw new Error(
            `owned key ${show(key)} has a different immutable anchor`,
          );
        if (member.status !== undefined && member.status !== old.status)
          throw new Error(
            `owned key ${show(key)} has a different immutable status`,
          );
        if (
          member.replacement !== undefined &&
          member.replacement !== (old.replacement ?? "")
        )
          throw new Error(
            `owned key ${show(key)} has a different immutable replacement`,
          );
        ownedEvidence.set(key, { member, mutant: old });
      }
    }
    for (const key of owned) {
      const resolved = ownedEvidence.get(key);
      const old =
        resolved?.mutant ??
        evidence.mutants.find(
          (mutant) =>
            mutantKey(row.file, {
              ...mutant,
              location: toNormalizedLocation(evidence.source, mutant.location),
            }) === key,
        );
      if (
        !old ||
        !["Survived", "NoCoverage"].includes(old.status) ||
        !affected.includes(old)
      )
        throw new Error(
          `owned key ${show(key)} is not a removed undetected member of the exact edit`,
        );
    }
    if (owned.size === 0) throw new Error("scoped dead row owns no members");

    if (finalReport && finalEntry) {
      const reportBinding = ilocBoundary
        ? selectIlocReportBinding(receipt, finalReport, root)
        : null;
      if (ilocBoundary)
        assertIlocFinalEvidence(finalEntry, finalReport, root, readTest);
      const editMap = applied.edits;
      const beforeNormalized = normalizeDirectives(beforeSource);
      const finalNormalized = normalizeDirectives(finalEntry.source ?? "");
      const ilocAuxiliary = ilocBoundary
        ? ilocAuxiliaryMutants({
            file: row.file,
            finalEntry,
            finalReport,
            edits: editMap,
            root,
            readTest,
          })
        : [];
      const auxiliaryAnchors = new Set(
        ilocAuxiliary.map((record) => record.anchor),
      );
      const originalRecords = evidence.mutants.map((old) => ({
        anchor: anchorKey(
          row.file,
          {
            ...old,
            location: toNormalizedLocation(evidence.source, old.location),
          },
          beforeNormalized,
        ),
        mutatorName: old.mutatorName,
        replacement: old.replacement ?? "",
      }));
      for (const mutant of finalEntry.mutants ?? []) {
        let from, to;
        try {
          from = offsetAt(
            finalNormalized,
            toNormalizedLocation(finalEntry.source ?? "", mutant.location)
              .start,
          );
          to = offsetAt(
            finalNormalized,
            toNormalizedLocation(finalEntry.source ?? "", mutant.location).end,
          );
        } catch {
          throw new Error(
            `unexplained live anchor ${mutant.mutatorName}: location is outside current source`,
          );
        }
        const normalizedLocation = toNormalizedLocation(
          finalEntry.source ?? "",
          mutant.location,
        );
        const current = anchorKey(
          row.file,
          { ...mutant, location: normalizedLocation },
          finalNormalized,
        );
        if (auxiliaryAnchors.has(current)) continue;
        const semantic = ilocBoundary
          ? mapIlocSemanticCounterpart({
              mutant,
              finalEntry,
              finalReport,
              evidence,
              edits: editMap,
              root,
              readTest,
            })
          : null;
        if (semantic) {
          anchors.push({
            current: semantic.current,
            original: semantic.original,
          });
          continue;
        }
        const liveSpan = finalNormalized.slice(from, to);
        const candidates = new Map();
        for (const startBoundary of ["start", "end"])
          for (const endBoundary of ["start", "end"]) {
            const oldFrom = mapFinalOffsetToBefore(
              from,
              editMap,
              startBoundary,
            );
            const oldTo = mapFinalOffsetToBefore(to, editMap, endBoundary);
            if (oldFrom === null || oldTo === null || oldFrom > oldTo) continue;
            const oldSpan = beforeNormalized.slice(oldFrom, oldTo);
            const deleted = editMap.some(
              (edit) => edit.start >= oldFrom && edit.end <= oldTo,
            );
            if (oldSpan !== liveSpan && !deleted) continue;
            const oldLocation = {
              start: pointAt(beforeNormalized, oldFrom),
              end: pointAt(beforeNormalized, oldTo),
            };
            const original = anchorKey(
              row.file,
              { ...mutant, location: oldLocation },
              beforeNormalized,
            );
            const exactMatches = originalRecords.filter(
              (record) =>
                record.anchor === original &&
                record.mutatorName === mutant.mutatorName &&
                record.replacement === (mutant.replacement ?? ""),
            ).length;
            const previous = candidates.get(original);
            candidates.set(original, {
              original,
              exactMatches: Math.max(previous?.exactMatches ?? 0, exactMatches),
            });
          }
        const possible = [...candidates.values()];
        if (possible.some((candidate) => candidate.exactMatches > 1))
          throw new Error(
            `unexplained live anchor ${mutant.mutatorName}: original report correspondence is ambiguous`,
          );
        const exact = possible.filter(
          (candidate) => candidate.exactMatches === 1,
        );
        if (exact.length > 1 || (exact.length === 0 && possible.length !== 1))
          throw new Error(
            `unexplained live anchor ${mutant.mutatorName}: edited text has no unique original correspondence`,
          );
        if (possible.length === 0)
          throw new Error(
            `unexplained live anchor ${mutant.mutatorName}: source text does not map through the receipt`,
          );
        if (ilocBoundary && exact.length !== 1)
          throw new Error(
            `iloc ${mutant.mutatorName} has no exact pinned token/coordinate counterpart`,
          );
        const original = exact[0]?.original ?? possible[0].original;
        anchors.push({ current, original });
      }
      const seen = new Set(),
        seenCurrent = new Set();
      for (const pair of anchors) {
        if (seenCurrent.has(pair.current))
          throw new Error(`duplicate live anchor ${show(pair.current)}`);
        seenCurrent.add(pair.current);
        if (seen.has(pair.original))
          throw new Error(
            `two live mutants map to one original anchor ${show(pair.original)}`,
          );
        seen.add(pair.original);
      }
      if (ilocBoundary) {
        for (const pair of anchors) {
          const oldMatches = evidence.mutants.filter(
            (old) =>
              anchorKey(
                row.file,
                {
                  ...old,
                  location: toNormalizedLocation(evidence.source, old.location),
                },
                beforeNormalized,
              ) === pair.original,
          );
          const currentMatches = (finalEntry.mutants ?? []).filter(
            (mutant) =>
              anchorKey(
                row.file,
                {
                  ...mutant,
                  location: toNormalizedLocation(
                    finalEntry.source ?? "",
                    mutant.location,
                  ),
                },
                finalNormalized,
              ) === pair.current,
          );
          if (oldMatches.length !== 1 || currentMatches.length !== 1)
            throw new Error(
              "iloc exact counterpart is missing or ambiguous in the complete report tables",
            );
          const old = oldMatches[0],
            current = currentMatches[0];
          const oldKey = mutantKey(row.file, {
            ...old,
            location: toNormalizedLocation(evidence.source, old.location),
          });
          const oneOwnedInnerTrue =
            oldKey === ILOC_INDEX_TRUE_KEY &&
            old.status === "Survived" &&
            current.mutatorName === "ConditionalExpression" &&
            current.replacement === "true" &&
            current.status === "Ignored" &&
            /^redundant-guard-after-typed-check — \S/.test(
              String(current.statusReason ?? ""),
            );
          if (old.status !== current.status && !oneOwnedInnerTrue)
            throw new Error(
              `iloc exact counterpart status changed from ${old.status} to ${current.status}`,
            );
        }
      }
      for (const key of owned) {
        const resolved = ownedEvidence.get(key);
        const old =
          resolved?.mutant ??
          evidence.mutants.find(
            (mutant) =>
              mutantKey(row.file, {
                ...mutant,
                location: toNormalizedLocation(
                  evidence.source,
                  mutant.location,
                ),
              }) === key,
          );
        const member = resolved?.member;
        if (
          member &&
          anchors.some((pair) => pair.original === member.anchorKey)
        )
          throw new Error(
            `scoped dead member ${show(key)} is still generated in the final report`,
          );
        if (
          old &&
          anchors.some(
            (pair) =>
              pair.original ===
              anchorKey(
                row.file,
                {
                  ...old,
                  location: toNormalizedLocation(evidence.source, old.location),
                },
                normalizeDirectives(evidence.source),
              ),
          )
        )
          throw new Error(
            `scoped dead member ${show(key)} is still generated in the final report`,
          );
      }
      const mapped = new Set(anchors.map((pair) => pair.original));
      const actualRecords = candidateRecords.filter(
        (record) => !mapped.has(record.anchor),
      );
      if (canonical(actualRecords) !== canonical(claimed))
        throw new Error(
          `removedMutants does not exactly account for invalidated report mutants (computed ${actualRecords.map((record) => show(record.anchor)).join(", ")}; claimed ${claimed.map((record) => show(record.anchor)).join(", ")})`,
        );
      removedMutants.push(...actualRecords);
      auxiliaryMutants.push(...ilocAuxiliary);
      if (
        ilocBoundary &&
        (anchors.length !== 154 ||
          actualRecords.length !== 4 ||
          ilocAuxiliary.length !== 3)
      )
        throw new Error(
          `iloc complete correspondence differs from the retained inventory (mapped ${anchors.length}, removed ${actualRecords.length}, auxiliary ${ilocAuxiliary.length})`,
        );

      const successorByOld = new Map(
        (receipt.detectedSuccessors ?? []).map((item) => [
          item.oldAnchor,
          item,
        ]),
      );
      const counterfactualByOld = new Map(
        (receipt.counterfactuals ?? []).map((item) => [item.oldAnchor, item]),
      );
      const detectedOld = actualRecords.filter((record) =>
        DETECTED.has(record.status),
      );
      const detectedAnchors = new Set(
        detectedOld.map((record) => record.anchor),
      );
      for (const [label, records] of [
        ["successor", receipt.detectedSuccessors ?? []],
        ["counterfactual", receipt.counterfactuals ?? []],
      ]) {
        const seenDetected = new Set();
        for (const item of records) {
          if (!detectedAnchors.has(item.oldAnchor))
            throw new Error(
              `${label} references an unaccounted detected mutant`,
            );
          if (seenDetected.has(item.oldAnchor))
            throw new Error(`${label} is duplicated for a detected mutant`);
          seenDetected.add(item.oldAnchor);
        }
      }
      for (const old of detectedOld) {
        if (
          successorByOld.has(old.anchor) === counterfactualByOld.has(old.anchor)
        )
          throw new Error(
            `detected mutant ${show(old.anchor)} must have exactly one successor or counterfactual`,
          );
        const successor = successorByOld.get(old.anchor);
        if (successor) {
          const found = [];
          for (const [file, entry] of Object.entries(finalReport.files ?? {}))
            for (const mutant of entry.mutants ?? [])
              if (
                anchorKey(file, mutant, entry.source ?? "") ===
                successor.finalAnchor
              )
                found.push({ file, mutant });
          if (found.length !== 1)
            throw new Error(
              `detected successor ${show(successor.finalAnchor)} is missing or ambiguous`,
            );
          const { mutant } = found[0];
          if (!DETECTED.has(mutant.status))
            throw new Error(`detected successor is ${mutant.status}`);
          const boundSuccessor = reportBinding?.successorsByOld.get(old.anchor);
          if (
            reportBinding &&
            (!boundSuccessor ||
              boundSuccessor.finalAnchor !== successor.finalAnchor)
          )
            throw new Error(
              "iloc report-specific binding does not match the receipt successor",
            );
          const expectedTest = boundSuccessor?.test ?? successor.test;
          if (
            !expectedTest ||
            typeof expectedTest.file !== "string" ||
            typeof expectedTest.name !== "string" ||
            !expectedTest.name
          )
            throw new Error("detected successor has no named test");
          safeRelative(root, expectedTest.file, "successor test");
          const text = readTest
            ? readTest(expectedTest.file)
            : readFileSync(
                safeRelative(root, expectedTest.file, "successor test"),
                "utf8",
              );
          const reportedTest = finalReport.testFiles?.[expectedTest.file];
          const namedTests =
            reportedTest?.tests?.filter((test) =>
              reportBinding
                ? String(test.id) === expectedTest.id &&
                  test.name === expectedTest.name
                : test.name === expectedTest.name,
            ) ?? [];
          if (
            typeof text !== "string" ||
            text.length === 0 ||
            (!ilocBoundary && !text.includes(expectedTest.name)) ||
            reportedTest?.source !== text ||
            namedTests.length !== 1 ||
            (reportBinding && hash(text) !== expectedTest.sourceSha256)
          )
            throw new Error(
              "detected successor test source is absent or stale",
            );
          const killedBy = resolvedTests(finalReport, mutant);
          if (
            reportBinding
              ? !mutant.killedBy?.some((id) => String(id) === expectedTest.id)
              : !killedBy.some(
                  (test) =>
                    test.file === expectedTest.file &&
                    (test.name === expectedTest.name ||
                      test.name.endsWith(` > ${expectedTest.name}`)),
                )
          )
            throw new Error(
              "detected successor killedBy does not name the real test",
            );
          if (
            typeof successor.semanticTrace !== "string" ||
            successor.semanticTrace.trim() === ""
          )
            throw new Error("detected successor semanticTrace is empty");
        } else {
          const proof = counterfactualByOld.get(old.anchor);
          if (
            !proof ||
            proof.executed !== true ||
            !Array.isArray(proof.argv) ||
            proof.argv.length === 0 ||
            typeof proof.command !== "string" ||
            proof.command.trim() === "" ||
            typeof proof.alteredSha256 !== "string" ||
            !hex256.test(proof.alteredSha256) ||
            typeof proof.expectedDiagnostic !== "string" ||
            !proof.expectedDiagnostic ||
            !Number.isInteger(proof.exitCode) ||
            proof.exitCode <= 0 ||
            proof.unchangedExitCode !== 0 ||
            typeof proof.assertion !== "string" ||
            !proof.assertion
          )
            throw new Error(
              `removed detected counterpart ${show(old.anchor)} has no executed counterfactual`,
            );
        }
      }
    } else {
      if (requireFinal)
        throw new Error(
          "final report entry is required for scoped deletion proof",
        );
      // Without a final report, validate the immutable candidate table and owned
      // members; final invalidation/successor partitioning is deferred to --final.
      const candidates = new Map(
        candidateRecords.map((record) => [record.anchor, record]),
      );
      if (
        claimed.some(
          (record) =>
            canonical(candidates.get(record.anchor)) !== canonical(record),
        )
      )
        throw new Error(
          "removedMutants includes a record absent from embedded affected evidence",
        );
      for (const key of owned) {
        const resolved = ownedEvidence.get(key);
        const old =
          resolved?.mutant ??
          evidence.mutants.find(
            (mutant) =>
              mutantKey(row.file, {
                ...mutant,
                location: toNormalizedLocation(
                  evidence.source,
                  mutant.location,
                ),
              }) === key,
          );
        if (
          !old ||
          !claimed.some(
            (record) =>
              record.anchor ===
              anchorKey(
                row.file,
                {
                  ...old,
                  location: toNormalizedLocation(evidence.source, old.location),
                },
                normalizeDirectives(evidence.source),
              ),
          )
        )
          throw new Error(
            `owned dead key ${show(key)} is missing from removedMutants evidence`,
          );
      }
      removedMutants.push(...claimed);
    }
  } catch (error) {
    fail(error.message);
  }
  return {
    problems,
    edits: validatedEdits,
    anchors,
    removedMutants,
    auxiliaryMutants,
  };
}

export {
  canonical as canonicalReceiptJson,
  normalizeDirectives as normalizeReceiptSource,
};
