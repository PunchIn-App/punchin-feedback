import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import worker from '../src/index.js';
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
    const res = await worker.fetch(req('/webhook', { method: 'POST', body, headers: { 'X-Hub-Signature-256': await sign(env.GITHUB_WEBHOOK_SECRET, body), 'X-GitHub-Delivery': 'd1' } }), env, ctx);
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
    const res = await worker.fetch(req('/webhook', { method: 'POST', body, headers: { 'X-Hub-Signature-256': await sign(env.GITHUB_WEBHOOK_SECRET, body), 'X-GitHub-Delivery': 'r1' } }), env, ctx);
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
