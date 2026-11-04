// Commit-bound, function-scoped deletion receipts (D-18/D-21). Node builtins plus one
// lazily loaded package: the pinned `typescript` parser, used solely by
// `namedKillerBinding` (Plan 67-59) and never loaded unless that binding is called.
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
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
import { anchorKey, mutantKey } from "./identity.mjs";
import { enclosingFunction } from "./cluster.mjs";

const DIRECTIVE = /^\s*\/\/ Stryker (?:disable|restore)\b/;
const DETECTED = new Set(["Killed", "Timeout"]);
const ISOBMFF_ADMISSION_BASE = "cb8eedde27eaa6b2a54cb9f2008d91292a8b3bba";
const ILOC_BOUNDARY_BASE = "cb8eedde27eaa6b2a54cb9f2008d91292a8b3bba";
const CSTRING_BOUNDARY_BASE = "cb8eedde27eaa6b2a54cb9f2008d91292a8b3bba";
const CSTRING_BOUNDARY_SOURCE_SHA256 =
  "048c8627199aa21976979317b6024f0928a42d376567279b660ed3e7dcf8363c";
const CSTRING_BEFORE_REPORT_CANONICAL_SHA256 =
  "f91da4980b29d64e22cd0f95f39d4ecc6ebb0d385436a51b35d8a9e0c6936558";
const CSTRING_UNANNOTATED_REPORT_CANONICAL_SHA256 =
  "ab337986324b6fb560436d665bbdf75d6885f435b7e853f3e9070c3a3f68b42e";
const CSTRING_FINAL_REPORT_CANONICAL_SHA256 =
  "68685e54ba6ba32c63b848f13215f2ec4ded2700c711dddedd9f36020fdef297";
const CSTRING_CANDIDATE_SOURCE_SHA256 =
  "be06b8a71401be7a6d54058f4af6699389a5b3ee6b150844805260da6541c2db";
const CSTRING_FINAL_RAW_SOURCE_SHA256 =
  "9a53dabcfe43d43311c17b17c2453dcc47e55b7cae2c193340c58d24cacc7c88";
const CSTRING_OPERATION = Object.freeze({
  operation: "cstring-integer-boundary",
  file: "src/isobmff/items.ts",
  function: "readCString",
  occurrence: 0,
  before: "end < buffer.length",
  after: "end <= buffer.length - 1",
});
const CSTRING_EQUIVALENT_KEY = [
  "src/isobmff/items.ts",
  "EqualityOperator",
  "end <= buffer.length",
  184,
  10,
  184,
  29,
].join("\0");
const CSTRING_EQUIVALENT_ORIGIN =
  "isobmff:src/isobmff/items.ts:readCString:EqualityOperator";
const CSTRING_EQUIVALENT_DIRECTIVE =
  "// Stryker disable next-line ArithmeticOperator: equivalent-arithmetic — the sole measured +1 replacement probes undefined at EOF twice, then the existing end-of-buffer guard produces the same typed box-framing error; NUL-terminated values and returned bytes are unchanged.";
const CSTRING_REFERENCE_TRACE = [
  "readCString callers and integer bounds (current source, all call sites):",
  "parseInfe passes the payload from readFullBoxChild. Its start position is 0; version 2/3 selects integer idBytes 2 or 4, ensureBytes validates each read, and position advances only by those byte counts (2, then 2, then 4) before item_name. A NUL-terminated name returns integer end+1. MIME content_type starts at that integer; optional content_encoding is called only when position < payload.length. URI item_uri_type starts at the same integer after item_name. Every position is an integer within [0,payload.length] because ensureBytes and each successful terminator bound the prior read.",
  "parseIpco calls readCString for auxC with the FullBox payload and position 0. readFullBoxChild first requires its four-byte version/flags field, while the resulting string payload can be empty; at length 0 both original and candidate loop conditions are false and the unchanged end >= length guard emits the same typed box-framing refusal.",
  "Buffer.length and all caller offsets are integers. For every integer end and length, end < length is equivalent to end <= length - 1, including zero-length and end-at-EOF cases. The valid NUL predicate, end += 1, post-loop guard/throw, decode range and return remain byte-identical. The sole measured ArithmeticOperator +1 mutant can read undefined at EOF and EOF+1; Buffer indexed reads have no side effects and the same existing guard then throws the same typed error. NUL-terminated values never reach those probes.",
].join("\n");
const CSTRING_COUNTERFACTUALS = Object.freeze([
  Object.freeze({
    id: "loop-op",
    before: "end < buffer.length",
    after: "end >= buffer.length",
    sourceSha256:
      "2a9cfb8d131bca528751b912ccded9ac8153b5bd2582fafe57dbe5543393240a",
    testLogSha256:
      "247864e69bdbf123349233b93d712a0b0b124464edaa6c17331ab78ea0e21749",
    greenTestLogSha256:
      "13efc34630f498a3f2dd686f5f20e599a66dfc7a2d7d996ca659dd7ce04f2667",
    testFile: "tests/isobmff_writer.test.ts",
    testName:
      "tracer: heif-enc-grid.heic rebuild (62-02) > rebuilds heif-enc-grid.heic end to end: removes Exif/XMP, preserves every surviving item byte-identical, leaks none of the removed payload, and re-admits",
    assertion: "expect(sanitized.ok).toBe(true)",
  }),
  Object.freeze({
    id: "nul-equality",
    before: "buffer[end] !== 0",
    after: "buffer[end] === 0",
    sourceSha256:
      "75834d915bfee6db75728dbbac5204245a18b2cc5b8c4974bfdd1623f829c8c2",
    testLogSha256:
      "aeac0b9a5b526de02658faa43f24999b71f690573e73cc434409dda2a464e937",
    greenTestLogSha256:
      "1eccf954170c7416d6125a2dc9a87d7c1eeb30b296e0dbcc40d1604292c7190c",
    testFile: "tests/isobmff_writer.test.ts",
    testName:
      "tracer: heif-enc-grid.heic rebuild (62-02) > rebuilds heif-enc-grid.heic end to end: removes Exif/XMP, preserves every surviving item byte-identical, leaks none of the removed payload, and re-admits",
    assertion: "expect(sanitized.ok).toBe(true)",
  }),
]);
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

