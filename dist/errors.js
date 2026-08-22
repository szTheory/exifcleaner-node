export function jsonSafeCause(cause) {
    if (typeof cause === "object" && cause !== null) {
        const candidate = cause;
        const message = typeof candidate.message === "string" ? candidate.message : String(cause);
        if (typeof candidate.code === "string") {
            return { code: candidate.code, message };
        }
        return { message };
    }
    return { message: String(cause) };
}
export function isNodeErrorCode(cause, code) {
    return (typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === code);
}
export function aborted(path) {
    return path === undefined
        ? { code: "aborted", detail: "The operation was aborted." }
        : { code: "aborted", detail: "The operation was aborted.", path };
}
//# sourceMappingURL=errors.js.map