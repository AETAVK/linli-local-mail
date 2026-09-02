# Linli Local Mail Public Projection Rules

## Repository role

This repository is a generated public projection of the private Linli Local Mail source. Product development, conflict
resolution, private tests, migration evidence, and release preparation must happen in the private canonical repository.
Do not implement product features directly in this public projection.

## Allowed work

- Read, audit, build, or test the projected source.
- Report a defect with the affected public path and reproduction evidence.
- Make an emergency public-only workflow repair only when explicitly authorized. The same repair must be backported to
  the private canonical source before the next projection export.

## Prohibited content and actions

- Do not add user letters, SQLite databases, logs, API keys, certificates, private keys, game assets, bundled Node.js,
  compiled installer output, or transaction backups.
- Do not add tracked paths outside `PUBLIC_PROJECTION.json`.
- Do not force-push, rewrite or delete release tags, publish a release, or change repository secrets without explicit
  maintainer authorization.

Run `npm run governance:check` before proposing a public-repository commit. A failed repository-role or projection
check means the operation is being attempted in the wrong workspace or from an unmanaged source.
