import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import worker, { stripQuoted } from '../src/index.js';
import { makeEnv, ctx, routeFetch } from './helpers.js';
import { bundled } from '../src/bundledTemplates.js';
import { signUnsub } from '../src/unsubscribe.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const URLBASE = 'https://feedback.trackmytime.today';
const req = (path, init) => new Request(`${URLBASE}${path}`, init);

const ghRoutes = {
  'GET raw.githubusercontent.com': () => new Response(bundled.bug),
  'GET /installation': () => Response.json({ id: 1 }),
  'POST /access_tokens': () => new Response(JSON.stringify({ token: 'ghs', expires_at: new Date(Date.now() + 3600e3).toISOString() }), { status: 201 }),
  'POST /issues': () => new Response(JSON.stringify({ number: 101, html_url: 'https://github.com/PunchIn-App/punchin/issues/101' }), { status: 201 }),
};

function bugForm(extra = {}) {
  const fd = new FormData();
  const base = {
    kind: 'bug', title: 'Timer drifts', 'f.what-happened': 'wrong', 'f.steps': '1. start',
    'f.expected': 'right', 'f.version': '0.21.0', 'f.install-type': 'PWA (installed to home screen)',
    'f.browser': 'Chrome 124', 'f.os': 'macOS 14.4', 'f.device': 'desktop', _hp: '',
  };
  for (const [k, v] of Object.entries({ ...base, ...extra })) fd.set(k, v);
  return fd;
}

