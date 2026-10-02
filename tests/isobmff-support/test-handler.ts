// Test-only ISOBMFF proof harness handler (D-16): the one handler both 61-10's "declines once,
// before any write" proof (success criterion 4) and its "recognized through the widened registry
// read" proof (success criterion 3) install through the existing private
// `setRegisteredHandlersForTests` seam (`src/admission/registry.ts`). It is never added to the
// real `HANDLERS` array (D-15). `createIsobmffWriterHandlerForTests` below (not this stub) is what
// now exercises the shipped-but-unregistered `heic-handler.ts`/`avif-handler.ts` (62-12).
//
// `matches` and `admit` are the real engine (`classifyIsobmffBrand`/`admitIsobmff`) -- a
// pure-classifier-only proof would not demonstrate the engine path the app actually observes. The
// five write-side methods (`inspect`, `buildOutputPlan`, `checkOutputPlan`, `writeOutput`,
// `verifyOutput`) are counting spies: every hostile-class run through `sanitizeFile` must decline
// at admission, strictly before `buildOutputPlan`/`checkOutputPlan`/`writeOutput`/`verifyOutput`
// are ever reached, so those four counters must stay at 0. `inspect` is exercised by the positive
// recognition proofs (`inspectFile`) and is counted too, for symmetry and so a future assertion
// can pin it if needed.
//
// This module is the one narrow, declared exception in `tests/isobmff_isolation.test.ts`'s
// `ISOLATION_RULES` allowed to import `src/isobmff/` directly -- it is the seam between the
// engine and test support, not an independent oracle like `builder.ts`/`inventory.ts`/`hostile.ts`,
// none of which may import it (see that file's `test-handler.ts` rule and the three updated
// `forbiddenSpecifierSubstrings` entries).
import type { FileHandle } from "node:fs/promises";
import type {
  AdmissionDeclineDetail,
  FormatAdmission,
} from "../../src/admission/handler.js";
import type { RegisteredHandler } from "../../src/admission/registry.js";
import { registeredHandlersForTests } from "../../src/admission/registry.js";
import { createHeicHandler } from "../../src/admission/heic-handler.js";
import { createAvifHandler } from "../../src/admission/avif-handler.js";
import { admitIsobmff } from "../../src/isobmff/admission.js";
import { classifyIsobmffBrand } from "../../src/isobmff/brand.js";
import { classifyIsobmffAdmissionFailure } from "../../src/isobmff/errors.js";
import { parseBoxHeader, type BoxHeader } from "../../src/isobmff/boxes.js";
import {
  parseIloc,
  type IlocItem,
  type IlocTable,
} from "../../src/isobmff/iloc.js";
import { parseIpma, type IpmaEntry } from "../../src/isobmff/ipma.js";
import {
  fullBoxHeader,
  plainBoxHeader,
  rebuildIloc,
  rebuildIpma,
  rebuildIref,
} from "../../src/isobmff/rebuild.js";
import type { IsobmffItem } from "../../src/isobmff/items.js";
import type {
  IsobmffOutputPlan,
  IsobmffOutputPlanPart,
} from "../../src/isobmff/plan.js";
import type { Inspection, Result } from "../../src/types.js";

export interface IsobmffTestHandlerCounters {
  admit: number;
  inspect: number;
  buildOutputPlan: number;
  checkOutputPlan: number;
  writeOutput: number;
  verifyOutput: number;
}

export interface IsobmffTestHandler {
  readonly handler: RegisteredHandler;
  readonly counters: IsobmffTestHandlerCounters;
}

/**
 * Builds one fresh test-only `RegisteredHandler` plus its own counters object. A fresh instance
 * per call (never a module-level singleton) so concurrent/sequential test cases never share
 * counter state.
 */
export function createIsobmffTestHandler(): IsobmffTestHandler {
  const counters: IsobmffTestHandlerCounters = {
    admit: 0,
    inspect: 0,
    buildOutputPlan: 0,
    checkOutputPlan: 0,
    writeOutput: 0,
    verifyOutput: 0,
  };

  // Borrow the real PNG handler's capability literal rather than fabricating one: `NativeFormat`
  // has no "heic"/"avif" value until Phase 62 registers real handlers, and this test harness must
  // not widen that public union. The borrowed capability is never mutated; only this handler's own
  // `stagingFileName` differs from PNG's.
  const pngHandler = registeredHandlersForTests().find(
    (candidate) => candidate.capability.format === "png",
  );
  if (pngHandler === undefined) {
    throw new Error(
      "createIsobmffTestHandler: no registered png handler to borrow a capability from",
    );
  }
  const capability = pngHandler.capability;

  function notReached(name: string): never {
    throw new Error(
      `isobmff test handler: ${name} must not run -- every hostile/declined fixture must be rejected at admission, before any write-side method runs`,
    );
  }

  const handler: RegisteredHandler = Object.freeze({
    capability,
    stagingFileName: ".isobmff-test-stage",

    matches(magic: Buffer): boolean {
      return classifyIsobmffBrand(magic) !== "decline";
    },

    async admit(
      handle: FileHandle,
      size: number,
      signal?: AbortSignal,
    ): Promise<FormatAdmission> {
      counters.admit += 1;
      return admitIsobmff(handle, size, signal);
    },

    inspect(admission: FormatAdmission): Inspection {
      counters.inspect += 1;
      return {
        format: capability.format,
        entries: admission.entries,
        warnings: admission.warnings,
      };
    },

    buildOutputPlan(): unknown {
      counters.buildOutputPlan += 1;
      return notReached("buildOutputPlan");
    },

    checkOutputPlan(): string | undefined {
      counters.checkOutputPlan += 1;
      return notReached("checkOutputPlan");
    },

    async writeOutput(): Promise<void> {
      counters.writeOutput += 1;
      return notReached("writeOutput");
    },

    async verifyOutput(): Promise<Result<void>> {
      counters.verifyOutput += 1;
      return notReached("verifyOutput");
    },

    classifyAdmissionFailure(
      cause: unknown,
    ): AdmissionDeclineDetail | undefined {
      return classifyIsobmffAdmissionFailure(cause);
    },
  }) as RegisteredHandler;

  return { handler, counters };
}

