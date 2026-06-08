import { describe, it, expect } from 'vitest';
import { signUnsub, verifyUnsub } from '../src/unsubscribe.js';

const secret = 'unsec';

describe('unsubscribe tokens', () => {
  it('round-trips the issue number', async () => {
    const t = await signUnsub(secret, 42);
    expect(await verifyUnsub(secret, t)).toBe(42);
  });

  it('rejects a tampered token', async () => {
    const t = await signUnsub(secret, 42);
    const bad = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
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
