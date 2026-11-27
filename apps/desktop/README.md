# Run Vela desktop

The private Electron workspace hosts the Vela UI over a persistent daemon runtime (`connectRuntime()` + bundled `daemon.mjs` executed via `ELECTRON_RUN_AS_NODE=1`) and shows Home, Local projects and their chats alongside the separate design specimen. Product pages are separate work. Process ownership is defined in [AGENTS.md](AGENTS.md). Desktop's `0.0.0` is an internal Electron packaging identifier; daemon protocol/version negotiation uses the bundled `@glows777/vela` package version.

Main connects to (or starts on demand) the single-writer daemon for `VELA_DIR` (or `~/.vela`), sharing sessions, projects, extensions, webhooks, and the Lark channel toggle stored in `vela.db` with the CLI. Closing the window leaves the daemon running by default (`stopDaemonOnQuit: false`, configurable in **Settings › General**). Turn off **Settings › Lark › Run Lark in this app** when pausing the shared Lark channel on this machine. A constrained preload bridge exposes channel, Local and Lark host operations; renderer code never imports the SDK. The window is the app frame with Home, a Local or Lark project page, its session side panel, the New project dialog, the Routines page, the setup screen a fresh data directory opens on, and Settings › General, Models and Lark. Lark settings verify app credentials before saving, show the current connection, and list and remove enabled chats. Credential checks leave Local responsive. Applying Lark settings requires idle Lark sessions and deliveries. If a configuration replacement fails, Local keeps working. New project → Lark discovers a new group by mention and asks for single-use approval bound to the current credentials before enabling its members.

## Run locally

Use Bun 1.4 or later and Node 22.18 or later from the repository root.

```sh
bun install
bun run desktop:dev
bun run desktop:preview
bun run desktop:check
bun run desktop:verify
```

The development preview shows Button, Dialog, Tabs, and Switch with typography, palette, and theme selection. Both HTML entries are pre-optimized for a cold first launch.

For runtime evidence, including the packaged pass and scratch directory options, follow [desktop verification](../../.skills/verify-vela/desktop.md). The driver creates and removes a private data subdirectory inside a supplied `VELA_DIR`, and never overwrites an existing settings file. It verifies the Local host with a faux model, configured shell, image input and paged history, drives the Local product journeys, first-run setup against a local provider endpoint, and the Lark journeys against an isolated fake transport; the app itself uses the normal configured model.

## Package locally

```sh
bun run desktop:package
```

Forge prints the output directory under `apps/desktop/out/`. macOS packages are unsigned and unnotarized. Signing, installers, updates, and acceptance on Windows or Linux are separate work. The package includes the Photon Apache 2.0 license and both font licenses.
