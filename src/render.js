// Server-rendered HTML for the two forms + success/error pages. The form is
// derived from the parsed issue-form schema so it mirrors the GitHub form. Brand
// styling comes from /styles.css (self-hosted). See design §6, §9, §11.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The app passes the user's theme + accent so the form feels native. Sanitize
// strictly: theme is an explicit class (else auto = follow prefers-color-scheme),
// and accent is injected into a <style> block so it MUST be a bare hex colour
// (no `}`/`<`) or it's dropped — otherwise a query param could inject CSS.
export const sanitizeTheme = (t) => (t === 'light' || t === 'dark' ? t : '');
export const sanitizeAccent = (a) => (/^#[0-9a-fA-F]{3,8}$/.test(a || '') ? a : '');

// Screenshots: Cloudflare's Turnstile api.js does NOT support Subresource
// Integrity (it is a first-party, auto-updated script), so no integrity attr.
function turnstileHead(sitekey) {
  return sitekey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : '';
}

function page({ title, accent, theme, sitekey, body }) {
  const a = sanitizeAccent(accent) || '#2D5BF5';
  const cls = sanitizeTheme(theme); // '' → auto (follows prefers-color-scheme)
  return `<!doctype html>
<html lang="en"${cls ? ` class="theme-${cls}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/styles.css">
<style>:root{--accent:${a}}</style>
${turnstileHead(sitekey)}
</head>
<body>
<main class="card">
${body}
</main>
</body>
</html>`;
}

function controlFor(field, prefill) {
  const name = `f.${field.id}`;
  const id = `field-${field.id}`;
  const req = field.required ? ' required' : '';
  const v = prefill[field.id];
  if (field.type === 'dropdown') {
    const opts = ['<option value="">—</option>']
      .concat(field.options.map((o) => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(o)}</option>`))
      .join('');
    return `<select id="${id}" name="${name}"${field.multiple ? ' multiple' : ''}${req}>${opts}</select>`;
  }
  if (field.type === 'checkboxes') {
    return `<div class="checks">${field.options
      .map((o) => `<label class="check"><input type="checkbox" name="${name}" value="${esc(o)}"> ${esc(o)}</label>`)
      .join('')}</div>`;
  }
  if (field.type === 'textarea') {
    return `<textarea id="${id}" name="${name}" rows="4"${req} placeholder="${esc(field.placeholder)}">${esc(v ?? '')}</textarea>`;
  }
  return `<input id="${id}" name="${name}" type="text"${req} placeholder="${esc(field.placeholder)}" value="${esc(v ?? '')}">`;
}

function blockFor(field, prefill) {
  if (field.type === 'markdown') return field.value ? `<div class="note">${esc(field.value)}</div>` : '';
  const reqMark = field.required ? ' <span class="req" aria-hidden="true">*</span>' : '';
  const desc = field.description ? `<p class="hint">${esc(field.description)}</p>` : '';
  return `<div class="field">
  <label for="field-${field.id}">${esc(field.label)}${reqMark}</label>
  ${desc}
  ${controlFor(field, prefill)}
</div>`;
}

const SNIFF = `<script>
(function(){
  var ua=navigator.userAgent;
  function set(id,val){var el=document.getElementById(id); if(el&&!el.value)el.value=val;}
  function browser(){
    if(/Edg\\/(\\d+)/.test(ua))return 'Edge '+RegExp.$1;
    if(/CriOS\\/(\\d+)/.test(ua))return 'Chrome '+RegExp.$1+' (iOS)';
    if(/FxiOS\\/(\\d+)/.test(ua))return 'Firefox '+RegExp.$1+' (iOS)';
    if(/Chrome\\/(\\d+)/.test(ua))return 'Chrome '+RegExp.$1;
    if(/Version\\/(\\d+).*Safari/.test(ua))return 'Safari '+RegExp.$1;
    if(/Firefox\\/(\\d+)/.test(ua))return 'Firefox '+RegExp.$1;
    return '';
  }
  function os(){
    var m;
    if(/iPhone|iPad|iPod/.test(ua)){m=ua.match(/OS (\\d+[_\\d]*)/);return m?'iOS '+m[1].replace(/_/g,'.'):'iOS';}
    if(/Android/.test(ua)){m=ua.match(/Android (\\d+\\.?\\d*)/);return m?'Android '+m[1]:'Android';}
    m=ua.match(/Mac OS X (\\d+[_\\d]*)/);if(m)return 'macOS '+m[1].replace(/_/g,'.');
    if(/Windows NT 10/.test(ua))return 'Windows 10 / 11';
    if(/Windows/.test(ua))return 'Windows';
    return 'Linux / other';
  }
  function device(){
    if(/iPad/.test(ua))return 'iPad';
    if(/iPhone/.test(ua))return 'iPhone';
    if(/Android/.test(ua)){var m=ua.match(/\\(Linux; Android [^;]+; ([^)]+)\\)/);return m?m[1].trim():'Android device';}
    return 'Desktop ('+screen.width+'×'+screen.height+')';
  }
  set('field-browser',browser());
  set('field-os',os());
  set('field-device',device());
  var it=document.getElementById('field-install-type');
  if(it&&!it.value){it.value=matchMedia('(display-mode: standalone)').matches?'PWA (installed to home screen)':'Browser tab';}
  // enable notification CHECKBOXES only when an email is present — scope to the
  // .check inputs so the email field itself (also inside .notify) stays editable.
  var email=document.getElementById('reporter-email');
  function toggle(){var on=email&&email.value.trim().length>0;document.querySelectorAll('.notify .check input').forEach(function(c){c.disabled=!on;});}
  if(email){email.addEventListener('input',toggle);toggle();}
})();
</script>`;