function assertIlocFinalEvidence(finalEntry, finalReport, root, readTest, row) {
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
  const currentTestFiles = new Set([
    ...(row.deletion?.detectedSuccessors ?? []).map((successor) =>
      successor.test?.file,
    ),
    ...(row.deletion?.reportBindings ?? []).flatMap((binding) =>
      (binding.successors ?? []).map((successor) => successor.test?.file),
    ),
  ].filter((file) => typeof file === "string"));
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
    // Historical report fixtures retain the exact source inventory from their
    // measured run. Only files that own a receipt's named direct killer must
    // still match the current checkout; unrelated report test files may have
    // gained later tests without invalidating the immutable historical report.
    if (currentTestFiles.has(file) && source !== entry.source)
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
        assertIlocFinalEvidence(finalEntry, finalReport, root, readTest, row);
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

function cstringRecords(report, label) {
  const file = CSTRING_OPERATION.file;
  const entry = report?.files?.[file];
  if (
    !entry ||
    Object.keys(report.files).length !== 1 ||
    typeof entry.source !== "string" ||
    !Array.isArray(entry.mutants)
  )
    throw new Error(`${label} report is not a complete single-file items.ts report`);
  const source = normalizeDirectives(entry.source);
  const records = entry.mutants.map((mutant) => {
    const location = toNormalizedLocation(entry.source, mutant.location);
    const normalizedMutant = { ...mutant, location };
    return {
      mutant,
      anchor: anchorKey(file, normalizedMutant, source),
      rawAnchor: anchorKey(file, mutant, entry.source),
      start: offsetAt(source, location.start),
      end: offsetAt(source, location.end),
      replacement: mutant.replacement ?? "",
      mutatorName: mutant.mutatorName,
      status: mutant.status,
      killedBy: resolvedTests(report, mutant),
    };
  });
  const anchors = new Set();
  for (const record of records) {
    if (anchors.has(record.anchor))
      throw new Error(`${label} report has duplicate canonical mutant anchors`);
    anchors.add(record.anchor);
  }
  return { entry, source, records };
}

function cstringUnique(records, predicate, label) {
  const found = records.filter(predicate);
  if (found.length !== 1)
    throw new Error(`${label} has ${found.length} matching report records`);
  return found[0];
}

function cstringStatusCounts(records) {
  return records.reduce((counts, record) => {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
    return counts;
  }, {});
}

function cstringEquivalentReport(actual, measured) {
  const evidence = (report, label) => {
    const { entry, source, records } = cstringRecords(report, label);
    const operationStart = cstringExpressionOffset(source, CSTRING_OPERATION.after);
    const operationEnd = operationStart + CSTRING_OPERATION.after.length;
    const operationAffected = new Set(
      records
        .filter(
          (record) =>
            (record.start <= operationStart && record.end >= operationEnd) ||
            (record.start < operationEnd && record.end > operationStart),
        )
        .map((record) => record.anchor),
    );
    const testsById = new Map();
    for (const [file, testFile] of Object.entries(report.testFiles ?? {}))
      for (const test of testFile.tests ?? [])
        testsById.set(String(test.id), { file, name: test.name });
    const references = (mutant, field) => (mutant[field] ?? [])
      .map((id) => testsById.get(String(id)))
      .map((test) => {
        if (!test) throw new Error(`${label} report has an unresolved ${field} test id`);
        return test;
      })
      .sort((left, right) => left.file.localeCompare(right.file) || left.name.localeCompare(right.name));
    const mutants = records.map((record) => {
      const nonlocalKilled =
        record.status === "Killed" && !operationAffected.has(record.anchor);
      // Resolve every reference even when nonlocal first-failure attribution is omitted.
      const killedBy = references(record.mutant, "killedBy");
      const coveredBy = references(record.mutant, "coveredBy");
      return {
        anchor: record.anchor,
        rawAnchor: record.rawAnchor,
        status: record.status,
        ...(nonlocalKilled
          ? {}
          : {
              statusReason: record.mutant.statusReason ?? null,
              killedBy,
            }),
        static: record.mutant.static ?? null,
        coveredBy,
      };
    }).sort((left, right) => left.anchor.localeCompare(right.anchor));
    const tests = Object.entries(report.testFiles ?? {}).map(([file, testFile]) => ({
      file,
      source: testFile.source,
      tests: (testFile.tests ?? []).map((test) => test.name).sort(),
    })).sort((left, right) => left.file.localeCompare(right.file));
    return {
      file: CSTRING_OPERATION.file,
      language: entry.language,
      source: entry.source,
      mutants,
      tests,
    };
  };
  return canonical(evidence(actual, "current")) === canonical(evidence(measured, "measured"));
}

function cstringExpressionOffset(source, expression) {
  const declarations = [...source.matchAll(/\bfunction\s+readCString\s*\(/g)];
  if (declarations.length !== 1)
    throw new Error(`readCString declaration is ${declarations.length === 0 ? "missing" : "ambiguous"}`);
  const start = declarations[0].index;
  const nextDeclaration = source.indexOf("\nfunction ", start + 1);
  const end = nextDeclaration < 0 ? source.length : nextDeclaration;
  const positions = [];
  let from = start;
  while ((from = source.indexOf(expression, from)) !== -1 && from < end) {
    positions.push(from);
    from += expression.length;
  }
  if (positions.length !== 1)
    throw new Error(`readCString expression ${JSON.stringify(expression)} is ${positions.length === 0 ? "missing" : "ambiguous"}`);
  return positions[0];
}

/**
 * Named-killer closure binding (Plan 67-59, maintainer decision A, 2026-11-04).
 *
 * The readCString receipt used to compare whole test-file bytes, so any byte appended to
 * tests/isobmff_items.test.ts made `ledger-check --pre` fail. It now binds each NAMED KILLER
 * test's own source closure instead. The closure has six parts; its digest is the SHA-256 of
 * the canonical JSON of them:
 *   1 target       raw text of the killer's whole expression statement;
 *   2 scope        for every static describe on the killer's path: title, callee, every argument
 *                  but the title and callback (options), and the raw text of each direct
 *                  callback statement that is not a plain static describe/it/test registration
 *                  (hooks, helpers, loops, blocks, .each, modifiers, dynamic titles, wrappers);
 *   3 effects      raw text of each top-level statement that is a non-plain registration, a
 *                  non-declaration statement (hooks, mocks, setup, assignments), or a
 *                  declaration that executes code at load, referenced or not;
 *   4 declarations raw text of each top-level declaration reachable by identifier reference
 *                  from parts 1-3 (fixed point; destructured names, overload groups and merged
 *                  declarations indexed by every bound name);
 *   5 imports      the module/imported/local/type-only record of every import binding used by
 *                  parts 1-4, plus the file's sorted set of runtime module specifiers;
 *   6 file flags   whether any registration is exclusive (`only`, `fit`, `fdescribe`) and the
 *                  sorted `@vitest-` pragma comments.
 * Raw text means exact source slices, so whitespace or comment edits inside a closure statement
 * fail closed and need human review. Plain static top-level describe/it/test statements the
 * killer does not use are deliberately unbound (they are the tests a later plan appends).
 * The package is loaded lazily and a missing package or an unparseable source throws a typed
 * error; no consumer falls back to comparing bytes.
 */
const NAMED_KILLER_CACHE_LIMIT = 64;
const namedKillerCache = new Map();
let typescriptForBinding = null;

export class NamedKillerBindingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NamedKillerBindingError";
    this.code = code;
  }
}

