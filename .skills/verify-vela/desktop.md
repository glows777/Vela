# Verify Vela desktop

Drive the real Electron window from the repository root.

```sh
bun run desktop:check
bun run desktop:verify
bun run desktop:package
bun run desktop:verify --packaged apps/desktop/out/Vela-darwin-arm64/Vela.app
```

Use Forge's actual output path for your architecture. The packaged driver currently accepts a macOS `.app`. Other platforms need separate runtime acceptance. Local packaging is unsigned and unnotarized.

The driver creates separate scratch `HOME`, `VELA_DIR`, and Electron user-data directories. To supply home or data directories, set `VELA_DESKTOP_HOME` and `VELA_DIR` to scratch paths. The driver preserves supplied directories and deletes only the temporary directories it creates. The packaged pass checks Node's `os.homedir()` against `HOME`. Electron's native `app.getPath('home')` still identifies the OS account; its writable `userData` path is explicitly isolated. Set `VELA_DESKTOP_EVIDENCE` to an evidence directory outside the repository; the default is `/tmp/vela-desktop-evidence-<id>/`. Development and packaged runs own and close their child processes. Run them sequentially.

The development pass proves that the preview loads on first launch, local assets load, theme tokens reach the document root and body portals, the renderer has no Node globals, the minimum layout has no horizontal overflow, and the bridge and product journeys below pass. The packaged pass proves launch, isolated user-data and renderer, minimum size, system themes, bundled licenses, and the absence of specimen output. Inspect the screenshots and `result.json`; a build or typecheck alone does not prove runtime behavior. Arc keyboard, focus, spring, and frame internals are outside this driver.

After changing dependency pre-optimization, run once with this checkout's `apps/desktop/node_modules/.vite` cache absent. After changing token checks, temporarily introduce an unprefixed token and generated CSS drift, confirm the expected errors, restore the files, and rerun the clean check. After changing import ownership, probe forbidden direct and aliased imports and a permitted main SDK import, then restore the probe files.

## What the driver asserts

`scripts/verify.ts` seeds a scratch `HOME`, `VELA_DIR`, faux scenario and settings, launches the real app, and drives it two ways:

- `bridgeJourney` drives `window.vela` directly: channels and connections, `openProject`, `submit`, session reads, `stop` with a stale run, an image input that reaches the transcript, and a history read that walks `after` one page at a time. The packaged pass runs this journey too.
- Product journeys drive the window as a person would, one per acceptance flow: journey 1 opens a Local project through New project and reads its answer; journey 2 asks for bigger work and follows the session card into the panel, where it runs, is stopped, continues and fails; journey 3 answers what a session asks, from the header and Home to the panel; journey 4 keeps two projects apart and checks a conversation's place; journey 5 creates, edits and cancels routines on the Routines page and reads the host's own rejection; journey 6 opens an empty data directory on setup, has a wrong key refused through a local provider endpoint (`scripts/verify-provider.ts`), saves a good one, and runs `vela --list-models` against the same directory. Each writes light and dark screenshots. Add a journey when a page lands, and keep assertions on what is visible.
- Journeys 4 and 5 end by starting the app again on the same scratch data, and journey 6 needs an empty data directory of its own, so the development driver launches four times. The packaged pass runs the bridge journey and journey 1 only: it exists to prove launch, themes and packaging, and the product journeys are accepted in the development pass.

A faux model plays the scripted answers. Background requests such as memory consolidation call `generateText`, so give the scenario a `generate` queue or they consume the scripted stream answers. Send one input at a time and wait until a session has no run: a second input while a run is live steers it. Two runs can race for the next scripted step — after a hand-off the hub and the new session both ask for one — so give both the same text where the order must not matter. Keep evidence outside the repository. Offline Lark coverage uses an isolated fake transport; live acceptance follows the [connection ownership rule](../../apps/desktop/AGENTS.md#process-ownership).
