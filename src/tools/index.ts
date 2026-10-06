import {
  createEditFileTool,
  createListDirectoryTool,
  createReadFileTool,
  createWriteFileTool,
} from './file'
import type { ToolDefinition } from './registry'
import { createGlobTool, createGrepTool } from './search'
import { createBashTool } from './shell'
import { pickSearchTool, webFetchTool } from './web'

/** 核心工具集合；文件、搜索和 bash 工具的相对路径按 cwd 解析（默认进程工作目录）。 */
export function createCoreTools({
  cwd,
}: {
  cwd?: string
} = {}): ToolDefinition[] {
  return [
    createReadFileTool(cwd),
    createWriteFileTool(cwd),
    createEditFileTool(cwd),
    createListDirectoryTool(cwd),
    createGrepTool(cwd),
    createGlobTool(cwd),
    createBashTool(cwd),
    webFetchTool,
    pickSearchTool(),
  ]
}

export const allTools: ToolDefinition[] = createCoreTools()
