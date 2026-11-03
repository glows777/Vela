import { resolveShellPath } from '../../../vela/src/cli/shell.ts'
import { createBashTool } from '../../src/tools/shell.ts'

export function createTestBashTool(cwd?: string) {
  return createBashTool(cwd, { shellPath: resolveShellPath() })
}

export const testBashTool = createTestBashTool()
