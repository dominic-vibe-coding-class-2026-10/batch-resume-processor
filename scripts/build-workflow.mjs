import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertFolderId, assertObject, checkConfig, driveQuery, readKeys } from '../lib/check-config.mjs';
import { collectFiles } from '../lib/collect-files.mjs';
import { UPLOAD_BOUNDARY, buildMultipart } from '../lib/multipart.mjs';
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

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflowPath = resolve(root, 'workflows/batch-resume-processor.json');

const SYSTEM_MESSAGE = `You extract three facts from one resume. Use only the resume text. Do not guess, and do not use tools.

Return plain text with these headings, in this order:
Name:
Education:
Working experience:

Rules:
- Keep personal names, school names, and employer names in the script used on the resume. Do not translate them.
- Keep the headings in English even when the resume is in Chinese.
- Education: one line per credential, with the institution and dates when the resume includes them.
- Working experience: one line per role, with the employer, title, and dates when the resume includes them.
- If a section is missing, write "Not found" under that heading.
- Do not add a preamble, a closing remark, or markdown fences.`;

function expr(expression) {
  return `={{ ${expression} }}`;
}

function embed(functions, body) {
  const header = functions.map((fn) => fn.toString()).join('\n\n');
  return `// Generated from n8n-resume-processor/lib. Edit the lib, then run scripts/build-workflow.mjs.\n${header}\n\n${body.trim()}\n`;
}

function codeNode({ id, name, position, mode, jsCode }) {
  return {
    parameters: {
      mode,
      language: 'javaScript',
      jsCode,
    },
    id,
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
  };
}

function httpNode({ id, name, position, parameters, onError }) {
  const node = {
    parameters: {
      authentication: 'none',
      ...parameters,
      options: parameters.options || {},
    },
    id,
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
  };
  if (onError) node.onError = onError;
  return node;
}

function sticky({ id, name, position, content, width, height, color }) {
  return {
    parameters: {
      content,
      width,
      height,
      color,
    },
    id,
    name,
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position,
  };
}

const generatedAtHelper = `function generatedAtHKT() {
  try {
    return $now.setZone('Asia/Hong_Kong').toFormat('yyyy-LL-dd HH:mm') + ' HKT';
  } catch (error) {
    return new Date().toISOString();
  }
}`;

const fileLookupHelper = `function fileIdentity(incoming) {
  const found = lookupFile((nodeName) => $(nodeName).item.json);
  let fallback = 'unknown.pdf';
  try {
    if (typeof $itemIndex === 'number') fallback = 'resume-' + ($itemIndex + 1) + '.pdf';
  } catch (error) {
    fallback = 'unknown.pdf';
  }
  const incomingName = incoming && typeof incoming.name === 'string' ? incoming.name.trim() : '';
  const incomingId = incoming && typeof incoming.id === 'string' ? incoming.id.trim() : '';
  return {
    fileName: found.fileName || incomingName || fallback,
    fileId: found.fileId || incomingId,
  };
}

function nodeJson(nodeName) {
  try {
    return $(nodeName).item.json;
  } catch (error) {
    return null;
  }
}`;

