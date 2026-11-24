# Desktop design

The design for the Vela desktop app. Use these files when you build or review an app screen.

| File | What it is |
|---|---|
| `app.md` | The app's rules: layout, shape, states, motion, icons, voice, and how projects, sessions, Lark, routines and settings work. This is the source for app UI. |
| `system.md` | The shared Vela design system (content, colour, themes, type, wordmark and portrait marks). It covers the website too; inside the app, `app.md` wins where they differ. |
| `vela-app.html` | The design boards: 34 screens (home, local project, Lark project, topic, running session, routines, settings, first run, error states and more). Open it in a browser. It is a visual reference, not code to copy. |
| `tokens.json` | The Vela design tokens the app uses: colours, fonts, control sizes, radii, spacing, and motion. Code reads this file, not the boards. |
| `provenance.json` | Where adopted assets and components came from, and their licenses. |

How they fit together:

- **Colours, fonts, control sizes, radii, spacing, and motion** come from [`tokens.json`](tokens.json) (`vela-` names). Use the native controls in [`src/renderer/ui/`](../src/renderer/ui/) and follow the [design ownership rules](../AGENTS.md#design-ownership). Where `app.md` or a board names a size or radius, use the closest existing token instead of adding a new one.
- **The boards show the full design, ahead of the product.** Some screens depend on things Vela doesn't have yet: approval and decision cards, the step checklist, branches and forks, the menu bar, notifications. Build a screen only when its issue asks for it, and show only what Vela actually records. Names and data on the boards are samples.
