import type { FileHandle } from "node:fs/promises";
import { COPY_BLOCK_BYTES } from "../io/copy-range.js";
import { executionError } from "../errors.js";
import { createMinimalExif } from "../metadata/exif.js";
import { err, ok } from "../result.js";
import type { MetadataError, Result } from "../types.js";
import { classifyIsobmffModel, type IsobmffAdmission } from "./admission.js";
import { IsobmffStructureError } from "./errors.js";
import type { IsobmffItem, IsobmffProperty } from "./items.js";
import { computeIsobmffMinimalExifTags } from "./plan.js";
import { parseIsobmff, type IsobmffModel } from "./parse.js";

// ISOBMFF output verifier (Phase 62, D-18 complete, 62-09): re-parses the destination through the
// real engine, confirms it still admits, and recomputes every expectation from the SOURCE
// admission and the request flags only -- never from the plan's own output (T-62-25). Covers:
// the top-level type list minus free/skip/C2PA uuid with ftyp bytes identical; the surviving item
// set, pitm, and each surviving item's infe fields; iref minus removed entries (k's to-list
// reduction); each surviving item's associations by resolved property bytes plus essential bit,
// in order; each surviving item's payload byte-identical through each file's own iloc/idat,
// streamed in COPY_BLOCK_BYTES windows; 0 or 1 Exif items (D-13's minimal Exif content); 0 mime
// items; the D-16 ICC colr rule both ways; D-11's iloc version/widths; mdat payload-length
// coverage (the union of surviving cm=0 extents); and idat byte-identity.

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function verificationError(detail: string, path: string): MetadataError {
  return executionError(
    { code: "verification-failed", detail, path },
    "started",
  );
}

function verificationAborted(path: string): MetadataError {
  return executionError(
    { code: "aborted", detail: "Operation was aborted.", path },
    "started",
  );
}

/** Resolve an item's extent to an absolute file offset, construction_method 0 (file-relative:
 * `item.baseOffset` is already an absolute file position, written that way by the source encoder
 * and never adjusted outside `mdat`'s own rewrite) or 1 (idat-relative: `item.baseOffset` is an
 * offset into `idat`'s own payload, so the absolute file position is `idat`'s own absolute start
 * -- `layout.metaOffset + layout.metaHeaderSize + idatRange.offset`, since `idatRange.offset` is
 * itself relative to `metaPayload`, a freshly-read standalone buffer, not the file -- plus that). */
function resolveAbsoluteOffset(
  model: IsobmffModel,
  item: IsobmffItem,
  extent: { readonly offset: number },
): number {
  if (item.constructionMethod === 1) {
    if (model.idatRange === undefined) {
      throw new Error(
        "verifyIsobmffOutput: construction_method 1 item but no idat range",
      );
    }
    return (
      model.layout.metaOffset +
      model.layout.metaHeaderSize +
      model.idatRange.offset +
      item.baseOffset +
      extent.offset
    );
  }
  return item.baseOffset + extent.offset;
}

async function rangesEqual(
  sourceHandle: FileHandle,
  sourceOffset: number,
  destinationHandle: FileHandle,
  destinationOffset: number,
  length: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const bufferSize = Math.min(COPY_BLOCK_BYTES, Math.max(length, 1));
  const sourceBuffer = Buffer.allocUnsafe(bufferSize);
  const destinationBuffer = Buffer.allocUnsafe(bufferSize);
  for (let offset = 0; offset < length;) {
    if (isAborted(signal))
      throw signal?.reason ?? new DOMException("Aborted", "AbortError");
    const take = Math.min(COPY_BLOCK_BYTES, length - offset);
    const left = await sourceHandle.read(
      sourceBuffer,
      0,
      take,
      sourceOffset + offset,
    );
    const right = await destinationHandle.read(
      destinationBuffer,
      0,
      take,
      destinationOffset + offset,
    );
    if (left.bytesRead !== take || right.bytesRead !== take) {
      throw new Error(
        "Source or output changed or became truncated during verification.",
      );
    }
    if (
      !sourceBuffer
        .subarray(0, take)
        .equals(destinationBuffer.subarray(0, take))
    )
      return false;
    offset += take;
  }
  return true;
}

/** D-16: read a whole file into one buffer, for the removed-ICC-bytes absence scan only -- every
 * other check in this module reads bounded ranges through the file handles directly. */
