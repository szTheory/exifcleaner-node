/**
 * Format-neutral absolute per-arm/per-flag floor counters (D-20).
 *
 * Floors are absolute integers over a fixed sample count. There are no percentages,
 * ratios, or rounding decisions in the pass/fail path.
 */

export type Counters = Record<string, number>;

export function createCounters(): Counters {
  return {};
}

export function countSample(counters: Counters, keys: readonly string[]): void {
  for (const key of keys) {
    counters[key] = (counters[key] ?? 0) + 1;
  }
}

/**
 * Throws one Error listing every counter below its floor, naming the counter and
 * its measured vs. required values. A counter absent from `counts` is treated as 0.
 */
export function assertFloors(
  counts: Readonly<Counters>,
  floors: Readonly<Counters>,
): void {
  const failures: string[] = [];
  for (const [key, floor] of Object.entries(floors)) {
    const measured = counts[key] ?? 0;
    if (measured < floor) {
      failures.push(`${key}: measured ${measured}, required at least ${floor}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Floor violations:\n${failures.join("\n")}`);
  }
}