/**
 * 62-02 (D-10): builds the one real engine-bound ISOBMFF writer handler, through the shipped
 * `createHeicHandler`/`createAvifHandler` modules (`src/admission/heic-handler.ts`,
 * `avif-handler.ts`, 62-12) rather than calling `createIsobmffHandler` directly -- so every suite
 * that uses this seam exercises the shipped, unregistered handler modules, not just the shared
 * factory underneath them. Borrows the registered png capability the same way
 * `createIsobmffTestHandler` above does -- `NativeFormat` gains no "heic"/"avif" member until
 * 62.1-07, so this test harness must not widen that public union. The staging file name is D-10's
 * `output.heic` / `output.avif`, now set inside the handler modules themselves.
 */
export function createIsobmffWriterHandlerForTests(
  brand: "heic" | "avif",
): RegisteredHandler {
  const pngHandler = registeredHandlersForTests().find(
    (candidate) => candidate.capability.format === "png",
  );
  if (pngHandler === undefined) {
    throw new Error(
      "createIsobmffWriterHandlerForTests: no registered png handler to borrow a capability from",
    );
  }
  const factory = brand === "heic" ? createHeicHandler : createAvifHandler;
  return factory(pngHandler.capability) as RegisteredHandler;
}

/**
 * 62-05 (D-12): a counting wrapper around the REAL writer handler (never the admission-only
 * `createIsobmffTestHandler` stub, whose write-side methods all throw `notReached`). A `"plan"`
 * stage hostile fixture (currently: `offset-rewrite-overflow` only) admits cleanly through
 * `admitIsobmff` and must be declined one stage later, inside `checkOutputPlan` -- so
 * `buildOutputPlan`/`checkOutputPlan` must actually run their real logic, not a stub that assumes
 * every decline happens at admission. `writeOutput`/`verifyOutput` stay counted too, so a test can
 * still assert they are never reached.
 */
export function createIsobmffWriterCountingHandlerForTests(
  brand: "heic" | "avif",
): IsobmffTestHandler {
  const real = createIsobmffWriterHandlerForTests(brand);
  const counters: IsobmffTestHandlerCounters = {
    admit: 0,
    inspect: 0,
    buildOutputPlan: 0,
    checkOutputPlan: 0,
    writeOutput: 0,
    verifyOutput: 0,
  };

  const handler: RegisteredHandler = Object.freeze({
    capability: real.capability,
    stagingFileName: real.stagingFileName,

    matches(magic: Buffer): boolean {
      return real.matches(magic);
    },

    async admit(
      handle: FileHandle,
      size: number,
      signal?: AbortSignal,
    ): Promise<FormatAdmission> {
      counters.admit += 1;
      return real.admit(handle, size, signal);
    },

    inspect(admission: FormatAdmission): Inspection {
      counters.inspect += 1;
      return real.inspect(admission);
    },

    buildOutputPlan(
      admission: FormatAdmission,
      preserveOrientation: boolean,
      preserveColorProfile: boolean,
      preserveResolution: boolean,
      orientation: number | undefined,
    ): unknown {
      counters.buildOutputPlan += 1;
      return real.buildOutputPlan(
        admission,
        preserveOrientation,
        preserveColorProfile,
        preserveResolution,
        orientation,
      );
    },

    checkOutputPlan(plan: unknown): string | undefined {
      counters.checkOutputPlan += 1;
      return real.checkOutputPlan(plan as never);
    },

    async writeOutput(
      source: FileHandle,
      destination: FileHandle,
      plan: unknown,
      signal?: AbortSignal,
    ): Promise<void> {
      counters.writeOutput += 1;
      return real.writeOutput(source, destination, plan as never, signal);
    },

    async verifyOutput(
      ...args: Parameters<RegisteredHandler["verifyOutput"]>
    ): Promise<Result<void>> {
      counters.verifyOutput += 1;
      return real.verifyOutput(...args);
    },

    classifyAdmissionFailure(
      cause: unknown,
      preserveColorProfile: boolean,
    ): AdmissionDeclineDetail | undefined {
      return real.classifyAdmissionFailure(cause, preserveColorProfile);
    },
  }) as RegisteredHandler;

  return { handler, counters };
}

