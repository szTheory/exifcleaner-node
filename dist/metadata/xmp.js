const XMP_ORIENTATION_NAME = "tiff:Orientation";
function isOrientationValue(value) {
    return Number.isInteger(value) && value >= 1 && value <= 8;
}
function isValidCodePoint(value) {
    return (Number.isInteger(value) &&
        value >= 0 &&
        value <= 0x10ffff &&
        !(value >= 0xd800 && value <= 0xdfff));
}
function decodeXml(value) {
    return value
        .replace(/&#x([0-9a-f]+);/giu, (_match, digits) => {
        const codePoint = Number.parseInt(digits, 16);
        if (!isValidCodePoint(codePoint))
            throw new RangeError("XMP contains an invalid numeric entity.");
        return String.fromCodePoint(codePoint);
    })
        .replace(/&#([0-9]+);/gu, (_match, digits) => {
        const codePoint = Number.parseInt(digits, 10);
        if (!isValidCodePoint(codePoint))
            throw new RangeError("XMP contains an invalid numeric entity.");
        return String.fromCodePoint(codePoint);
    })
        .replace(/&quot;/gu, '"')
        .replace(/&apos;/gu, "'")
        .replace(/&lt;/gu, "<")
        .replace(/&gt;/gu, ">")
        .replace(/&amp;/gu, "&");
}
function validateEntities(xml) {
    const entitySurface = xml
        .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gu, "")
        .replace(/<!--[\s\S]*?-->/gu, "")
        .replace(/<\?[\s\S]*?\?>/gu, "");
    const withoutValid = entitySurface.replace(/&(amp|quot|apos|lt|gt|#x[0-9a-f]+|#[0-9]+);/giu, 
    // Stryker disable next-line StringLiteral: equivalent-arithmetic — the replacement text of this replace call is only ever searched for an ampersand, and any replacement without one leaves that search result identical.
    "");
    if (withoutValid.includes("&"))
        return "XMP contains a malformed or unsupported entity.";
    try {
        decodeXml(entitySurface);
    }
    catch (cause) {
        return cause instanceof Error
            ? cause.message
            : "XMP contains an invalid entity.";
    }
    return undefined;
}
function validateXmlStructure(xml) {
    if (/<!DOCTYPE\b|<!ENTITY\b/iu.test(xml)) {
        return "XMP document type and entity declarations are unsupported.";
    }
    const stack = [];
    const tokenPattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>/gu;
    let consumed = 0;
    for (const match of xml.matchAll(tokenPattern)) {
        const token = match[0];
        const index = match.index;
        // Stryker disable next-line ConditionalExpression: defensive-unreachable-by-construction — String.prototype.matchAll yields only matches that carry an index, so this guard never fires. The always-true sibling is suppressed only as collateral: the next-line form cannot select a replacement, and that sibling is a compile error, not a frozen member.
        if (index === undefined)
            continue;
        // Stryker disable next-line ConditionalExpression: defensive-unreachable-by-construction — a less-than sign between two matched tokens would itself begin a token, because the last alternative of the token pattern accepts any less-than sign that a greater-than sign follows and one always follows (it ends the next match), so the gap text never holds one. The always-true sibling is suppressed only as collateral: the next-line form cannot select a replacement, and that sibling is a compile error, not a frozen member.
        if (xml.slice(consumed, index).includes("<"))
            // Stryker disable next-line StringLiteral: defensive-unreachable-by-construction — the guard above never fires, so this refusal text is never produced.
            return "XMP contains a malformed tag.";
        consumed = index + token.length;
        if (token.startsWith("<?") ||
            token.startsWith("<!--") ||
            token.startsWith("<![CDATA["))
            continue;
        const close = token.match(/^<\/\s*([A-Za-z_][\w.:-]*)\s*>$/u);
        if (close !== null) {
            const expected = stack.pop();
            if (expected !== close[1])
                return "XMP contains mismatched XML tags.";
            continue;
        }
        const open = token.match(/^<\s*([A-Za-z_][\w.:-]*)\b[\s\S]*>$/u);
        if (open === null)
            return "XMP contains a malformed tag.";
        // Stryker disable next-line StringLiteral: defensive-unreachable-by-construction — the open-tag pattern has a mandatory first capture group, so a match always carries a name and the empty fallback is never used.
        if (!/\/\s*>$/u.test(token))
            stack.push(open[1] ?? "");
    }
    if (xml.slice(consumed).includes("<") || stack.length > 0) {
        return "XMP contains an unclosed XML tag.";
    }
    return undefined;
}
export function parseXmp(payload) {
    const warnings = [];
    let xml;
    try {
        xml = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    }
    catch {
        return {
            entries: [],
            warnings: [
                { code: "metadata-invalid", detail: "XMP is not valid UTF-8." },
            ],
        };
    }
    const structureError = validateXmlStructure(xml);
    const entityError = validateEntities(xml);
    if (structureError !== undefined || entityError !== undefined) {
        return {
            entries: [],
            warnings: [
                {
                    code: "metadata-invalid",
                    detail: structureError ?? entityError ?? "XMP is malformed.",
                },
            ],
        };
    }
    const values = new Map();
    const add = (name, value) => {
        const clean = decodeXml(value.replace(/<[^>]+>/gu, "").trim());
        if (clean.length === 0)
            return;
        const current = values.get(name);
        if (current === undefined)
            values.set(name, [clean]);
        else
            current.push(clean);
    };
    const descriptionPattern = /<rdf:Description\b([^>]*)>/giu;
    for (const match of xml.matchAll(descriptionPattern)) {
        const attributes = match[1] ?? "";
        const attributePattern = /([A-Za-z_][\w.-]*:[A-Za-z_][\w.-]*)\s*=\s*(["'])(.*?)\2/gsu;
        for (const attribute of attributes.matchAll(attributePattern)) {
            const name = attribute[1];
            const value = attribute[3];
            if (name !== undefined &&
                value !== undefined &&
                !name.startsWith("xmlns:")) {
                add(name, value);
            }
        }
    }
    const elementPattern = /<((?!rdf:|x:)[A-Za-z_][\w.-]*:[A-Za-z_][\w.-]*)\b[^>]*>([\s\S]*?)<\/\1\s*>/gu;
    for (const match of xml.matchAll(elementPattern)) {
        const name = match[1];
        const body = match[2];
        if (name === undefined || body === undefined)
            continue;
        const listItems = [
            ...body.matchAll(/<rdf:li\b[^>]*>([\s\S]*?)<\/rdf:li\s*>/gu),
        ];
        if (listItems.length > 0) {
            for (const item of listItems)
                add(name, item[1] ?? "");
        }
        else if (!/<[A-Za-z_]/u.test(body.replace(/<!\[CDATA\[[\s\S]*?\]\]>/gu, ""))) {
            add(name, body.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1"));
        }
    }
    if (!/<(?:x:xmpmeta|rdf:RDF|rdf:Description)\b/u.test(xml)) {
        warnings.push({
            code: "metadata-invalid",
            detail: "XMP packet has no RDF metadata root.",
        });
    }
    return {
        entries: [...values].map(([name, found]) => ({
            namespace: "XMP",
            name,
            value: found.length === 1 ? (found[0] ?? "") : found,
        })),
        warnings,
    };
}
/**
 * D-05: reads a `tiff:Orientation` entry out of an XMP packet for routing
 * purposes only. Returns the value when it parses as an integer 1-8,
 * `"invalid"` when the entry is present but unusable, or `undefined` when no
 * such entry exists. Never returns or forwards XMP bytes — the caller uses
 * the returned value only to decide whether to decline or proceed; it must
 * never reach output.
 */
export function xmpOrientation(xmp) {
    const { entries } = parseXmp(xmp);
    const entry = entries.find((item) => item.name === XMP_ORIENTATION_NAME);
    if (entry === undefined)
        return undefined;
    const raw = entry.value;
    const text = typeof raw === "string"
        ? raw.trim()
        : typeof raw === "number"
            ? String(raw)
            : undefined;
    if (text === undefined || text.length === 0)
        return "invalid";
    const parsed = Number.parseInt(text, 10);
    return String(parsed) === text && isOrientationValue(parsed)
        ? parsed
        : "invalid";
}
//# sourceMappingURL=xmp.js.map