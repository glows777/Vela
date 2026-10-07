/**
 * Vela SDK 的公开入口（`import { createVela } from 'vela'`）。
 * 只从这里 export；CLI 在 src/cli/main.ts，测试工具在 'vela/testing'。
 * 先只导出已有使用场景的部分；扩展 API 和公开面快照测试在第 1b 步一起定。
 */

export type {
  VelaEvent,
  VelaEventListener,
  VelaSessionEventListener,
} from './agent/events'
export type { VelaLimits } from './limits'
export { silentLogger, type VelaLogger } from './logger'
export { createEmbedder, type EmbeddingFn } from './rag/embedder'
export type { ToolDefinition } from './tools/registry'
export type { TokenStatus, UsageTotals } from './usage/tracker'
export { createVela, type Vela, type VelaOptions } from './vela'
export { type PromptOptions, VelaSession } from './vela-session'
