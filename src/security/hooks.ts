import type { VelaEvent } from '../agent/events.ts'
import { errorMessage, silentLogger, type VelaLogger } from '../logger.ts'

export type HookAction = 'allow' | 'block' | 'modify'

/** Session info passed to hooks; a hook can emit events into the calling session. */
export interface HookContext {
  sessionId?: string
  /** The model's id for this tool call */
  toolCallId?: string
  /** Set for calls a tool made through ctx.executeTool(): the calling tool's id */
  parentToolCallId?: string
  emit(event: VelaEvent): void
}

const noContext: HookContext = { emit: () => {} }

export interface HookResult {
  action: HookAction
  reason?: string
  modifiedInput?: unknown
  modifiedOutput?: unknown
}

export type PreToolHook = (
  toolName: string,
  input: unknown,
  context: HookContext,
) => HookResult | Promise<HookResult>
export type PostToolHook = (
  toolName: string,
  input: unknown,
  output: unknown,
  context: HookContext,
) => HookResult | Promise<HookResult>

export class HookPipeline {
  private preHooks: Array<{ name: string; fn: PreToolHook }> = []
  private postHooks: Array<{ name: string; fn: PostToolHook }> = []

  constructor(private logger: VelaLogger = silentLogger) {}

  setLogger(logger: VelaLogger): void {
    this.logger = logger
  }

  registerPre(name: string, fn: PreToolHook): void {
    this.preHooks.push({ name, fn })
  }

  registerPost(name: string, fn: PostToolHook): void {
    this.postHooks.push({ name, fn })
  }

  async runPre(
    toolName: string,
    input: unknown,
    context: HookContext = noContext,
  ): Promise<HookResult> {
    let currentInput = input
    let modified = false
    for (const hook of this.preHooks) {
      try {
        const result = await hook.fn(toolName, currentInput, context)
        if (result.action === 'block') return result
        if (result.action === 'modify' && result.modifiedInput !== undefined) {
          currentInput = result.modifiedInput
          modified = true
        }
      } catch (error) {
        this.logger.error(
          `[hook:${hook.name}] pre failed: ${errorMessage(error)}`,
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
    context: HookContext = noContext,
  ): Promise<HookResult> {
    let currentOutput = output
    for (const hook of this.postHooks) {
      try {
        const result = await hook.fn(toolName, input, currentOutput, context)
        if (result.action === 'modify' && result.modifiedOutput !== undefined) {
          currentOutput = result.modifiedOutput
        }
      } catch (error) {
        this.logger.error(
          `[hook:${hook.name}] post failed: ${errorMessage(error)}`,
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
