# Reviewing Vela pull requests

For human and bot reviewers alike. Repo conventions are in [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md); this file says what a review should and shouldn't flag.

## What a bug looks like here

- A user-visible regression through a real entry point: the CLI/TUI, the SDK's public API, a channel message, a model or provider response, or the file system.
- An error swallowed or replaced by a silent "safe" default. Vela fails loudly: errors say what went wrong and how to fix it.
- `src/` using `Bun.*` globals or `bun:` modules (the package must run on Node ≥ 22.18), or a relative import without `.ts`.
- A public API change without an updated `api/public-api.txt`, or a user-facing change without a CHANGELOG line.
- Behavior that departs from pi without the PR saying why.
- Security: channel access outside the enabled-chat list, path or command injection, secrets in logs. These are never optional.

## How to write a finding

- Give the trigger path: who does what, through which entry point, and what goes wrong. Cite file and line. A finding that can be written as a faux scenario failing on `main` is blocking; one without a path is a suggestion and doesn't block.
- Mark each finding blocking or nit. Nits never block a merge; post at most three.
- Point out the bug class once so the author fixes every instance, instead of one comment per instance.
- Don't repeat a finding already posted on the PR, and don't flag code the PR doesn't touch.

## What to push back on

- Checks, fallbacks, retries or caches for situations no faux scenario can reach. Validate at boundaries (user input, channel messages, network and model responses, file contents); trust internal code and extensions.
- Tests that don't map to an acceptance item, a fixed bug or a valid finding.
- A PR that grows with each review round. That usually means defenses are piling up instead of the root cause being fixed.

## Rounds

After three review-and-fix rounds without converging, stop and reconsider the approach in the issue instead of another round. From the third round on, review only the new commits.

## Skip

`bun.lock`, `api/public-api.txt` (check only that it matches the export change), `CHANGELOG.md` wording.
