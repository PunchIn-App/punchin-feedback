# punchin-feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `punchin-feedback` Cloudflare Worker — account-free web forms (derived from the GitHub issue templates) that file real GitHub issues, host screenshots in R2, and email reporters copies + close/reopen follow-ups.

**Architecture:** A single module Worker (`export default { fetch, scheduled }`). `fetch()` serves two server-rendered forms + a submit endpoint + a GitHub webhook + an unsubscribe endpoint + an R2 image route; static brand assets (CSS/fonts) are served by Workers Static Assets (asset-first, `not_found_handling:"none"` so dynamic routes fall through). `scheduled()` runs a daily image-retention sweep. Small, focused, individually-tested pure modules do the work; `index.js` is just routing + handlers. Mirrors the sibling `punchin-email` worker (ES modules, Node ≥22, `vitest` node env with binding test-doubles, no build step).

**Tech Stack:** Cloudflare Workers (Static Assets, KV, R2, `send_email`, Cron Triggers), Web Crypto (RS256 JWT + HMAC), GitHub App REST API, Cloudflare Turnstile, `js-yaml`, Vitest.

---

## Source of truth

The design spec is [`docs/2026-06-07-punchin-feedback-design.md`](../../2026-06-07-punchin-feedback-design.md). All verified API facts used below are in **Appendix A** (from the 2026-06-07 research pass). Read the spec §s referenced per task.

## Scope note

This plan covers **only the `punchin-feedback` worker**. The cross-repo PunchIn app change (spec §14 — repoint Settings → About at the form, branch off `design/brand-refresh`) is a **separate follow-on plan** (`docs/superpowers/plans/2026-06-07-punchin-app-feedback-links.md`), written after the worker is green.

---

## Interface contracts (locked — every task conforms to these)

**Field schema** (output of `parseIssueForm`): a plain object
```js
{
  name: string,            // template `name`
  description: string,     // template `description`
  labels: string[],        // template top-level `labels` (e.g. ['bug'])
  titlePrefix: string|null,// template top-level `title` (usually null here)
  fields: [                // in template order, markdown blocks INCLUDED (filtered at body time)
    { type:'markdown'|'input'|'textarea'|'dropdown'|'checkboxes',
      id: string|null, label: string, description: string,
      placeholder: string, required: boolean,
      options: string[],   // dropdown/checkboxes only
      multiple: boolean,   // dropdown only
      render: string|null } // textarea only
  ]
}
```

**Submitted values** (form → handlers): `{ title, fields: { <id>: string|string[] }, reporterEmail, notify:{copy,closed,reopened}, _hp }` (`_hp` = honeypot).

**Env bindings:** `FEEDBACK` (KV), `ATTACHMENTS` (R2), `EMAIL` (send_email), `ASSETS` (static), vars per spec §3. Secrets: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PKCS#8), `GITHUB_WEBHOOK_SECRET`, `UNSUB_SECRET`, `TURNSTILE_SECRET`.

**KV keys** (spec §13): `tpl:<kind>`, `gh-token`, `issue:<n>`, `seen:<deliveryId>`, `rl:<iphash>`, `expire:<dueMs>:<imgKey>`.

**Issue record** (`issue:<n>` value): `{ email?, kind, createdAt, notify:{copy,closed,reopened}, images:string[], imgYearClockStart:number, closedAt?:number }`.

**Test doubles** (`test/helpers.js`): `fakeKV()` (Map-backed get/put/delete/list with TTL capture), `fakeR2()` (Map-backed put/get/head/delete returning objects with `.body`,`.writeHttpMetadata`,`.httpEtag`,`.customMetadata`), `fakeEmail()` (records `.send()` calls), `fakeFetch(routes)` (maps URL→Response), `makeEnv(overrides)`.

---

## File structure

