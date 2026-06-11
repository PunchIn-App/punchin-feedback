# punchin-feedback

[![License: BUSL-1.1](https://img.shields.io/badge/license-BUSL--1.1-2D5BF5?style=flat)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/PunchIn-App/punchin-feedback/ci.yml?branch=main&style=flat&label=CI&color=2D5BF5)](https://github.com/PunchIn-App/punchin-feedback/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-1.1.1-2D5BF5?style=flat)](docs/CHANGELOG.md)

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
POST /webhook     → also: issue_comment.created → email the reporter (if opted in)
GET  /unsubscribe → stop a reporter's future emails (HMAC-signed token)
GET  /a/<key>     → serve an uploaded screenshot from R2
GET  /setup       → one-click GitHub App creation (manifest flow)
email()           → inbound reply to comment+<id>@<domain> → posted as an issue comment
scheduled (daily) → delete screenshots past their retention window
```

## Two-way comments (optional)

Reporters who tick "Email me when someone comments" get emailed on each new maintainer
comment, and can **reply by email** — the reply is posted back as a comment (attributed to them,
quoted history stripped). To enable:

1. **App:** subscribe to the **Issue comment** event (App → Permissions & events → Subscribe to events).
2. **Inbound replies (for the two-way part):** in Email Routing, route `comment@<your-domain>` (with
   subaddressing) to this worker (**Send to a Worker → punchin-feedback**). It coexists with a
   catch-all relay — specific rules win. Then set `ENABLE_EMAIL_REPLIES = "1"` in `wrangler.toml`.
   Until that's set, comment *notifications* still work; only the reply-by-email part is gated off
   (so a reply can't bounce off the relay's allowlist).

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
| `ENABLE_EMAIL_REPLIES` | Set to `"1"` to post reporters' email replies as issue comments (see [Two-way comments](#two-way-comments-optional)) |

Secrets (never in `[vars]`): `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`,
`UNSUB_SECRET`, `TURNSTILE_SECRET`.

## Development

```bash
npm install
npm test                # vitest run (92 tests, mocked bindings)
npm run check           # wrangler deploy --dry-run (bundles, no upload)
npm run dev             # wrangler dev (local worker)
npm run sync-templates  # regenerate src/bundledTemplates.js from templates/*.yml
```

The design spec is in [`docs/2026-06-07-punchin-feedback-design.md`](docs/2026-06-07-punchin-feedback-design.md);
the build plan in [`docs/superpowers/plans/`](docs/superpowers/plans/).

## Contributing

Contributions are welcome. See [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md)
for the workflow, versioning, documentation, and testing requirements.
Contributions require agreeing to the
[Contributor License Agreement](.github/CLA.md) — you sign by including the
sign-off line from the PR template in your pull request description. This
project follows a [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please do not file public issues for vulnerabilities. Email
[cve@trackmytime.today](mailto:cve@trackmytime.today) (or `cve+<number>@…` if a
CVE is assigned) — see [SECURITY.md](SECURITY.md) for the full policy.

## License

[Business Source License 1.1](LICENSE) — any individual may use, modify, and
self-host the worker to run feedback intake for a project or repository they
personally control, at no charge. Organizational use (a company, agency, or
other legal entity deploying it as part of its internal tooling, support
infrastructure, or operations) requires a commercial license from PunchIn-App
([licensing@trackmytime.today](mailto:licensing@trackmytime.today)). On the
Change Date (2030-06-02) the license converts to the
[GNU AGPL v3.0](https://www.gnu.org/licenses/agpl-3.0.en.html).
