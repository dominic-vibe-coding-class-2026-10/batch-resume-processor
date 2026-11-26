# n8n Resume Processor — Import & Test Manifest

This manifest instructs a coding agent (e.g. Cursor) to:

1. Authenticate to the user's n8n instance
2. Import the workflow JSON
3. Apply configuration (or guide the user to paste values)
4. Select the Ollama credential
5. Execute a test run and verify the result

---

## Prerequisites

- The workflow JSON is available at:  
  `n8n-resume-processor/workflows/batch-resume-processor.json`  
  (or the local version `batch-resume-processor.local.json` after running the config scripts)

- User has an existing Ollama credential in n8n named: `{{OLLAMA_CREDENTIAL_NAME}}`

---

## Placeholders (fill these before running the agent)

| Placeholder                     | Description                                      | Example                          |
|---------------------------------|--------------------------------------------------|----------------------------------|
| `{{N8N_BASE_URL}}`              | Base URL of the n8n instance                     | `https://n8n.example.com`        |
| `{{N8N_API_KEY}}`               | n8n API key (Settings → API)                     | `n8n_api_...`                    |
| `{{OLLAMA_CREDENTIAL_NAME}}`    | Exact name of the existing Ollama credential     | `Ollama account`                 |
| `{{OLLAMA_MODEL}}`              | Model to use                                     | `kimi-k3.1-pro`                  |
| `{{FOLDER_IN}}`                 | Google Drive folder ID for input PDFs            | `1AbC...xyz`                     |
| `{{FOLDER_OUT}}`                 | Google Drive folder ID for result.txt            | `1DeF...uvw`                     |
| `{{CLIENT_ID}}`                 | Google OAuth Client ID                           | `60680155185-...`                |
| `{{CLIENT_SECRET}}`             | Google OAuth Client Secret                       | `GOCSPX-...`                     |
| `{{REFRESH_TOKEN}}`             | Google refresh token                             | `1//04DE6sqh...`                 |

---

## Steps for the Agent

### 1. Authenticate to n8n
- Use the n8n API or UI login with:
  - Base URL: `{{N8N_BASE_URL}}`
  - API Key: `{{N8N_API_KEY}}`
- Confirm the instance is reachable and the API key works.

### 2. Import the workflow
- Import the file:  
  `n8n-resume-processor/workflows/batch-resume-processor.json`
- Name the workflow: `Batch Resume Processor (Google Drive)`
- Activate it only after testing (leave inactive initially).

### 3. Apply configuration
Option A (preferred if scripts exist):
```bash
# Ensure config.json is filled, then:
node n8n-resume-processor/scripts/apply-config.mjs
# Import the generated workflows/batch-resume-processor.local.json instead
```

Option B (manual):
- Open the imported workflow.
- In the **Config** node, paste:
  - `client_id` = `{{CLIENT_ID}}`
  - `client_secret` = `{{CLIENT_SECRET}}`
  - `refresh_token` = `{{REFRESH_TOKEN}}`
  - `folder_in` = `{{FOLDER_IN}}`
  - `folder_out` = `{{FOLDER_OUT}}`

### 4. Select Ollama credential
- Open the **Ollama Chat Model** node.
- Select the existing credential: `{{OLLAMA_CREDENTIAL_NAME}}`
- Confirm the model is set to `{{OLLAMA_MODEL}}`

### 5. Test the workflow
- Place 1–2 test PDFs in the Google Drive folder `{{FOLDER_IN}}`.
- In n8n, open the workflow and click **Execute workflow** (Manual Trigger).
- Wait for completion.
- Check:
  - The execution log for errors.
  - That `result.txt` appears in the Google Drive folder `{{FOLDER_OUT}}`.
  - That the content contains the expected Name / Education / Working experience sections.

### 6. Report results
- Summarize success or failure.
- If failed, include the relevant error messages from the n8n execution.
- Confirm the location of the uploaded `result.txt`.

---

## Notes

- The access token obtained at the start of the run is valid for ~1 hour.
- The refresh token must have the scope `https://www.googleapis.com/auth/drive`.
- Folder IDs are the long strings after `/folders/` in the Google Drive URL.
- Do not commit real values of the placeholders into the repository.
- Add this file (`test_manifest.md`) to the `n8n-resume-processor` repository under a `docs/` or root folder.

---

## Expected Flow (for reference)

```
Manual Trigger
  → Config
  → Get Access Token
  → List PDFs
  → Loop Over Items
      → Download PDF → Extract from File → AI Agent
  → Aggregate Output
  → Convert to File
  → Upload result.txt
```
