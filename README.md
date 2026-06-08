# punchin-feedback

Account-free **bug report / feature request** intake for
[PunchIn](https://github.com/PunchIn-App/punchin).

People without a GitHub account fill in two web forms that are **derived from the project's own
`.github/ISSUE_TEMPLATE/*.yml`** templates; this Cloudflare Worker files a real GitHub issue on
their behalf (via a GitHub App), hosts screenshot uploads (Cloudflare R2), and — if the reporter
opts in with their email — sends a copy plus follow-ups when the issue is closed or reopened.

Served at **`feedback.trackmytime.today`**. Self-hostable for any repo/domain — same ethos as the
sibling [`punchin-email`](https://github.com/PunchIn-App/punchin-email) worker.

## How it works

```
GET  /            → redirect to the app
GET  /bug         → Bug form        (rendered from bug_report.yml; env metadata auto-fills)
GET  /feature     → Feature form    (rendered from feature_request.yml)
POST /submit      → validate → spam-gate → upload images → create issue → email copy
POST /webhook     → GitHub App issues.closed / issues.reopened → notify + manage retention
GET  /unsubscribe → stop a reporter's future emails (HMAC-signed token)
GET  /a/<key>     → serve an uploaded screenshot from R2
GET  /setup       → one-click GitHub App creation (manifest flow)
scheduled (daily) → delete screenshots past their retention window
```

A submitted issue is formatted to match GitHub's own issue-form rendering, so it's
indistinguishable from one filed by a logged-in user. The reporter's email is never written to the
public issue — it lives only in KV, and is purged 3 months after the issue is closed (or ~1 year if
it stays open), or immediately on unsubscribe. Screenshots are deleted 1 year after upload (reset if
the issue is reopened) or 30 days after close, whichever is first. Both retentions are disclosed on
the form.

## Setup

### 1. Cloudflare resources

```bash
npx wrangler kv namespace create FEEDBACK     # put the id in wrangler.toml [[kv_namespaces]]
npx wrangler r2 bucket create punchin-feedback-attachments
npx wrangler email sending enable trackmytime.today   # one-time domain onboarding for sending
```
The custom domain and the daily cron are already declared in `wrangler.toml` and provision on
deploy.

### 2. The GitHub App (one-click)

Deploy once (`npm run deploy`), then visit **`https://feedback.trackmytime.today/setup`** and click
**Create the GitHub App**. It creates an App with `Issues: write` (file issues) + `Contents: read`
(read the issue templates live — needed when the target repo is **private**) and an `Issues` webhook
pointed at `/webhook`. Install it on `PunchIn-App/punchin`; the callback page then shows the exact
secret commands.

> If your App was created before `Contents: read` was added, edit the App → **Permissions & events
> → Repository permissions → Contents → Read-only**, save, then approve the permission update on the
> installation (**org → Settings → GitHub Apps → your App → Configure → review request**). Until
> then the form renders from the bundled template copies (it never breaks — it just won't track live
> template edits).

> ⚠️ GitHub issues the App private key in **PKCS#1**, but Web Crypto needs **PKCS#8**. Convert once:
> ```bash
> openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem -out app.pkcs8.pem
> ```
> …and store `app.pkcs8.pem` as `GITHUB_APP_PRIVATE_KEY`.

### 3. Secrets

```bash
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY    # the PKCS#8 PEM
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put UNSUB_SECRET              # any long random string
npx wrangler secret put TURNSTILE_SECRET          # optional (spam protection)
```

### 4. Turnstile (optional, recommended)

Create a Turnstile widget for `feedback.trackmytime.today`; set `TURNSTILE_SITEKEY` (in
`wrangler.toml [vars]`) and `TURNSTILE_SECRET` (secret). Without it, the honeypot + per-IP
rate-limit still apply.

> ⚠️ Set **both or neither**. Sitekey only → an unverified widget; secret only → every real
> submission fails verification and reporters are locked out.

### 5. Deploy

```bash
npm run deploy
```

### 6. Optional wiring

- **Reporter replies:** add `feedback` to the `punchin-email` relay's `ALLOWED_ALIASES` so replies
  to the notification emails route to your inbox.
- **In-app links:** point the PunchIn app's Settings → About at
  `feedback.trackmytime.today/{bug,feature}` with `version`/`install-type` query params (see the
  app's `src/utils/issueUrl.js`).

## Configuration (`wrangler.toml [vars]`)

| Var | Meaning |
|---|---|
| `REPO_OWNER` / `REPO_NAME` | Target repo for filed issues |
| `TEMPLATE_REF` | Branch the issue templates are read from (`main`) |
| `APP_URL` | Where `/` redirects + email links |
| `FROM_ADDRESS` | Sender for notification emails |
| `TURNSTILE_SITEKEY` | Public Turnstile key (blank = Turnstile off) |
| `ACCENT` | Brand accent colour |
| `PROVENANCE_LABEL` | Extra label on web-filed issues |
| `IMG_MAX_BYTES` / `IMG_MAX_COUNT` | Screenshot caps |

Secrets (never in `[vars]`): `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`,
`UNSUB_SECRET`, `TURNSTILE_SECRET`.

## Development

```bash
npm install
npm test                # vitest run (70 tests, mocked bindings)
npm run check           # wrangler deploy --dry-run (bundles, no upload)
npm run dev             # wrangler dev (local worker)
npm run sync-templates  # regenerate src/bundledTemplates.js from templates/*.yml
```

The design spec is in [`docs/2026-06-07-punchin-feedback-design.md`](docs/2026-06-07-punchin-feedback-design.md);
the build plan in [`docs/superpowers/plans/`](docs/superpowers/plans/).

## License

[Apache-2.0](LICENSE).
