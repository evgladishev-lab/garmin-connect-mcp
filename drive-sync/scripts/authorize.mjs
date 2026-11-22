import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { DRIVE_FOLDER, DRIVE_SCOPE, DRIVE_URL, exchangeToken, googleJson, googleRequest } from '../lib/google-drive.js';

const origin = 'http://127.0.0.1:53682';
const redirectUri = origin + '/oauth/callback';
const { GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, GOOGLE_PICKER_API_KEY, GOOGLE_CLOUD_PROJECT_NUMBER } = process.env;
const outputFile = new URL('../.env.drive-preview', import.meta.url);
const random = () => randomBytes(32).toString('base64url');
const startKey = random();
const state = random();
const verifier = random();
const pickerNonce = random();
let started = false;
let callbackUsed = false;
let selectionUsed = false;
let tokens;

function send(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
  }).end(body);
}

function pickerPage(accessToken) {
  const config = JSON.stringify({
    accessToken,
    apiKey: GOOGLE_PICKER_API_KEY,
    appId: GOOGLE_CLOUD_PROJECT_NUMBER,
    folderId: DRIVE_FOLDER,
    nonce: pickerNonce,
  }).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="ru"><meta charset="utf-8">
<title>Garmin Health Sync</title>
<h1>Подключение Google Drive</h1>
<p>В Google Picker выберите существующую папку Garmin Health Sync.</p>
<button id="open" disabled>Выбрать папку</button><p id="result" role="status"></p>
<script src="https://apis.google.com/js/api.js"></script>
<script>
const settings = ${config};
const button = document.querySelector('#open');
const result = document.querySelector('#result');
gapi.load('picker', () => { button.disabled = false; });
button.onclick = () => {
  const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
    .setIncludeFolders(true).setSelectFolderEnabled(true).setMode(google.picker.DocsViewMode.LIST);
  new google.picker.PickerBuilder().addView(view)
    .setDeveloperKey(settings.apiKey).setAppId(settings.appId)
    .setOAuthToken(settings.accessToken).setOrigin(location.origin)
    .setCallback(async data => {
      if (data.action !== google.picker.Action.PICKED) return;
      if (data.docs[0]?.id !== settings.folderId) {
        result.textContent = 'Выберите папку Garmin Health Sync с указанным в проекте ID.';
        return;
      }
      button.disabled = true;
      try {
        const response = await fetch('/select', { method: 'POST', headers: { 'X-Picker-Nonce': settings.nonce } });
        result.textContent = await response.text();
      } catch {
        result.textContent = 'Локальная настройка прервана. Проверьте терминал.';
      }
    }).build().setVisible(true);
};
</script></html>`;
}

async function handle(request, response) {
  if (request.headers.host !== new URL(origin).host) {
    send(response, 403, 'Invalid host.');
    return;
  }
  const url = new URL(request.url, origin);
  if (request.method === 'GET' && url.pathname === '/start' && url.searchParams.get('key') === startKey && !started) {
    started = true;
    const params = new URLSearchParams({
      client_id: GOOGLE_DRIVE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: DRIVE_SCOPE,
      access_type: 'offline', prompt: 'consent', state, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    response.writeHead(302, {
      Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + params,
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    }).end();
    return;
  }
  if (request.method === 'GET' && url.pathname === '/oauth/callback') {
    const code = url.searchParams.get('code');
    if (!started || callbackUsed || url.searchParams.get('state') !== state || !code) {
      send(response, 400, 'Google authorization did not complete. Restart the local setup.');
      return;
    }
    callbackUsed = true;
    tokens = await exchangeToken(fetch, {
      client_id: GOOGLE_DRIVE_CLIENT_ID, client_secret: GOOGLE_DRIVE_CLIENT_SECRET,
      redirect_uri: redirectUri, grant_type: 'authorization_code', code, code_verifier: verifier,
    });
    if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) throw new Error('missing_refresh_token');
    response.writeHead(303, { Location: '/picker', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'Set-Cookie': 'picker=' + pickerNonce + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=600' }).end();
    return;
  }
  const authorizedPicker = request.headers.cookie?.split(/;\s*/).includes('picker=' + pickerNonce);
  if (request.method === 'GET' && url.pathname === '/picker' && tokens && !selectionUsed && authorizedPicker) {
    send(response, 200, pickerPage(tokens.access_token), 'text/html; charset=utf-8');
    return;
  }
  if (request.method === 'POST' && url.pathname === '/select' && tokens && !selectionUsed && authorizedPicker &&
      request.headers.origin === origin && request.headers['x-picker-nonce'] === pickerNonce) {
    selectionUsed = true;
    const headers = { Authorization: 'Bearer ' + tokens.access_token };
    const folder = await googleJson(await googleRequest(fetch, 'folder_access',
      DRIVE_URL + '/files/' + DRIVE_FOLDER + '?supportsAllDrives=true&fields=id,mimeType,capabilities(canAddChildren)',
      { headers }), 'folder_access');
    if (folder?.id !== DRIVE_FOLDER || folder.mimeType !== 'application/vnd.google-apps.folder' ||
        folder.capabilities?.canAddChildren !== true) throw new Error('folder_not_writable');
    const ids = await googleJson(await googleRequest(fetch, 'generate_id',
      DRIVE_URL + '/files/generateIds?count=1&space=drive', { headers }), 'generate_id');
    if (typeof ids?.ids?.[0] !== 'string' || !/^[A-Za-z0-9_-]+$/.test(ids.ids[0])) {
      throw new Error('invalid_file_id');
    }
    const settings = {
      GOOGLE_DRIVE_CLIENT_ID,
      GOOGLE_DRIVE_CLIENT_SECRET,
      GOOGLE_DRIVE_REFRESH_TOKEN: tokens.refresh_token,
      DRIVE_SMOKE_FILE_ID: ids.ids[0],
      DRIVE_SMOKE_TOKEN: randomBytes(32).toString('hex'),
    };
    if (Object.values(settings).some(value => /[\r\n"'#]/.test(value))) throw new Error('invalid_env_value');
    await writeFile(outputFile, Object.entries(settings).map(([key, value]) => key + '=' + value).join('\n') + '\n',
      { flag: 'wx', mode: 0o600 });
    send(response, 200, 'Доступ к папке подтверждён. Переменные для Preview сохранены в локальный .env.drive-preview.');
    stop();
    return;
  }
  send(response, 404, 'Not found.');
}

if (!GOOGLE_DRIVE_CLIENT_ID || !GOOGLE_DRIVE_CLIENT_SECRET || !GOOGLE_PICKER_API_KEY ||
    !/^\d+$/.test(GOOGLE_CLOUD_PROJECT_NUMBER ?? '')) {
  console.error('Set Google OAuth client, Picker API key and numeric Cloud project number.');
  process.exit(1);
}

const knownErrors = new Set(['missing_refresh_token', 'folder_not_writable', 'invalid_file_id', 'invalid_env_value']);
const server = createServer((request, response) => {
  handle(request, response).catch(error => {
    const stage = error.stage ?? (knownErrors.has(error.message) ? error.message : undefined);
    const description = stage ? stage + (error.status ? ' (HTTP ' + error.status + ')' : '') :
      error.code === 'EEXIST' ? 'Local .env.drive-preview already exists.' : 'Local setup failed.';
    send(response, 502, description);
    console.error(description);
    process.exitCode = 1;
    stop();
  });
});
const expiry = setTimeout(() => { process.exitCode = 1; stop(); }, 600_000);
function stop() {
  tokens = undefined;
  clearTimeout(expiry);
  server.close();
}
server.on('error', () => {
  console.error('Cannot listen on 127.0.0.1:53682.');
  process.exitCode = 1;
  stop();
});
server.listen(53682, '127.0.0.1', () => console.log('Open locally: ' + origin + '/start?key=' + startKey));
