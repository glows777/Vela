import z from "zod"
import type { MemoryStore } from "../memory"
import type { ToolDefinition } from "./registry"

const memoryToolParamSchema = z
  .object({
    action: z
      .enum(["save", "list", "search", "read", "delete"])
      .describe("记忆操作"),
    name: z.string().optional().describe("记忆名称（save 时必填）"),
    description: z.string().optional().describe("一句话描述（save 时必填）"),
    type: z.enum(["user", "feedback", "project", "reference"]).optional(),
    content: z.string().optional().describe("记忆内容（save 时必填）"),
    query: z.string().optional().describe("搜索关键词（search 时必填）"),
    filename: z
      .string()
      .optional()
      .describe(
        "真实文件名（read/delete 时必填，包含 type 前缀和 .md 后缀）；不要填写记忆的 name/逻辑名。例如 user_favorite_language 对应 user_user-favorite-language.md",
      ),
  })
  .strict()

export function createMemoryTool(memoryStore: MemoryStore): ToolDefinition {
  return {
    name: "memory",
    description:
      "管理跨会话记忆。name 是记忆的逻辑名，filename 是磁盘上的真实文件名。read/delete 必须传完整 filename（包含 type 前缀和 .md 后缀），不能传 name；例如 name=user_favorite_language 对应 filename=user_user-favorite-language.md。action: save（保存）| list（列表）| search（搜索）| read（读取）| delete（删除）",
    inputSchema: memoryToolParamSchema,
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async (args: z.infer<typeof memoryToolParamSchema>) => {
      switch (args.action) {
        case "save": {
          if (!args.name || !args.type || !args.content) {
            return "保存失败：需要 name、type、content 参数"
          }
          const filename = memoryStore.save({
            name: args.name,
            description: args.description || args.name,
            type: args.type,
            content: args.content,
          })
          return `已保存到记忆: ${filename}`
        }
        case "list": {
          const entries = memoryStore.list()
          if (entries.length === 0) return "当前没有存储任何记忆。"
          return (
            `记忆列表（共 ${entries.length} 条记忆）：\n` +
            entries
              .map((e) => `  [${e.type}] ${e.name} — ${e.description}`)
              .join("\n")
          )
        }
        case "search": {
          const results = memoryStore.search(args.query || "")
          if (results.length === 0)
            return `没有找到与 "${args.query}" 相关的记忆。`
          return (
            `搜索结果（${results.length} 条匹配）：\n` +
            results
              .map((e) => `  [${e.type}] ${e.name} — ${e.description}`)
              .join("\n")
          )
        }
        case "read": {
          if (!args.filename) return "读取失败：需要 filename 参数"
          const content = memoryStore.loadFile(args.filename)
          if (content === null) return `找不到记忆文件: ${args.filename}`
          return content
        }
        case "delete": {
          if (!args.filename) return "删除失败：需要 filename 参数"
          const ok = memoryStore.delete(args.filename)
          return ok
            ? `已删除记忆: ${args.filename}`
            : `未找到记忆文件: ${args.filename}`
        }
        default:
          return "未知操作"
      }
    },
  }
}
