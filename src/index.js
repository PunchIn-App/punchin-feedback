// punchin-feedback — Worker entrypoint: routing + request/webhook/cron handlers.
// Account-free bug-report / feature-request intake. See
// docs/2026-06-07-punchin-feedback-design.md (§7 = the data flows).
//
// Static assets (/styles.css, /fonts/*) are served by Workers Static Assets
// (asset-first, not_found_handling="none"), so they never reach fetch(); every
// dynamic route below falls through here.

import { loadTemplate } from './templates.js';
import { buildIssue } from './issueBody.js';
import { installationToken, createIssue, verifyWebhook } from './github.js';
import { parseUploads, putImage, serveImage, scheduleExpiry, sweepExpired } from './attachments.js';
import { buildCopyEmail, buildClosedEmail, buildReopenEmail, sendEmail } from './email.js';
import { signUnsub, verifyUnsub } from './unsubscribe.js';
import { checkHoneypot, rateLimit, verifyTurnstile } from './spam.js';
import { renderForm, renderSuccess, renderError, renderMessage, sanitizeTheme, sanitizeAccent } from './render.js';
import { handleSetup, handleSetupCallback } from './setup.js';

const YEAR_MS = 365 * 24 * 3600 * 1000;
const DAY30_MS = 30 * 24 * 3600 * 1000;
const YEAR_S = 365 * 24 * 3600;
const DAYS90_S = 90 * 24 * 3600;
const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s || '');

const html = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
// `ui` carries the user's theme/accent (from the app) through error/success pages.
const htmlError = (env, msg, status, ui = {}) => html(renderError(msg, { accent: ui.accent || env.ACCENT, theme: ui.theme }), status);
const formError = (env, schema, kind, values, msg, status, ui = {}) =>
  html(renderForm(schema, { kind, turnstileSitekey: env.TURNSTILE_SITEKEY, accent: ui.accent || env.ACCENT, theme: ui.theme, prefill: prefillFrom(values), error: msg }), status);

function prefillFrom(values) {
  return { ...values.fields, title: values.title, reporterEmail: values.reporterEmail, notify: values.notify, _hp: values._hp };
}

function extractValues(fd, schema) {
  const fields = {};
  for (const f of schema.fields) {
    if (f.type === 'markdown') continue;
    const name = `f.${f.id}`;
    fields[f.id] = f.type === 'checkboxes' || (f.type === 'dropdown' && f.multiple) ? fd.getAll(name) : fd.get(name) ?? '';
  }
  return {
    title: fd.get('title') ?? '',
    fields,
    reporterEmail: (fd.get('reporter-email') ?? '').trim(),
    notify: { copy: fd.get('notify-copy') != null, closed: fd.get('notify-closed') != null, reopened: fd.get('notify-reopened') != null },
    _hp: fd.get('_hp') ?? '',
  };
}

function validate(schema, values) {
  if (!values.title.trim()) return 'Please enter a title.';
  for (const f of schema.fields) {
    if (f.type === 'markdown' || !f.required) continue;
    const v = values.fields[f.id];
    const empty = Array.isArray(v) ? v.length === 0 : !String(v ?? '').trim();
    if (empty) return `Please fill in "${f.label}".`;
  }
  return null;
}

// GET /bug | /feature
async function handleForm(request, env, kind) {
  const schema = await loadTemplate(env, kind);
  const prefill = {};
  for (const [k, v] of new URL(request.url).searchParams) prefill[k] = v;
  const theme = sanitizeTheme(prefill.theme);
  const accent = sanitizeAccent(prefill.accent) || env.ACCENT;
  return html(renderForm(schema, { kind, turnstileSitekey: env.TURNSTILE_SITEKEY, accent, theme, prefill }));
}

