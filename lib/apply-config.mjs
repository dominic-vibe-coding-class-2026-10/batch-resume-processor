import { checkConfig } from './check-config.mjs';

const KEYS = ['client_id', 'client_secret', 'refresh_token', 'folder_in', 'folder_out'];

export function applyConfigValues(workflow, config) {
  const checked = checkConfig(config);
  const next = structuredClone(workflow);
  const node = next.nodes.find((item) => item.name === 'Config');
  if (!node) throw new Error('The workflow has no Config node.');
  const assignments = node.parameters?.assignments?.assignments;
  if (!Array.isArray(assignments)) throw new Error('The Config node has no assignments.');
  for (const key of KEYS) {
    const row = assignments.find((item) => item.name === key);
    if (!row) throw new Error(`The Config node is missing ${key}.`);
    row.value = checked[key];
  }
  return next;
}
