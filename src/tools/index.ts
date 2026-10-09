import type { BinaryResolver } from './binaries.ts'
import {
  createEditFileTool,
  createListDirectoryTool,
  createReadFileTool,
  createWriteFileTool,
} from './file.ts'
import type { ToolDefinition } from './registry.ts'
import { createFindTool, createGrepTool } from './search.ts'
import { createBashTool } from './shell.ts'

/** Core tools. File, search and bash tools resolve relative paths against cwd (default: process working directory). */
export function createCoreTools({
  cwd,
  bashTimeoutMs,
  resolveBinary,
}: {
  cwd?: string
  bashTimeoutMs?: number
  /** Finds ripgrep / fd for grep / find (default: PATH only) */
  resolveBinary?: BinaryResolver
} = {}): ToolDefinition[] {
  return [
    createReadFileTool(cwd),
    createWriteFileTool(cwd),
    createEditFileTool(cwd),
    createListDirectoryTool(cwd),
    createGrepTool(cwd, resolveBinary),
    createFindTool(cwd, resolveBinary),
    createBashTool(cwd, { timeoutMs: bashTimeoutMs }),
  ]
}
