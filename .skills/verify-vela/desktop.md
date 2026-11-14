# Verify the desktop foundation

Use the actual Electron window with synthetic design samples. The desktop has no SDK or model integration, so the CLI fixture and faux-model helpers do not apply here.

From the repository root, run:

```sh
bun run desktop:check
bun run desktop:verify
bun run desktop:package
bun run desktop:verify --packaged apps/desktop/out/Vela-darwin-arm64/Vela.app
```

Use the output path printed by Forge for your platform and architecture. The packaged driver currently accepts a macOS `.app`; other platforms need their own runtime acceptance before being reported as verified. It launches the packaged executable directly. The app remains unsigned and unnotarized.

The development driver owns a Forge process, an ephemeral debugging port, and a scratch profile. It closes its own process group in `finally`. The packaged driver owns a Playwright Electron process and scratch profile. Both preserve screenshots and a result JSON under a new directory matching `/tmp/vela-desktop-evidence-<id>/`. Set `VELA_DESKTOP_EVIDENCE` to choose another evidence directory outside the repository.

The driver proves preview content appears on first launch before any reload, then checks local assets, renderer errors, themes and system media preferences, reduced motion, keyboard focus, and minimum viewport layout. The packaged pass also checks the scratch user-data path, renderer Node isolation, and minimum dimensions and rejects specimen output in the packaged renderer. Inspect the screenshots after running it. The production shell has no controls; keyboard control acceptance belongs to the development specimen.

For a token change, inspect all three explicit theme screenshots and the system preference checks. For a lifecycle or packaging change, run both development and packaged passes. Never infer runtime acceptance from typechecking or a package existing on disk.

Run the development pass once with its own `apps/desktop/node_modules/.vite` cache absent when changing dependency pre-optimization. Preserve another running checkout's cache. The production build input stays `index.html`.

Arc acceptance uses the installed Button, Dialog, Tabs, and Switch. The driver checks disabled-button keyboard skipping, visible focus, dialog autofocus, forward and reverse focus trapping, Escape dismissal and trigger focus restoration, arrow-key tab selection, and Space toggling. Dialog colors must match Vela's canonical manifest through a body portal for every explicit theme and system light, dark, and high contrast.

`motion-frames.json` records computed transforms during actual interaction under normal and reduced motion. Normal Button press, Dialog entrance, and Tabs panel movement must produce transformed frames. Their reduced branches must omit movement. Switch must show intermediate spring positions normally and jump under reduced motion. Arc retains short reduced-motion fades; do not replace those assertions with a global duration-zero rule. Reload between media modes so the upstream Motion preference hooks initialize from the selected preference.

After changing the token generator or checker, temporarily introduce an unprefixed token and generated CSS drift, run the relevant check, and confirm the expected error. Restore each file in `finally` and rerun the clean check. Pinned Arc source hashes and the bundled MIT license must match provenance after adoption or update. Inspect the normal and reduced control screenshots plus each explicit theme screenshot. The packaged driver checks the Arc license alongside both font licenses and rejects preview content and SDK imports in the archive.
