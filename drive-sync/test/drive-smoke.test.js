import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler } from '../api/drive-smoke.js';
import { DRIVE_FOLDER, DRIVE_SCOPE, GOOGLE_TOKEN_URL } from '../lib/google-drive.js';

const env = {
  VERCEL_ENV: 'preview',
  DRIVE_SMOKE_TOKEN: 'a'.repeat(64),
  GOOGLE_DRIVE_CLIENT_ID: 'example-client',
  GOOGLE_DRIVE_CLIENT_SECRET: 'fake-client-secret',
  GOOGLE_DRIVE_REFRESH_TOKEN: 'fake-refresh-token',
  DRIVE_SMOKE_FILE_ID: 'test-file-id',
};

function incoming(authorization = 'Bearer ' + env.DRIVE_SMOKE_TOKEN) {
  return new Request('https://preview.example/api/drive-smoke', {
    method: 'POST', headers: { authorization },
  });
}

function google({ uploadStatus = 200, scope = DRIVE_SCOPE, parent = DRIVE_FOLDER, content, tokenStatus = 200, delay = false } = {}) {
  const calls = [];
  let uploadedPayload;
  return {
    calls,
    async request(url, options) {
      calls.push(url);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      if (url === GOOGLE_TOKEN_URL) {
        assert.equal(options.body.get('grant_type'), 'refresh_token');
        assert.equal(options.body.get('refresh_token'), env.GOOGLE_DRIVE_REFRESH_TOKEN);
        assert.equal(options.body.get('client_secret'), env.GOOGLE_DRIVE_CLIENT_SECRET);
        if (delay) throw new Error('fake-refresh-token');
        return Response.json({ access_token: 'fake-access-token', token_type: 'Bearer', scope }, { status: tokenStatus });
      }
      assert.equal(options.headers.Authorization, 'Bearer fake-access-token');
      if (url.includes('/upload/')) {
        assert.equal(options.method, 'POST');
        assert.match(options.headers['Content-Type'], /^multipart\/related; boundary=/);
        const [metadata, payload] = options.body.split('\r\n\r\n').slice(1);
        assert.deepEqual(JSON.parse(metadata.split('\r\n')[0]), {
          id: env.DRIVE_SMOKE_FILE_ID, name: 'garmin-drive-smoke.json', parents: [DRIVE_FOLDER], mimeType: 'application/json',
        });
        uploadedPayload = payload.split('\r\n')[0];
        assert.deepEqual(JSON.parse(uploadedPayload), { source: 'garmin-health-sync', test: true });
        return Response.json({}, { status: uploadStatus });
      }
      if (url.includes('alt=media')) return new Response(content ?? uploadedPayload);
      return Response.json({ id: env.DRIVE_SMOKE_FILE_ID, name: 'garmin-drive-smoke.json', mimeType: 'application/json',
        parents: [parent], trashed: false });
    },
  };
}

test('requires preview, independent authorization and complete configuration before contacting Google', async () => {
  const { request, calls } = google();
  assert.equal((await createHandler({ ...env, VERCEL_ENV: 'production' }, request)(incoming())).status, 404);
  assert.equal((await createHandler({ ...env, DRIVE_SMOKE_TOKEN: '' }, request)(incoming())).status, 404);
  assert.equal((await createHandler(env, request)(incoming('Bearer wrong'))).status, 401);
  assert.equal((await createHandler({ ...env, GOOGLE_DRIVE_REFRESH_TOKEN: '' }, request)(incoming())).status, 503);
  assert.deepEqual(calls, []);
});

for (const uploadStatus of [200, 409]) {
  test('verifies the same predetermined file after upload HTTP ' + uploadStatus, async () => {
    const { request, calls } = google({ uploadStatus });
    const response = await createHandler(env, request)(incoming());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      id: env.DRIVE_SMOKE_FILE_ID, folderId: DRIVE_FOLDER, verified: true, created: uploadStatus !== 409,
    });
    assert.equal(calls.length, 4);
  });
}

test('rejects a broader OAuth grant before touching Drive', async () => {
  const { request, calls } = google({ scope: 'https://www.googleapis.com/auth/drive' });
  const result = await createHandler(env, request)(incoming());
  assert.equal(result.status, 502);
  assert.deepEqual(await result.json(), { error: 'oauth_scope', upstreamStatus: 200 });
  assert.deepEqual(calls, [GOOGLE_TOKEN_URL]);
});

test('verifies the folder and exact payload even after a conflict', async () => {
  for (const [options, error] of [
    [{ parent: 'other-folder', uploadStatus: 409 }, 'drive_metadata_mismatch'],
    [{ content: '{}', uploadStatus: 409 }, 'drive_content_mismatch'],
    [{ uploadStatus: 404 }, 'drive_create'],
  ]) {
    const { request } = google(options);
    const result = await createHandler(env, request)(incoming());
    assert.equal(result.status, 502);
    assert.equal((await result.json()).error, error);
  }
});

test('returns a stage and status without exposing Google errors or credentials', async () => {
  for (const options of [{ tokenStatus: 400 }, { delay: true }]) {
    const { request } = google(options);
    const result = await createHandler(env, request)(incoming());
    assert.equal(result.status, 502);
    assert.deepEqual(await result.json(), { error: 'oauth_token', upstreamStatus: options.tokenStatus ?? 0 });
  }
});