// POST /submit
async function handleSubmit(request, env) {
  const origin = new URL(request.url).origin;
  const ip = request.headers.get('CF-Connecting-IP') || '';
  let fd;
  try {
    fd = await request.formData();
  } catch {
    return htmlError(env, 'Invalid form submission.', 400);
  }
  // Theme + accent the app passed (carried through hidden fields) so the
  // error/success pages stay native too.
  const ui = { theme: sanitizeTheme(fd.get('theme')), accent: sanitizeAccent(fd.get('accent')) };
  const kind = fd.get('kind');
  if (kind !== 'bug' && kind !== 'feature') return htmlError(env, 'Unknown form.', 400, ui);

  const schema = await loadTemplate(env, kind);
  const values = extractValues(fd, schema);

  if (!checkHoneypot(values)) return htmlError(env, 'Submission rejected.', 400, ui);
  if (!(await verifyTurnstile(env, fd.get('cf-turnstile-response') || '', ip)))
    return formError(env, schema, kind, values, 'Please complete the verification challenge and try again.', 400, ui);
  if (!(await rateLimit(env, ip))) return formError(env, schema, kind, values, 'Too many submissions — please try again in a few minutes.', 429, ui);

  const invalid = validate(schema, values);
  if (invalid) return formError(env, schema, kind, values, invalid, 400, ui);

  const up = await parseUploads(fd, { max: Number(env.IMG_MAX_COUNT || 5), maxBytes: Number(env.IMG_MAX_BYTES || 5242880) });
  if (!up.ok) return formError(env, schema, kind, values, up.error, 400, ui);

  // Hard path: store images + create the issue. A failure here is the only
  // user-facing error (the filing didn't happen).
  const now = Date.now();
  let issue;
  const keys = [];
  let bodyMd = '';
  try {
    const imageUrls = [];
    for (const img of up.images) {
      const key = await putImage(env, img);
      keys.push(key);
      imageUrls.push(`${origin}/a/${key}`);
    }
    const built = buildIssue(schema, values, { imageUrls, provenanceLabel: env.PROVENANCE_LABEL || '' });
    bodyMd = built.body;
    issue = await createIssue(env, await installationToken(env), built);
  } catch {
    return formError(env, schema, kind, values, 'Sorry — we could not file your report right now. Please try again.', 502, ui);
  }

  // Best-effort: persistence + copy email never fail the already-filed issue.
  let emailed = false;
  try {
    const hasEmail = isEmail(values.reporterEmail);
    const wantsNotify = values.notify.copy || values.notify.closed || values.notify.reopened;
    if (hasEmail && wantsNotify) {
      await env.FEEDBACK.put(`issue:${issue.number}`, JSON.stringify({ email: values.reporterEmail, kind, createdAt: now, notify: values.notify, images: keys, imgYearClockStart: now }), { expirationTtl: YEAR_S });
    } else if (keys.length) {
      await env.FEEDBACK.put(`issue:${issue.number}`, JSON.stringify({ kind, createdAt: now, notify: { copy: false, closed: false, reopened: false }, images: keys, imgYearClockStart: now }), { expirationTtl: YEAR_S });
    }
    if (keys.length) await scheduleExpiry(env, keys, now + YEAR_MS);
    if (hasEmail && values.notify.copy) {
      const unsubUrl = `${origin}/unsubscribe?token=${await signUnsub(env.UNSUB_SECRET, issue.number)}`;
      await sendEmail(env, values.reporterEmail, buildCopyEmail({ issue, title: values.title, kind, bodyMarkdown: bodyMd, unsubUrl, appUrl: env.APP_URL }));
      emailed = true;
    }
  } catch {
    /* best-effort — the issue is already filed */
  }

  return html(renderSuccess({ number: issue.number, html_url: issue.html_url, emailed, accent: ui.accent || env.ACCENT, theme: ui.theme }));
}

