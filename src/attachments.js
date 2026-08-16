// Screenshot uploads: validate (magic bytes, size, count), store in R2, serve,
// and manage retention. Deletion is app-managed (the 1-year clock resets on
// reopen, so it can't be a static R2 lifecycle rule) via KV due-markers swept by
// the daily cron. See design §8 / §7.4.

import { withSecurityHeaders, setSecurityHeaders } from './headers.js';

const SIGNATURES = [
  { type: 'image/png', ext: 'png', test: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { type: 'image/jpeg', ext: 'jpg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', ext: 'gif', test: (b) => b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61 },
  // WebP is a RIFF container: 'RIFF' at 0..3 AND 'WEBP' at 8..11 (a 4-byte prefix check would accept WAV/AVI).
  { type: 'image/webp', ext: 'webp', test: (b) => b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
];

// Real type from magic bytes (file.type is client-controlled and untrusted).
export function detectImageType(bytes) {
  for (const s of SIGNATURES) if (s.test(bytes)) return { type: s.type, ext: s.ext };
  return null;
}

// FormData -> { ok, images:[{bytes,type,ext,name}] } | { ok:false, error }.
export async function parseUploads(formData, { max, maxBytes }) {
  const files = formData.getAll('screenshots').filter((f) => f instanceof File && f.size > 0);
  if (files.length > max) return { ok: false, error: `Too many screenshots (max ${max}).` };
  const images = [];
  for (const file of files) {
    if (file.size > maxBytes) return { ok: false, error: `"${file.name}" is too large (max ${Math.round(maxBytes / 1048576)} MB).` };
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = detectImageType(bytes);
    if (!kind) return { ok: false, error: `"${file.name}" is not a PNG, JPEG, GIF or WebP image.` };
    images.push({ bytes, type: kind.type, ext: kind.ext, name: file.name });
  }
  return { ok: true, images };
}

export async function putImage(env, image) {
  const key = `${crypto.randomUUID().replace(/-/g, '')}.${image.ext}`;
  await env.ATTACHMENTS.put(key, image.bytes, {
    httpMetadata: { contentType: image.type, cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { originalName: image.name || '' },
  });
  return key;
}

export async function serveImage(env, key) {
  const obj = await env.ATTACHMENTS.get(key);
  if (!obj) return new Response('Not found', { status: 404, headers: withSecurityHeaders() });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('Content-Disposition', 'inline');
  if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream');
  // These bytes are user-uploaded and served inline from our own origin, so the
  // browser must not be allowed to sniff its way to another content-type.
  setSecurityHeaders(headers);
  return new Response(obj.body, { headers });
}

// ---- Retention markers: expire:<dueMs>:<imgKey> ----

export async function cancelExpiry(env, keys) {
  const set = new Set(keys);
  const { keys: marks } = await env.FEEDBACK.list({ prefix: 'expire:' });
  for (const m of marks) {
    if (set.has(m.name.split(':').slice(2).join(':'))) await env.FEEDBACK.delete(m.name);
  }
}

export async function scheduleExpiry(env, keys, dueMs) {
  await cancelExpiry(env, keys); // replace any existing markers for these keys
  const ttl = Math.max(60, Math.ceil((dueMs - Date.now()) / 1000) + 86400); // self-clean ~1d past due
  for (const key of keys) await env.FEEDBACK.put(`expire:${dueMs}:${key}`, '1', { expirationTtl: ttl });
}

// Delete R2 objects whose marker is due; returns the count deleted.
export async function sweepExpired(env, now = Date.now()) {
  const { keys: marks } = await env.FEEDBACK.list({ prefix: 'expire:' });
  let deleted = 0;
  for (const m of marks) {
    const parts = m.name.split(':');
    const dueMs = Number(parts[1]);
    if (Number.isFinite(dueMs) && dueMs <= now) {
      await env.ATTACHMENTS.delete(parts.slice(2).join(':'));
      await env.FEEDBACK.delete(m.name);
      deleted++;
    }
  }
  return deleted;
}
