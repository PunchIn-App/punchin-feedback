// One-click GitHub App creation via the App Manifest flow (design §12 / plan
// Appendix A§4e). GET /setup serves a form that POSTs a manifest to GitHub; after
// the operator creates the App, GitHub redirects to /setup/callback?code=… which
// exchanges the code for the App credentials and shows the exact secret commands.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function pageHtml(title, inner) {
  return `<!doctype html><html lang="en" class="theme-dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><link rel="stylesheet" href="/styles.css"></head>
<body><main class="card">${inner}</main></body></html>`;
}

export function handleSetup(request, env) {
  const origin = new URL(request.url).origin;
  const manifest = {
    name: 'PunchIn Feedback',
    url: env.APP_URL,
    hook_attributes: { url: `${origin}/webhook` },
    redirect_url: `${origin}/setup/callback`,
    public: false,
    default_permissions: { issues: 'write', contents: 'read' },
    default_events: ['issues'],
  };
  // Create the App under the target org so it can be installed on its repos.
  const action = `https://github.com/organizations/${encodeURIComponent(env.REPO_OWNER)}/settings/apps/new`;
  const inner = `
<h1 class="ds-h1">Set up the GitHub App</h1>
<p class="ds-body">This creates a GitHub App named <strong>PunchIn Feedback</strong> in the
<code>${esc(env.REPO_OWNER)}</code> org with only <code>Issues: write</code> and an
<code>Issues</code> webhook pointed at this worker. After creating it, install it on
<code>${esc(env.REPO_OWNER)}/${esc(env.REPO_NAME)}</code>, then you'll get the secret commands to run.</p>
<form action="${esc(action)}" method="post">
  <input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}">
  <button type="submit" class="btn">Create the GitHub App</button>
</form>
<p class="hint">Prefer a personal account instead of the org? Replace the URL with
<code>https://github.com/settings/apps/new</code>.</p>`;
  return new Response(pageHtml('Set up the GitHub App', inner), { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export async function handleSetupCallback(request, env) {
  const code = new URL(request.url).searchParams.get('code');
  if (!code) return new Response(pageHtml('Setup error', '<h1 class="ds-h1">Missing code</h1><p class="ds-body">Start again at <a href="/setup">/setup</a>.</p>'), { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } });

  const r = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'punchin-feedback' },
  });
  if (r.status !== 201) {
    return new Response(pageHtml('Setup error', `<h1 class="ds-h1">Conversion failed (${r.status})</h1><p class="ds-body">The code expires an hour after creation — retry from <a href="/setup">/setup</a>.</p>`), { status: 502, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  const app = await r.json();
  const inner = `
<h1 class="ds-h1">App created — finish in two steps</h1>
<div class="note"><strong>These values are shown only once.</strong> Copy them now.</div>
<h2 class="ds-h1" style="font-size:18px">1. Install the app</h2>
<p class="ds-body">Install <strong>${esc(app.slug || 'PunchIn Feedback')}</strong> on
<code>${esc(env.REPO_OWNER)}/${esc(env.REPO_NAME)}</code>:
<a href="${esc(app.html_url || '')}/installations/new">open the install page</a>.</p>
<h2 class="ds-h1" style="font-size:18px">2. Set the worker secrets</h2>
<p class="ds-body">GitHub's private key is <strong>PKCS#1</strong>; Web Crypto needs <strong>PKCS#8</strong>, so convert it once:</p>
<pre class="note">printf '%s' '${esc(app.pem || '')}' > app.pem
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem -out app.pkcs8.pem

npx wrangler secret put GITHUB_APP_ID            # ${esc(app.id)}
npx wrangler secret put GITHUB_APP_PRIVATE_KEY   # paste the contents of app.pkcs8.pem
npx wrangler secret put GITHUB_WEBHOOK_SECRET    # ${esc(app.webhook_secret || '')}
npx wrangler secret put UNSUB_SECRET             # any long random string
# (optional, if using Turnstile) npx wrangler secret put TURNSTILE_SECRET</pre>
<p class="hint">Then delete app.pem and app.pkcs8.pem. Deploy with <code>npm run deploy</code>.</p>`;
  return new Response(pageHtml('App created', inner), { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
