// Format submitted form values into the exact markdown GitHub produces for an
// issue-form submission, so a web-filed issue is indistinguishable from a native
// one. Rules verified 2026-06-07 (see design §7 / plan Appendix A§1):
//   - each field -> `### <label>` + blank line + value, fields separated by a blank line
//   - type:markdown is display-only and excluded from the body
//   - empty optional input/textarea -> `_No response_`; empty dropdown -> `None`
//   - dropdown multi-select joined by ", "; checkboxes -> `- [x]` / `- [ ]`
//   - textarea with `render:<lang>` -> value wrapped in a ```<lang> fence
//     (widened past any backtick run in the value — see the fence note below)
//   - headings use the field LABEL, not the id

const toArray = (raw) => (Array.isArray(raw) ? raw : raw == null ? [] : [raw]);

// Everything below is anonymous public input filed under our own GitHub App
// identity, so two markdown abuses have to be closed off.
//
// 1. Mentions. "@octocat" / "@org/team" in an issue body notifies real people
//    from our identity — a free spam-and-harassment relay. A zero-width space
//    after the @ stops GitHub's mention filter from linkifying it (a username
//    must follow the @ immediately) while the text still reads as "@octocat".
//    Only an @ that could start a mention is touched, so a bare "@" survives.
//    NOT applied inside code fences: GitHub's mention filter already skips
//    pre/code, and injecting invisible characters into pasted code would corrupt
//    it for anyone who copies it back out (`@media`, decorators, annotations).
const ZWSP = '​';
const sanitize = (raw) => String(raw ?? '').trim().replace(/@(?=[A-Za-z0-9])/g, `@${ZWSP}`);

// 2. Fence escape. A fixed ``` fence is closed by any ``` the submitter includes,
//    after which the rest of their value is rendered as markdown inside a section
//    that looks machine-generated. Use a fence one backtick longer than the
//    longest run in the value, which CommonMark guarantees cannot be closed early.
function fenceFor(value) {
  const longest = (value.match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function renderField(field, raw) {
  if (field.type === 'dropdown') {
    // Option values are client-supplied (the form is just HTML) — sanitize them.
    const vals = toArray(raw).map(sanitize).filter(Boolean);
    return vals.length ? vals.join(', ') : 'None';
  }
  if (field.type === 'checkboxes') {
    // Label text comes from the schema, not the submission; only the ticks do —
    // and an exact match against the schema options is the strictest form of that.
    const selected = new Set(toArray(raw));
    return field.options.map((opt) => `- [${selected.has(opt) ? 'x' : ' '}] ${opt}`).join('\n');
  }
  // input / textarea
  if (field.type === 'textarea' && field.render) {
    const code = String(raw ?? '').trim();
    if (!code) return '_No response_';
    const fence = fenceFor(code);
    return fence + field.render + '\n' + code + '\n' + fence;
  }
  const v = sanitize(raw);
  if (!v) return '_No response_';
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
    title: sanitize(values.title),
    body: formatIssueBody(schema, values, { imageUrls }),
    labels,
  };
}
