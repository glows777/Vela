// Exact relevant answers from the original issue #203 live artifacts.
export const savedGraderAnswers = [
  {
    scenario: 'C1',
    check: 'bash limits',
    source: 'default/C1-new-3-1',
    answer:
      '## 通用工具：3000 字符\n\n- 阈值：`DEFAULT_MAX_RESULT_CHARS = 3000`，定义在 **`src/tools/call-result.ts:9`**，由 `prepareCallResult` 使用（`call-result.ts:40`）。\n- 超过后：完整结果写入 `sessions/<sessionId>/tool-results/<callId>.txt`（`ToolResultStore.save`，`src/session/tool-results.ts`），模型只拿到 `preview` 字符串（`src/tools/registry.ts:563`、`src/context/tool-result-output.ts:8`）。\n- 预览形态：前 60% + `[preview: first N and last M of T UTF-16 code units; K omitted here, full output saved]` + 后 40%（`truncateResult`，`call-result.ts:154`）。所以预览本身约 3000 字符再加标记文字；实测 5006 字节输出 → preview 3103 字符，头部 1800 / 尾部 1200。\n- 计数口径：模型看到的文本的 `String.length`（UTF-16 code unit），字符串不按 JSON 转义计；非字符串结果取 `JSON.stringify` 长度。注意 bash 的 50KB 是字节，不是字符。\n\n工具可用 `ToolDefinition.maxResultChars`（`src/tools/registry.ts:85`，传入处 `registry.ts:537`）覆盖默认值：read_file `50KB+1024`（单页上限就是 50KB，基本永不触发）、grep/search `12000`、web 工具 `3000`、MCP `20000`、飞书 topics `20000`。\n\n## bash：不一样\n\nbash 从执行开始就把 stdout/stderr 直接写进文件，模型只看**最后 2000 行或 50KB（先到者）**：\n\n- `BASH_MAX_LINES = 2000`、`BASH_MAX_BYTES = 50 * 1024`，定义在 **`src/tools/shell.ts:10-11`**，截取逻辑是 `readTail`（`shell.ts:281` 起），脚注为 `[Showing the last N lines ... of X bytes of output. Full output: <path>]`。\n- bash 返回的已经是 `StoredToolResult`，`prepareCallResult` 的 `if (!stored && ...)`（`call-result.ts:48`）会跳过 3000 字符那条路径，因此 bash 预览可以远超 3000 字符。\n- 实测：20000 行输出 → preview 22,130 字符；300KB 单行 → preview 51,351 字符（50KB 尾部 + 脚注），完整文件 300,000 字节。\n- 用户自己敲的 `!cmd` 走 `runBash`（`shell.ts:217`），同样是 2000 行/50KB，只是不经过模型。',
  },
  {
    scenario: 'C5',
    check: 'progress recalled',
    source: 'default/C5-new-2-1',
    answer:
      '**3 steps completed** (`step-1.txt`, `step-2.txt`, `step-3.txt` all present). **Next step number: 4.**\n\nNo files changed.',
  },
  {
    scenario: 'C5',
    check: 'progress recalled',
    source: 'default/C5-old-3-1',
    answer:
      '**Status:** 3 of 6 steps completed.\n\n- **Completed:** steps 1, 2, 3 — `task/step-1.txt`, `task/step-2.txt`, `task/step-3.txt` each contain exactly `step=N\\n`.\n- **Next:** step 4 (read `task/note-4.txt`, then create `task/step-4.txt`).\n\nNo files changed. Awaiting your go-ahead for step 4.',
  },
  {
    scenario: 'C5',
    check: 'progress recalled',
    source: 'high/C5-new-3-1',
    answer:
      '3 steps completed (step-1.txt, step-2.txt, step-3.txt). Next step number: 4.',
  },
] as const