// --- D-19 writer mutants (62-10, Task 2) -------------------------------------------------------
//
// `createPlanMutantHandler` is the second wrapper factory D-19 requires: a deliberately mutated
// `IsobmffOutputPlan` (before the real `writeOutput` ever runs). It never edits `src/` -- every
// mutation lives here, reparsing and resplicing the plan's own already-correct `meta` bytes part
// (or, for the mdat-coverage mutant, the plan's own copy-range parts) through the SAME rebuild
// encoders (`src/isobmff/rebuild.ts`) the real writer uses, so a mutant always produces a
// structurally consistent (if wrong) file, never random byte corruption.
//
// `plan.ts`'s own part ordering (`buildIsobmffOutputPlan`, verified against the module) is relied
// on directly, never re-derived: `parts[0]` is always the verbatim `ftyp` copy, `parts[1]` is
// always the one `meta` "bytes" part, `parts[2]` is always the `mdat` header "bytes" part, and
// every part from index 3 onward is either a "copy" (one merged surviving mdat range) or, at most
// once, a final "bytes" part (the minimal Exif payload appended at the mdat tail, D-13).

function listChildren(buffer: Buffer, start: number, end: number): BoxHeader[] {
  const children: BoxHeader[] = [];
  let position = start;
  while (position < end) {
    const header = parseBoxHeader(buffer, position, end);
    children.push(header);
    position = header.end;
  }
  return children;
}

function readBoxVersionFlags(
  buffer: Buffer,
  box: BoxHeader,
): { readonly version: number; readonly flags: number } {
  return {
    version: buffer.readUInt8(box.payloadStart),
    flags: buffer.readUIntBE(box.payloadStart + 1, 3),
  };
}

/** Find one direct child of `containerBytes` (the container's own full bytes, header included)
 * by type -- `isFullBox` skips the 4-byte version/flags field before listing children (true for
 * `meta`, false for the plain `iprp`/`ipco`). Throws if absent: every mutant below targets a
 * fixture it already knows carries the child it mutates. */
function findChildInContainer(
  containerBytes: Buffer,
  isFullBox: boolean,
  type: string,
): BoxHeader {
  const header = parseBoxHeader(containerBytes, 0, containerBytes.length);
  const childrenStart = header.payloadStart + (isFullBox ? 4 : 0);
  const children = listChildren(containerBytes, childrenStart, header.end);
  const found = children.find((child) => child.type === type);
  if (found === undefined) {
    throw new Error(
      `test-handler mutant: no "${type}" child found inside "${header.type}".`,
    );
  }
  return found;
}

/** Replace one child's bytes inside `containerBytes`, recomputing the container's own header
 * (size only -- type/version/flags are the caller's, preserved unchanged). `isFullBox` controls
 * whether a 4-byte version/flags field precedes the children (consumed by `headerLen`, never
 * duplicated into the rebuilt payload -- `fullBoxHeader`'s `payloadLength` already excludes it,
 * matching `rebuild.ts`'s own convention). */
function replaceChildBytes(
  containerBytes: Buffer,
  containerType: string,
  isFullBox: boolean,
  version: number,
  flags: number,
  child: { readonly start: number; readonly end: number },
  replacement: Buffer,
): Buffer {
  const headerLen = isFullBox ? 12 : 8;
  const before = containerBytes.subarray(headerLen, child.start);
  const after = containerBytes.subarray(child.end);
  const payload = Buffer.concat([before, replacement, after]);
  const header = isFullBox
    ? fullBoxHeader(containerType, version, flags, payload.length)
    : plainBoxHeader(containerType, payload.length);
  return Buffer.concat([header, payload]);
}

function metaBytesPart(plan: IsobmffOutputPlan): Buffer {
  const part = plan.parts[1];
  if (part === undefined || part.kind !== "bytes") {
    throw new Error(
      'test-handler mutant: plan.parts[1] is not the expected meta "bytes" part.',
    );
  }
  return part.data;
}

function withMetaBytes(
  plan: IsobmffOutputPlan,
  newMetaBytes: Buffer,
): IsobmffOutputPlan {
  return {
    ...plan,
    parts: plan.parts.map((part, index) =>
      index === 1 ? { kind: "bytes", data: newMetaBytes } : part,
    ),
  };
}

interface MutableIlocShape {
  readonly offsetSize: number;
  readonly lengthSize: number;
  readonly baseOffsetSize: number;
  readonly indexSize: number;
  readonly items: readonly IlocItem[];
}