| File | Responsibility |
|---|---|
| `wrangler.toml` | worker config: bindings, vars, `[assets]`, `[triggers]` |
| `src/index.js` | `export default { fetch, scheduled }` + route handlers |
| `src/templates.js` | `parseIssueForm(yaml)`, `loadTemplate(env, kind)` (fetch raw→cache→bundled fallback) |
| `src/bundledTemplates.js` | the two issue-form YAMLs as exported strings (offline fallback floor) |
| `src/issueBody.js` | `formatIssueBody`, `buildIssue` (GitHub issue-form rendering) |
| `src/github.js` | `appJwt`, `installationToken` (KV-cached), `createIssue` |
| `src/email.js` | `buildCopyEmail`/`buildClosedEmail`/`buildReopenEmail`, `sendEmail` |
| `src/unsubscribe.js` | `signUnsub`/`verifyUnsub` (HMAC) |
| `src/spam.js` | `checkHoneypot`, `rateLimit`, `verifyTurnstile` |
| `src/attachments.js` | `detectImageType`, `parseUploads`, `putImage`, `serveImage`, `scheduleExpiry`/`cancelExpiry`, `sweepExpired` |
| `src/render.js` | `renderForm`, `renderSuccess`, `renderError` (+ inline client sniff + Turnstile + disclosure) |
| `assets/styles.css` | brand tokens from the design system |
| `assets/fonts/*.woff2` | self-hosted Noto (Sans / Display / Mono) |
| `test/*.test.js` | one suite per module + `test/helpers.js` |
| `.github/workflows/ci.yml` | `npm test` + `wrangler --dry-run` + template-parity check |

---

## Task 1: Worker config + routing skeleton

**Files:** Create `wrangler.toml`; Create `src/index.js`; Create `test/helpers.js`, `test/router.test.js`.

- [ ] **Step 1 — failing test** (`test/router.test.js`): `GET /` → 302 to `APP_URL`; unknown path → 404; `GET /bug` reaches a stubbed handler. Use a Request + `makeEnv()`.
- [ ] **Step 2** run `npx vitest run test/router.test.js` → FAIL (no `src/index.js`).
- [ ] **Step 3** write `src/index.js` `export default { fetch, scheduled }` with the route table from Appendix A§2 (the `pathname` switch + `/a/<key>` regex), each branch delegating to a handler imported from its module (stub handlers returning 501 for now), `/` → `Response.redirect(env.APP_URL, 302)`.
- [ ] **Step 4** run → PASS.
- [ ] **Step 5** write `wrangler.toml` per Appendix A§2 (main, compatibility_date, `[assets] directory="./assets" binding="ASSETS" not_found_handling="none"`, `[triggers] crons=["0 3 * * *"]`, `[[kv_namespaces]]` FEEDBACK, `[[r2_buckets]]` ATTACHMENTS, `[[send_email]]` EMAIL, `[vars]` REPO_OWNER/REPO_NAME/TEMPLATE_REF/APP_URL/FROM_ADDRESS/TURNSTILE_SITEKEY/ACCENT/PROVENANCE_LABEL/IMG_MAX_BYTES/IMG_MAX_COUNT — ids left as `PLACEHOLDER`).
- [ ] **Step 6 — commit** `feat: worker config + routing skeleton`.

## Task 2: Template parse + load (spec §5)

**Files:** Create `src/bundledTemplates.js`, `src/templates.js`, `test/templates.test.js`.

- [ ] **Step 1 — failing test:** parse the bundled bug YAML → assert `labels==['bug']`, field ids in order `[what-happened,steps,expected,version,install-type,browser,os,device,context]`, `install-type.type==='dropdown'` with the two options, `context.required===false`. Parse feature → ids `[problem,solution,alternatives,scope]`. Also: a `markdown` block parses with `type:'markdown'` and is retained in `fields`. Also a **drift test**: read `templates/bug_report.yml` + `templates/feature_request.yml` from disk (`node:fs`) and assert `parseIssueForm(disk) deepEquals parseIssueForm(bundled)`.
- [ ] **Step 2** run → FAIL.
- [ ] **Step 3** author `src/bundledTemplates.js` (the two YAML strings, copied verbatim from `templates/*.yml`). Implement `parseIssueForm(yaml)` with `js-yaml` `load`, mapping each `body[]` entry to the locked schema (default `required:false`, `options=[]`, etc.). Implement `loadTemplate(env, kind)`: `fetch(raw.githubusercontent/<owner>/<repo>/<TEMPLATE_REF>/.github/ISSUE_TEMPLATE/<file>)` → on ok parse + `FEEDBACK.put('tpl:'+kind, json, {expirationTtl: 6h})`; on failure read `tpl:<kind>` cache; on miss parse the bundled string. (Pure parse separated from I/O `loadTemplate`.)
- [ ] **Step 4** run → PASS.
- [ ] **Step 5 — test loadTemplate:** with `fakeFetch` returning the YAML → caches + returns parsed; with `fakeFetch` throwing + empty KV → returns bundled; with cache populated + fetch throwing → returns cache. Implement to pass.
- [ ] **Step 6 — commit** `feat: issue-form template parsing + live load with fallback`.

