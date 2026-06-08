import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkHoneypot, rateLimit, verifyTurnstile } from '../src/spam.js';
import { makeEnv, routeFetch } from './helpers.js';

describe('checkHoneypot', () => {
  it('passes when empty, fails when filled', () => {
    expect(checkHoneypot({ _hp: '' })).toBe(true);
    expect(checkHoneypot({})).toBe(true);
    expect(checkHoneypot({ _hp: 'spam' })).toBe(false);
  });
});

describe('rateLimit', () => {
  it('allows up to the cap, then blocks; independent per IP', async () => {
    const env = makeEnv();
    let ok = true;
    for (let i = 0; i < 12; i++) ok = await rateLimit(env, '1.2.3.4');
    expect(ok).toBe(true); // 12th still allowed
    expect(await rateLimit(env, '1.2.3.4')).toBe(false); // 13th blocked
    expect(await rateLimit(env, '9.9.9.9')).toBe(true); // a different IP is independent
  });
});

describe('verifyTurnstile', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('skips (passes) when not configured', async () => {
    expect(await verifyTurnstile(makeEnv({ TURNSTILE_SECRET: '' }), 'tok', '1.1.1.1')).toBe(true);
  });

  it('passes on success', async () => {
    vi.stubGlobal('fetch', routeFetch({ 'POST siteverify': () => Response.json({ success: true }) }));
    expect(await verifyTurnstile(makeEnv({ TURNSTILE_SECRET: 's' }), 'tok', '1.1.1.1')).toBe(true);
  });

  it('fails on rejection', async () => {
    vi.stubGlobal('fetch', routeFetch({ 'POST siteverify': () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] }) }));
    expect(await verifyTurnstile(makeEnv({ TURNSTILE_SECRET: 's' }), 'tok', '1.1.1.1')).toBe(false);
  });
});
