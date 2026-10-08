# Contributing to Vela

Thanks for helping. Bug reports, fixes and small focused features are welcome. For a larger change, open an issue first so we can agree on the approach before you write it.

## Setup

Vela is developed with [Bun](https://bun.sh) 1.4 or newer. The published package also runs on Node.js 22.18 or newer, and CI runs the tests on Bun and the consumer smoke test on Node 22.18.

```bash
git clone https://github.com/glows777/Vela
cd Vela
bun install
bun run start        # run the CLI from source
VELA_MODEL=mock bun run start   # no API key needed
```

## Checks

Run these before opening a pull request. CI runs the same ones.

```bash
bun run test            # unit + e2e tests, offline, a few seconds
bun run typecheck
bun run lint            # bun run lint:fix fixes what it can
bun run smoke:consumer  # builds, packs and installs the package into empty Node and Bun projects
```

`bun run test:live` runs a few tests against a real model and needs API keys; it is not part of CI.

If you change the exports of `@glows777/vela` or `@glows777/vela/testing`, run `bun run api:update` and commit the updated `api/public-api.txt`. The snapshot test fails until you do, so public API changes are always deliberate.

## Code conventions

- `src/` is the published package. It must run on Node and Bun: use `node:` modules and web standard APIs only, no `Bun.*` globals or `bun:` modules. Relative imports carry the `.ts` extension. Scripts and tests may use Bun APIs.
- Everything in the repo is in English: code, comments, messages, tests and docs.
- Keep changes small and in the style of the surrounding code. Biome handles formatting and lint.
- Vela follows [pi](https://github.com/earendil-works/pi)'s design where it can. If you're adding something pi already has, match pi's names and behavior unless there is a reason not to.

## Tests

[test/README.md](test/README.md) explains how the tests are organized. In short: unit tests live in `test/unit/` mirroring `src/`, end-to-end flows live in `test/e2e/` and drive Vela with the scripted faux model. To fix a bug, first add a faux scenario that reproduces it.

## Pull requests

- One change per pull request, with a description of what changes for users and how you tested it.
- Add tests for new behavior and bug fixes.
- Update the docs in `docs/` when you change user-facing behavior.
- If the change affects users, add a line to the top section of [CHANGELOG.md](CHANGELOG.md) under the right heading (New Features, Breaking Changes, Added, Changed, Fixed). A breaking change must say how to migrate.

## API stability

While Vela is on 0.x, breaking changes to the public API bump the minor version and patch releases don't break anything. [docs/sdk.md](docs/sdk.md#api-stability) lists what counts as public.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
