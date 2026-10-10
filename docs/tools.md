# Tools

Tools are the functions the model can call. Vela ships seven core tools for files, search and shell, plus `tool_search` for loading deferred tools. Extensions add more (see [Built-in extensions](built-in-extensions.md) and [Extensions](extensions.md)).

Every tool runs inside the Vela process with the operating-system permissions of the user who started it. Roles and permission rules decide which tools a session's model can see and call; they are not a sandbox. See [Security](security.md).

## Core tools

| Tool | Purpose | Annotations |
|---|---|---|
| `read_file` | Read a text file, or a saved tool result, one page at a time | read-only |
| `write_file` | Create or overwrite a file | destructive, idempotent |
| `edit_file` | Replace one or more exact pieces of text in a file | destructive |
| `list_directory` | List a directory's entries | read-only |
| `grep` | Search file contents with ripgrep | read-only |
| `find` | Find files by glob pattern with fd | read-only |
| `bash` | Run a shell command | destructive, open world |
| `tool_search` | Load the schema of a deferred tool | read-only |

The annotations are the tool's `annotations` hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, the same as pi and MCP). Vela does not decide permissions from them; a permission extension can.

Relative paths resolve against the working directory: the directory the CLI was started in, or `cwd` in `createVela()` (default `process.cwd()`). Paths outside it are not blocked.

Compared with pi: Vela's names are `read_file`, `write_file`, `edit_file` and `list_directory` instead of `read`, `write`, `edit` and `ls`; `grep`, `find` and `bash` match pi's. All core tools are enabled by default, and there is no `--tools` flag, `powershell` tool, `codemode` or image reading.

### read_file

| Parameter | Type | Default | Description |
|---|---|---|---|
| `path` | string | required | File path |
| `offset` | integer >= 1 | `1` | Line to start from |
| `limit` | integer >= 1 | `2000` | Maximum number of lines |
| `column` | integer >= 0 | `0` | UTF-16 offset within the start line, for continuing a very long line |

One call returns at most `limit` lines and at most 50KB (UTF-8), the same page size as pi. The result ends with a footer naming the range shown and either `EOF: no more content.` or the exact `offset`, `column` and `limit` for the next call. The file is read as a stream, so large files are not loaded into memory.

### write_file

| Parameter | Type | Description |
|---|---|---|
| `path` | string | File path |
| `content` | string | Full file content |

Replaces the whole file and creates missing parent directories.

### edit_file

| Parameter | Type | Description |
|---|---|---|
| `path` | string | File path |
| `edits` | `{ oldText, newText }[]` | One or more replacements. `newText` is written literally (`$&`, `$1` and `$$` are not special) |

The parameters and matching are the same as pi's `edit` tool:

- Every `oldText` is matched against the original file, not after the earlier edits, and must match exactly one place. Edits must not overlap.
- A byte order mark and CRLF line endings are ignored while matching and kept when writing.
- When `oldText` does not match exactly, a fuzzy match is tried that ignores trailing whitespace, Unicode normalization (NFKC), smart quotes, Unicode dashes and special spaces. Only the lines the match touches are rewritten; the rest of the file keeps its original bytes.
- When an `oldText` is not found, is found more than once, overlaps another edit, or the edits change nothing, the call fails with an error and the file is left unchanged. A missing file is an error too.
- Arguments that some models send in the wrong shape (`edits` as a JSON string, a single edit object, or top-level `oldText` / `newText`) are rewritten into `edits[]` before validation.

The model gets `Successfully replaced N block(s) in <path>.`. The diff (with line numbers), a unified patch and the first changed line are kept in the tool history, not sent to the model.

### list_directory

| Parameter | Type | Default | Description |
|---|---|---|---|
| `path` | string | working directory | Directory to list |

Returns one line per entry, `[DIR] name` or `[FILE] name`. It does not recurse.

### grep

