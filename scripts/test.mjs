import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { applyConfigValues } from '../lib/apply-config.mjs';
import { checkConfig, checkOAuthClient, driveQuery } from '../lib/check-config.mjs';
import { collectFiles } from '../lib/collect-files.mjs';
import { UPLOAD_BOUNDARY, buildMultipart } from '../lib/multipart.mjs';
import {
  OAUTH_REDIRECT_URI,
  buildAuthUrl,
  escapeHtml,
  exchangeAuthCode,
  withRefreshToken,
} from '../lib/oauth.mjs';
import {
  aggregateResumes,
  asMessage,
  emptyFolderReport,
  lookupFile,
  readReportText,
  shapedResume,
  skippedResume,
  stripSecrets,
} from '../lib/resume-report.mjs';
import { buildWorkflow, writeWorkflow } from './build-workflow.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflowPath = resolve(root, 'workflows/batch-resume-processor.json');

const validConfig = {
  client_id: 'client-id.apps.googleusercontent.com',
  client_secret: 'client-secret-value',
  refresh_token: '1//refresh-token-value',
  folder_in: 'folderIn123',
  folder_out: 'folderOut456',
};

function nodeByName(workflow, name) {
  const node = workflow.nodes.find((item) => item.name === name);
  assert.ok(node, `missing node ${name}`);
  return node;
}

async function runCodeWithThis(jsCode, context, thisValue = {}) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('$input', '$', '$now', '$itemIndex', jsCode);
  return fn.call(thisValue, context.$input, context.$, context.$now, context.$itemIndex);
}

test('checkConfig accepts a complete config and builds the Drive query', () => {
  const checked = checkConfig(validConfig);
  assert.equal(checked.folder_in, 'folderIn123');
  assert.equal(checked.drive_query, driveQuery('folderIn123'));
  assert.equal(
    checked.drive_query,
    "'folderIn123' in parents and mimeType = 'application/pdf' and trashed = false",
  );
  assert.equal(driveQuery("a\\b'c"), "'a\\\\b\\'c' in parents and mimeType = 'application/pdf' and trashed = false");
});

test('checkConfig rejects blanks, placeholders, and folder URLs', () => {
  assert.throws(() => checkConfig({ ...validConfig, refresh_token: '   ' }), /refresh_token/);
  assert.throws(() => checkConfig({ ...validConfig, client_id: 'PASTE_CLIENT_ID' }), /client_id/);
  assert.throws(
    () => checkConfig({ ...validConfig, folder_in: 'https://drive.google.com/drive/folders/abc' }),
    /folder id/,
  );
  assert.throws(() => checkConfig({ ...validConfig, folder_out: 12 }), /folder_out/);
  assert.throws(() => checkOAuthClient({ client_id: '', client_secret: 'secret' }), /client_id/);
});

test('collectFiles flattens pages, drops non-PDFs, and dedupes', () => {
  const collected = collectFiles([
    {
      files: [
        { id: 'b', name: 'b.pdf', mimeType: 'application/pdf' },
        { id: 'a', name: 'A 10.pdf', mimeType: 'application/pdf' },
        { id: 'note', name: 'notes.txt', mimeType: 'text/plain' },
      ],
    },
    {
      files: [
        { id: 'b', name: 'b.pdf', mimeType: 'application/pdf' },
        { id: 'a2', name: 'A 2.pdf', mimeType: 'application/pdf' },
        { id: '   ', name: 'blank.pdf', mimeType: 'application/pdf' },
      ],
    },
    { files: [] },
    {},
  ]);
  assert.deepEqual(
    collected.files.map((file) => file.name),
    ['A 2.pdf', 'A 10.pdf', 'b.pdf'],
  );
  assert.equal(collected.count, 3);
  assert.deepEqual(collectFiles([]), { files: [], count: 0 });
});

