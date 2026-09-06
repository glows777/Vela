import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import z from "zod";
import type { ToolDefinition } from "./registry";

export const readFileParamSchema = z.object({
  path: z.string().describe("文件路径"),
  offset: z.number().int().positive().optional().describe('起始行，1-based，默认 1'),
  limit: z.number().int().positive().optional().describe('最多读取行数，默认 200'),
  column: z.number().int().nonnegative().optional().describe('起始行内的 UTF-16 偏移，默认 0；超长单行按返回的 column 续读'),
});
export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "分页读取文本文件或工具结果文件。返回展示范围和下一页 offset/column；只有读到 EOF 才表示读取完毕。",
  inputSchema: readFileParamSchema,
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 12000,
  execute: async (input: z.infer<typeof readFileParamSchema>) => {
    const { path, offset = 1, limit = 200, column = 0 } = readFileParamSchema.parse(input);
    const file = Bun.file(resolve(path));
    const decoder = new TextDecoder();
    let line = 1;
    let col = 0;
    let body = '';
    let more = false;
    let reachedStart = offset === 1 && column === 0;
    let lastLine = offset;
    const consume = (text: string): boolean => {
      for (const char of text) {
        if (line === offset && col < column && col + char.length > column) throw new Error('column 位于 Unicode 字符中间，请使用上次返回的 column');
        if (line >= offset && (line > offset || col >= column)) {
          reachedStart = true;
          if (body.length + char.length > 8000 || line >= offset + limit) {
            more = true;
            return false;
          }
          body += char;
          lastLine = line;
        }
        if (char === '\n') {
          if (line === offset && col < column) throw new Error('column 超过起始行长度');
          line++;
          col = 0;
        } else {
          col += char.length;
        }
      }
      return true;
    };
    for await (const chunk of file.stream()) {
      if (!consume(decoder.decode(chunk, { stream: true }))) break;
    }
    if (!more) consume(decoder.decode());
    if (!reachedStart && !(line === offset && col === column)) throw new Error('offset/column 超过文件范围');
    const next = more
      ? `More content exists. Continue read_file with path=${JSON.stringify(path)}, offset=${line}, column=${col}, limit=${limit}.`
      : 'EOF: no more content.';
    return `${body}\n\n[read_file: lines ${offset}-${lastLine}, starting column=${column}; ${body.length} UTF-16 code units shown. ${next}]`;
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
    return readdirSync(resolved, { withFileTypes: true })
      .map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
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
