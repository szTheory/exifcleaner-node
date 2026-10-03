// QUA-02 / D-28 (62.1-06): every box, item and property type the independent inventory sees is
// classified against the closed lists in docs/isobmff.md `## Classification lists (QUA-02)`, and
// anything no list names is reported. Red controls name `zzzz` (top-level) and `zzzp` (property).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PRESERVED_ITEM_TYPES } from "../src/isobmff/admission.js";
import {
  C2PA_UUID_USERTYPE,
  TOP_LEVEL_ALLOWLIST,
} from "../src/isobmff/boxes.js";
import { META_CHILD_ALLOWLIST } from "../src/isobmff/items.js";
import {
  box,
  ftypBox,
  hdlrBox,
  heifFile,
  iinfBox,
  infeBox,
  ipcoBox,
  ispe,
  mdatBox,
  metaBox,
} from "./isobmff-support/builder.js";
import { isobmffArmSampleArbitrary } from "./isobmff-support/generator.js";
import {
  inventoryIsobmff,
  type IsobmffInventory,
} from "./isobmff-support/inventory.js";
import {
  classifyInventoryAgainstSpec,
  EMPTY_SPEC_LISTS,
  loadIsobmffSpecLists,
  parseIsobmffSpecLists,
  type IsobmffSpecLists,
  type SpecVerdict,
} from "./isobmff-support/spec-lists.js";

const DOC_PATH = fileURLToPath(new URL("../docs/isobmff.md", import.meta.url));
const FIXTURE_DIR = fileURLToPath(
  new URL("./isobmff-support/fixtures/", import.meta.url),
);
const FIXTURES = ["heif-enc-grid.heic", "heif-enc-grid.avif"] as const;
const FC_SEED = 460046;
const FC_RUNS = 200;

function minimalHeic(): Buffer {
  return heifFile({
    primary: {
      itemId: 1,
      itemType: "hvc1",
      width: 1,
      height: 1,
      payload: Buffer.from([0x00, 0x01, 0x02, 0x03]),
    },
    exif: { itemId: 2, payload: Buffer.alloc(10) },
  });
}

