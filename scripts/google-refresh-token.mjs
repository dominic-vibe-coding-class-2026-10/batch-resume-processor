import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkOAuthClient } from '../lib/check-config.mjs';
import {
  OAUTH_PORT,
  OAUTH_REDIRECT_URI,
  buildAuthUrl,
  escapeHtml,
  exchangeAuthCode,
  withRefreshToken,
} from '../lib/oauth.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = resolve(root, 'config.json');

function page(title, message) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
}

function send(response, status, title, message) {
  const body = page(title, message);
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

let config;
try {
  config = JSON.parse(await readFile(configPath, 'utf8'));
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error('Copy config-template.json to config.json and set client_id and client_secret.');
    process.exit(1);
  }
  throw error;
}
const client = checkOAuthClient(config);
const state = randomBytes(16).toString('hex');
const authUrl = buildAuthUrl({
  clientId: client.client_id,
  redirectUri: OAUTH_REDIRECT_URI,
  state,
});

const code = await new Promise((resolveCode, reject) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', OAUTH_REDIRECT_URI);
    if (url.pathname !== '/callback') {
      send(response, 404, 'Not found', 'This page is only the OAuth callback.');
      return;
    }
    const receivedState = url.searchParams.get('state') || '';
    const oauthError = url.searchParams.get('error');
    if (oauthError) {
      send(response, 400, 'Google did not grant access', oauthError);
      server.close();
      reject(new Error(`Google authorization was not granted (${oauthError}).`));
      return;
    }
    if (receivedState !== state) {
      send(response, 400, 'Authorization failed', 'The login response did not match this script.');
      server.close();
      reject(new Error('OAuth state did not match. Run the script again.'));
      return;
    }
    const authCode = url.searchParams.get('code');
    if (!authCode) {
      send(response, 400, 'Authorization failed', 'Google did not include a code.');
      server.close();
      reject(new Error('Google did not return an authorization code.'));
      return;
    }
    send(response, 200, 'Refresh token saved', 'You can close this tab and return to the terminal.');
    server.close();
    resolveCode(authCode);
  });

  server.on('error', (error) => {
    reject(error.code === 'EADDRINUSE'
      ? new Error(`Port ${OAUTH_PORT} is already in use. Stop the other process and run this script again.`)
      : error);
  });

  const timer = setTimeout(() => {
    server.close();
    reject(new Error('Timed out waiting for Google to redirect back. Run the script again.'));
  }, 180000);
  timer.unref();

  server.listen(OAUTH_PORT, '127.0.0.1', () => {
    console.log('Open this URL in a browser, sign in with the Google account that can read the resume folder, and approve access:');
    console.log(authUrl);
    console.log(`Waiting on ${OAUTH_REDIRECT_URI}`);
    const opener = spawn('xdg-open', [authUrl], { stdio: 'ignore', detached: true });
    opener.on('error', () => {});
    opener.unref();
  });
});

const refreshToken = await exchangeAuthCode({
  clientId: client.client_id,
  clientSecret: client.client_secret,
  code,
  redirectUri: OAUTH_REDIRECT_URI,
  fetchImpl: globalThis.fetch,
});

const next = withRefreshToken(config, refreshToken);
await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`);
console.log('Saved refresh_token to config.json');
console.log('Add folder_in and folder_out if they are empty, then run node scripts/apply-config.mjs');
