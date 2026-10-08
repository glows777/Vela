/**
 * registerTool: give the model a new tool. It is shared by all sessions and the model can call it directly.
 * The tool name the model sees is prefixed with the extension name: here, `hello_greet`.
 */
import type { VelaExtension } from '@glows777/vela'
import { z } from 'zod'

const hello: VelaExtension = (vela) => {
  vela.registerTool({
    name: 'greet',
    description: 'Say hello to someone',
    inputSchema: z.object({ name: z.string().describe('Name') }),
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ name }: { name: string }) => `Hello, ${name}!`,
  })
}

export default hello
