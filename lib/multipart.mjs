export const UPLOAD_BOUNDARY = 'n8n_resume_boundary_7f3a9c';

export function buildMultipart({ text, folderOut, boundary }) {
  if (typeof folderOut !== 'string' || !folderOut.trim()) {
    throw new Error('Config folder_out is empty. Set the Google Drive output folder id.');
  }
  if (typeof text !== 'string') {
    throw new Error('Resume report text is missing.');
  }
  if (text.includes(boundary)) {
    throw new Error('The resume report contains the multipart boundary, so the upload body would be invalid.');
  }
  const metadata = JSON.stringify({
    name: 'result.txt',
    parents: [folderOut.trim()],
    mimeType: 'text/plain',
  });
  const payload =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: text/plain; charset=UTF-8\r\n\r\n' +
    `${text}\r\n` +
    `--${boundary}--\r\n`;
  return {
    payload,
    fileName: 'result.txt',
    contentType: `multipart/related; boundary=${boundary}`,
  };
}