## Task 3: Issue-body formatter (spec §7, Appendix A§1)

**Files:** Create `src/issueBody.js`, `test/issueBody.test.js`.

- [ ] **Step 1 — failing test:** `formatIssueBody(bugSchema, values, {imageUrls:[]})` for filled values → exact string with `### What happened\n\n<v>\n\n…`; an **empty optional** `context` → `### Additional context\n\n_No response_`; `install-type` dropdown value rendered as the option text; `markdown` blocks (if any) **excluded**; with `imageUrls` non-empty → a trailing `### Screenshots\n\n![screenshot 1](url)\n…` section. `buildIssue(schema, values, {imageUrls, kind, provenanceLabel:'via-web-form'})` → `{ title: values.title, body, labels:['bug','via-web-form'] }`. Add cases for dropdown-empty→`None`, checkboxes→`- [x]`/`- [ ]`, textarea `render:js`→fenced block (future-proofing the engine).
- [ ] **Step 2** run → FAIL.
- [ ] **Step 3** implement per Appendix A§1 rules exactly (label headings, blank-line separators, empty placeholders, fence for `render`, checkbox lines, dropdown join `, `). Skip `markdown` and any field with no submitted value+not-required only via the `_No response_` rule (never omit a schema field's heading — except `markdown`).
- [ ] **Step 4** run → PASS.  **Step 5 — commit** `feat: GitHub issue-form body formatter`.

## Task 4: Unsubscribe tokens

**Files:** Create `src/unsubscribe.js`, `test/unsubscribe.test.js`.

- [ ] **Step 1 — failing test:** `t = await signUnsub(secret, 42)`; `await verifyUnsub(secret, t) === 42`; tampered token → `null`; wrong secret → `null`.
- [ ] **Step 2** FAIL. **Step 3** implement: payload `"<n>.<exp>"`, HMAC-SHA256 via Web Crypto, token = `b64url(payload)+"."+b64url(sig)`; verify recomputes + `crypto.subtle.verify`. **Step 4** PASS. **Step 5 — commit** `feat: signed unsubscribe tokens`.

## Task 5: Spam controls (Appendix A§5)

**Files:** Create `src/spam.js`, `test/spam.test.js`.

- [ ] **Step 1 — failing test:** `checkHoneypot({_hp:''})===true`, `checkHoneypot({_hp:'x'})===false`; `rateLimit(env, ip)` increments `rl:<hash>` and returns `false` once over the cap; `verifyTurnstile` with `fakeFetch` → `{success:true}` passes, `{success:false,'error-codes':[...]}` fails; when `TURNSTILE_SECRET` unset → skipped (returns true) but honeypot+rate-limit still apply.
- [ ] **Step 2** FAIL. **Step 3** implement: honeypot pure; `rateLimit` hashes ip (SHA-256 hex) → KV counter w/ TTL window; `verifyTurnstile` POSTs FormData to `https://challenges.cloudflare.com/turnstile/v0/siteverify`, reads `outcome['error-codes']`, asserts `success` (+ optional hostname/action). **Step 4** PASS. **Step 5 — commit** `feat: honeypot + rate-limit + Turnstile`.

## Task 6: Attachments (spec §8, §7.4; Appendix A§3)

**Files:** Create `src/attachments.js`, `test/attachments.test.js`.

- [ ] **Step 1 — failing tests:** `detectImageType` returns the right MIME for PNG/JPEG/GIF/`RIFF…WEBP` byte fixtures and `null` for junk/`RIFF…WAVE`; `parseUploads(formData, {max, maxBytes})` returns valid `File`s, rejects oversize/overcount/non-image; `putImage(env, file)` → random key, `ATTACHMENTS.put` called with `httpMetadata.contentType` + `customMetadata`; `serveImage(env, key)` → streams `object.body` with content-type + etag, 404 when absent; `scheduleExpiry(env, n, keys, dueMs)` writes `expire:<dueMs>:<key>`; `cancelExpiry` deletes them; `sweepExpired(env, now)` deletes due R2 objects + markers, leaves future ones.
- [ ] **Step 2** FAIL. **Step 3** implement per Appendix A§3 (magic bytes; `formData.getAll`; `crypto.randomUUID()` keys under `a/`; `writeHttpMetadata`+`httpEtag`; KV `list({prefix:'expire:'})` parse `dueMs` for the sweep). **Step 4** PASS. **Step 5 — commit** `feat: R2 screenshot upload, serving, and retention sweep`.

## Task 7: GitHub App client (Appendix A§4)

**Files:** Create `src/github.js`, `test/github.test.js`.

- [ ] **Step 1 — failing tests:** generate a throwaway RSA key in-test (`crypto.subtle.generateKey('RSASSA-PKCS1-v1_5'…)`, export pkcs8→PEM); `appJwt(id, pem)` → three base64url segments, header `{alg:'RS256',typ:'JWT'}`, `exp-iat<=600`, and `crypto.subtle.verify` passes against the public key. `installationToken(env)` with `fakeFetch`: looks up installation (or reads cached `gh-token`), POSTs access_tokens, caches token w/ TTL, returns it; second call uses cache (no fetch). `createIssue(env, token, {title,body,labels})` → POST with headers incl. **`User-Agent`**, `Accept`, `X-GitHub-Api-Version`; returns `{number,html_url}`; throws on non-201.
- [ ] **Step 2** FAIL. **Step 3** implement per Appendix A§4 (base64url helpers, `importKey('pkcs8'…RSASSA-PKCS1-v1_5/SHA-256)`, `iat=now-60/exp=now+540`; installation id from var or `/repos/{o}/{r}/installation`; cache token in KV keyed `gh-token` with `expirationTtl` ~50min). **Step 4** PASS. **Step 5 — commit** `feat: GitHub App auth + issue creation`.

## Task 8: Email (spec §9; Appendix A§5)

**Files:** Create `src/email.js`, `test/email.test.js`.

- [ ] **Step 1 — failing tests:** `buildCopyEmail({issue,title,kind,bodyMarkdown,unsubUrl,appUrl})` → `{subject, html, text, headers}` where the **first** line of text/html body is the unsubscribe link, `headers['List-Unsubscribe']` is `<https…>` and `headers['List-Unsubscribe-Post']==='List-Unsubscribe=One-Click'`, and the disclosure line is present; `buildClosedEmail` includes the `state_reason`; `buildReopenEmail` includes the link. `sendEmail(env, msg, to)` calls `EMAIL.send` with `from:{email:FROM_ADDRESS}` (binding shape, `email` not `address`).
- [ ] **Step 2** FAIL. **Step 3** implement; ensure only whitelisted headers; https-only unsubscribe URL. **Step 4** PASS. **Step 5 — commit** `feat: reporter emails with top-of-body unsubscribe`.

## Task 9: Form rendering (spec §6, §9, §11; Appendix A§5 widget)

**Files:** Create `src/render.js`, `test/render.test.js`.

- [ ] **Step 1 — failing tests:** `renderForm(schema, {kind, turnstileSitekey, prefill, accent})` HTML contains: every non-markdown field's `label` + an input/textarea/select with matching `id`; required markers on required fields; the markdown blocks' text; the optional **email** field; the three notification checkboxes (copy `checked`); the **honeypot** field (visually hidden); the **upload** input + the Cloudflare-R2 retention **disclosure** text; the Turnstile `<div class="cf-turnstile" data-sitekey>` when a sitekey is given (absent otherwise); prefilled `value`s from `prefill`; the inline client **sniff** script. `renderSuccess({number,html_url,emailed})` shows the number + link. `renderError(msg, values)` re-renders with inputs preserved.
- [ ] **Step 2** FAIL. **Step 3** implement (semantic HTML, `<label for>`/`id`, `enctype=multipart/form-data`, `/styles.css` + `/fonts` references, `prefers-color-scheme`, accent var, a11y focus). Port the browser/OS/device sniff from `punchin/src/utils/issueUrl.js` into an inline `<script>` that fills version/install-type/browser/os/device only when empty/!prefilled. **Step 4** PASS. **Step 5 — commit** `feat: brand-styled accessible forms`.

## Task 10: Brand assets

**Files:** Create `assets/styles.css`; copy `assets/fonts/*.woff2`.

- [ ] **Step 1** author `assets/styles.css` from `punchin-design-system/project/colors_and_type.css` (tokens, `.ds-*`, dark default + `.theme-light` under `@media (prefers-color-scheme: light)`), with `@font-face` pointing at `/fonts/*.woff2` and form/input/button/card styling using the tokens.
- [ ] **Step 2** copy the three Noto WOFF2 (Sans, Sans Display, Mono — normal; Sans italic optional) from `punchin/app/public/fonts/` into `assets/fonts/`.
- [ ] **Step 3 — verify** `GET /styles.css` resolves under `wrangler dev` (manual) and no `assets/index.html` exists. **Step 4 — commit** `feat: self-hosted brand CSS + Noto fonts`.

## Task 11: Wire handlers in index.js (spec §7)

**Files:** Modify `src/index.js`; Create `test/handlers.test.js`.

- [ ] **Step 1 — failing tests** (mock all bindings via `makeEnv`):
  - `GET /bug` → 200 form containing the bug fields.
  - `POST /submit` happy path: valid bug form (+ Turnstile token + 1 image) → `createIssue` called; `issue:<n>` stored with `notify`+`images`+`imgYearClockStart`; expiry marker at `imgYearClockStart+365d`; copy email sent (since `copy` checked); response = success page with the issue number. **Best-effort:** when `EMAIL.send` throws, still 200 success (filing not lost). When `createIssue` throws → error page with inputs preserved.
  - `POST /submit` spam: bad honeypot or failed Turnstile → 400, no issue.
  - `POST /webhook` `closed`: valid HMAC + `notify.closed` → close email; records `closedAt`; recomputes expiry to `min(year, closedAt+30d)`; re-puts mapping with 90d TTL. Bad HMAC → 401. Duplicate `X-GitHub-Delivery` → 204 no-op.
  - `POST /webhook` `reopened`: reopen email; resets `imgYearClockStart`; clears `closedAt`; restores ~1yr TTL.
  - `GET /unsubscribe?token=…` valid → clears email/notify, 200 confirm; bad token → 400.
  - `GET /a/<key>` → streams the image.
  - `scheduled()` → calls `sweepExpired`.
- [ ] **Step 2** FAIL. **Step 3** implement the handlers composing Tasks 2–9 in the spec §7 order (raw-body read **before** JSON parse for the webhook; best-effort ordering after `createIssue`). **Step 4** PASS. **Step 5 — commit** `feat: wire submit/webhook/unsubscribe/cron handlers`.

## Task 12: GitHub App manifest setup route (self-host one-click; Appendix A§4e)

**Files:** Modify `src/index.js` (`/setup`, `/setup/callback`); `test/setup.test.js`.

- [ ] **Step 1 — failing test:** `GET /setup` → HTML form POSTing the manifest (Appendix A§4e) to `github.com/settings/apps/new?state=…` with `default_permissions:{issues:'write'}`, `default_events:['issues']`, `hook_attributes.url=/webhook`. `GET /setup/callback?code=…` → `fakeFetch` the conversions endpoint → page displaying the returned App ID / webhook secret / a note that the `pem` is **PKCS#1 and must be converted** before use.
- [ ] **Step 2** FAIL. **Step 3** implement. **Step 4** PASS. **Step 5 — commit** `feat: GitHub App manifest setup flow`.

## Task 13: CI + docs

**Files:** Create `.github/workflows/ci.yml`; Update `README.md`, `CLAUDE.md`, `docs/CHANGELOG.md`, `LICENSE`.

- [ ] **Step 1** `ci.yml` (mirror `punchin-email`): Node 22, `npm ci`, `npm test`, `npx wrangler deploy --dry-run`, **plus** a template-parity step: fetch punchin `main`'s two issue-form YAMLs and `diff` against `templates/*.yml` (fail on drift).
- [ ] **Step 2** flesh out `README.md` (setup incl. the **PKCS#1→PKCS#8** step, `wrangler` resource commands, secrets, custom domain, cron, Turnstile, relay-alias reply routing), expand `CLAUDE.md` module map, start `docs/CHANGELOG.md`, add Apache-2.0 `LICENSE`.
- [ ] **Step 3** run full suite `npm test` + `npm run check` → green. **Step 4 — commit** `chore: CI + docs`.

## Task 14: Full verification

- [ ] `npm test` all green; `npm run check` (wrangler dry-run) bundles clean.
- [ ] Manual `wrangler dev` smoke (forms render, styles/fonts load, `/` redirects) — record results.
- [ ] Hand the operator the setup checklist + the generated manifest URL; do **not** push/create the GitHub repo or deploy until the user says go.

---

## Appendix A — Verified API reference (2026-06-07 research)

### A§1 GitHub issue-form body rendering
Each submitted field → `### <label>` + blank line + value, fields separated by a blank line. `type:markdown` is **display-only, excluded** from the body. `input`/`textarea` → value as-is (textarea preserves newlines/markdown). `textarea` with `render:<lang>` → value wrapped in a ```<lang> fence. `dropdown` → selected option text; multi-select joined `", "`; empty optional → `None`. `input`/`textarea` empty optional → `_No response_` (literal, underscores). `checkboxes` → one `- [x] <label>` / `- [ ] <label>` per option in order. Headings use **label**, not id.

### A§2 Static assets + routing + cron
Default **asset-first**; set **`not_found_handling:"none"`** so unmatched paths reach `fetch()`. **No `assets/index.html`** or `/` is served as an asset. `export default { async fetch(req,env,ctx){}, async scheduled(controller,env,ctx){} }`. Cron under top-level `[triggers] crons=[...]`. `wrangler.toml`:
```toml
name = "punchin-feedback"
main = "src/index.js"
compatibility_date = "2026-06-06"
[assets]
directory = "./assets/"
binding = "ASSETS"
not_found_handling = "none"
[triggers]
crons = ["0 3 * * *"]
[[kv_namespaces]]
binding = "FEEDBACK"
id = "PLACEHOLDER"
[[r2_buckets]]
binding = "ATTACHMENTS"
bucket_name = "punchin-feedback-attachments"
[[send_email]]
name = "EMAIL"
[vars]
REPO_OWNER="PunchIn-App"
REPO_NAME="punchin"
TEMPLATE_REF="main"
APP_URL="https://trackmytime.today"
FROM_ADDRESS="feedback@trackmytime.today"
TURNSTILE_SITEKEY=""
ACCENT="#2D5BF5"
PROVENANCE_LABEL="via-web-form"
IMG_MAX_BYTES="5242880"
IMG_MAX_COUNT="5"
```
Router: `/`→302 `APP_URL`; `/bug`,`/feature`,`/submit`,`/webhook`,`/unsubscribe`,`/setup`,`/setup/callback`; `/a/<key>` via `pathname.match(/^\/a\/([^/]+)$/)`; else 404. Static `/styles.css`,`/fonts/*` never reach `fetch()`.

### A§3 R2 + multipart
`[[r2_buckets]] binding bucket_name`. `env.ATTACHMENTS.put(key, bytes, {httpMetadata:{contentType}, customMetadata:{...}})`; `get()`→ `object.body` stream, `object.writeHttpMetadata(headers)`, `headers.set('etag', object.httpEtag)`, `return new Response(object.body, {headers})`. `request.formData()`→ `File` (extends Blob): `.name/.type(untrusted)/.size`, `await file.arrayBuffer()`. Body cap 100MB (free plan); our 5MB cap → `arrayBuffer()` safe. Magic bytes: PNG `89 50 4E 47 0D 0A 1A 0A`; JPEG `FF D8 FF`; GIF `47 49 46 38 (37|39) 61`; WebP `RIFF`(0-3) **and** `WEBP`(8-11). `delete()`/`list()` ≤1000; `list({prefix})` + cursor.

### A§4 GitHub App
**(KEY)** App private key is **PKCS#1** (`BEGIN RSA PRIVATE KEY`); Web Crypto needs **PKCS#8** (`BEGIN PRIVATE KEY`) → one-time `openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem -out app.pkcs8.pem`. JWT RS256 = `RSASSA-PKCS1-v1_5`+`SHA-256`, all segments **base64url**; `iss`=app/client id, `iat`=now-60, `exp`=now+540 (≤600). Installation token: `POST /app/installations/{id}/access_tokens` (Bearer JWT) → `{token, expires_at}` (~1h); installation id from webhook `payload.installation.id` or `GET /repos/{o}/{r}/installation`. Create issue: `POST /repos/{o}/{r}/issues` (Bearer install token) body `{title,body,labels}` → 201 `{number,html_url}`. **Every** request needs `Authorization`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, and a **`User-Agent`** (else 403). Webhook: `X-Hub-Signature-256 = 'sha256='+hex(HMAC-SHA256(secret, RAW body))` — read `request.text()` **before** JSON.parse, verify with `crypto.subtle.verify('HMAC',…)` (constant-time). Test vector: secret `It's a Secret to Everybody`, body `Hello, World!` → `sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17`. Manifest: POST form field `manifest`(JSON) to `github.com/settings/apps/new?state=…` → redirect `?code=` → `POST /app-manifests/{code}/conversions` (no auth, code ≤1h) → `{id, pem(PKCS#1), webhook_secret, client_id…}` (only returned once). Manifest fields: `name,url,hook_attributes.url,redirect_url,public,default_permissions:{issues:'write'},default_events:['issues']`.

### A§5 Email + Turnstile
`env.EMAIL.send({to, from:{email,name}, subject, html, text, replyTo, headers})` → `{messageId}` (binding uses `email`, not `address`). `List-Unsubscribe`/`List-Unsubscribe-Post` whitelisted; `List-Unsubscribe` needs `<https…>`/`<mailto…>` (no plain http); `List-Unsubscribe-Post` exactly `List-Unsubscribe=One-Click`. From/To/Subject/Reply-To via API fields, not `headers`. ≤50 recipients; transactional only; paid plan → arbitrary recipients; domain onboarded (`wrangler email sending enable`). Turnstile: `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` FormData `secret,response,remoteip?` → `{success, 'error-codes':[], hostname, action}`; token single-use, 300s. Client: `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer>`; `<div class="cf-turnstile" data-sitekey="…">`; server reads `formData.get('cf-turnstile-response')`.

---

## Self-review

- **Spec coverage:** forms/templates (T2,9,10) · issue body parity (T3) · GitHub App+issue (T7) · screenshots+retention (T6,11) · email+prefs+unsubscribe (T4,8,11) · webhook closed/reopened+dedup (T11) · spam (T5) · cron sweep (T6,11) · self-host manifest (T12) · privacy disclosures (T9) · CI parity (T13). App PR = separate plan (noted). ✔
- **Type consistency:** the locked field-schema / issue-record / KV-key shapes are used identically across T2–T11. ✔
- **No placeholders:** load-bearing code is specified via Appendix A; simple modules give exact test assertions + signatures. Resource ids are intentionally `PLACEHOLDER` until the operator creates them.
