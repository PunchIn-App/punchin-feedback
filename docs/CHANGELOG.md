# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses semantic versioning.

## [Unreleased]

### Added
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
  - 70 unit + integration tests; CI runs the suite, a `wrangler` dry-run, and a template-parity
    check against `punchin`'s default branch.
