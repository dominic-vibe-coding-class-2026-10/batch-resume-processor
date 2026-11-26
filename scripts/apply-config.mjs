import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyConfigValues } from '../lib/apply-config.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = resolve(root, 'config.json');
const workflowPath = resolve(root, 'workflows/batch-resume-processor.json');
const localPath = resolve(root, 'workflows/batch-resume-processor.local.json');

let config;
try {
  config = JSON.parse(await readFile(configPath, 'utf8'));
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error('Copy n8n-resume-processor/config.example.json to n8n-resume-processor/config.json and fill it in.');
    process.exit(1);
  }
  throw error;
}
const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
const local = applyConfigValues(workflow, config);
await writeFile(localPath, `${JSON.stringify(local, null, 2)}\n`);
console.log('Wrote n8n-resume-processor/workflows/batch-resume-processor.local.json');
console.log('Import that file into n8n. It contains the OAuth client secret and refresh token.');