test('report rows keep file names and redact bearer tokens in errors', () => {
  const leaked = 'Authorization: Bearer ya29.abcDEF-123 failed';
  assert.match(stripSecrets(leaked), /Bearer \[redacted\]/);
  assert.doesNotMatch(stripSecrets(leaked), /ya29/);
  const skipped = skippedResume({
    fileName: 'ada-ng.pdf',
    fileId: 'file-1',
    download: { error: { message: leaked } },
    extracted: null,
  });
  assert.match(skipped.output, /Could not download/);
  assert.doesNotMatch(skipped.output, /ya29/);
  assert.equal(
    skippedResume({ fileName: 'scan.pdf', fileId: 'file-2', download: { id: 'file-2' }, extracted: { text: '' } }).output,
    'No text could be extracted from this PDF. It may be scanned or image-only.',
  );
  const shaped = shapedResume({
    fileName: 'ada-ng.pdf',
    fileId: 'file-1',
    incoming: { output: 'Name:\nAda Ng\nEducation:\nNot found\nWorking experience:\nNot found' },
  });
  assert.match(shaped.output, /Ada Ng/);
  assert.match(
    shapedResume({ fileName: 'ada-ng.pdf', fileId: 'file-1', incoming: { error: 'model down' } }).output,
    /model down/,
  );
  assert.equal(asMessage('x'.repeat(800)).length, 500);

  const report = aggregateResumes([shaped, skipped], '2026-11-26 14:10 HKT');
  assert.match(report.output, /Files: 2/);
  assert.match(report.output, /===== ada-ng.pdf =====/);
  assert.match(report.output, /Drive file id: file-1/);
  assert.match(emptyFolderReport('2026-11-26 14:10 HKT').output, /Files: 0/);
});

test('lookupFile skips broken paired items and readReportText uses the branch that ran', () => {
  const found = lookupFile((name) => {
    if (name === 'Split Out') throw new Error('not paired');
    if (name === 'Download PDF') return { name: 'ada-ng.pdf', id: 'file-1' };
    return {};
  });
  assert.deepEqual(found, { fileName: 'ada-ng.pdf', fileId: 'file-1' });

  const text = readReportText((name) => {
    if (name === 'Aggregate Output') throw new Error('not executed');
    if (name === 'Empty Result') return 'empty report';
    throw new Error(name);
  });
  assert.equal(text, 'empty report');
  assert.throws(() => readReportText(() => {
    throw new Error('nope');
  }), /No aggregated resume text/);
});

test('multipart body carries metadata and the report text', () => {
  const built = buildMultipart({
    text: 'Name:\nAda Ng\n',
    folderOut: 'folderOut456',
    boundary: UPLOAD_BOUNDARY,
  });
  assert.equal(built.fileName, 'result.txt');
  assert.equal(built.contentType, `multipart/related; boundary=${UPLOAD_BOUNDARY}`);
  const parts = built.payload.split(`--${UPLOAD_BOUNDARY}`);
  const metadata = JSON.parse(parts[1].split('\r\n\r\n')[1].trim());
  assert.deepEqual(metadata, {
    name: 'result.txt',
    parents: ['folderOut456'],
    mimeType: 'text/plain',
  });
  assert.match(parts[2], /Ada Ng/);
  assert.throws(
    () => buildMultipart({ text: `bad ${UPLOAD_BOUNDARY}`, folderOut: 'folderOut456', boundary: UPLOAD_BOUNDARY }),
    /boundary/,
  );
});

