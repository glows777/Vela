import type { ToolDefinition } from "./registry";
import { pickSearchTool, webFetchTool } from "./web";
import {
  editFileTool,
  listDirectoryTool,
  readFileTool,
  writeFileTool,
} from "./file";
import { bashTool } from "./shell";
import { globTool, grepTool } from "./search";

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
];