/** Reparse the plan's `meta` bytes part's own `iloc` child, hand the resolved table to
 * `mutateTable`, and splice the rebuilt (mutated) `iloc` back in -- every other meta child byte
 * untouched. `rebuildIloc` is given an empty rewrite map (so it writes each returned item's own
 * `baseOffset`/`extents[].offset` verbatim, at the returned field widths) and a minimal
 * `IsobmffItem`-shaped array built from the parsed `IlocItem`s (only the fields `rebuildIloc`
 * actually reads: `id`, `constructionMethod`, `dataReferenceIndex`, `baseOffset`, `extents`). */
function withMutatedIloc(
  plan: IsobmffOutputPlan,
  mutateTable: (table: IlocTable) => MutableIlocShape,
): IsobmffOutputPlan {
  const metaBytes = metaBytesPart(plan);
  const ilocBox = findChildInContainer(metaBytes, true, "iloc");
  const { version, flags } = readBoxVersionFlags(metaBytes, ilocBox);
  const ilocPayload = metaBytes.subarray(ilocBox.payloadStart + 4, ilocBox.end);
  const table = parseIloc(ilocPayload, version, flags);
  const mutated = mutateTable(table);

  const fakeItems = mutated.items.map(
    (item) =>
      ({
        id: item.itemId,
        constructionMethod: item.constructionMethod,
        dataReferenceIndex: item.dataReferenceIndex,
        baseOffset: item.baseOffset,
        extents: item.extents,
      }) as unknown as IsobmffItem,
  );

  const newIlocBytes = rebuildIloc(
    table.version,
    mutated.offsetSize,
    mutated.lengthSize,
    mutated.baseOffsetSize,
    mutated.indexSize,
    fakeItems,
    new Map(),
  );
  // D-14/D-11: meta itself is always version 0, flags 0 (plan.ts's buildMetaBytes); never read
  // back from the bytes being spliced, since the splice target here is the iloc CHILD, not meta.
  const newMetaBytes = replaceChildBytes(
    metaBytes,
    "meta",
    true,
    0,
    0,
    ilocBox,
    newIlocBytes,
  );
  return withMetaBytes(plan, newMetaBytes);
}

/** Reparse the plan's `meta` bytes part's own `iprp` > `ipma` grandchild, hand the resolved
 * entries to `mutateEntries`, and splice the rebuilt (mutated) `ipma` back in through `iprp`. */
function withMutatedIpma(
  plan: IsobmffOutputPlan,
  mutateEntries: (entries: readonly IpmaEntry[]) => readonly IpmaEntry[],
): IsobmffOutputPlan {
  const metaBytes = metaBytesPart(plan);
  const iprpBox = findChildInContainer(metaBytes, true, "iprp");
  const iprpBytes = metaBytes.subarray(iprpBox.start, iprpBox.end);
  const ipmaBox = findChildInContainer(iprpBytes, false, "ipma");
  const { version, flags } = readBoxVersionFlags(iprpBytes, ipmaBox);
  const ipmaPayload = iprpBytes.subarray(ipmaBox.payloadStart + 4, ipmaBox.end);
  const entries = parseIpma(ipmaPayload, version, flags);
  const mutatedEntries = mutateEntries(entries);

  const newIpmaBytes = rebuildIpma(
    version,
    flags,
    mutatedEntries.map((entry) => ({
      itemId: entry.itemId,
      associations: entry.associations.map((association) => ({
        propertyIndex: association.propertyIndex,
        essential: association.essential,
      })),
    })),
  );
  const newIprpBytes = replaceChildBytes(
    iprpBytes,
    "iprp",
    false,
    0,
    0,
    ipmaBox,
    newIpmaBytes,
  );
  const newMetaBytes = replaceChildBytes(
    metaBytes,
    "meta",
    true,
    0,
    0,
    iprpBox,
    newIprpBytes,
  );
  return withMetaBytes(plan, newMetaBytes);
}

/** D-19 mutant 1: "the offset shift skipped" -- every surviving construction_method-0 item's
 * rewritten `iloc` base/extent offset is written as its raw position WITHIN the new mdat payload
 * (0-based), as if D-11's `newMdatPayloadStart` addition had never run, instead of the correct
 * absolute file position. `newMdatPayloadStart` is recomputed independently from the plan's own
 * `ftyp` copy length plus its `meta`/`mdat`-header "bytes" part lengths (`parts[0..2]`), never
 * trusted from any other source. */