test('oauth URL requests offline drive access and the exchange keeps secrets out of errors', async () => {
  const url = new URL(buildAuthUrl({
    clientId: 'client-id',
    redirectUri: OAUTH_REDIRECT_URI,
    state: 'state-1',
  }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('redirect_uri'), OAUTH_REDIRECT_URI);
  assert.equal(url.searchParams.get('state'), 'state-1');
  assert.equal(escapeHtml('<tag&>'), '&lt;tag&amp;&gt;');

  const refresh = await exchangeAuthCode({
    clientId: 'client-id',
    clientSecret: 'super-secret',
    code: 'auth-code',
    redirectUri: OAUTH_REDIRECT_URI,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ refresh_token: '1//new-refresh' }),
    }),
  });
  assert.equal(refresh, '1//new-refresh');
  assert.equal(withRefreshToken({ client_id: 'client-id' }, refresh).refresh_token, refresh);

  await assert.rejects(
    () => exchangeAuthCode({
      clientId: 'client-id',
      clientSecret: 'super-secret',
      code: 'auth-code',
      redirectUri: OAUTH_REDIRECT_URI,
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant', error_description: 'bad code' }),
      }),
    }),
    (error) => {
      assert.match(error.message, /bad code/);
      assert.doesNotMatch(error.message, /super-secret/);
      return true;
    },
  );
});

test('the workflow connects the manifest nodes and keeps secrets out of the template', async () => {
  const workflow = buildWorkflow();
  await writeWorkflow(workflowPath);
  const saved = JSON.parse(await readFile(workflowPath, 'utf8'));
  assert.equal(saved.name, 'Batch Resume Processor');
  assert.equal(saved.active, false);
  assert.equal(saved.settings.executionOrder, 'v1');

  const names = new Set(saved.nodes.map((node) => node.name));
  for (const required of [
    'Manual Trigger',
    'Config',
    'Get Access Token',
    'List PDFs',
    'Split Out',
    'Loop Over Items',
    'Download PDF',
    'Extract from File',
    'AI Agent',
    'Ollama Chat Model',
    'Aggregate Output',
    'Convert to File',
    'Upload result.txt',
  ]) {
    assert.ok(names.has(required), required);
  }

  const config = nodeByName(saved, 'Config');
  const assignments = Object.fromEntries(config.parameters.assignments.assignments.map((row) => [row.name, row.value]));
  assert.deepEqual(assignments, {
    client_id: '',
    client_secret: '',
    refresh_token: '',
    folder_in: '',
    folder_out: '',
  });

  assert.equal(nodeByName(saved, 'Get Access Token').parameters.url, 'https://oauth2.googleapis.com/token');
  assert.equal(
    nodeByName(saved, 'Get Access Token').parameters.bodyParameters.parameters.find((row) => row.name === 'grant_type').value,
    'refresh_token',
  );
  const list = nodeByName(saved, 'List PDFs');
  assert.equal(list.parameters.url, 'https://www.googleapis.com/drive/v3/files');
  assert.equal(list.parameters.queryParameters.parameters.find((row) => row.name === 'fields').value, 'files(id,name,mimeType),nextPageToken');
  const download = nodeByName(saved, 'Download PDF');
  assert.equal(download.parameters.queryParameters.parameters.find((row) => row.name === 'alt').value, 'media');
  assert.equal(download.parameters.options.response.response.responseFormat, 'file');
  const upload = nodeByName(saved, 'Upload result.txt');
  assert.equal(upload.parameters.url, 'https://www.googleapis.com/upload/drive/v3/files');
  assert.equal(upload.parameters.queryParameters.parameters.find((row) => row.name === 'uploadType').value, 'multipart');
  assert.equal(
    upload.parameters.headerParameters.parameters.find((row) => row.name === 'Content-Type').value,
    `multipart/related; boundary=${UPLOAD_BOUNDARY}`,
  );
  assert.equal(nodeByName(saved, 'Ollama Chat Model').parameters.model, 'kimi-k3.1-pro');
  assert.match(nodeByName(saved, 'AI Agent').parameters.options.systemMessage, /Name:/);
  assert.match(nodeByName(saved, 'AI Agent').parameters.options.systemMessage, /Education:/);
  assert.match(nodeByName(saved, 'AI Agent').parameters.options.systemMessage, /Working experience:/);
  assert.equal(nodeByName(saved, 'Convert to File').parameters.options.fileName, 'result.txt');
  assert.equal(nodeByName(saved, 'Extract from File').parameters.options.joinPages, true);
  assert.equal(nodeByName(saved, 'Extract from File').parameters.options.keepSource, 'json');

  assert.equal(saved.connections['Loop Over Items'].main[0][0].node, 'Aggregate Output');
  assert.equal(saved.connections['Loop Over Items'].main[1][0].node, 'Download PDF');
  assert.equal(saved.connections['Shape Result'].main[0][0].node, 'Loop Over Items');
  assert.equal(saved.connections['Skipped Resume'].main[0][0].node, 'Loop Over Items');
  assert.equal(saved.connections['Has PDFs'].main[0][0].node, 'Split Out');
  assert.equal(saved.connections['Has PDFs'].main[1][0].node, 'Empty Result');
  assert.equal(saved.connections['Has Text'].main[0][0].node, 'AI Agent');
  assert.equal(saved.connections['Has Text'].main[1][0].node, 'Skipped Resume');
  assert.equal(saved.connections['Ollama Chat Model'].ai_languageModel[0][0].node, 'AI Agent');
  assert.equal(saved.connections['Ollama Chat Model'].ai_languageModel[0][0].type, 'ai_languageModel');

  const incoming = new Set();
  for (const [from, outputs] of Object.entries(saved.connections)) {
    assert.ok(names.has(from), from);
    for (const [type, groups] of Object.entries(outputs)) {
      for (const group of groups) {
        for (const link of group) {
          assert.ok(names.has(link.node), link.node);
          assert.equal(link.type, type);
          incoming.add(link.node);
        }
      }
    }
  }
  for (const node of saved.nodes) {
    if (node.type === 'n8n-nodes-base.stickyNote') continue;
    if (node.name === 'Manual Trigger' || node.name === 'Ollama Chat Model') continue;
    assert.ok(incoming.has(node.name), `${node.name} has no incoming connection`);
  }

  const referenced = JSON.stringify(saved).matchAll(/\$\('([^']+)'\)/g);
  for (const match of referenced) assert.ok(names.has(match[1]), match[1]);

  for (const node of saved.nodes) {
    if (node.type !== 'n8n-nodes-base.code') continue;
    new vm.Script(`async function run() {\n${node.parameters.jsCode}\n}`);
  }

  const serialized = JSON.stringify(saved);
  assert.doesNotMatch(serialized, /ya29\./);
  assert.doesNotMatch(serialized, /1\/\/0/);
  assert.equal(workflow.nodes.length, saved.nodes.length);
});

