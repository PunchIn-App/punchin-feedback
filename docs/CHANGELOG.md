# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses semantic versioning.

## [Unreleased]

## [1.3.0] — 2026-08-16

Hardening pass across the public form, the filed-issue body, and the operator
setup routes. `MINOR` (new configurable var; reporter-observable change to the
filed issue).

### Security

- **The bot check now fails closed.** With `TURNSTILE_SECRET` unset, the check
  returned a pass for every submission while the widget still rendered from the
  public sitekey — so a misconfigured deployment looked protected and accepted
  everything, with nothing in the logs to say so. A missing secret is always a
  misconfiguration, so it is now treated as a failure rather than a bypass.
- **Security headers on every response.** `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer` are now set on the
  forms, the setup pages, and on user-uploaded attachments served from R2, which
  are returned `Content-Disposition: inline` and so benefited most from `nosniff`.
  A content-security policy is deliberately not included yet: the forms carry
  inline scripts that must be hashed first.
- **The setup routes are no longer reachable in production.** `/setup` and
  `/setup/callback` were unauthenticated and had no completion gate, and the page
  renders the GitHub App private key and webhook secret. They are now behind an
  environment variable that is unset in production, and the pages that render
  secrets send `cache-control: no-store`. The OAuth `code` is also URL-encoded
  before being placed in an api.github.com path.

### Changed

- **Untrusted text is neutralised before it reaches the issue body.** A
  submission could previously mention real GitHub users from this app's identity,
  or close the code fence around a textarea value and continue in markdown. An
  `@` that GitHub could linkify is now defused, and the fence is chosen to be
  longer than any run of backticks in the value. An `@` that cannot begin a
  mention is left alone, so email addresses, `user@host` strings and version
  specifiers such as `pkg@2.1.0` survive intact.
- **Workers Logs observability enabled.**

---

## [1.2.0] — 2026-06-11

### Changed
- **App-context windows can now genuinely close themselves.** Browsers only honour
  `window.close()` when the window has an opener or its back/forward stack holds fewer than two
  entries (the OAuth-popup pattern). The app opens the forms with `noopener`, and a native POST
  navigation made the success page entry #2 — so the v1.1.1 Close button always fell back to the
  ✕ hint. In app context the form now submits via `fetch()` and the response (success, form
  error, or error page) replaces the document in place, keeping the stack at one entry — the
  Close button is then permitted to dismiss the tab/Custom Tab. Native form POST remains for
  direct visitors, no-JS, and as the automatic fallback if `fetch()` fails. (#6 follow-up)

## [1.1.1] — 2026-06-11

### Fixed
- **App-context exit is now best-effort, not just instructional.** The success/message pages'
  "close this window" guidance gains a **Close this window** button that attempts
  `window.close()` — which works when the form was opened as a plain script-opened tab — and,
  where the in-app overlay (Android Custom Tab / iOS in-app Safari) refuses it, the button swaps
  for a pre-rendered hint pointing at the overlay's own ✕. The static instruction line remains
  for the no-JS case. (#6 follow-up)

## [1.1.0] — 2026-06-11

### Fixed
- **In-app overlay exit (#6).** The form's "← PunchIn" back link and the post-submit "Done" button
  pointed at `/`, which — inside the in-app browser overlay the PWA opens (Android Custom Tab /
  iOS in-app Safari) — loaded a second copy of the app *inside the overlay* instead of returning
  to the PWA. The app now marks its links with `?from=app` (carried through the form like
  theme/accent); in that context the pages drop every root link and show "close this window to
  get back to PunchIn" instead. Direct visitors keep a link, relabelled "Back to PunchIn".
  Requires the companion `punchin` change that adds the param to its feedback links.

### Changed
- **Relicensed Apache-2.0 → Business Source License 1.1** (PR #4), matching the PunchIn app's
  licensing model. Individuals may still use, modify, and self-host the worker to run feedback
  intake for a project or repository they personally control, at no charge (the LICENSE's
  Additional Use Grant); organizational use requires a commercial license from PunchIn-App.
  On the Change Date (2030-06-02) the work relicenses to AGPL-3.0.

## [1.0.1] — 2026-06-08

First tagged release. The account-free intake worker and two-way issue comments,
plus repo governance scaffolding and project-board automation brought to parity
with the sibling `punchin-email` worker.

### Added
- **Two-way issue comments.** A reporter can opt into "Email me when someone comments"; each new
  maintainer comment is emailed to them, and they can **reply by email** — the reply is posted back
  as an issue comment (attributed to them, quoted history stripped). Inbound replies are gated by
  `ENABLE_EMAIL_REPLIES` + an Email Routing rule; comment notifications work without it. Sender is
  verified against the reporter's address; the worker's own comments are skipped (no loop).
- Initial `punchin-feedback` Cloudflare Worker: account-free bug-report / feature-request intake.
  - Two forms (`/bug`, `/feature`) derived from the live GitHub issue-form templates (with a KV
    cache and a bundled offline fallback), rendering near-identically to the GitHub forms.
  - Files real GitHub issues via a GitHub App (RS256 JWT → cached installation token), formatting
    the body to match GitHub's own issue-form output.
  - Optional reporter email with copy / closed / reopened notifications; every email carries an
    unsubscribe link at the top of the body plus `List-Unsubscribe` headers.
  - Screenshot uploads stored in R2 and embedded in the issue, with magic-byte validation and a
    reopen-aware retention sweep (deleted at the earlier of 1 year from upload/reopen and 30 days
    from close).
  - Reporter email purged 3 months after the issue is closed (or ~1 year if it stays open), or on
    unsubscribe.
  - Spam controls: honeypot, per-IP rate limit, and optional Cloudflare Turnstile.
  - One-click GitHub App creation via the App Manifest flow (`/setup`).
  - 92 unit + integration tests; CI runs the suite, a `wrangler` dry-run, and a template-parity
    check against `punchin`'s default branch.
