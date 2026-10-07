/**
 * `vela/testing`：离线测试 Vela 和扩展用的工具。
 * faux 模型按脚本回放响应，faux embedder 给出确定性的向量，
 * createTestVela() 在临时目录里装配一个真实的 Vela，recordModel / replayScenario 录制和重跑真实会话。
 */

export {
  createFauxModel,
  type FauxModel,
  type FauxModelOptions,
  type FauxRequest,
  type FauxResponse,
  type FauxScenario,
  type FauxStep,
  type FauxToolCall,
  type FauxUsage,
  fauxError,
  fauxHang,
  fauxStreamError,
  fauxSummary,
  fauxText,
  fauxToolCall,
  loadFauxScenario,
  readFauxScenario,
} from './faux'
export { createFauxEmbedder } from './faux-embedder'
export { type Recorder, type RecordOptions, recordModel } from './record'
export { type ReplayResult, replayScenario } from './replay'
export {
  cleanupTestVelas,
  createTestVela,
  type FixtureSkill,
  type TestVela,
  type TestVelaOptions,
  tempDir,
} from './test-vela'