test('code nodes run with the same helpers n8n will call', async () => {
  const workflow = buildWorkflow();
  const code = (name) => nodeByName(workflow, name).parameters.jsCode;
  const now = { setZone: () => ({ toFormat: () => '2026-11-26 14:10' }) };

  const checked = await runCodeWithThis(code('Check Config'), {
    $input: { first: () => ({ json: validConfig }) },
  });
  assert.equal(checked[0].json.drive_query, driveQuery(validConfig.folder_in));
  await assert.rejects(() => runCodeWithThis(code('Check Config'), {
    $input: { first: () => ({ json: { ...validConfig, folder_out: '' } }) },
  }), /folder_out/);

  const collected = await runCodeWithThis(code('Collect Files'), {
    $input: {
      all: () => [
        { json: { files: [{ id: 'b', name: 'b.pdf', mimeType: 'application/pdf' }] } },
        { json: { files: [{ id: 'a', name: 'a.pdf', mimeType: 'application/pdf' }] } },
      ],
    },
  });
  assert.deepEqual(collected[0].json.files.map((file) => file.id), ['a', 'b']);

  const empty = await runCodeWithThis(code('Empty Result'), { $now: now });
  assert.match(empty[0].json.output, /2026-11-26 14:10 HKT/);
  assert.match(empty[0].json.output, /Files: 0/);

  const nodes = {
    'Split Out': { name: 'ada-ng.pdf', id: 'file-1' },
    'Download PDF': { error: { message: 'Bearer ya29.secret-token denied' } },
    'Extract from File': { error: 'no binary' },
  };
  const skipped = await runCodeWithThis(code('Skipped Resume'), {
    $input: { item: { json: { error: 'no binary' } } },
    $: (name) => ({ item: { json: nodes[name] } }),
    $itemIndex: 0,
  });
  assert.equal(skipped[0].json.fileName, 'ada-ng.pdf');
  assert.match(skipped[0].json.output, /Could not download/);
  assert.doesNotMatch(skipped[0].json.output, /ya29/);

  const shaped = await runCodeWithThis(code('Shape Result'), {
    $input: { item: { json: { output: 'Name:\nAda Ng' } } },
    $: (name) => ({ item: { json: name === 'Split Out' ? { name: 'ada-ng.pdf', id: 'file-1' } : {} } }),
    $itemIndex: 0,
  });
  assert.equal(shaped[0].json.output, 'Name:\nAda Ng');

  const aggregate = await runCodeWithThis(code('Aggregate Output'), {
    $input: { all: () => [{ json: shaped[0].json }, { json: skipped[0].json }] },
    $now: now,
  });
  assert.match(aggregate[0].json.output, /Files: 2/);
  assert.match(aggregate[0].json.output, /ada-ng.pdf/);

  const built = await runCodeWithThis(
    code('Build Multipart Upload'),
    {
      $: (name) => {
        if (name === 'Aggregate Output') return { first: () => ({ json: aggregate[0].json }) };
        if (name === 'Check Config') return { first: () => ({ json: checked[0].json }) };
        throw new Error(`${name} did not run`);
      },
    },
    {
      helpers: {
        prepareBinaryData: async (buffer, fileName, mimeType) => ({
          data: Buffer.from(buffer).toString('base64'),
          fileName,
          mimeType,
        }),
      },
    },
  );
  const payload = Buffer.from(built[0].binary.data.data, 'base64').toString('utf8');
  assert.match(payload, /"parents":\["folderOut456"\]/);
  assert.match(payload, /Name:\\nAda Ng|Name:\nAda Ng/);
  assert.equal(built[0].binary.data.mimeType, `multipart/related; boundary=${UPLOAD_BOUNDARY}`);
});