export function buildWorkflow() {
  const bearer = expr(" 'Bearer ' + $('Get Access Token').first().json.access_token ".trim());
  const nodes = [
    sticky({
      id: 'b1e0a001-0001-4001-8001-000000000001',
      name: 'Note: Setup',
      position: [-80, 80],
      width: 1880,
      height: 340,
      color: 4,
      content: `## Setup
Paste the five values into **Config**, or import \`batch-resume-processor.local.json\` from \`scripts/apply-config.mjs\`.

The refresh token needs the scope \`https://www.googleapis.com/auth/drive\`. \`drive.file\` cannot see PDFs already in the folder.

\`folder_in\` and \`folder_out\` are folder ids, the segment after \`/folders/\` in the Drive URL. Each run creates a new \`result.txt\` in the output folder. An access token lasts about one hour.`,
    }),
    sticky({
      id: 'b1e0a001-0001-4001-8001-000000000002',
      name: 'Note: Loop',
      position: [1880, 760],
      width: 2280,
      height: 280,
      color: 5,
      content: `## One PDF at a time
**Loop Over Items** (batch size 1) downloads a PDF, extracts its text, and asks the Ollama agent for Name, Education, and Working experience.

Connect **Shape Result** and **Skipped Resume** back into **Loop Over Items**. The top output of the loop fires after every file has been sent back.

Image-only PDFs and download errors are recorded in the report. The other files still run.`,
    }),
    sticky({
      id: 'b1e0a001-0001-4001-8001-000000000003',
      name: 'Note: Ollama',
      position: [3320, 1280],
      width: 420,
      height: 260,
      color: 6,
      content: `## Ollama
Select the existing **Ollama account** credential.

Model: \`kimi-k3.1-pro\`. Context length is 8192 tokens. Raise **Context Length** on this node for a very long resume.

If n8n is in Docker and Ollama is on the host, set the credential base URL to \`http://host.docker.internal:11434\`.`,
    }),
    sticky({
      id: 'b1e0a001-0001-4001-8001-000000000004',
      name: 'Note: Upload',
      position: [2100, 1560],
      width: 1680,
      height: 200,
      color: 3,
      content: `## result.txt
**Convert to File** writes the report as \`result.txt\`. Drive's multipart upload also needs a JSON metadata part, which **Build Multipart Upload** adds around that same text.

The POST goes to \`uploadType=multipart\` with the access token from the start of the run. No Google Drive credential is stored in n8n.`,
    }),
    {
      parameters: {},
      id: 'b1e0a001-0001-4001-8001-000000000101',
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [0, 520],
    },
    {
      parameters: {
        mode: 'manual',
        includeOtherFields: false,
        assignments: {
          assignments: [
            { id: 'cfg-client-id', name: 'client_id', value: '', type: 'string' },
            { id: 'cfg-client-secret', name: 'client_secret', value: '', type: 'string' },
            { id: 'cfg-refresh-token', name: 'refresh_token', value: '', type: 'string' },
            { id: 'cfg-folder-in', name: 'folder_in', value: '', type: 'string' },
            { id: 'cfg-folder-out', name: 'folder_out', value: '', type: 'string' },
          ],
        },
        options: {},
      },
      id: 'b1e0a001-0001-4001-8001-000000000102',
      name: 'Config',
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [260, 520],
    },
    codeNode({
      id: 'b1e0a001-0001-4001-8001-000000000103',
      name: 'Check Config',
      position: [520, 520],
      mode: 'runOnceForAllItems',
      jsCode: embed(
        [assertObject, readKeys, assertFolderId, driveQuery, checkConfig],
        `const checked = checkConfig($input.first().json);
return [{ json: checked }];`,
      ),
    }),
    httpNode({
      id: 'b1e0a001-0001-4001-8001-000000000104',
      name: 'Get Access Token',
      position: [800, 520],
      parameters: {
        method: 'POST',
        url: 'https://oauth2.googleapis.com/token',
        sendBody: true,
        contentType: 'form-urlencoded',
        specifyBody: 'keypair',
        bodyParameters: {
          parameters: [
            { name: 'client_id', value: expr('$json.client_id') },
            { name: 'client_secret', value: expr('$json.client_secret') },
            { name: 'refresh_token', value: expr('$json.refresh_token') },
            { name: 'grant_type', value: 'refresh_token' },
          ],
        },
        options: { timeout: 30000 },
      },
    }),
    httpNode({
      id: 'b1e0a001-0001-4001-8001-000000000105',
      name: 'List PDFs',
      position: [1100, 520],
      parameters: {
        method: 'GET',
        url: 'https://www.googleapis.com/drive/v3/files',
        sendQuery: true,
        specifyQuery: 'keypair',
        queryParameters: {
          parameters: [
            { name: 'q', value: expr("$('Check Config').first().json.drive_query") },
            { name: 'fields', value: 'files(id,name,mimeType),nextPageToken' },
            { name: 'pageSize', value: '1000' },
            { name: 'orderBy', value: 'name' },
            { name: 'supportsAllDrives', value: 'true' },
            { name: 'includeItemsFromAllDrives', value: 'true' },
          ],
        },
        sendHeaders: true,
        specifyHeaders: 'keypair',
        headerParameters: {
          parameters: [{ name: 'Authorization', value: bearer }],
        },
        options: {
          timeout: 60000,
          pagination: {
            pagination: {
              paginationMode: 'updateAParameterInEachRequest',
              parameters: {
                parameters: [
                  {
                    type: 'qs',
                    name: 'pageToken',
                    value: expr('$response.body?.nextPageToken'),
                  },
                ],
              },
              paginationCompleteWhen: 'other',
              completeExpression: expr('!$response.body?.nextPageToken'),
              limitPagesFetched: true,
              maxRequests: 20,
            },
          },
        },
      },
    }),
    codeNode({
      id: 'b1e0a001-0001-4001-8001-000000000106',
      name: 'Collect Files',
      position: [1400, 520],
      mode: 'runOnceForAllItems',
      jsCode: embed(
        [collectFiles],
        `const pages = $input.all().map((item) => item.json);
const collected = collectFiles(pages);
return [{ json: collected }];`,
      ),
    }),
    {
      parameters: {
        conditions: {
          options: {
            caseSensitive: true,
            leftValue: '',
            typeValidation: 'loose',
            version: 2,
          },
          conditions: [
            {
              id: 'cond-has-pdfs',
              leftValue: expr('$json.count'),
              rightValue: 0,
              operator: { type: 'number', operation: 'gt' },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
      id: 'b1e0a001-0001-4001-8001-000000000107',
      name: 'Has PDFs',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [1680, 520],
    },
    codeNode({
      id: 'b1e0a001-0001-4001-8001-000000000108',
      name: 'Empty Result',
      position: [1680, 820],
      mode: 'runOnceForAllItems',
      jsCode: embed(
        [emptyFolderReport],
        `${generatedAtHelper}

return [{ json: emptyFolderReport(generatedAtHKT()) }];`,
      ),
    }),
    {
      parameters: {
        fieldToSplitOut: 'files',
        include: 'noOtherFields',
        options: {},
      },
      id: 'b1e0a001-0001-4001-8001-000000000109',
      name: 'Split Out',
      type: 'n8n-nodes-base.splitOut',
      typeVersion: 1,
      position: [2100, 1100],
    },
    {
      parameters: {
        batchSize: 1,
        options: {},
      },
      id: 'b1e0a001-0001-4001-8001-000000000110',
      name: 'Loop Over Items',
      type: 'n8n-nodes-base.splitInBatches',
      typeVersion: 3,
      position: [2380, 1100],
    },
    httpNode({
      id: 'b1e0a001-0001-4001-8001-000000000111',
      name: 'Download PDF',
      position: [2700, 1100],
      onError: 'continueRegularOutput',
      parameters: {
        method: 'GET',
        url: expr("'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent($json.id)"),
        sendQuery: true,
        specifyQuery: 'keypair',
        queryParameters: {
          parameters: [
            { name: 'alt', value: 'media' },
            { name: 'supportsAllDrives', value: 'true' },
          ],
        },
        sendHeaders: true,
        specifyHeaders: 'keypair',
        headerParameters: {
          parameters: [{ name: 'Authorization', value: bearer }],
        },
        options: {
          timeout: 120000,
          response: {
            response: {
              responseFormat: 'file',
              outputPropertyName: 'data',
            },
          },
        },
      },
    }),
    {
      parameters: {
        operation: 'pdf',
        binaryPropertyName: 'data',
        options: {
          joinPages: true,
          keepSource: 'json',
        },
      },
      id: 'b1e0a001-0001-4001-8001-000000000112',
      name: 'Extract from File',
      type: 'n8n-nodes-base.extractFromFile',
      typeVersion: 1.1,
      position: [3020, 1100],
      onError: 'continueRegularOutput',
    },
    {
      parameters: {
        conditions: {
          options: {
            caseSensitive: true,
            leftValue: '',
            typeValidation: 'loose',
            version: 2,
          },
          conditions: [
            {
              id: 'cond-has-text',
              leftValue: expr("typeof $json.text === 'string' ? $json.text.trim().length : 0"),
              rightValue: 0,
              operator: { type: 'number', operation: 'gt' },
            },
          ],
          combinator: 'and',
        },
        options: {},
      },
      id: 'b1e0a001-0001-4001-8001-000000000113',
      name: 'Has Text',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [3320, 1100],
    },
    {
      parameters: {
        promptType: 'define',
        text: expr(
          "'File name: ' + ($json.name || 'unknown.pdf') + '\\n\\n' + (Array.isArray($json.text) ? $json.text.join('\\n\\n') : ($json.text || ''))",
        ),
        hasOutputParser: false,
        options: {
          systemMessage: SYSTEM_MESSAGE,
          maxIterations: 5,
        },
      },
      id: 'b1e0a001-0001-4001-8001-000000000114',
      name: 'AI Agent',
      type: '@n8n/n8n-nodes-langchain.agent',
      typeVersion: 3.1,
      position: [3640, 980],
      onError: 'continueRegularOutput',
    },
    {
      parameters: {
        model: 'kimi-k3.1-pro',
        options: {
          temperature: 0,
          numCtx: 8192,
          numPredict: 2048,
          keepAlive: '30m',
        },
      },
      id: 'b1e0a001-0001-4001-8001-000000000115',
      name: 'Ollama Chat Model',
      type: '@n8n/n8n-nodes-langchain.lmChatOllama',
      typeVersion: 1,
      position: [3640, 1280],
      credentials: {
        ollamaApi: {
          name: 'Ollama account',
        },
      },
    },
    codeNode({
      id: 'b1e0a001-0001-4001-8001-000000000116',
      name: 'Skipped Resume',
      position: [3640, 1540],
      mode: 'runOnceForEachItem',
      jsCode: embed(
        [asMessage, stripSecrets, lookupFile, skippedResume],
        `${fileLookupHelper}

const incoming = $input.item.json;
const identity = fileIdentity(incoming);
return [{
  json: skippedResume({
    fileName: identity.fileName,
    fileId: identity.fileId,
    download: nodeJson('Download PDF'),
    extracted: nodeJson('Extract from File'),
  }),
}];`,
      ),
    }),
    codeNode({
      id: 'b1e0a001-0001-4001-8001-000000000117',
      name: 'Shape Result',
      position: [3960, 980],
      mode: 'runOnceForEachItem',
      jsCode: embed(
        [asMessage, stripSecrets, lookupFile, shapedResume],
        `${fileLookupHelper}

const incoming = $input.item.json;
const identity = fileIdentity(incoming);
return [{
  json: shapedResume({
    fileName: identity.fileName,
    fileId: identity.fileId,
    incoming,
  }),
}];`,
      ),
    }),
    codeNode({
      id: 'b1e0a001-0001-4001-8001-000000000118',
      name: 'Aggregate Output',
      position: [2380, 1860],
      mode: 'runOnceForAllItems',
      jsCode: embed(
        [aggregateResumes],
        `${generatedAtHelper}

const items = $input.all().map((item) => item.json);
return [{ json: aggregateResumes(items, generatedAtHKT()) }];`,
      ),
    }),
    {
      parameters: {
        operation: 'toText',
        sourceProperty: 'output',
        binaryPropertyName: 'data',
        options: {
          fileName: 'result.txt',
          encoding: 'utf8',
        },
      },
      id: 'b1e0a001-0001-4001-8001-000000000119',
      name: 'Convert to File',
      type: 'n8n-nodes-base.convertToFile',
      typeVersion: 1.1,
      position: [2700, 1860],
    },
    codeNode({
      id: 'b1e0a001-0001-4001-8001-000000000120',
      name: 'Build Multipart Upload',
      position: [3040, 1860],
      mode: 'runOnceForAllItems',
      jsCode: embed(
        [buildMultipart, readReportText],
        `const text = readReportText((nodeName) => $(nodeName).first().json.output);
const folderOut = $('Check Config').first().json.folder_out;
const built = buildMultipart({
  text,
  folderOut,
  boundary: '${UPLOAD_BOUNDARY}',
});
const binary = await this.helpers.prepareBinaryData(
  Buffer.from(built.payload, 'utf8'),
  built.fileName,
  built.contentType,
);
return [{
  json: {
    fileName: built.fileName,
    contentType: built.contentType,
    bytes: Buffer.byteLength(built.payload, 'utf8'),
  },
  binary: { data: binary },
}];`,
      ),
    }),
    httpNode({
      id: 'b1e0a001-0001-4001-8001-000000000121',
      name: 'Upload result.txt',
      position: [3380, 1860],
      parameters: {
        method: 'POST',
        url: 'https://www.googleapis.com/upload/drive/v3/files',
        sendQuery: true,
        specifyQuery: 'keypair',
        queryParameters: {
          parameters: [
            { name: 'uploadType', value: 'multipart' },
            { name: 'supportsAllDrives', value: 'true' },
          ],
        },
        sendHeaders: true,
        specifyHeaders: 'keypair',
        headerParameters: {
          parameters: [
            { name: 'Authorization', value: bearer },
            { name: 'Content-Type', value: `multipart/related; boundary=${UPLOAD_BOUNDARY}` },
          ],
        },
        sendBody: true,
        contentType: 'binaryData',
        inputDataFieldName: 'data',
        options: { timeout: 60000 },
      },
    }),
  ];

  const link = (node) => ({ node, type: 'main', index: 0 });
  const connections = {
    'Manual Trigger': { main: [[link('Config')]] },
    Config: { main: [[link('Check Config')]] },
    'Check Config': { main: [[link('Get Access Token')]] },
    'Get Access Token': { main: [[link('List PDFs')]] },
    'List PDFs': { main: [[link('Collect Files')]] },
    'Collect Files': { main: [[link('Has PDFs')]] },
    'Has PDFs': {
      main: [[link('Split Out')], [link('Empty Result')]],
    },
    'Empty Result': { main: [[link('Convert to File')]] },
    'Split Out': { main: [[link('Loop Over Items')]] },
    'Loop Over Items': {
      main: [[link('Aggregate Output')], [link('Download PDF')]],
    },
    'Download PDF': { main: [[link('Extract from File')]] },
    'Extract from File': { main: [[link('Has Text')]] },
    'Has Text': {
      main: [[link('AI Agent')], [link('Skipped Resume')]],
    },
    'AI Agent': { main: [[link('Shape Result')]] },
    'Ollama Chat Model': {
      ai_languageModel: [
        [{ node: 'AI Agent', type: 'ai_languageModel', index: 0 }],
      ],
    },
    'Skipped Resume': { main: [[link('Loop Over Items')]] },
    'Shape Result': { main: [[link('Loop Over Items')]] },
    'Aggregate Output': { main: [[link('Convert to File')]] },
    'Convert to File': { main: [[link('Build Multipart Upload')]] },
    'Build Multipart Upload': { main: [[link('Upload result.txt')]] },
  };

  return {
    name: 'Batch Resume Processor',
    nodes,
    connections,
    pinData: {},
    active: false,
    settings: {
      executionOrder: 'v1',
    },
    meta: {
      templateCredsSetupCompleted: false,
    },
    tags: [],
  };
}

export async function writeWorkflow(target = workflowPath) {
  const workflow = buildWorkflow();
  await writeFile(target, `${JSON.stringify(workflow, null, 2)}\n`);
  return workflow;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await writeWorkflow();
  console.log(`Wrote ${workflowPath}`);
}
