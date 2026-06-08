import { describe, it, expect, vi, afterEach } from 'vitest';
import { appJwt, installationToken, createIssue, verifyWebhook } from '../src/github.js';
import { makeEnv, routeFetch } from './helpers.js';

// --- helpers: generate a throwaway RSA key + base64url decode -----------------
function toPem(buf, label) {
  const b = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return `-----BEGIN ${label}-----\n${b.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}
async function genKey() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  return { pem: toPem(await crypto.subtle.exportKey('pkcs8', pair.privateKey), 'PRIVATE KEY'), publicKey: pair.publicKey };
}
function atobUrl(s) {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return atob(t);
}
function b64urlToBytes(s) {
  const bin = atobUrl(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

describe('appJwt', () => {
  it('produces a verifiable RS256 JWT with sane claims', async () => {
    const { pem, publicKey } = await genKey();
    const jwt = await appJwt('client-id-123', pem);
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(atobUrl(h))).toEqual({ alg: 'RS256', typ: 'JWT' });
    const payload = JSON.parse(atobUrl(p));
    expect(payload.iss).toBe('client-id-123');
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    const ok = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' }, publicKey, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`)
    );
    expect(ok).toBe(true);
  });
});

describe('installationToken', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('mints once and serves from cache thereafter', async () => {
    const { pem } = await genKey();
    const env = makeEnv({ GITHUB_APP_PRIVATE_KEY: pem, GITHUB_APP_ID: 'app1' });
    let mints = 0;
    vi.stubGlobal('fetch', routeFetch({
      'GET /installation': () => Response.json({ id: 555 }),
      'POST /access_tokens': () => { mints++; return new Response(JSON.stringify({ token: 'ghs_abc', expires_at: new Date(Date.now() + 3600e3).toISOString() }), { status: 201 }); },
    }));
    expect(await installationToken(env)).toBe('ghs_abc');
    expect(await installationToken(env)).toBe('ghs_abc'); // cached
    expect(mints).toBe(1);
  });
});

describe('createIssue', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('posts with the required headers + body and returns the issue', async () => {
    const env = makeEnv();
    let init;
    vi.stubGlobal('fetch', routeFetch({
      'POST /issues': (req) => { init = req.init; return new Response(JSON.stringify({ number: 7, html_url: 'https://github.com/PunchIn-App/punchin/issues/7' }), { status: 201 }); },
    }));
    const issue = await createIssue(env, 'tok', { title: 'T', body: 'B', labels: ['bug'] });
    expect(issue.number).toBe(7);
    expect(init.headers['User-Agent']).toBe('punchin-feedback');
    expect(init.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(JSON.parse(init.body)).toMatchObject({ title: 'T', labels: ['bug'] });
  });

  it('throws on a non-201 response', async () => {
    const env = makeEnv();
    vi.stubGlobal('fetch', routeFetch({ 'POST /issues': () => new Response('nope', { status: 403 }) }));
    await expect(createIssue(env, 'tok', { title: 'T', body: 'B', labels: [] })).rejects.toThrow();
  });
});

describe('verifyWebhook', () => {
  // GitHub's documented test vector.
  const secret = "It's a Secret to Everybody";
  const body = 'Hello, World!';
  const sig = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

  it('accepts a correct signature', async () => {
    expect(await verifyWebhook(secret, body, sig)).toBe(true);
  });
  it('rejects a wrong signature, secret, or malformed header', async () => {
    expect(await verifyWebhook(secret, 'tampered', sig)).toBe(false);
    expect(await verifyWebhook('wrong', body, sig)).toBe(false);
    expect(await verifyWebhook(secret, body, 'sha256=zzzz')).toBe(false);
    expect(await verifyWebhook(secret, body, null)).toBe(false);
  });
});
