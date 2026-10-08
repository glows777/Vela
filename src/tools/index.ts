import {
  createEditFileTool,
  createListDirectoryTool,
  createReadFileTool,
  createWriteFileTool,
} from './file.ts'
import type { ToolDefinition } from './registry.ts'
import { createGlobTool, createGrepTool } from './search.ts'
import { createBashTool } from './shell.ts'

/** Core tools. File, search and bash tools resolve relative paths against cwd (default: process working directory). */
export function createCoreTools({
  cwd,
  bashTimeoutMs,
}: {
  cwd?: string
  bashTimeoutMs?: number
} = {}): ToolDefinition[] {
  return [
    createReadFileTool(cwd),
    createWriteFileTool(cwd),
    createEditFileTool(cwd),
    createListDirectoryTool(cwd),
    createGrepTool(cwd),
    createGlobTool(cwd),
    createBashTool(cwd, { timeoutMs: bashTimeoutMs }),
  ]
}
