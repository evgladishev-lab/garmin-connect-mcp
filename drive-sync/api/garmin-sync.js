import { createHash, timingSafeEqual } from 'node:crypto';
import { executeSync, isSyncPreview } from '../lib/run-sync.js';

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
    const result = await executeSync(env, request);
    return reply(result, result.ok ? 200 : statuses[result.error] ?? 502);
  };
}

export const POST = createSyncHandler(process.env);
