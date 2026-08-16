import {
  editFileTool,
  listDirectoryTool,
  readFileTool,
  writeFileTool,
} from "./file"
import type { ToolDefinition } from "./registry"
import { globTool, grepTool } from "./search"
import { bashTool } from "./shell"
import { pickSearchTool, webFetchTool } from "./web"

export const allTools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirectoryTool,
  grepTool,
  globTool,
  bashTool,
  webFetchTool,
  pickSearchTool(),
]
