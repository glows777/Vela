# Desktop development

"This codebase is yours: what it's for and how it's built are your call, and you'll keep building on it."

Vela desktop brings Local projects, Local sessions, Lark projects, and Lark sessions into one app. It hosts the SDK so a user can manage those conversations in the same window.

## Process ownership

- `src/main/` owns Electron lifecycle and the in-process SDK host. Run `createChannelVela` with Local and Lark here. Sessions and events use function calls rather than a CLI subprocess, RPC, or HTTP service.
- `src/renderer/` owns the browser-only UI. It reaches main through one constrained `contextBridge` preload API so Node, Electron, and SDK privileges stay outside the page.
- `src/preload/` owns that bridge and imports no SDK. Expose typed operations rather than generic IPC access. No other IPC channels.
- `src/shared/` owns the bridge contract in one TypeScript file. It stays browser-safe and imports no main, preload, Node, Electron, or SDK code, so shared types cannot carry privileges into the renderer.

Only main may import `@glows777/vela*`. `desktop:check` enforces importer ownership, including local imports and TypeScript aliases. The SDK host, shared contract, preload bridge, and real-window assertions are connected. Home, the Local project page, the session side panel, the New project dialog, the Routines page, first-run setup and Settings › General/Models/Lark are product screens; the remaining Lark pages depend on host calls that land with them and are not built yet.

While “Run Lark in this app” is on, the app owns its Lark connection. Never use the same Lark app credentials concurrently with `vela serve`, because the two hosts would compete for one connection and persisted channel state.

Keep `sandbox`, `contextIsolation`, and disabled `nodeIntegration`. Deny new windows, page navigation, and permission requests. Keep the strict CSP in both HTML entries. These limits contain renderer content as product functionality grows.

## Design ownership

Screens follow `design/app.md`; the boards in `design/vela-app.html` show them.

`design/tokens.json` owns all Vela design tokens (colors, shadows, fonts, radii, spacing, control sizes, and motion). Prefix every token with `vela-` and regenerate CSS with `bun run --cwd apps/desktop tokens`. Native Vela controls live in `src/renderer/ui/` on top of Radix UI accessibility primitives.

Use the specimen for design work and keep `index.html` as the sole production input so samples cannot ship.

## Verification

Follow [desktop runtime verification](../../.skills/verify-vela/desktop.md) after user-visible changes. It defines isolated home and data directories and the faux-model SDK-host pattern the journeys use. Keep evidence outside commits. Running and unsigned packaging commands live in [README.md](README.md); packaging does not authorize publication.
