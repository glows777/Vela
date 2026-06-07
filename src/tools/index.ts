import { tool } from "ai";
import { join, resolve } from "node:path";
import z from "zod";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import type { ToolDefinition } from "./register";

export const weatherToolParamSchema = z.object({
  city: z.string().describe("要查询天气的城市名称"),
});

export const weatherTool: ToolDefinition = {
  name: "get_weather",
  description: "查询指定城市的天气信息",
  inputSchema: weatherToolParamSchema,
  execute: async ({ city }: { city: string }) => {
    const mockWeather: Record<string, string> = {
      北京: "晴，15-25°C，东南风 2 级",
      上海: "多云，18-22°C，西南风 3 级",
      深圳: "阵雨，22-28°C，南风 2 级",
    };
    return mockWeather[city] || `${city}：暂无数据`;
  },
  isConcurrencySafe: true,
  isReadOnly: true,
};

export const calculatorToolParamSchema = z.object({
  expression: z.string().describe('要计算的数学表达式，如 "2 + 3 * 4"'),
});

export const calculatorTool: ToolDefinition = {
  name: "calculator",
  description: "计算数学表达式的结果。当用户提问涉及数学运算时使用",
  inputSchema: calculatorToolParamSchema,
  execute: async ({ expression }: { expression: string }) => {
    try {
      const result = new Function(`return ${expression}`)();
      return `${expression} = ${result}`;
    } catch {
      return `无法计算: ${expression}`;
    }
  },

  isConcurrencySafe: true,
  isReadOnly: true,
};

export const readFileParamSchema = z.object({
  path: z.string().describe("文件路径"),
});
export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "读取指定路径的文件内容",
  inputSchema: readFileParamSchema,
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 500, // 生产环境通常 50000+
  execute: async ({ path }: { path: string }) => {
    return readFileSync(resolve(path), "utf-8");
  },
};

const writeFileToolParamSchema = z.object({
  path: z.string().describe("文件路径"),
  content: z.string().describe("要写入的内容"),
});
export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: "写入内容到指定文件",
  inputSchema: writeFileToolParamSchema,

  isConcurrencySafe: false, // 写操作不能并行
  isReadOnly: false,
  execute: async ({ path, content }: { path: string; content: string }) => {
    writeFileSync(resolve(path), content, "utf-8");
    return `已写入 ${content.length} 字符到 ${path}`;
  },
};

const listDirectoryToolParamSchema = z.object({
  path: z.string().optional().describe("目录路径，默认为当前目录"),
});
export const listDirectoryTool: ToolDefinition = {
  name: "list_directory",
  description: "列出指定目录下的文件和子目录",
  inputSchema: listDirectoryToolParamSchema,
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ path = "." }: { path?: string }) => {
    const resolved = resolve(path);
    return readdirSync(resolved)
      .map((name) => {
        const stat = statSync(join(resolved, name));
        return `${stat.isDirectory() ? "[DIR]" : "[FILE]"} ${name}`;
      })
      .join("\n");
  },
};

export const allTools: ToolDefinition[] = [
  weatherTool,
  calculatorTool,
  readFileTool,
  writeFileTool,
  listDirectoryTool,
];
