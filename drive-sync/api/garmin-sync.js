import { createHash, timingSafeEqual } from 'node:crypto';
import { executeSync, isSyncPreview } from '../lib/run-sync.js';
import { historicalDates } from '../lib/garmin-sync.js';

const hash = value => createHash('sha256').update(value).digest();
const reply = (body, status) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const statuses = { not_found: 404, configuration: 503, already_running: 409 };

export function createSyncHandler(env, request = fetch) {
  return async incoming => {
    if (incoming.method !== 'POST' || !isSyncPreview(env)) return reply({ error: 'not_found' }, 404);
    if (typeof env.CRON_SECRET !== 'string' || env.CRON_SECRET.length < 32 ||
        !timingSafeEqual(hash(incoming.headers.get('authorization') ?? ''), hash('Bearer ' + env.CRON_SECRET))) {
      return reply({ error: 'unauthorized' }, 401);
    }
    let dates;
    if (incoming.body !== null) {
      try {
        const body = await incoming.text();
        if (body.trim()) {
          if (body.length > 256) return reply({ error: 'invalid_date_range' }, 400);
          dates = historicalDates(JSON.parse(body));
          if (!dates) return reply({ error: 'invalid_date_range' }, 400);
        }
      } catch {
        return reply({ error: 'invalid_date_range' }, 400);
      }
    }
    const result = await executeSync(env, request, dates);
    return reply(result, result.ok ? 200 : statuses[result.error] ?? 502);
  };
}

export const POST = createSyncHandler(process.env);
