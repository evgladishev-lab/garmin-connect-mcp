import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectDay, completedDates } from '../lib/garmin-sync.js';
import { syncDays } from '../lib/run-sync.js';
import { createSyncHandler } from '../api/garmin-sync.js';

const now = new Date('2026-11-22T17:00:00Z');
const selected = '2026-11-21';

function fixture() {
  const records = new Map();
  const days = new Map();
  const writes = [];
  let conflict;
  let failHrv = false;
  let sequence = 0;
  return {
    writes, setDuplicate: date => { conflict = date; }, failHrv: () => { failHrv = true; },
    state: { async id(date, reserve) {
      if (!days.has(date)) days.set(date, await reserve());
      return days.get(date);
    } },
    drive: {
      async find(date) {
        if (date === conflict) return [{ id: 'different' }, { id: 'duplicate' }];
        const id = days.get(date);
        return records.has(id) ? [{ id }] : [];
      },
      async reserve() { return String(++sequence); },
      async read(id) { return records.get(id) ?? null; },
      async write(id, date, content) { writes.push(date); records.set(id, JSON.parse(content)); },
    },
    async get(url, query = {}) {
      if (url.includes('/hrv/')) {
        if (failHrv) throw new Error('synthetic upstream error payload');
        return { hrvSummary: { lastNightAvg: 40 } };
      }
      if (url.includes('/stats/steps')) return [{ calendarDate: url.split('/').at(-1), totalSteps: 0 }];
      if (url.includes('/activities/search')) {
        assert.equal(query.excludeChildren, true);
        const activity = { activityId: 5, startTimeGMT: selected + ' 15:00:00', ownerFullName: 'private metadata' };
        return [activity, activity];
      }
      return null;
    },
  };
}

test('three completed local dates cross the UTC midnight boundary', () => {
  assert.deepEqual(completedDates(new Date('2026-11-22T16:59:59Z')), ['2026-11-19', '2026-11-20', '2026-11-21']);
  assert.deepEqual(completedDates(now), ['2026-11-20', '2026-11-21', '2026-11-22']);
});

test('preserves zero steps, distinguishes missing measurements and deduplicates recorded workouts', async () => {
  const result = await collectDay(fixture().get, selected);
  assert.equal(result.steps.data.totalSteps, 0);
  assert.equal(result.spo2.status, 'no_data');
  assert.equal(result.workouts.data.records.length, 1);
  assert.equal(result.workouts.data.duplicates, 1);
  assert.equal('ownerFullName' in result.workouts.data.records[0], false);
  assert.deepEqual((await collectDay(fixture().get, '2026-11-20')).workouts.data.records, []);
});

test('repeats the same three days without creating duplicate files or writes', async () => {
  const f = fixture();
  const first = await syncDays({ ...f, now });
  const retry = await syncDays({ ...f, now });
  assert.equal(first.ok, true);
  assert.equal(retry.ok, true);
  assert.deepEqual(first.days.map(d => d.id), retry.days.map(d => d.id));
  assert.equal(f.writes.length, 3);
  assert.ok(retry.days.every(d => d.verified && !d.changed));
});

test('retains previous good data on upstream errors and blocks ambiguous Drive duplicates', async () => {
  const f = fixture();
  const first = await syncDays({ ...f, now });
  f.failHrv();
  f.setDuplicate('2026-11-20');
  const second = await syncDays({ ...f, now });
  assert.equal(second.ok, false);
  assert.equal(second.days[0].stage, 'drive_duplicate');
  assert.equal(second.days[1].errors[0].metric, 'hrv');
  const record = await f.drive.read(first.days[1].id);
  assert.deepEqual(record.metrics.hrv, { status: 'stale', data: { lastNightAvg: 40, readings: [] },
    latestAttempt: { status: 'error', stage: 'garmin_shape', code: null } });
});

test('route requires the isolated project ID and bearer and refuses Preview cron GET', async () => {
  const env = { VERCEL_ENV: 'preview', VERCEL_PROJECT_ID: 'prj_test', GARMIN_SYNC_PROJECT_ID: 'prj_test', CRON_SECRET: 'a'.repeat(43) };
  const address = 'https://example.test/api/garmin-sync';
  const make = (method, bearer) => new Request(address, { method, headers: bearer ? { Authorization: 'Bearer ' + bearer } : {} });
  assert.equal((await createSyncHandler(env)(make('GET', env.CRON_SECRET))).status, 404);
  assert.equal((await createSyncHandler({ ...env, VERCEL_PROJECT_ID: 'prj_mcp' })(make('POST', env.CRON_SECRET))).status, 404);
  assert.equal((await createSyncHandler(env)(make('POST'))).status, 401);
  assert.equal((await createSyncHandler(env)(make('POST', env.CRON_SECRET))).status, 503);
});
