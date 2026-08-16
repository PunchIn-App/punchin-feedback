import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src/index.js';
import { makeEnv, ctx, routeFetch } from './helpers.js';

const req = (path) => new Request(`https://feedback.trackmytime.today${path}`);

// The one-time App-manifest flow is off unless the operator opts in; every test
// below that exercises the pages therefore runs with the gate open.
const setupEnv = (overrides = {}) => makeEnv({ ENABLE_SETUP: '1', ...overrides });

afterEach(() => vi.unstubAllGlobals());

// These routes are unauthenticated and, once the App exists, permanently
// obsolete — /setup exposes an App-creation form and /setup/callback prints
// credentials. They must be indistinguishable from an unknown path unless
// deliberately re-enabled.
describe('setup routes are gated', () => {
  it('404 by default (ENABLE_SETUP unset), like any unknown path', async () => {
    for (const path of ['/setup', '/setup/callback?code=abc123']) {
      const res = await worker.fetch(req(path), makeEnv(), ctx);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('Not found');
    }
  });

  it('404 for any value other than the explicit opt-in', async () => {
    const res = await worker.fetch(req('/setup'), makeEnv({ ENABLE_SETUP: 'true' }), ctx);
    expect(res.status).toBe(404);
  });

  it('serves the pages when ENABLE_SETUP=1', async () => {
    expect((await worker.fetch(req('/setup'), setupEnv(), ctx)).status).toBe(200);
  });
});

describe('GET /setup', () => {
  it('serves the manifest form scoped to the org with issues:write + webhook', async () => {
    const html = await (await worker.fetch(req('/setup'), setupEnv(), ctx)).text();
    expect(html).toContain('github.com/organizations/PunchIn-App/settings/apps/new');
    expect(html).toContain('name="manifest"');
    expect(html).toContain('issues'); // default_permissions / default_events
    expect(html).toContain('contents'); // Contents:read for live template fetch
    expect(html).toContain('/webhook'); // hook_attributes.url
  });
});

describe('GET /setup/callback', () => {
  it('exchanges the code and shows App id + webhook secret + PKCS#8 instructions', async () => {
    vi.stubGlobal('fetch', routeFetch({
      'POST /app-manifests/': () => new Response(JSON.stringify({ id: 999, slug: 'punchin-feedback', html_url: 'https://github.com/apps/punchin-feedback', webhook_secret: 'whs_secret', pem: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----' }), { status: 201 }),
    }));
    const html = await (await worker.fetch(req('/setup/callback?code=abc123'), setupEnv(), ctx)).text();
    expect(html).toContain('999'); // app id
    expect(html).toContain('whs_secret'); // webhook secret
    expect(html).toContain('openssl pkcs8 -topk8'); // the PKCS#1 -> PKCS#8 step
    expect(html).toContain('GITHUB_APP_PRIVATE_KEY');
  });

  // `code` is attacker-suppliable (anyone can hit /setup/callback?code=…) and is
  // spliced into an api.github.com path, so it has to be percent-encoded or it
  // can walk out of /app-manifests/<code>/conversions into another API endpoint.
  it('percent-encodes the code into the API path', async () => {
    let called = '';
    vi.stubGlobal('fetch', routeFetch({
      'POST api.github.com': (r) => { called = r.url; return new Response('{}', { status: 502 }); },
    }));
    await worker.fetch(req('/setup/callback?code=' + encodeURIComponent('../../repos/x/y/issues?a=b')), setupEnv(), ctx);
    expect(called).toBe('https://api.github.com/app-manifests/..%2F..%2Frepos%2Fx%2Fy%2Fissues%3Fa%3Db/conversions');
  });

  it('400s without a code', async () => {
    const res = await worker.fetch(req('/setup/callback'), setupEnv(), ctx);
    expect(res.status).toBe(400);
  });
});

describe('setup page headers', () => {
  it('the setup pages are hardened like every other page', async () => {
    const res = await worker.fetch(req('/setup'), setupEnv(), ctx);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  // The callback page prints the App's private key and webhook secret; it must
  // never be written to a cache (browser, proxy, or back/forward store).
  it('the setup pages are never cached', async () => {
    vi.stubGlobal('fetch', routeFetch({
      'POST /app-manifests/': () => new Response(JSON.stringify({ id: 999, slug: 's', html_url: 'https://github.com/apps/s', webhook_secret: 'whs_secret', pem: 'KEY' }), { status: 201 }),
    }));
    expect((await worker.fetch(req('/setup'), setupEnv(), ctx)).headers.get('cache-control')).toBe('no-store');
    expect((await worker.fetch(req('/setup/callback?code=abc123'), setupEnv(), ctx)).headers.get('cache-control')).toBe('no-store');
  });
});
