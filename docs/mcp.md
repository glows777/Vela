# MCP servers

Vela connects to [Model Context Protocol](https://modelcontextprotocol.io) servers over stdio or streamable HTTP and makes their tools available to the model. Support comes from the built-in `mcp` extension, modeled on pi's: it loads by default in the CLI, `-builtin:mcp` in `extensions` turns it off, and an SDK app adds `mcp()` itself (see [SDK](#sdk)). The client is the official MCP TypeScript SDK.

## Configure servers

Vela reads servers from `~/.vela/mcp.json` and, when the project is [trusted](settings.md#project-trust), from the project's `.vela/mcp.json`. The format is the `mcpServers` object of Claude Desktop, Claude Code and pi, so an existing entry can be copied over:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "description": "Search and read the product documentation"
    }
  }
}
```

A project entry replaces the user entry of the same name. A project entry without `command`, `url` or `type` only overrides `enabled`, `exposure` and `toolExposure` of the user entry and keeps the rest, so this turns off a user-level server in one project:

```json
{ "mcpServers": { "internal-tools": { "enabled": false } } }
```

Keep servers with credentials in the user file, and use the project file only for servers the project needs.

| Field | Servers | Description |
|---|---|---|
| `command`, `args` | stdio | One executable and its arguments, not a shell command line. A leading `~/` names the home directory |
| `env` | stdio | Extra environment variables. The server also inherits Vela's environment, as `bash` does |
| `cwd` | stdio | Working directory, relative to Vela's working folder (default: the working folder) |
| `url` | HTTP | The streamable HTTP endpoint |
| `headers` | HTTP | Request headers, for example `Authorization` |
| `type` | both | Optional: `stdio`, `http` or `streamable-http`. A `command` means stdio and a `url` means HTTP |
| `timeout` | both | Seconds to wait for a request (default 60). Progress notifications from the server restart it |
| `enabled` | both | `false` keeps the entry without connecting |
| `exposure`, `toolExposure` | both | How the model reaches the tools (see [Tool exposure](#tool-exposure)) |
| `description` | both | What the server offers, in a sentence. It is shown with the server in the system prompt and searched by `tool_search`. Default: the first line of the server's instructions |

Rules, the same as pi's:

- Server names may contain only letters, digits, `_` and `-`. Names that differ only in `-` and `_` are the same server, and the second one is an error.
- `${NAME}` and `$NAME` in `command`, `args`, `cwd`, `url`, `env` and `headers` are replaced with environment variables (`$$` is a literal `$`). Unlike in `settings.json`, a variable that is not set is an error for that server instead of an empty string.
- The legacy SSE transport is not supported. Servers that offer SSE usually also offer streamable HTTP, often at `/mcp` instead of `/sse`.
- An invalid entry is reported and skipped; the other servers still connect.
- `exposure: "codemode"` is rejected for now: Vela has no codemode yet.
- OAuth sign-in is not supported yet. For a server that needs it, put a token in an `Authorization` header if the server accepts one.

## Connections

One set of connections serves all sessions of a Vela: a Feishu bot with many conversations starts each stdio server once. (pi connects per session; Vela runs many sessions at once.) Servers connect in the background when the first session starts and close when the Vela is disposed; closing a stdio server closes its stdin, then sends SIGTERM, then SIGKILL.

- The first prompt waits up to 10 seconds only for servers with `direct` tools, which must be in its request. A server still connecting is named in the system prompt, and `tool_search` waits for every server before it searches.
- Connecting to an HTTP server is retried twice after a network error or a 408, 429 or 5xx status. Tool calls are never retried, because the server may already have acted.
- When a connection drops (for example the stdio process exits), the next call to one of its tools connects again.
- When a server announces that its tool list changed, new tools are registered and removed tools are unregistered.
- Configuration errors and servers that failed to connect are reported once, after startup: in interactive mode as a message, otherwise on stderr. The error includes the end of a stdio server's stderr.

`/mcp` lists each server with its state, tool count, exposure and the file that configured it, plus any connection error. `/mcp reconnect <server>` drops a server's connection and connects again, for example after you restarted it.

## Tool exposure

Each tool is registered as `mcp__<server>__<tool>`, with every character other than letters, digits and `_` replaced by `_`; names longer than 64 characters, or two tools whose names become the same, get a hash suffix. Its [namespace](tools.md#deferred-tools-and-tool_search) is `mcp__<server>`, and the server's instructions are the namespace instructions.

| `exposure` | What the model gets |
|---|---|
| `deferred` (default) | The system prompt names the server with its tool count and description. The model loads tools with `tool_search`, which returns the server instructions with them |
| `direct` | The tools are declared to the model like built-in tools. Use it for small, often-used servers |
| `hidden` | Registered but unreachable |

`toolExposure` overrides the server's exposure for single tools. Keys are the server's own tool names, or patterns where `*` matches anything; an exact name wins over patterns, and among patterns the first match wins:

```json
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" },
      "exposure": "deferred",
      "toolExposure": { "search_code": "direct", "delete_*": "hidden" }
    }
  }
}
```

pi's default is `codemode`, where the model writes a script that calls the tools. Vela will follow once it has codemode; until then `deferred` keeps large servers out of the context until they are needed.

## Results

Text content reaches the model as text. Vela tool results are text only, so images, audio and binary resources become a one-line placeholder with their type and size; embedded text resources are shown in full, and resource links show their URI, name and description. A result without content blocks shows its `structuredContent` as JSON. A result with `isError` is an error result for the model. Text longer than 20,000 characters is saved to a file and the model gets the beginning and end with the file's path, like other large tool results (see [Tools](tools.md#result-size-and-truncation)). The tool history keeps the whole `CallToolResult`. Progress notifications become `tool_execution_update` events.

## Permissions

MCP tools go through the same pipeline as every tool: the session's role and permissions, extensions' `tool_call` and `tool_result` handlers, confirmation for `ask`, and the tool history. The server's `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint` annotations are on each tool's `annotations` for permission extensions to use; Vela itself does not act on them.

`owner` and `collaborator` sessions can use MCP tools. `guest` sessions, such as channel senders, cannot: the tools are not listed, `tool_search` does not find them, and a call is rejected. See [Security](security.md#session-roles).

An MCP server runs with your permissions (stdio) or acts with the credentials you give it (HTTP), and its tool descriptions and results are text the model reads. Add only servers you trust.

## SDK

`createVela()` loads no extensions by default. Pass `mcp()` with the servers in the same format; the SDK does not read `mcp.json`:

```ts
import { createVela, mcp } from '@glows777/vela'

const vela = createVela({
  model: 'anthropic/<model-id>',
  extensions: [
    mcp({
      servers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        },
      },
    }),
  ],
})
```

Without `servers`, `mcp()` reads `mcpServers` from `extensionConfig.mcp`. Values are used as given: resolve any environment variables yourself. Call `await vela.dispose()` to close the connections and stop stdio servers.

## Not supported yet

OAuth sign-in, MCP resources (`list_mcp_resources`, `read_mcp_resource`), `vela mcp add/list` shell commands, registering servers from other extensions, and codemode. pi has all of these.
