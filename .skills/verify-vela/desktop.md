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

The development pass proves that the preview loads on first launch, local assets load, theme tokens reach the document root and body portals, the renderer has no Node globals, and the minimum layout has no horizontal overflow. The packaged pass proves launch, isolated user-data and renderer, minimum size, system themes, bundled licenses, and the absence of specimen output. Inspect the screenshots and `result.json`; a build or typecheck alone does not prove runtime behavior. Arc keyboard, focus, spring, and frame internals are outside this driver.

After changing dependency pre-optimization, run once with this checkout's `apps/desktop/node_modules/.vite` cache absent. After changing token checks, temporarily introduce an unprefixed token and generated CSS drift, confirm the expected errors, restore the files, and rerun the clean check. After changing import ownership, probe forbidden direct and aliased imports and a permitted main SDK import, then restore the probe files.

## Verify SDK hosting when it lands

The current foundation enforces process ownership; it does not run the SDK or a preload bridge. The first SDK integration must add a real-window assertion that main is the SDK host, such as the connected Local channel appearing in the window, together with the consumed shared TypeScript contract and preload implementation.

Use the scratch `HOME` and `VELA_DIR` pattern in [local-host-journey.ts](scripts/local-host-journey.ts). Seed a scripted faux model and isolated Local project settings there, launch the real app with those paths through this driver, and assert visible channel and session state through the real window. Keep assertions on user-visible results and persisted scratch files. The faux setup and main-process host must use the same scratch data directory. Use an isolated fake Lark transport for offline coverage; live Lark acceptance follows the [connection ownership rule](../../apps/desktop/AGENTS.md#process-ownership).
