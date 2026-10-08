import type { Tool } from "ai";
import z from "zod";
import type { ToolDefinition, ToolRegistry } from "./registry.ts";

const toolSearchToolSchema = z.object({
  query: z
    .string()
    .describe('工具名，如 "mcp__github__list_issues"。支持逗号分隔多个工具名'),
});

export const registerToolSearchTool = (registry: ToolRegistry) => {
  const toolSearchTool: ToolDefinition = {
    name: "tool_search",
    description:
      "获取延迟工具的完整定义。传入工具名（从系统提示的延迟工具列表中选取），返回该工具的完整参数 Schema",
    inputSchema: toolSearchToolSchema,
    isConcurrencySafe: true,
    isReadOnly: true,
    // 用执行这次调用的会话 registry：发现的延迟工具只对这个会话生效
    execute: async ({ query }: { query: string }, context) => {
      const results = (context?.registry ?? registry).searchTools(query);
      if (results.length === 0) return `没有找到匹配 "${query}" 的工具`;
      return results.map<Tool>((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    },
  };

  registry.register(toolSearchTool);
};
