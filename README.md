# Batch Resume Processor

An n8n workflow that reads PDFs from a Google Drive folder, asks an Ollama model for the candidate's name, education, and working experience, and writes one `result.txt` back to another Drive folder.

Google is called with HTTP Request nodes and a refresh token. The workflow does not store a Google Drive credential in n8n.

Import `workflows/batch-resume-processor.json` on n8n 1.99 or newer (AI Agent node 3.1). n8n 2.x is the better fit.

## What you need

- A Google Cloud OAuth client with the Drive API enabled
- A refresh token for the Google account that can read the input folder and write the output folder
- The two folder ids (the segment after `/folders/` in the Drive URL)
- n8n, with an Ollama credential already saved
- Ollama running a chat model. The workflow is set to `kimi-k3.1-pro`; change the model on **Ollama Chat Model** if you pulled a different one

`https://www.googleapis.com/auth/drive` is required. The narrower `drive.file` scope cannot see PDFs that this app did not create.

While the OAuth consent screen is in **Testing**, Google expires refresh tokens after seven days. Add the account as a test user, or publish the app when you want a token that keeps working.

## Configure

```bash
cp n8n-resume-processor/config.example.json n8n-resume-processor/config.json
```

`config.json` is gitignored. Fill `client_id` and `client_secret` first. On the OAuth client, add this authorized redirect URI:

`http://127.0.0.1:53682/callback`

Then mint the refresh token. The script listens on `127.0.0.1:53682`, prints the consent URL, and writes `refresh_token` into `config.json`. It does not print the token.

```bash
node n8n-resume-processor/scripts/google-refresh-token.mjs
```

Put the two folder ids in `config.json`, then bake them into a local workflow file:

```bash
node n8n-resume-processor/scripts/apply-config.mjs
```

That writes `workflows/batch-resume-processor.local.json`, which contains the client secret and refresh token. Import that file. Do not commit it.

You can skip the scripts and paste the five values into the **Config** node instead:

| Field | Meaning |
| --- | --- |
| `client_id` | Google OAuth client id |
| `client_secret` | Google OAuth client secret |
| `refresh_token` | Long-lived refresh token |
| `folder_in` | Drive folder id for the input PDFs |
| `folder_out` | Drive folder id for `result.txt` |

## Import and run

1. In n8n, choose **Import from File** and select `workflows/batch-resume-processor.local.json`.
2. Open **Ollama Chat Model** and select the existing Ollama credential. The base URL lives on that credential, usually `http://127.0.0.1:11434`. If n8n runs in Docker and Ollama runs on the host, use `http://host.docker.internal:11434`.
3. Save, then execute the workflow from **Manual Trigger**.

The model context length is 8192 tokens. Raise **Context Length** on **Ollama Chat Model** for a very long resume. The access token from the start of the run lasts about an hour.

## Connections

```
Manual Trigger
  -> Config
  -> Check Config
  -> Get Access Token          POST https://oauth2.googleapis.com/token
  -> List PDFs                 GET  /drive/v3/files  (pdfs in folder_in, page size 1000)
  -> Collect Files
  -> Has PDFs
       true  -> Split Out
              -> Loop Over Items          batch size 1
                   loop -> Download PDF   GET /drive/v3/files/{id}?alt=media
                        -> Extract from File (pdf, pages joined, original file name kept)
                        -> Has Text
                             true  -> AI Agent -> Shape Result --+
                             false -> Skipped Resume ------------+
                                                                  |
                   done <- Loop Over Items <---------------------+
                        -> Aggregate Output
       false -> Empty Result
  Aggregate Output or Empty Result
    -> Convert to File          result.txt
    -> Build Multipart Upload
    -> Upload result.txt        POST /upload/drive/v3/files?uploadType=multipart
```

**Ollama Chat Model** connects to the AI Agent on the language-model input, not the main flow.

**Loop Over Items** has two outputs. The loop output (second) is **Download PDF**. The done output (first) is **Aggregate Output**, and it fires only after **Shape Result** or **Skipped Resume** has been connected back into the loop. Wire those two returns back to **Loop Over Items** if you rearrange the canvas; the imported file already has them.

## Report

`result.txt` is UTF-8. Each run creates a new Drive file named `result.txt`. Drive allows more than one file with that name, so older reports stay in the folder until you delete them.

```
Batch resume extraction
Generated: 2026-11-26 14:10 HKT
Files: 2

===== ada-ng.pdf =====
Drive file id: 1abc

Name:
Ada Ng
Education:
HKU, BSc Computer Science, 2016–2020
Working experience:
Northwind Labs, Product Engineer, 2020–2024

===== scanned.pdf =====
Drive file id: 1def

No text could be extracted from this PDF. It may be scanned or image-only.
```

Names, schools, and employers stay in the script used on the resume. The three headings stay in English. A scanned or image-only PDF is recorded and the rest of the batch still runs. A download or model error is recorded the same way, with any bearer token stripped from the message.

An empty input folder still uploads a report that says no PDFs were found.

## Limits

- Listing follows `nextPageToken` for up to 20 pages of 1000 files, in My Drive and shared drives.
- Text comes from the PDF text layer. This workflow does not OCR scans.
- Do not set **Max Pages** to 0 on **Extract from File**. Leaving that option off reads every page.
- The client secret and refresh token sit in the Config node in plain text, which is the point of using HTTP Request nodes instead of a stored Google credential. Do not share an export after you fill them in.

## Develop

Logic for config checks, file collection, the report, and the multipart body lives in `lib/`. The workflow JSON is generated.

```bash
node n8n-resume-processor/scripts/build-workflow.mjs
node n8n-resume-processor/scripts/test.mjs
```
