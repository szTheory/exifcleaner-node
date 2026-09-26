import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getCapabilities,
  inspectFile,
  sanitizeFile,
} from "../../../dist/index.js";
import type { MetadataEntry, NativeFormat } from "../../../src/types.js";

const CORPUS_ROOT = fileURLToPath(new URL("../../corpus/", import.meta.url));
const MANIFEST_PATH = join(CORPUS_ROOT, "manifest.json");
const SHA256 = /^[a-f0-9]{64}$/;
const ROLES = new Set([
  "decode",
  "differential",
  "structural",
  "negative-control",
  "property-regression",
  "benchmark",
]);

/**
 * The private namespace literal (`src/types.ts` deliberately does not export
 * it), projected through a public member type so this file names no
 * container vocabulary of its own -- KIT-01 D-03.
 */
type Namespace = MetadataEntry["namespace"];

/**
 * The registered-handler capability list is this kit's single runtime
 * source of truth for which formats exist, which extension each one uses,
 * and which metadata namespaces each one can report removing -- read once,
 * derived entirely from the built package, never restated as a literal here.
 */
const CAPABILITIES = getCapabilities().formats;
const FORMAT_IDS: ReadonlySet<string> = new Set(
  CAPABILITIES.map((capability) => capability.format),
);
const ALL_NAMESPACES: ReadonlySet<string> = new Set(
  CAPABILITIES.flatMap((capability) => capability.removes),
);

function capabilityFor(format: NativeFormat) {
  const capability = CAPABILITIES.find((item) => item.format === format);
  if (capability === undefined)
    throw new Error(`Unregistered format: ${format}`);
  return capability;
}

type RecordRole =
  | "decode"
  | "differential"
  | "structural"
  | "negative-control"
  | "property-regression"
  | "benchmark";

/**
 * `part` is a container-specific payload identifier -- each registered
 * format's own chunk-type or sub-stream identifier -- named neutrally so
 * this kit carries no per-format vocabulary of its own (KIT-01 D-03).
 * Callers supply their own `payloadDigests` extraction (one per registered
 * format's own oracles module), never this file.
 */
export interface PayloadDigest {
  readonly part: string;
  readonly sha256: string;
}

interface Provenance {
  readonly revision: string;
  readonly url: string;
  readonly license: string;
  readonly licenseStatus: "approved";
}

interface SuccessOutcome {
  readonly status: "success";
  readonly removedNamespaces: readonly Namespace[];
}

interface RefusalOutcome {
  readonly status: "refused";
  readonly errorCode: "malformed-file" | "unsafe-structure";
  readonly nativeWrite: "not-started";
}

export interface CorpusRecord {
  readonly id: string;
  readonly format: NativeFormat;
  readonly roles: readonly RecordRole[];
  readonly localPath?: string;
  readonly generator?: {
    readonly kind: string;
    readonly seed: number;
    readonly sourceCase: string;
  };
  readonly provenance: Provenance;
  readonly sha256: string;
  readonly bytes: number;
  readonly topology: readonly string[];
  readonly outcome: SuccessOutcome | RefusalOutcome;
  readonly retainedPayloads: readonly PayloadDigest[];
  readonly permittedDifferences: readonly string[];
  readonly oracle?: Readonly<Record<string, unknown>>;
}

interface CorpusManifest {
  readonly schemaVersion: 1;
  readonly records: readonly CorpusRecord[];
}

export interface RunQualificationCaseOptions {
  /**
   * Extracts the retained-payload digests from a reopened destination's raw
   * bytes -- format-specific, supplied by the caller's own oracles module.
   * This kit never parses a container format itself.
   */
  readonly payloadDigests: (bytes: Buffer) => readonly PayloadDigest[];
}

type QualificationTranscript =
  | {
      readonly version: 1;
      readonly caseId: string;
      readonly status: "success";
      readonly source: {
        readonly relativePath: string;
        readonly sha256: string;
        readonly unchanged: true;
      };
      readonly destination: { readonly state: "created" };
      readonly reopened: {
        readonly format: NativeFormat;
        readonly namespaces: Readonly<Record<string, number>>;
      };
      readonly retainedPayloads: readonly PayloadDigest[];
    }
  | {
      readonly version: 1;
      readonly caseId: string;
      readonly status: "refused";
      readonly source: {
        readonly relativePath: string;
        readonly unchanged: true;
      };
      readonly destination: { readonly state: "absent" };
      readonly error: { readonly code: string; readonly nativeWrite: string };
    };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(detail: string): never {
  throw new Error(`Invalid corpus record: ${detail}`);
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(field);
  return value;
}

