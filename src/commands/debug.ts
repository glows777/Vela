import { applyDefense, estimateMessageTokens } from "../context/defense"
import { textToolResultOutput } from "../context/tool-result-output"
import { setCacheEnabled } from "../mock"
import type { CommandHandler } from "./index.js"

export const debugCommands: CommandHandler[] = [
  (cmd, ctx) => {
    if (cmd !== "模拟长对话" && cmd !== "sim") return false
    const now = Date.now()
    console.log("\n[模拟] 注入 20 条历史消息（含大量工具结果）...")
    for (let i = 0; i < 5; i++) {
      const age = (20 - i * 4) * 60 * 1000
      const idx = ctx.messages.length
      ctx.messages.push({
        role: "user",
        content: `第 ${i + 1} 轮：帮我读文件 file-${i}.ts`,
      })
      ctx.timestamps.set(idx, now - age)
      ctx.messages.push({
        role: "assistant",
        content: [
          {
            type: "tool-call" as const,
            toolCallId: `sim-${i}`,
            toolName: "read_file",
            input: { path: `file-${i}.ts` },
          },
        ],
      })
      ctx.timestamps.set(idx + 1, now - age)
      const bigContent =
        `// file-${i}.ts\n` +
        "export function handler() {\n  // ...\n}\n".repeat(200)
      ctx.messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result" as const,
            toolCallId: `sim-${i}`,
            toolName: "read_file",
            output: textToolResultOutput(bigContent),
          },
        ],
      })
      ctx.timestamps.set(idx + 2, now - age)
      ctx.messages.push({
        role: "assistant",
        content: [
          { type: "text" as const, text: `文件 file-${i}.ts 的内容已读取。` },
        ],
      })
      ctx.timestamps.set(idx + 3, now - age)
    }
    console.log(
      `[模拟完成] ${ctx.messages.length} 条消息, ~${estimateMessageTokens(ctx.messages)} tokens\n`,
    )
    return true
  },

  (cmd, ctx) => {
    if (cmd !== "执行防线" && cmd !== "defend") return false
    console.log("\n--- 执行三层防线 ---")
    const before = estimateMessageTokens(ctx.messages)
    const def = applyDefense(ctx.messages, ctx.timestamps)
    ctx.messages = def.messages
    console.log(
      `  [Layer 2] 截断: ${def.truncated} 条, 预算清理: ${def.compacted} 条`,
    )
    console.log(
      `  [Layer 3] 软修剪: ${def.softPruned}, 硬清除: ${def.hardPruned}`,
    )
    console.log(
      `  [结果] ~${before} → ~${def.tokenEstimate} tokens (节省 ${before - def.tokenEstimate})\n`,
    )
    return true
  },

  (cmd, ctx) => {
    if (cmd !== "status" && cmd !== "查看状态") return false
    const tokens = estimateMessageTokens(ctx.messages)
    const memCount = ctx.memoryStore?.list().length ?? 0
    console.log(
      `\n[状态] ${ctx.messages.length} 条消息, ~${tokens} tokens, ${memCount} 条记忆\n`,
    )
    return true
  },

  (cmd) => {
    if (cmd === "/cache off" || cmd === "cache off") {
      setCacheEnabled(false)
      console.log("\n  已关闭 cache 模拟\n")
      return true
    }
    if (cmd === "/cache on" || cmd === "cache on") {
      setCacheEnabled(true)
      console.log("\n  已开启 cache 模拟\n")
      return true
    }
    return false
  },
]
