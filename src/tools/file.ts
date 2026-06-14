import type { ToolDefinition } from "./registry";
import z from "zod";
import { join, resolve } from "node:path";
import { readdirSync, statSync } from "node:fs";

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
    return Bun.file(resolve(path)).text();
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
    await Bun.write(resolve(path), content);
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

const editFileToolParamSchema = z.object({
  path: z.string().describe("文件路径"),
  old_string: z.string().describe("要被替换的原始文本（必须精确匹配）"),
  new_string: z.string().describe("替换后的新文本"),
});
export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    "精确替换文件中的指定内容。用 old_string 定位要替换的文本，用 new_string 替换它。不是全量覆写——只改你指定的部分",
  inputSchema: editFileToolParamSchema,
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({
    path,
    old_string,
    new_string,
  }: {
    path: string;
    old_string: string;
    new_string: string;
  }) => {
    const resolved = resolve(path);
    const file = Bun.file(resolved);
    if (!(await file.exists())) return `文件不存在: ${path}`;

    const content = await file.text();
    const count = content.split(old_string).length - 1;

    if (count === 0) {
      return `未找到匹配内容。请检查 old_string 是否与文件中的文本完全一致（包括空格和换行）`;
    }
    if (count > 1) {
      return `找到 ${count} 处匹配，请提供更多上下文让 old_string 唯一`;
    }

    const updated = content.replace(old_string, new_string);
    await Bun.write(resolved, updated);
    return `已替换 ${path} 中的内容（${old_string.length} → ${new_string.length} 字符）`;
  },
};
