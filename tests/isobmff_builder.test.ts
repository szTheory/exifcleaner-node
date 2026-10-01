// Hex-literal pins for the ISOBMFF fixture builder (D-20).
//
// Every expected value below is hand-computed from the field widths cited in docs/isobmff.md's
// `## Grammar` section (libheif v1.19.7 `box.cc`), never from calling the builder itself or any
// parser. The builder/parser share an author; these literals are the independent check that the
// builder's bytes actually match the cited spec, not merely match themselves.
//
// Each `expected` literal is a single hex string (never built from `+`-concatenated field pieces)
// so Prettier keeps `Buffer.from("...", "hex")` on one line; the field-by-field breakdown is given
// in the comment immediately above each one.
import { describe, expect, it } from "vitest";
import {
  box,
  ftypBox,
  ilocBox,
  ipmaBox,
  irefBox,
} from "./isobmff-support/builder.js";

describe("box() framing", () => {
  it("size-0 header ('free' box extends-to-EOF framing)", () => {
    // size(32)=00000000 type(32)="free"=66726565, empty payload.
    const expected = Buffer.from("0000000066726565", "hex");
    expect(box("free", Buffer.alloc(0), { size: "zero" })).toEqual(expected);
  });

  it("size-1 largesize header ('mdat' with a 4-byte payload)", () => {
    // size(32)=00000001 type(32)="mdat"=6d646174 largesize(64)=0x14 (16 header + 4 payload)
    // followed by the 4-byte payload itself (01020304).
    // prettier-ignore
    const expected = Buffer.from("000000016d646174000000000000001401020304", "hex");
    expect(
      box("mdat", Buffer.from([0x01, 0x02, 0x03, 0x04]), {
        size: "largesize",
      }),
    ).toEqual(expected);
  });
});

describe("ftypBox()", () => {
  it("major 'heic', minor 0, three compatible brands", () => {
    // size(32)=0000001c (8 header + 4 major + 4 minor + 3*4 compatible = 28)
    // type(32)="ftyp"=66747970, major="heic"=68656963, minor(32)=00000000,
    // compatible: "mif1"=6d696631, "miaf"=6d696166, "heic"=68656963.
    // prettier-ignore
    const expected = Buffer.from("0000001c6674797068656963000000006d6966316d69616668656963", "hex");
    expect(ftypBox("heic", 0, ["mif1", "miaf", "heic"])).toEqual(expected);
  });
});

describe("ilocBox() width matrix", () => {
  it("v0 widths (4,4,0): item 1, one extent (offset 0x10, length 0x20)", () => {
    // FullBox header: size(32)=0000001e type(32)="iloc"=696c6f63 version/flags(32)=00000000.
    // Payload: widths nibble-byte1 (offsetSize4<<4|lengthSize4)=0x44, byte2
    // (baseOffsetSize0<<4|indexSize0)=0x00 -> "4400". item_count(16, v0)=0001.
    // item: item_ID(16, v0)=0001; v0 has NO construction_method field; data_reference_index(16)=
    // 0000; base_offset_size=0 -> no bytes; extent_count(16)=0001; extent: no index (v0);
    // offset(32)=00000010; length(32)=00000020.
    // prettier-ignore
    const expected = Buffer.from("0000001e696c6f6300000000440000010001000000010000001000000020", "hex");
    expect(
      ilocBox({
        version: 0,
        offsetSize: 4,
        lengthSize: 4,
        baseOffsetSize: 0,
        indexSize: 0,
        items: [
          {
            itemId: 1,
            dataReferenceIndex: 0,
            baseOffset: 0,
            extents: [{ offset: 0x10, length: 0x20 }],
          },
        ],
      }),
    ).toEqual(expected);
  });

  it("v1 widths (4,4,0,0): item 7, construction_method 1 encodes 'reserved+cm' as 0001", () => {
    // size(32)=00000020 type(32)="iloc" version/flags(32)=01000000 (version=1). widths "4400".
    // item_count(16, v<2)=0001. item: item_ID(16)=0007; reserved+construction_method(16, v>=1
    // only)=0001 (cm=1); data_reference_index(16)=0000; base_offset_size=0 -> no bytes;
    // extent_count(16)=0001; index_size=0 -> no extent_index bytes even though v>=1;
    // offset(32)=00000100; length(32)=00000200.
    // prettier-ignore
    const expected = Buffer.from("00000020696c6f63010000004400000100070001000000010000010000000200", "hex");
    expect(
      ilocBox({
        version: 1,
        offsetSize: 4,
        lengthSize: 4,
        baseOffsetSize: 0,
        indexSize: 0,
        items: [
          {
            itemId: 7,
            constructionMethod: 1,
            dataReferenceIndex: 0,
            baseOffset: 0,
            extents: [{ offset: 0x100, length: 0x200 }],
          },
        ],
      }),
    ).toEqual(expected);
  });

  it("v2 widths (8,8,8,8): 32-bit item_count/item_ID, 64-bit extent fields", () => {
    // size(32)=0000003c type(32)="iloc" version/flags(32)=02000000 (version=2). widths nibble
    // byte1 (offsetSize8<<4|lengthSize8)=0x88, byte2 (baseOffsetSize8<<4|indexSize8)=0x88 ->
    // "8888". item_count(32, v2)=00000001. item: item_ID(32, v2)=00000009; reserved+
    // construction_method(16, v>=1, defaults cm=0)=0000; data_reference_index(16)=0000;
    // base_offset(64, size8)=0000000000000001; extent_count(16)=0001; extent: index(64, size8,
    // v2 index_size>0)=0000000000000000; offset(64)=0000000000001000;
    // length(64)=0000000000002000.
    // prettier-ignore
    const expected = Buffer.from("0000003c696c6f6302000000888800000001000000090000000000000000000000010001000000000000000000000000000010000000000000002000", "hex");
    expect(
      ilocBox({
        version: 2,
        offsetSize: 8,
        lengthSize: 8,
        baseOffsetSize: 8,
        indexSize: 8,
        items: [
          {
            itemId: 9,
            dataReferenceIndex: 0,
            baseOffset: 0x1,
            extents: [{ index: 0, offset: 0x1000, length: 0x2000 }],
          },
        ],
      }),
    ).toEqual(expected);
  });
});

