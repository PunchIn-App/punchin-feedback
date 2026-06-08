# punchin-feedback — AI Assistant Guide

A Cloudflare Worker providing an **account-free** bug-report / feature-request intake for the
[PunchIn](https://github.com/PunchIn-App/punchin) app: it files real GitHub issues on a reporter's
behalf via a GitHub App, hosts screenshot uploads in R2, and optionally emails the reporter a copy
plus close/reopen follow-ups.

**Status:** built — 70 tests passing, bundles clean (`npm run check`). The authoritative design is
[`docs/2026-06-07-punchin-feedback-design.md`](docs/2026-06-07-punchin-feedback-design.md); the
build plan lives in `docs/superpowers/plans/`. **Read the design before changing anything**, and
keep both current as code changes.

## Conventions (mirror the sibling `punchin-email` worker)

- ES modules, Node ≥ 22, **no build step**. Tests run under `vitest` (node environment) with test
  doubles for the bindings (KV / R2 / EMAIL / `fetch`).
- Pure, runtime-agnostic logic lives in small, focused modules; `src/index.js` keeps to its
  `fetch()` / `scheduled()` entrypoints + the request/webhook/cron handlers.
- **No PII or secrets in `wrangler.toml [vars]`** — secrets go through `wrangler secret put`.
- Reject/҂fail safely: a filed issue must never be lost to a downstream (KV/email) hiccup; webhook
  handling is HMAC-verified and idempotent.

## Module map (`src/`)

| Module | Responsibility |
|---|---|
| `index.js` | `export default { fetch, scheduled, email }` — route table + the submit/webhook/unsubscribe/image handlers, the cron sweep, and the **inbound email handler** (a reporter's reply to `comment+<id>@` → posted as an issue comment via `stripQuoted` + `createComment`). The webhook also handles `issue_comment.created` → notifies the reporter. Composes every other module. |
| `templates.js` | `parseIssueForm(yaml)` → field schema; `loadTemplate(env, kind)` fetches the live template via the **authenticated GitHub Contents API** (App needs `Contents: read` — the target repo is private), caches in KV, falls back to `bundledTemplates.js` if the fetch fails. |
| `bundledTemplates.js` | **Generated** by `scripts/sync-bundled.mjs` from `templates/*.yml` — the offline fallback. Don't hand-edit. |
| `issueBody.js` | `formatIssueBody` / `buildIssue` — values → exact GitHub issue-form markdown (`### label`, `_No response_`, dropdown/checkbox rules; `markdown` blocks excluded). |
| `github.js` | `appJwt` (RS256/PKCS#8), `installationToken` (KV-cached ~1h), `createIssue`, `verifyWebhook` (HMAC, raw body). |
| `attachments.js` | `detectImageType` (magic bytes), `parseUploads`, `putImage`/`serveImage` (R2), reopen-aware `scheduleExpiry`/`cancelExpiry`/`sweepExpired`. |
| `email.js` | `buildCopyEmail`/`buildClosedEmail`/`buildReopenEmail` (unsubscribe-at-top + `List-Unsubscribe`) and `sendEmail`. |
| `unsubscribe.js` | `signUnsub`/`verifyUnsub` — HMAC tokens encoding the issue number + expiry. |
| `spam.js` | `checkHoneypot`, `rateLimit` (per-IP KV), `verifyTurnstile`. |
| `render.js` | `renderForm`/`renderSuccess`/`renderError`/`renderMessage` — brand HTML, inline UA sniff, disclosures, Turnstile widget. |
| `setup.js` | `handleSetup`/`handleSetupCallback` — GitHub App manifest one-click flow. |

## Other layout

```
assets/      self-hosted styles.css + Noto WOFF2 (served by Workers Static Assets)
templates/   committed issue-form .yml copies (fallback source; CI checks vs punchin main)
scripts/     sync-bundled.mjs (templates/*.yml -> src/bundledTemplates.js)
test/        one vitest suite per module + helpers.js (binding test-doubles)
docs/        design spec, build plan, CHANGELOG
```

## Conventions worth keeping

- **Submit is best-effort after `createIssue`:** once the issue is filed, KV persistence and the
  copy email must never turn it into a user-facing error.
- **Webhook:** verify HMAC on the **raw** body before `JSON.parse`; dedup by `X-GitHub-Delivery`;
  the issue mapping survives close (reopen needs it) and is governed by a state-dependent KV TTL.
- **Retention is app-managed** (KV due-markers + cron), not an R2 lifecycle rule, because the
  1-year image clock resets on reopen.
- **Turnstile `api.js` can't take an SRI hash** (first-party, auto-updated) — that's the only
  external script, and the exception is noted in `render.js`.