async function readWholeFile(
  handle: FileHandle,
  size: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(size);
  const { bytesRead } = await handle.read(buffer, 0, size, 0);
  if (bytesRead !== size) {
    throw new Error("readWholeFile: short read.");
  }
  return buffer;
}

/** D-16: "colr" is a plain box (not a FullBox): size(4) type(4) colour_type(4) [ICC bytes]. The
 * ICC payload starts right after the 8-byte plain box header plus the 4-byte colour_type field. */
function colrIccPayloadBytes(
  model: IsobmffModel,
  property: IsobmffProperty,
): Buffer {
  return model.layout.metaPayload.subarray(property.start + 12, property.end);
}

/** D-16 (recomputed here independently of `plan.ts`, T-62-25): the 1-based `ipco` property
 * indices this request removes -- every `colr` property whose `colourType` is "prof" or "rICC",
 * when `preserveColorProfile` is false; none when it is true. */
function removedColrPropertyIndices(
  model: IsobmffModel,
  preserveColorProfile: boolean,
): ReadonlySet<number> {
  if (preserveColorProfile) return new Set();
  return new Set(
    model.properties
      .filter(
        (property) =>
          property.type === "colr" &&
          (property.colourType === "prof" || property.colourType === "rICC"),
      )
      .map((property) => property.index),
  );
}

/** D-18: one surviving item's associations, resolved to (property bytes, essential), in the
 * item's own declaration order, with any removed ICC property's association already excluded. */
function resolvePropertyAssociationBytes(
  model: IsobmffModel,
  item: IsobmffItem,
  removedIndices: ReadonlySet<number>,
): readonly { readonly bytes: Buffer; readonly essential: boolean }[] {
  return item.properties
    .filter((association) => !removedIndices.has(association.index))
    .map((association) => {
      const property = model.properties.find(
        (candidate) => candidate.index === association.index,
      );
      if (property === undefined) {
        throw new Error(
          `resolvePropertyAssociationBytes: item ${item.id} references undeclared property ` +
            `index ${association.index}.`,
        );
      }
      return {
        bytes: model.layout.metaPayload.subarray(property.start, property.end),
        essential: association.essential,
      };
    });
}

