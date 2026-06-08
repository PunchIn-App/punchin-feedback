// Parse a GitHub issue-form (.github/ISSUE_TEMPLATE/*.yml) into the field schema
// used to render the form and format the issue body, and load it live from the
// target repo (cached in KV) with a bundled offline fallback. See design §5.
import { load } from 'js-yaml';
import { bundled } from './bundledTemplates.js';
import { installationToken } from './github.js';

const FILES = { bug: 'bug_report.yml', feature: 'feature_request.yml' };
const CACHE_TTL = 21600; // 6h

// Pure: YAML text -> locked field schema (see plan "Interface contracts").
export function parseIssueForm(text) {
  const doc = load(text) || {};
  const fields = (doc.body || []).map((entry) => {
    const a = entry.attributes || {};
    return {
      type: entry.type,
      id: entry.id ?? null,
      label: a.label ?? '',
      description: a.description ?? '',
      placeholder: a.placeholder ?? '',
      value: a.value ?? '', // markdown blocks' instructional text (display only)
      required: entry.validations?.required === true,
      // dropdown options are strings; checkboxes options are {label,...} objects.
      options: (a.options || []).map((o) => (typeof o === 'string' ? o : o.label)),
      multiple: a.multiple === true,
      render: a.render ?? null,
    };
  });
  const labels = Array.isArray(doc.labels) ? doc.labels : doc.labels ? [doc.labels] : [];
  return { name: doc.name ?? '', description: doc.description ?? '', labels, titlePrefix: doc.title ?? null, fields };
}

// I/O: serve the KV-cached schema (TTL gives the "refresh every few hours"
// behaviour); on a cache miss fetch the live template, parse, and cache it; if
// GitHub is unreachable fall back to the bundled copy. Cache-FIRST so a normal
// request neither calls GitHub nor writes KV (avoids the 1-write/s/key limit).
export async function loadTemplate(env, kind) {
  const cached = await env.FEEDBACK.get(`tpl:${kind}`, 'json');
  if (cached) return cached;

  // Fetch the live template via the authenticated GitHub Contents API (works for
  // a PRIVATE repo; needs the App's `Contents: read` permission). On any failure
  // — App not yet granted Contents:read, repo/file missing, unreachable — fall
  // back to the bundled copy. Either way cache the result so we don't re-probe on
  // every request, and so it auto-upgrades to live once the permission is granted.
  let schema;
  try {
    const text = await fetchLiveTemplate(env, FILES[kind]);
    if (text) schema = parseIssueForm(text);
  } catch {
    /* fall back to bundled */
  }
  if (!schema) schema = parseIssueForm(bundled[kind]);
  await env.FEEDBACK.put(`tpl:${kind}`, JSON.stringify(schema), { expirationTtl: CACHE_TTL });
  return schema;
}

// Raw file contents from the GitHub Contents API using the App installation token.
// Returns the YAML text, or null if the API didn't return it.
async function fetchLiveTemplate(env, file) {
  const token = await installationToken(env);
  const url = `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/.github/ISSUE_TEMPLATE/${file}?ref=${env.TEMPLATE_REF}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.raw',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'punchin-feedback',
    },
  });
  if (!r.ok) return null;
  // With the `.raw` media type the body is the file itself; if the API instead
  // returned JSON, decode the base64 `content` (UTF-8 safe).
  if ((r.headers.get('content-type') || '').includes('json')) {
    const json = await r.json();
    if (!json.content) return null;
    return new TextDecoder().decode(Uint8Array.from(atob(json.content.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
  }
  return await r.text();
}
