import { resolveShellPath } from '../../src/cli/shell.ts'
import { createBashTool } from '../../src/driver/tools/shell.ts'

export function createTestBashTool(cwd?: string) {
  return createBashTool(cwd, { shellPath: resolveShellPath() })
}

export const testBashTool = createTestBashTool()
