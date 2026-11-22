import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { DRIVE_FOLDER, DRIVE_URL, GoogleRequestError, exchangeToken, googleJson, googleRequest } from '../lib/google-drive.js';

const FILE_NAME = 'garmin-drive-smoke.json';
const fileContent = JSON.stringify({ source: 'garmin-health-sync', test: true }) + '\n';

function reply(body, status) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function authorized(header, secret) {
  const hash = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(header ?? ''), hash('Bearer ' + secret));
}

export function createHandler(env, request = fetch) {
  return async function driveSmoke(incoming) {
    const { VERCEL_ENV, DRIVE_SMOKE_TOKEN, GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET,
      GOOGLE_DRIVE_REFRESH_TOKEN, DRIVE_SMOKE_FILE_ID } = env;

    if (VERCEL_ENV !== 'preview' || !/^[a-f0-9]{64}$/.test(DRIVE_SMOKE_TOKEN ?? '')) {
      return reply({ error: 'not_found' }, 404);
    }
    if (!authorized(incoming.headers.get('authorization'), DRIVE_SMOKE_TOKEN)) {
      return reply({ error: 'unauthorized' }, 401);
    }
    if (!GOOGLE_DRIVE_CLIENT_ID || !GOOGLE_DRIVE_CLIENT_SECRET || !GOOGLE_DRIVE_REFRESH_TOKEN ||
        !/^[A-Za-z0-9_-]+$/.test(DRIVE_SMOKE_FILE_ID ?? '')) {
      return reply({ error: 'configuration' }, 503);
    }

    try {
      const { access_token } = await exchangeToken(request, {
        grant_type: 'refresh_token',
        client_id: GOOGLE_DRIVE_CLIENT_ID,
        client_secret: GOOGLE_DRIVE_CLIENT_SECRET,
        refresh_token: GOOGLE_DRIVE_REFRESH_TOKEN,
      });
      const headers = { Authorization: 'Bearer ' + access_token };
      const boundary = randomUUID();
      const metadata = { id: DRIVE_SMOKE_FILE_ID, name: FILE_NAME, parents: [DRIVE_FOLDER], mimeType: 'application/json' };
      const body = [
        '--' + boundary,
        'Content-Type: application/json; charset=UTF-8',
        '',
        JSON.stringify(metadata),
        '--' + boundary,
        'Content-Type: application/json',
        '',
        fileContent,
        '--' + boundary + '--',
        '',
      ].join('\r\n');

      const upload = await googleRequest(request, 'drive_create',
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'multipart/related; boundary=' + boundary },
          body,
        }, [409]);
      await upload.body?.cancel().catch(() => {});

      const url = DRIVE_URL + '/files/' + DRIVE_SMOKE_FILE_ID;
      const fields = 'id,name,mimeType,parents,trashed,webViewLink';
      const file = await googleJson(await googleRequest(request, 'drive_metadata',
        url + '?supportsAllDrives=true&fields=' + fields, { headers }), 'drive_metadata');
      if (file?.id !== DRIVE_SMOKE_FILE_ID || file.name !== FILE_NAME ||
          file.trashed !== false || file.mimeType !== 'application/json' ||
          file.parents?.length !== 1 || file.parents[0] !== DRIVE_FOLDER) {
        return reply({ error: 'drive_metadata_mismatch' }, 502);
      }

      const media = await googleRequest(request, 'drive_readback', url + '?alt=media&supportsAllDrives=true', { headers });
      if (await media.text() !== fileContent) {
        return reply({ error: 'drive_content_mismatch' }, 502);
      }
      return reply({ id: file.id, folderId: DRIVE_FOLDER, verified: true, created: upload.status !== 409 }, 200);
    } catch (error) {
      if (error instanceof GoogleRequestError) {
        return reply({ error: error.stage, upstreamStatus: error.status }, 502);
      }
      return reply({ error: 'drive_smoke_failed' }, 502);
    }
  };
}

export const POST = createHandler(process.env);
