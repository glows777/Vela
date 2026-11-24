# Upgrading to Vela v0.9

Vela v0.9 simplifies configuration, aligns core tool names with `pi`, and removes implicit engine workarounds. Follow this guide when moving from v0.8.

## 1. Unified `config.json`

Vela v0.9 uses a single `<agentDir>/config.json` (plus trusted `<cwd>/.vela/config.json`) instead of separate `settings.json`, `models.json`, and `mcp.json` files. Startup fails fast when any legacy config file exists without `config.json`.

### Key Mapping (`v0.8` → `v0.9`)

| Legacy File & Key | `config.json` Key |
|---|---|
| `settings.json` → `defaultModel` | `model` |
| `settings.json` → `defaultThinkingLevel` | `thinkingLevel` |
| `settings.json` → `defaultTools` | `tools` |
| `settings.json` → `extensionConfig.lark` | `lark` |
| `settings.json` → `extensionConfig.web` | `web` |
| `settings.json` → `extensionConfig.memory` | `memory` |
| `settings.json` → `extensionConfig.local` | `local` |
| `settings.json` → `extensionConfig.channel.eventReceiver` | `webhooks` |
| `settings.json` → `extensionConfig.channel.eventDefaultTarget` | `eventDefaultTarget` |
| `settings.json` → `extensionConfig.mcp.mcpServers` | `mcpServers` |
| `models.json` → `providers` | `providers` |
| `mcp.json` → `mcpServers` | `mcpServers` |

Notes:
- Remove `$schema` if present, and remove `builtin:rag` / `+builtin:rag` / `-builtin:rag` from `extensions`.
- Project `.vela/config.json` files cannot override host-owned keys (`providers`, `lark`, `local`, `webhooks`, `environments`, `location`, `eventDefaultTarget`).
- After merging into `config.json`, archive or delete `settings.json`, `models.json`, and `mcp.json` so Vela stops treating the directory as un-migrated (or keep `config.json` alongside them).

### Prompt to Migrate With an AI Assistant

Paste this prompt into an AI coding assistant if you want it to convert your `~/.vela` directory:

> Inspect `~/.vela/settings.json`, `~/.vela/models.json`, and `~/.vela/mcp.json` (whichever exist) and create `~/.vela/config.json` with `0600` permissions using Vela v0.9 flat keys:
> - Rename `defaultModel` → `model`, `defaultThinkingLevel` → `thinkingLevel`, `defaultTools` → `tools`.
> - Hoist `extensionConfig.{lark,web,memory,local}` to top-level `{lark,web,memory,local}`.
> - Hoist `extensionConfig.channel.eventReceiver` → `webhooks`, and `extensionConfig.channel.eventDefaultTarget` → `eventDefaultTarget`.
> - Merge `extensionConfig.mcp.mcpServers` and `mcp.json`'s `mcpServers` into top-level `mcpServers`.
> - Hoist `models.json`'s `providers` to top-level `providers`.
> - Update any `tools` entries from `read_file`, `write_file`, `edit_file`, `list_directory` to `read`, `write`, `edit`, `ls`.
> - Drop retired keys: `$schema`, `builtin:rag` entries in `extensions`, `bashForegroundTimeoutSeconds`, `bashForegroundTimeoutMaxSeconds`, `limits.microcompactThreshold`, and `limits.minMicroSavings`.
> Do not delete or overwrite existing secrets; keep backups of the old files before removing them.

## 2. Core Tool Renames

Four core built-in tool names match `pi` with zero runtime aliases:

| v0.8 Name | v0.9 Name |
|---|---|
| `read_file` | `read` |
| `write_file` | `write` |
| `edit_file` | `edit` |
| `list_directory` | `ls` |

Update any `--tools` flags, `config.json` `tools` lists (for example `+ls` instead of `+list_directory`), extension `tool_call` / `tool_result` hooks, and custom instructions that name these tools.

## 3. Removed Features & Settings

- **Nested tool execution**: `ctx.executeTool()` and `parentToolCallId` are removed from the extension/tool execution API.
- **Microcompaction**: `limits.microcompactThreshold`, `limits.minMicroSavings`, `ContextEditEntry`, and `'micro'` compaction events are removed; compaction runs cleanly via turn-boundary / overflow summarization.
- **Heuristic loop detection & file write guard**: `loop_detected` / `'loop'` stop reasons and `read`-before-`write` guard errors are removed.
- **Implicit bash backgrounding & shell fallback**: Automatic backgrounding of slow foreground commands and `shell_unavailable` tool-set mutations are removed. Foreground `bash` enforces its explicit `timeout` (default `120s`, max `1800s`) with `SIGTERM` → `SIGKILL`; pass `run_in_background: true` (or press `Ctrl+B` in the TUI) when you want a background job.
- **Removed config keys**: `bashForegroundTimeoutSeconds`, `bashForegroundTimeoutMaxSeconds`, `limits.microcompactThreshold`, `limits.minMicroSavings`.
- **Execution environment access**: Tools that need command execution or environment file access call `ctx.requireEnv()` on demand instead of assuming an eager environment on every tool call.
- **Normalizers & CLI hints**: Legacy content part tags (`reasoning`, `tool-call`, `tool-result`, `image-data`, `image-file-reference`) and `.sessions`/`.memory`/`.usage` CWD move hints are removed from runtime message normalization and CLI startup.
