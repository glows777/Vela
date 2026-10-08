/**
 * registerTool：给模型加一个工具。所有会话共享，模型直接能调用。
 * 模型看到的工具名带扩展名前缀：这里是 `hello_greet`。
 */
import type { VelaExtension } from '@glows777/vela'
import { z } from 'zod'

const hello: VelaExtension = (vela) => {
  vela.registerTool({
    name: 'greet',
    description: '向某人问好',
    inputSchema: z.object({ name: z.string().describe('名字') }),
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ name }: { name: string }) => `你好，${name}！`,
  })
}

export default hello
