# Batch Resume Processor

This project reads PDF resumes from one Google Drive folder, asks an Ollama model for the candidate’s name, education, and working experience, and writes one `result.txt` into a second Drive folder.

You import `workflows/batch-resume-processor.json` into n8n. Google is called with ordinary HTTP Request nodes and a refresh token. You do not create a Google Drive credential inside n8n.

Commands below assume this folder is the project. If you cloned a larger checkout, `cd` into the folder that contains this README first.

## Two files, two jobs

| File | Who it is for |
| --- | --- |
| This README | You. Do the Google Cloud Console work, fill `config.json`, then import and run the workflow in n8n. |
| [`manifest.md`](manifest.md) | A coding agent. Hand it this file when you want the agent to build, import, and prove the workflow. It already includes the mistakes that waste a run: a dead refresh token, the wrong Google redirect, publishing an old n8n version, and a Code node that returns an array. |

Give the agent `manifest.md` only after the Google Console steps below are done, or be ready to sign in when it sends you a Google link. The agent cannot click through your Google account.

Tell the agent something like this, and do not commit the values:

```text
Follow manifest.md. config.json is already filled. Do not commit config.json or any local workflow file.
N8N_BASE_URL: http://your-n8n-host:5678
N8N_API_KEY: (the key from n8n Settings → API)
OLLAMA_CREDENTIAL_NAME: Ollama account
OLLAMA_MODEL: kimi-k3.1-pro
```

When the agent finishes, n8n shows a successful execution and `result.txt` is in the output folder.

## What you set up in Google Cloud Console

Use the Google account that can open both Drive folders. A different account will not see the files.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project, for example `batch-resume-processor`.
2. Go to **APIs & Services → Library**, search for **Google Drive API**, and click **Enable**.
3. Go to **APIs & Services → OAuth consent screen**.
   - User type: **External**, unless this is a Google Workspace account you control.
   - Fill the app name and your email.
   - Add the scope `https://www.googleapis.com/auth/drive`. The narrower `drive.file` scope cannot see PDFs that this app did not create.
   - Under **Test users**, add the Gmail account that owns the Drive folders.
   - Leave the app in **Testing** while you are learning. Google then expires refresh tokens after seven days. Publishing the app makes a token last, and Google may ask you to verify an app that requests full Drive access.
4. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   - Application type: **Web application**.
   - Name: `batch-resume-processor`.
   - Under **Authorized redirect URIs**, add both lines and save:

     `http://127.0.0.1:53682/callback`

     `https://developers.google.com/oauthplayground`

   - Copy the **Client ID** and **Client secret**. The secret is shown in full on this screen. If you lose it, reset the secret on this same client. A new secret makes every old refresh token invalid.

The first redirect is for `scripts/google-refresh-token.mjs` on your own computer. The second is for [OAuth Playground](https://developers.google.com/oauthplayground). If a redirect is missing, Google shows **Access blocked** and **Error 400: redirect_uri_mismatch**, and there is no place to type your password.

## Two Drive folders

1. In Google Drive, create a folder for the incoming PDFs and a folder for the report.
2. Open each folder. The address looks like `https://drive.google.com/drive/folders/1AbC...`.
3. The long id after `/folders/` is what the workflow wants. Do not paste the whole URL.
4. Put one or two text PDFs in the input folder. The workflow reads the text layer. A scan with no selectable text is recorded as “no text” and the other files still run.

## Fill config.json

```bash
cp config-template.json config.json
```

`config-template.json` is safe to commit. Every value starts with `PASTE_`, and the workflow refuses to run until you replace them. `config.json` is gitignored. Never commit it, and never commit `workflows/batch-resume-processor.local.json`.

| Field | Where it comes from |
| --- | --- |
| `client_id` | OAuth client ID from the Credentials page |
| `client_secret` | OAuth client secret from that same client |
| `refresh_token` | Minted in the next step. It must be created with this client id and this secret. |
| `folder_in` | Drive folder id for the PDFs |
| `folder_out` | Drive folder id for `result.txt` |

Mint the refresh token on your computer, after the redirect URI is saved:

```bash
node scripts/google-refresh-token.mjs
```

Open the URL it prints, sign in with the Drive account, and click **Allow**. The script writes `refresh_token` into `config.json`. It does not print the token.

If you use OAuth Playground instead, turn on **Use your own OAuth credentials**, paste this client id and secret, choose the scope `https://www.googleapis.com/auth/drive`, authorize, and exchange the code. Copy the refresh token into `config.json`. Changing the client secret later means you must mint the token again. Reusing the old token makes **Get Access Token** fail with `invalid_grant`.

Then bake the values into a local workflow file:

```bash
node scripts/apply-config.mjs
```

That writes `workflows/batch-resume-processor.local.json`. Import that file. You can also import `workflows/batch-resume-processor.json` and paste the five values into the **Config** node yourself.

## Import and run in n8n

You need n8n 1.99 or newer. n8n 2.x is the better fit, because the AI Agent node is version 3.1. You also need an Ollama credential already saved in n8n, and a chat model. The workflow is set to `kimi-k3.1-pro`. Change **Ollama Chat Model** if you pulled a different model.

1. In n8n, choose **Import from File** and select `workflows/batch-resume-processor.local.json`.
2. Open **Ollama Chat Model**. Select your Ollama credential. Its base URL is usually `http://127.0.0.1:11434`. If n8n runs in Docker and Ollama runs on the host, use `http://host.docker.internal:11434`.
3. Save, then run from **Manual Trigger**.

The model context length is 8192 tokens. Raise **Context Length** on **Ollama Chat Model** for a very long resume. The Google access token from the start of the run lasts about an hour.

## What the canvas does

```
Manual Trigger
  -> Config
  -> Check Config
  -> Get Access Token          POST https://oauth2.googleapis.com/token
  -> List PDFs                 GET  /drive/v3/files  (pdfs in folder_in)
  -> Collect Files
  -> Has PDFs
       true  -> Split Out
              -> Loop Over Items          one PDF at a time
                   loop -> Download PDF
                        -> Extract from File
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
    -> Upload result.txt
```

**Ollama Chat Model** connects to the AI Agent on the language-model input, not along the main line.

**Loop Over Items** has two outputs. The second output is the loop, and it goes to **Download PDF**. The first output fires when every file is done, and it goes to **Aggregate Output**. **Shape Result** and **Skipped Resume** both connect back into **Loop Over Items**. The imported file is already wired that way.

## What result.txt looks like

Each run creates a new Drive file named `result.txt`. Drive allows more than one file with that name, so older reports stay until you delete them.

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

Names, schools, and employers stay in the script used on the resume. The three headings stay in English. An empty input folder still uploads a report that says no PDFs were found.

## If a run fails on the first Google node

Open **Get Access Token**. The red toast “Bad request — please check your parameters” is n8n wrapping Google’s answer.

- `invalid_client` means the client secret is wrong.
- `invalid_grant` means the refresh token was not minted with this client id and secret, or Google has expired it. Mint a new one. Do not run the workflow again with the same token.
- `redirect_uri_mismatch` on the sign-in page means the redirect in that link is not in the OAuth client’s **Authorized redirect URIs**.

The client secret and refresh token sit in the **Config** node in plain text. That is how these HTTP Request nodes work. Do not share an export after you fill them in.

## Develop

Logic lives in `lib/`. The workflow JSON is generated.

```bash
node scripts/build-workflow.mjs
node --test scripts/test.mjs
```
