---
name: desktop-dev
description: Develop Vela's Electron shell, Arc foundation, and desktop conventions. Use for work under apps/desktop.
---

# Desktop development

Deliver a locally running desktop change with Vela branding, free Arc controls, and browser-only renderer imports. Product features and SDK integration remain deferred until after Vela 0.7 unless the user changes that scope.

Read [desktop boundaries](../../apps/desktop/AGENTS.md) and the relevant section of [desktop development](../../apps/desktop/README.md). Keep the small `design/tokens.json` brand manifest canonical. All Vela-owned token names use `vela-`; regenerate CSS after changing it. Arc owns spacing, control radii, and motion. Keep the document-root `arc-theme.css` bridge as the sole Vela adaptation seam for Arc colors and fonts, including portals and system themes.

Use the development preview to inspect controls and all themes. Adopt only consumed free Arc code through the stock pinned shadcn commands in the desktop README. Preserve upstream motion and reduced-motion behavior. Record deployed payload hashes, adopted source hashes, license, and exact adaptations. Registry and GitHub revisions can differ. Keep the production entry limited to `index.html`.

Run `bun run desktop:check` and the affected workspace test. Follow [desktop runtime verification](../verify-vela/desktop.md) for renderer or lifecycle changes. Keep evidence and local app packages outside commits. Report signing and platform acceptance separately from a local package build.
