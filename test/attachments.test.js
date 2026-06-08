import { describe, it, expect } from 'vitest';
import {
  detectImageType, parseUploads, putImage, serveImage,
  scheduleExpiry, cancelExpiry, sweepExpired,
} from '../src/attachments.js';
import { makeEnv } from './helpers.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
const fileFrom = (bytes, name, type) => new File([bytes], name, { type });

describe('detectImageType', () => {
  it('recognises real image signatures', () => {
    expect(detectImageType(PNG).type).toBe('image/png');
    expect(detectImageType(JPEG).type).toBe('image/jpeg');
    expect(detectImageType(GIF).type).toBe('image/gif');
    expect(detectImageType(WEBP).type).toBe('image/webp');
  });
  it('rejects non-images including RIFF-but-not-WEBP', () => {
    expect(detectImageType(WAV)).toBe(null);
    expect(detectImageType(new Uint8Array([1, 2, 3, 4]))).toBe(null);
  });
});

describe('parseUploads', () => {
  it('accepts valid images', async () => {
    const fd = new FormData();
    fd.append('screenshots', fileFrom(PNG, 'a.png', 'image/png'));
    fd.append('screenshots', fileFrom(JPEG, 'b.jpg', 'image/jpeg'));
    const r = await parseUploads(fd, { max: 5, maxBytes: 1000 });
    expect(r.ok).toBe(true);
    expect(r.images.map((i) => i.type)).toEqual(['image/png', 'image/jpeg']);
  });
  it('rejects over the count cap', async () => {
    const fd = new FormData();
    for (let i = 0; i < 3; i++) fd.append('screenshots', fileFrom(PNG, `x${i}.png`, 'image/png'));
    expect((await parseUploads(fd, { max: 2, maxBytes: 1000 })).ok).toBe(false);
  });
  it('rejects oversize files', async () => {
    const fd = new FormData();
    fd.append('screenshots', fileFrom(new Uint8Array(2000), 'big.png', 'image/png'));
    expect((await parseUploads(fd, { max: 5, maxBytes: 1000 })).ok).toBe(false);
  });
  it('rejects a spoofed non-image (declared png, junk bytes)', async () => {
    const fd = new FormData();
    fd.append('screenshots', fileFrom(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'fake.png', 'image/png'));
    expect((await parseUploads(fd, { max: 5, maxBytes: 1000 })).ok).toBe(false);
  });
});

describe('putImage + serveImage', () => {
  it('stores under a random key and serves with content-type', async () => {
    const env = makeEnv();
    const key = await putImage(env, { bytes: PNG, type: 'image/png', ext: 'png', name: 'a.png' });
    expect(key.endsWith('.png')).toBe(true);
    const res = await serveImage(env, key);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect((await serveImage(env, 'missing')).status).toBe(404);
  });
});

describe('retention markers', () => {
  it('schedules, sweeps due markers, and cancel prevents deletion', async () => {
    const env = makeEnv();
    await env.ATTACHMENTS.put('k1.png', PNG, { httpMetadata: { contentType: 'image/png' } });
    await env.ATTACHMENTS.put('k2.png', PNG, { httpMetadata: { contentType: 'image/png' } });
    const now = Date.now();
    await scheduleExpiry(env, ['k1.png'], now - 1000); // already due
    await scheduleExpiry(env, ['k2.png'], now + 1e9); // far future

    expect(await sweepExpired(env, now)).toBe(1);
    expect(await env.ATTACHMENTS.get('k1.png')).toBe(null);
    expect(await env.ATTACHMENTS.get('k2.png')).not.toBe(null);

    await cancelExpiry(env, ['k2.png']);
    expect(await sweepExpired(env, now + 2e9)).toBe(0); // marker gone -> nothing swept
    expect(await env.ATTACHMENTS.get('k2.png')).not.toBe(null);
  });
});