function loadTypeScriptForBinding() {
  if (typescriptForBinding) return typescriptForBinding;
  try {
    typescriptForBinding = createRequire(
      new URL("../../package.json", import.meta.url),
    )("typescript");
  } catch (cause) {
    throw new NamedKillerBindingError(
      "typescript-unavailable",
      `the typescript package could not be loaded from exifcleaner-node/package.json, so named killer closures cannot be bound (${String(cause?.message ?? cause).split("\n")[0]})`,
    );
  }
  return typescriptForBinding;
}

const KILLER_PLAIN_ROOTS = new Set(["describe", "it", "test"]);
const KILLER_REGISTRATION_ROOTS = new Set([
  "describe", "it", "test", "fit", "fdescribe", "xit", "xdescribe", "xtest", "suite",
]);

function namedKillerClosure(source, fullName) {
  const ts = loadTypeScriptForBinding();
  const sf = ts.createSourceFile(
    "named-killer.test.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (sf.parseDiagnostics.length > 0)
    throw new NamedKillerBindingError(
      "syntax",
      "named killer test source has a syntax error, so no closure can be bound",
    );
  const raw = (node) => source.slice(node.getStart(sf), node.end);
  const unwrap = (node) => {
    while (
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node)
    )
      node = node.expression;
    return node;
  };
  // The bare identifier at the root of a callee chain (`it.each(t)` -> `it`).
  const registrationRoot = (callee) => {
    let node = callee;
    for (;;) {
      node = unwrap(node);
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
        node = node.expression;
      else if (ts.isCallExpression(node)) node = node.expression;
      else if (ts.isTaggedTemplateExpression(node)) node = node.tag;
      else break;
    }
    return ts.isIdentifier(node) ? node.text : null;
  };
  const isRegistrationCall = (node) =>
    ts.isCallExpression(node) &&
    KILLER_REGISTRATION_ROOTS.has(registrationRoot(node.expression));
  const registrationMemo = new Map();
  const containsRegistration = (node) => {
    if (registrationMemo.has(node)) return registrationMemo.get(node);
    let found = false;
    const visit = (child) => {
      if (found) return;
      if (isRegistrationCall(child)) {
        found = true;
        return;
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    registrationMemo.set(node, found);
    return found;
  };
  const staticTitle = (node) =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : null;
  const isFunctionNode = (node) => ts.isArrowFunction(node) || ts.isFunctionExpression(node);
  // describe/it/test(<static title>, <one function>[, options]) as a statement.
  const staticRegistration = (statement) => {
    if (!ts.isExpressionStatement(statement)) return null;
    const call = statement.expression;
    if (
      !ts.isCallExpression(call) ||
      !ts.isIdentifier(call.expression) ||
      !KILLER_PLAIN_ROOTS.has(call.expression.text) ||
      (call.typeArguments && call.typeArguments.length > 0)
    )
      return null;
    const [first, ...rest] = call.arguments;
    const title = first === undefined ? null : staticTitle(first);
    if (title === null) return null;
    const callbacks = rest.filter(isFunctionNode);
    if (callbacks.length !== 1) return null;
    return {
      statement,
      kind: call.expression.text,
      title,
      call,
      callback: callbacks[0],
      options: rest.filter((argument) => argument !== callbacks[0]),
      plain: rest.length === 1,
    };
  };
  const isPlainRegistration = (statement) => staticRegistration(statement)?.plain === true;

  // A non-plain statement holding a registration may generate or wrap the killer: refuse when a
  // registration inside it carries the killer's own last title segment or a templated title
  // whose literal parts are compatible with it.
  const lastTitleMatches = (title) => fullName === title || fullName.endsWith(` > ${title}`);
  const mayGenerateKiller = (statement) => {
    let found = false;
    const visit = (child) => {
      if (found) return;
      if (
        ts.isCallExpression(child) &&
        ["it", "test"].includes(registrationRoot(child.expression)) &&
        child.arguments.length > 0
      ) {
        const titleNode = child.arguments[0];
        const exact = staticTitle(titleNode);
        if (exact !== null) found = lastTitleMatches(exact);
        else if (ts.isTemplateExpression(titleNode)) {
          const head = titleNode.head.text;
          const tail = titleNode.templateSpans.at(-1).literal.text;
          const last = fullName.includes(" > ")
            ? fullName.slice(fullName.lastIndexOf(" > ") + 3)
            : fullName;
          found = (head !== "" || tail !== "") && last.startsWith(head) && last.endsWith(tail);
        }
        if (found) return;
      }
      ts.forEachChild(child, visit);
    };
    visit(statement);
    return found;
  };

  // --- resolve the killer ---
  const candidates = [];
  let unsupported = false;
  const bodyStatements = (callback) => {
    if (ts.isBlock(callback.body)) return [...callback.body.statements];
    if (containsRegistration(callback.body)) unsupported = true;
    return [];
  };
  const walk = (statements, prefix, chain) => {
    for (const statement of statements) {
      const registration = staticRegistration(statement);
      if (registration) {
        const full = prefix === null ? registration.title : `${prefix} > ${registration.title}`;
        if (registration.kind === "describe") {
          if (fullName.startsWith(`${full} > `))
            walk(bodyStatements(registration.callback), full, [...chain, registration]);
        } else if (full === fullName) candidates.push({ chain, leaf: registration });
        continue;
      }
      if (containsRegistration(statement) && mayGenerateKiller(statement)) unsupported = true;
    }
  };
  walk(sf.statements, null, []);
  if (unsupported)
    throw new NamedKillerBindingError(
      "unsupported",
      "named killer registration is unsupported: a dynamic, templated, generated or wrapped registration shares its path",
    );
  if (candidates.length === 0)
    throw new NamedKillerBindingError(
      "absent",
      `named killer registration is absent from the test source: ${JSON.stringify(fullName)}`,
    );
  if (candidates.length > 1)
    throw new NamedKillerBindingError(
      "ambiguous",
      `named killer registration is ambiguous: ${candidates.length} registrations share ${JSON.stringify(fullName)}`,
    );
  const { chain, leaf } = candidates[0];
  const pathStatements = new Set([...chain.map((entry) => entry.statement), leaf.statement]);

  // --- declarations and import bindings ---
  const bindingNames = (name, out) => {
    if (ts.isIdentifier(name)) out.push(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
      for (const element of name.elements)
        if (ts.isBindingElement(element)) bindingNames(element.name, out);
    return out;
  };
  const declaredNames = (statement) => {
    if (ts.isVariableStatement(statement))
      return statement.declarationList.declarations.flatMap((declaration) =>
        bindingNames(declaration.name, []),
      );
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name &&
      ts.isIdentifier(statement.name)
    )
      return [statement.name.text];
    return [];
  };
  const isDeclarationStatement = (statement) =>
    ts.isVariableStatement(statement) ||
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement);
  const declarationIndex = new Map();
  const imports = [];
  const runtimeSpecifiers = new Set();
  for (const statement of sf.statements) {
    for (const name of declaredNames(statement)) {
      if (!declarationIndex.has(name)) declarationIndex.set(name, []);
      declarationIndex.get(name).push(statement);
    }
    if (ts.isImportDeclaration(statement)) {
      const module = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      const declarationTypeOnly = clause?.isTypeOnly === true;
      if (!declarationTypeOnly) runtimeSpecifiers.add(module);
      if (!clause) continue;
      if (clause.name)
        imports.push({ module, imported: "default", local: clause.name.text, typeOnly: declarationTypeOnly });
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named))
        imports.push({ module, imported: "*", local: named.name.text, typeOnly: declarationTypeOnly });
      else if (named)
        for (const element of named.elements)
          imports.push({
            module,
            imported: (element.propertyName ?? element.name).text,
            local: element.name.text,
            typeOnly: declarationTypeOnly || element.isTypeOnly === true,
          });
    } else if (ts.isImportEqualsDeclaration(statement)) {
      if (ts.isExternalModuleReference(statement.moduleReference)) {
        const module = statement.moduleReference.expression.text;
        if (!statement.isTypeOnly) runtimeSpecifiers.add(module);
        imports.push({ module, imported: "=", local: statement.name.text, typeOnly: statement.isTypeOnly === true });
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      !statement.isTypeOnly
    )
      runtimeSpecifiers.add(statement.moduleSpecifier.text);
  }

  // --- load-time effects ---
  const isFunctionBoundary = (node) =>
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node);
  const hasLoadEffect = (node) => {
    let found = false;
    const visit = (child) => {
      if (found || isFunctionBoundary(child)) return;
      if (
        ts.isCallExpression(child) ||
        ts.isNewExpression(child) ||
        ts.isAwaitExpression(child) ||
        ts.isTaggedTemplateExpression(child) ||
        ts.isDeleteExpression(child) ||
        ((ts.isPrefixUnaryExpression(child) || ts.isPostfixUnaryExpression(child)) &&
          (child.operator === ts.SyntaxKind.PlusPlusToken ||
            child.operator === ts.SyntaxKind.MinusMinusToken)) ||
        (ts.isBinaryExpression(child) &&
          child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          child.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
      ) {
        found = true;
        return;
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };
  const declarationHasLoadEffect = (statement) => {
    if (ts.isVariableStatement(statement)) return hasLoadEffect(statement.declarationList);
    if (ts.isEnumDeclaration(statement))
      return statement.members.some((member) => member.initializer && hasLoadEffect(member.initializer));
    if (ts.isClassDeclaration(statement)) {
      if ((ts.getDecorators(statement) ?? []).length > 0) return true;
      if ((statement.heritageClauses ?? []).some((clause) => hasLoadEffect(clause))) return true;
      return statement.members.some((member) => {
        if (ts.isClassStaticBlockDeclaration(member)) return true;
        if (member.name && ts.isComputedPropertyName(member.name) && hasLoadEffect(member.name))
          return true;
        return (
          ts.isPropertyDeclaration(member) &&
          (member.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) &&
          member.initializer !== undefined &&
          hasLoadEffect(member.initializer)
        );
      });
    }
    return false;
  };

  // --- the six parts ---
  const target = raw(leaf.statement);
  const scope = chain.map((entry, depth) => {
    const next = depth + 1 < chain.length ? chain[depth + 1].statement : leaf.statement;
    const callbackStatements = ts.isBlock(entry.callback.body) ? [...entry.callback.body.statements] : [];
    return {
      title: entry.title,
      callee: raw(entry.call.expression),
      options: entry.options.map(raw),
      statements: callbackStatements
        .filter((statement) => statement !== next && !isPlainRegistration(statement))
        .map(raw),
      nodes: [
        ...entry.options,
        ...callbackStatements.filter((statement) => statement !== next && !isPlainRegistration(statement)),
      ],
    };
  });
  const effectNodes = [];
  for (const statement of sf.statements) {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement) ||
      ts.isExportDeclaration(statement) ||
      ts.isEmptyStatement(statement) ||
      pathStatements.has(statement) ||
      isPlainRegistration(statement)
    )
      continue;
    if (containsRegistration(statement)) effectNodes.push(statement);
    else if (!isDeclarationStatement(statement)) effectNodes.push(statement);
    else if (declarationHasLoadEffect(statement)) effectNodes.push(statement);
  }
  const effects = effectNodes.map(raw);

  const referenced = (nodes) => {
    const names = new Set();
    const visit = (node) => {
      if (ts.isIdentifier(node)) names.add(node.text);
      ts.forEachChild(node, visit);
    };
    for (const node of nodes) visit(node);
    return names;
  };
  const seedNodes = [leaf.statement, ...scope.flatMap((entry) => entry.nodes), ...effectNodes];
  const included = new Set();
  let frontier = seedNodes;
  while (frontier.length > 0) {
    const next = [];
    for (const name of referenced(frontier))
      for (const statement of declarationIndex.get(name) ?? [])
        if (!included.has(statement)) {
          included.add(statement);
          next.push(statement);
        }
    frontier = next;
  }
  const declarations = [...included]
    .sort((left, right) => left.getStart(sf) - right.getStart(sf))
    .map(raw);
  const usedNames = referenced([...seedNodes, ...included]);
  const importRecords = imports
    .filter((record) => usedNames.has(record.local))
    .map((record) => canonical(record))
    .sort();

  // --- file flags ---
  let hasOnly = false;
  const visitFlags = (node) => {
    if (hasOnly) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "only" &&
      KILLER_REGISTRATION_ROOTS.has(registrationRoot(node.expression))
    )
      hasOnly = true;
    else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["fit", "fdescribe"].includes(node.expression.text)
    )
      hasOnly = true;
    ts.forEachChild(node, visitFlags);
  };
  visitFlags(sf);
  const pragmas = [...source.matchAll(/@vitest-[A-Za-z][\w-]*[^\n]*/g)]
    .map((match) => match[0].trim())
    .sort();

  return {
    name: fullName,
    target,
    scope: scope.map(({ title, callee, options, statements }) => ({ title, callee, options, statements })),
    effects,
    declarations,
    imports: { bindings: importRecords, runtimeSpecifiers: [...runtimeSpecifiers].sort() },
    flags: { only: hasOnly, pragmas },
  };
}

