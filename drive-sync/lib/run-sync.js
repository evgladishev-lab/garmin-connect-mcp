import { collectDay, completedDates, METRICS, ZONE } from './garmin-sync.js';
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

export async function syncDays({ get, drive, state, now = new Date() }) {
  const days = [];
  for (const date of completedDates(now)) {
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
      const fetched = await collectDay(get, date);
      const metrics = Object.fromEntries(METRICS.map(key => {
        const fresh = fetched[key];
        const old = previous?.metrics[key];
        return [key, fresh.status !== 'ok' && old?.data != null
          ? { status: 'stale', data: old.data, latestAttempt: fresh }
          : fresh];
      }));
      const output = { schemaVersion, date, timeZone: ZONE, source: 'garmin-connect', metrics };
      const content = stringify(output);
      const changed = content !== stringify(previous);
      if (changed) await drive.write(id, date, content, previous !== null);
      const readback = await drive.read(id, date);
      if (stringify(readback) !== content) throw new Error('drive_readback_mismatch');
      days.push({ date, id, changed, verified: true,
        missing: METRICS.filter(key => fetched[key].status === 'no_data'),
        errors: METRICS.filter(key => fetched[key].status === 'error').map(key => ({ metric: key, ...fetched[key] })),
        duplicateWorkouts: fetched.workouts.data?.duplicates ?? 0 });
    } catch (error) {
      days.push({ date, verified: false, ...failure(error, 'sync_day_failed') });
    }
  }
  return { ok: days.every(day => day.verified && day.errors.length === 0), days };
}
