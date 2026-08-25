export function snapshotSource(stats) {
    return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, atime: stats.atime, mtime: stats.mtime };
}
export function identityOf(stats) {
    return { dev: stats.dev, ino: stats.ino };
}
export function identityMatches(expected, actual) {
    return expected.dev === actual.dev && expected.ino === actual.ino;
}
export function sourceSnapshotMatches(expected, actual) {
    return expected.dev === actual.dev && expected.ino === actual.ino && expected.size === actual.size && expected.mtimeMs === actual.mtimeMs && expected.ctimeMs === actual.ctimeMs;
}
//# sourceMappingURL=identity.js.map