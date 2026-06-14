export interface PromptContext {
  toolCount: number;
  deferredToolSummary: string;
  sessionMessageCount: number;
  sessionId: string;
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

  debug(ctx: PromptContext): void {
    console.log("\n=== Prompt PipeLine Debug ===");
    for (const { name, fn } of this.pipeLines) {
      const result = fn(ctx);
      const status = result !== null ? `[ON] ${result.length} chars` : "[OFF]";
      console.log(`  ${name}: ${status}`);
    }
    console.log("========================\n");
  }
}
