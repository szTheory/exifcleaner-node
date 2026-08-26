import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectFile, sanitizeFile } from "../../dist/index.js";

const CORPUS_ROOT = fileURLToPath(new URL("../corpus/", import.meta.url));
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
const PAYLOAD_CHUNKS = new Set(["VP8 ", "VP8L", "ALPH", "ANIM", "ANMF"]);

type RecordRole =
  | "decode"
  | "differential"
  | "structural"
  | "negative-control"
  | "property-regression"
  | "benchmark";

interface PayloadDigest {
  readonly fourCc: string;
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
  readonly removedNamespaces: readonly ("EXIF" | "XMP" | "ICC")[];
}

interface RefusalOutcome {
  readonly status: "refused";
  readonly errorCode: "malformed-file";
  readonly nativeWrite: "not-started";
}

export interface CorpusRecord {
  readonly id: string;
  readonly role: RecordRole;
  readonly localPath?: string;
  readonly generator?: {
    readonly kind: "riff-declared-size-plus-one";
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
}

interface CorpusManifest {
  readonly schemaVersion: 1;
  readonly records: readonly CorpusRecord[];
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
        readonly format: "webp";
        readonly namespaces: Readonly<Record<"EXIF" | "XMP" | "ICC", number>>;
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

export function assertCorpusRecord(
  value: unknown,
): asserts value is CorpusRecord {
  if (!isObject(value)) invalid("record must be an object");
  const id = stringField(value.id, "id");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) invalid("id");
  const role = stringField(value.role, "role");
  if (!ROLES.has(role)) invalid("role");
  const hasLocalPath = typeof value.localPath === "string";
  const hasGenerator = isObject(value.generator);
  if (hasLocalPath === hasGenerator) invalid("exactly one materializer");
  if (hasLocalPath) {
    const localPath = stringField(value.localPath, "localPath");
    if (basename(localPath) !== localPath || localPath.includes(".."))
      invalid("localPath");
  }
  if (hasGenerator) {
    const generator = value.generator;
    if (!isObject(generator)) invalid("generator");
    if (
      generator.kind !== "riff-declared-size-plus-one" ||
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
    stringField(provenance.license, "license") !== "MIT" ||
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
    if (removed.some((item) => !["EXIF", "XMP", "ICC"].includes(String(item))))
      invalid("removedNamespaces");
  } else if (
    value.outcome.status !== "refused" ||
    value.outcome.errorCode !== "malformed-file" ||
    value.outcome.nativeWrite !== "not-started"
  )
    invalid("outcome");
  const retained = arrayField(value.retainedPayloads, "retainedPayloads");
  for (const item of retained) {
    if (
      !isObject(item) ||
      !PAYLOAD_CHUNKS.has(stringField(item.fourCc, "fourCc")) ||
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

function payloadDigests(data: Buffer): readonly PayloadDigest[] {
  const payloads: PayloadDigest[] = [];
  for (let offset = 12; offset < data.length;) {
    const fourCc = data.toString("ascii", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    if (PAYLOAD_CHUNKS.has(fourCc))
      payloads.push({
        fourCc,
        sha256: digest(data.subarray(offset + 8, offset + 8 + size)),
      });
    offset += 8 + size + (size & 1);
  }
  return payloads;
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

function relativePath(record: CorpusRecord): string {
  return record.localPath ?? `${record.id}.generated.webp`;
}

export async function runQualificationCase(
  caseId: string,
): Promise<QualificationTranscript> {
  const record = await loadCorpusRecord(caseId);
  const source = await materializeCorpusRecord(caseId);
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-qualification-"));
  const sourcePath = join(directory, "source.webp");
  const destinationPath = join(directory, "sanitized.webp");
  try {
    await writeFile(sourcePath, source);
    const result = await sanitizeFile({
      sourcePath,
      destinationPath,
      preserveOrientation: false,
      preserveColorProfile: false,
      preserveTimestamps: false,
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
    const namespaces = { EXIF: 0, XMP: 0, ICC: 0 };
    for (const entry of reopened.value.entries)
      namespaces[entry.namespace] += 1;
    const retainedPayloads = payloadDigests(await readFile(destinationPath));
    if (
      JSON.stringify(retainedPayloads) !==
        JSON.stringify(record.retainedPayloads) ||
      Object.values(namespaces).some((count) => count !== 0)
    )
      throw new Error(`Reopen contract failed: ${record.id}`);
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
