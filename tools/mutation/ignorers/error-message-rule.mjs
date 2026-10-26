// Pure rule behind the `error-message` Stryker ignorer (67-04, D-20).
// Reads only the Babel NodePath fields node.type, key, listKey, parentPath.node
// so unit tests can use structural stand-ins without Babel.

// Typed errors: (kind, message, limit?) so the message is argument index 1.
export const STRUCTURE_ERROR_CALLEES = Object.freeze(
  new Set([
    "WebpStructureError",
    "PngStructureError",
    "JpegStructureError",
    "IsobmffStructureError",
  ]),
);
export const STRUCTURE_ERROR_MESSAGE_INDEX = 1;

// Platform errors: (message) so the message is argument index 0.
export const PLAIN_ERROR_CALLEES = Object.freeze(
  new Set(["Error", "RangeError", "DOMException"]),
);
export const PLAIN_ERROR_MESSAGE_INDEX = 0;

export const ERROR_MESSAGE_REASON_PREFIX = "error-message:";

const LITERAL_TYPES = new Set(["StringLiteral", "TemplateLiteral"]);

export function shouldIgnoreErrorMessage(path) {
  const node = path?.node;
  if (!node || !LITERAL_TYPES.has(node.type)) return undefined;
  if (path.listKey !== "arguments") return undefined;
  const parent = path.parentPath?.node;
  if (!parent || parent.type !== "NewExpression") return undefined;
  const callee = parent.callee;
  if (!callee || callee.type !== "Identifier") return undefined;
  const name = callee.name;
  let index;
  if (STRUCTURE_ERROR_CALLEES.has(name)) index = STRUCTURE_ERROR_MESSAGE_INDEX;
  else if (PLAIN_ERROR_CALLEES.has(name)) index = PLAIN_ERROR_MESSAGE_INDEX;
  else return undefined;
  if (path.key !== index) return undefined;
  return `${ERROR_MESSAGE_REASON_PREFIX} message argument of new ${name}(...) (D-20)`;
}
