/**
 * `vela/testing`: tools for testing Vela and extensions offline.
 * The faux model plays back scripted responses, the faux embedder returns deterministic vectors,
 * createTestVela() assembles a real Vela in a temp directory, and recordModel / replayScenario
 * record and replay real sessions.
 */

export { type ReplayResult, replayScenario } from './core-replay.ts'
export {
  cleanupTestVelas,
  createTestVela,
  type FixtureSkill,
  type TestVela,
  type TestVelaOptions,
  tempDir,
} from './core-vela.ts'
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
} from './faux.ts'
export { createFauxEmbedder } from './faux-embedder.ts'
export { type Recorder, type RecordOptions, recordModel } from './record.ts'
