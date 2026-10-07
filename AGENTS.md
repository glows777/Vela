---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

## Agent 执行边界

- 用户当前指令优先于本文件、Skill 和历史上下文。只读取与当前任务相关的源码、配置、测试和文档；小改动不要求先遍历整个仓库。
- 先确定可观察的完成条件。已授权的可逆实现、检查和修复应持续做到完成，不在首版补丁后提前交回；只有会改变范围/结果的未知信息或不可逆/外部写入才需要暂停。
- 按变更风险选择验证：对受影响的 Bun 测试做定向回归；跨模块、运行时或协议改动再扩大到完整 `bun test`、类型检查或构建。不要为低风险改动机械运行无关的全套检查。
- `.skills/<name>/SKILL.md` 是按需加载的工作流入口。新增或维护 Skill 时保持触发描述短而精确；多流程内容使用入口加引用/脚本的渐进式披露，不预加载无关正文，也不把一次任务的临时步骤写进共享规则。

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

`src/` 是发布到 npm 的包（编译成 `dist/`），要在 Node ≥ 22.18 和 Bun 上都能跑：只用 `node:` 模块和 Web 标准 API，不用 `Bun.*` 全局和 `bun:` 模块（RAG 的 SQLite 经 `src/extensions/rag/sqlite.ts` 适配两边）；相对 import 写 `.ts` 扩展名。`bun run build` 出 `dist/`，`bun run smoke:consumer` 在 Node 和 Bun 的空项目里各验一遍。下面的 Bun API 建议只适用于 `scripts/` 和 `test/`。

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

测试怎么组织、怎么验收一次改动、怎么新增测试，见 [test/README.md](test/README.md)（改测试或改到 agent loop、装配、事件、上下文、CLI 前先读）。要点：

- `bun run test` 跑 unit + e2e（约 5 秒，不联网、不需要环境变量）；定向时 `bun test test/unit/<模块>` 或 `bun test test/e2e/<场景>`。
- 单元测试放 `test/unit/`，路径镜像 `src/`；整体流程放 `test/e2e/`，用 `test/support/vela.ts` 的 `createTestVela()` 和 `src/testing/faux.ts` 的脚本化 faux 模型。
- 修 bug 先写一个能复现的 faux 场景；改了事件、faux 接口或测试约定时同步更新 test/README.md。

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