async function sign(secret, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return 'sha256=' + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let pem;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const b = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))));
  pem = `-----BEGIN PRIVATE KEY-----\n${b.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
});
afterEach(() => vi.unstubAllGlobals());

describe('GET /bug', () => {
  it('renders the bug form', async () => {
    vi.stubGlobal('fetch', routeFetch(ghRoutes));
    const res = await worker.fetch(req('/bug'), makeEnv(), ctx);
    expect(res.status).toBe(200);
    const t = await res.text();
    expect(t).toContain('Steps to reproduce');
    expect(t).toContain('name="title"');
  });

  it('applies theme + accent passed from the app via query params', async () => {
    vi.stubGlobal('fetch', routeFetch(ghRoutes));
    const res = await worker.fetch(req('/bug?theme=light&accent=%23FF8FA3'), makeEnv(), ctx);
    const t = await res.text();
    expect(t).toContain('class="theme-light"');
    expect(t).toContain('--accent:#FF8FA3');
  });
});

describe('POST /submit', () => {
  it('files the issue, stores the mapping + expiry, and emails a copy', async () => {
    const env = makeEnv({ GITHUB_APP_PRIVATE_KEY: pem });
    vi.stubGlobal('fetch', routeFetch(ghRoutes));
    const fd = bugForm({ 'reporter-email': 'r@example.com', 'notify-copy': 'on' });
    fd.append('screenshots', new File([PNG], 's.png', { type: 'image/png' }));
    const res = await worker.fetch(req('/submit', { method: 'POST', body: fd }), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('#101');

    const map = await env.FEEDBACK.get('issue:101', 'json');
    expect(map.email).toBe('r@example.com');
    expect(map.images).toHaveLength(1);
    expect(map.imgYearClockStart).toBeTypeOf('number');
    expect((await env.FEEDBACK.list({ prefix: 'expire:' })).keys.length).toBe(1);
    expect(env.EMAIL.sent).toHaveLength(1);
    expect(env.EMAIL.sent[0].to).toBe('r@example.com');
  });

  it('the copy email carries a reply address when ENABLE_EMAIL_REPLIES is on', async () => {
    const env = makeEnv({ GITHUB_APP_PRIVATE_KEY: pem, ENABLE_EMAIL_REPLIES: '1' });
    vi.stubGlobal('fetch', routeFetch(ghRoutes));
    await worker.fetch(req('/submit', { method: 'POST', body: bugForm({ 'reporter-email': 'r@example.com', 'notify-copy': 'on' }) }), env, ctx);
    expect(env.EMAIL.sent[0].replyTo).toMatch(/^comment\+[0-9a-f]+@trackmytime\.today$/);
    expect(env.EMAIL.sent[0].text).toContain('Reply to this email to add a comment');
    expect((await env.FEEDBACK.list({ prefix: 'reply:' })).keys.length).toBe(1);
  });

  it('a failing email never fails the already-filed issue (best-effort)', async () => {
    const env = makeEnv({ GITHUB_APP_PRIVATE_KEY: pem });
    env.EMAIL.send = async () => { throw new Error('smtp down'); };
    vi.stubGlobal('fetch', routeFetch(ghRoutes));
    const res = await worker.fetch(req('/submit', { method: 'POST', body: bugForm({ 'reporter-email': 'r@example.com', 'notify-copy': 'on' }) }), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('#101');
  });

  it('createIssue failure shows an error (502)', async () => {
    const env = makeEnv({ GITHUB_APP_PRIVATE_KEY: pem });
    vi.stubGlobal('fetch', routeFetch({ ...ghRoutes, 'POST /issues': () => new Response('boom', { status: 500 }) }));
    const res = await worker.fetch(req('/submit', { method: 'POST', body: bugForm() }), env, ctx);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('could not file');
  });

  it('rejects a filled honeypot without filing', async () => {
    const env = makeEnv({ GITHUB_APP_PRIVATE_KEY: pem });
    let issued = false;
    vi.stubGlobal('fetch', routeFetch({ ...ghRoutes, 'POST /issues': () => { issued = true; return new Response('{}', { status: 201 }); } }));
    const res = await worker.fetch(req('/submit', { method: 'POST', body: bugForm({ _hp: 'bot' }) }), env, ctx);
    expect(res.status).toBe(400);
    expect(issued).toBe(false);
  });

  it('carries from=app through to an overlay-safe success page (issue #6)', async () => {
    const env = makeEnv({ GITHUB_APP_PRIVATE_KEY: pem });
    vi.stubGlobal('fetch', routeFetch(ghRoutes));
    // GET: the app's link includes ?from=app → no root links, hidden field set
    const form = await (await worker.fetch(req('/bug?from=app'), env, ctx)).text();
    expect(form).toContain('<input type="hidden" name="from" value="app">');
    expect(form).not.toContain('href="/"');
    // POST: the carried field makes the success page overlay-safe too
    const res = await worker.fetch(req('/submit', { method: 'POST', body: bugForm({ from: 'app' }) }), env, ctx);
    expect(res.status).toBe(200);
    const t = await res.text();
    expect(t).toContain('close this window');
    expect(t).not.toContain('href="/"');
  });

  it('a form error keeps the app context (from field survives the re-render)', async () => {
    const env = makeEnv({ GITHUB_APP_PRIVATE_KEY: pem });
    vi.stubGlobal('fetch', routeFetch(ghRoutes));
    const res = await worker.fetch(req('/submit', { method: 'POST', body: bugForm({ from: 'app', title: '' }) }), env, ctx);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('<input type="hidden" name="from" value="app">');
  });

  it('rejects a missing required field with a form error', async () => {
    const env = makeEnv({ GITHUB_APP_PRIVATE_KEY: pem });
    vi.stubGlobal('fetch', routeFetch(ghRoutes));
    const fd = bugForm();
    fd.delete('f.steps');
    const res = await worker.fetch(req('/submit', { method: 'POST', body: fd }), env, ctx);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Steps to reproduce');
  });
});

describe('POST /webhook', () => {
  it('closed: emails, records closedAt, schedules expiry', async () => {
    const env = makeEnv();
    await env.FEEDBACK.put('issue:101', JSON.stringify({ email: 'r@example.com', kind: 'bug', createdAt: Date.now(), notify: { copy: true, closed: true, reopened: true }, images: ['k1.png'], imgYearClockStart: Date.now() }));
    const body = JSON.stringify({ action: 'closed', issue: { number: 101, html_url: 'https://x/101', title: 'T', state_reason: 'completed' } });
    const res = await worker.fetch(req('/webhook', { method: 'POST', body, headers: { 'X-Hub-Signature-256': await sign(env.GITHUB_WEBHOOK_SECRET, body), 'X-GitHub-Delivery': 'd1', 'X-GitHub-Event': 'issues' } }), env, ctx);
    expect(res.status).toBe(200);
    expect(env.EMAIL.sent[0].subject).toContain('Closed');
    const map = await env.FEEDBACK.get('issue:101', 'json');
    expect(map.closedAt).toBeTypeOf('number');
    expect((await env.FEEDBACK.list({ prefix: 'expire:' })).keys.length).toBe(1);
  });

  it('reopened: emails, resets the year clock, clears closedAt', async () => {
    const env = makeEnv();
    const old = Date.now() - 1e9;
    await env.FEEDBACK.put('issue:7', JSON.stringify({ email: 'r@e.com', kind: 'bug', notify: { reopened: true }, images: ['k.png'], createdAt: old, imgYearClockStart: old, closedAt: old }));
    const body = JSON.stringify({ action: 'reopened', issue: { number: 7, html_url: 'x', title: 'T' } });
    const res = await worker.fetch(req('/webhook', { method: 'POST', body, headers: { 'X-Hub-Signature-256': await sign(env.GITHUB_WEBHOOK_SECRET, body), 'X-GitHub-Delivery': 'r1', 'X-GitHub-Event': 'issues' } }), env, ctx);
    expect(res.status).toBe(200);
    expect(env.EMAIL.sent[0].subject).toContain('Reopened');
    const map = await env.FEEDBACK.get('issue:7', 'json');
    expect(map.imgYearClockStart).toBeGreaterThan(old);
    expect(map.closedAt).toBeUndefined();
  });

  it('rejects a bad signature (401)', async () => {
    const env = makeEnv();
    const body = JSON.stringify({ action: 'closed', issue: { number: 1 } });
    const res = await worker.fetch(req('/webhook', { method: 'POST', body, headers: { 'X-Hub-Signature-256': 'sha256=00' } }), env, ctx);
    expect(res.status).toBe(401);
  });

  it('is idempotent on a duplicate delivery id', async () => {
    const env = makeEnv();
    await env.FEEDBACK.put('seen:dup', '1');
    await env.FEEDBACK.put('issue:5', JSON.stringify({ email: 'r@e.com', kind: 'bug', notify: { closed: true }, images: [], createdAt: Date.now(), imgYearClockStart: Date.now() }));
    const body = JSON.stringify({ action: 'closed', issue: { number: 5, html_url: 'x', title: 'T' } });
    const res = await worker.fetch(req('/webhook', { method: 'POST', body, headers: { 'X-Hub-Signature-256': await sign(env.GITHUB_WEBHOOK_SECRET, body), 'X-GitHub-Delivery': 'dup' } }), env, ctx);
    expect(res.status).toBe(200);
    expect(env.EMAIL.sent).toHaveLength(0);
  });
});

describe('POST /webhook issue_comment', () => {
  const commentReq = async (env, body, delivery) =>
    worker.fetch(req('/webhook', { method: 'POST', body, headers: { 'X-Hub-Signature-256': await sign(env.GITHUB_WEBHOOK_SECRET, body), 'X-GitHub-Delivery': delivery, 'X-GitHub-Event': 'issue_comment' } }), env, ctx);

  it('emails the reporter on a human comment (opted-in); reply address when replies are enabled', async () => {
    const env = makeEnv({ ENABLE_EMAIL_REPLIES: '1' });
    await env.FEEDBACK.put('issue:101', JSON.stringify({ email: 'r@e.com', kind: 'bug', notify: { commented: true }, images: [], createdAt: Date.now(), imgYearClockStart: Date.now() }));
    const body = JSON.stringify({ action: 'created', issue: { number: 101, html_url: 'x', title: 'T' }, comment: { body: 'Which browser?', html_url: 'x#c', user: { login: 'maint', type: 'User' } } });
    const res = await commentReq(env, body, 'c1');
    expect(res.status).toBe(200);
    expect(env.EMAIL.sent[0].subject).toContain('New comment');
    expect(env.EMAIL.sent[0].text).toContain('Which browser?');
    expect(env.EMAIL.sent[0].replyTo).toMatch(/^comment\+[0-9a-f]+@trackmytime\.today$/);
    expect((await env.FEEDBACK.list({ prefix: 'reply:' })).keys.length).toBe(1);
  });

  it('omits the reply address when replies are not enabled (no bounce risk)', async () => {
    const env = makeEnv(); // ENABLE_EMAIL_REPLIES off
    await env.FEEDBACK.put('issue:101', JSON.stringify({ email: 'r@e.com', kind: 'bug', notify: { commented: true } }));
    const body = JSON.stringify({ action: 'created', issue: { number: 101, html_url: 'x', title: 'T' }, comment: { body: 'hi', html_url: 'x', user: { login: 'm', type: 'User' } } });
    await commentReq(env, body, 'c1b');
    expect(env.EMAIL.sent[0].subject).toContain('New comment');
    expect(env.EMAIL.sent[0].replyTo).toBeUndefined();
    expect((await env.FEEDBACK.list({ prefix: 'reply:' })).keys.length).toBe(0);
  });

  it('skips bot/app comments (no notification loop)', async () => {
    const env = makeEnv();
    await env.FEEDBACK.put('issue:101', JSON.stringify({ email: 'r@e.com', kind: 'bug', notify: { commented: true } }));
    const body = JSON.stringify({ action: 'created', issue: { number: 101, html_url: 'x', title: 'T' }, comment: { body: 'reposted', html_url: 'x', user: { login: 'app', type: 'Bot' } } });
    await commentReq(env, body, 'c2');
    expect(env.EMAIL.sent).toHaveLength(0);
  });

  it('does not email when the reporter did not opt into comments', async () => {
    const env = makeEnv();
    await env.FEEDBACK.put('issue:101', JSON.stringify({ email: 'r@e.com', kind: 'bug', notify: { commented: false } }));
    const body = JSON.stringify({ action: 'created', issue: { number: 101, html_url: 'x', title: 'T' }, comment: { body: 'hi', html_url: 'x', user: { login: 'm', type: 'User' } } });
    await commentReq(env, body, 'c3');
    expect(env.EMAIL.sent).toHaveLength(0);
  });
});

describe('stripQuoted', () => {
  it('keeps the new text and drops quoted history / signature', () => {
    expect(stripQuoted('My reply.\n\nOn Mon, X wrote:\n> old')).toBe('My reply.');
    expect(stripQuoted('Hi there\n> quoted')).toBe('Hi there');
    expect(stripQuoted('Thanks\n--\nSent from my phone')).toBe('Thanks');
    expect(stripQuoted('Answer\n______________\nFrom: someone')).toBe('Answer');
  });
});

describe('email() — inbound reply → comment', () => {
  const msg = ({ from, to, raw }) => ({ from, to, raw: new Response(raw).body, headers: new Headers() });
  const drain = async (m, env) => { let p; await worker.email(m, env, { waitUntil: (x) => { p = x; } }); await p; };
  // Token-flow only (no 'POST /issues' — the comments URL contains '/issues' and
  // would match it first under routeFetch's substring matching).
  const tokenRoutes = {
    'GET /installation': () => Response.json({ id: 1 }),
    'POST /access_tokens': () => new Response(JSON.stringify({ token: 't', expires_at: new Date(Date.now() + 3600e3).toISOString() }), { status: 201 }),
  };

  it('posts the reporter reply as a comment, stripping quoted text', async () => {
    const env = makeEnv({ GITHUB_APP_PRIVATE_KEY: pem });
    await env.FEEDBACK.put('reply:abc', '101');
    await env.FEEDBACK.put('issue:101', JSON.stringify({ email: 'r@e.com', kind: 'bug' }));
    const mime = ['From: r@e.com', 'To: comment+abc@trackmytime.today', 'Content-Type: text/plain; charset=utf-8', '', 'It was Chrome 124 on macOS.', '', 'On Mon, maintainer wrote:', '> Which browser?', ''].join('\r\n');
    let commentBody;
    vi.stubGlobal('fetch', routeFetch({ ...tokenRoutes, 'POST /comments': (r) => { commentBody = JSON.parse(r.init.body).body; return new Response(JSON.stringify({ id: 1 }), { status: 201 }); } }));
    await drain(msg({ from: 'r@e.com', to: 'comment+abc@trackmytime.today', raw: mime }), env);
    expect(commentBody).toContain('It was Chrome 124');
    expect(commentBody).toContain('Reply from the reporter');
    expect(commentBody).not.toContain('Which browser?');
  });

  it('ignores an unknown reply address', async () => {
    const env = makeEnv({ GITHUB_APP_PRIVATE_KEY: pem });
    let posted = false;
    vi.stubGlobal('fetch', routeFetch({ ...tokenRoutes, 'POST /comments': () => { posted = true; return new Response('{}', { status: 201 }); } }));
    await drain(msg({ from: 'r@e.com', to: 'comment+nope@trackmytime.today', raw: 'From: r@e.com\r\n\r\nhi' }), env);
    expect(posted).toBe(false);
  });

  it('ignores a reply from someone other than the reporter', async () => {
    const env = makeEnv({ GITHUB_APP_PRIVATE_KEY: pem });
    await env.FEEDBACK.put('reply:abc', '101');
    await env.FEEDBACK.put('issue:101', JSON.stringify({ email: 'r@e.com', kind: 'bug' }));
    let posted = false;
    vi.stubGlobal('fetch', routeFetch({ ...tokenRoutes, 'POST /comments': () => { posted = true; return new Response('{}', { status: 201 }); } }));
    const mime = 'From: attacker@evil.com\r\nTo: comment+abc@trackmytime.today\r\nContent-Type: text/plain\r\n\r\nmalicious';
    await drain(msg({ from: 'attacker@evil.com', to: 'comment+abc@trackmytime.today', raw: mime }), env);
    expect(posted).toBe(false);
  });
});

describe('GET /unsubscribe', () => {
  it('valid token clears email + notify', async () => {
    const env = makeEnv();
    await env.FEEDBACK.put('issue:9', JSON.stringify({ email: 'r@e.com', kind: 'bug', notify: { copy: true, closed: true, reopened: true }, images: [], createdAt: Date.now(), imgYearClockStart: Date.now() }));
    const res = await worker.fetch(req('/unsubscribe?token=' + (await signUnsub(env.UNSUB_SECRET, 9))), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Unsubscribed');
    const map = await env.FEEDBACK.get('issue:9', 'json');
    expect(map.email).toBeUndefined();
    expect(map.notify.closed).toBe(false);
  });

  it('bad token -> 400', async () => {
    const res = await worker.fetch(req('/unsubscribe?token=bad'), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });
});

describe('GET /a/<key> and scheduled', () => {
  it('serves a stored image', async () => {
    const env = makeEnv();
    await env.ATTACHMENTS.put('pic.png', PNG, { httpMetadata: { contentType: 'image/png' } });
    const res = await worker.fetch(req('/a/pic.png'), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it('scheduled() sweeps due images', async () => {
    const env = makeEnv();
    await env.ATTACHMENTS.put('old.png', PNG, { httpMetadata: { contentType: 'image/png' } });
    await env.FEEDBACK.put(`expire:${Date.now() - 1000}:old.png`, '1');
    let waited;
    await worker.scheduled({ cron: '0 3 * * *' }, env, { waitUntil: (p) => { waited = p; } });
    await waited;
    expect(await env.ATTACHMENTS.get('old.png')).toBe(null);
  });
});
