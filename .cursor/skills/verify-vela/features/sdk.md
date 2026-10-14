# SDK createVela

Library users embed Vela with `createVela({ model })` from `@glows777/vela` and get sessions with `prompt()`, events, and storage. `@glows777/vela/testing` ships a scripted faux model (`createFauxModel`, `fauxText`, …) for offline use.

## Sub-features

- `sdk-minimal` one session, one prompt, scripted reply (`examples/sdk/01-minimal.ts`).
- `sdk-events` subscribe to agent events (`02-events.ts`).
- `sdk-multi` concurrent sessions (`03-multi-session.ts`).
- `sdk-storage` custom session storage (`04-custom-storage.ts`).
- `sdk-node` the built package works in plain Node ≥ 22.18 and Bun (`bun run smoke:consumer`).

## How to get to it (user POV)

- `import { createVela } from '@glows777/vela'` in an app; repo examples under `examples/sdk/`.

## Driving it with bun (examples)

Preconditions:

- `bun install` done; run from the repo root.

- **Minimal.** Run `mkdir -p /tmp/vela-evidence/$RUN && bun examples/sdk/01-minimal.ts </dev/null > /tmp/vela-evidence/$RUN/sdk-minimal.stdout; echo $? > /tmp/vela-evidence/$RUN/sdk-minimal.exit`. stdout is `Hello! I am a scripted faux model.` and `messages: 2`; exit 0.
- **Others.** Same pattern for `02-events.ts` … `04-custom-storage.ts`; each must exit 0.
- **Consumer smoke.** `bun run build && bun run smoke:consumer` checks the packed package in empty Node and Bun projects.

## Gotchas

- The faux model is the provider boundary; it plays fixed responses and checks no wording.
- `smoke:consumer` needs Node ≥ 22.18; this box's system Node is v20.19, so that path is unverified here.
- `examples` import `@glows777/vela` via the package self-reference; run them from the repo root.
