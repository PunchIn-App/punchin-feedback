# Security Policy

## Supported Versions

Only the latest release of the PunchIn Feedback Worker is actively supported
with security updates.

| Version | Supported |
| ------- | --------- |
| 1.0.x   | Yes       |
| < 1.0   | No        |

## Scope

The PunchIn Feedback Worker is the Cloudflare Worker that powers
`feedback.trackmytime.today` — the account-free bug-report / feature-request
intake that files real GitHub issues on a reporter's behalf. In scope are:

- The worker source (`src/index.js` and the modules it composes:
  `templates.js`, `issueBody.js`, `github.js`, `attachments.js`, `email.js`,
  `unsubscribe.js`, `spam.js`, `render.js`, `setup.js`) and its routing logic.
- The GitHub App credential handling — the App private key (PKCS#8), the RS256
  JWT, and the KV-cached installation token — and the webhook HMAC verification
  (`verifyWebhook`, over the raw body) and idempotency.
- The reporter map and caches in the `FEEDBACK` KV namespace. Entries hold the
  reporter's email (only if they opted in), the issue mapping, the template
  cache, the GitHub-token cache, webhook-dedup markers, the per-IP rate-limit
  counters, and image-expiry due-markers.
- Uploaded screenshots in the `ATTACHMENTS` R2 bucket, their magic-byte
  validation, the obscured serving keys, and the reopen-aware retention sweep.
- The unsubscribe token signing (`signUnsub`/`verifyUnsub`, HMAC) and the
  outbound notification email path.
- The inbound reply path (`comment+<id>@<domain>` → posted as an issue comment),
  including sender verification against the reporter's address and the
  self-comment / mail-loop guard.
- The spam controls: the honeypot, the per-IP rate limit, and Cloudflare
  Turnstile verification.

Out of scope:

- The PunchIn app itself and the issues once filed — those live in the
  [`punchin`](https://github.com/PunchIn-App/punchin) repository.
- Mail once it has been delivered to a reporter's inbox, which is governed by
  that provider's own security.
- The deliverability posture of the domain itself (SPF/DKIM/DMARC/MX records),
  except where the worker is responsible for what it (re-)sends.

> Because this worker files issues **on a reporter's behalf** and stores their
> email address, two classes of bug are especially in-scope: anything that could
> expose a reporter's email (in a public issue, an error page, or a log), and
> anything that would let one person file or comment **as** another reporter
> (e.g. forging the inbound reply sender or replaying a webhook).

## Reporting a Vulnerability

Please do **not** report security vulnerabilities through public GitHub issues.

Instead, report them privately by either:

- Emailing **[cve@trackmytime.today](mailto:cve@trackmytime.today)**, or
- Using GitHub's built-in security advisory feature: **[Report a vulnerability](https://github.com/PunchIn-App/punchin-feedback/security/advisories/new)**

If a CVE has already been assigned, please email the sub-addressed form
`cve+<number>@trackmytime.today` instead — for example, `cve+542161425@trackmytime.today`
for CVE-542161425 — so your report is automatically grouped by its CVE ID.

### What to include

Please include as much of the following as possible:

- A description of the vulnerability and its potential impact
- Steps to reproduce or proof-of-concept code
- The affected version(s)
- Any suggested fix or mitigation if you have one

### What to expect

- **Acknowledgement**: We aim to acknowledge your report within 48 hours
- **Status update**: We aim to provide an assessment and estimated timeline within 7 days
- **Resolution**: We aim to patch critical vulnerabilities within 14 days

If a vulnerability is accepted, we will coordinate a fix and disclosure timeline with you. If it is declined, we will explain why.

We appreciate responsible disclosure and will credit reporters in the release notes unless you prefer to remain anonymous.