/** Splits a file into its top-level boxes (32-bit sizes only, which every builder file uses). */
function topLevelBoxes(bytes: Buffer): Buffer[] {
  const boxes: Buffer[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const size = bytes.readUInt32BE(offset);
    boxes.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  return boxes;
}

function unlistedTypes(inventory: IsobmffInventory): string[] {
  return classifyInventoryAgainstSpec(inventory, loadIsobmffSpecLists())
    .unlisted.map(({ kind, type }) => `${kind}:${type}`)
    .sort();
}

describe("loadIsobmffSpecLists parses the doc's closed lists (QUA-02)", () => {
  it("parses four non-empty lists out of docs/isobmff.md", () => {
    const lists = loadIsobmffSpecLists();
    expect(lists.topLevel.get("ftyp")).toBe("preserve");
    expect(lists.topLevel.get("free")).toBe("remove");
    expect(lists.topLevel.get("uuid")).toBe("remove");
    expect(lists.topLevel.get("moov")).toBe("decline");
    expect(lists.metaChildren.get("iloc")).toBe("preserve");
    expect(lists.metaChildren.get("xml ")).toBe("decline");
    expect(lists.itemTypes.get("Exif")).toBe("remove");
    expect(lists.itemTypes.get("mime")).toBe("remove");
    expect(lists.itemTypes.get("hvc1")).toBe("preserve");
    expect(lists.itemTypes.get("uri ")).toBe("decline");
    expect(lists.propertyTypes.get("colr")).toBe("preserve");
    expect(lists.propertyTypes.has("zzzp")).toBe(false);
    expect(lists.topLevel.has("zzzz")).toBe(false);
  });

  it("a duplicated type makes the parser throw", () => {
    const doc = readFileSync(DOC_PATH, "utf8");
    const row = doc.match(/^\| `ftyp` \| preserve \|.*$/mu)?.[0];
    expect(row).toBeDefined();
    const duplicated = doc.replace(row ?? "", `${row ?? ""}\n${row ?? ""}`);
    expect(() => parseIsobmffSpecLists(duplicated)).toThrow(/duplicate/iu);
  });

  it("a verdict outside preserve/remove/decline makes the parser throw", () => {
    const doc = readFileSync(DOC_PATH, "utf8");
    const mutated = doc.replace(
      /^\| `ftyp` \| preserve \|/mu,
      "| `ftyp` | keep     |",
    );
    expect(mutated).not.toBe(doc);
    expect(() => parseIsobmffSpecLists(mutated)).toThrow(/verdict/iu);
  });

  it("a doc without the section, or with a missing list, makes the parser throw", () => {
    const doc = readFileSync(DOC_PATH, "utf8");
    expect(() =>
      parseIsobmffSpecLists(
        doc.replace("## Classification lists (QUA-02)", "## Renamed"),
      ),
    ).toThrow(/Classification lists/u);
    expect(() =>
      parseIsobmffSpecLists(doc.replace("### Item types", "### Renamed")),
    ).toThrow(/Item types/u);
  });
});

describe("classifyInventoryAgainstSpec reports unlisted types (QUA-02)", () => {
  it("red control: an unknown top-level box `zzzz` is reported", () => {
    const file = Buffer.concat([minimalHeic(), box("zzzz", Buffer.alloc(8))]);
    expect(unlistedTypes(inventoryIsobmff(file))).toEqual(["top-level:zzzz"]);
  });

  it("red control: an unknown property type `zzzp` is reported", () => {
    const file = Buffer.concat([
      ftypBox("heic", 0, ["mif1", "heic"]),
      metaBox([
        hdlrBox("pict"),
        iinfBox(0, [infeBox({ version: 2, itemId: 1, itemType: "hvc1" })]),
        box("iprp", ipcoBox([ispe(1, 1), box("zzzp", Buffer.alloc(4))])),
      ]),
      mdatBox(Buffer.alloc(4)),
    ]);
    expect(unlistedTypes(inventoryIsobmff(file))).toEqual(["property:zzzp"]);
  });

  it("adjacency: an unlisted box right after a listed one, and one at the very end, are both reported", () => {
    const [ftyp, ...rest] = topLevelBoxes(minimalHeic());
    const afterListed = Buffer.concat([
      ftyp ?? Buffer.alloc(0),
      box("zzza", Buffer.alloc(0)),
      ...rest,
    ]);
    expect(unlistedTypes(inventoryIsobmff(afterListed))).toEqual([
      "top-level:zzza",
    ]);
    const atEnd = Buffer.concat([minimalHeic(), box("zzzb", Buffer.alloc(0))]);
    expect(unlistedTypes(inventoryIsobmff(atEnd))).toEqual(["top-level:zzzb"]);
    const both = Buffer.concat([
      ftyp ?? Buffer.alloc(0),
      box("zzza", Buffer.alloc(0)),
      ...rest,
      box("zzzb", Buffer.alloc(0)),
    ]);
    expect(unlistedTypes(inventoryIsobmff(both))).toEqual([
      "top-level:zzza",
      "top-level:zzzb",
    ]);
  });

  it("empty: no items and an empty iinf classify with no unlisted types", () => {
    const file = Buffer.concat([
      ftypBox("heic", 0, ["mif1", "heic"]),
      metaBox([hdlrBox("pict"), iinfBox(0, [])]),
      mdatBox(Buffer.alloc(0)),
    ]);
    const inventory = inventoryIsobmff(file);
    expect(inventory.items).toEqual([]);
    expect(unlistedTypes(inventory)).toEqual([]);
  });

  it("empty lists: a real inventory reports every type it contains", () => {
    const inventory = inventoryIsobmff(
      readFileSync(`${FIXTURE_DIR}heif-enc-grid.heic`),
    );
    const expected = [
      ...inventory.topLevel.map((b) => `top-level:${b.type}`),
      ...inventory.metaChildren.map((type) => `meta-child:${type}`),
      ...inventory.items.map((item) => `item:${item.type}`),
      ...inventory.properties.map((property) => `property:${property.type}`),
    ];
    const reported = classifyInventoryAgainstSpec(
      inventory,
      EMPTY_SPEC_LISTS,
    ).unlisted.map(({ kind, type }) => `${kind}:${type}`);
    expect(reported.length).toBeGreaterThan(0);
    expect(new Set(reported)).toEqual(new Set(expected));
    expect(
      classifyInventoryAgainstSpec(inventory, EMPTY_SPEC_LISTS).verdicts,
    ).toEqual([]);
  });

  it("ordering: permuting top-level box order or iinf entry order does not change the verdict set", () => {
    const lists = loadIsobmffSpecLists();
    const [ftyp, meta, mdat] = topLevelBoxes(minimalHeic());
    const free = box("free", Buffer.alloc(4));
    const skip = box("skip", Buffer.alloc(4));
    const orderA = Buffer.concat(
      [ftyp, meta, free, skip, mdat].map((b) => b ?? Buffer.alloc(0)),
    );
    const orderB = Buffer.concat(
      [ftyp, skip, mdat, free, meta].map((b) => b ?? Buffer.alloc(0)),
    );
    const a = classifyInventoryAgainstSpec(inventoryIsobmff(orderA), lists);
    const b = classifyInventoryAgainstSpec(inventoryIsobmff(orderB), lists);
    expect(a.verdicts.length).toBeGreaterThan(0);
    expect(b).toEqual(a);

    const entries = [
      infeBox({ version: 2, itemId: 1, itemType: "hvc1" }),
      infeBox({ version: 2, itemId: 2, itemType: "Exif" }),
      infeBox({ version: 2, itemId: 3, itemType: "grid" }),
    ];
    const withIinf = (ordered: readonly Buffer[]): Buffer =>
      Buffer.concat([
        ftypBox("heic", 0, ["mif1", "heic"]),
        metaBox([hdlrBox("pict"), iinfBox(0, ordered)]),
        mdatBox(Buffer.alloc(0)),
      ]);
    const forward = classifyInventoryAgainstSpec(
      inventoryIsobmff(withIinf(entries)),
      lists,
    );
    const reversed = classifyInventoryAgainstSpec(
      inventoryIsobmff(withIinf([...entries].reverse())),
      lists,
    );
    expect(forward.verdicts).toContainEqual({
      kind: "item",
      type: "grid",
      verdict: "preserve",
    });
    expect(reversed).toEqual(forward);
  });
});

describe("real sources classify with zero unlisted types (QUA-02)", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture} has no unlisted type`, () => {
      const inventory = inventoryIsobmff(
        readFileSync(`${FIXTURE_DIR}${fixture}`),
      );
      expect(inventory.items.length).toBeGreaterThan(0);
      expect(unlistedTypes(inventory)).toEqual([]);
    });
  }

  for (const brand of ["heic", "avif"] as const) {
    it(`${FC_RUNS} ${brand} generator sources (seed ${FC_SEED}) have no unlisted type`, () => {
      const samples = fc.sample(
        isobmffArmSampleArbitrary(brand).filter(
          (armSample) => !armSample.arms.includes("hazard"),
        ),
        { seed: FC_SEED, numRuns: FC_RUNS },
      );
      expect(samples).toHaveLength(FC_RUNS);
      const unlisted = new Set<string>();
      for (const { sample } of samples) {
        for (const type of unlistedTypes(inventoryIsobmff(sample.bytes))) {
          unlisted.add(type);
        }
      }
      expect([...unlisted]).toEqual([]);
    });
  }
});

/** Types in `list` whose verdict is one of `verdicts`. */
function typesWith(
  list: ReadonlyMap<string, SpecVerdict>,
  ...verdicts: SpecVerdict[]
): Set<string> {
  return new Set(
    [...list].filter(([, v]) => verdicts.includes(v)).map(([type]) => type),
  );
}

/** Every disagreement between the spec lists and the engine's own allowlists, both directions. */
function driftAgainstEngine(lists: IsobmffSpecLists): string[] {
  const drift: string[] = [];
  const compare = (
    label: string,
    spec: ReadonlySet<string>,
    engine: ReadonlySet<string>,
  ): void => {
    for (const type of spec) {
      if (!engine.has(type))
        drift.push(`${label}: spec admits "${type}", engine does not`);
    }
    for (const type of engine) {
      if (!spec.has(type))
        drift.push(`${label}: engine admits "${type}", spec does not`);
    }
  };
  const declined = (
    label: string,
    spec: ReadonlySet<string>,
    engine: ReadonlySet<string>,
  ): void => {
    for (const type of spec) {
      if (engine.has(type))
        drift.push(`${label}: spec declines "${type}", engine admits it`);
    }
  };

  // Top level: the engine admits TOP_LEVEL_ALLOWLIST plus the one C2PA `uuid` usertype.
  const topAdmitted = typesWith(lists.topLevel, "preserve", "remove");
  const uuidAdmitted = topAdmitted.delete("uuid");
  compare("top-level", topAdmitted, TOP_LEVEL_ALLOWLIST);
  if (uuidAdmitted !== (C2PA_UUID_USERTYPE.length === 32)) {
    drift.push(
      "top-level: the spec's uuid row disagrees with C2PA_UUID_USERTYPE",
    );
  }
  declined(
    "top-level",
    typesWith(lists.topLevel, "decline"),
    TOP_LEVEL_ALLOWLIST,
  );

  compare(
    "meta-child",
    typesWith(lists.metaChildren, "preserve", "remove"),
    META_CHILD_ALLOWLIST,
  );
  declined(
    "meta-child",
    typesWith(lists.metaChildren, "decline"),
    META_CHILD_ALLOWLIST,
  );

  compare("item", typesWith(lists.itemTypes, "preserve"), PRESERVED_ITEM_TYPES);
  // admission.ts's Rule 2 removes exactly `Exif` and the XMP `mime` shape (not exported).
  compare(
    "item-remove",
    typesWith(lists.itemTypes, "remove"),
    new Set(["Exif", "mime"]),
  );
  declined("item", typesWith(lists.itemTypes, "decline"), PRESERVED_ITEM_TYPES);
  return drift;
}

describe("spec lists agree with the engine (drift guard)", () => {
  it("the doc's lists equal TOP_LEVEL_ALLOWLIST, META_CHILD_ALLOWLIST and PRESERVED_ITEM_TYPES in both directions", () => {
    expect(driftAgainstEngine(loadIsobmffSpecLists())).toEqual([]);
  });

  it("negative control: a spec-only type and an engine-only type are each reported", () => {
    const lists = loadIsobmffSpecLists();
    const itemTypes = new Map(lists.itemTypes);
    itemTypes.set("zzzi", "preserve");
    itemTypes.delete("tmap");
    const metaChildren = new Map(lists.metaChildren);
    metaChildren.set("grpl", "decline");
    const topLevel = new Map(lists.topLevel);
    topLevel.delete("uuid");
    expect(
      driftAgainstEngine({ ...lists, itemTypes, metaChildren, topLevel }),
    ).toEqual([
      "top-level: the spec's uuid row disagrees with C2PA_UUID_USERTYPE",
      'meta-child: engine admits "grpl", spec does not',
      'meta-child: spec declines "grpl", engine admits it',
      'item: spec admits "zzzi", engine does not',
      'item: engine admits "tmap", spec does not',
    ]);
  });
});
