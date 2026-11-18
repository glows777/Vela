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
- Product journeys drive the window as a person would. Journey 1 opens a Local project through New project, asks a question in its chat, reads the plain-text answer, reloads, and checks light and dark. Add a journey when a page lands, and keep assertions on what is visible.

A faux model plays the scripted answers. Background requests such as memory consolidation call `generateText`, so give the scenario a `generate` queue or they consume the scripted stream answers. Send one input at a time: a second input while a run is live steers it. Keep evidence outside the repository. Offline Lark coverage uses an isolated fake transport; live acceptance follows the [connection ownership rule](../../apps/desktop/AGENTS.md#process-ownership).