export async function verifyIsobmffOutput(
  sourceHandle: FileHandle,
  admission: IsobmffAdmission,
  destinationHandle: FileHandle,
  destinationSize: number,
  destinationPath: string,
  preserveOrientation: boolean,
  preserveColorProfile: boolean,
  preserveResolution: boolean,
  expectedOrientation: number | undefined,
  signal?: AbortSignal,
): Promise<Result<void>> {
  // D-13/D-18: recompute the minimal Exif item's expected shape from the source admission and
  // the request flags -- never from the plan -- so a planner bug cannot also fool the verifier.
  const tags = computeIsobmffMinimalExifTags(
    admission,
    preserveOrientation,
    preserveResolution,
    expectedOrientation,
  );
  const keepExifItemId =
    tags !== undefined ? admission.exifSourceItemId : undefined;
  const expectedMinimalExifPayload =
    keepExifItemId !== undefined
      ? Buffer.concat([Buffer.alloc(4), createMinimalExif(tags!)])
      : undefined;

  let destinationModel: IsobmffModel;
  try {
    destinationModel = await parseIsobmff(
      destinationHandle,
      destinationSize,
      undefined,
      signal,
    );
    // Must admit: a decline here throws IsobmffStructureError, caught below.
    classifyIsobmffModel(destinationModel, destinationSize);
  } catch (cause) {
    if (isAborted(signal)) return err(verificationAborted(destinationPath));
    return err(
      verificationError(
        cause instanceof IsobmffStructureError
          ? cause.message
          : "Could not reopen and verify the destination.",
        destinationPath,
      ),
    );
  }

  try {
    // D-18: pitm never changes -- the primary item is never removed (D3's removable-item-
    // referenced rule already refuses a removable item named by pitm at admission).
    if (admission.model.primaryItemId !== destinationModel.primaryItemId) {
      return err(
        verificationError("pitm (primary item id) changed.", destinationPath),
      );
    }

    // D-11: the source's iloc version and all four declared field widths are written unchanged.
    const sourceIloc = admission.model.iloc;
    const destinationIloc = destinationModel.iloc;
    if (sourceIloc === undefined || destinationIloc === undefined) {
      return err(verificationError("Missing iloc table.", destinationPath));
    }
    if (
      sourceIloc.version !== destinationIloc.version ||
      sourceIloc.offsetSize !== destinationIloc.offsetSize ||
      sourceIloc.lengthSize !== destinationIloc.lengthSize ||
      sourceIloc.baseOffsetSize !== destinationIloc.baseOffsetSize ||
      sourceIloc.indexSize !== destinationIloc.indexSize
    ) {
      return err(
        verificationError(
          "iloc version or a declared field width changed.",
          destinationPath,
        ),
      );
    }

    // D-14/D-18: the output top-level type list equals the source's minus free/skip/C2PA uuid,
    // in the same source order, and ftyp's bytes are identical. Every admitted top-level `uuid`
    // is the C2PA box (D-09/D5: any other usertype already fails parse-time admission), so
    // filtering by type alone (never by usertype) is exact here.
    const sourceTopLevelTypes = admission.model.layout.topLevelBoxes
      .map((box) => box.type)
      .filter((type) => type !== "free" && type !== "skip" && type !== "uuid");
    const destinationTopLevelTypes = destinationModel.layout.topLevelBoxes.map(
      (box) => box.type,
    );
    if (
      sourceTopLevelTypes.length !== destinationTopLevelTypes.length ||
      sourceTopLevelTypes.some(
        (type, index) => type !== destinationTopLevelTypes[index],
      )
    ) {
      return err(
        verificationError(
          "Destination top-level box list did not match the source minus free/skip/C2PA uuid.",
          destinationPath,
        ),
      );
    }

    const sourceFtyp = admission.model.layout.topLevelBoxes.find(
      (box) => box.type === "ftyp",
    );
    const destinationFtyp = destinationModel.layout.topLevelBoxes.find(
      (box) => box.type === "ftyp",
    );
    if (sourceFtyp === undefined || destinationFtyp === undefined) {
      return err(
        verificationError("Missing top-level ftyp box.", destinationPath),
      );
    }
    const ftypEqual = await rangesEqual(
      sourceHandle,
      sourceFtyp.start,
      destinationHandle,
      destinationFtyp.start,
      sourceFtyp.end - sourceFtyp.start,
      signal,
    );
    if (!ftypEqual) {
      return err(verificationError("ftyp bytes changed.", destinationPath));
    }

    // D-13: k's own id stays in the expected surviving set (in its original source-order slot)
    // exactly when a minimal Exif item is required -- its old payload is gone, but its id is
    // reused in place, never a new allocation.
    const removedIds = new Set(admission.classification.removableItemIds);
    const expectedSurvivingIds = admission.model.items
      .filter((item) => !removedIds.has(item.id) || item.id === keepExifItemId)
      .map((item) => item.id);
    const actualSurvivingIds = destinationModel.items.map((item) => item.id);
    if (
      expectedSurvivingIds.length !== actualSurvivingIds.length ||
      expectedSurvivingIds.some((id, index) => id !== actualSurvivingIds[index])
    ) {
      return err(
        verificationError(
          "Destination item set did not match the sanitized plan.",
          destinationPath,
        ),
      );
    }

    // D-13/D-18: 0 or 1 Exif items. If 1, it must be k, reused at its own id -- never a new one,
    // never more than one. No `mime` (XMP) item ever survives.
    let exifItemCount = 0;
    for (const item of destinationModel.items) {
      if (item.type === "mime") {
        return err(
          verificationError(
            "mime item remained after sanitization.",
            destinationPath,
          ),
        );
      }
      if (item.type === "Exif") {
        exifItemCount += 1;
        if (item.id !== keepExifItemId) {
          return err(
            verificationError(
              `Unexpected Exif item ${item.id} remained after sanitization.`,
              destinationPath,
            ),
          );
        }
      }
    }
    if (exifItemCount > 1) {
      return err(
        verificationError(
          "More than one Exif item remained after sanitization.",
          destinationPath,
        ),
      );
    }
    if (keepExifItemId !== undefined && exifItemCount === 0) {
      return err(
        verificationError(
          `Expected minimal Exif item ${keepExifItemId} is missing from the destination.`,
          destinationPath,
        ),
      );
    }

    // D-16: recomputed independently of plan.ts, from the SOURCE admission's own properties.
    const removedPropertyIndices = removedColrPropertyIndices(
      admission.model,
      preserveColorProfile,
    );

    const sourceItemsById = admission.model.itemsById;
    for (const destinationItem of destinationModel.items) {
      if (destinationItem.id === keepExifItemId) {
        // D-13: k's payload is new, synthesized bytes -- compare against the recomputed
        // expected payload, never against the source's own (removed) Exif bytes.
        if (destinationItem.constructionMethod !== 0) {
          return err(
            verificationError(
              `Minimal Exif item ${destinationItem.id} is not construction_method 0.`,
              destinationPath,
            ),
          );
        }
        if (destinationItem.extents.length !== 1) {
          return err(
            verificationError(
              `Minimal Exif item ${destinationItem.id} does not have exactly one extent.`,
              destinationPath,
            ),
          );
        }
        const extent = destinationItem.extents[0]!;
        if (
          expectedMinimalExifPayload === undefined ||
          extent.length !== expectedMinimalExifPayload.length
        ) {
          return err(
            verificationError(
              `Minimal Exif item ${destinationItem.id} payload length did not match the ` +
                "expected minimal Exif payload.",
              destinationPath,
            ),
          );
        }
        const absoluteOffset = resolveAbsoluteOffset(
          destinationModel,
          destinationItem,
          extent,
        );
        const actualPayload = Buffer.allocUnsafe(extent.length);
        const read = await destinationHandle.read(
          actualPayload,
          0,
          extent.length,
          absoluteOffset,
        );
        if (
          read.bytesRead !== extent.length ||
          !actualPayload.equals(expectedMinimalExifPayload)
        ) {
          return err(
            verificationError(
              `Minimal Exif item ${destinationItem.id} payload bytes did not match the ` +
                "expected minimal Exif payload.",
              destinationPath,
            ),
          );
        }
        // CR-01 (code review 2026-10-02): assert the CARDINALITY of k's qualifying cdsc record
        // -- exactly one cdsc record from k reduces to [pitm] -- not just that `.find()` happens
        // to turn up a match. k may legitimately carry OTHER iref records of any type, including
        // other cdsc records to other items (D-13: only the qualifying record is rewritten; every
        // other record from k survives verbatim), so this does not assert k carries only one cdsc
        // record total, only that exactly one reduces to [pitm].
        const qualifyingCdscRecordsFromK = destinationModel.references.filter(
          (reference) =>
            reference.type === "cdsc" &&
            reference.fromItemId === destinationItem.id &&
            reference.toItemIds.length === 1 &&
            reference.toItemIds[0] === destinationModel.primaryItemId,
        );
        if (qualifyingCdscRecordsFromK.length !== 1) {
          return err(
            verificationError(
              `Minimal Exif item ${destinationItem.id} has ` +
                `${qualifyingCdscRecordsFromK.length} cdsc records reduced to [pitm]; expected ` +
                "exactly 1.",
              destinationPath,
            ),
          );
        }
        if (destinationItem.properties.length !== 0) {
          return err(
            verificationError(
              `Minimal Exif item ${destinationItem.id} unexpectedly carries an ipma entry.`,
              destinationPath,
            ),
          );
        }
        continue;
      }

      const sourceItem = sourceItemsById.get(destinationItem.id);
      if (sourceItem === undefined) {
        return err(
          verificationError(
            `Destination item ${destinationItem.id} has no source counterpart.`,
            destinationPath,
          ),
        );
      }

      // D-18: every surviving item's infe fields (type, name, hidden, contentType,
      // contentEncoding) are equal -- the writer copies every non-k infe box byte-verbatim
      // (D-14), so this must hold exactly.
      if (
        sourceItem.type !== destinationItem.type ||
        sourceItem.name !== destinationItem.name ||
        sourceItem.hidden !== destinationItem.hidden ||
        sourceItem.contentType !== destinationItem.contentType ||
        sourceItem.contentEncoding !== destinationItem.contentEncoding
      ) {
        return err(
          verificationError(
            `Item ${destinationItem.id} infe fields changed.`,
            destinationPath,
          ),
        );
      }

      // D-18: associations compared by resolved property bytes plus essential bit, in order --
      // never by index, never as an unordered set. A removed ICC property's association is
      // excluded from the SOURCE side's expectation (D-16), independently of the plan's own
      // remap, before the ordered comparison runs.
      const expectedAssociations = resolvePropertyAssociationBytes(
        admission.model,
        sourceItem,
        removedPropertyIndices,
      );
      const actualAssociations = resolvePropertyAssociationBytes(
        destinationModel,
        destinationItem,
        new Set(),
      );
      if (expectedAssociations.length !== actualAssociations.length) {
        return err(
          verificationError(
            `Item ${destinationItem.id} property association count changed.`,
            destinationPath,
          ),
        );
      }
      for (let index = 0; index < expectedAssociations.length; index += 1) {
        const expected = expectedAssociations[index]!;
        const actual = actualAssociations[index]!;
        if (
          expected.essential !== actual.essential ||
          !expected.bytes.equals(actual.bytes)
        ) {
          return err(
            verificationError(
              `Item ${destinationItem.id} property association ${index} changed (bytes or ` +
                "essential bit, or associations were reordered).",
              destinationPath,
            ),
          );
        }
      }

      if (sourceItem.extents.length !== destinationItem.extents.length) {
        return err(
          verificationError(
            `Item ${destinationItem.id} extent count changed.`,
            destinationPath,
          ),
        );
      }
      for (let index = 0; index < sourceItem.extents.length; index += 1) {
        const sourceExtent = sourceItem.extents[index]!;
        const destinationExtent = destinationItem.extents[index]!;
        if (sourceExtent.length !== destinationExtent.length) {
          return err(
            verificationError(
              `Item ${destinationItem.id} extent ${index} length changed.`,
              destinationPath,
            ),
          );
        }
        const sourceAbsolute = resolveAbsoluteOffset(
          admission.model,
          sourceItem,
          sourceExtent,
        );
        const destinationAbsolute = resolveAbsoluteOffset(
          destinationModel,
          destinationItem,
          destinationExtent,
        );
        const equal = await rangesEqual(
          sourceHandle,
          sourceAbsolute,
          destinationHandle,
          destinationAbsolute,
          sourceExtent.length,
          signal,
        );
        if (!equal) {
          return err(
            verificationError(
              `Item ${destinationItem.id} payload bytes changed.`,
              destinationPath,
            ),
          );
        }
      }
    }

    // D-18: iref equals the source's minus removed entries, with k's own QUALIFYING cdsc record
    // (the first, in iref order, of type "cdsc" from k whose to-list contains the primary) -- and
    // ONLY that record -- reduced to [pitm] (D-13). Recomputed independently of plan.ts, from the
    // source admission only, and independently of plan.ts's own index computation (code review
    // 2026-10-02 CR-01: a blanket `fromItemId === keepExifItemId` rewrite previously squashed
    // every record from k, not only the qualifying one).
    const qualifyingKReferenceIndex =
      keepExifItemId === undefined
        ? -1
        : admission.model.references.findIndex(
            (reference) =>
              reference.fromItemId === keepExifItemId &&
              reference.type === "cdsc" &&
              reference.toItemIds.includes(admission.model.primaryItemId),
          );
    const expectedReferences = admission.model.references
      .map((reference, index) => ({ reference, index }))
      .filter(
        ({ reference }) =>
          !removedIds.has(reference.fromItemId) ||
          reference.fromItemId === keepExifItemId,
      )
      .map(({ reference, index }) =>
        index === qualifyingKReferenceIndex
          ? { ...reference, toItemIds: [admission.model.primaryItemId] }
          : reference,
      );
    const actualReferences = destinationModel.references;
    if (expectedReferences.length !== actualReferences.length) {
      return err(
        verificationError(
          "iref record count did not match the source minus removed entries.",
          destinationPath,
        ),
      );
    }
    for (let index = 0; index < expectedReferences.length; index += 1) {
      const expected = expectedReferences[index]!;
      const actual = actualReferences[index]!;
      if (
        expected.type !== actual.type ||
        expected.fromItemId !== actual.fromItemId ||
        expected.toItemIds.length !== actual.toItemIds.length ||
        expected.toItemIds.some(
          (id, toIndex) => id !== actual.toItemIds[toIndex],
        )
      ) {
        return err(
          verificationError(
            `iref record ${index} did not match the source minus removed entries.`,
            destinationPath,
          ),
        );
      }
    }

    // D-16/D-18: the ICC `colr` rule, both ways. `nclx` is always preserved, byte-identical,
    // regardless of the flag -- checked first since it applies unconditionally.
    const sourceColrProperties = admission.model.properties.filter(
      (property) => property.type === "colr",
    );
    const destinationColrProperties = destinationModel.properties.filter(
      (property) => property.type === "colr",
    );
    const sourceNclxBytes = sourceColrProperties
      .filter((property) => property.colourType === "nclx")
      .map((property) =>
        admission.model.layout.metaPayload.subarray(
          property.start,
          property.end,
        ),
      );
    const destinationNclxBytes = destinationColrProperties
      .filter((property) => property.colourType === "nclx")
      .map((property) =>
        destinationModel.layout.metaPayload.subarray(
          property.start,
          property.end,
        ),
      );
    if (
      sourceNclxBytes.length !== destinationNclxBytes.length ||
      sourceNclxBytes.some(
        (bytes, index) => !bytes.equals(destinationNclxBytes[index]!),
      )
    ) {
      return err(
        verificationError(
          "A kept nclx colr property changed.",
          destinationPath,
        ),
      );
    }

    if (preserveColorProfile) {
      // D-16: nothing is removed -- the whole ipco box must be byte-identical to the source's.
      const sourceIpco = admission.model.layout.item.iprpChildren.find(
        (child) => child.type === "ipco",
      );
      const destinationIpco = destinationModel.layout.item.iprpChildren.find(
        (child) => child.type === "ipco",
      );
      if ((sourceIpco === undefined) !== (destinationIpco === undefined)) {
        return err(
          verificationError(
            "ipco presence changed although preserveColorProfile is true.",
            destinationPath,
          ),
        );
      }
      if (sourceIpco !== undefined && destinationIpco !== undefined) {
        const sourceIpcoBytes = admission.model.layout.metaPayload.subarray(
          sourceIpco.start,
          sourceIpco.end,
        );
        const destinationIpcoBytes =
          destinationModel.layout.metaPayload.subarray(
            destinationIpco.start,
            destinationIpco.end,
          );
        if (!sourceIpcoBytes.equals(destinationIpcoBytes)) {
          return err(
            verificationError(
              "ipco bytes changed although preserveColorProfile is true.",
              destinationPath,
            ),
          );
        }
      }
    } else {
      // D-16: no prof/rICC colr property may remain anywhere in the destination's ipco, and none
      // of the removed ICC payload bytes may occur anywhere in the destination file.
      for (const property of destinationColrProperties) {
        if (property.colourType === "prof" || property.colourType === "rICC") {
          return err(
            verificationError(
              "An ICC colr property (prof/rICC) remained after sanitization with " +
                "preserveColorProfile false.",
              destinationPath,
            ),
          );
        }
      }
      const removedIccProperties = sourceColrProperties.filter(
        (property) =>
          property.colourType === "prof" || property.colourType === "rICC",
      );
      // WR-01 (code review 2026-10-02): recompute the WHOLE expected surviving ipco payload
      // independently -- source properties, in source order, minus the independently
      // recomputed removed indices -- and compare it byte for byte against the destination's
      // actual ipco children bytes. The per-item association check elsewhere in this function
      // only reads back properties an `ipma` entry actually associates with a surviving item; a
      // property no `ipma` entry references at all (an orphan, D-34, e.g. a `udes` box) was never
      // read back by anything before this check existed, so a corrupting or dropping defect in
      // `rebuildIpco`/the removal filter would go uncaught.
      const removedPropertyIndices = new Set(
        sourceColrProperties
          .filter(
            (property) =>
              property.colourType === "prof" || property.colourType === "rICC",
          )
          .map((property) => property.index),
      );
      const expectedIpcoChildrenBytes = Buffer.concat(
        admission.model.properties
          .filter((property) => !removedPropertyIndices.has(property.index))
          .map((property) =>
            admission.model.layout.metaPayload.subarray(
              property.start,
              property.end,
            ),
          ),
      );
      const destinationIpcoForOrphanCheck =
        destinationModel.layout.item.iprpChildren.find(
          (child) => child.type === "ipco",
        );
      const actualIpcoChildrenBytes =
        destinationIpcoForOrphanCheck === undefined
          ? Buffer.alloc(0)
          : destinationModel.layout.metaPayload.subarray(
              destinationIpcoForOrphanCheck.payloadStart,
              destinationIpcoForOrphanCheck.end,
            );
      if (!expectedIpcoChildrenBytes.equals(actualIpcoChildrenBytes)) {
        return err(
          verificationError(
            "The surviving ipco payload (source properties minus the removed ICC " +
              "properties) did not match the destination byte for byte.",
            destinationPath,
          ),
        );
      }

      if (removedIccProperties.length > 0) {
        const destinationWhole = await readWholeFile(
          destinationHandle,
          destinationSize,
        );
        for (const property of removedIccProperties) {
          const iccBytes = colrIccPayloadBytes(admission.model, property);
          if (iccBytes.length > 0 && destinationWhole.includes(iccBytes)) {
            return err(
              verificationError(
                "Removed ICC payload bytes were found in the destination.",
                destinationPath,
              ),
            );
          }
        }
      }
    }

    // D-18 coverage: the output mdat payload length equals the size of the union of output
    // construction_method-0 extents (recomputed from the destination's own item graph, never
    // trusted from the plan) -- proves no gap and no overflow in the rebuilt mdat payload.
    const destinationMdat = destinationModel.mdatRanges[0];
    if (destinationMdat === undefined) {
      return err(
        verificationError("Missing top-level mdat box.", destinationPath),
      );
    }
    interface AbsoluteRange {
      readonly start: number;
      readonly end: number;
    }
    const cm0Ranges: AbsoluteRange[] = [];
    for (const item of destinationModel.items) {
      if (item.constructionMethod !== 0) continue;
      for (const extent of item.extents) {
        if (extent.length === 0) continue;
        const start = item.baseOffset + extent.offset;
        cm0Ranges.push({ start, end: start + extent.length });
      }
    }
    cm0Ranges.sort((a, b) => a.start - b.start);
    let coveredLength = 0;
    let previousEnd: number | undefined;
    for (const range of cm0Ranges) {
      const effectiveStart =
        previousEnd !== undefined
          ? Math.max(range.start, previousEnd)
          : range.start;
      if (range.end > effectiveStart) {
        coveredLength += range.end - effectiveStart;
      }
      previousEnd =
        previousEnd !== undefined
          ? Math.max(previousEnd, range.end)
          : range.end;
    }
    if (coveredLength !== destinationMdat.length) {
      return err(
        verificationError(
          "Output mdat payload length did not equal the union of surviving extents " +
            `(covered ${coveredLength}, mdat payload length ${destinationMdat.length}).`,
          destinationPath,
        ),
      );
    }

    // D-18: idat is byte-identical. Presence must agree (idat is copied verbatim, D-14 -- it is
    // dropped only when the source never had one); its payload length and bytes must match
    // exactly, resolved to each file's own absolute position (idatRange.offset is relative to
    // `metaPayload`, never the file -- see resolveAbsoluteOffset's banner).
    const sourceIdat = admission.model.idatRange;
    const destinationIdat = destinationModel.idatRange;
    if ((sourceIdat === undefined) !== (destinationIdat === undefined)) {
      return err(verificationError("idat presence changed.", destinationPath));
    }
    if (sourceIdat !== undefined && destinationIdat !== undefined) {
      if (sourceIdat.length !== destinationIdat.length) {
        return err(verificationError("idat length changed.", destinationPath));
      }
      const sourceAbsolute =
        admission.model.layout.metaOffset +
        admission.model.layout.metaHeaderSize +
        sourceIdat.offset;
      const destinationAbsolute =
        destinationModel.layout.metaOffset +
        destinationModel.layout.metaHeaderSize +
        destinationIdat.offset;
      const idatEqual = await rangesEqual(
        sourceHandle,
        sourceAbsolute,
        destinationHandle,
        destinationAbsolute,
        sourceIdat.length,
        signal,
      );
      if (!idatEqual) {
        return err(verificationError("idat bytes changed.", destinationPath));
      }
    }

    return ok(undefined);
  } catch (cause) {
    if (isAborted(signal)) return err(verificationAborted(destinationPath));
    return err(
      verificationError(
        cause instanceof Error
          ? cause.message
          : "Could not verify the destination.",
        destinationPath,
      ),
    );
  }
}
