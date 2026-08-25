function isIdentityFact(value) {
    return (typeof value === "number" &&
        Number.isFinite(value) &&
        Number.isInteger(value) &&
        value >= 0);
}
function isTimestampFact(value) {
    return typeof value === "number" && Number.isFinite(value);
}
export function snapshotSource(stats) {
    return {
        dev: stats.dev,
        ino: stats.ino,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ctimeMs: stats.ctimeMs,
        atime: new Date(stats.atime.getTime()),
        mtime: new Date(stats.mtime.getTime()),
    };
}
export function identityOf(stats) {
    return isIdentityFact(stats.dev) && isIdentityFact(stats.ino)
        ? { dev: stats.dev, ino: stats.ino }
        : undefined;
}
export function identityMatches(expected, actual) {
    return (isIdentityFact(expected.dev) &&
        isIdentityFact(expected.ino) &&
        isIdentityFact(actual.dev) &&
        isIdentityFact(actual.ino) &&
        expected.dev === actual.dev &&
        expected.ino === actual.ino);
}
export function sourceSnapshotMatches(expected, actual) {
    return (identityMatches(expected, actual) &&
        isTimestampFact(expected.size) &&
        isTimestampFact(actual.size) &&
        isTimestampFact(expected.mtimeMs) &&
        isTimestampFact(actual.mtimeMs) &&
        isTimestampFact(expected.ctimeMs) &&
        isTimestampFact(actual.ctimeMs) &&
        expected.size === actual.size &&
        expected.mtimeMs === actual.mtimeMs &&
        expected.ctimeMs === actual.ctimeMs);
}
export function sourcePathMatchesSnapshot(snapshot, stats) {
    return sourceSnapshotMatches(snapshot, stats);
}
export function destinationPathMatchesIdentity(identity, stats) {
    return identityMatches(identity, stats);
}
export function identitiesDistinct(source, destination) {
    return !identityMatches(source, destination);
}
export function timestampsMatchAtMillisecondPrecision(expected, actual) {
    return (Number.isInteger(expected.atime.getTime()) &&
        Number.isInteger(expected.mtime.getTime()) &&
        Number.isInteger(actual.atimeMs) &&
        Number.isInteger(actual.mtimeMs) &&
        expected.atime.getTime() === actual.atimeMs &&
        expected.mtime.getTime() === actual.mtimeMs);
}
//# sourceMappingURL=identity.js.map