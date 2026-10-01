// src/isobmff/items.ts coverage (BMF-04/BMF-05, D1, D-21): the validated item graph
// (`iinf`/`iloc`/`iref`/`ipco`/`ipma`/`pitm`/`grpl`/`idat`/`colr`), proven against the
// independent inventory walker (`tests/isobmff-support/inventory.ts`) on real `heif-enc`
// fixtures and against hand-built structural cases for the AVIF brand, `colr` extraction and
// every graph-validity decline. Task 3 proves `parseIsobmff` never reads `mdat`'s payload.
import { mkdtemp, open, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseIsobmff } from "../src/isobmff/parse.js";
import { buildItemModel } from "../src/isobmff/items.js";
import { inventoryIsobmff } from "./isobmff-support/inventory.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "isobmff-support",
  "fixtures",
);
const HEIC_PATH = join(FIXTURES_DIR, "heif-enc-grid.heic");
const AVIF_PATH = join(FIXTURES_DIR, "heif-enc-grid.avif");

const cleanupDirectories: string[] = [];

afterEach(async () => {
  while (cleanupDirectories.length > 0) {
    const directory = cleanupDirectories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exifcleaner-isobmff-items-"));
  cleanupDirectories.push(directory);
  return directory;
}

async function writeFixture(
  bytes: Buffer,
): Promise<{ path: string; size: number }> {
  const directory = await freshDirectory();
  const path = join(directory, "input.heic");
  const handle = await open(path, "w");
  try {
    await handle.write(bytes, 0, bytes.length, 0);
  } finally {
    await handle.close();
  }
  return { path, size: bytes.length };
}

async function parseFixtureBytes(bytes: Buffer) {
  const { path, size } = await writeFixture(bytes);
  const handle = await open(path, "r");
  try {
    return await parseIsobmff(handle, size);
  } finally {
    await handle.close();
  }
}

/** Compare `parseIsobmff`'s item graph against the independent inventory walker's own view of
 * the same bytes, field by field (D-21). */
async function expectModelMatchesInventory(path: string): Promise<void> {
  const bytes = readFileSync(path);
  const inventory = inventoryIsobmff(bytes);
  expect(inventory.items.length).toBeGreaterThan(0);

  const handle = await open(path, "r");
  try {
    const model = await parseIsobmff(handle, bytes.length);

    expect(model.primaryItemId).toBe(inventory.primaryItemId);
    expect(model.items.map((item) => item.id)).toEqual(
      inventory.items.map((item) => item.id),
    );

    const modelByItemId = new Map(model.items.map((item) => [item.id, item]));
    for (const inventoryItem of inventory.items) {
      const modelItem = modelByItemId.get(inventoryItem.id);
      expect(modelItem).toBeDefined();
      expect(modelItem?.type).toBe(inventoryItem.type);
      expect(modelItem?.hidden).toBe(inventoryItem.hidden);
      expect(modelItem?.constructionMethod).toBe(
        inventoryItem.constructionMethod,
      );
      expect(modelItem?.dataReferenceIndex).toBe(
        inventoryItem.dataReferenceIndex,
      );
      expect(modelItem?.baseOffset).toBe(inventoryItem.baseOffset);
      expect(modelItem?.extents).toEqual(inventoryItem.extents);
      if (inventoryItem.contentType !== undefined) {
        expect(modelItem?.contentType).toBe(inventoryItem.contentType);
      }
    }

    expect(
      model.references.map((reference) => ({
        type: reference.type,
        from: reference.fromItemId,
        to: reference.toItemIds,
      })),
    ).toEqual(
      inventory.references.map((reference) => ({
        type: reference.type,
        from: reference.from,
        to: reference.to,
      })),
    );

    expect(
      model.properties.map((property) => ({
        index: property.index,
        type: property.type,
      })),
    ).toEqual(
      inventory.properties.map((property) => ({
        index: property.index,
        type: property.type,
      })),
    );
    for (const inventoryProperty of inventory.properties) {
      if (inventoryProperty.auxUrn !== undefined) {
        const modelProperty = model.properties.find(
          (property) => property.index === inventoryProperty.index,
        );
        expect(modelProperty?.auxUrn).toBe(inventoryProperty.auxUrn);
      }
    }

    for (const inventoryAssociation of inventory.associations) {
      const modelItem = modelByItemId.get(inventoryAssociation.itemId);
      expect(
        modelItem?.properties.map((association) => ({
          propertyIndex: association.index,
          essential: association.essential,
        })),
      ).toEqual(inventoryAssociation.associations);
    }
  } finally {
    await handle.close();
  }
}

// --- Task 1: item graph from the real heif-enc HEIC, matching the inventory end to end ---

describe("buildItemModel exports (acceptance: items.ts exports buildItemModel and the four types)", () => {
  it("buildItemModel is a function", () => {
    expect(typeof buildItemModel).toBe("function");
  });
});

describe("parseIsobmff item graph on heif-enc-grid.heic", () => {
  it("matches the independent inventory walker's items, references, properties and associations", async () => {
    await expectModelMatchesInventory(HEIC_PATH);
  });

  it("exposes the primary item's colr colour type via properties, with no colorProfile for an nclx primary", async () => {
    const bytes = readFileSync(HEIC_PATH);
    const handle = await open(HEIC_PATH, "r");
    try {
      const model = await parseIsobmff(handle, bytes.length);
      const colr = model.properties.find(
        (property) => property.type === "colr",
      );
      expect(colr?.colourType).toBe("nclx");
      expect(model.colorProfile).toBeUndefined();
      expect(model.idatRange).toEqual({ offset: 59, length: 8 });
      expect(model.handlerType).toBe("pict");
    } finally {
      await handle.close();
    }
  });
});
