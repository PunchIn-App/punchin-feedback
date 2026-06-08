# Contributing to PunchIn Feedback Worker

Thanks for your interest in contributing!

## License of Contributions

This project is licensed under the [Apache License 2.0](../LICENSE). Per section
5 of that license, any contribution you intentionally submit for inclusion in
the project is provided under the same license, with no additional terms — no
separate CLA to sign.

## Reporting Security Vulnerabilities

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report them privately by emailing
[cve@trackmytime.today](mailto:cve@trackmytime.today) or using GitHub's private
advisory system:
**[Report a vulnerability →](https://github.com/PunchIn-App/punchin-feedback/security/advisories/new)**

See [SECURITY.md](../SECURITY.md) for the full policy, supported versions, and response timeline.

## Code of Conduct

This project follows a [Code of Conduct](../CODE_OF_CONDUCT.md). By participating, you
agree to uphold it. Report unacceptable behavior privately to
[abuse@trackmytime.today](mailto:abuse@trackmytime.today).

---

## Getting Started

```bash
git clone https://github.com/PunchIn-App/punchin-feedback.git
cd punchin-feedback
npm install
npm test              # run the Vitest suite once
npm run test:watch
npm run check         # wrangler deploy --dry-run (bundles, no upload)
npm run dev           # wrangler dev (local worker)
npm run sync-templates # regenerate src/bundledTemplates.js from templates/*.yml
```

A build is considered passing when **all** of the following succeed:

```bash
npm test
npm run check
node scripts/sync-bundled.mjs && git diff --exit-code src/bundledTemplates.js
```

CI enforces this on every push to `main` and on every PR (the test + dry-run job
and a separate `template-sync` job that fails if `src/bundledTemplates.js` is out
of step with `templates/*.yml`).

---

## Deployment & secrets

The worker is deployed with `npm run deploy` (`wrangler deploy`). The custom
domain (`feedback.trackmytime.today`) and the daily retention cron are declared
in `wrangler.toml` and provision on deploy — see the **Setup** section of
[`README.md`](../README.md).

Configuration lives in `wrangler.toml`:

- **Non-secret vars** (`REPO_OWNER`, `REPO_NAME`, `TEMPLATE_REF`, `APP_URL`,
  `FROM_ADDRESS`, `TURNSTILE_SITEKEY`, `ACCENT`, `PROVENANCE_LABEL`,
  `IMG_MAX_BYTES`, `IMG_MAX_COUNT`, `ENABLE_EMAIL_REPLIES`) go in the `[vars]`
  block. These are committed to the repo, so **never put a secret or personal
  address here.**
- **Secrets** — `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (the PKCS#8 PEM),
  `GITHUB_WEBHOOK_SECRET`, `UNSUB_SECRET`, and the optional `TURNSTILE_SECRET` —
  are set with `wrangler secret put <NAME>` and read from `env.<NAME>` at
  runtime. Reporters' email addresses are likewise PII and live only in KV,
  never in `[vars]`.

Bindings (`FEEDBACK` KV, `ATTACHMENTS` R2, `EMAIL` send binding, `ASSETS`) are
declared in `wrangler.toml`; changing a binding name requires updating both the
config and `src/index.js`.

---

## Workflow

1. Fork the repo and create a branch from `main`
2. Make your changes — see [`CLAUDE.md`](../CLAUDE.md) for architecture conventions
3. If you edited anything under `templates/`, run `npm run sync-templates` and commit `src/bundledTemplates.js`
4. Add or update tests under `test/` and run `npm test`
5. Run `npm run check` to confirm the worker still bundles
6. Follow the **versioning**, **documentation**, and **testing** requirements below
7. Open a pull request with a clear description

---

## Versioning

The worker uses **semantic versioning** (`MAJOR.MINOR.PATCH`). It is currently
**pre-1.0**: while on `0.x`, a behaviour change that would otherwise be `MAJOR`
lands as a `MINOR` bump (there is no `1.0.0` API-stability promise yet). Use the
table below; the `0.` prefix is what signals "not yet stable."

### What triggers each increment

| Change type | Increment |
|---|---|
| Change to reporter-facing behaviour (the forms, the submit result, the emails) | `MINOR` |
| New configurable var or binding | `MINOR` |
| New supported issue-form construct / template field type | `MINOR` |
| Bug fix in form rendering, issue creation, the webhook, email, or image handling | `PATCH` |
| New safety/robustness guard with no behaviour change for normal submissions | `PATCH` |
| Internal refactor (no behaviour change) | `PATCH` |
| Dependency update (no behaviour change) | `PATCH` |
| Template re-sync only (`npm run sync-templates`, no logic change) | `PATCH` |
| Test additions only | no bump |
| CI / workflow config change only | no bump |
| Documentation-only change | no bump |

**Tiebreaker:** if a reporter or a maintainer would observe the change (a
different form, a different filed issue, a different email), it's at least
`MINOR`.

### When a version bump is required

A version bump commit must update **all** of the following in the same PR:

| File | What to change |
|---|---|
| `package.json` | `"version"` field — source of truth |
| `README.md` | Version badge URL |
| `CLAUDE.md` | `**Version:**` in the header |
| `docs/CHANGELOG.md` | New section at the top (see format below) |
| `SECURITY.md` | Keep the **Supported Versions** "0.x (latest)" row pointing at the new release (post-1.0, set the new `X.Y.x` row to **Yes** and mark prior versions **No**) |

Commit message convention: `chore: bump to vX.Y.Z`

### Cutting a release

Once the version-bump PR is merged to `main`, publish the release so the
GitHub sidebar and the version badge line up with the code:

1. Make sure `main` is up to date and green: `git checkout main && git pull`,
   then `npm test` and `npm run check`.
2. Tag the release commit: `git tag -a vX.Y.Z -m "vX.Y.Z"` (annotated tags only).
3. Push the tag: `git push origin vX.Y.Z`.
4. **Create a GitHub release** from the tag, using the matching
   `docs/CHANGELOG.md` section as the notes:

   ```bash
   gh release create vX.Y.Z \
     --title "vX.Y.Z" \
     --notes-file <(sed -n '/## \[X.Y.Z\]/,/^## \[/p' docs/CHANGELOG.md | sed '$d')
   ```

   (Or `gh release create vX.Y.Z --generate-notes` to let GitHub draft the
   notes from merged PRs, then edit to match the changelog.)
5. Deploy: `npm run deploy`.

The tag name (`vX.Y.Z`) must match the `package.json` version exactly. Don't
create a release for a version that isn't yet on `main`.

---

## Documentation Requirements

Every PR that changes code must update the relevant documentation in the **same
PR**. This is not optional — stale docs are treated as a bug.

| What changed in your PR | `CLAUDE.md` | `README.md` | `docs/CHANGELOG.md` |
|---|---|---|---|
| New module or helper in `src/` | Add to the Module map | — | — |
| New/changed handler, route, or guard | Update the relevant section | ✓ if behaviour changes | ✓ |
| New config var or binding | Update Configuration & Bindings | Update Configuration table | ✓ |
| New form field / template behaviour | Update the `templates.js` / `issueBody.js` rows | ✓ | ✓ |
| Version bump | Update `**Version:**` header | Update version badge | Add new section |

---

## CHANGELOG Format

Add a new section at the very top of `docs/CHANGELOG.md`. Follow
[Keep a Changelog](https://keepachangelog.com/):

```markdown
## [X.Y.Z] — YYYY-MM-DD

### Added
- Forms — short description of a new capability

### Changed
- Submit — what changed and how it differs from before

### Fixed
- Webhook — what was broken and what it does now

### Security
- Hardened — what was tightened and why
```

Rules:
- Omit sections that have no entries
- Write from the reporter's / maintainer's perspective, not the diff's
- Start each bullet with the area: `Forms — `, `Submit — `, `Webhook — `,
  `Email — `, `Attachments — `, `Setup — `, `Spam — `, etc.
- Internal refactors with no observable effect go under `Changed` with an `(internal)` suffix

---

## Testing

- Run `npm test` before opening a PR
- Each `src/` module has a matching suite under `test/`:
  `attachments.test.js`, `email.test.js`, `github.test.js`, `issueBody.test.js`,
  `render.test.js`, `setup.test.js`, `spam.test.js`, `templates.test.js`,
  `unsubscribe.test.js`
- End-to-end handler behaviour (every submit/webhook/unsubscribe/image path,
  including each rejection) is covered by `test/handlers.test.js`, and routing by
  `test/router.test.js`, using the binding test-doubles (KV / R2 / EMAIL /
  `fetch`) in `test/helpers.js`
- Do not remove or weaken existing tests

---

## Code Conventions

The full conventions are in [`CLAUDE.md`](../CLAUDE.md). Key rules:

- **Keep logic pure where possible** — small, focused, runtime-agnostic modules
  hold the logic; `src/index.js` keeps to its `fetch()` / `scheduled()` /
  `email()` entrypoints and the request/webhook/cron handlers, which are exported
  for testing.
- **Submit is best-effort after `createIssue`** — once the GitHub issue is filed,
  a downstream hiccup (KV persistence, the copy email) must **never** turn it into
  a user-facing error. The filed issue is the source of truth.
- **Verify webhooks before trusting them** — check the HMAC over the **raw** body
  before `JSON.parse`, dedup by `X-GitHub-Delivery`, and keep webhook handling
  idempotent. The issue mapping must survive close (reopen needs it).
- **Protect PII** — a reporter's email lives only in KV, never in a public issue,
  an error page, or a log. Honour the retention windows (email purged 3 months
  after close / ~1 year while open / immediately on unsubscribe; screenshots at
  the earlier of 1 year from upload-or-reopen and 30 days from close).
- **No secrets in `[vars]`** — see Deployment & secrets above.
- **Turnstile is both-or-neither** — a sitekey without a secret (or vice-versa)
  locks reporters out; the honeypot + per-IP rate limit are the always-on floor.
- **Keep `templates/` and `src/bundledTemplates.js` in sync** — `bundledTemplates.js`
  is generated by `npm run sync-templates`; never hand-edit it, and commit it
  alongside any `templates/` change (CI fails otherwise).