function arrayField(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(field);
  return value;
}

/**
 * A generator kind's own suffix convention, mirroring how each concrete kind
 * self-describes ("this generator derives one record from another by
 * mutating a declared length field"). One historical kind spells its
 * container vocabulary in its own name (kept, per KIT-01 D-03's own carve-out
 * for a value already in the manifest); the suffix match admits it and any
 * differently-prefixed generator of the same shape without this file naming
 * that vocabulary itself.
 */
const GENERATOR_KIND = /^[a-z][a-z0-9-]*-declared-size-plus-one$/;

export function assertCorpusRecord(
  value: unknown,
): asserts value is CorpusRecord {
  if (!isObject(value)) invalid("record must be an object");
  const id = stringField(value.id, "id");
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(id)) invalid("id");
  if (typeof value.format !== "string" || !FORMAT_IDS.has(value.format))
    invalid("format");
  const roles = arrayField(value.roles, "roles");
  if (
    roles.length === 0 ||
    roles.some((role) => typeof role !== "string" || !ROLES.has(role)) ||
    new Set(roles).size !== roles.length
  )
    invalid("roles");
  const hasLocalPath = typeof value.localPath === "string";
  const hasGenerator = isObject(value.generator);
  if (hasLocalPath === hasGenerator) invalid("exactly one materializer");
  if (hasLocalPath) {
    const localPath = stringField(value.localPath, "localPath");
    const resolvedPath = resolve(CORPUS_ROOT, localPath);
    const fromRoot = relative(CORPUS_ROOT, resolvedPath);
    if (
      localPath.startsWith("/") ||
      fromRoot.startsWith("..") ||
      resolve(CORPUS_ROOT, fromRoot) !== resolvedPath
    )
      invalid("localPath");
  }
  if (hasGenerator) {
    const generator = value.generator;
    if (!isObject(generator)) invalid("generator");
    if (
      typeof generator.kind !== "string" ||
      !GENERATOR_KIND.test(generator.kind) ||
      !Number.isSafeInteger(generator.seed) ||
      typeof generator.sourceCase !== "string"
    )
      invalid("generator");
  }
  if (!isObject(value.provenance)) invalid("provenance");
  const provenance = value.provenance;
  if (
    !/^[a-f0-9]{40}$/.test(stringField(provenance.revision, "revision")) ||
    !stringField(provenance.url, "url").startsWith("https://") ||
    // A well-formed SPDX-style identifier, optionally an "OR" disjunction of
    // two (matches every license this corpus has ever recorded). The exact
    // approved-license enum this shape admits lives with each fixture's own
    // authority (tools-manifest fixture validation ties a record's license
    // to its pinned archive's own license field), never restated here.
    !/^[A-Za-z0-9][A-Za-z0-9.-]*(?: OR [A-Za-z0-9][A-Za-z0-9.-]*)?$/.test(
      stringField(provenance.license, "license"),
    ) ||
    provenance.licenseStatus !== "approved"
  )
    invalid("provenance");
  if (!SHA256.test(stringField(value.sha256, "sha256"))) invalid("sha256");
  if (
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0
  )
    invalid("bytes");
  const topology = arrayField(value.topology, "topology");
  if (
    topology.length === 0 ||
    topology.some((item) => typeof item !== "string")
  )
    invalid("topology");
  if (!isObject(value.outcome)) invalid("outcome");
  if (value.outcome.status === "success") {
    const removed = arrayField(
      value.outcome.removedNamespaces,
      "removedNamespaces",
    );
    if (removed.some((item) => !ALL_NAMESPACES.has(String(item))))
      invalid("removedNamespaces");
  } else if (
    value.outcome.status !== "refused" ||
    (value.outcome.errorCode !== "malformed-file" &&
      value.outcome.errorCode !== "unsafe-structure") ||
    value.outcome.nativeWrite !== "not-started"
  )
    invalid("outcome");
  const retained = arrayField(value.retainedPayloads, "retainedPayloads");
  for (const item of retained) {
    if (
      !isObject(item) ||
      typeof stringField(item.part, "part") !== "string" ||
      !SHA256.test(stringField(item.sha256, "payload sha256"))
    )
      invalid("retainedPayloads");
  }
  const permitted = arrayField(
    value.permittedDifferences,
    "permittedDifferences",
  );
  if (permitted.some((item) => typeof item !== "string"))
    invalid("permittedDifferences");
  if (value.oracle !== undefined && !isObject(value.oracle)) invalid("oracle");
}

