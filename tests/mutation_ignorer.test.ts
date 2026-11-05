import { describe, expect, it } from "vitest";
import {
  PLAIN_ERROR_CALLEES,
  REFUSE_CALLEE,
  REFUSE_REASON,
  STRUCTURE_ERROR_CALLEES,
  shouldIgnoreErrorMessage,
  shouldIgnoreRefuseMessage,
  // @ts-expect-error plain .mjs tooling scripts without type declarations
} from "../tools/mutation/ignorers/error-message-rule.mjs";

// Unit controls for the `error-message` Stryker ignorer rule (MUT-03, D-20).
// Structural NodePath stand-ins carry only the Babel fields the rule reads,
// so no tooling install is needed. These test tooling, not src.

type Stub = {
  node: { type: string };
  key: number | string;
  listKey: string;
  parentPath: { node: unknown };
};

function arg(
  calleeName: string,
  index: number,
  literalType = "StringLiteral",
  opts: { parentType?: string; callee?: unknown } = {},
): Stub {
  return {
    node: { type: literalType },
    key: index,
    listKey: "arguments",
    parentPath: {
      node: {
        type: opts.parentType ?? "NewExpression",
        callee: opts.callee ?? { type: "Identifier", name: calleeName },
      },
    },
  };
}

const STRUCTURE = [
  "WebpStructureError",
  "PngStructureError",
  "JpegStructureError",
  "IsobmffStructureError",
];
const PLAIN = ["Error", "RangeError", "DOMException"];

describe("error-message ignorer rule (D-20)", () => {
  it("freezes exactly the seven callee names", () => {
    expect([...STRUCTURE_ERROR_CALLEES].sort()).toEqual([...STRUCTURE].sort());
    expect([...PLAIN_ERROR_CALLEES].sort()).toEqual([...PLAIN].sort());
  });

  it.each(STRUCTURE)("ignores the message (index 1) of new %s", (name) => {
    expect(shouldIgnoreErrorMessage(arg(name, 1))).toBe(
      `error-message: message argument of new ${name}(...) (D-20)`,
    );
  });

  it.each(PLAIN)("ignores the message (index 0) of new %s", (name) => {
    expect(shouldIgnoreErrorMessage(arg(name, 0))).toBe(
      `error-message: message argument of new ${name}(...) (D-20)`,
    );
  });

  it("ignores a template literal message too", () => {
    expect(
      shouldIgnoreErrorMessage(arg("WebpStructureError", 1, "TemplateLiteral")),
    ).toMatch(/^error-message:/);
  });

  it.each(STRUCTURE)("does not ignore the kind (index 0) of new %s", (name) => {
    expect(shouldIgnoreErrorMessage(arg(name, 0))).toBeUndefined();
  });

  it.each(STRUCTURE)(
    "does not ignore the limit (index 2) of new %s",
    (name) => {
      expect(shouldIgnoreErrorMessage(arg(name, 2))).toBeUndefined();
    },
  );

  it.each(PLAIN)("does not ignore index 1 (cause) of new %s", (name) => {
    expect(shouldIgnoreErrorMessage(arg(name, 1))).toBeUndefined();
  });

  it("does not ignore a call expression without new", () => {
    expect(
      shouldIgnoreErrorMessage(
        arg("Error", 0, "StringLiteral", { parentType: "CallExpression" }),
      ),
    ).toBeUndefined();
  });

  it("does not ignore an unlisted callee such as new TypeError", () => {
    expect(shouldIgnoreErrorMessage(arg("TypeError", 0))).toBeUndefined();
  });

  it("does not ignore a member callee such as new errors.WebpStructureError", () => {
    const callee = {
      type: "MemberExpression",
      object: { type: "Identifier", name: "errors" },
      property: { type: "Identifier", name: "WebpStructureError" },
    };
    expect(
      shouldIgnoreErrorMessage(arg("", 1, "StringLiteral", { callee })),
    ).toBeUndefined();
  });

  it("does not ignore a refusal-details table string", () => {
    const tableString: Stub = {
      node: { type: "StringLiteral" },
      key: "detail",
      listKey: "properties",
      parentPath: { node: { type: "ObjectProperty" } },
    };
    expect(shouldIgnoreErrorMessage(tableString)).toBeUndefined();
  });

  it("does not ignore a FourCC comparison literal", () => {
    const fourCc: Stub = {
      node: { type: "StringLiteral" },
      key: "right",
      listKey: undefined as unknown as string,
      parentPath: { node: { type: "BinaryExpression" } },
    };
    expect(shouldIgnoreErrorMessage(fourCc)).toBeUndefined();
  });

  it.each(["NumericLiteral", "Identifier", "BooleanLiteral"])(
    "does not ignore a %s at the message index",
    (type) => {
      expect(
        shouldIgnoreErrorMessage(arg("WebpStructureError", 1, type)),
      ).toBeUndefined();
    },
  );

  it("is undefined for a missing path or node", () => {
    expect(shouldIgnoreErrorMessage(undefined)).toBeUndefined();
    expect(shouldIgnoreErrorMessage({})).toBeUndefined();
  });
});

