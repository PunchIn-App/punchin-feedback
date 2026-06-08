// Format submitted form values into the exact markdown GitHub produces for an
// issue-form submission, so a web-filed issue is indistinguishable from a native
// one. Rules verified 2026-06-07 (see design §7 / plan Appendix A§1):
//   - each field -> `### <label>` + blank line + value, fields separated by a blank line
//   - type:markdown is display-only and excluded from the body
//   - empty optional input/textarea -> `_No response_`; empty dropdown -> `None`
//   - dropdown multi-select joined by ", "; checkboxes -> `- [x]` / `- [ ]`
//   - textarea with `render:<lang>` -> value wrapped in a ```<lang> fence
//   - headings use the field LABEL, not the id

const toArray = (raw) => (Array.isArray(raw) ? raw : raw == null ? [] : [raw]);

function renderField(field, raw) {
  if (field.type === 'dropdown') {
    const vals = toArray(raw).filter(Boolean);
    return vals.length ? vals.join(', ') : 'None';
  }
  if (field.type === 'checkboxes') {
    const selected = new Set(toArray(raw));
    return field.options.map((opt) => `- [${selected.has(opt) ? 'x' : ' '}] ${opt}`).join('\n');
  }
  // input / textarea
  const v = String(raw ?? '').trim();
  if (!v) return '_No response_';
  if (field.type === 'textarea' && field.render) return '```' + field.render + '\n' + v + '\n```';
  return v;
}

// schema + values -> issue body markdown (Screenshots section appended if any).
export function formatIssueBody(schema, values, { imageUrls = [] } = {}) {
  const fieldValues = values.fields || {};
  const blocks = [];
  for (const field of schema.fields) {
    if (field.type === 'markdown') continue;
    blocks.push(`### ${field.label}\n\n${renderField(field, fieldValues[field.id])}`);
  }
  if (imageUrls.length) {
    const imgs = imageUrls.map((u, i) => `![screenshot ${i + 1}](${u})`).join('\n');
    blocks.push(`### Screenshots\n\n${imgs}`);
  }
  return blocks.join('\n\n');
}

// schema + values -> { title, body, labels } for the GitHub create-issue call.
export function buildIssue(schema, values, { imageUrls = [], provenanceLabel = '' } = {}) {
  const labels = [...(schema.labels || [])];
  if (provenanceLabel) labels.push(provenanceLabel);
  return {
    title: String(values.title ?? '').trim(),
    body: formatIssueBody(schema, values, { imageUrls }),
    labels,
  };
}