/**
 * SHA-256 of the named killer's source closure inside `source` (see the block comment above).
 * Memoized per (SHA-256 of the source, test name) in a bounded map; never keyed by name alone.
 */
export function namedKillerBinding(source, fullTestName) {
  if (typeof source !== "string" || typeof fullTestName !== "string")
    throw new NamedKillerBindingError("syntax", "named killer binding needs source text and a test name");
  const key = `${hash(source)}\0${fullTestName}`;
  const cached = namedKillerCache.get(key);
  if (cached !== undefined) return cached;
  const digest = hash(canonical(namedKillerClosure(source, fullTestName)));
  if (namedKillerCache.size >= NAMED_KILLER_CACHE_LIMIT)
    namedKillerCache.delete(namedKillerCache.keys().next().value);
  namedKillerCache.set(key, digest);
  return digest;
}

function cstringDirectKill(report, record, expectedTest, readTest, label) {
  if (record.status !== "Killed")
    throw new Error(`${label} is ${record.status}, not Killed`);
  const matching = record.killedBy.filter(
    (test) =>
      test.file === expectedTest.file && test.name === expectedTest.name,
  );
  if (matching.length !== 1)
    throw new Error(`${label} is not directly killed by its named test`);
  const tableEntry = report.testFiles?.[expectedTest.file];
  if (
    !tableEntry ||
    typeof tableEntry.source !== "string" ||
    !Array.isArray(tableEntry.tests) ||
    !tableEntry.tests.some((test) => test.name === expectedTest.name)
  )
    throw new Error(`${label} named killer is absent from its report test table`);
  if (readTest) {
    // The named killer's own closure is compared, never whole test-file bytes (Plan 67-59).
    let embedded;
    let live;
    try {
      embedded = namedKillerBinding(tableEntry.source, expectedTest.name);
      live = namedKillerBinding(readTest(expectedTest.file), expectedTest.name);
    } catch (error) {
      if (error instanceof NamedKillerBindingError)
        throw new Error(`${label} ${error.message}`);
      throw error;
    }
    if (embedded !== live) throw new Error(`${label} named killer source is stale`);
  }
  return { file: expectedTest.file, name: expectedTest.name };
}

