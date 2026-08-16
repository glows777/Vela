import z from "zod";
import type { ToolDefinition } from "./registry";

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