// Second narrow rule (67-27 second halt): the message argument of refuse(<refusal>, <message>).
function refuseArg(
  index: number,
  literalType = "StringLiteral",
  opts: { parentType?: string; callee?: unknown; listKey?: string } = {},
): Stub {
  return {
    node: { type: literalType },
    key: index,
    listKey: opts.listKey ?? "arguments",
    parentPath: {
      node: {
        type: opts.parentType ?? "CallExpression",
        callee: opts.callee ?? { type: "Identifier", name: "refuse" },
      },
    },
  };
}

describe("refuse message ignorer rule (D-20 second rule)", () => {
  it("names exactly the refuse callee and a valid unobservable-message class reason", () => {
    expect(REFUSE_CALLEE).toBe("refuse");
    expect(REFUSE_REASON).toMatch(/^unobservable-message — \S/);
    expect(REFUSE_REASON.startsWith("error-message:")).toBe(false);
  });

  it("ignores the message (index 1) of refuse(...) as a string or template literal", () => {
    expect(shouldIgnoreRefuseMessage(refuseArg(1))).toBe(REFUSE_REASON);
    expect(shouldIgnoreRefuseMessage(refuseArg(1, "TemplateLiteral"))).toBe(
      REFUSE_REASON,
    );
  });

  it("does not ignore the refusal literal (index 0), the type-invalid mutant stays visible", () => {
    expect(shouldIgnoreRefuseMessage(refuseArg(0))).toBeUndefined();
  });

  it("does not ignore index 2 or any later argument of refuse(...)", () => {
    expect(shouldIgnoreRefuseMessage(refuseArg(2))).toBeUndefined();
    expect(shouldIgnoreRefuseMessage(refuseArg(3))).toBeUndefined();
  });

  it("does not ignore the same position of other callees, member callees or new expressions", () => {
    for (const name of ["fail", "refuseAll", "Refuse", "throwError"]) {
      expect(
        shouldIgnoreRefuseMessage(
          refuseArg(1, "StringLiteral", {
            callee: { type: "Identifier", name },
          }),
        ),
      ).toBeUndefined();
    }
    const member = {
      type: "MemberExpression",
      object: { type: "Identifier", name: "this" },
      property: { type: "Identifier", name: "refuse" },
    };
    expect(
      shouldIgnoreRefuseMessage(
        refuseArg(1, "StringLiteral", { callee: member }),
      ),
    ).toBeUndefined();
    expect(
      shouldIgnoreRefuseMessage(
        refuseArg(1, "StringLiteral", { parentType: "NewExpression" }),
      ),
    ).toBeUndefined();
  });

  it("does not ignore a non-literal argument, a literal outside an argument list or an unrelated literal", () => {
    for (const type of ["NumericLiteral", "Identifier", "BooleanLiteral"])
      expect(shouldIgnoreRefuseMessage(refuseArg(1, type))).toBeUndefined();
    expect(
      shouldIgnoreRefuseMessage(
        refuseArg(1, "StringLiteral", { listKey: "elements" }),
      ),
    ).toBeUndefined();
    const fourCc: Stub = {
      node: { type: "StringLiteral" },
      key: "right",
      listKey: undefined as unknown as string,
      parentPath: { node: { type: "BinaryExpression" } },
    };
    expect(shouldIgnoreRefuseMessage(fourCc)).toBeUndefined();
  });

  it("leaves the D-20 rule untouched: refuse(...) is not a structure-error constructor, and a structure error is not a refuse call", () => {
    expect(shouldIgnoreErrorMessage(refuseArg(1))).toBeUndefined();
    expect(
      shouldIgnoreRefuseMessage(arg("JpegStructureError", 1)),
    ).toBeUndefined();
  });

  it("is undefined for a missing path or node", () => {
    expect(shouldIgnoreRefuseMessage(undefined)).toBeUndefined();
    expect(shouldIgnoreRefuseMessage({})).toBeUndefined();
  });
});
