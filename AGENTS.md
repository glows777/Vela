---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

## Agent boundaries

- The user's current instructions take precedence over this file, skills and earlier context. Read only the source, config, tests and docs relevant to the task; small changes don't require walking the whole repo.
- Define an observable done condition first. Authorized, reversible implementation, checks and fixes are carried through to completion, not handed back after the first patch; pause only for unknowns that change scope or outcome, or for irreversible or external writes.
- Pick verification by risk: run the affected Bun tests for targeted regressions; widen to the full `bun test`, typecheck or build for cross-module, runtime or protocol changes. Don't run unrelated full suites for low-risk changes.
- `.skills/<name>/SKILL.md` is an on-demand workflow entry point. Keep a skill's trigger description short and precise; put multi-flow content behind references or scripts (progressive disclosure), don't preload unrelated text, and don't write one task's temporary steps into shared rules.

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

`src/` is the npm package (compiled to `dist/`) and must run on Node ≥ 22.18 and Bun: use only `node:` modules and web-standard APIs, never `Bun.*` globals or `bun:` modules (RAG's SQLite goes through `src/extensions/rag/sqlite.ts`, which adapts both). Relative imports carry the `.ts` extension. `bun run build` emits `dist/`; `bun run smoke:consumer` checks the package in empty Node and Bun projects. The Bun API advice below applies only to `scripts/` and `test/`.

All code, comments, messages and docs in the repo are in English.

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

How tests are organized, how to verify a change and how to add tests: see [test/README.md](test/README.md) (read it before changing tests or the agent loop, assembly, events, context or CLI). In short:

- `bun run test` runs unit + e2e (a few seconds, no network, no environment variables); target with `bun test test/unit/<module>` or `bun test test/e2e/<scenario>`.
- Unit tests live in `test/unit/`, mirroring `src/`; end-to-end flows live in `test/e2e/` and use `createTestVela()` from `test/support/vela.ts` and the scripted faux model from `src/testing/faux.ts`.
- Fix a bug by first writing a faux scenario that reproduces it; when you change events, the faux interface or test conventions, update test/README.md.

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
