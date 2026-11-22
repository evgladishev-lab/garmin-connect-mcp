import { randomUUID } from 'node:crypto';
import { DRIVE_FOLDER, DRIVE_URL, exchangeToken, googleJson, googleRequest } from './google-drive.js';

export const fileName = date => 'garmin-daily-' + date + '.json';
const fileFields = 'id,name,mimeType,parents,trashed,appProperties';

export async function openDrive(env, request) {
  const { access_token } = await exchangeToken(request, {
    grant_type: 'refresh_token', client_id: env.GOOGLE_DRIVE_CLIENT_ID,
    client_secret: env.GOOGLE_DRIVE_CLIENT_SECRET, refresh_token: env.GOOGLE_DRIVE_REFRESH_TOKEN,
  });
  const headers = { Authorization: 'Bearer ' + access_token };
  const api = (stage, url, options = {}, accepted) => googleRequest(request, stage, url,
    { ...options, headers: { ...headers, ...options.headers } }, accepted);
  const json = async (stage, url, options) => googleJson(await api(stage, url, options), stage);
  return {
    async find(date) {
      const query = new URLSearchParams({
        q: "'" + DRIVE_FOLDER + "' in parents and trashed = false and name = '" + fileName(date) + "'",
        fields: 'nextPageToken,incompleteSearch,files(' + fileFields + ')', pageSize: '100', supportsAllDrives: 'true',
      });
      const result = await json('drive_list', DRIVE_URL + '/files?' + query);
      if (result.incompleteSearch || result.nextPageToken || !Array.isArray(result.files)) throw new Error('drive_scan_incomplete');
      return result.files;
    },
    async reserve() {
      const ids = await json('drive_id', DRIVE_URL + '/files/generateIds?count=1&space=drive');
      if (!/^[\w-]+$/.test(ids?.ids?.[0] ?? '')) throw new Error('drive_id_invalid');
      return ids.ids[0];
    },
    async read(id, date) {
      const url = DRIVE_URL + '/files/' + id;
      const res = await api('drive_metadata', url + '?supportsAllDrives=true&fields=' + fileFields, {}, [404]);
      if (res.status === 404) { await res.body?.cancel(); return null; }
      const meta = await googleJson(res, 'drive_metadata');
      if (meta.id !== id || meta.name !== fileName(date) || meta.mimeType !== 'application/json' ||
          meta.trashed || meta.parents?.length !== 1 || meta.parents[0] !== DRIVE_FOLDER ||
          meta.appProperties?.garminDate !== date) throw new Error('drive_file_conflict');
      return json('drive_read', url + '?alt=media&supportsAllDrives=true');
    },
    async write(id, date, payload, exists) {
      const root = 'https://www.googleapis.com/upload/drive/v3/files';
      const query = '?supportsAllDrives=true&fields=id';
      if (exists) {
        const response = await api('drive_update', root + '/' + id + query + '&uploadType=media', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: payload,
        });
        await response.body?.cancel();
        return;
      }
      const boundary = randomUUID();
      const metadata = { id, name: fileName(date), parents: [DRIVE_FOLDER], mimeType: 'application/json',
        appProperties: { garminDate: date } };
      const body = ['--' + boundary, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata),
        '--' + boundary, 'Content-Type: application/json', '', payload, '--' + boundary + '--', ''].join('\r\n');
      const response = await api('drive_create', root + query + '&uploadType=multipart', {
        method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body,
      }, [409]);
      await response.body?.cancel();
    },
  };
}
