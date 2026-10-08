import { readFauxScenario } from './faux.ts'
import {
  createTestVela,
  type TestVela,
  type TestVelaOptions,
} from './test-vela.ts'

export interface ReplayResult {
  t: TestVela
  /** 每条输入 prompt() 抛出的错误（没出错的是 undefined），顺序同 inputs */
  errors: unknown[]
}

/**
 * 把录制的场景（`VELA_RECORD=<file>` 录下的 JSON）离线重跑一遍：
 * 用场景里的响应建 faux 模型，按 `inputs` 顺序在默认会话里逐条 prompt。
 * 返回的 `t` 和 createTestVela() 的一样，可以继续断言事件、消息和落盘文件。
 */
export async function replayScenario(
  path: string,
  options: Omit<TestVelaOptions, 'responses' | 'generate' | 'model'> = {},
): Promise<ReplayResult> {
  const scenario = await readFauxScenario(path)
  if (!scenario.inputs?.length)
    throw new Error(`replayScenario: ${path} 没有 inputs，无法重跑`)
  const { inputs, responses, generate, ...fauxOptions } = scenario
  const t = createTestVela({
    ...options,
    responses,
    generate,
    faux: { ...fauxOptions, ...options.faux },
  })
  const errors: unknown[] = []
  for (const input of inputs) {
    errors.push(
      await t.run(input).then(
        () => undefined,
        (error: unknown) => error,
      ),
    )
  }
  return { t, errors }
}
