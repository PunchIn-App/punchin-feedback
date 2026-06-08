import { describe, it, expect } from 'vitest';
import { signUnsub, verifyUnsub } from '../src/unsubscribe.js';

const secret = 'unsec';

describe('unsubscribe tokens', () => {
  it('round-trips the issue number', async () => {
    const t = await signUnsub(secret, 42);
    expect(await verifyUnsub(secret, t)).toBe(42);
  });

  it('rejects a tampered signature', async () => {
    const t = await signUnsub(secret, 42);
    const [p, s] = t.split('.');
    // Flip the FIRST signature char — always significant (unlike the last base64
    // char, whose trailing bits can alias to the same decoded bytes).
    const bad = `${p}.${s[0] === 'A' ? 'B' : 'A'}${s.slice(1)}`;
    expect(await verifyUnsub(secret, bad)).toBe(null);
  });

  it('rejects a wrong secret', async () => {
    const t = await signUnsub(secret, 42);
    expect(await verifyUnsub('other-secret', t)).toBe(null);
  });

  it('rejects an expired token', async () => {
    const t = await signUnsub(secret, 7, -1000); // already expired
    expect(await verifyUnsub(secret, t)).toBe(null);
  });

  it('rejects garbage input', async () => {
    expect(await verifyUnsub(secret, 'nope')).toBe(null);
    expect(await verifyUnsub(secret, '')).toBe(null);
    expect(await verifyUnsub(secret, 'a.b.c')).toBe(null);
  });
});
