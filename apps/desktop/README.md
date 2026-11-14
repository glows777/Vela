# Vela desktop foundation

The private Electron workspace keeps Vela's brand and uses free Arc controls and motion. Product flows and SDK integration wait until after Vela 0.7. The six published packages retain their release inventory and versions. Desktop's `0.0.0` is an internal packaging identifier.

## Run locally

Use Bun 1.4 or later and Node 22.18 or later from the repository root.

```sh
bun install
bun run desktop:dev
bun run desktop:preview
```

The production window contains the local Vela icon and wordmark. The separate development preview demonstrates Arc Button, Dialog, Tabs, and Switch, plus typography, palette, and theme selection. The preview keeps no product data. Vite pre-optimizes both HTML entries so the preview works on a cold first launch. Its source and content are excluded from production bundles.

```sh
bun run desktop:check
bun run desktop:verify
bun run desktop:package
```

The check rejects token drift, unprefixed Vela tokens, privileged renderer imports, and changed pinned assets or Arc files. The runtime driver exercises real Electron controls and records motion frames and screenshots. Follow [desktop runtime verification](../../.skills/verify-vela/desktop.md) for the packaged pass. Local macOS packaging is unsigned and unnotarized. Signing, installers, updates, and Windows or Linux runtime acceptance remain separate work.

## Token and theme ownership

`design/tokens.json` is the canonical Vela brand manifest. Its colors and local font families export only `--vela-*` variables. Edit the manifest and run `bun run --cwd apps/desktop tokens`. The unused website dimension, type, and motion scales have been removed. Vela colors can evolve with the desktop design; the old requirement to preserve every website export value no longer applies.

Arc owns control spacing, radii, density, and interaction motion. Keep its variable names and use its actual shared `motion-tokens.ts` presets. Vela attention red stays separate from Arc interaction accent. Use the installed controls directly; do not wrap each control or add a parallel animation system.

`base.css` loads Arc foundation, generated Vela tokens, the explicit `arc-theme.css` bridge, then app layout. The bridge declares colors and fonts on the document root, so body-portaled Dialog content inherits them. It also maps the consumed Arc dark shadows to system dark using upstream values. The three Vela themes are light, dark, and high contrast. System follows color scheme, then contrast or forced colors. Explicit themes override media preferences. Reduced motion retains Arc's upstream fades and instant toggle branches.

Body text uses Arial and native CJK fallbacks. Local Barlow Condensed supplies display text; Shippori is decorative. Font and Arc MIT licenses accompany packaged apps. `design/provenance.json` records immutable asset sources, registry payload hashes, installed source hashes, and adoption changes.

## Adopt or update a free Arc component

`components.json` configures the public `@uiarc` registry. Arc's CSS Modules need no Tailwind dependency or Vite plugin. The stock CLI successfully installs this foundation without Tailwind; the retained `tailwind` metadata is shadcn's project configuration schema.

Read the candidate's actual registry source and dependency closure before adoption. Bring in only code the current UI consumes.

```sh
cd apps/desktop
bunx shadcn@4.23.0 view @uiarc/COMPONENT
bunx shadcn@4.23.0 add @uiarc/COMPONENT
```

If shadcn 4.23.0 requests stall when both SOCKS `ALL_PROXY` and HTTP proxy variables are configured, omit `ALL_PROXY` for that command. For example, use `env -u ALL_PROXY -u all_proxy bunx shadcn@4.23.0 view @uiarc/COMPONENT`. This preserves the HTTP proxy variables and your global proxy settings.

Replace `COMPONENT` with the free item's name. Never use a Pro registry or credentials. Review every installed file. Freeze each fetched registry response's SHA-256 and each source-content SHA-256 in `design/provenance.json`, including shared dependencies. Record the retrieval date and exact local adaptations. Registry deployment and GitHub HEAD can differ; a Git revision is not proof of the deployed payload. Keep the [Arc MIT license](https://github.com/kuratlielia/arc-library/blob/8302b52ed9dc79ae7ca699b158a98dfdf09656f7/LICENSE).

The current files retain upstream formatting and runtime behavior. Stock shadcn removes a leading comment from four files. Unused default exports and two unused exported type modifiers were removed to satisfy workspace quality checks. Provenance lists each difference. Biome excludes this pinned vendor directory; `desktop:check` detects source drift. Put Vela theme changes in the bridge, not vendor files. Do not describe CLI-rewritten or otherwise edited source as untouched.

For an update, run `bunx shadcn@4.23.0 add @uiarc/COMPONENT --dry-run`, then `--diff FILE` for each affected file. Preserve local adaptations and refresh provenance after review. Use `--overwrite` only with explicit approval. Repeat the checks and runtime driver. There is no custom installer or updater.

## Process boundaries

`src/main.ts` owns Electron lifecycle and denies window creation, navigation, and permission requests. It has no preload, IPC, SDK, or application services. Renderer code stays browser-only. Vite's production input is `index.html`; `specimen.html` is development-only.
