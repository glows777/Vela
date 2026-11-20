import type { LanguageModel } from 'ai'
import type { ContextManager } from '../context/manager.ts'
import type { VelaLimits } from '../limits.ts'
import { clampThinkingLevel } from '../models/catalog.ts'
import {
  DEFAULT_THINKING_LEVEL,
  limitsForModel,
  type ModelInfo,
  type ResolvedModel,
  THINKING_LEVELS,
  type ThinkingLevel,
} from '../models/index.ts'
import type { SessionDeps } from './deps.ts'
import type { SessionContext } from './entries.ts'
import type { SessionStore } from './index.ts'
import type { SessionOptions } from './options.ts'
import type { SessionDefaults } from './resources.ts'

/** Session-local selection provenance and the prepared project's default snapshot. */
export class SessionDefaultState {
  modelChoice: string | LanguageModel | undefined
  resolved?: ResolvedModel
  /** The selected model wrapped with extension provider hooks. */
  hooked?: LanguageModel
  thinking: ThinkingLevel
  modelPinned: boolean
  thinkingPinned: boolean
  compactionPinned: boolean
  effectiveLimitOverrides: Partial<VelaLimits>
  private prepared?: SessionDefaults

  constructor(
    deps: Pick<
      SessionDeps<unknown>,
      'model' | 'thinkingLevel' | 'limitOverrides'
    >,
    options: SessionOptions,
  ) {
    this.modelChoice = options.model ?? deps.model
    this.thinking = options.thinkingLevel ?? deps.thinkingLevel
    this.modelPinned = options.model !== undefined
    this.thinkingPinned = options.thinkingLevel !== undefined
    this.compactionPinned = options.autoCompaction !== undefined
    this.effectiveLimitOverrides = { ...deps.limitOverrides }
  }

  /** The requested level clamped to the selected model's support. */
  thinkingLevelFor(info: ModelInfo): ThinkingLevel {
    return clampThinkingLevel(this.thinking, info, THINKING_LEVELS)
  }

  async restore(
    context: SessionContext,
    deps: {
      extensions: { ready: Promise<void> }
      logger: SessionDeps<unknown>['logger']
    },
    id: string,
    selectModel: (model: string) => void,
  ): Promise<void> {
    if (
      context.thinkingLevel &&
      THINKING_LEVELS.includes(context.thinkingLevel)
    ) {
      this.thinking = context.thinkingLevel
      this.thinkingPinned = true
    }
    if (context.model && context.model !== this.resolved?.info.ref) {
      // Providers registered by extensions resolve only after extensions load
      await deps.extensions.ready.catch(() => {})
      try {
        selectModel(context.model)
        this.modelPinned = true
      } catch (error) {
        deps.logger.warn(
          `[session] Saved model ${context.model} for ${id} is unavailable, keeping the current model: ${error instanceof Error ? error.message : error}`,
        )
      }
    }
    if (context.model && context.model === this.resolved?.info.ref)
      this.modelPinned = true
  }

  applyOpenChoices(
    options: SessionOptions,
    selectModel: (model: string | LanguageModel) => void,
  ) {
    // A model or thinking level given at open (a channel's current chat entry) wins over the saved choice
    if (options.thinkingLevel !== undefined)
      this.thinking = options.thinkingLevel
    if (options.model !== undefined && options.model !== this.modelChoice)
      selectModel(options.model)
  }

  apply(
    defaults: SessionDefaults | undefined,
    store: SessionStore,
    limits: VelaLimits,
    context: ContextManager,
  ): void {
    if (!defaults || defaults === this.prepared) return
    // Do not resolve a model while loading resources: project providers may not be ready.
    if (!this.modelPinned && defaults.model !== this.modelChoice) {
      this.modelChoice = defaults.model
      this.resolved = undefined
      this.hooked = undefined
      if (typeof defaults.model === 'string')
        store.appendModelChange(defaults.model)
    }
    const thinking = defaults.thinkingLevel ?? DEFAULT_THINKING_LEVEL
    if (!this.thinkingPinned && thinking !== this.thinking) {
      this.thinking = thinking
      store.appendThinkingLevelChange(this.thinking)
    }
    this.effectiveLimitOverrides = { ...(defaults.limits ?? {}) }
    const effective = limitsForModel(
      this.resolved?.info ?? {},
      this.effectiveLimitOverrides,
    )
    Object.assign(limits, effective)
    Object.assign(context.limits, effective)
    if (!this.compactionPinned)
      context.autoCompaction = defaults.autoCompaction ?? true
    this.prepared = defaults
  }
}
