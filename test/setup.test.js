import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src/index.js';
import { makeEnv, ctx, routeFetch } from './helpers.js';

const req = (path) => new Request(`https://feedback.trackmytime.today${path}`);

afterEach(() => vi.unstubAllGlobals());

describe('GET /setup', () => {
  it('serves the manifest form scoped to the org with issues:write + webhook', async () => {
    const html = await (await worker.fetch(req('/setup'), makeEnv(), ctx)).text();
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
    const html = await (await worker.fetch(req('/setup/callback?code=abc123'), makeEnv(), ctx)).text();
    expect(html).toContain('999'); // app id
    expect(html).toContain('whs_secret'); // webhook secret
    expect(html).toContain('openssl pkcs8 -topk8'); // the PKCS#1 -> PKCS#8 step
    expect(html).toContain('GITHUB_APP_PRIVATE_KEY');
  });

  it('400s without a code', async () => {
    const res = await worker.fetch(req('/setup/callback'), makeEnv(), ctx);
    expect(res.status).toBe(400);
  });
});
