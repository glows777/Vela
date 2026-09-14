export type HookAction = 'allow' | 'block' | 'modify'

export interface HookResult {
  action: HookAction
  reason?: string
  modifiedInput?: unknown
  modifiedOutput?: unknown
}

export type PreToolHook = (
  toolName: string,
  input: unknown,
) => HookResult | Promise<HookResult>
export type PostToolHook = (
  toolName: string,
  input: unknown,
  output: unknown,
) => HookResult | Promise<HookResult>

export class HookPipeline {
  private preHooks: Array<{ name: string; fn: PreToolHook }> = []
  private postHooks: Array<{ name: string; fn: PostToolHook }> = []

  registerPre(name: string, fn: PreToolHook): void {
    this.preHooks.push({ name, fn })
  }

  registerPost(name: string, fn: PostToolHook): void {
    this.postHooks.push({ name, fn })
  }

  async runPre(toolName: string, input: unknown): Promise<HookResult> {
    let currentInput = input
    let modified = false
    for (const hook of this.preHooks) {
      try {
        const result = await hook.fn(toolName, currentInput)
        if (result.action === 'block') return result
        if (result.action === 'modify' && result.modifiedInput !== undefined) {
          currentInput = result.modifiedInput
          modified = true
        }
      } catch (error) {
        console.error(
          `[hook:${hook.name}] pre 异常: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return modified
      ? { action: 'modify', modifiedInput: currentInput }
      : { action: 'allow' }
  }

  async runPost(
    toolName: string,
    input: unknown,
    output: unknown,
  ): Promise<HookResult> {
    let currentOutput = output
    for (const hook of this.postHooks) {
      try {
        const result = await hook.fn(toolName, input, currentOutput)
        if (result.action === 'modify' && result.modifiedOutput !== undefined) {
          currentOutput = result.modifiedOutput
        }
      } catch (error) {
        console.error(
          `[hook:${hook.name}] post 异常: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return { action: 'allow', modifiedOutput: currentOutput }
  }

  list(): { pre: string[]; post: string[] } {
    return {
      pre: this.preHooks.map((hook) => hook.name),
      post: this.postHooks.map((hook) => hook.name),
    }
  }
}
