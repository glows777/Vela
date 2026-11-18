# Run Vela desktop

The private Electron workspace hosts the SDK in its main process and shows Home, Local projects and their chats alongside the separate design specimen. Product pages are separate work. Process ownership is defined in [AGENTS.md](AGENTS.md). Desktop's `0.0.0` is an internal packaging identifier.

Main loads the normal user settings from `VELA_DIR` (or `~/.vela`), owns the Local and Lark channels, and disposes them on quit. Do not run this app and `vela serve` against the same Lark credentials at once. A constrained preload bridge exposes channel and Local host operations; renderer code never imports the SDK. The window is the app frame with Home, a project page and the New project dialog; the session panel and Lark pages are later issues.

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

For runtime evidence, including the packaged pass and scratch directory options, follow [desktop verification](../../.skills/verify-vela/desktop.md). The driver creates and removes a private data subdirectory inside a supplied `VELA_DIR`, and never overwrites an existing settings file. It verifies the Local host with a faux model, configured shell, image input and paged history, then drives journey 1 as a person would; the app itself uses the normal configured model.

## Package locally

```sh
bun run desktop:package
```

Forge prints the output directory under `apps/desktop/out/`. macOS packages are unsigned and unnotarized. Signing, installers, updates, and acceptance on Windows or Linux are separate work. The package includes the Photon Apache 2.0 license, Arc MIT license, and both font licenses.

## Adopt or update Arc components

Read the candidate's registry source and dependency closure, then use the configured public registry with stock shadcn.

```sh
cd apps/desktop
bunx shadcn@4.23.0 view @uiarc/COMPONENT
bunx shadcn@4.23.0 add @uiarc/COMPONENT
```

Replace `COMPONENT` with the free item's name. Review the installed changes and follow the [design ownership rules](AGENTS.md#design-ownership). Arc uses CSS Modules without a Tailwind dependency or plugin; the retained `tailwind` metadata is shadcn's configuration schema.

For an update, inspect `bunx shadcn@4.23.0 add @uiarc/COMPONENT --dry-run` and `--diff FILE` before applying changes. Run desktop checks and the runtime driver after adoption or an update.
