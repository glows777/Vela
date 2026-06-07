import { extname, join, relative, resolve } from "node:path";
import z from "zod";
import { existsSync, readdirSync, statSync } from "node:fs";
import type { ToolDefinition } from "./register";
import TurndownService from "turndown";
import { pickSearchTool } from "./web-search";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});
turndown.remove(["script", "style", "nav", "footer", "header", "iframe"]);

function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}

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

const globToolParamSchema = z.object({
  pattern: z.string().describe('搜索模式，如 "**/*.ts"、"src/*.json"'),
  path: z.string().optional().describe("搜索起始目录，默认当前目录"),
});
export const globTool: ToolDefinition = {
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
    const glob = new Bun.Glob(pattern);
    const results: string[] = [];

    for await (const result of glob.scan({
      cwd: resolve(path),
      dot: false,
      onlyFiles: true,
      followSymlinks: false,
    })) {
      if (result.split(/[\\/]/).some((segment) => ignored.has(segment))) {
        continue;
      }
      results.push(result);
    }

    if (results.length === 0) return `没有找到匹配 "${pattern}" 的文件`;
    return results.sort().join("\n");
  },
};

const grepToolParamSchema = z.object({
  pattern: z.string().describe("搜索模式（正则表达式）"),
  path: z.string().optional().describe("搜索路径（文件或目录），默认当前目录"),
});
export const grepTool: ToolDefinition = {
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
    const baseDir = resolve(path);
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
        content = await Bun.file(filePath).text();
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

    if (await Bun.file(baseDir).exists()) {
      await searchFile(baseDir, relative(baseDir, baseDir));
    } else {
      const glob = new Bun.Glob("**/*");

      for await (const rel of glob.scan({
        cwd: baseDir,
        dot: true,
        onlyFiles: true,
        followSymlinks: true,
      })) {
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
};

const bashToolParamSchema = z.object({
  command: z.string().describe("要执行的 shell 命令"),
});
export const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "执行 shell 命令并返回输出。适合运行脚本、检查环境、执行构建等操作",
  inputSchema: bashToolParamSchema,
  isConcurrencySafe: false,
  isReadOnly: false,
  maxResultChars: 3000,
  execute: async ({ command }: { command: string }) => {
    try {
      const check = Bun.spawn({
        cmd: ["bash", "-lc", "echo test"],
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        timeout: 10000,
      });
      const checkExitCode = await check.exited;
      if (checkExitCode !== 0) {
        return `[bash 不可用] 当前环境（WebContainer）不支持 shell 命令。本地终端运行 pnpm start 可使用 bash 工具。`;
      }
    } catch {
      return `[bash 不可用] 当前环境（WebContainer）不支持 shell 命令。本地终端运行 pnpm start 可使用 bash 工具。`;
    }

    try {
      const proc = Bun.spawn({
        cmd: ["bash", "-lc", command],
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10000,
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        proc.stdout.text(),
        proc.stderr.text(),
        proc.exited,
      ]);

      if (exitCode === 0) {
        return stdout || "(命令执行成功，无输出)";
      }

      return `命令执行失败 (exit ${exitCode || 1}):\n${stderr || stdout || `Command failed: ${command}`}`;
    } catch (err: any) {
      const stderr = err.stderr?.toString?.() || "";
      const stdout = err.stdout?.toString?.() || "";
      return `命令执行失败 (exit ${err.exitCode || err.status || 1}):\n${stderr || stdout || err.message}`;
    }
  },
};

const webFetchToolParamSchema = z.object({
  url: z.string().describe("完整 URL"),
});
export const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  description: "抓取指定 URL 的网页内容，转换为 Markdown 格式",
  inputSchema: webFetchToolParamSchema,
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({ url }: { url: string }) => {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; SuperAgent/1.0)" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return `抓取失败: HTTP ${res.status}`;
      const html = await res.text();
      return htmlToMarkdown(html);
    } catch (err: any) {
      return `抓取失败: ${err.message}`;
    }
  },
};

let previewServer: Bun.Server<undefined> | null = null;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".tsx": "application/javascript; charset=utf-8", // 让浏览器把 .tsx 当 JS 加载
  ".ts": "application/javascript; charset=utf-8",
  // ...
};

const startPreviewToolParamSchema = z.object({
  port: z.number(),
});
export const startPreviewTool: ToolDefinition = {
  name: "start_preview",
  description: "启动 app/ 目录的预览服务器。生成应用文件后必须立即调用此工具",
  inputSchema: startPreviewToolParamSchema,
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({ port = 8080 }: { port?: number } = {}) => {
    if (previewServer) return `预览服务器已在运行 → http://localhost:${port}`;
    const root = resolve("app");
    if (!existsSync(root)) return "错误：app/ 目录不存在";

    previewServer = Bun.serve({
      port,
      async fetch(req) {
        let urlPath: string;
        try {
          const pathname = new URL(req.url).pathname;
          urlPath = decodeURIComponent(pathname).replace(/\/$/, "/index.html");
        } catch {
          return new Response("Bad Request", { status: 400 });
        }

        const filePath = resolve(root, `.${urlPath}`);
        const relativePath = relative(root, filePath);

        if (relativePath.startsWith("..")) {
          return new Response(null, { status: 403 });
        }

        const file = Bun.file(filePath);
        if (!(await file.exists())) {
          return new Response("Not Found", { status: 404 });
        }

        return new Response(file, {
          headers: {
            "Content-Type":
              MIME[extname(filePath).toLowerCase()] ||
              "application/octet-stream",
            "Cache-Control": "no-cache",
          },
        });
      },
    });

    return `✓ 预览服务器已启动 → http://localhost:${previewServer.port}`;
  },
};

export const allTools: ToolDefinition[] = [
  weatherTool,
  calculatorTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirectoryTool,
  grepTool,
  globTool,
  bashTool,
  startPreviewTool,
  webFetchTool,
  pickSearchTool(),
];
