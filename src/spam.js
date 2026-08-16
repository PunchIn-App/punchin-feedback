// Abuse controls for the public submit endpoint (design §10):
//   - honeypot: a hidden field bots tend to fill
//   - rate limit: per-IP rolling cap in KV
//   - Turnstile: Cloudflare server-side token verification (optional for self-hosters)

const RL_MAX = 12; // submissions per window per IP
const RL_WINDOW = 600; // seconds

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// true = ok (empty), false = looks like a bot (filled).
export function checkHoneypot(values) {
  return (values?._hp ?? '') === '';
}

// true = allowed, false = over the cap. Rolling window (each hit refreshes TTL).
export async function rateLimit(env, ip) {
  const key = `rl:${await sha256hex(ip || 'unknown')}`;
  const cur = Number((await env.FEEDBACK.get(key)) || 0);
  if (cur >= RL_MAX) return false;
  await env.FEEDBACK.put(key, String(cur + 1), { expirationTtl: RL_WINDOW });
  return true;
}

// true = passed (or Turnstile is deliberately off); false = failed/forged/misconfigured.
//
// "Deliberately off" is the *sitekey* being unset: with no TURNSTILE_SITEKEY the
// form renders no widget and self-hosters run on honeypot + rate-limit alone
// (design §10). A sitekey WITHOUT a secret is never deliberate — the widget
// renders, so the form looks protected, while a secret-less pass would wave
// every submission (incl. forged tokens) through. That combination fails closed
// and is logged, because it can only be a deployment mistake.
//
// Local dev: `.dev.vars` overrides `wrangler.toml [vars]`, so either blank
// TURNSTILE_SITEKEY there (Turnstile off) or use Cloudflare's always-passes test
// pair — sitekey 1x00000000000000000000AA / secret 1x0000000000000000000000000000000AA.
export async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) {
    if (env.TURNSTILE_SITEKEY) {
      console.error('turnstile: TURNSTILE_SECRET is not set but TURNSTILE_SITEKEY is — failing closed (set the secret, or clear the sitekey to run without Turnstile)');
      return false;
    }
    return true;
  }
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token || '');
  if (ip) form.append('remoteip', ip);
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const outcome = await r.json();
    return outcome?.success === true;
  } catch {
    return false;
  }
}
