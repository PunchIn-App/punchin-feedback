// Reporter emails: a copy on submit, plus close/reopen follow-ups. Every message
// carries the unsubscribe link as the FIRST line of the body, a List-Unsubscribe
// header (https only) + One-Click, and a disclosure of why it was received.
// Sent via the Workers send_email binding (from object uses `email`, not `address`).
// See design §9 / plan Appendix A§5.

const KIND_LABEL = { bug: 'bug report', feature: 'feature request' };

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function headersFor(unsubUrl) {
  return { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

function compose({ unsubUrl, contentText, contentHtml, appUrl }) {
  const disclosure =
    `You're receiving this because someone submitted feedback at ${appUrl} and asked for updates. ` +
    `If this wasn't you, you can ignore it or unsubscribe above.`;
  const text = `Unsubscribe: ${unsubUrl}\n\n${contentText}\n\n—\n${disclosure}`;
  const html =
    `<p style="font:12px sans-serif"><a href="${unsubUrl}">Unsubscribe from these emails</a></p>` +
    `<div style="font:14px/1.6 sans-serif">${contentHtml}</div>` +
    `<hr><p style="font:12px sans-serif;color:#666">${escapeHtml(disclosure)}</p>`;
  return { text, html };
}

export function buildCopyEmail({ issue, title, kind, bodyMarkdown, unsubUrl, appUrl }) {
  const label = KIND_LABEL[kind] || 'submission';
  const lead = `Thanks! Your ${label} was filed as #${issue.number}: "${title}". Track it here: ${issue.html_url}`;
  const contentText = `${lead}\n\nHere's a copy of what you submitted:\n\n${bodyMarkdown}`;
  const contentHtml =
    `<p>${escapeHtml(lead)}</p><p><strong>Your submission:</strong></p>` +
    `<pre style="white-space:pre-wrap">${escapeHtml(bodyMarkdown)}</pre>`;
  return { subject: `Your ${label} was filed: #${issue.number} — ${title}`, ...compose({ unsubUrl, contentText, contentHtml, appUrl }), headers: headersFor(unsubUrl) };
}

export function buildClosedEmail({ issue, title, kind, stateReason, unsubUrl, appUrl }) {
  const label = KIND_LABEL[kind] || 'submission';
  const reason = stateReason === 'not_planned' ? ' as not planned' : stateReason === 'completed' ? ' as completed' : '';
  const lead = `Your ${label} #${issue.number} ("${title}") was closed${reason}. ${issue.html_url}`;
  return { subject: `Closed: #${issue.number} — ${title}`, ...compose({ unsubUrl, contentText: lead, contentHtml: `<p>${escapeHtml(lead)}</p>`, appUrl }), headers: headersFor(unsubUrl) };
}

export function buildReopenEmail({ issue, title, kind, unsubUrl, appUrl }) {
  const label = KIND_LABEL[kind] || 'submission';
  const lead = `Your ${label} #${issue.number} ("${title}") was reopened. ${issue.html_url}`;
  return { subject: `Reopened: #${issue.number} — ${title}`, ...compose({ unsubUrl, contentText: lead, contentHtml: `<p>${escapeHtml(lead)}</p>`, appUrl }), headers: headersFor(unsubUrl) };
}

export function buildCommentEmail({ issue, title, kind, author, commentBody, commentUrl, unsubUrl, replyTo, appUrl }) {
  const label = KIND_LABEL[kind] || 'submission';
  const lead = `${author} commented on your ${label} #${issue.number} ("${title}"):`;
  const replyLine = replyTo ? 'Reply to this email to respond on the issue.' : '';
  const contentText = `${lead}\n\n${commentBody}\n\nView: ${commentUrl}${replyLine ? `\n\n${replyLine}` : ''}`;
  const contentHtml =
    `<p>${escapeHtml(lead)}</p>` +
    `<blockquote style="border-left:3px solid #888;padding-left:10px;color:#444;white-space:pre-wrap">${escapeHtml(commentBody)}</blockquote>` +
    `<p><a href="${escapeHtml(commentUrl)}">View on the issue</a></p>` +
    (replyLine ? `<p>${escapeHtml(replyLine)}</p>` : '');
  return {
    subject: `New comment on #${issue.number} — ${title}`,
    ...compose({ unsubUrl, contentText, contentHtml, appUrl }),
    headers: headersFor(unsubUrl),
    replyTo,
  };
}

export async function sendEmail(env, to, msg) {
  return env.EMAIL.send({
    to,
    from: { email: env.FROM_ADDRESS, name: 'PunchIn Feedback' },
    ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    headers: msg.headers,
  });
}
