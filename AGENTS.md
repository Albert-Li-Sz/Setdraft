# Hydro Problem Make development rules

## Scope

This repository contains the Hydro authoring workspace, local verification API, web UI,
and the `pi-ai`/telemetry libraries used by the AI chat. The former Pi Agent, terminal UI,
remote transport, and evaluation workspaces are intentionally not part of this project.

## Code quality

- Read a file in full before making a broad change.
- Keep changes focused and remove obsolete references when a feature is removed.
- Avoid `any`, ad-hoc dynamic imports, and non-erasable TypeScript syntax. Keep existing
  lazy provider imports intentional and use top-level imports elsewhere; use explicit fields
  instead of parameter properties, enums, or namespaces.
- Keep direct external npm dependencies pinned to exact versions.
- Do not modify `packages/ai/src/models.generated.ts` directly; change the generator and
  regenerate it when model data changes.

## Verification

- After code changes run `npm run check`; fix all reported errors and warnings.
- Run focused tests with
  `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run <test>`
  or `node --test <test>` for Node tests.
- Do not run `npm run build` or the complete test suite unless the user requests it.
- Use the faux provider for AI tests; never use real credentials or paid APIs.
- Refresh the lockfile with `npm install --package-lock-only --ignore-scripts` after
  package metadata changes.

## Git

- Never use `git reset --hard`, `git checkout .`, `git clean`, `git stash`, `git add -A`,
  `git add .`, or `git commit --no-verify`.
- Stage explicit paths only, review `git status` before committing, and never commit unless
  the user asks.
- Do not force-push or overwrite changes made by another session.