export function mutateIlocOffsetShiftSkipped(
  plan: IsobmffOutputPlan,
): IsobmffOutputPlan {
  const ftypPart = plan.parts[0];
  const mdatHeaderPart = plan.parts[2];
  if (ftypPart === undefined || ftypPart.kind !== "copy") {
    throw new Error(
      'mutateIlocOffsetShiftSkipped: plan.parts[0] is not the expected ftyp "copy" part.',
    );
  }
  if (mdatHeaderPart === undefined || mdatHeaderPart.kind !== "bytes") {
    throw new Error(
      'mutateIlocOffsetShiftSkipped: plan.parts[2] is not the expected mdat header "bytes" part.',
    );
  }
  const metaBytes = metaBytesPart(plan);
  const newMdatPayloadStart =
    ftypPart.length + metaBytes.length + mdatHeaderPart.data.length;

  return withMutatedIloc(plan, (table) => ({
    offsetSize: table.offsetSize,
    lengthSize: table.lengthSize,
    baseOffsetSize: table.baseOffsetSize,
    indexSize: table.indexSize,
    items: table.items.map((item) => {
      if (item.constructionMethod !== 0) return item;
      if (table.baseOffsetSize > 0) {
        return { ...item, baseOffset: item.baseOffset - newMdatPayloadStart };
      }
      return {
        ...item,
        extents: item.extents.map((extent) => ({
          ...extent,
          offset: extent.offset - newMdatPayloadStart,
        })),
      };
    }),
  }));
}

/** D-19 mutant 2: "the ipma remap off by one" -- every surviving association's (already correctly
 * remapped, per D-16) `propertyIndex` is written one too high. Needs a fixture carrying at least
 * one removed ICC property (so the correct remap is non-trivial) sanitized with
 * `preserveColorProfile: false`. */
export function mutateIpmaRemapOffByOne(
  plan: IsobmffOutputPlan,
): IsobmffOutputPlan {
  return withMutatedIpma(plan, (entries) =>
    entries.map((entry) => ({
      itemId: entry.itemId,
      associations: entry.associations.map((association) => ({
        essential: association.essential,
        propertyIndex: association.propertyIndex + 1,
      })),
    })),
  );
}

function addToMdatHeaderPayloadLength(
  headerBytes: Buffer,
  delta: number,
): Buffer {
  const header = Buffer.from(headerBytes);
  const declared = header.readUInt32BE(0);
  if (declared === 1) {
    // largesize form (D-15): 16-byte header, the real total size is the 8-byte BE field at
    // offset 8.
    const total = header.readBigUInt64BE(8);
    header.writeBigUInt64BE(total + BigInt(delta), 8);
    return header;
  }
  header.writeUInt32BE(declared + delta, 0);
  return header;
}

/** D-19 mutant 3: "one removed range kept in the mdat copy ranges" -- an extra "copy" part
 * (duplicating the first surviving merged range) is appended to the mdat section, with the mdat
 * header's own declared size grown by the same amount so the box itself still parses cleanly.
 * This makes the written `mdat` payload longer than the union of surviving
 * construction_method-0 extents, which D-18's coverage check (`verify.ts`) catches directly. */
export function mutateMdatKeepRemovedRange(
  plan: IsobmffOutputPlan,
): IsobmffOutputPlan {
  const mdatHeaderPart = plan.parts[2];
  if (mdatHeaderPart === undefined || mdatHeaderPart.kind !== "bytes") {
    throw new Error(
      'mutateMdatKeepRemovedRange: plan.parts[2] is not the expected mdat header "bytes" part.',
    );
  }
  const copyIndices = plan.parts
    .map((part, index) => ({ part, index }))
    .filter(({ part, index }) => index >= 3 && part.kind === "copy");
  const first = copyIndices[0];
  const last = copyIndices[copyIndices.length - 1];
  if (first === undefined || last === undefined || first.part.kind !== "copy") {
    throw new Error(
      "mutateMdatKeepRemovedRange: no mdat copy ranges found in the plan to duplicate.",
    );
  }
  const extraLength = first.part.length;
  const extraPart: IsobmffOutputPlanPart = {
    kind: "copy",
    sourceOffset: first.part.sourceOffset,
    length: extraLength,
  };
  const newMdatHeaderBytes = addToMdatHeaderPayloadLength(
    mdatHeaderPart.data,
    extraLength,
  );

  const newParts: IsobmffOutputPlanPart[] = [];
  plan.parts.forEach((part, index) => {
    if (index === 2) {
      newParts.push({ kind: "bytes", data: newMdatHeaderBytes });
      return;
    }
    newParts.push(part);
    if (index === last.index) newParts.push(extraPart);
  });
  return { ...plan, parts: newParts };
}

/** D-19 mutant 4: "iloc widths normalized to 8" -- every field width (`offset_size`,
 * `length_size`, `base_offset_size`, and `index_size` when the version carries one) is forced to
 * 8 bytes, with every item's own `baseOffset`/extent `offset` values left numerically unchanged
 * (just encoded wider). D-18's explicit width-equality check (`verify.ts`, run before any byte
 * comparison) catches this directly, regardless of whether the wider encoding still resolves to
 * the right absolute position. */
export function mutateIlocWidthsNormalizedToEight(
  plan: IsobmffOutputPlan,
): IsobmffOutputPlan {
  return withMutatedIloc(plan, (table) => ({
    offsetSize: 8,
    lengthSize: 8,
    baseOffsetSize: 8,
    indexSize: table.indexSize > 0 ? 8 : table.indexSize,
    items: table.items,
  }));
}