export function renderForm(schema, { kind, turnstileSitekey = '', accent = '', theme = '', prefill = {}, error = null } = {}) {
  const notify = prefill.notify || { copy: true, closed: false, reopened: false, commented: false };
  const errorBanner = error ? `<div class="error" role="alert">${esc(error)}</div>` : '';
  const fields = schema.fields.map((f) => blockFor(f, prefill)).join('\n');
  const turnstile = turnstileSitekey ? `<div class="cf-turnstile" data-sitekey="${esc(turnstileSitekey)}"></div>` : '';

  const body = `
<a class="back" href="/">← PunchIn</a>
<h1 class="ds-h1">${esc(schema.name)}</h1>
<p class="ds-body">${esc(schema.description)}</p>
${errorBanner}
<form method="POST" action="/submit" enctype="multipart/form-data">
  <input type="hidden" name="kind" value="${esc(kind)}">
  <input type="hidden" name="theme" value="${esc(sanitizeTheme(theme))}">
  <input type="hidden" name="accent" value="${esc(sanitizeAccent(accent))}">
  <div class="hp" aria-hidden="true"><label>Leave this empty<input name="_hp" tabindex="-1" autocomplete="off" value="${esc(prefill._hp ?? '')}"></label></div>

  <div class="field">
    <label for="title">Title <span class="req" aria-hidden="true">*</span></label>
    <input id="title" name="title" type="text" required value="${esc(prefill.title ?? '')}">
  </div>

  ${fields}

  <div class="field">
    <label for="screenshots">Screenshots <span class="opt">(optional)</span></label>
    <input id="screenshots" name="screenshots" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple>
    <p class="hint">Stored in Cloudflare R2 (PunchIn's storage), served from this site, and embedded in the public GitHub issue — anyone who can see the issue can see them. Deleted 1 year after upload (reset if the issue is reopened) or 30 days after it's closed, whichever is first.</p>
  </div>

  <fieldset class="notify">
    <legend>Email me about this <span class="opt">(optional)</span></legend>
    <div class="field">
      <label for="reporter-email">Your email</label>
      <input id="reporter-email" name="reporter-email" type="email" value="${esc(prefill.reporterEmail ?? '')}" placeholder="you@example.com">
      <p class="hint">Used only to send the updates you pick below. Never shown on the public issue. Deleted 3 months after the issue is closed (or ~1 year if it stays open), or whenever you unsubscribe.</p>
    </div>
    <label class="check"><input type="checkbox" name="notify-copy"${notify.copy ? ' checked' : ''}> Email me a copy + the issue link</label>
    <label class="check"><input type="checkbox" name="notify-closed"${notify.closed ? ' checked' : ''}> Email me when it's closed</label>
    <label class="check"><input type="checkbox" name="notify-reopened"${notify.reopened ? ' checked' : ''}> Email me if it's reopened</label>
    <label class="check"><input type="checkbox" name="notify-commented"${notify.commented ? ' checked' : ''}> Email me when someone comments (you can reply by email)</label>
  </fieldset>

  ${turnstile}
  <button type="submit" class="btn">Submit</button>
</form>
${SNIFF}`;

  return page({ title: schema.name, accent, theme, sitekey: turnstileSitekey, body });
}

export function renderSuccess({ number, html_url, emailed, accent = '', theme = '' }) {
  const body = `
<a class="back" href="/">← PunchIn</a>
<h1 class="ds-h1">Thank you</h1>
<p class="ds-body">Your feedback was filed as <a href="${esc(html_url)}">#${esc(number)}</a>.</p>
${emailed ? '<p class="ds-body">We\'ve emailed you a copy and the link.</p>' : ''}
<a class="btn" href="/">Done</a>`;
  return page({ title: 'Thank you', accent, theme, sitekey: '', body });
}

export function renderMessage(title, message, { accent = '', theme = '' } = {}) {
  const body = `
<a class="back" href="/">← PunchIn</a>
<h1 class="ds-h1">${esc(title)}</h1>
<p class="ds-body">${esc(message)}</p>
<a class="btn" href="/">Done</a>`;
  return page({ title, accent, theme, sitekey: '', body });
}

export function renderError(message, { accent = '', theme = '' } = {}) {
  const body = `
<a class="back" href="/">← PunchIn</a>
<h1 class="ds-h1">Something went wrong</h1>
<div class="error" role="alert">${esc(message)}</div>
<a class="btn" href="javascript:history.back()">Go back</a>`;
  return page({ title: 'Error', accent, theme, sitekey: '', body });
}
