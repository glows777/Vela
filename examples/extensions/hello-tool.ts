/**
 * registerTool: give the model a new tool. It is shared by all sessions and the model can call it directly.
 * The tool name the model sees is prefixed with the extension name: `hello-tool_greet` when the CLI loads
 * this file (named after the file), `hello_greet` when passed to createVela() (named after the function).
 */
import type { VelaExtension } from '@glows777/vela'
import { z } from 'zod'

const hello: VelaExtension = (vela) => {
  vela.registerTool({
    name: 'greet',
    description: 'Say hello to someone',
    inputSchema: z.object({ name: z.string().describe('Name') }),
    isReadOnly: true,
    execute: async ({ name }: { name: string }) => `Hello, ${name}!`,
  })
}

export default hello
