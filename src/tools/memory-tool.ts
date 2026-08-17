import z from "zod"
import type { MemoryStore } from "../memory"
import type { ToolDefinition } from "./registry"

const memoryToolParamSchema = z
  .object({
    action: z
      .enum(["save", "list", "search", "read", "delete"])
      .describe("Memory operation"),
    name: z.string().optional().describe("Memory name (required for save)"),
    description: z
      .string()
      .optional()
      .describe("One-sentence description (required for save)"),
    type: z.enum(["user", "feedback", "project", "reference"]).optional(),
    content: z
      .string()
      .optional()
      .describe("Memory content (required for save)"),
    query: z
      .string()
      .optional()
      .describe("Search keywords (required for search)"),
    filename: z
      .string()
      .optional()
      .describe(
        "Actual filename (required for read/delete; includes the type prefix and .md suffix). Do not provide the memory name/logical name. For example, user_favorite_language maps to user_user-favorite-language.md",
      ),
  })
  .strict()

export function createMemoryTool(memoryStore: MemoryStore): ToolDefinition {
  return {
    name: "memory",
    description:
      "Manage cross-session memories. name is the logical memory name, while filename is the actual filename on disk. read and delete require the complete filename (including the type prefix and .md suffix), not name. For example, name=user_favorite_language maps to filename=user_user-favorite-language.md. Actions: save | list | search | read | delete",
    inputSchema: memoryToolParamSchema,
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async (args: z.infer<typeof memoryToolParamSchema>) => {
      switch (args.action) {
        case "save": {
          if (!args.name || !args.type || !args.content) {
            return "Save failed: name, type, and content are required"
          }
          const filename = memoryStore.save({
            name: args.name,
            description: args.description || args.name,
            type: args.type,
            content: args.content,
          })
          return `Saved to memory: ${filename}`
        }
        case "list": {
          const entries = memoryStore.list()
          if (entries.length === 0) return "No memories are currently stored."
          return (
            `Memory list (${entries.length} memories):\n` +
            entries
              .map((e) => `  [${e.type}] ${e.name} — ${e.description}`)
              .join("\n")
          )
        }
        case "search": {
          const results = memoryStore.search(args.query || "")
          if (results.length === 0)
            return `No memories found matching "${args.query}".`
          return (
            `Search results (${results.length} matches):\n` +
            results
              .map((e) => `  [${e.type}] ${e.name} — ${e.description}`)
              .join("\n")
          )
        }
        case "read": {
          if (!args.filename) return "Read failed: filename is required"
          const content = memoryStore.loadFile(args.filename)
          if (content === null) return `Memory file not found: ${args.filename}`
          return content
        }
        case "delete": {
          if (!args.filename) return "Delete failed: filename is required"
          const ok = memoryStore.delete(args.filename)
          return ok
            ? `Memory deleted: ${args.filename}`
            : `Memory file not found: ${args.filename}`
        }
        default:
          return "Unknown action"
      }
    },
  }
}
