# punchin-feedback — AI Assistant Guide

A Cloudflare Worker providing an **account-free** bug-report / feature-request intake for the
[PunchIn](https://github.com/PunchIn-App/punchin) app: it files real GitHub issues on a reporter's
behalf via a GitHub App, hosts screenshot uploads in R2, and optionally emails the reporter a copy
plus close/reopen follow-ups.

**Status:** under construction. The authoritative design is
[`docs/2026-06-07-punchin-feedback-design.md`](docs/2026-06-07-punchin-feedback-design.md); the
build plan lives in `docs/superpowers/plans/`. **Read the design before changing anything**, and
keep both current as code lands.

## Conventions (mirror the sibling `punchin-email` worker)

- ES modules, Node ≥ 22, **no build step**. Tests run under `vitest` (node environment) with test
  doubles for the bindings (KV / R2 / EMAIL / `fetch`).
- Pure, runtime-agnostic logic lives in small, focused modules; `src/index.js` keeps to its
  `fetch()` / `scheduled()` entrypoints + the request/webhook/cron handlers.
- **No PII or secrets in `wrangler.toml [vars]`** — secrets go through `wrangler secret put`.
- Reject/҂fail safely: a filed issue must never be lost to a downstream (KV/email) hiccup; webhook
  handling is HMAC-verified and idempotent.

## Layout

```
src/         worker modules (see the design doc §4/§17)
assets/      self-hosted brand CSS + Noto fonts
templates/   bundled last-known-good copies of the issue-form .yml (fallback floor)
test/        vitest suites (one per module)
docs/        design spec + build plan + CHANGELOG
```

(Expanded module-by-module as the implementation lands.)
