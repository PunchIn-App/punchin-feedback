// HMAC-signed, self-contained unsubscribe tokens (no DB lookup needed to verify).
// token = b64url(payload) + "." + b64url(HMAC-SHA256(secret, payload)), where
// payload = "<issueNumber>.<expiryMs>". Verified with crypto.subtle.verify
// (constant-time). Returns the issue number, or null if invalid/tampered/expired.

const enc = new TextEncoder();
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 400; // ~13 months — outlives the issue map

function b64url(bytes) {
  let s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s) {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hmacKey(secret, usages) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

export async function signUnsub(secret, issueNumber, ttlMs = DEFAULT_TTL_MS) {
  const payload = `${issueNumber}.${Date.now() + ttlMs}`;
  const key = await hmacKey(secret, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return `${b64url(enc.encode(payload))}.${b64url(sig)}`;
}

export async function verifyUnsub(secret, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [p, s] = token.split('.');
  let payloadBytes, sigBytes;
  try {
    payloadBytes = b64urlToBytes(p);
    sigBytes = b64urlToBytes(s);
  } catch {
    return null;
  }
  const key = await hmacKey(secret, ['verify']);
  if (!(await crypto.subtle.verify('HMAC', key, sigBytes, payloadBytes))) return null;
  const [nStr, expStr] = new TextDecoder().decode(payloadBytes).split('.');
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  const n = Number(nStr);
  return Number.isInteger(n) ? n : null;
}
