# Desktop development

Keep the production app a quiet branded shell until product work is explicitly authorized after Vela 0.7. Do not add fake task data, product pages, SDK imports, backend processes, preload, or IPC placeholders.

Use `src/main.ts` for Electron lifecycle. Renderer code stays browser-only. Its TypeScript environment excludes Node globals; `desktop:check` also rejects privileged imports. Do not weaken the boundary to share main-process code.

Keep Vela brand colors and fonts in `design/tokens.json`, with every owned token prefixed `vela-`. Token values can adapt to Arc. Remove unused website scales instead of preserving a second control system. Run `bun run --cwd apps/desktop tokens`; never hand-edit generated CSS. Arc owns control geometry, spacing, and motion. Map Vela colors and fonts only in the document-root `src/styles/arc-theme.css` bridge so portals inherit all themes.

Use the separate specimen for design work. Keep it out of the production input. Consume free Arc controls directly and preserve their motion and reduced-motion branches. Follow the stock pinned shadcn workflow in README.md. Record exact deployed payload and adopted source hashes, licenses, and adaptations in provenance. A GitHub revision alone cannot identify the deployed registry. Do not add a custom installer, wrappers, or Pro dependencies.

Read `.skills/desktop-dev/SKILL.md` from the repository root for desktop changes. Run the relevant desktop checks and `.skills/verify-vela/desktop.md` before claiming runtime behavior. Packaging is local and unsigned; it does not authorize publication.
