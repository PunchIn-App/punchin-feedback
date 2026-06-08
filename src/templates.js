// Parse a GitHub issue-form (.github/ISSUE_TEMPLATE/*.yml) into the field schema
// used to render the form and format the issue body, and load it live from the
// target repo (cached in KV) with a bundled offline fallback. See design §5.
import { load } from 'js-yaml';
import { bundled } from './bundledTemplates.js';

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

  const file = FILES[kind];
  const url = `https://raw.githubusercontent.com/${env.REPO_OWNER}/${env.REPO_NAME}/${env.TEMPLATE_REF}/.github/ISSUE_TEMPLATE/${file}`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'punchin-feedback' } });
    if (r.ok) {
      const schema = parseIssueForm(await r.text());
      await env.FEEDBACK.put(`tpl:${kind}`, JSON.stringify(schema), { expirationTtl: CACHE_TTL });
      return schema;
    }
  } catch {
    /* fall through to bundled */
  }
  return parseIssueForm(bundled[kind]);
}
