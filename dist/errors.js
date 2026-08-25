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
    const error = path === undefined
        ? { code: "aborted", detail: "The operation was aborted." }
        : { code: "aborted", detail: "The operation was aborted.", path };
    return requestError(error);
}
function withProof(error, phase, nativeWrite) {
    return { ...error, phase, nativeWrite };
}
export function requestError(error) {
    return withProof(error, "request", "not-started");
}
export function sourceOpenError(error) {
    return withProof(error, "source-open", "not-started");
}
export function admissionDecline(error) {
    return withProof(error, "admission", "not-started");
}
export function executionError(error, nativeWrite) {
    return withProof(error, "transaction", nativeWrite);
}
export function withDestinationFinalization(error, finalization) {
    return { ...error, finalization };
}
//# sourceMappingURL=errors.js.map