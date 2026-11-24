import { openDrive } from './sync-drive.js';
import { blobState } from './sync-state.js';
import { garminClient, collectDay, completedDates, METRICS, ZONE } from './garmin-sync.js';
import { GoogleRequestError } from './google-drive.js';

const schemaVersion = 1;
const knownStages = new Set(['drive_scan_incomplete', 'drive_file_conflict', 'drive_duplicate',
  'drive_schema_invalid', 'drive_readback_mismatch', 'state_id_invalid', 'state_read']);

export function failure(error, fallback) {
  if (error instanceof GoogleRequestError) return { stage: error.stage, upstreamStatus: error.status };
  return { stage: knownStages.has(error?.message) ? error.message : fallback };
}

function validatePrevious(previous, date) {
  if (previous === null) return;
  if (previous?.schemaVersion !== schemaVersion || previous.date !== date || previous.timeZone !== ZONE ||
      previous.source !== 'garmin-connect' || METRICS.some(key =>
        !['ok', 'no_data', 'error', 'stale'].includes(previous.metrics?.[key]?.status) ||
        (['ok', 'stale'].includes(previous.metrics[key].status) && previous.metrics[key].data == null))) {
    throw new Error('drive_schema_invalid');
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

const stringify = value => JSON.stringify(canonical(value));

export async function syncDays({ get, drive, state, now = new Date(), dates }) {
  const historical = dates !== undefined;
  const days = [];
  for (const date of dates ?? completedDates(now)) {
    try {
      const existing = await drive.find(date);
      if (existing.length > 1) throw new Error('drive_duplicate');
      const id = await state.id(date, () => {
        if (existing.length === 1) throw new Error('drive_file_conflict');
        return drive.reserve();
      });
      if (existing.length === 1 && existing[0].id !== id) throw new Error('drive_file_conflict');
      const previous = await drive.read(id, date);
      validatePrevious(previous, date);
      const fetched = await collectDay(get, date, historical);
      const missing = METRICS.filter(key => fetched[key].status === 'no_data');
      const errors = METRICS.filter(key => fetched[key].status === 'error').map(key => ({ metric: key, ...fetched[key] }));
      if (historical && errors.length > 0) {
        days.push({ date, id, changed: false, verified: false, missing, errors });
        continue;
      }
      const workouts = fetched.workouts.data;
      if (historical && previous === null && METRICS.every(key =>
        key === 'workouts' ? !workouts?.records.length : fetched[key].status !== 'ok')) {
        days.push({ date, changed: false, verified: false, skipped: 'no_data', missing, errors });
        continue;
      }
      const metrics = { ...previous?.metrics, ...Object.fromEntries(METRICS.map(key => {
        const fresh = fetched[key];
        const old = previous?.metrics[key];
        if (fresh.status !== 'ok' && old?.data != null) {
          return [key, historical ? old : { status: 'stale', data: old.data, latestAttempt: fresh }];
        }
        if (historical && old?.data && fresh.status === 'ok') {
          if (key === 'workouts') {
            const records = new Map(old.data.records.map(row => [String(row.activityId), row]));
            for (const row of fresh.data.records) {
              const id = String(row.activityId);
              records.set(id, { ...records.get(id), ...row });
            }
            return [key, { ...fresh, data: { ...fresh.data, records: [...records.entries()]
              .sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row) } }];
          }
          return [key, { ...fresh, data: { ...old.data, ...fresh.data } }];
        }
        return [key, fresh];
      })) };
      const output = { schemaVersion, date, timeZone: ZONE, source: 'garmin-connect', metrics };
      const content = stringify(output);
      const changed = content !== stringify(previous);
      if (changed) await drive.write(id, date, content, previous !== null);
      const readback = await drive.read(id, date);
      if (stringify(readback) !== content) throw new Error('drive_readback_mismatch');
      days.push({ date, id, changed, verified: true,
        missing, errors, duplicateWorkouts: workouts?.duplicates ?? 0 });
    } catch (error) {
      days.push({ date, verified: false, ...failure(error, 'sync_day_failed') });
    }
  }
  return { ok: days.every(day => day.skipped === 'no_data' || (day.verified && day.errors.length === 0)), days };
}

const keys = ['GARMIN_API_KEY', 'GOOGLE_DRIVE_CLIENT_ID', 'GOOGLE_DRIVE_CLIENT_SECRET',
  'GOOGLE_DRIVE_REFRESH_TOKEN', 'BLOB_READ_WRITE_TOKEN'];

export function isSyncPreview(env) {
  return env.VERCEL_ENV === 'preview' && Boolean(env.GARMIN_SYNC_PROJECT_ID) &&
    env.VERCEL_PROJECT_ID === env.GARMIN_SYNC_PROJECT_ID;
}

function pacedGarmin(get, signal) {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  return async (...params) => {
    signal.throwIfAborted();
    await wait(175);
    try {
      return await get(...params);
    } catch (error) {
      if (error.status !== 0 && error.status !== 429 && !(error.status >= 500 && error.status <= 599)) throw error;
      await wait(error.status === 429 ? 1500 : 600);
      signal.throwIfAborted();
      return get(...params);
    }
  };
}

export async function executeSync(env, request = fetch, dates) {
  if (!isSyncPreview(env)) return { ok: false, error: 'not_found' };
  const missing = keys.filter(key => !env[key]);
  if (missing.length) return { ok: false, error: 'configuration', missing };
  const state = blobState(env.BLOB_READ_WRITE_TOKEN, env.GARMIN_SYNC_PROJECT_ID);
  let unlock;
  try {
    unlock = await state.lock();
    if (!unlock) return { ok: false, error: 'already_running' };
    const deadline = AbortSignal.timeout(90_000);
    const bounded = (url, options) => request(url, {
      ...options, signal: AbortSignal.any([deadline, options.signal]),
    });
    const drive = await openDrive(env, bounded);
    const get = garminClient(env.GARMIN_API_KEY, bounded);
    return await syncDays({ get: dates ? pacedGarmin(get, deadline) : get, drive, state, dates });
  } catch (error) {
    return { ok: false, ...failure(error, 'sync_environment_failed') };
  } finally {
    if (unlock) {
      try { await unlock(); } catch {
        // The lease expires automatically before another run can take over.
      }
    }
  }
}
