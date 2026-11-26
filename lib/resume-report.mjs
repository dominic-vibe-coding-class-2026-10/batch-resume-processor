export function stripSecrets(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '[redacted-access-token]');
}

export function asMessage(error) {
  const clip = (text) => {
    const clean = stripSecrets(text).replace(/\s+/g, ' ').trim();
    if (clean.length <= 500) return clean;
    return `${clean.slice(0, 499)}…`;
  };
  if (error == null) return 'Unknown error';
  if (typeof error === 'string') return clip(error);
  if (typeof error !== 'object') return clip(String(error));
  const parts = [];
  if (typeof error.message === 'string') parts.push(error.message);
  if (typeof error.description === 'string') parts.push(error.description);
  if (error.error && typeof error.error === 'object' && typeof error.error.message === 'string') {
    parts.push(error.error.message);
  }
  if (parts.length) return clip(parts.join(' — '));
  try {
    return clip(JSON.stringify(error));
  } catch {
    return 'Unknown error';
  }
}

export function lookupFile(getNodeJson) {
  const nodeNames = ['Split Out', 'Download PDF', 'Extract from File', 'Loop Over Items'];
  let fileName = '';
  let fileId = '';
  for (const nodeName of nodeNames) {
    let json;
    try {
      json = getNodeJson(nodeName);
    } catch {
      continue;
    }
    if (!json || typeof json !== 'object') continue;
    if (!fileName && typeof json.name === 'string' && json.name.trim()) fileName = json.name.trim();
    if (!fileName && typeof json.fileName === 'string' && json.fileName.trim()) {
      fileName = json.fileName.trim();
    }
    if (!fileId && typeof json.id === 'string' && json.id.trim()) fileId = json.id.trim();
    if (!fileId && typeof json.fileId === 'string' && json.fileId.trim()) fileId = json.fileId.trim();
  }
  return { fileName, fileId };
}

export function skippedResume({ fileName, fileId, download, extracted }) {
  const downloadError = download && download.error != null ? download.error : null;
  const extractError = extracted && extracted.error != null ? extracted.error : null;
  let output;
  if (downloadError) {
    output = `ERROR: Could not download the PDF. ${asMessage(downloadError)}`;
  } else if (extractError) {
    output = `ERROR: Could not extract text from the PDF. ${asMessage(extractError)}`;
  } else {
    output = 'No text could be extracted from this PDF. It may be scanned or image-only.';
  }
  return {
    fileName: fileName || 'unknown.pdf',
    fileId: fileId || '',
    output,
  };
}

export function shapedResume({ fileName, fileId, incoming }) {
  if (incoming && incoming.error != null) {
    return {
      fileName: fileName || 'unknown.pdf',
      fileId: fileId || '',
      output: `ERROR: The model did not return an extraction. ${asMessage(incoming.error)}`,
    };
  }
  const text = incoming && typeof incoming.output === 'string' ? incoming.output.trim() : '';
  return {
    fileName: fileName || 'unknown.pdf',
    fileId: fileId || '',
    output: text || 'The model returned an empty response for this resume.',
  };
}

export function aggregateResumes(items, generatedAt) {
  const section = (item, index) => {
    const name = item.fileName || `resume-${index + 1}.pdf`;
    const fileId = item.fileId ? `Drive file id: ${item.fileId}\n` : '';
    const body = typeof item.output === 'string' && item.output.trim() ? item.output.trim() : '(empty model output)';
    return `===== ${name} =====\n${fileId}\n${body}`;
  };
  const sections = items.map(section);
  const output = [
    'Batch resume extraction',
    `Generated: ${generatedAt}`,
    `Files: ${items.length}`,
    '',
    sections.join('\n\n'),
    '',
  ].join('\n');
  return { output, count: items.length };
}

export function emptyFolderReport(generatedAt) {
  const output = [
    'Batch resume extraction',
    `Generated: ${generatedAt}`,
    'Files: 0',
    '',
    'No PDF files were found in the input folder.',
    'The search keeps files whose MIME type is application/pdf and that are not in the trash.',
    '',
  ].join('\n');
  return { output, count: 0 };
}

export function readReportText(readNode) {
  const names = ['Aggregate Output', 'Empty Result'];
  for (const name of names) {
    try {
      const output = readNode(name);
      if (typeof output === 'string') return output;
    } catch {
      // The other branch did not run.
    }
  }
  throw new Error('No aggregated resume text was produced.');
}