/** D-19 mutant 5: "minimal Exif written to idat with construction method 1" -- the minimal Exif
 * item k's `iloc` entry is rewritten to `construction_method` 1 (idat-relative), never the D-13
 * mandated `construction_method` 0 mdat-tail placement. k is identified as the one surviving
 * construction_method-0 item with exactly one extent whose length equals the plan's own trailing
 * minimal-Exif "bytes" part (the one "bytes" part after every "copy" part in the mdat section,
 * D-13) -- unambiguous for the single-Exif-item fixtures this mutant targets. Requires a fixture
 * and preservation flags that actually synthesize a minimal Exif item (i.e. the plan carries that
 * trailing "bytes" part); throws otherwise, so a misuse is loud rather than silently a no-op. */
export function mutateMinimalExifConstructionMethodOne(
  plan: IsobmffOutputPlan,
): IsobmffOutputPlan {
  let minimalExifLength: number | undefined;
  const lastPart = plan.parts[plan.parts.length - 1];
  if (
    lastPart !== undefined &&
    lastPart.kind === "bytes" &&
    plan.parts.length > 3
  ) {
    minimalExifLength = lastPart.data.length;
  }
  if (minimalExifLength === undefined) {
    throw new Error(
      "mutateMinimalExifConstructionMethodOne: plan has no trailing minimal Exif payload part " +
        "-- this mutant requires a fixture/flags that actually synthesize one (D-13).",
    );
  }

  return withMutatedIloc(plan, (table) => ({
    offsetSize: table.offsetSize,
    lengthSize: table.lengthSize,
    baseOffsetSize: table.baseOffsetSize,
    indexSize: table.indexSize,
    items: table.items.map((item) => {
      if (
        item.constructionMethod === 0 &&
        item.extents.length === 1 &&
        item.extents[0]!.length === minimalExifLength
      ) {
        return { ...item, constructionMethod: 1 };
      }
      return item;
    }),
  }));
}

/** Reparse the plan's `meta` bytes part's own `iref` child into plain `{type, fromItemId,
 * toItemIds}` records, hand them to `mutateRefs`, and splice the rebuilt (mutated) `iref` back in
 * through `rebuildIref` -- the CR-01 fix-pass counterpart of `withMutatedIloc`/`withMutatedIpma`
 * above (62-13 code review fix pass). */
function withMutatedIref(
  plan: IsobmffOutputPlan,
  mutateRefs: (
    refs: readonly {
      type: string;
      fromItemId: number;
      toItemIds: readonly number[];
    }[],
  ) => readonly {
    type: string;
    fromItemId: number;
    toItemIds: readonly number[];
  }[],
): IsobmffOutputPlan {
  const metaBytes = metaBytesPart(plan);
  const irefBox = findChildInContainer(metaBytes, true, "iref");
  const { version } = readBoxVersionFlags(metaBytes, irefBox);
  const idBytes = version === 0 ? 2 : 4;
  const childrenStart = irefBox.payloadStart + 4;
  const children = listChildren(metaBytes, childrenStart, irefBox.end);
  const refs = children.map((child) => {
    const body = metaBytes.subarray(child.payloadStart, child.end);
    const fromItemId =
      idBytes === 2 ? body.readUInt16BE(0) : body.readUInt32BE(0);
    let position = idBytes;
    const toCount = body.readUInt16BE(position);
    position += 2;
    const toItemIds: number[] = [];
    for (let i = 0; i < toCount; i++) {
      toItemIds.push(
        idBytes === 2
          ? body.readUInt16BE(position)
          : body.readUInt32BE(position),
      );
      position += idBytes;
    }
    return { type: child.type, fromItemId, toItemIds };
  });
  const mutated = mutateRefs(refs);
  const newIrefBytes = rebuildIref(
    version,
    mutated.map((reference) => ({
      type: reference.type,
      fromItemId: reference.fromItemId,
      toItemIds: reference.toItemIds,
    })),
  );
  const newMetaBytes = replaceChildBytes(
    metaBytes,
    "meta",
    true,
    0,
    0,
    irefBox,
    newIrefBytes,
  );
  return withMetaBytes(plan, newMetaBytes);
}

/** CR-01 fix-pass regression mutant (62-13): replays the EXACT pre-fix bug shape -- every iref
 * record sharing the from-item that has more than one record (k) gets its to-list forcibly
 * squashed to the qualifying record's own (already-correct, single-target) to-list, exactly as
 * the blanket `fromItemId === kItem?.id` rewrite in `plan.ts`/`verify.ts` used to do before the
 * fix. Applied to the plan the REAL (fixed) writer already produced correctly, so this proves the
 * fixed `verifyOutput` independently recomputes and disagrees -- not merely that the writer itself
 * got it right. Requires a fixture where exactly one from-item carries more than one iref record,
 * one of which is a single-target `cdsc` record (the qualifying shape); throws otherwise. */
