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
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { anchorKey, mutantKey } from "./identity.mjs";
import { enclosingFunction } from "./cluster.mjs";

const DIRECTIVE = /^\s*\/\/ Stryker (?:disable|restore)\b/;
const DETECTED = new Set(["Killed", "Timeout"]);
const ISOBMFF_ADMISSION_BASE = "cb8eedde27eaa6b2a54cb9f2008d91292a8b3bba";
const hex256 = /^[a-f0-9]{64}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const normalizeDirectives = (source) => source.split("\n").filter((line) => !DIRECTIVE.test(line)).join("\n");
const show = (key) => String(key).replaceAll("\u0000", "|");

function safeRelative(root, relative, label) {
  if (typeof relative !== "string" || relative === "" || isAbsolute(relative) ||
      relative.split(/[\\/]/).includes("..")) throw new Error(`${label}: unsafe relative path`);
  const path = resolve(root, relative);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`${label}: path escapes root`);
  if (existsSync(path)) {
    const actual = realpathSync(path), base = realpathSync(root);
    if (actual !== base && !actual.startsWith(`${base}${sep}`)) throw new Error(`${label}: symlink escapes root`);
    return actual;
  }
  return path;
}

function gitSource(root, ref, file) {
  if (typeof ref !== "string" || ref === "" || ref.startsWith("-") || ref.includes("\0"))
    throw new Error("beforeRef is missing or invalid");
  const safeFile = file.replaceAll("\\", "/");
  if (!safeFile || safeFile.startsWith("/") || safeFile.split("/").includes(".."))
    throw new Error("receipt file path is unsafe");
  try {
    return execFileSync("git", ["show", `${ref}:${safeFile}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(`beforeRef source unavailable (${ref}:${safeFile}); full history is required and no fetch fallback is allowed`);
  }
}

// Mask comments and literals while preserving every UTF-16 offset. This small
// lexical pass is sufficient to select brace-delimited function bodies without
// mistaking braces in strings/comments for syntax; it intentionally fails closed
// when a named body cannot be selected uniquely.
function maskNonCode(source) {
  const chars = source.split("");
  let quote = null, lineComment = false, blockComment = false, escaped = false;
  for (let i = 0; i < chars.length; i++) {
    const c = source[i], n = source[i + 1];
    if (lineComment) { if (c === "\n") lineComment = false; else chars[i] = " "; continue; }
    if (blockComment) { if (c === "*" && n === "/") { chars[i] = chars[i + 1] = " "; i++; blockComment = false; } else if (c !== "\n") chars[i] = " "; continue; }
    if (quote !== null) {
      if (c !== "\n") chars[i] = " ";
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && n === "/") { chars[i] = chars[i + 1] = " "; i++; lineComment = true; continue; }
    if (c === "/" && n === "*") { chars[i] = chars[i + 1] = " "; i++; blockComment = true; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; chars[i] = " "; }
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
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`invalid function name ${JSON.stringify(name)}`);
  const mask = maskNonCode(source);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = new RegExp(`\\b${escaped}\\b`, "g");
  const containers = [];
  const stack = [];
  for (let at = 0; at < mask.length; at++) {
    if (mask[at] === "{") {
      const boundary = Math.max(mask.lastIndexOf("}", at - 1), mask.lastIndexOf(";", at - 1));
      const prefix = mask.slice(boundary + 1, at);
      const kind = /\bclass\s+[A-Za-z_$][\w$]*(?:\s+extends\b[\s\S]*)?\s*$/.test(prefix)
        ? "class"
        : /(?:=|:|\breturn|\(|,)\s*$/.test(prefix) ? "object" : "block";
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
    return at + name.length + assignment[0].length + rest.length - afterParameters.length + body[0].lastIndexOf("{");
  };

  const bodies = [];
  for (const m of mask.matchAll(token)) {
    const at = m.index;
    const prefix = mask.slice(Math.max(0, at - 80), at);
    let body = -1;
    if (/\bfunction\s*\*?\s*$/.test(prefix)) body = bodyAfterParameters(at);
    else {
      body = arrowBody(at);
      if (body < 0 && containers[mask.lastIndexOf("{", at - 1)] &&
          ["class", "object"].includes(containers[mask.lastIndexOf("{", at - 1)])) {
        const boundary = Math.max(mask.lastIndexOf("{", at - 1), mask.lastIndexOf("}", at - 1),
          mask.lastIndexOf(",", at - 1), mask.lastIndexOf(";", at - 1));
        const memberPrefix = mask.slice(boundary + 1, at);
        if (/^\s*(?:(?:async|static|public|private|protected|readonly|override|abstract|get|set)\s+)*\*?\s*$/.test(memberPrefix))
          body = bodyAfterParameters(at);
      }
    }
    if (body < 0 || mask[body] !== "{") continue;
    const end = matching(mask, body);
    if (end < 0) continue;
    bodies.push({ start: body, end: end + 1, function: name });
  }
  if (bodies.length !== 1) throw new Error(`function ${name} is ${bodies.length === 0 ? "missing" : "ambiguous"}`);
  return bodies[0];
}

export function applyEdits(source, edits) {
  let current = source;
  const validated = [];
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index];
    if (!edit || typeof edit.function !== "string" || typeof edit.before !== "string" ||
        edit.before === "" || typeof edit.after !== "string" || edit.before === edit.after ||
        (edit.after !== "" && (!edit.before.includes(edit.after) ||
          edit.before.indexOf(edit.after) !== edit.before.lastIndexOf(edit.after))) ||
        !Number.isInteger(edit.occurrence) || edit.occurrence < 0)
      throw new Error(`edit ${index}: empty, ambiguous or non-deletion edit`);
    const bounds = functionBounds(current, edit.function);
    const body = current.slice(bounds.start, bounds.end);
    const positions = [];
    let from = 0, at;
    while ((at = body.indexOf(edit.before, from)) !== -1) { positions.push(bounds.start + at); from = at + Math.max(1, edit.before.length); }
    if (positions.length <= edit.occurrence) throw new Error(`edit ${index}: exact expression occurrence ${edit.occurrence} is missing`);
    const selected = positions[edit.occurrence];
    const lexical = maskNonCode(current).slice(selected, selected + edit.before.length);
    const lexicalPattern = maskNonCode(edit.before);
    if (!/\S/.test(lexicalPattern) ||
        lexical.replace(/\s/g, "") !== lexicalPattern.replace(/\s/g, ""))
      throw new Error(`edit ${index}: selected occurrence is not an exact lexical source expression`);
    const originalStart = mapOffsetToOriginal(selected, validated, "start");
    if (originalStart === null) throw new Error(`edit ${index}: overlaps or edits previously inserted text`);
    if (source.slice(originalStart, originalStart + edit.before.length) !== edit.before)
      throw new Error(`edit ${index}: exact text does not correspond to the pinned before source`);
    for (const prior of validated) {
      const delta = edit.after.length - edit.before.length;
      if (selected + edit.before.length <= prior.currentStart) {
        prior.currentStart += delta; prior.currentEnd += delta; prior.currentAfterEnd += delta;
      } else if (selected < prior.currentEnd && selected + edit.before.length > prior.currentStart) {
        throw new Error(`edit ${index}: overlaps an earlier edit`);
      }
    }
    current = current.slice(0, selected) + edit.after + current.slice(selected + edit.before.length);
    validated.push({ ...edit, start: originalStart, end: originalStart + edit.before.length,
      originalStart, stageStart: selected, currentStart: selected,
      currentEnd: selected + edit.before.length, currentAfterEnd: selected + edit.after.length });
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
      if (edit.after === "") {
        if (at !== afterStart) return null;
        return boundary === "start" ? edit.end : edit.start;
      }
      const index = edit.before.indexOf(edit.after);
      if (index === -1 || edit.before.indexOf(edit.after, index + 1) !== -1) return null;
      return edit.originalStart + index + Math.min(at - afterStart, edit.after.length);
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
  if (!point || !Number.isInteger(point.line) || !Number.isInteger(point.column) ||
      point.line < 1 || point.column < 1 || point.line > lines.length || point.column > lines[point.line - 1].length + 1)
    throw new Error("mutant location is outside source bounds");
  let offset = point.column - 1;
  for (let i = 0; i < point.line - 1; i++) offset += lines[i].length + 1;
  return offset;
}

function toNormalizedLocation(source, location) {
  const lines = source.split("\n");
  const removedBefore = (line) => lines.slice(0, line - 1).filter((item) => DIRECTIVE.test(item)).length;
  return { start: { ...location.start, line: location.start.line - removedBefore(location.start.line) },
    end: { ...location.end, line: location.end.line - removedBefore(location.end.line) } };
}

function evidenceParts(evidence, file) {
  if (!evidence || typeof evidence !== "object") throw new Error("beforeEvidence is missing");
  if (typeof evidence.source === "string" && Array.isArray(evidence.mutants))
    return { source: evidence.source, mutants: evidence.mutants, testFiles: evidence.testFiles ?? {} };
  const entry = evidence.files?.[file];
  if (entry && typeof entry.source === "string" && Array.isArray(entry.mutants))
    return { source: entry.source, mutants: entry.mutants, testFiles: evidence.testFiles ?? {} };
  throw new Error("beforeEvidence must contain the complete file source and mutant table");
}

function resolvedTests(report, mutant) {
  const byId = new Map();
  for (const [file, entry] of Object.entries(report.testFiles ?? {}))
    for (const test of entry.tests ?? []) byId.set(String(test.id), { file, name: test.name });
  return (mutant.killedBy ?? []).map((id) => byId.get(String(id))).filter(Boolean)
    .map(({ file, name }) => ({ file, name })).sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

function referencedTests(report, mutants) {
  const ids = new Set(mutants.flatMap((mutant) => (mutant.killedBy ?? []).map(String)));
  const files = {};
  for (const [file, entry] of Object.entries(report.testFiles ?? {})) {
    const tests = (entry.tests ?? []).filter((test) => ids.has(String(test.id)));
    if (tests.length) files[file] = { ...entry, tests };
  }
  return files;
}

function rawRecord(file, mutant, source, report) {
  const normalizedLocation = toNormalizedLocation(source, mutant.location);
  return { anchor: anchorKey(file, { ...mutant, location: normalizedLocation }, normalizeDirectives(source)), mutatorName: mutant.mutatorName,
    replacement: mutant.replacement ?? "", location: mutant.location, status: mutant.status,
    ...(mutant.statusReason === undefined ? {} : { statusReason: mutant.statusReason }),
    killedBy: resolvedTests(report, mutant) };
}

export function affectedBy(mutant, source, edits) {
  let start, end;
  try {
    const location = toNormalizedLocation(source, mutant.location);
    start = offsetAt(normalizeDirectives(source), location.start);
    end = offsetAt(normalizeDirectives(source), location.end);
  }
  catch { return false; }
  return edits.some((edit) => start < edit.end && end > edit.start);
}

function mapFinalOffsetToBefore(offset, edits, boundary) {
  return mapOffsetToOriginal(offset, edits, boundary);
}

/** Validate one `row.deletion`; no writes, fetches or network operations occur. */
export function validateDeletion({ row, root, currentSource = null, finalEntry = null,
  finalReport = null, readTest = null, survivors = null, requireFinal = false }) {
  const problems = [], anchors = [], validatedEdits = [], removedMutants = [];
  const fail = (message) => problems.push(`${row?.id ?? "dead row"}: ${message}`);
  try {
    const receipt = row?.deletion;
    if (!receipt || receipt.version !== 1) throw new Error("missing version-1 deletion receipt");
    if (typeof row.file !== "string" || receipt.function !== row.function) throw new Error("receipt function does not match owned row");
    if (row.file === "src/isobmff/admission.ts" && receipt.beforeRef !== ISOBMFF_ADMISSION_BASE)
      throw new Error(`isobmff admission receipts must use permanent beforeRef ${ISOBMFF_ADMISSION_BASE}`);
    if (typeof row.symbol !== "string" || row.symbol === "" ||
        !receipt.edits?.some((edit) => edit.function === row.function && edit.before.includes(row.symbol)))
      throw new Error("required dead symbol is not named by its scoped function edit");
    const trackedPath = safeRelative(root, row.file, "receipt source");
    const beforeSource = gitSource(root, receipt.beforeRef, row.file);
    if (!hex256.test(receipt.beforeSourceSha256 ?? "") || hash(beforeSource) !== receipt.beforeSourceSha256)
      throw new Error("before source hash mismatch");
    const evidence = evidenceParts(receipt.beforeEvidence, row.file);
    const evidenceDigest = hash(canonical(receipt.beforeEvidence));
    if (!hex256.test(receipt.beforeEvidenceSha256 ?? "") || evidenceDigest !== receipt.beforeEvidenceSha256)
      throw new Error("beforeEvidence canonical digest mismatch");
    if (normalizeDirectives(evidence.source) !== normalizeDirectives(beforeSource))
      throw new Error("embedded source differs from authoritative git source");
    if (hash(normalizeDirectives(beforeSource)) !== hash(normalizeDirectives(evidence.source)))
      throw new Error("normalized source hash mismatch");
    const expectedReportPath = safeRelative(root, receipt.beforeReport, "beforeReport");
    if (!hex256.test(receipt.beforeReportSha256 ?? "")) throw new Error("before report hash is invalid");
    if (existsSync(expectedReportPath)) {
      const bytes = readFileSync(expectedReportPath);
      if (hash(bytes) !== receipt.beforeReportSha256) throw new Error("retained before report hash mismatch");
      const report = JSON.parse(bytes.toString("utf8"));
      const slice = report.files?.[row.file];
      if (!slice || canonical(slice) !== canonical({ source: evidence.source, mutants: evidence.mutants, ...(slice.language === undefined ? {} : { language: slice.language }) }))
        throw new Error("retained before report slice differs from embedded evidence");
      if (canonical(referencedTests(report, slice.mutants ?? [])) !== canonical(evidence.testFiles ?? {}))
        throw new Error("retained before report test evidence differs from embedded evidence");
    }
    if (!Array.isArray(receipt.edits) || receipt.edits.length === 0) throw new Error("receipt has no edits");
    const applied = applyEdits(normalizeDirectives(beforeSource), receipt.edits);
    const diskSource = readFileSync(trackedPath, "utf8");
    if (typeof currentSource !== "string") currentSource = diskSource;
    else if (normalizeDirectives(currentSource) !== normalizeDirectives(diskSource))
      throw new Error("current source differs from working tree");
    const normalizedCurrent = normalizeDirectives(currentSource);
    if (applied.source !== normalizedCurrent) throw new Error("current source differs from exact ordered edit chain");
    if (finalEntry && normalizeDirectives(finalEntry.source ?? "") !== normalizedCurrent)
      throw new Error("final report source differs from current source");
    if (typeof receipt.referenceTrace !== "string" || receipt.referenceTrace.trim() === "")
      throw new Error("referenceTrace is empty");
    validatedEdits.push(...applied.edits);

    const affected = evidence.mutants.filter((mutant) => affectedBy(mutant, evidence.source, applied.edits));
    const candidateRecords = affected.map((mutant) => rawRecord(row.file, mutant, evidence.source, { testFiles: evidence.testFiles })).sort((a, b) => a.anchor.localeCompare(b.anchor) || a.status.localeCompare(b.status));
    for (const mutant of affected) if (DETECTED.has(mutant.status)) {
      const resolved = resolvedTests({ testFiles: evidence.testFiles }, mutant);
      if (resolved.length === 0 || resolved.length !== (mutant.killedBy ?? []).length)
        throw new Error(`affected detected mutant ${show(anchorKey(row.file, mutant, evidence.source))} has unresolved killedBy test evidence`);
    }
    if (!Array.isArray(receipt.removedMutants)) throw new Error("removedMutants inventory is missing");
    const claimed = [...receipt.removedMutants].sort((a, b) => String(a.anchor).localeCompare(String(b.anchor)) || String(a.status).localeCompare(String(b.status)));
    const owned = new Set(row.keys ?? []);
    if (owned.size !== (row.keys ?? []).length) throw new Error("duplicate owned key");
    const ownedEvidence = new Map();
    if (survivors) {
      for (const key of owned) {
        const members = survivors.filter((candidate) => candidate.key === key);
        const member = members[0];
        if (members.length !== 1 || !member || member.file !== row.file || member.function !== row.function ||
            member.mutatorName !== row.mutatorName || member.group !== row.group)
          throw new Error(`owned key ${show(key)} is absent from its immutable origin`);
        const rowOrigin = row.originClusterId;
        const memberOrigin = [member.group, member.file, member.function, member.mutatorName].join(":");
        if (rowOrigin !== undefined && rowOrigin !== memberOrigin)
          throw new Error(`owned key ${show(key)} has different immutable origin metadata`);
        const candidates = evidence.mutants.filter((mutant) =>
          mutantKey(row.file, { ...mutant, location: toNormalizedLocation(evidence.source, mutant.location) }) === key);
        if (candidates.length !== 1)
          throw new Error(`owned key ${show(key)} has ${candidates.length} directive-normalized report matches`);
        const old = candidates[0];
        const normalizedAnchor = anchorKey(row.file,
          { ...old, location: toNormalizedLocation(evidence.source, old.location) },
          normalizeDirectives(evidence.source));
        if (normalizedAnchor !== member.anchorKey)
          throw new Error(`owned key ${show(key)} has a different immutable anchor`);
        if (member.status !== undefined && member.status !== old.status)
          throw new Error(`owned key ${show(key)} has a different immutable status`);
        if (member.replacement !== undefined && member.replacement !== (old.replacement ?? ""))
          throw new Error(`owned key ${show(key)} has a different immutable replacement`);
        ownedEvidence.set(key, { member, mutant: old });
      }
    }
    for (const key of owned) {
      const resolved = ownedEvidence.get(key);
      const old = resolved?.mutant ?? evidence.mutants.find((mutant) =>
        mutantKey(row.file, { ...mutant, location: toNormalizedLocation(evidence.source, mutant.location) }) === key);
      if (!old || !["Survived", "NoCoverage"].includes(old.status) || !affected.includes(old))
        throw new Error(`owned key ${show(key)} is not a removed undetected member of the exact edit`);
    }
    if (owned.size === 0) throw new Error("scoped dead row owns no members");

    if (finalReport && finalEntry) {
      const editMap = applied.edits;
      const beforeNormalized = normalizeDirectives(beforeSource);
      const finalNormalized = normalizeDirectives(finalEntry.source ?? "");
      const originalRecords = evidence.mutants.map((old) => ({
        anchor: anchorKey(row.file,
          { ...old, location: toNormalizedLocation(evidence.source, old.location) }, beforeNormalized),
        mutatorName: old.mutatorName,
        replacement: old.replacement ?? "",
      }));
      for (const mutant of finalEntry.mutants ?? []) {
        let from, to;
        try {
          from = offsetAt(finalNormalized, toNormalizedLocation(finalEntry.source ?? "", mutant.location).start);
          to = offsetAt(finalNormalized, toNormalizedLocation(finalEntry.source ?? "", mutant.location).end);
        } catch { throw new Error(`unexplained live anchor ${mutant.mutatorName}: location is outside current source`); }
        const liveSpan = finalNormalized.slice(from, to);
        const candidates = new Map();
        for (const startBoundary of ["start", "end"]) for (const endBoundary of ["start", "end"]) {
          const oldFrom = mapFinalOffsetToBefore(from, editMap, startBoundary);
          const oldTo = mapFinalOffsetToBefore(to, editMap, endBoundary);
          if (oldFrom === null || oldTo === null || oldFrom > oldTo) continue;
          const oldSpan = beforeNormalized.slice(oldFrom, oldTo);
          const deleted = editMap.some((edit) => edit.start >= oldFrom && edit.end <= oldTo);
          if (oldSpan !== liveSpan && !deleted) continue;
          const oldLocation = { start: pointAt(beforeNormalized, oldFrom), end: pointAt(beforeNormalized, oldTo) };
          const original = anchorKey(row.file, { ...mutant, location: oldLocation }, beforeNormalized);
          const exactMatches = originalRecords.filter((record) => record.anchor === original &&
            record.mutatorName === mutant.mutatorName && record.replacement === (mutant.replacement ?? "")).length;
          const previous = candidates.get(original);
          candidates.set(original, { original, exactMatches: Math.max(previous?.exactMatches ?? 0, exactMatches) });
        }
        const possible = [...candidates.values()];
        if (possible.some((candidate) => candidate.exactMatches > 1))
          throw new Error(`unexplained live anchor ${mutant.mutatorName}: original report correspondence is ambiguous`);
        const exact = possible.filter((candidate) => candidate.exactMatches === 1);
        if (exact.length > 1 || (exact.length === 0 && possible.length !== 1))
          throw new Error(`unexplained live anchor ${mutant.mutatorName}: edited text has no unique original correspondence`);
        if (possible.length === 0)
          throw new Error(`unexplained live anchor ${mutant.mutatorName}: source text does not map through the receipt`);
        const original = exact[0]?.original ?? possible[0].original;
        const normalizedLocation = toNormalizedLocation(finalEntry.source ?? "", mutant.location);
        const current = anchorKey(row.file, { ...mutant, location: normalizedLocation }, finalNormalized);
        anchors.push({ current, original });
      }
      const seen = new Set(), seenCurrent = new Set();
      for (const pair of anchors) {
        if (seenCurrent.has(pair.current)) throw new Error(`duplicate live anchor ${show(pair.current)}`);
        seenCurrent.add(pair.current);
        if (seen.has(pair.original)) throw new Error(`two live mutants map to one original anchor ${show(pair.original)}`);
        seen.add(pair.original);
      }
      for (const key of owned) {
        const resolved = ownedEvidence.get(key);
        const old = resolved?.mutant ?? evidence.mutants.find((mutant) =>
          mutantKey(row.file, { ...mutant, location: toNormalizedLocation(evidence.source, mutant.location) }) === key);
        const member = resolved?.member;
        if (member && anchors.some((pair) => pair.original === member.anchorKey))
          throw new Error(`scoped dead member ${show(key)} is still generated in the final report`);
        if (old && anchors.some((pair) => pair.original === anchorKey(row.file,
          { ...old, location: toNormalizedLocation(evidence.source, old.location) }, normalizeDirectives(evidence.source))))
          throw new Error(`scoped dead member ${show(key)} is still generated in the final report`);
      }
      const mapped = new Set(anchors.map((pair) => pair.original));
      const actualRecords = candidateRecords.filter((record) => !mapped.has(record.anchor));
      if (canonical(actualRecords) !== canonical(claimed))
        throw new Error(`removedMutants does not exactly account for invalidated report mutants (computed ${actualRecords.map((record) => show(record.anchor)).join(", ")}; claimed ${claimed.map((record) => show(record.anchor)).join(", ")})`);
      removedMutants.push(...actualRecords);

      const successorByOld = new Map((receipt.detectedSuccessors ?? []).map((item) => [item.oldAnchor, item]));
      const counterfactualByOld = new Map((receipt.counterfactuals ?? []).map((item) => [item.oldAnchor, item]));
      const detectedOld = actualRecords.filter((record) => DETECTED.has(record.status));
      const detectedAnchors = new Set(detectedOld.map((record) => record.anchor));
      for (const [label, records] of [["successor", receipt.detectedSuccessors ?? []], ["counterfactual", receipt.counterfactuals ?? []]]) {
        const seenDetected = new Set();
        for (const item of records) {
          if (!detectedAnchors.has(item.oldAnchor)) throw new Error(`${label} references an unaccounted detected mutant`);
          if (seenDetected.has(item.oldAnchor)) throw new Error(`${label} is duplicated for a detected mutant`);
          seenDetected.add(item.oldAnchor);
        }
      }
      for (const old of detectedOld) {
        if (successorByOld.has(old.anchor) === counterfactualByOld.has(old.anchor))
          throw new Error(`detected mutant ${show(old.anchor)} must have exactly one successor or counterfactual`);
        const successor = successorByOld.get(old.anchor);
        if (successor) {
          const found = [];
          for (const [file, entry] of Object.entries(finalReport.files ?? {}))
            for (const mutant of entry.mutants ?? [])
              if (anchorKey(file, mutant, entry.source ?? "") === successor.finalAnchor) found.push({ file, mutant });
          if (found.length !== 1) throw new Error(`detected successor ${show(successor.finalAnchor)} is missing or ambiguous`);
          const { mutant } = found[0];
          if (!DETECTED.has(mutant.status)) throw new Error(`detected successor is ${mutant.status}`);
          const expectedTest = successor.test;
          if (!expectedTest || typeof expectedTest.file !== "string" || typeof expectedTest.name !== "string" || !expectedTest.name)
            throw new Error("detected successor has no named test");
          safeRelative(root, expectedTest.file, "successor test");
          const text = readTest ? readTest(expectedTest.file) : readFileSync(safeRelative(root, expectedTest.file, "successor test"), "utf8");
          if (typeof text !== "string" || !text.includes(expectedTest.name) || finalReport.testFiles?.[expectedTest.file]?.source !== text)
            throw new Error("detected successor test source is absent or stale");
          const killedBy = resolvedTests(finalReport, mutant);
          if (!killedBy.some((test) => test.file === expectedTest.file && (test.name === expectedTest.name || test.name.endsWith(` > ${expectedTest.name}`))))
            throw new Error("detected successor killedBy does not name the real test");
          if (typeof successor.semanticTrace !== "string" || successor.semanticTrace.trim() === "")
            throw new Error("detected successor semanticTrace is empty");
        } else {
          const proof = counterfactualByOld.get(old.anchor);
          if (!proof || proof.executed !== true || !Array.isArray(proof.argv) || proof.argv.length === 0 ||
              typeof proof.command !== "string" || proof.command.trim() === "" ||
              typeof proof.alteredSha256 !== "string" || !hex256.test(proof.alteredSha256) ||
              typeof proof.expectedDiagnostic !== "string" || !proof.expectedDiagnostic ||
              !Number.isInteger(proof.exitCode) || proof.exitCode <= 0 || proof.unchangedExitCode !== 0 ||
              typeof proof.assertion !== "string" || !proof.assertion)
            throw new Error(`removed detected counterpart ${show(old.anchor)} has no executed counterfactual`);
        }
      }
    } else {
      if (requireFinal) throw new Error("final report entry is required for scoped deletion proof");
      // Without a final report, validate the immutable candidate table and owned
      // members; final invalidation/successor partitioning is deferred to --final.
      const candidates = new Map(candidateRecords.map((record) => [record.anchor, record]));
      if (claimed.some((record) => canonical(candidates.get(record.anchor)) !== canonical(record)))
        throw new Error("removedMutants includes a record absent from embedded affected evidence");
      for (const key of owned) {
        const resolved = ownedEvidence.get(key);
        const old = resolved?.mutant ?? evidence.mutants.find((mutant) =>
          mutantKey(row.file, { ...mutant, location: toNormalizedLocation(evidence.source, mutant.location) }) === key);
        if (!old || !claimed.some((record) => record.anchor === anchorKey(row.file,
          { ...old, location: toNormalizedLocation(evidence.source, old.location) }, normalizeDirectives(evidence.source))))
          throw new Error(`owned dead key ${show(key)} is missing from removedMutants evidence`);
      }
      removedMutants.push(...claimed);
    }
  } catch (error) {
    fail(error.message);
  }
  return { problems, edits: validatedEdits, anchors, removedMutants };
}

export { canonical as canonicalReceiptJson, normalizeDirectives as normalizeReceiptSource };
