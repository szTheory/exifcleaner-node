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

/**
 * fast-check prints each `fc.statistics` row as the label, a run of dots, and the
 * percentage rounded to two decimals (`label..........12.50%`). The dot run has a
 * variable length (at least two) so the percentages line up.
 */
const STATISTICS_ROW = /^(.+?)\.{2,}([0-9]+(?:\.[0-9]+)?)%$/;

/** Half the print resolution: a printed rate within this of its floor is not below it. */
const PRINT_TOLERANCE = 0.005;

/**
 * Maps each label to its printed percentage. Lines that are not rows are ignored,
 * and row order does not matter.
 */
export function parseStatisticsRates(
  lines: readonly string[],
): Map<string, number> {
  const rates = new Map<string, number>();
  for (const line of lines) {
    const match = STATISTICS_ROW.exec(line);
    if (match === null) continue;
    rates.set(match[1]!, Number(match[2]));
  }
  return rates;
}

/**
 * Derives each slot's minimum rate in percent from its absolute counter floor:
 * `100 * floors[keyOf(label)] / floorRuns`, where `floorRuns` is the run count the
 * floors were measured at. Throws naming the slot when its floor key is missing, so a
 * rate can never drift from, or silently outlive, the counter floor it comes from.
 */
export function slotRateFloors(
  floors: Readonly<Counters>,
  slotLabels: readonly string[],
  keyOf: (label: string) => string,
  floorRuns = 200,
): Readonly<Record<string, number>> {
  const rates: Record<string, number> = {};
  for (const label of slotLabels) {
    const key = keyOf(label);
    const floor = floors[key];
    if (floor === undefined) {
      throw new Error(
        `slot ${label}: no floor key ${key} to derive a rate from`,
      );
    }
    rates[label] = (100 * floor) / floorRuns;
  }
  return Object.freeze(rates);
}

/**
 * Throws one Error naming every slot that is absent from the statistics output
 * (zero hits print no row) or whose printed rate is below its stated minimum rate
 * minus half the two-decimal print resolution.
 */
export function assertSlotRates(
  lines: readonly string[],
  rateFloors: Readonly<Record<string, number>>,
): void {
  const rates = parseStatisticsRates(lines);
  const failures: string[] = [];
  for (const [label, minimum] of Object.entries(rateFloors)) {
    const printed = rates.get(label);
    if (printed === undefined) {
      failures.push(`slot ${label}: absent from the statistics output`);
    } else if (printed < minimum - PRINT_TOLERANCE) {
      failures.push(
        `slot ${label}: printed rate ${printed}%, required at least ${minimum}%`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(`Slot rate violations:\n${failures.join("\n")}`);
  }
}
