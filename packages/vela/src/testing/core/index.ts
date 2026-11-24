/**
 * `vela/testing`: tools for testing Vela and extensions offline.
 * The faux model plays back scripted responses, the faux embedder returns deterministic vectors,
 * createTestVela() assembles a real Vela in a temp directory, and recordModel / replayScenario
 * record and replay real sessions.
 */

export { createMockModel, type DemoModel } from './demo-model.ts'
export {
  createFauxModel,
  type FauxModel,
  type FauxModelOptions,
  type FauxPromptMessage,
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
} from './faux.ts'
export { type Recorder, type RecordOptions, recordModel } from './record.ts'
export { replayScenario } from './replay.ts'
export {
  cleanupTestVelas,
  createTestVela,
  type FixtureSkill,
  type TestVela,
  type TestVelaOptions,
  tempDir,
} from './test-vela.ts'
