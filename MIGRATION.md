# Provenance

This repository was extracted, with its history, from the Cairn monorepo. It is not a
fresh start: every commit below the first one here is a commit of that history, filtered
to the paths this repository owns.

| | |
|---|---|
| Source | <https://github.com/ParkWardRR/cairn-driving-log-selfhosted> |
| Source tag | `monorepo-final` |
| Source commit | `b3ada35e78414e0ed179b95f356231da877f80a9` |
| Extraction | `git filter-repo` a40bce548d2c, driven by `split/extract` in that repository |
| Path map | `split/paths.tsv` in that repository, at the commit above |

## Where each path came from

| Source path (in the monorepo) | Path here |
|---|---|
| `ui/` | the directory's contents become the repository root |
| `deploy/deploy-ui.sh` | `deploy/deploy-ui.sh` |
| `deploy/backup-places.sh` | `deploy/backup-data.sh` (generalised to every store with user data) |
| `deploy/caddy/` | `deploy/caddy/` |
| `deploy/systemd/cairn-ui.service` | `deploy/systemd/cairn-ui.service` |
| `deploy/systemd/cairn-ui-places.conf` | `deploy/systemd/cairn-ui-places.conf` |
| `deploy/systemd/ui.env.example` | `deploy/systemd/ui.env.example` |
| `docs/places.md` | `docs/places.md` |
| `docs/screenshots/` | `docs/screenshots/` |


## What was and was not carried over

- **History of paths that no longer exist** (the legacy stack, v1/v2 migrations, old
  compose files) is not in this repository. It remains in the archive,
  <https://github.com/ParkWardRR/cairn-original-monorepo-archive>, and in the front door's history.
- **Commit hashes differ** from the monorepo: a filtered history is a new history.
  Author, date and message of every kept commit are unchanged, and the extraction was
  verified against the source (the final tree and sampled historical trees match byte
  for byte, modes and symlinks included).
- **Tags**: the old `v0.1.0` tools release stays with the front door and the archive.

## What was changed after extraction

Each change is one commit on top of the extracted history, so `git log` shows exactly
what was rewritten and nothing else was touched:

- **docs: record where this repository came from**: this file
- **build: rename the Go module to this repository's path**: the Go module path and every import of it
- **docs: point links that crossed a repository boundary at the repository that owns them**: relative links to files that now live in another repository became absolute links
- **deploy: take the target host from the environment, not the repository**: no real host name is stored; the deploy scripts read one from the environment or a gitignored `deploy.env`, and deploy this repository's own `HEAD`
- **docs: add a README and the licence**: README and LICENSE
- **chore: ignore rules for this repository**: `.gitignore`
- **build: pin the contracts (contracts.lock and its fetch script)**: `contracts.lock` and `scripts/fetch-contracts.sh`: the protocol specs and vectors are fetched at a pinned tag and commit, not copied
- **ci: run on the self-hosted runner under the trusted-code policy**: `.github/workflows/ci.yml`, `tests/check-runners.sh` and its self-test