Runs [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`).

| Parameter | Type | Default | Description |
|---|---|---|---|
| `pattern` | string | required | Regular expression, or a literal string with `literal` |
| `path` | string | working directory | Directory or file to search |
| `glob` | string | | Only search files matching this glob, for example `*.ts` or `**/*.spec.ts` |
| `ignoreCase` | boolean | `false` | Case-insensitive search |
| `literal` | boolean | `false` | Treat `pattern` as a literal string |
| `context` | number | `0` | Lines to show before and after each match |
| `limit` | number | `100` | Maximum number of matches |

Each match is printed as `path:line: text`; context lines use `path-line- text`. Paths are relative to the search directory. Lines longer than 500 characters are cut, with a notice telling the model to use `read_file`. When the limit is hit, rg is stopped and the result ends with a notice suggesting a larger `limit` or a narrower pattern.

grep respects `.gitignore`, searches hidden files, and skips `.git/`. An invalid regular expression or a missing path is returned as an error.

### find

Runs [fd](https://github.com/sharkdp/fd) with `--glob`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `pattern` | string | required | Glob, for example `*.ts`, `**/*.json` or `src/**/*.spec.ts` |
| `path` | string | working directory | Directory to search |
| `limit` | number | `1000` | Maximum number of results |

Returns one path per line, relative to the search directory; directories end with `/`. A pattern without `/` matches file names anywhere below `path`; a pattern with `/` matches the path. find respects `.gitignore` (also outside a git repository) and includes hidden files.

### Where rg and fd come from

grep and find need the `rg` and `fd` programs. They are looked up in this order:

1. The bin directory: `~/.vela/bin` in the CLI (under `VELA_DIR` if set).
2. `PATH` (for fd, also `fdfind`, the name Debian and Ubuntu use).
3. Download: the CLI downloads the latest release for your platform from GitHub (fd is pinned to 10.3.0 on Intel macOS, its last release with an Intel macOS binary) into `~/.vela/bin` the first time a search tool needs it.

Set `VELA_OFFLINE=1` to turn off the download; the tool then fails with an error that says how to install the program (`brew install ripgrep fd`, or `apt install ripgrep fd-find`).

With the SDK, pass `binDir` to enable the same lookup and download, and `offline` to turn off the download:

```ts
import { createVela } from '@glows777/vela'

const vela = createVela({ binDir: '/opt/my-app/bin', offline: false })
```

Without `binDir`, only `PATH` is searched and nothing is downloaded.

### bash

| Parameter | Type | Description |
|---|---|---|
| `command` | string | Shell command |
| `timeout` | number | Optional timeout in seconds. There is no default timeout |

Runs `bash -lc <command>` in the working directory (set `shellPath` in [settings](settings.md) or `createVela({ shellPath })` to use another shell; a path that does not exist is an error). stdout and stderr are combined and written to a file in the session's tool results directory as the command runs. Like pi, the model gets the last 2,000 lines or 50KB of output, whichever is smaller; when that cuts the output, a line names the full output file, which can be read with `read_file`. A non-zero exit ends the preview with `Command exited with code N`, a timeout with `Command timed out after N seconds`, and an abort with `Command aborted`; like pi, these three are error results (`isError: true`), with the preview as the error text. While the command runs, the tail of its output is sent as `tool_execution_update` events (`partialResult` is `{ content: [{ type: 'text', text }] }`, at most every 100ms and only when the output grew).

- Timeout: none by default, as in pi; the model passes `timeout` for commands that may hang. On timeout or abort the whole process group is killed.
- Before running, every command goes through a classifier: dangerous commands are rejected, and moderate-risk commands run but emit a `security_warning` event. See [Security](security.md).
- A post-tool hook prefixes the output with an ISO timestamp.

## How tools run

### Concurrency

The model can request several tool calls in one response. As in pi, they run in parallel by default:

- `write_file` and `edit_file` queue per file (resolved through symlinks): two writes to the same file run one after the other, writes to different files run at the same time. The queue is shared by every session in the process.
- `bash` and the read-only tools take no lock.
- A tool with `executionMode: 'sequential'` runs alone within its session: it waits for the session's calls that started before it, and calls that start after it wait for it. Other sessions are not affected. The built-in `memory` and `rag_ingest` tools are sequential.

Permission checks, hooks and confirmation prompts run before a call waits for anything, so a tool waiting for approval does not hold back other tools.

### Result size and truncation

Each tool has a result limit in characters:

| Tool | Limit |
|---|---|
| `read_file` | one page (50KB) plus its footer, so a page is never saved again |
| `grep`, `find` | 12,000 |
| `bash` | its own tail preview, see above |
| everything else | 3,000 (default) |

When a result is longer than its limit, Vela saves the full result to a file under the session's data directory (`sessions/<id>/tool-results/`) and gives the model a preview instead: the first 60% and last 40% of the limit, joined by a line that says how much was omitted and that the full output was saved. The model can read the file with `read_file`.

Every call and result is also recorded in a tool history log (JSONL) in the session's directory. The system prompt tells the model where the log is and how to query it, so it can find an earlier result after compaction.

### Microcompaction

When a long session's estimated input reaches `limits.microcompactThreshold`, Vela replaces older results of the core file, search and bash tools with a short reference to the saved file, and summarizes older history if that is not enough. See [Sessions](sessions.md#compaction).

## Deferred tools and tool_search

A tool definition's `exposure` decides where the tool shows up. The values and their meaning are pi's:

| `exposure` | Sent to the model | Found by `tool_search` | Callable with `ctx.executeTool()` |
|---|---|---|---|
| `direct` (default) | yes | yes | yes |
| `model-only` | yes | yes | no |
| `deferred` | after `tool_search` loads it | yes | yes |
| `codemode` | no | no | yes |
| `hidden` | no | no | no |

Vela has no codemode tool yet, so a `codemode` tool can only be run by other tools through `ctx.executeTool()`. A `hidden` tool stays registered but unused, for example while it is turned off.

A deferred tool is not sent to the model as a tool. Instead, the system prompt lists its name, with the tool's `searchHint` if it has one, and tells the model to call `tool_search` first. Tools with the same `namespace` (`{ name, description?, instructions? }`, for example the tools of one MCP server) are listed together under the namespace's name and description.

`tool_search` takes one parameter:

| Parameter | Type | Description |
|---|---|---|
| `query` | string | A tool name, or several separated by commas |

It matches exact tool names (it is not a fuzzy search), returns each tool's name, description, input schema and `namespace` (with its `instructions`), and makes the tool available to the model for the rest of the session. Discovery is per session.

All core tools are direct. Deferred exposure is for extensions that register many tools, so their schemas do not fill the context until needed. See [Extensions](extensions.md).

## Roles and tool access

Every session has a role (`owner`, `collaborator` or `guest`) that decides which tools the model sees: an owner gets all tools, a collaborator all but `bash`, and a guest only `tool_search`, `rag_search` and `web_search`. CLI sessions are `owner`, and channel senders are `guest` unless the channel says otherwise. A tool the role denies is not sent to the model; if the model calls it anyway, the call is rejected and the rejection is recorded in the tool history. The full rules are in [Security](security.md#session-roles).

## Choosing tools per session (SDK)

The CLI has no flag to select tools. With the SDK, pass `tools` (an allowlist) and `permissions` (rules layered over the role) when opening a session:

```ts
const session = vela.session('review', {
  role: 'collaborator',
  tools: ['read_file', 'list_directory', 'grep', 'find'],
  permissions: { write_file: 'ask' },
})
```

- `tools` limits the session to the named tools; the role still applies. `session.setActiveTools(names)` changes the selection later, and `session.setActiveTools(undefined)` removes it. `session.getActiveTools()` returns the names the model can currently see. If you select tools, include `tool_search` when the session needs deferred tools.
- `permissions` maps a tool name, or `*` for all other tools, to `allow`, `deny` or `ask`. An exact name beats `*`. The role is the upper bound: session rules can only make a tool stricter (`allow` → `ask` → `deny`), never allow a tool the role forbids. `ask` calls the session UI's `confirm` before the tool runs; a session without a UI rejects the call.

See [SDK](sdk.md) for the session API and [examples/extensions/read-only-session.ts](../examples/extensions/read-only-session.ts) for an extension that sets the selection per session.
