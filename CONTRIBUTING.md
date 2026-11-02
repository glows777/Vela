# Contributing to Vela

Thanks for helping. Bug reports, fixes and small focused features are welcome. For a larger change, open an issue first so we can agree on the approach before you write it.

## Setup

Vela is developed with [Bun](https://bun.sh) 1.4 or newer. The published package also runs on Node.js 22.18 or newer, and CI runs the tests on Bun and the consumer smoke test on Node 22.18.

```bash
git clone https://github.com/glows777/Vela
cd Vela
bun install
bun run build        # build the publishable artifacts (source development does not require this)
bun run start        # run the CLI from source
VELA_MODEL=mock bun run start   # no API key needed
```

## Checks

Run these before opening a pull request. CI runs the same ones.

```bash
bun run test            # unit + e2e tests, offline, about 1–2 minutes
bun run typecheck
bun run lint            # biome check: formatting, import order and lint; bun run lint:fix fixes what it can
bun run quality        # Knip, strict production dependencies, Madge, size limits, package boundaries and channel tool names in docs/channels.md
bun run smoke:consumer  # builds and packs all six, installs each alone in empty Node and Bun projects
```

`bun run test:live` runs a few tests against a real model and needs API keys; it is not part of CI.

If you change any package export, run `bun run api:update` and commit its `packages/<name>/api/public-api.txt`. The snapshot test fails until you do, so public API changes are always deliberate.

## Code conventions

- `packages/*/src/` contains the published packages. It must run on Node and Bun: use `node:` modules and web standard APIs only, no `Bun.*` globals or `bun:` modules. Relative imports carry the `.ts` extension. Scripts and tests may use Bun APIs.
- Everything in the repo is in English: code, comments, messages, tests and docs.
- Keep changes small and in the style of the surrounding code. Biome handles formatting and lint.
- Vela follows [pi](https://github.com/earendil-works/pi)'s design where it can. If you're adding something pi already has, match pi's names and behavior unless there is a reason not to.

## Tests

[test/README.md](test/README.md) explains how the tests are organized. In short: unit tests live in `packages/*/test/unit/` mirroring each package’s `src/`; workspace architecture tests live in `test/unit/`, end-to-end flows live in `test/e2e/` and drive Vela with the scripted faux model. To fix a bug, first add a faux scenario that reproduces it.

## Pull requests

- One change per pull request, with a description of what changes for users and how you tested it.
- Add tests for new behavior and bug fixes.
- Update the docs in `docs/` when you change user-facing behavior.
- If the change affects users, add a line to the top section of [CHANGELOG.md](CHANGELOG.md) under the right heading (New Features, Breaking Changes, Added, Changed, Fixed). A breaking change must say how to migrate.

## Releasing

Maintainers release from an up-to-date `main` with entries under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md):

```bash
bun run release patch   # or minor, major, or an exact version like 0.2.0
bun run release 0.4.0-rc.1
```

All six packages publish in lockstep: core, channels, MCP, RAG, Lark, then the umbrella CLI. Source manifests use `workspace:*`; packed manifests pin the exact shared version. The script bumps the root and all six versions, runs the checks, commits, tags `vX.Y.Z` and pushes. A final version dates the changelog section. A release candidate leaves the entries under `## [Unreleased]` for that final version, and the workflow publishes the candidate on npm's `next` dist-tag (`npm i @glows777/vela@next`). The tag starts the Release workflow, which runs CI on the tagged commit, publishes to npm with provenance through trusted publishing, and creates the GitHub release from the changelog section. If the script's checks fail, nothing is committed: `git restore package.json packages/*/package.json bun.lock CHANGELOG.md`, fix, and run it again. If the push fails, run `git push --atomic origin main vX.Y.Z` again. If the workflow fails partway, run the Release workflow by hand with the tag; a package version already on npm is skipped only when its `gitHead` matches the release commit. A missing package is published in dependency order; an existing conflicting or unverifiable version stops the release. If a newly published version is temporarily not visible in the registry, publication stops safely. Wait for registry visibility, then rerun the Release workflow with the same tag; matching versions are verified and skipped. Do not change source or reuse the version for different artifacts.

Before the first workspace release, maintainers must verify ownership and trusted publishing for every package. Publication stays on hold until the separately reviewed Lark rename PR is complete and Liam explicitly authorizes a release; merging the rename alone does not authorize publication. Release tests use injected registry/publisher mocks; consumer checks serve local tarballs and never publish npm packages.

## API stability

While Vela is on 0.x, breaking changes to the public API bump the minor version and patch releases don't break anything. [docs/sdk.md](docs/sdk.md#api-stability) lists what counts as public.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