function assertManifest(value: unknown): asserts value is CorpusManifest {
  if (!isObject(value) || value.schemaVersion !== 1) invalid("schemaVersion");
  const records = arrayField(value.records, "records");
  const ids = new Set<string>();
  for (const record of records) {
    assertCorpusRecord(record);
    if (ids.has(record.id)) invalid("duplicate id");
    ids.add(record.id);
  }
}

async function readManifest(): Promise<CorpusManifest> {
  const parsed: unknown = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  assertManifest(parsed);
  return parsed;
}

export async function loadCorpusRecord(caseId: string): Promise<CorpusRecord> {
  const manifest = await readManifest();
  const record = manifest.records.find((item) => item.id === caseId);
  if (record === undefined) throw new Error(`Unknown corpus case: ${caseId}`);
  return record;
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertMaterialized(record: CorpusRecord, data: Buffer): void {
  if (data.length !== record.bytes || digest(data) !== record.sha256)
    throw new Error(`Corpus integrity check failed: ${record.id}`);
}

export async function materializeCorpusRecord(caseId: string): Promise<Buffer> {
  const record = await loadCorpusRecord(caseId);
  if (record.localPath !== undefined) {
    const path = resolve(CORPUS_ROOT, record.localPath);
    if (relative(CORPUS_ROOT, path).startsWith(".."))
      invalid("localPath escaped corpus");
    const data = await readFile(path);
    assertMaterialized(record, data);
    return data;
  }
  const generator = record.generator;
  if (generator === undefined) invalid("materializer");
  const data = Buffer.from(await materializeCorpusRecord(generator.sourceCase));
  data.writeUInt32LE(data.readUInt32LE(4) + 1, 4);
  assertMaterialized(record, data);
  return data;
}

function extensionFor(format: NativeFormat): string {
  return capabilityFor(format).extensions[0];
}

function relativePath(record: CorpusRecord): string {
  return (
    record.localPath ?? `${record.id}.generated${extensionFor(record.format)}`
  );
}

export async function runQualificationCase(
  caseId: string,
  options: RunQualificationCaseOptions,
): Promise<QualificationTranscript> {
  const record = await loadCorpusRecord(caseId);
  const source = await materializeCorpusRecord(caseId);
  const extension = extensionFor(record.format);
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-qualification-"));
  const sourcePath = join(directory, `source${extension}`);
  const destinationPath = join(directory, `sanitized${extension}`);
  try {
    await writeFile(sourcePath, source);
    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
      preserveResolution: false,
    });
    const sourceUnchanged =
      digest(await readFile(sourcePath)) === record.sha256;
    if (record.outcome.status === "refused") {
      if (result.ok) throw new Error(`Expected refusal: ${record.id}`);
      await access(destinationPath).then(
        () => Promise.reject(new Error(`Unexpected destination: ${record.id}`)),
        () => undefined,
      );
      if (
        result.error.code !== record.outcome.errorCode ||
        result.error.nativeWrite !== record.outcome.nativeWrite ||
        !sourceUnchanged
      )
        throw new Error(`Refusal contract failed: ${record.id}`);
      return {
        version: 1,
        caseId: record.id,
        status: "refused",
        source: { relativePath: relativePath(record), unchanged: true },
        destination: { state: "absent" },
        error: {
          code: result.error.code,
          nativeWrite: result.error.nativeWrite,
        },
      };
    }
    if (!result.ok || !sourceUnchanged)
      throw new Error(`Expected success: ${record.id}`);
    const reopened = await inspectFile(destinationPath);
    if (!reopened.ok)
      throw new Error(`Could not reopen destination: ${record.id}`);
    const namespaces: Record<string, number> = {};
    for (const namespace of capabilityFor(record.format).removes)
      namespaces[namespace] = 0;
    for (const entry of reopened.value.entries) {
      if (entry.namespace in namespaces)
        namespaces[entry.namespace] = (namespaces[entry.namespace] ?? 0) + 1;
    }
    const retainedPayloads = options.payloadDigests(
      await readFile(destinationPath),
    );
    if (
      JSON.stringify(retainedPayloads) !==
        JSON.stringify(record.retainedPayloads) ||
      Object.values(namespaces).some((count) => count !== 0)
    )
      throw new Error(`Reopen contract failed: ${record.id}`);
    if (reopened.value.format !== record.format)
      throw new Error(`Expected a matching-format reopen: ${record.id}`);
    return {
      version: 1,
      caseId: record.id,
      status: "success",
      source: {
        relativePath: relativePath(record),
        sha256: record.sha256,
        unchanged: true,
      },
      destination: { state: "created" },
      reopened: { format: reopened.value.format, namespaces },
      retainedPayloads,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
