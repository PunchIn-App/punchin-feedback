# punchin-feedback

Account-free **bug report / feature request** intake for
[PunchIn](https://github.com/PunchIn-App/punchin).

People without a GitHub account fill in web forms that are **derived from the project's own
`.github/ISSUE_TEMPLATE/*.yml`** templates; this Cloudflare Worker files a real GitHub issue on
their behalf (via a GitHub App), can host screenshot uploads (Cloudflare R2), and optionally emails
the reporter a copy plus follow-ups when the issue is closed or reopened.

Served at **`feedback.trackmytime.today`**. Self-hostable for any repo/domain — same ethos as the
sibling [`punchin-email`](https://github.com/PunchIn-App/punchin-email) worker.

> 🚧 **Under construction.** The authoritative design is in
> [`docs/2026-06-07-punchin-feedback-design.md`](docs/2026-06-07-punchin-feedback-design.md); the
> implementation plan lives in `docs/superpowers/plans/`. Setup and deploy instructions are added
> here as the worker is built.

## Development

```bash
npm install
npm test        # vitest run
npm run check   # wrangler deploy --dry-run (bundles, no upload)
npm run dev     # wrangler dev (local worker)
```

## License

[Apache-2.0](LICENSE).
