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

function isIdentityFact(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isTimestampFact(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function snapshotSource(stats: Stats): SourceSnapshot {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, atime: stats.atime, mtime: stats.mtime };
}

export function identityOf(stats: Stats): FileIdentity | undefined {
  return isIdentityFact(stats.dev) && isIdentityFact(stats.ino) ? { dev: stats.dev, ino: stats.ino } : undefined;
}

export function identityMatches(expected: FileIdentity, actual: Stats): boolean {
  return isIdentityFact(expected.dev) && isIdentityFact(expected.ino) && isIdentityFact(actual.dev) && isIdentityFact(actual.ino) && expected.dev === actual.dev && expected.ino === actual.ino;
}

export function sourceSnapshotMatches(expected: SourceSnapshot, actual: Stats): boolean {
  return identityMatches(expected, actual) && isTimestampFact(expected.size) && isTimestampFact(actual.size) && isTimestampFact(expected.mtimeMs) && isTimestampFact(actual.mtimeMs) && isTimestampFact(expected.ctimeMs) && isTimestampFact(actual.ctimeMs) && expected.size === actual.size && expected.mtimeMs === actual.mtimeMs && expected.ctimeMs === actual.ctimeMs;
}

export function sourcePathMatchesSnapshot(snapshot: SourceSnapshot, stats: Stats): boolean {
  return sourceSnapshotMatches(snapshot, stats);
}

export function destinationPathMatchesIdentity(identity: FileIdentity, stats: Stats): boolean {
  return identityMatches(identity, stats);
}

export function identitiesDistinct(source: FileIdentity, destination: Stats): boolean {
  return !identityMatches(source, destination);
}

export function timestampsMatchAtMillisecondPrecision(
  expected: SourceSnapshot,
  actual: Stats,
): boolean {
  return Number.isInteger(expected.atime.getTime()) && Number.isInteger(expected.mtime.getTime()) && Number.isInteger(actual.atimeMs) && Number.isInteger(actual.mtimeMs) && expected.atime.getTime() === actual.atimeMs && expected.mtime.getTime() === actual.mtimeMs;
}
