export function collectFiles(pages) {
  const files = [];
  for (const page of pages) {
    const list = page && Array.isArray(page.files) ? page.files : [];
    for (const file of list) {
      if (!file || typeof file.id !== 'string' || !file.id.trim()) continue;
      if (file.mimeType !== 'application/pdf') continue;
      files.push({
        id: file.id.trim(),
        name: typeof file.name === 'string' && file.name.trim() ? file.name.trim() : `${file.id.trim()}.pdf`,
        mimeType: 'application/pdf',
      });
    }
  }

  const seen = new Set();
  const unique = [];
  for (const file of files) {
    if (seen.has(file.id)) continue;
    seen.add(file.id);
    unique.push(file);
  }
  unique.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  return { files: unique, count: unique.length };
}