export function mutateIrefSquashSecondRecordFromK(
  plan: IsobmffOutputPlan,
): IsobmffOutputPlan {
  return withMutatedIref(plan, (refs) => {
    const counts = new Map<number, number>();
    for (const reference of refs) {
      counts.set(
        reference.fromItemId,
        (counts.get(reference.fromItemId) ?? 0) + 1,
      );
    }
    const kId = [...counts.entries()].find(([, count]) => count > 1)?.[0];
    if (kId === undefined) {
      throw new Error(
        "mutateIrefSquashSecondRecordFromK: no from-item has more than one iref record to squash.",
      );
    }
    const qualifying = refs.find(
      (reference) =>
        reference.fromItemId === kId &&
        reference.type === "cdsc" &&
        reference.toItemIds.length === 1,
    );
    if (qualifying === undefined) {
      throw new Error(
        "mutateIrefSquashSecondRecordFromK: no qualifying single-target cdsc record found for " +
          "the squash target.",
      );
    }
    return refs.map((reference) =>
      reference.fromItemId === kId
        ? { ...reference, toItemIds: [...qualifying.toItemIds] }
        : reference,
    );
  });
}

/** WR-01 fix-pass regression mutant (62-13): corrupts one byte inside an `ipco` property's own
 * payload, in place (the mutated property's total byte length is preserved, so no box header
 * anywhere needs recomputing). Targets a property by type -- the fixture using this mutant must
 * carry exactly one surviving property of that type with at least one payload byte. This is the
 * WR-01 shape: an `ipco` property no `ipma` entry references at all (an orphan, D-34), which the
 * pre-fix `verifyOutput` never read back at all. */
export function mutateIpcoCorruptOrphanProperty(
  orphanType: string,
): (plan: IsobmffOutputPlan) => IsobmffOutputPlan {
  return (plan) => {
    const metaBytes = metaBytesPart(plan);
    const iprpBox = findChildInContainer(metaBytes, true, "iprp");
    const iprpBytes = metaBytes.subarray(iprpBox.start, iprpBox.end);
    const ipcoBox = findChildInContainer(iprpBytes, false, "ipco");
    const ipcoBytes = iprpBytes.subarray(ipcoBox.start, ipcoBox.end);
    const children = listChildren(ipcoBytes, 8, ipcoBytes.length);
    const target = children.find((child) => child.type === orphanType);
    if (target === undefined) {
      throw new Error(
        `mutateIpcoCorruptOrphanProperty: no "${orphanType}" property found in ipco.`,
      );
    }
    if (target.payloadStart >= target.end) {
      throw new Error(
        `mutateIpcoCorruptOrphanProperty: "${orphanType}" property has no payload byte to corrupt.`,
      );
    }
    const mutatedIpco = Buffer.from(ipcoBytes);
    mutatedIpco[target.payloadStart] =
      (mutatedIpco[target.payloadStart]! ^ 0xff) & 0xff;

    const newIprpBytes = Buffer.concat([
      iprpBytes.subarray(0, ipcoBox.start),
      mutatedIpco,
      iprpBytes.subarray(ipcoBox.end),
    ]);
    const newMetaBytes = Buffer.concat([
      metaBytes.subarray(0, iprpBox.start),
      newIprpBytes,
      metaBytes.subarray(iprpBox.end),
    ]);
    return withMetaBytes(plan, newMetaBytes);
  };
}

/**
 * D-19 (62-10): a counting-free wrapper around the REAL writer handler (`inner`, always
 * `createIsobmffWriterHandlerForTests`'s return value) whose `buildOutputPlan` applies `mutate`
 * to the real, already-correct `IsobmffOutputPlan` before it is ever written -- `mutate` sees only
 * the plan itself (frozen plain data), never the admission, matching the plan's own declared
 * seam (`createPlanMutantHandler(inner, mutate: (plan) => plan)`). Every other method delegates
 * straight through, unmodified -- `writeOutput` and `verifyOutput` run the REAL engine against the
 * mutated plan, so a mutant is always caught by the real, unmodified D-18 proof, never by a test
 * double standing in for it.
 */
export function createPlanMutantHandler(
  inner: RegisteredHandler,
  mutate: (plan: IsobmffOutputPlan) => IsobmffOutputPlan,
): RegisteredHandler {
  return Object.freeze({
    capability: inner.capability,
    stagingFileName: inner.stagingFileName,

    matches(magic: Buffer): boolean {
      return inner.matches(magic);
    },

    async admit(
      handle: FileHandle,
      size: number,
      signal?: AbortSignal,
    ): Promise<FormatAdmission> {
      return inner.admit(handle, size, signal);
    },

    inspect(admission: FormatAdmission): Inspection {
      return inner.inspect(admission);
    },

    buildOutputPlan(
      admission: FormatAdmission,
      preserveOrientation: boolean,
      preserveColorProfile: boolean,
      preserveResolution: boolean,
      orientation: number | undefined,
    ): unknown {
      const plan = inner.buildOutputPlan(
        admission,
        preserveOrientation,
        preserveColorProfile,
        preserveResolution,
        orientation,
      ) as IsobmffOutputPlan;
      return mutate(plan);
    },

    checkOutputPlan(plan: unknown): string | undefined {
      return inner.checkOutputPlan(plan as never);
    },

    async writeOutput(
      source: FileHandle,
      destination: FileHandle,
      plan: unknown,
      signal?: AbortSignal,
    ): Promise<void> {
      return inner.writeOutput(source, destination, plan as never, signal);
    },

    async verifyOutput(
      ...args: Parameters<RegisteredHandler["verifyOutput"]>
    ): Promise<Result<void>> {
      return inner.verifyOutput(...args);
    },

    classifyAdmissionFailure(
      cause: unknown,
      preserveColorProfile: boolean,
    ): AdmissionDeclineDetail | undefined {
      return inner.classifyAdmissionFailure(cause, preserveColorProfile);
    },
  }) as RegisteredHandler;
}

