import type { ToolResultStore } from "../session/tool-results";

export interface PromptContext {
  toolCount: number;
  deferredToolSummary: string;
  sessionMessageCount: number;
  sessionId: string;
  /** 当前会话的工具结果存储（toolHistoryGuide 用） */
  toolResults?: ToolResultStore;
  /** 当前会话已激活的 skill */
  activeSkills?: ReadonlySet<string>;
}

export type PipeFn = (ctx: PromptContext) => string | null;

export class PromptPipeline {
  private pipeLines: Array<{ name: string; fn: PipeFn }> = [];

  pipe(name: string, fn: PipeFn) {
    this.pipeLines.push({ name, fn });
    return this;
  }

  build(ctx: PromptContext) {
    const prompts: string[] = [];

    for (const { fn } of this.pipeLines) {
      const prompt = fn(ctx);
      if (prompt !== null) {
        prompts.push(prompt);
      }
    }

    return prompts.join("\n\n");
  }

  /** 每个段落当前是否启用、多少字符（null 表示这一段关闭）。 */
  status(ctx: PromptContext): Array<{ name: string; chars: number | null }> {
    return this.pipeLines.map(({ name, fn }) => {
      const result = fn(ctx);
      return { name, chars: result === null ? null : result.length };
    });
  }
}
