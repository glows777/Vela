import { glob, readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import z from "zod";
import { resolveIn } from "./file.ts";
import type { ToolDefinition } from "./registry.ts";

const globToolParamSchema = z.object({
  pattern: z.string().describe('搜索模式，如 "**/*.ts"、"src/*.json"'),
  path: z.string().optional().describe("搜索起始目录，默认当前目录"),
});
export const createGlobTool = (cwd?: string): ToolDefinition => ({
  name: "glob",
  description:
    '按模式搜索文件。支持 * 和 ** 通配符，如 "src/**/*.ts" 匹配 src 下所有 TypeScript 文件',
  inputSchema: globToolParamSchema,
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({
    pattern,
    path = ".",
  }: {
    pattern: string;
    path?: string;
  }) => {
    const ignored = new Set(["node_modules", ".git"]);
    const base = resolveIn(cwd, path);
    const results: string[] = [];

    for await (const entry of glob(pattern, {
      cwd: base,
      withFileTypes: true,
      exclude: (entry) => ignored.has(entry.name),
    })) {
      if (!entry.isFile()) continue;
      results.push(relative(base, join(entry.parentPath, entry.name)));
    }

    if (results.length === 0) return `没有找到匹配 "${pattern}" 的文件`;
    return results.sort().join("\n");
  },
});

const grepToolParamSchema = z.object({
  pattern: z.string().describe("搜索模式（正则表达式）"),
  path: z.string().optional().describe("搜索路径（文件或目录），默认当前目录"),
});
export const createGrepTool = (cwd?: string): ToolDefinition => ({
  name: "grep",
  description: "在文件中搜索匹配指定模式的内容。返回匹配的行号和内容",
  inputSchema: grepToolParamSchema,
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({
    pattern,
    path = ".",
  }: {
    pattern: string;
    path?: string;
  }) => {
    const baseDir = resolveIn(cwd, path);
    const regex = new RegExp(pattern, "i");
    const matches: string[] = [];
    const SKIP = new Set(["node_modules", ".git", "dist"]);
    const BIN_EXT = new Set([
      ".png",
      ".jpg",
      ".gif",
      ".woff",
      ".woff2",
      ".ico",
      ".lock",
    ]);

    async function searchFile(filePath: string, rel: string) {
      if (matches.length >= 50) return;
      const ext = filePath.slice(filePath.lastIndexOf("."));
      if (BIN_EXT.has(ext)) return;

      let content: string;
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        return;
      }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i] ?? "")) {
          matches.push(`${rel}:${i + 1}: ${lines[i]?.trimEnd()}`);
          if (matches.length >= 50) return;
        }
      }
    }

    if ((await stat(baseDir)).isFile()) {
      await searchFile(baseDir, relative(baseDir, baseDir));
    } else {
      const entries = await readdir(baseDir, {
        recursive: true,
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const rel = relative(baseDir, join(entry.parentPath, entry.name));
        if (matches.length >= 50) break;
        if (rel.split(/[\\/]/).some((segment) => SKIP.has(segment))) continue;
        await searchFile(join(baseDir, rel), rel);
      }
    }

    if (matches.length === 0) return `没有找到匹配 "${pattern}" 的内容`;
    const suffix =
      matches.length >= 50 ? "\n... (结果已截断，共 50+ 条匹配)" : "";
    return matches.join("\n") + suffix;
  },
});

export const globTool = createGlobTool();
export const grepTool = createGrepTool();
