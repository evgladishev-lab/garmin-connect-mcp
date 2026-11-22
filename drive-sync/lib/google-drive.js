export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_FOLDER = '1UfCrah98vAD_buax5q99MqRpXJhoAgkB';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const DRIVE_URL = 'https://www.googleapis.com/drive/v3';
export const REQUEST_TIMEOUT = 7000;

export class GoogleRequestError extends Error {
  constructor(stage, status) {
    super(stage);
    this.stage = stage;
    this.status = status;
  }
}

export async function googleRequest(request, stage, url, options = {}, allowed = []) {
  let response;
  try {
    response = await request(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
  } catch {
    throw new GoogleRequestError(stage, 0);
  }
  if (!response.ok && !allowed.includes(response.status)) {
    await response.body?.cancel().catch(() => {});
    throw new GoogleRequestError(stage, response.status);
  }
  return response;
}

export async function googleJson(response, stage) {
  try {
    return await response.json();
  } catch {
    throw new GoogleRequestError(stage, response.status);
  }
}

export async function exchangeToken(request, params) {
  const response = await googleRequest(request, 'oauth_token', GOOGLE_TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams(params),
  }, [400, 401]);
  const tokens = await googleJson(response, 'oauth_token');
  if (!response.ok) {
    const renewal = params.grant_type === 'refresh_token' && tokens?.error === 'invalid_grant';
    throw new GoogleRequestError(renewal ? 'oauth_reauthorization_required' : 'oauth_token', response.status);
  }
  if (typeof tokens?.access_token !== 'string' || !tokens.access_token ||
      typeof tokens.token_type !== 'string' || tokens.token_type.toLowerCase() !== 'bearer' ||
      typeof tokens.scope !== 'string' || tokens.scope.trim() !== DRIVE_SCOPE) {
    throw new GoogleRequestError('oauth_scope', response.status);
  }
  return tokens;
}
