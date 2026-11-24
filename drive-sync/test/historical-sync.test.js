import assert from 'node:assert/strict';
import { test } from 'node:test';
import { historicalDates } from '../lib/garmin-sync.js';
import { syncDays } from '../lib/run-sync.js';

test('validates closed historical ranges against the local calendar', () => {
  const now = new Date('2026-11-23T17:00:00Z');
  const bounds = (startDate, endDate) => historicalDates({ startDate, endDate }, now);
  assert.deepEqual(bounds('2026-11-21', '2026-11-23'), ['2026-11-21', '2026-11-22', '2026-11-23']);
  assert.equal(bounds('2026-11-23', '2026-11-24'), null);
  assert.equal(bounds('2026-11-18', '2026-11-23'), null);
  assert.equal(bounds('2025-02-30', '2025-03-01'), null);
});

test('resumes after a partial Garmin failure with the same file IDs', async () => {
  const dates = ['2024-12-20', '2024-12-21'];
  const files = new Map();
  const ids = new Map();
  const writes = [];
  let failure = true;
  let skip = false;
  const drive = {
    async find(date) {
      const id = ids.get(date);
      return files.has(id) ? [{ id }] : [];
    },
    async reserve() { return String(ids.size + 1); },
    async read(id) { return files.get(id) ?? null; },
    async write(id, date, content) { files.set(id, JSON.parse(content)); writes.push(date); },
  };
  const state = {
    async id(date, reserve) {
      if (!ids.has(date)) ids.set(date, await reserve());
      return ids.get(date);
    },
  };
  const get = async (path, params) => {
    if (!path.endsWith('/dailySleep') || skip) return null;
    if (failure && params.date === dates[1]) throw new Error('simulated Garmin error');
    return {
      calendarDate: params.date, sleepTimeSeconds: 3600,
      sleepEndTimestampGMT: Date.parse(params.date + 'T03:00:00Z'),
    };
  };
  const run = (selected = dates) => syncDays({ dates: selected, drive, state, get });
  const first = await run();
  assert.equal(first.ok, false);
  assert.deepEqual(writes, [dates[0]]);
  failure = false;
  const resumed = await run();
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.days.map(day => day.id), first.days.map(day => day.id));
  assert.deepEqual(resumed.days.map(day => day.changed), [false, true]);
  assert.ok((await run()).days.every(day => day.verified && !day.changed));
  skip = true;
  const partial = await run([dates[0], '2024-12-22']);
  assert.equal(partial.days[0].verified, true);
  assert.equal(partial.days[0].changed, false);
  assert.equal(partial.days[1].skipped, 'no_data');
  assert.deepEqual(writes, dates);
});