// POST /webhook (GitHub App: issues.closed / issues.reopened)
async function handleWebhook(request, env) {
  const raw = await request.text();
  if (!(await verifyWebhook(env.GITHUB_WEBHOOK_SECRET, raw, request.headers.get('X-Hub-Signature-256'))))
    return new Response('bad signature', { status: 401 });

  const delivery = request.headers.get('X-GitHub-Delivery') || '';
  if (delivery) {
    if (await env.FEEDBACK.get(`seen:${delivery}`)) return new Response('duplicate', { status: 200 });
    await env.FEEDBACK.put(`seen:${delivery}`, '1', { expirationTtl: 600 });
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response('bad json', { status: 400 });
  }
  const action = event.action;
  const num = event.issue?.number;
  if ((action !== 'closed' && action !== 'reopened') || !num) return new Response('ok', { status: 200 });

  const map = await env.FEEDBACK.get(`issue:${num}`, 'json');
  if (!map) return new Response('ok', { status: 200 });

  const origin = new URL(request.url).origin;
  const issue = { number: num, html_url: event.issue.html_url };
  const title = event.issue.title;
  const now = Date.now();
  const yearStart = map.imgYearClockStart || map.createdAt || now;
  const unsubUrl = async () => `${origin}/unsubscribe?token=${await signUnsub(env.UNSUB_SECRET, num)}`;

  if (action === 'closed') {
    if (map.email && map.notify?.closed) {
      try {
        await sendEmail(env, map.email, buildClosedEmail({ issue, title, kind: map.kind, stateReason: event.issue.state_reason, unsubUrl: await unsubUrl(), appUrl: env.APP_URL }));
      } catch {}
    }
    map.closedAt = now;
    if (map.images?.length) await scheduleExpiry(env, map.images, Math.min(yearStart + YEAR_MS, now + DAY30_MS));
    await env.FEEDBACK.put(`issue:${num}`, JSON.stringify(map), { expirationTtl: DAYS90_S }); // purge email ~3mo after close
  } else {
    if (map.email && map.notify?.reopened) {
      try {
        await sendEmail(env, map.email, buildReopenEmail({ issue, title, kind: map.kind, unsubUrl: await unsubUrl(), appUrl: env.APP_URL }));
      } catch {}
    }
    map.imgYearClockStart = now; // reopening resets the 1-year clock
    delete map.closedAt;
    if (map.images?.length) await scheduleExpiry(env, map.images, now + YEAR_MS);
    await env.FEEDBACK.put(`issue:${num}`, JSON.stringify(map), { expirationTtl: YEAR_S });
  }
  return new Response('ok', { status: 200 });
}

// GET /unsubscribe?token=...
async function handleUnsubscribe(request, env) {
  const n = await verifyUnsub(env.UNSUB_SECRET, new URL(request.url).searchParams.get('token'));
  if (n == null) return htmlError(env, 'This unsubscribe link is invalid or has expired.', 400);
  const map = await env.FEEDBACK.get(`issue:${n}`, 'json');
  if (map) {
    delete map.email;
    map.notify = { copy: false, closed: false, reopened: false };
    await env.FEEDBACK.put(`issue:${n}`, JSON.stringify(map), { expirationTtl: YEAR_S });
  }
  return html(renderMessage('Unsubscribed', "You won't receive any more emails about this report.", { accent: env.ACCENT }));
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (pathname === '/') return Response.redirect(env.APP_URL, 302);
    if (pathname === '/bug') return handleForm(request, env, 'bug');
    if (pathname === '/feature') return handleForm(request, env, 'feature');
    if (pathname === '/submit') return request.method === 'POST' ? handleSubmit(request, env) : new Response('Method not allowed', { status: 405 });
    if (pathname === '/webhook') return request.method === 'POST' ? handleWebhook(request, env) : new Response('Method not allowed', { status: 405 });
    if (pathname === '/unsubscribe') return handleUnsubscribe(request, env);
    if (pathname === '/setup') return handleSetup(request, env);
    if (pathname === '/setup/callback') return handleSetupCallback(request, env);

    const asset = pathname.match(/^\/a\/([^/]+)$/);
    if (asset) return serveImage(env, asset[1]);

    return new Response('Not found', { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(sweepExpired(env));
  },
};
