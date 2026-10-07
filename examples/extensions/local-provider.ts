/**
 * registerProvider：加一个模型 provider，之后 `local/<模型>` 可以用在 `--model`、`/model`、
 * `session.setModel()`。这里把本机的 Ollama（OpenAI 兼容接口）接进来；
 * 只是换地址和 key 的话也可以直接写 ~/.vela/models.json，不用扩展。
 */
import { createOpenAI } from '@ai-sdk/openai'
import type { VelaExtension } from 'vela'

const localProvider: VelaExtension = (vela) => {
  const baseURL =
    typeof vela.config.baseUrl === 'string'
      ? vela.config.baseUrl
      : 'http://localhost:11434/v1'
  const ollama = createOpenAI({ baseURL, apiKey: 'ollama', name: 'local' })
  vela.registerProvider('local', {
    // 列出的模型带元数据（上下文窗口决定压缩阈值）；没列出的 id 也能用
    models: [{ id: 'qwen3:8b', contextWindow: 40_960 }],
    createModel: (id) => ollama.chat(id),
  })
}

export default localProvider
