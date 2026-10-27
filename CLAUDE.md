# Notes for Claude

## Versioning and releases

Every push that changes the app (not docs-only) bumps the version:

- Minor (`0.X.0`) for a new or overhauled feature; patch (`0.0.X`) for smaller
  adjustments to existing features.
- Bump in a separate `Version X.Y.Z` commit: `package.json`, the two top-level
  `version` fields in `package-lock.json`, and the "currently `vX.Y.Z`" line in
  `README.md`.
- **The Version commit's body is the release notes**, grouped as in
  `git show v0.3.0` (a `Heading:` line, then `- ` bullets). Attribution
  trailers stay at the end as usual; the workflow strips them.

**Do not create or push tags.** Cloud sessions cannot push them (the session's
git proxy drops tag pushes; branch pushes work). Releases are automatic instead:
on a push to `master`, `.github/workflows/windows.yml` tests and builds on
Windows, and if package.json's version has no `vX.Y.Z` tag yet it tags the
pushed commit (annotated: `Earthy X.Y.Z` plus the Version commit's body) and
publishes a GitHub release with the installer. So a release happens when the
Version commit reaches `master`, not when it is pushed to a working branch.

After pushing to `master`, check that run (GitHub MCP `actions_list` /
`get_job_logs`): it is the only Windows build and test.

## Before pushing

`npm run typecheck`, `npm run lint`, `npm test`.
