import { createHash, timingSafeEqual } from 'node:crypto';
import { garminClient } from '../lib/garmin-sync.js';
import { openDrive } from '../lib/sync-drive.js';
import { blobState } from '../lib/sync-state.js';
import { failure, syncDays } from '../lib/run-sync.js';

const keys = ['GARMIN_API_KEY', 'GOOGLE_DRIVE_CLIENT_ID', 'GOOGLE_DRIVE_CLIENT_SECRET',
  'GOOGLE_DRIVE_REFRESH_TOKEN', 'BLOB_READ_WRITE_TOKEN', 'GARMIN_SYNC_PROJECT_ID'];

const hash = value => createHash('sha256').update(value).digest();
const reply = (body, status) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export function createSyncHandler(env, request = fetch, dependencies = {}) {
  return async incoming => {
    const projectId = env.GARMIN_SYNC_PROJECT_ID;
    if (!['preview', 'production'].includes(env.VERCEL_ENV) || !projectId ||
        env.VERCEL_PROJECT_ID !== projectId ||
        (incoming.method === 'GET' && env.VERCEL_ENV !== 'production')) {
      return reply({ error: 'not_found' }, 404);
    }
    if (typeof env.CRON_SECRET !== 'string' || env.CRON_SECRET.length < 32 ||
        !timingSafeEqual(hash(incoming.headers.get('authorization') ?? ''), hash('Bearer ' + env.CRON_SECRET))) {
      return reply({ error: 'unauthorized' }, 401);
    }
    if (keys.some(key => !env[key])) return reply({ error: 'configuration' }, 503);
    const state = (dependencies.blobState ?? blobState)(env.BLOB_READ_WRITE_TOKEN, projectId);
    let unlock;
    let result;
    try {
      unlock = await state.lock();
      if (!unlock) return reply({ error: 'already_running' }, 409);
      const deadline = AbortSignal.timeout(90_000);
      const bounded = (url, options) => request(url, {
        ...options, signal: AbortSignal.any([deadline, options.signal]),
      });
      const drive = await (dependencies.openDrive ?? openDrive)(env, bounded);
      result = await syncDays({ get: garminClient(env.GARMIN_API_KEY, bounded), drive, state });
    } catch (error) {
      return reply({ ok: false, ...failure(error, 'sync_environment_failed') }, 502);
    } finally {
      if (unlock) {
        try { await unlock(); } catch {
          // The lease expires automatically before another run can take over.
        }
      }
    }
    return reply(result, result.ok ? 200 : 502);
  };
}

export const GET = createSyncHandler(process.env);
export const POST = GET;
