import { handleSchedule } from '@vercel/schedules';
import { executeSync } from '../lib/run-sync.js';

export const POST = handleSchedule(async () => {
  const result = await executeSync(process.env);
  console.info(JSON.stringify({
    event: 'garmin_daily_sync', ok: result.ok, error: result.error, stage: result.stage, missing: result.missing,
    days: result.days?.map(({ date, verified, changed, missing, errors, stage, duplicateWorkouts }) =>
      ({ date, verified, changed, missing, errors, stage, duplicateWorkouts })),
  }));
  if (!result.ok) throw new Error('garmin_daily_sync_failed');
});
