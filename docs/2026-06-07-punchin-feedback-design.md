# punchin-feedback — Design Spec

**Date:** 2026-06-07 (rev. 3 — retention rules refined)
**Status:** Approved in principle (brainstorming) — pending final spec review
**Author identity for this repo:** `punchIn-app-bot` (workspace identity lock applies)

---

## 1. Summary

A self-hosted, **account-free** bug-report / feature-request intake for the
[PunchIn](https://github.com/PunchIn-App/punchin) app. People with no GitHub account fill in one of
two web forms that are **derived from the project's own GitHub issue-form templates**, so the forms
and the resulting issues are *near-identical* to the native GitHub experience. The service files a
real GitHub issue on their behalf, can host screenshot uploads, and (optionally) emails the reporter
a copy plus follow-ups when the issue is closed or reopened.

It is a **new standalone Cloudflare Worker + repo, `punchin-feedback`**, served at
**`feedback.trackmytime.today`**, written to be **self-hostable for any repo/domain** (same ethos as
the sibling `punchin-email` worker) — everything `punchin`-specific is configuration.

### Goals

- `/bug` and `/feature` forms that **mirror the GitHub issue-form templates field-for-field**, by
  deriving the form *and* the issue-body formatting from the same template YAML (§5).
- No GitHub account required to submit.
- Email is **optional**; if given, the reporter chooses via checkboxes which mails they want:
  a copy (pre-checked), a close notification, and a reopen notification (§9).
- **Screenshot upload** that renders inline in the filed issue (§8).
- Bug-form environment fields (**version, install type, browser, OS, device**) **autopopulate** (§6).
- Submitted issues are *near-identical* to natively-filed ones (same field rendering, same labels).
- Every email carries a working **unsubscribe link at the very top** + `List-Unsubscribe` (§9).

### Non-goals (v1)

- **Using GitHub's native "add files" attachment uploader.** *Confirmed infeasible:* GitHub has no
  supported API for it — uploads are bound to a logged-in browser session and explicitly reject
  PATs / OAuth Apps / GitHub Apps (a deliberate abuse boundary). A server authenticating as a
  GitHub App cannot use it. We therefore self-host uploads in R2 and embed them as markdown (§8).
  Refs: [community #46951](https://github.com/orgs/community/discussions/46951),
  [community #28219](https://github.com/orgs/community/discussions/28219),
  [cli/cli #12960](https://github.com/cli/cli/issues/12960).
- An authenticated **admin UI** (no runtime-editable settings needed in v1).
- Field types beyond what GitHub issue forms define (we support `markdown`, `input`, `textarea`,
  `dropdown`, `checkboxes` — the full issue-form set).

---

## 2. Key facts established during design

- **Cloudflare Email Sending (`send_email`) sends to arbitrary recipients** (the "verified
  destination" rule is inbound-`forward()` only). `trackmytime.today` is already onboarded (the
  relay sends from it), so DKIM/SPF/DMARC are in place.
- **GitHub issue authorship cannot be spoofed.** `POST /issues` has no author field; the author is
  always the authenticating identity. → We drop the reporter-name field entirely (an unverified
  name in the body adds noise); only an optional email is collected, for notifications.
- **Issue author = a GitHub App bot** (`<app-slug>[bot]`), chosen for reusable distribution
  (per-installation bot, least-privilege, built-in webhook, App-manifest one-click install).
- **No supported GitHub attachment API** (see non-goals) → R2-hosted screenshots embedded as
  markdown.
- **`punchin` is a public repo** → issue-template YAML is fetched **unauthenticated** from
  `raw.githubusercontent.com` (§5), so the App needs only `Issues: write`. *(If the repo were
  private, add `Contents: read` to the App and fetch via the API instead.)*

---

## 3. Architecture

One Worker. `fetch()` serves the forms + handles submit/webhook/unsubscribe/asset routes;
`scheduled()` runs the retention sweep.

```
GET  /            → 302 redirect to APP_URL
GET  /bug         → Bug form     (rendered from the live bug_report.yml)
GET  /feature     → Feature form (rendered from the live feature_request.yml)
POST /submit      → multipart: validate → spam-gate → upload images→R2 → create issue
                     (embed image markdown) → store issue→{email,prefs,images} in KV → send copy
POST /webhook     → GitHub App webhook: issues.closed / issues.reopened → notify per prefs
                     (idempotent via X-GitHub-Delivery) → schedule/cancel image expiry
GET  /unsubscribe → HMAC-signed token → stop this issue's future notifications
GET  /a/<key>     → serve an uploaded image from R2
GET  /styles.css, /fonts/*  → static brand assets (self-hosted Noto; no CDN)
scheduled()       → daily: delete images past retention (min of 1yr-from-upload-or-reopen and 30d-from-close)
```

### Bindings, vars, secrets

| Kind | Name | Purpose |
|---|---|---|
| `send_email` | `EMAIL` | Outbound mail from `feedback@trackmytime.today` (same DKIM as the relay). |
| KV | `FEEDBACK` | template cache, GH token cache, issue→reporter map, webhook dedup, rate-limit, image-expiry index. |
| R2 | `ATTACHMENTS` | uploaded screenshots; deletion is **app-managed** via KV due-markers + the daily cron (the 1-year clock resets on reopen, so it can't be a static lifecycle rule). An optional long (e.g. 2yr) bucket lifecycle rule is kept only as an orphan backstop. |
| Static Assets | (assets) | `/styles.css` + `/fonts/*.woff2`. |
| Cron Trigger | (daily) | drives `scheduled()` retention sweep. |
| Secret | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | GitHub App auth (RS256). |
| Secret | `GITHUB_WEBHOOK_SECRET` | verify inbound webhook HMAC. |
| Secret | `UNSUB_SECRET` | sign/verify unsubscribe tokens. |
| Secret | `TURNSTILE_SECRET` | (optional) Turnstile verification. |
| Var | `REPO_OWNER`/`REPO_NAME` | `PunchIn-App` / `punchin`. |
| Var | `TEMPLATE_REF` | branch to read templates from — `main` (GitHub's live forms render from the default branch). |
| Var | `APP_URL` | `GET /` redirect + email links (`https://trackmytime.today`). |
| Var | `FROM_ADDRESS` | `feedback@trackmytime.today`. |
| Var | `TURNSTILE_SITEKEY` | (optional) public site key injected into forms. |
| Var | `ACCENT` | brand accent default `#2D5BF5` (fork-overridable). |
| Var | `PROVENANCE_LABEL` | (optional) extra label on web-filed issues, e.g. `via-web-form`. |
| Var | `IMG_MAX_BYTES`, `IMG_MAX_COUNT` | upload caps (e.g. 5 MiB, 5). |

> Mirrors `punchin-email`: **no PII or secrets in `[vars]`**.

---

## 4. Components (small, independently testable units)

| Module | Responsibility | Purity |
|---|---|---|
| `src/templates.js` | Fetch issue-form YAML (raw.githubusercontent, `main`) → parse → field schema; cache in KV (hours); bundled last-known-good fallback. | I/O + pure parse |
| `src/render.js` | schema + brand tokens → form / success / error HTML (incl. the client sniff + Turnstile + upload UI). | pure |
| `src/issueBody.js` | schema + submitted values + image URLs → GitHub-style issue body + title + labels. | pure |
| `src/github.js` | GitHub App auth (JWT → installation token, KV-cached ~1h) + `createIssue()`. | I/O |
| `src/attachments.js` | multipart parse, image validation (magic-byte sniff), R2 put, public URL, expiry index + cron sweep. | I/O |
| `src/email.js` | copy / closed / reopened templates (unsubscribe-at-top + `List-Unsubscribe`) + send. | I/O |
| `src/unsubscribe.js` | sign + verify HMAC unsubscribe tokens. | pure |
| `src/spam.js` | Turnstile verify + honeypot + KV IP rate-limit. | mixed |
| `src/sniff.client.js` | browser/OS/device detection, **ported from `punchin/src/utils/issueUrl.js`**; served to the form. | pure (client) |
| `src/index.js` | `fetch()` router + `scheduled()` + the submit/webhook/unsubscribe handlers. | I/O |

---

## 5. Templates → near-identical forms (the core mechanism)

Both the rendered form **and** the issue-body formatter are derived from the same source as
GitHub's own issue forms, so they can't diverge:

- **Source:** `https://raw.githubusercontent.com/{owner}/{repo}/{TEMPLATE_REF}/.github/ISSUE_TEMPLATE/{bug_report,feature_request}.yml`, fetched **unauthenticated** (public repo), `TEMPLATE_REF = main`.
- **Cache:** parsed schema stored in KV (`tpl:<kind>`) for a few hours; auto-tracks template edits
  with no redeploy.
- **Fallback floor:** if both live fetch and KV cache miss (GitHub unreachable + cold cache), render
  from a **bundled last-known-good copy** committed in the repo — the form must always render.
- **Parser** handles the issue-form field set: `markdown` (display-only — **never** appears in the
  issue body), `input`, `textarea`, `dropdown`, `checkboxes`, with `id` / `label` / `description` /
  `placeholder` / `validations.required` / dropdown `options`.

> **Target is "near-identical," not byte-perfect.** The parse→render→format engine is the
> highest-risk component; in planning, verify it against **one real GitHub-rendered issue-form
> submission** (heading level, blank-line spacing, the literal `_No response_`, dropdown and
> checkboxes rendering), hit near-identical, and stop. Don't gold-plate to byte-exactness.

---

## 6. Form fields & autopopulation

**Issue fields** come entirely from the parsed template (§5). For the current `punchin` templates:

- **Bug:** `title`* · `what-happened`* · `steps`* · `expected`* · `version`* · `install-type`*
  (dropdown) · `browser`* · `os`* · `device`* · `context`. *(`*` = required; a **Title** field is
  added at the top of every form because GitHub's UI supplies the title box that the `.yml` does not.)*
- **Feature:** `title`* · `problem`* · `solution`* · `alternatives` · `scope`.

**Autopopulation (bug form):**

- `browser` / `os` / `device` — filled **client-side** from `navigator.userAgent` using logic
  ported verbatim from `punchin/src/utils/issueUrl.js` (`describeBrowser/Os/Device`). Editable.
- `version` / `install-type` — a standalone page can't know these, so they **prefill from query
  params** that the PunchIn app passes when it links in (§14). Direct visitors leave them to fill
  manually (version is shown in the app's Settings → About). All prefilled fields stay editable.
- `from=app` — not a field: marks app context. The app opens these pages in an in-app browser
  overlay (Android Custom Tab / iOS in-app Safari) or a new tab — never in its own context — and
  no navigation can escape the overlays, so in this context the form drops the "← PunchIn" root
  link and success/message pages replace the root link with a "close this window" line plus a
  best-effort **Close** button: `window.close()` works in plain script-opened tabs; where the
  overlay refuses it the button swaps for a pre-rendered hint pointing at the overlay's own ✕
  (issue #6). Carried through the form via a hidden input, like `theme`/`accent`. Direct
  visitors get a "Back to PunchIn" link.

**Reporter section** ("Email me about this — optional"), separate from the issue schema:

- `reporter-email` (input; validated only if non-empty).
- Three notification checkboxes, shown/enabled once an email is present (§9). **No name field.**

---

## 7. Data flow

### 7.1 Submit (`POST /submit`, multipart/form-data)

1. Parse form + files; resolve `kind`.
2. **Spam gate:** honeypot empty → Turnstile valid (if configured) → IP rate-limit OK. Else 400 +
   error page (preserving text input where feasible).
3. **Validate** required fields against the parsed schema; invalid → re-render form with errors +
   the user's input intact.
4. **Upload images** (if any): validate each (magic-byte image type, ≤ `IMG_MAX_BYTES`, count ≤
   `IMG_MAX_COUNT`) → `ATTACHMENTS.put(key, …)` with a random 128-bit key → collect public URLs
   `https://feedback.trackmytime.today/a/<key>`.
5. **`createIssue()`** — title, body (issue-form format with the image markdown appended under a
   "Screenshots" section), labels (`[bug]`/`[enhancement]` + optional `PROVENANCE_LABEL`).
   **Email is never in the body.**
6. **Once `createIssue` succeeds the submission is committed** — always return the success page
   (issue number + link). The rest is **best-effort** and must never turn a filed issue into a
   user-facing error (mirrors `punchin-email`'s "a failed TTL refresh never fails the sent relay"):
   - If email given: store `issue:<number> → { email, kind, createdAt, notify:{copy,closed,reopened},
     images:[keys], imgYearClockStart: createdAt }` in KV (~1yr TTL). *(If no email but images
     exist, still store `{ images, createdAt, imgYearClockStart }` so the retention sweep can find
     them.)* Also write the image-expiry marker due at `imgYearClockStart + 365d` (§7.4).
   - If `notify.copy`: send the copy email.
7. **Only `createIssue` failure** shows the reporter an error (form input preserved for retry).

### 7.2 Webhook (`POST /webhook`)

1. Verify `X-Hub-Signature-256` HMAC (`GITHUB_WEBHOOK_SECRET`); invalid → 401.
2. **Idempotency:** if `X-GitHub-Delivery` is already in KV (`seen:<id>`, short TTL) → 204. Else mark it.
3. `action === "closed"`:
   - read `issue:<n>`; if `notify.closed` and an email exists → send the close email (includes
     GitHub's `state_reason`: *completed* vs *not planned*).
   - record `closedAt`; recompute the image-expiry marker to due at `min(imgYearClockStart + 365d,
     closedAt + 30d)` (§7.4).
   - **re-put the mapping with a 90-day TTL** so the email + prefs are purged 3 months after close
     unless the issue is reopened first (§10).
4. `action === "reopened"`:
   - if `notify.reopened` and email → send the reopen email.
   - **reset the image 1-year clock** (`imgYearClockStart = reopenedAt`), clear `closedAt`, and
     recompute the image-expiry marker (no close clock while open again).
   - **re-put the mapping with the ~1yr TTL** (restore the open-issue email-retention backstop).
5. Other actions → 204 no-op.

> **Mapping is NOT deleted on close** (reopen needs it). Its lifetime is governed by a state-
> dependent KV TTL — ~1yr while open, 90d after close, restored on reopen (§10) — plus immediate
> removal on unsubscribe. Webhook idempotency comes from the delivery-id dedup, not from deletion.

### 7.3 Unsubscribe (`GET /unsubscribe?token=…`)

Verify the HMAC token (encodes the issue number) → set `notify` flags false (and drop the stored
email) on `issue:<n>` → confirmation page. Image-retention metadata is kept so cleanup still runs.

### 7.4 Retention sweep (`scheduled()`, daily)

Image deletion is fully app-managed (the 1-year clock is resettable, so a static R2 lifecycle rule
can't express it). Each issue's images carry one expiry marker = **min(`imgYearClockStart` + 365d,
`closedAt` + 30d)**, where `imgYearClockStart` = upload time, **reset to the time of the most recent
reopen**. The marker is (re)computed on submit / close / reopen; the daily cron deletes any R2
objects whose marker is due and clears the markers. Net effect, reopen-aware:

- **Open issue:** images deleted 1 year after upload — *or* 1 year after the last reopen, since
  reopening **resets** that clock.
- **Closed issue:** deleted 30 days after close (whichever of the two clocks is sooner).
- A reopen cancels the 30-day close clock and restarts the 1-year clock.

A generous (e.g. 2-year) R2 bucket lifecycle rule may be kept purely as an orphan backstop for
objects whose KV markers were ever lost.

---

## 8. Attachments (screenshots)

- **Why R2, not GitHub:** native attachment upload is API-infeasible (§2). R2-hosted images embedded
  as `![](https://feedback.trackmytime.today/a/<key>)` render inline in the issue (GitHub fronts
  them via its Camo image proxy).
- **Validation:** magic-byte type check (PNG/JPEG/WebP/GIF only — not just the declared MIME),
  per-file size cap, total count cap; uploads are Turnstile-gated + rate-limited; keys are random
  and unguessable (the bucket is not enumerable).
- **Retention:** the earlier of **1 year from upload (reset if the issue is reopened)** and **30
  days from close**, reopen-aware (§7.4).
- **Disclosure (required):** the form states plainly, next to the upload control, that screenshots
  are **stored in Cloudflare R2** (PunchIn's storage provider, the same platform that hosts the
  app), **served from `feedback.trackmytime.today`, embedded in the public GitHub issue (visible to
  anyone who can see the issue), and deleted 1 year after upload (reset if reopened) or 30 days
  after the issue is closed, whichever is sooner.** A short privacy note alongside it covers the
  email handling (§10).
- **Residual risk (accepted):** a determined user could upload policy-violating imagery; mitigations
  are the type/size/count caps, Turnstile + rate-limit, unguessable non-enumerable keys, and the
  fact that every upload accompanies an issue a maintainer reviews. Camo may briefly cache an image
  past deletion — acceptable and covered by the disclosure.

---

## 9. Email

- **Preferences (3 checkboxes, shown when an email is entered):** *Email me a copy + the issue link*
  (**pre-checked**), *Email me when it's closed* (unchecked), *Email me if it's reopened*
  (unchecked). With no email, no notifications.
- **Messages:** **copy** (on submit), **closed** (with close reason + link), **reopened** (with
  link). From `feedback@trackmytime.today`.
- **Unsubscribe at the very top:** the first line of every email body is a visible unsubscribe link
  (signed `/unsubscribe` URL), **and** a `List-Unsubscribe` (+ `List-Unsubscribe-Post`) header.
- Each email also carries a one-line *"You're receiving this because someone submitted feedback at
  trackmytime.today and asked for updates; if this wasn't you, unsubscribe above."*
- (Optional, operator) Adding `feedback` to the `punchin-email` relay's `ALLOWED_ALIASES` routes any
  reporter replies to the inbox via existing infrastructure.

---

## 10. Privacy & abuse (non-negotiable)

- Reporter **email** is in KV only, never in the public issue. It is held **only as long as it's
  needed to send the notifications the reporter asked for**, then purged: **3 months after the issue
  is closed** without being reopened (reopening restores the window), a **~1-year backstop** if the
  issue never closes, and **immediately on unsubscribe**. This retention is **disclosed on the form**
  (in the same privacy note as the screenshot disclosure, §8). Implemented as a state-dependent KV
  TTL: ~1yr on submit/reopen, 90d on close (self-cleaning — no cron needed for the email).
- **No reporter name** is collected.
- Public endpoints are defended by **Turnstile + honeypot + IP rate-limit**; uploads add type/size/
  count caps. Mitigation is a requirement, not an option. Turnstile is optional **only** for
  self-hosters (honeypot + rate-limit still apply); the `punchin` deployment enables it.
- Webhook is HMAC-verified; unsubscribe tokens are HMAC-signed (no enumeration).

---

## 11. Brand / styling

Reuse `punchin-design-system/project/colors_and_type.css` tokens (Noto fonts, color tokens, type
scale, spacing, radii, shadows, `.ds-*` classes). Self-host the Noto WOFF2 as static assets (no
CDN). Default accent PunchIn Blue `#2D5BF5`/`#2348DB` via `ACCENT`; honor `prefers-color-scheme`.
Accessible forms (real labels, required markers, an error summary, visible focus rings); the success
page states the issue number + link and, if an email was given, which mails to expect.

---

## 12. Reusability / self-hosting

Everything `punchin`-specific is config (repo, branch, domain, from-address, app URL, accent,
provenance label, caps, Turnstile on/off). Forms derive from the adopter's own templates
automatically (§5). Ship a **GitHub App manifest** for one-click install. README documents the App
install, KV, R2, custom domain, cron, secrets, and the optional relay-alias reply routing.

**Licensing boundary (BUSL-1.1, since the v1.1.0 relicense):** self-hosting remains free for an
individual running feedback intake for a project or repository they personally control (the
LICENSE's Additional Use Grant). Organizational use — a company, agency, or other legal entity
deploying it in its internal tooling, support infrastructure, or operations — requires a
commercial license from PunchIn-App (licensing@trackmytime.today). On the Change Date
(2030-06-02) the work relicenses to AGPL-3.0.

---

## 13. KV data model

| Key | Value | TTL |
|---|---|---|
| `tpl:<kind>` | parsed template schema | hours |
| `gh-token` | cached installation token | ~1h |
| `issue:<n>` | `{ email?, kind, createdAt, notify:{copy,closed,reopened}, images:[keys], imgYearClockStart, closedAt? }` | ~1yr open / **90d after close** (reset on reopen) |
| `seen:<delivery-id>` | webhook dedup marker | short |
| `rl:<iphash>` | rate-limit counter | minutes |
| `expire:<dueDateSortable>:<key>` | image-expiry marker, due = min(imgYearClockStart+365d, closedAt+30d); recomputed on close/reopen | until swept |

---

## 14. Cross-repo change — the PunchIn app PR (separate deliverable)

Per decision: open a **PR in the `punchin` repo on a new branch off `design/brand-refresh`** (the
repo is currently checked out there — branch *from* it, don't commit onto it). Do **not** merge.

- Repurpose `src/utils/issueUrl.js` so Settings → About also offers **"Report a bug / request a
  feature without a GitHub account"** linking to `feedback.trackmytime.today/{bug,feature}` with
  `version` + `install-type` (+ the existing `browser`/`os`/`device`) prefilled — alongside the
  existing GitHub deep-links (GitHub users keep the native path).
- Add **`from=app`** to both feedback-form builders so the worker can render overlay-safe exits
  (§6, issue #6) — the app always opens the forms in a context where "close this window" is the
  only correct way back.
- **Honor punchin's docs-sync CI:** update `docs/ARCHITECTURE.md` / `docs/TEST-COVERAGE.md` for any
  new/changed source or test file, add tests for the new builders, and add a `docs/CHANGELOG.md`
  entry (user-visible). Use the `skip-docs-check` label only if genuinely N/A.

---

## 15. Planning-time verifications (check live sources, not memory)

1. **Issue-form body rendering** — exact format per field type (incl. `dropdown`, `checkboxes`,
   `_No response_`, and `markdown` being display-only) vs a real GitHub submission (§5).
2. **Static Assets + dynamic Worker routing** — assets-first vs `run_worker_first`, so `/bug`,
   `/submit`, `/a/<key>` reach the handler while `/styles.css`,`/fonts/*` serve as assets.
3. **GitHub App** — JWT (RS256) → installation-token flow + cache window; `Issues: write` perm +
   `Issues` webhook event subscription; manifest fields.
4. **R2** — Workers binding put/get; bucket **lifecycle rule** for age-based (365-day) deletion.
5. **Cloudflare Email Sending** — daily send caps for expected volume; `List-Unsubscribe` allowed.
6. **Multipart in Workers** — `request.formData()` file handling + size limits.

---

## 16. One-time operator setup

1. Create + install the GitHub App (via the shipped manifest) on `PunchIn-App/punchin`; set its
   webhook URL to `https://feedback.trackmytime.today/webhook` + secret; subscribe to `Issues`.
2. Create the `FEEDBACK` KV namespace and the `ATTACHMENTS` R2 bucket (+ a 365-day lifecycle rule).
3. Add the Worker custom domain `feedback.trackmytime.today` + the daily Cron Trigger.
4. Ensure `feedback@trackmytime.today` / the sending domain are onboarded for Email Sending.
   *(In progress on the operator side.)*
5. Set secrets (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `UNSUB_SECRET`,
   optional `TURNSTILE_SECRET`).
6. (Optional) Create a Turnstile widget; set `TURNSTILE_SITEKEY` + `TURNSTILE_SECRET`.
7. (Optional) Add `feedback` to the `punchin-email` relay's `ALLOWED_ALIASES`.
8. Review + merge the separate `punchin` app PR (§14) to surface the links in-app.

---

## 17. Repository layout (proposed, mirrors `punchin-email`)

```
punchin-feedback/
  src/
    index.js          fetch() router + scheduled() + submit/webhook/unsubscribe handlers
    templates.js      fetch + parse + cache issue-form YAML; bundled fallback
    render.js         form / success / error HTML (pure)
    issueBody.js      values + image URLs → issue body + title + labels (pure)
    github.js         App auth + createIssue()
    attachments.js    multipart parse, image validation, R2 put/serve, expiry sweep
    email.js          copy/closed/reopened templates (unsub-at-top) + send
    unsubscribe.js    HMAC token sign/verify (pure)
    spam.js           Turnstile + honeypot + rate-limit
    sniff.client.js   browser/OS/device detection (ported from issueUrl.js)
  assets/             styles.css + fonts/*.woff2
  templates/          bundled last-known-good copies of the .yml (fallback floor)
  test/
    templates.test.js   parse YAML → schema; fallback behavior
    issueBody.test.js   body-format snapshots (input/textarea/dropdown/checkboxes/_No response_)
    render.test.js      every schema field present; a11y attrs; upload disclosure present
    github.test.js      JWT/token + createIssue over mocked fetch
    attachments.test.js validation + R2 put/serve + expiry scheduling over mocks
    email.test.js       template assembly incl. unsubscribe-at-top; send over mocked binding
    unsubscribe.test.js token round-trip + tamper rejection
    spam.test.js        honeypot / rate-limit / Turnstile verify
    handlers.test.js    submit best-effort ordering; webhook closed/reopened/dedup; cron sweep
  docs/
    2026-06-07-punchin-feedback-design.md   (this file)
    CHANGELOG.md
  wrangler.toml
  README.md
  CLAUDE.md
```
