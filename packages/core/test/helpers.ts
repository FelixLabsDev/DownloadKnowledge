import { openNodeDriver } from '@dk/storage-node';
import { Collection, DAY_MS, type CollectionOptions } from '../src';

/** 2026-01-05 12:00 UTC. Tests run with a zero timezone offset, so the study day starts at 04:00 UTC. */
export const T0 = Date.UTC(2026, 0, 5, 12);

export interface TestClock {
  now: number;
  advance(ms: number): void;
  days(n: number): void;
}

export async function testCollection(opts: CollectionOptions = {}) {
  const clock: TestClock = {
    now: T0,
    advance(ms) {
      this.now += ms;
    },
    days(n) {
      this.now += n * DAY_MS;
    },
  };
  const driver = openNodeDriver(':memory:');
  const col = await Collection.open(driver, {
    now: () => clock.now,
    tzOffsetMinutes: () => 0,
    fuzz: false,
    ...opts,
  });
  return { col, clock, driver };
}
