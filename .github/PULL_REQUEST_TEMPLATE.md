## Summary

<!-- What does this PR do and why? One to three bullet points. -->

-

## Type of change

<!-- Check all that apply -->

- [ ] Bug fix in form rendering / submit / webhook / email / image handling (→ `PATCH`)
- [ ] New or changed reporter-facing behaviour — the forms, the filed issue, or the emails (→ `MINOR`)
- [ ] New config var or binding, or a newly supported issue-form construct (→ `MINOR`)
- [ ] New robustness / safety guard with no change for normal submissions (→ `PATCH`)
- [ ] Internal refactor / dependency / template re-sync (→ `PATCH`)
- [ ] Test additions only (no version bump)
- [ ] CI / docs only (no version bump)

## Checklist

### Code

- [ ] `npm test` passes
- [ ] `npm run check` (wrangler dry-run) passes
- [ ] If `templates/` changed: `npm run sync-templates` was run and `src/bundledTemplates.js` is committed
- [ ] New behaviour has a test added alongside it — every new rejection path is covered
- [ ] No secret or personal address added to `wrangler.toml [vars]` (secrets go via `wrangler secret put`)
- [ ] The safety guards (webhook HMAC verification, best-effort-after-`createIssue`, spam gate, retention windows) are not weakened without a documented rationale

### Version & changelog

- [ ] Version bump not required (tests / CI / docs only) **OR**
- [ ] `package.json` `version` updated
- [ ] `docs/CHANGELOG.md` new section added at the top
- [ ] `README.md` version badge URL updated
- [ ] `CLAUDE.md` `**Version:**` header updated

### Documentation

- [ ] `CLAUDE.md` updated where relevant (Module map / Conventions / Configuration & Bindings)
- [ ] `README.md` updated if behaviour or setup changed
