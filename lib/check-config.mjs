export function assertObject(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Config must be a JSON object with the keys from config.example.json.');
  }
}

export function readKeys(raw, keys, action) {
  assertObject(raw);
  const value = {};
  const missing = [];
  for (const key of keys) {
    const current = raw[key];
    if (typeof current !== 'string') {
      missing.push(key);
      continue;
    }
    const next = current.trim();
    if (!next || next.startsWith('PASTE_')) missing.push(key);
    else value[key] = next;
  }
  if (missing.length) {
    throw new Error(`Config is incomplete. ${action} Missing or placeholder: ${missing.join(', ')}.`);
  }
  return value;
}

export function assertFolderId(key, value) {
  if (/^https?:\/\//i.test(value) || value.includes('/folders/')) {
    throw new Error(
      `${key} must be the Drive folder id, not the full URL. Copy the id after /folders/ in the address bar.`,
    );
  }
  if (/[\s'"]/.test(value)) {
    throw new Error(`${key} must be a Drive folder id with no spaces or quotes.`);
  }
}

export function driveQuery(folderId) {
  const escaped = folderId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `'${escaped}' in parents and mimeType = 'application/pdf' and trashed = false`;
}

export function checkOAuthClient(raw) {
  return readKeys(
    raw,
    ['client_id', 'client_secret'],
    'Set client_id and client_secret in config.json.',
  );
}

export function checkConfig(raw) {
  const value = readKeys(
    raw,
    ['client_id', 'client_secret', 'refresh_token', 'folder_in', 'folder_out'],
    'Fill config.json and run node scripts/apply-config.mjs, or paste the five values into the Config node.',
  );
  assertFolderId('folder_in', value.folder_in);
  assertFolderId('folder_out', value.folder_out);
  return {
    ...value,
    drive_query: driveQuery(value.folder_in),
  };
}
