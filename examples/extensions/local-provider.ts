/**
 * registerProvider: add a model provider. Afterwards `local/<model>` works with `--model`, `/model`
 * and `session.setModel()`. This example connects a local Ollama (OpenAI-compatible API).
 * If you only need a different URL and key, edit ~/.vela/models.json instead; no extension needed.
 */
import { createOpenAI } from '@ai-sdk/openai'
import type { VelaExtension } from '@glows777/vela'

const localProvider: VelaExtension = (vela) => {
  const baseURL =
    typeof vela.config.baseUrl === 'string'
      ? vela.config.baseUrl
      : 'http://localhost:11434/v1'
  const ollama = createOpenAI({ baseURL, apiKey: 'ollama', name: 'local' })
  vela.registerProvider('local', {
    // Listed models carry metadata (the context window sets the compaction threshold); unlisted ids still work
    models: [{ id: 'qwen3:8b', contextWindow: 40_960 }],
    createModel: (id) => ollama.chat(id),
  })
}

export default localProvider
