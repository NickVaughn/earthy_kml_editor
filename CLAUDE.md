# Notes for Claude

## Versioning

Every push that changes the app (not docs-only) bumps the version and is tagged:

- Minor (`0.X.0`) for a new or overhauled feature; patch (`0.0.X`) for smaller
  adjustments to existing features.
- Bump in a separate `Version X.Y.Z` commit: `package.json`, the two top-level
  `version` fields in `package-lock.json`, and the "currently `vX.Y.Z`" line in
  `README.md`.
- Tag that commit with an annotated `vX.Y.Z` tag: `Earthy X.Y.Z`, then grouped
  release notes (see `git show v0.3.0`).

## Before pushing

`npm run typecheck`, `npm run lint`, `npm test`.