describe("ipmaBox() association width/essential-bit matrix", () => {
  it("v0 flags 0: 1-byte association, property_index 3 essential -> 0x83", () => {
    // size(32)=00000014 type(32)="ipma"=69706d61 version/flags(32)=00000000. entry_count(32)=
    // 00000001. entry: item_ID(16, v0)=0001; association_count(8)=01; association (1 byte,
    // flags&1==0): essential(0x80)|property_index(3)=0x83.
    // prettier-ignore
    const expected = Buffer.from("0000001469706d61000000000000000100010183", "hex");
    expect(
      ipmaBox({
        version: 0,
        flags: 0,
        entries: [
          { itemId: 1, associations: [{ propertyIndex: 3, essential: true }] },
        ],
      }),
    ).toEqual(expected);
  });

  it("v1 flags 1: 2-byte association, property_index 0x0123 essential -> 0x8123", () => {
    // size(32)=00000017 type(32)="ipma" version/flags(32)=01000001 (version=1, flags=1).
    // entry_count(32)=00000001. entry: item_ID(32, v1)=00000001; association_count(8)=01;
    // association (2 bytes, flags&1==1): essential(0x8000)|property_index(0x0123)=0x8123.
    // prettier-ignore
    const expected = Buffer.from("0000001769706d61010000010000000100000001018123", "hex");
    expect(
      ipmaBox({
        version: 1,
        flags: 1,
        entries: [
          {
            itemId: 1,
            associations: [{ propertyIndex: 0x123, essential: true }],
          },
        ],
      }),
    ).toEqual(expected);
  });
});

describe("irefBox() from/to ID width", () => {
  it("v0 encodes 16-bit from/to IDs", () => {
    // size(32)=0000001a type(32)="iref"=69726566 version/flags(32)=00000000. One reference
    // record, box type="cdsc" (the reference type itself): record_size(32)=0000000e,
    // type="cdsc"=63647363, from_item_ID(16, v0)=0002, reference_count(16, always)=0001,
    // to_item_ID[0](16, v0)=0001.
    // prettier-ignore
    const expected = Buffer.from("0000001a69726566000000000000000e63647363000200010001", "hex");
    expect(
      irefBox(0, [{ type: "cdsc", fromItemId: 2, toItemIds: [1] }]),
    ).toEqual(expected);
  });

  it("v1 encodes 32-bit from/to IDs", () => {
    // size(32)=0000001e type(32)="iref" version/flags(32)=01000000. record_size(32)=00000012,
    // type="cdsc"=63647363, from_item_ID(32, v1)=00000002, reference_count(16, always)=0001,
    // to_item_ID[0](32, v1)=00000001.
    // prettier-ignore
    const expected = Buffer.from("0000001e6972656601000000000000126364736300000002000100000001", "hex");
    expect(
      irefBox(1, [{ type: "cdsc", fromItemId: 2, toItemIds: [1] }]),
    ).toEqual(expected);
  });
});
