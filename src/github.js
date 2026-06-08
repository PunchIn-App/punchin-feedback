// GitHub App auth + issue creation (Web Crypto only). Verified 2026-06-07 (plan
// Appendix A§4). NOTE: GitHub issues the App private key in PKCS#1; Web Crypto
// needs PKCS#8 — the operator converts it once with `openssl pkcs8 -topk8` and
// stores the PKCS#8 PEM as GITHUB_APP_PRIVATE_KEY.

const GH = 'https://api.github.com';
const UA = 'punchin-feedback';

function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64urlStr = (str) => b64url(new TextEncoder().encode(str));

function pemToPkcs8Bytes(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const raw = atob(body);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

// RS256 App JWT (iss=app/client id, iat=now-60 for skew, exp<=10min).
export async function appJwt(appId, pkcs8Pem) {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8Bytes(pkcs8Pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64urlStr(JSON.stringify({ iss: appId, iat: now - 60, exp: now + 540 }));
  const signingInput = `${header}.${payload}`;
  const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}

function ghHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': UA, // mandatory — GitHub 403s requests with no User-Agent
    ...extra,
  };
}

async function installationId(env, jwt) {
  if (env.GITHUB_INSTALLATION_ID) return env.GITHUB_INSTALLATION_ID;
  const r = await fetch(`${GH}/repos/${env.REPO_OWNER}/${env.REPO_NAME}/installation`, { headers: ghHeaders(jwt) });
  if (!r.ok) throw new Error(`installation lookup ${r.status}`);
  return (await r.json()).id;
}

// ~1h installation access token, cached in KV with margin.
export async function installationToken(env) {
  const cached = await env.FEEDBACK.get('gh-token', 'json');
  if (cached?.token && Date.parse(cached.expires_at) - Date.now() > 60000) return cached.token;
  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const id = await installationId(env, jwt);
  const r = await fetch(`${GH}/app/installations/${id}/access_tokens`, { method: 'POST', headers: ghHeaders(jwt) });
  if (r.status !== 201) throw new Error(`token mint ${r.status}: ${await r.text()}`);
  const { token, expires_at } = await r.json();
  await env.FEEDBACK.put('gh-token', JSON.stringify({ token, expires_at }), { expirationTtl: 3000 });
  return token;
}

// Verify an inbound webhook: X-Hub-Signature-256 = 'sha256='+hex(HMAC-SHA256(secret, rawBody)).
// Must be called on the RAW body (before JSON.parse). Constant-time via subtle.verify.
export async function verifyWebhook(secret, rawBody, signatureHeader) {
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) return false;
  const hex = signatureHeader.slice(7);
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return false;
  const sigBytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < sigBytes.length; i++) sigBytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(rawBody));
}

export async function createIssue(env, token, { title, body, labels }) {
  const r = await fetch(`${GH}/repos/${env.REPO_OWNER}/${env.REPO_NAME}/issues`, {
    method: 'POST',
    headers: ghHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ title, body, labels }),
  });
  if (r.status !== 201) throw new Error(`create issue ${r.status}: ${await r.text()}`);
  return await r.json(); // { number, html_url, ... }
}

export async function createComment(env, token, issueNumber, body) {
  const r = await fetch(`${GH}/repos/${env.REPO_OWNER}/${env.REPO_NAME}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: ghHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ body }),
  });
  if (r.status !== 201) throw new Error(`create comment ${r.status}: ${await r.text()}`);
  return await r.json(); // { id, html_url, ... }
}
