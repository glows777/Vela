import type { BinaryResolver } from './binaries.ts'
import {
  createEditFileTool,
  createListDirectoryTool,
  createReadFileTool,
  createWriteFileTool,
} from './file.ts'
import type { ToolContext, ToolDefinition } from './registry.ts'
import { createFindTool, createGrepTool } from './search.ts'
import { createBashTool } from './shell.ts'

/** Core tools. File, search and bash tools resolve relative paths against cwd (default: process working directory). */
export function createCoreTools({
  cwd,
  shellPath,
  resolveBinary,
  resolveCwd,
}: {
  cwd?: string
  /** Shell for the bash tool (settings `shellPath`); default bash on PATH */
  shellPath?: string
  /** Finds ripgrep / fd for grep / find (default: PATH only) */
  resolveBinary?: BinaryResolver
  /** Resolve the invoking session's cwd without changing shared tool definitions. */
  resolveCwd?: (context?: ToolContext) => string
} = {}): ToolDefinition[] {
  const factories = [
    createReadFileTool,
    createWriteFileTool,
    createEditFileTool,
    createListDirectoryTool,
    (dir?: string) => createGrepTool(dir, resolveBinary),
    (dir?: string) => createFindTool(dir, resolveBinary),
    (dir?: string) => createBashTool(dir, { shellPath }),
  ]
  return factories.map((create) => {
    const tool = create(cwd)
    return resolveCwd
      ? {
          ...tool,
          execute: (args, context) =>
            create(resolveCwd(context)).execute(args, context),
        }
      : tool
  })
}
