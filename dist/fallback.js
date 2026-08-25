export function classifyFallback(error) {
    return error.phase === "admission" && error.nativeWrite === "not-started"
        ? "safe-to-fallback"
        : "do-not-fallback";
}
//# sourceMappingURL=fallback.js.map