// --- D-19 flip-one-byte negative control (62-10, Task 1) --------------------------------------

/**
 * D-19 (62-10): a frozen `RegisteredHandler` delegating every method to `inner` except
 * `writeOutput`, which runs the real `inner.writeOutput` first (so the destination is a fully
 * correct, real sanitized file) and then, unless `position` is `"none"`, XORs `0xFF` into exactly
 * one byte of the DESTINATION file -- the first or last byte of the first surviving
 * construction_method-0 merged mdat range (computed from the plan's own part lengths, D-15: that
 * range is always `plan.parts[3]`, right after the verbatim `ftyp` copy, the `meta` "bytes" part,
 * and the `mdat` header "bytes" part, in that fixed order). `"none"` flips nothing, proving the
 * wrapper itself is inert when disabled (the negative control's negative control).
 */
export function createFlipOneByteHandler(
  inner: RegisteredHandler,
  options: { readonly position: "first" | "last" | "none" },
): RegisteredHandler {
  return Object.freeze({
    capability: inner.capability,
    stagingFileName: inner.stagingFileName,

    matches(magic: Buffer): boolean {
      return inner.matches(magic);
    },

    async admit(
      handle: FileHandle,
      size: number,
      signal?: AbortSignal,
    ): Promise<FormatAdmission> {
      return inner.admit(handle, size, signal);
    },

    inspect(admission: FormatAdmission): Inspection {
      return inner.inspect(admission);
    },

    buildOutputPlan(
      admission: FormatAdmission,
      preserveOrientation: boolean,
      preserveColorProfile: boolean,
      preserveResolution: boolean,
      orientation: number | undefined,
    ): unknown {
      return inner.buildOutputPlan(
        admission,
        preserveOrientation,
        preserveColorProfile,
        preserveResolution,
        orientation,
      );
    },

    checkOutputPlan(plan: unknown): string | undefined {
      return inner.checkOutputPlan(plan as never);
    },

    async writeOutput(
      source: FileHandle,
      destination: FileHandle,
      plan: unknown,
      signal?: AbortSignal,
    ): Promise<void> {
      await inner.writeOutput(source, destination, plan as never, signal);
      if (options.position === "none") return;

      const typedPlan = plan as IsobmffOutputPlan;
      const ftypPart = typedPlan.parts[0];
      const metaPart = typedPlan.parts[1];
      const mdatHeaderPart = typedPlan.parts[2];
      const firstRangePart = typedPlan.parts[3];
      if (
        ftypPart === undefined ||
        ftypPart.kind !== "copy" ||
        metaPart === undefined ||
        metaPart.kind !== "bytes" ||
        mdatHeaderPart === undefined ||
        mdatHeaderPart.kind !== "bytes" ||
        firstRangePart === undefined ||
        firstRangePart.kind !== "copy"
      ) {
        throw new Error(
          "createFlipOneByteHandler: unexpected plan.parts shape -- no surviving mdat range to flip a byte in.",
        );
      }
      const rangeStart =
        ftypPart.length + metaPart.data.length + mdatHeaderPart.data.length;
      const flipAt =
        options.position === "first"
          ? rangeStart
          : rangeStart + firstRangePart.length - 1;

      const byte = Buffer.alloc(1);
      const read = await destination.read(byte, 0, 1, flipAt);
      if (read.bytesRead !== 1) {
        throw new Error(
          `createFlipOneByteHandler: could not read the byte at destination offset ${flipAt}.`,
        );
      }
      byte[0] = byte[0]! ^ 0xff;
      await destination.write(byte, 0, 1, flipAt);
    },

    async verifyOutput(
      ...args: Parameters<RegisteredHandler["verifyOutput"]>
    ): Promise<Result<void>> {
      return inner.verifyOutput(...args);
    },

    classifyAdmissionFailure(
      cause: unknown,
      preserveColorProfile: boolean,
    ): AdmissionDeclineDetail | undefined {
      return inner.classifyAdmissionFailure(cause, preserveColorProfile);
    },
  }) as RegisteredHandler;
}
