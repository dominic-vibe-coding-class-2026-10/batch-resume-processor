# Batch Resume Processor — zero-shot manifest

Follow this file from top to bottom. It is the build, the import, and the proof that a run uploaded `result.txt`. Do not commit secrets, and do not print refresh tokens, client secrets, access tokens, or API keys.

If `n8n-resume-processor/` already exists and `node --test n8n-resume-processor/scripts/test.mjs` passes, skip to [Deploy and prove it](#deploy-and-prove-it). Otherwise build the tree below first.

## What done looks like

- `node --test n8n-resume-processor/scripts/test.mjs` passes.
- n8n has an inactive workflow named **Batch Resume Processor**.
- Its **Config** node holds the five values below. Google is called with HTTP Request nodes. There is no Google Drive credential in n8n.
- **Ollama Chat Model** uses the existing Ollama credential and model `kimi-k3.1-pro`.
- One execution finishes with status `success`.
- Drive folder `folder_out` contains a new `result.txt` whose body has `Name:`, `Education:`, and `Working experience:` for every PDF that had a text layer.

## Values the user supplies

```yaml
N8N_BASE_URL: ""          # no trailing path; a trailing slash is fine
N8N_API_KEY: ""           # Settings → API. Header X-N8N-API-KEY
OLLAMA_API_KEY: ""        # only if the Ollama credential test fails
OLLAMA_CREDENTIAL_NAME: "Ollama account"
OLLAMA_MODEL: "kimi-k3.1-pro"
CLIENT_ID: ""
CLIENT_SECRET: ""
REFRESH_TOKEN: ""         # may be dead; prove it before writing it into n8n
FOLDER_IN: ""             # Drive folder id, not the folder URL
FOLDER_OUT: ""
```

Keep these in `n8n-resume-processor/config.json` for the Google fields and the two folder ids. That file is gitignored. `workflows/*.local.json` is gitignored too.

## Repo to build

```
n8n-resume-processor/
  manifest.md
  README.md
  config.example.json
  lib/check-config.mjs
  lib/collect-files.mjs
  lib/resume-report.mjs
  lib/multipart.mjs
  lib/oauth.mjs
  lib/apply-config.mjs
  scripts/build-workflow.mjs
  scripts/test.mjs
  scripts/apply-config.mjs
  scripts/google-refresh-token.mjs
  workflows/batch-resume-processor.json    # generated, secrets empty
```

`config.example.json` is:

```json
{
  "client_id": "",
  "client_secret": "",
  "refresh_token": "",
  "folder_in": "",
  "folder_out": ""
}
```

Generate the workflow JSON from the script. Do not hand-edit it. After any lib change, run the build script and the tests.

```bash
node n8n-resume-processor/scripts/build-workflow.mjs
node --test n8n-resume-processor/scripts/test.mjs
```

## Behaviour to implement

Google scope is `https://www.googleapis.com/auth/drive`. `drive.file` cannot see PDFs this app did not create. Folder ids are the segment after `/folders/`. Reject a full Drive URL.

`lib/check-config.mjs`

- `checkConfig` reads `client_id`, `client_secret`, `refresh_token`, `folder_in`, `folder_out`. Trim them. Reject empty strings and values that start with `PASTE_`.
- Add `drive_query`: `'<folder_in>' in parents and mimeType = 'application/pdf' and trashed = false`, with quotes and backslashes in the id escaped.
- `checkOAuthClient` reads only `client_id` and `client_secret`.
- Inline the key list inside `checkConfig`. A Code node sandbox does not keep a module-level constant from another function.

`lib/collect-files.mjs`

- Flatten Drive list pages, keep `application/pdf`, drop trashed and other MIME types, dedupe by file id, sort by name.
- Return `{ files, count }`.

`lib/resume-report.mjs`

- Strip `Bearer …` and `ya29.…` from any error text before it enters the report.
- `shapedResume` returns `{ fileName, fileId, output }` from the model text. An error or an empty reply becomes a sentence in `output`, not a thrown exception.
- `skippedResume` records download errors, extract errors, and image-only PDFs the same way.
- `aggregateResumes` joins one section per file. `emptyFolderReport` says no PDFs were found. Timestamps use `Asia/Hong_Kong` and a `HKT` suffix.
- `readReportText` reads `Aggregate Output` first, then `Empty Result`.

`lib/multipart.mjs`

- Boundary constant `n8n_resume_boundary_7f3a9c`.
- Body is `multipart/related`: metadata JSON (`name: result.txt`, `parents: [folder_out]`, `mimeType: text/plain`), then the report as `text/plain`. CRLF separators. Refuse a report that contains the boundary.

`lib/oauth.mjs`

- Local helper redirect: `http://127.0.0.1:53682/callback`.
- Auth URL uses `response_type=code`, `access_type=offline`, `prompt=consent`, and the Drive scope.
- Exchange the code with `grant_type=authorization_code`. Require a `refresh_token` in the response.

## Workflow the builder must emit

Name: `Batch Resume Processor`. Leave `active: false`. Settings: `executionOrder: v1`.

```
Manual Trigger
  -> Config                         Set node, five string fields, values empty in the template
  -> Check Config                   Code, runOnceForAllItems
  -> Get Access Token               POST https://oauth2.googleapis.com/token
  -> List PDFs                      GET  https://www.googleapis.com/drive/v3/files
  -> Collect Files
  -> Has PDFs                       count > 0
       true  -> Split Out (field files)
              -> Loop Over Items    splitInBatches, batch size 1
                   loop (output 1) -> Download PDF
                        -> Extract from File
                        -> Has Text
                             true  -> AI Agent -> Shape Result ----+
                             false -> Skipped Resume --------------+
                                                                   |
                   done (output 0) <- Loop Over Items <------------+
                        -> Aggregate Output
       false -> Empty Result
  Aggregate Output and Empty Result both go to Convert to File
    -> Build Multipart Upload
    -> Upload result.txt
```

**Ollama Chat Model** connects to **AI Agent** on `ai_languageModel`, not on `main`. Loop output 0 is the done output. Loop output 1 is the current batch. **Shape Result** and **Skipped Resume** connect back to **Loop Over Items**.

Node details that are easy to get wrong:

| Node | Rule |
| --- | --- |
| Get Access Token | HTTP Request 4.2. POST. Body form-urlencoded with `client_id`, `client_secret`, `refresh_token` from `$json`, and `grant_type` = `refresh_token`. No n8n credential. |
| List PDFs | Query `q` from Check Config `drive_query`. `fields=files(id,name,mimeType),nextPageToken`, `pageSize=1000`, `orderBy=name`, `supportsAllDrives=true`, `includeItemsFromAllDrives=true`. Header `Bearer` plus the access token. Paginate on `nextPageToken`, stop after 20 pages. |
| Download PDF | `GET /drive/v3/files/{id}?alt=media&supportsAllDrives=true`. Response format `file` into binary property `data`. `onError: continueRegularOutput`. |
| Extract from File | Operation `pdf`, binary `data`, `joinPages: true`, `keepSource: json`. Do not set max pages to 0. `onError: continueRegularOutput`. |
| Has Text | True when trimmed `text` length is greater than 0. |
| AI Agent | `@n8n/n8n-nodes-langchain.agent` typeVersion 3.1. `promptType: define`. Prompt is the file name plus the extracted text. No output parser. `maxIterations: 5`. `onError: continueRegularOutput`. System message asks for plain text headings `Name:`, `Education:`, `Working experience:`, in that order, with no preamble and no markdown fence. Keep names in the resume’s script. Missing sections say `Not found`. |
| Ollama Chat Model | `@n8n/n8n-nodes-langchain.lmChatOllama` typeVersion 1. Model `kimi-k3.1-pro`. Temperature 0, `numCtx` 8192, `numPredict` 2048, `keepAlive` `30m`. Credential name `Ollama account`, type `ollamaApi`. |
| Code nodes | `runOnceForAllItems` returns `[{ json: ... }]`. `runOnceForEachItem` returns one object, `{ json: ... }`. **Shape Result** and **Skipped Resume** are each-item. Returning an array from those two makes n8n fail with `A 'json' property isn't an object`. |
| Convert to File | `toText`, source property `output`, file name `result.txt`, UTF-8. |
| Upload result.txt | `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`. Content-Type `multipart/related; boundary=n8n_resume_boundary_7f3a9c`. Raw body from the binary built in the previous node. Bearer token from **Get Access Token**. |

Check Config, Collect Files, Empty Result, Shape Result, Skipped Resume, Aggregate Output, and Build Multipart Upload are Code nodes whose source is the lib functions inlined by `scripts/build-workflow.mjs`. The template Config values stay empty. `scripts/apply-config.mjs` writes `workflows/batch-resume-processor.local.json` with the five values filled in. Do not commit that file.

Tests in `scripts/test.mjs` must cover the config guards, Drive query escaping, file collection, token redaction, multipart body, the OAuth URL, the node graph, and each Code node script under Node’s `vm` with the same `$input` / `$` shape n8n uses.

## Deploy and prove it

### 1. Confirm the refresh token before touching n8n

```http
POST https://oauth2.googleapis.com/token
Content-Type: application/x-www-form-urlencoded

client_id=...&client_secret=...&refresh_token=...&grant_type=refresh_token
```

- HTTP 200 and an `access_token`: keep going. If the body also contains a new `refresh_token`, save that one. Google sometimes rotates it, and the previous value then returns `invalid_grant`.
- `invalid_client`: the secret does not match this client id. Stop. Ask for the current secret. Do not start an n8n execution.
- `invalid_grant`: the secret is recognized and the refresh token is not. Stop. Mint a new token with the steps below. Running n8n again with the same token fails in **Get Access Token** the same way.

List the input folder with the access token:

```http
GET https://www.googleapis.com/drive/v3/files
  ?q='FOLDER_IN' in parents and trashed = false
  &fields=files(id,name,mimeType)
  &supportsAllDrives=true
  &includeItemsFromAllDrives=true
Authorization: Bearer ACCESS_TOKEN
```

Folder `FOLDER_OUT` must be readable the same way. If `FOLDER_IN` has no PDF, upload one text-layer sample so the model path is exercised, and say that you added it. An empty folder is still a valid run: the workflow uploads a report that says no PDFs were found.

### 2. Mint a refresh token when Google rejects the one supplied

This OAuth client accepts `https://developers.google.com/oauthplayground` as a redirect. It does **not** accept `http://127.0.0.1:53682/callback` until that URI is added on the OAuth client. Opening the local script’s URL produces **Error 400: redirect_uri_mismatch** and no email box.

Send the user this kind of URL (their client id, Drive scope, `access_type=offline`, `prompt=consent`, `redirect_uri=https://developers.google.com/oauthplayground`). They sign in with the Google account that can open both folders and click **Allow**. They paste back the full playground address, which looks like `https://developers.google.com/oauthplayground/?code=...`.

Exchange it at once. Authorization codes are single-use:

```http
POST https://oauth2.googleapis.com/token
code=...
client_id=...
client_secret=...
redirect_uri=https://developers.google.com/oauthplayground
grant_type=authorization_code
```

Require `refresh_token` in the response, then run the refresh-token check from step 1. Write the working token into `config.json` only.

`scripts/google-refresh-token.mjs` is the local alternative after the Cloud Console client lists `http://127.0.0.1:53682/callback` as an authorized redirect. The browser and the script must be on the same machine, because Google redirects to that machine’s `127.0.0.1`. A cloud agent cannot type the user’s Google password.

### 3. Reach n8n and Ollama

```http
GET {N8N_BASE_URL}/healthz
GET {N8N_BASE_URL}/api/v1/workflows
X-N8N-API-KEY: {N8N_API_KEY}
```

Create the workflow from `workflows/batch-resume-processor.json` when none exists:

```http
POST {N8N_BASE_URL}/api/v1/workflows
{ "name", "nodes", "connections", "settings" }
```

On an existing **Batch Resume Processor**, PUT only `name`, `nodes`, `connections`, `settings`, and `staticData`. Then set the five Config values. Match **Ollama Chat Model** `credentials.ollamaApi` to the credential whose name is `OLLAMA_CREDENTIAL_NAME` (`GET /api/v1/credentials`). Set `parameters.model` to `OLLAMA_MODEL`.

Test that credential: `POST /api/v1/credentials/{id}/test`. If it fails and an API key was supplied, `PATCH /api/v1/credentials/{id}` with `isPartialData: true` and the key in `data`, then test again. Do not create a second Ollama credential when one with that name already exists.

### 4. Publish the version you just saved, then run it

n8n 2’s `POST /api/v1/workflows/{id}/activate` is the old verb. It can run the previously published version, so the execution still has the old refresh token or the old Code node. Do not use it.

The public API has no “run this workflow” method. Use a temporary webhook, then remove it.

1. Remember the latest execution id for this workflow.
2. Add a Webhook node named `Test Webhook` (`n8n-nodes-base.webhook` typeVersion 2, POST, `responseMode: onReceived`, a random path such as `resume-test-` plus 32 hex chars). Connect it to **Config**. Leave **Manual Trigger** in place.
3. PUT the workflow. GET it again. Read `versionId`. Confirm the Config refresh token and the Shape Result source are the ones you just saved.
4. `POST /api/v1/workflows/{id}/publish` with `{ "versionId": "<that id>" }`. The response `activeVersionId` must equal that id.
5. `POST {N8N_BASE_URL}/webhook/<path>` with `{}`. A 404 for a few seconds means the webhook is not registered yet. Retry for about 20 seconds.
6. Poll `GET /api/v1/executions?workflowId={id}&limit=5`. Wait for an execution whose id is newer than the one from step 1. Ignore older rows, even when their status is already `error`. The run you just started can take a few seconds to appear, and the model can take several minutes.
7. `GET /api/v1/executions/{id}?includeData=true`. Accept it only when `workflowVersionId` is the version you published. `success` means every node you care about succeeded, including **Upload result.txt**.
8. `POST /api/v1/workflows/{id}/unpublish`. PUT again without `Test Webhook`. Confirm `active` is false and the webhook node is gone.

Download `result.txt` from Drive (`files.get?alt=media`) and read it. Do not trust the execution alone.

### 5. Report

Say whether the execution status was `success`, the execution id, and the Drive file id of `result.txt`. Quote the report headings. If you uploaded a sample PDF because the input folder was empty, say so. Leave the workflow unpublished.

## Failures already seen

| What you see | What it means |
| --- | --- |
| `invalid_client` | Wrong client secret. |
| `invalid_grant` on a direct token call | Refresh token was not issued for this secret, or it was rotated or revoked. Mint another. |
| n8n toast “Bad request — please check your parameters” on **Get Access Token** | Google’s HTTP 400. Read the node output. It is usually `invalid_grant`. |
| Google page “Access blocked” / `redirect_uri_mismatch` | The redirect on that link is not registered. Use the playground redirect above. |
| Execution `workflowVersionId` is an older id | Activate/publish ran a stale copy. Publish the `versionId` from the GET after your PUT, and wait for an execution of that version. |
| **Shape Result**: `A 'json' property isn't an object` | An each-item Code node returned an array. Return `{ json: ... }`. |
| Webhook 404 right after publish | Retry. Registration takes a few seconds. |
| First poll shows an older `error` execution | That run already finished. Keep polling until the new id appears. |
| Input folder lists zero PDFs | Upload a text-layer sample, or expect the empty-folder report. |

Redact tokens in execution dumps before writing them to disk or chat. `Config` output and the **Get Access Token** request both contain the secret and the refresh token.