test('apply-config writes secrets only onto the Config node of a local copy', async () => {
  const workflow = buildWorkflow();
  const local = applyConfigValues(workflow, validConfig);
  const config = nodeByName(local, 'Config');
  const values = Object.fromEntries(config.parameters.assignments.assignments.map((row) => [row.name, row.value]));
  assert.equal(values.client_secret, validConfig.client_secret);
  assert.equal(values.refresh_token, validConfig.refresh_token);
  const withoutConfig = {
    ...local,
    nodes: local.nodes.filter((node) => node.name !== 'Config'),
  };
  const leaked = JSON.stringify(withoutConfig);
  assert.equal(leaked.includes(validConfig.client_secret), false);
  assert.equal(leaked.includes(validConfig.refresh_token), false);

  const directory = await mkdtemp(resolve(tmpdir(), 'resume-config-'));
  const configPath = resolve(directory, 'config.json');
  const sourcePath = resolve(directory, 'workflow.json');
  const targetPath = resolve(directory, 'local.json');
  await writeFile(configPath, `${JSON.stringify(validConfig, null, 2)}\n`);
  await writeFile(sourcePath, `${JSON.stringify(workflow)}\n`);
  const applied = applyConfigValues(
    JSON.parse(await readFile(sourcePath, 'utf8')),
    JSON.parse(await readFile(configPath, 'utf8')),
  );
  await writeFile(targetPath, `${JSON.stringify(applied)}\n`);
  const roundTrip = JSON.parse(await readFile(targetPath, 'utf8'));
  assert.equal(nodeByName(roundTrip, 'Config').parameters.assignments.assignments[2].value, validConfig.refresh_token);
});
