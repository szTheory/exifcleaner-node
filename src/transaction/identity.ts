import type { Stats } from "node:fs";

export interface SourceSnapshot {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly atime: Date;
  readonly mtime: Date;
}

export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export function snapshotSource(stats: Stats): SourceSnapshot {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, atime: stats.atime, mtime: stats.mtime };
}

export function identityOf(stats: Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

export function identityMatches(expected: FileIdentity, actual: Stats): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino;
}

export function sourceSnapshotMatches(expected: SourceSnapshot, actual: Stats): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino && expected.size === actual.size && expected.mtimeMs === actual.mtimeMs && expected.ctimeMs === actual.ctimeMs;
}