/**
 * Validate the one measured readCString source operation. Its receipt carries
 * complete raw Stryker reports so --pre and copied candidate checks do not
 * depend on ignored report files. The original frozen key remains unchanged;
 * only its exact current equivalent is reconciled across mutator kinds.
 */
export function validateReadCStringBoundary({
  row,
  root,
  currentSource = null,
  finalEntry = null,
  finalReport = null,
  readTest = null,
  survivors = null,
  requireFinal = false,
  allowLiveReport = false,
}) {
  const problems = [];
  const anchors = [];
  let equivalentPair = null;
  const counterpartProofs = [];
  const fail = (message) => problems.push(`${row?.id ?? "source operation"}: ${message}`);
  try {
    const receipt = row?.sourceOperation;
    if (!receipt || receipt.version !== 1)
      throw new Error("missing version-1 sourceOperation receipt");
    if (
      row.id !== `${CSTRING_EQUIVALENT_ORIGIN}:equivalent-01` ||
      row.originClusterId !== CSTRING_EQUIVALENT_ORIGIN ||
      row.group !== "isobmff" ||
      row.file !== CSTRING_OPERATION.file ||
      row.function !== CSTRING_OPERATION.function ||
      row.mutatorName !== "EqualityOperator" ||
      row.disposition !== "equivalent" ||
      row.equivalenceClass !== "equivalent-arithmetic" ||
      row.count !== 1 ||
      canonical(row.keys) !== canonical([CSTRING_EQUIVALENT_KEY])
    )
      throw new Error("sourceOperation row differs from the immutable EOF-only owner");
    if (
      receipt.operation !== CSTRING_OPERATION.operation ||
      receipt.file !== CSTRING_OPERATION.file ||
      receipt.function !== CSTRING_OPERATION.function ||
      receipt.occurrence !== CSTRING_OPERATION.occurrence ||
      receipt.before !== CSTRING_OPERATION.before ||
      receipt.after !== CSTRING_OPERATION.after ||
      receipt.beforeRef !== CSTRING_BOUNDARY_BASE ||
      receipt.originalKey !== CSTRING_EQUIVALENT_KEY ||
      receipt.originalOrigin !== CSTRING_EQUIVALENT_ORIGIN ||
      receipt.beforeSourceSha256 !== CSTRING_BOUNDARY_SOURCE_SHA256
    )
      throw new Error("sourceOperation site, original key or permanent source binding differs");
    const expectedReceiptFields = [
      "version", "operation", "file", "function", "occurrence", "before", "after",
      "beforeRef", "beforeSourceSha256", "originalKey", "originalOrigin",
      "reports", "candidateSourceSha256", "candidateRawSourceSha256",
      "anchorMappings", "beforeAffected", "candidateAffected", "equivalentPair",
      "counterpartProofs", "counterfactuals", "campaignLogs", "referenceTrace",
    ].sort();
    if (canonical(Object.keys(receipt).sort()) !== canonical(expectedReceiptFields))
      throw new Error("sourceOperation receipt has missing or unexpected fields");
    if (receipt.referenceTrace !== CSTRING_REFERENCE_TRACE)
      throw new Error("sourceOperation caller and integer-bound reference trace differs");

    const trackedPath = safeRelative(root, CSTRING_OPERATION.file, "sourceOperation source");
    const beforeSource = gitSource(root, receipt.beforeRef, CSTRING_OPERATION.file);
    if (hash(normalizeDirectives(beforeSource)) !== CSTRING_BOUNDARY_SOURCE_SHA256)
      throw new Error("sourceOperation permanent Git source differs from the measured ancestor");
    const normalizedBefore = normalizeDirectives(beforeSource);
    if (receipt.occurrence !== 0)
      throw new Error("sourceOperation expression is missing or ambiguous in readCString");
    const beforeExpression = cstringExpressionOffset(normalizedBefore, CSTRING_OPERATION.before);
    const normalizedCandidate =
      normalizedBefore.slice(0, beforeExpression) +
      CSTRING_OPERATION.after +
      normalizedBefore.slice(beforeExpression + CSTRING_OPERATION.before.length);

    if (!receipt.reports || typeof receipt.reports !== "object")
      throw new Error("sourceOperation report bindings are missing");
    const expectedReportNames = ["before", "unannotated", "final"].sort();
    if (canonical(Object.keys(receipt.reports).sort()) !== canonical(expectedReportNames))
      throw new Error("sourceOperation report binding set differs from the measured campaigns");
    const expectedCanonicalReportDigests = {
      before: CSTRING_BEFORE_REPORT_CANONICAL_SHA256,
      unannotated: CSTRING_UNANNOTATED_REPORT_CANONICAL_SHA256,
      final: CSTRING_FINAL_REPORT_CANONICAL_SHA256,
    };
    const parsedReports = {};
    for (const name of expectedReportNames) {
      const binding = receipt.reports[name];
      if (
        !binding ||
        canonical(Object.keys(binding).sort()) !==
          canonical(["raw", "sha256", "canonicalSha256"].sort()) ||
        typeof binding.raw !== "string" ||
        hash(binding.raw) !== binding.sha256 ||
        binding.canonicalSha256 !== expectedCanonicalReportDigests[name]
      )
        throw new Error(`${name} sourceOperation report bytes differ from the retained real report`);
      let report;
      try {
        report = JSON.parse(binding.raw);
      } catch (error) {
        throw new Error(`${name} sourceOperation report is invalid JSON: ${error.message}`);
      }
      if (hash(canonical(report)) !== binding.canonicalSha256)
        throw new Error(`${name} sourceOperation canonical report digest mismatch`);
      parsedReports[name] = report;
    }
    const before = cstringRecords(parsedReports.before, "before");
    const unannotated = cstringRecords(parsedReports.unannotated, "unannotated");
    const candidate = cstringRecords(parsedReports.final, "final");
    if (
      hash(before.source) !== CSTRING_BOUNDARY_SOURCE_SHA256 ||
      before.source !== normalizeDirectives(normalizeDirectives(before.entry.source)) ||
      hash(unannotated.source) !== CSTRING_CANDIDATE_SOURCE_SHA256 ||
      hash(candidate.source) !== CSTRING_CANDIDATE_SOURCE_SHA256 ||
      receipt.candidateSourceSha256 !== CSTRING_CANDIDATE_SOURCE_SHA256 ||
      hash(candidate.entry.source) !== CSTRING_FINAL_RAW_SOURCE_SHA256 ||
      receipt.candidateRawSourceSha256 !== CSTRING_FINAL_RAW_SOURCE_SHA256 ||
      before.source !== normalizedBefore ||
      unannotated.source !== normalizedCandidate ||
      candidate.source !== normalizedCandidate
    )
      throw new Error("sourceOperation before/candidate source differs from the exact single-site edit");
    if (
      before.records.length !== 593 ||
      unannotated.records.length !== 594 ||
      candidate.records.length !== 594 ||
      canonical(cstringStatusCounts(before.records)) !== canonical({
        Ignored: 53, Killed: 319, CompileError: 193, Timeout: 3, Survived: 24, NoCoverage: 1,
      }) ||
      canonical(cstringStatusCounts(unannotated.records)) !== canonical({
        Ignored: 53, Killed: 320, CompileError: 193, Timeout: 3, Survived: 24, NoCoverage: 1,
      }) ||
      canonical(cstringStatusCounts(candidate.records)) !== canonical({
        Ignored: 54, Killed: 320, CompileError: 193, Timeout: 3, Survived: 23, NoCoverage: 1,
      })
    )
      throw new Error("sourceOperation full-file mutant counts differ from the measured reports");
    const directives = candidate.entry.source
      .split("\n")
      .flatMap((line, index) => line.trim() === CSTRING_EQUIVALENT_DIRECTIVE ? [index] : []);
    if (
      directives.length !== 1 ||
      candidate.entry.source.split("\n")[directives[0] + 1]?.trim() !==
        `while (${CSTRING_OPERATION.after} && buffer[end] !== 0) end += 1;` ||
      candidate.entry.source.includes("Stryker disable next-line EqualityOperator")
    )
      throw new Error("candidate source lacks the exact ArithmeticOperator-only directive layout");

    const mappings = [];
    const currentByAnchor = new Map(candidate.records.map((record) => [record.anchor, record]));
    for (const record of before.records)
      if (currentByAnchor.has(record.anchor))
        mappings.push({ current: record.anchor, original: record.anchor });
    const oldEquivalent = cstringUnique(
      before.records,
      (record) => record.mutatorName === "EqualityOperator" &&
        record.replacement === "end <= buffer.length" && record.status === "Survived",
      "original EOF-only equality survivor",
    );
    const currentEquivalent = cstringUnique(
      candidate.records,
      (record) => record.mutatorName === "ArithmeticOperator" &&
        record.replacement === "buffer.length + 1" && record.status === "Ignored" &&
        /^equivalent-arithmetic — \S/.test(String(record.mutant.statusReason ?? "")),
      "comment-owned current arithmetic equivalent",
    );
    const beforeEdit = cstringExpressionOffset(before.source, CSTRING_OPERATION.before);
    const afterEdit = beforeEdit + CSTRING_OPERATION.before.length;
    const candidateEdit = cstringExpressionOffset(candidate.source, CSTRING_OPERATION.after);
    const candidateEnd = candidateEdit + CSTRING_OPERATION.after.length;
    const impact = (records, start, end) => records
      .filter((record) => (record.start <= start && record.end >= end) ||
        (record.start < end && record.end > start))
      .map((record) => ({
        anchor: record.anchor,
        mutatorName: record.mutatorName,
        replacement: record.replacement,
        status: record.status,
        killedBy: record.killedBy,
      }))
      .sort((left, right) => left.anchor.localeCompare(right.anchor));
    const beforeSite = before.records.filter((record) =>
      (record.start <= beforeEdit && record.end >= afterEdit) ||
      (record.start < afterEdit && record.end > beforeEdit),
    );
    const candidateSite = candidate.records.filter((record) =>
      (record.start <= candidateEdit && record.end >= candidateEnd) ||
      (record.start < candidateEnd && record.end > candidateEdit),
    );
    const sitePairs = [
      {
        old: (record) => record.mutatorName === "BlockStatement" && record.replacement === "{}" && record.status === "CompileError",
        current: (record) => record.mutatorName === "BlockStatement" && record.replacement === "{}" && record.status === "CompileError",
      },
      {
        old: (record) => record.mutatorName === "ConditionalExpression" && record.replacement === "false" && record.status === "Killed",
        current: (record) => record.mutatorName === "ConditionalExpression" && record.replacement === "false" && record.status === "Killed",
      },
      {
        old: (record) => record.mutatorName === "LogicalOperator" && record.replacement === "end < buffer.length || buffer[end] !== 0" && record.status === "Timeout",
        current: (record) => record.mutatorName === "LogicalOperator" && record.replacement === "end <= buffer.length - 1 || buffer[end] !== 0" && record.status === "Timeout",
      },
      {
        old: (record) => record.mutatorName === "ConditionalExpression" && record.replacement === "true" && record.status === "Timeout",
        current: (record) => record.mutatorName === "ConditionalExpression" && record.replacement === "true" && record.status === "Timeout",
      },
      {
        old: (record) => record.mutatorName === "EqualityOperator" && record.replacement === "end >= buffer.length" && record.status === "Killed",
        current: (record) => record.mutatorName === "EqualityOperator" && record.replacement === "end > buffer.length - 1" && record.status === "Killed",
      },
    ];
    for (const [index, pair] of sitePairs.entries()) {
      const old = cstringUnique(beforeSite, pair.old, `site mapping ${index + 1} original`);
      const current = cstringUnique(candidateSite, pair.current, `site mapping ${index + 1} current`);
      if (
        old.anchor === current.anchor ||
        mappings.some((mapping) => mapping.original === old.anchor || mapping.current === current.anchor)
      )
        throw new Error(`site mapping ${index + 1} collides with another correspondence`);
      mappings.push({ current: current.anchor, original: old.anchor });
    }
    const survivorMatches = Array.isArray(survivors)
      ? survivors.filter((member) => member.key === CSTRING_EQUIVALENT_KEY)
      : [];
    if (
      survivorMatches.length !== 1 ||
      survivorMatches[0].file !== CSTRING_OPERATION.file ||
      survivorMatches[0].function !== CSTRING_OPERATION.function ||
      survivorMatches[0].mutatorName !== "EqualityOperator" ||
      survivorMatches[0].anchorKey !== oldEquivalent.anchor ||
      survivorMatches[0].status !== "Survived"
    )
      throw new Error("original EOF-only key differs from its immutable survivor snapshot");
    if (row.anchors?.length !== 1 || row.anchors[0] !== currentEquivalent.rawAnchor)
      throw new Error("equivalent owner does not name the one actual current raw comment anchor");
    const currentCanonicalKeys = new Set(mappings.map((pair) => pair.current));
    const originalCanonicalKeys = new Set(mappings.map((pair) => pair.original));
    if (
      currentCanonicalKeys.has(currentEquivalent.anchor) ||
      originalCanonicalKeys.has(oldEquivalent.anchor)
    )
      throw new Error("cross-mutator equivalent pair collides with an exact anchor mapping");
    mappings.push({ current: currentEquivalent.anchor, original: oldEquivalent.anchor });
    mappings.sort((left, right) => left.current.localeCompare(right.current));
    if (
      canonical(
        [...receipt.anchorMappings].sort((left, right) =>
          String(left.current).localeCompare(String(right.current)),
        ),
      ) !== canonical(mappings) ||
      new Set(mappings.map((pair) => pair.current)).size !== mappings.length ||
      new Set(mappings.map((pair) => pair.original)).size !== mappings.length
    )
      throw new Error("sourceOperation anchor mapping is incomplete, non-injective or forged");
    anchors.push(...mappings);
    equivalentPair = {
      current: currentEquivalent.anchor,
      original: oldEquivalent.anchor,
    };
    if (
      canonical(receipt.equivalentPair) !== canonical({
        current: currentEquivalent.rawAnchor,
        currentCanonical: currentEquivalent.anchor,
        originalKey: CSTRING_EQUIVALENT_KEY,
        original: oldEquivalent.anchor,
      })
    )
      throw new Error("sourceOperation cross-mutator pair differs from the measured unique EOF survivor");

    const beforeAffected = impact(before.records, beforeEdit, afterEdit);
    const candidateAffected = impact(candidate.records, candidateEdit, candidateEnd);
    if (
      beforeAffected.length !== 6 || candidateAffected.length !== 7 ||
      canonical(receipt.beforeAffected) !== canonical(beforeAffected) ||
      canonical(receipt.candidateAffected) !== canonical(candidateAffected)
    )
      throw new Error("sourceOperation complete affected inventories differ from full reports");

    const testBindings = [
      {
        label: "old loop opposite",
        report: parsedReports.before,
        records: before.records,
        mutator: "EqualityOperator",
        replacement: "end >= buffer.length",
        test: {
          file: "tests/isobmff_writer.test.ts",
          name: "tracer: heif-enc-grid.heic rebuild (62-02) > rebuilds heif-enc-grid.heic end to end: removes Exif/XMP, preserves every surviving item byte-identical, leaks none of the removed payload, and re-admits",
        },
      },
      {
        label: "old NUL-predicate opposite",
        report: parsedReports.before,
        records: before.records,
        mutator: "EqualityOperator",
        replacement: "buffer[end] === 0",
        test: {
          file: "tests/isobmff_writer.test.ts",
          name: "tracer: heif-enc-grid.heic rebuild (62-02) > rebuilds heif-enc-grid.heic end to end: removes Exif/XMP, preserves every surviving item byte-identical, leaks none of the removed payload, and re-admits",
        },
      },
      {
        label: "current loop opposite",
        report: parsedReports.final,
        records: candidate.records,
        mutator: "EqualityOperator",
        replacement: "end > buffer.length - 1",
        test: {
          file: "tests/isobmff_items.test.ts",
          name: "parseIsobmff item graph on heif-enc-grid.heic > matches the independent inventory walker's items, references, properties and associations",
        },
      },
      {
        label: "current NUL-predicate opposite",
        report: parsedReports.final,
        records: candidate.records,
        mutator: "EqualityOperator",
        replacement: "buffer[end] === 0",
        test: {
          file: "tests/isobmff_items.test.ts",
          name: "parseIsobmff item graph on heif-enc-grid.heic > matches the independent inventory walker's items, references, properties and associations",
        },
      },
    ];
    const expectedCounterparts = testBindings.map((binding) => {
      const record = cstringUnique(
        binding.records,
        (candidateRecord) => candidateRecord.mutatorName === binding.mutator &&
          candidateRecord.replacement === binding.replacement,
        binding.label,
      );
      const killer = cstringDirectKill(
        binding.report,
        record,
        binding.test,
        readTest,
        binding.label,
      );
      return {
        label: binding.label,
        anchor: record.anchor,
        mutatorName: record.mutatorName,
        replacement: record.replacement,
        status: record.status,
        test: killer,
      };
    });
    const semanticCounterparts = [
      {
        old: expectedCounterparts[0],
        current: expectedCounterparts[2],
      },
      {
        old: expectedCounterparts[1],
        current: expectedCounterparts[3],
      },
    ];
    if (canonical(receipt.counterpartProofs) !== canonical(semanticCounterparts))
      throw new Error("sourceOperation counterpart proofs do not match direct real killedBy evidence");
    counterpartProofs.push(...semanticCounterparts);

    if (!Array.isArray(receipt.counterfactuals) || receipt.counterfactuals.length !== CSTRING_COUNTERFACTUALS.length)
      throw new Error("sourceOperation counterfactual inventory is incomplete");
    const verifiedCounterfactuals = [];
    for (let index = 0; index < CSTRING_COUNTERFACTUALS.length; index++) {
      const expected = CSTRING_COUNTERFACTUALS[index];
      const actual = receipt.counterfactuals[index];
      if (
        !actual ||
        canonical(Object.keys(actual).sort()) !== canonical([
          "id", "alteredSource", "sourceSha256", "greenTestLog", "greenTestLogSha256", "greenExitCode", "testLog", "testLogSha256", "exitCode", "testFile", "testName", "assertion",
        ].sort()) ||
        actual.id !== expected.id || actual.sourceSha256 !== expected.sourceSha256 ||
        actual.testLogSha256 !== expected.testLogSha256 || hash(actual.testLog ?? "") !== expected.testLogSha256 ||
        actual.greenTestLogSha256 !== expected.greenTestLogSha256 || hash(actual.greenTestLog ?? "") !== expected.greenTestLogSha256 ||
        actual.greenExitCode !== 0 || !String(actual.greenTestLog).includes("Tests  1 passed") ||
        actual.exitCode !== 1 || actual.testFile !== expected.testFile ||
        actual.testName !== expected.testName || actual.assertion !== expected.assertion ||
        !String(actual.testLog).includes(expected.assertion)
      )
        throw new Error(`${expected.id} executed counterfactual evidence is missing or stale`);
      const alteredPositions = [];
      let at = 0;
      while ((at = before.entry.source.indexOf(expected.before, at)) !== -1) {
        alteredPositions.push(at);
        at += expected.before.length;
      }
      if (alteredPositions.length !== 1)
        throw new Error(`${expected.id} counterfactual source site is ambiguous`);
      const alteredSource = before.entry.source.slice(0, alteredPositions[0]) +
        expected.after + before.entry.source.slice(alteredPositions[0] + expected.before.length);
      if (
        actual.alteredSource !== alteredSource ||
        hash(actual.alteredSource) !== expected.sourceSha256 ||
        !actual.testLog.includes(expected.testName)
      )
        throw new Error(`${expected.id} altered source bytes or named failing test differ from the executed counterfactual`);
      verifiedCounterfactuals.push({
        id: expected.id,
        sourceSha256: expected.sourceSha256,
        greenTestLogSha256: expected.greenTestLogSha256,
        greenExitCode: 0,
        testLogSha256: expected.testLogSha256,
        exitCode: 1,
      });
    }
    const expectedLogBindings = {
      before: { sha256: "344a079d505629c126fdc892fc9da01de26ef924983ffd7732a82fe134ef5377" },
      unannotated: { sha256: "84c3a37250ae62416191be2b3d7187112f74378f51a266f44148136a1cf6645c" },
      final: { sha256: "8330735b0bca891e0dab0bb996ee1bdff9ac7db31f442e05dd05fbb41ad5159f" },
    };
    if (
      !receipt.campaignLogs || canonical(Object.keys(receipt.campaignLogs).sort()) !== canonical(["before", "final", "unannotated"].sort()) ||
      ["before", "unannotated", "final"].some((name) =>
        receipt.campaignLogs[name]?.sha256 !== expectedLogBindings[name].sha256 ||
        hash(receipt.campaignLogs[name]?.raw ?? "") !== expectedLogBindings[name].sha256 ||
        !receipt.campaignLogs[name].raw.includes("Initial test run succeeded. Ran 1187 tests")
      )
    )
      throw new Error("sourceOperation green full-suite campaign logs are absent or stale");
    if (canonical(verifiedCounterfactuals) !== canonical(receipt.counterfactuals.map(({ id, sourceSha256, greenTestLogSha256, greenExitCode, testLogSha256, exitCode }) => ({ id, sourceSha256, greenTestLogSha256, greenExitCode, testLogSha256, exitCode }))))
      throw new Error("sourceOperation counterfactual verification table differs");

    if (requireFinal) {
      const diskSource = readFileSync(trackedPath, "utf8");
      const selectedSource = typeof currentSource === "string" ? currentSource : diskSource;
      if (
        selectedSource !== diskSource ||
        hash(selectedSource) !== CSTRING_FINAL_RAW_SOURCE_SHA256 ||
        hash(normalizeDirectives(selectedSource)) !== CSTRING_CANDIDATE_SOURCE_SHA256 ||
        !finalEntry || hash(finalEntry.source ?? "") !== CSTRING_FINAL_RAW_SOURCE_SHA256 ||
        !finalReport || (allowLiveReport
          ? !cstringEquivalentReport(finalReport, parsedReports.final)
          : canonical(finalReport) !== canonical(parsedReports.final))
      )
        throw new Error("live sourceOperation source/report differs from the exact measured candidate");
      for (const [file, entry] of Object.entries(finalReport.testFiles ?? {})) {
        if (typeof entry.source !== "string" || !Array.isArray(entry.tests))
          throw new Error(`final sourceOperation test table is incomplete for ${file}`);
        // Structural completeness only. Named-killer closures are enforced in
        // cstringDirectKill; a test file that holds no named killer carries no receipt claim,
        // so its bytes are not compared here (Plan 67-59).
      }
    }
    return { problems, anchors, equivalentPair, counterpartProofs };
  } catch (error) {
    fail(error.message);
    return { problems, anchors: [], equivalentPair: null, counterpartProofs: [] };
  }
}

export {
  canonical as canonicalReceiptJson,
  normalizeDirectives as normalizeReceiptSource,
};
