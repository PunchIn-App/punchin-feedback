import { describe, it, expect } from 'vitest';
import worker from '../src/index.js';
import { makeEnv, ctx } from './helpers.js';

const req = (path, init) => new Request(`https://feedback.trackmytime.today${path}`, init);

describe('router', () => {
  it('redirects / to APP_URL', async () => {
    const res = await worker.fetch(req('/'), makeEnv(), ctx);
    expect(res.status).toBe(302);
    // Response.redirect normalizes the absolute URL (adds the trailing slash).
    expect(res.headers.get('location')).toBe('https://trackmytime.today/');
  });

  it('404s unknown paths', async () => {
    const res = await worker.fetch(req('/nope'), makeEnv(), ctx);
    expect(res.status).toBe(404);
  });

  it('routes /bug to a handler (not a 404)', async () => {
    const res = await worker.fetch(req('/bug'), makeEnv(), ctx);
    expect(res.status).not.toBe(404);
  });
});
