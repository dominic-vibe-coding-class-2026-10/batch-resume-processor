export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const OAUTH_REDIRECT_URI = 'http://127.0.0.1:53682/callback';
export const OAUTH_PORT = 53682;

export function buildAuthUrl({ clientId, redirectUri, state, scope = GOOGLE_DRIVE_SCOPE }) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scope);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return url.toString();
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function exchangeAuthCode({ clientId, clientSecret, code, redirectUri, fetchImpl }) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json();
  if (!response.ok) {
    const reason = payload.error_description || payload.error || `HTTP ${response.status}`;
    throw new Error(`Google token exchange failed: ${reason}`);
  }
  if (typeof payload.refresh_token !== 'string' || !payload.refresh_token) {
    throw new Error(
      'Google did not return a refresh_token. Run the consent screen again and approve access.',
    );
  }
  return payload.refresh_token;
}

export function withRefreshToken(config, refreshToken) {
  return { ...config, refresh_token: refreshToken };
}
