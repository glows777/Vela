# Tools

Tools are the functions the model can call. Vela ships seven core tools for files, search and shell, plus `tool_search` for loading deferred tools. Extensions add more (see [Built-in extensions](built-in-extensions.md) and [Extensions](extensions.md)).

Every tool runs inside the Vela process with the operating-system permissions of the user who started it. Permission rules decide which tools a session's model can see and call; they are not a sandbox. See [Security](security.md).

## Core tools

| Tool | Purpose | Annotations |
|---|---|---|
| `read_file` | Read an image, or a text/saved tool result file one page at a time | read-only |
| `write_file` | Create or overwrite a file | destructive, idempotent |
| `edit_file` | Replace one or more exact pieces of text in a file | destructive |
| `list_directory` | List a directory's entries | read-only |
| `grep` | Search file contents with ripgrep | read-only |
| `find` | Find files by glob pattern with fd | read-only |
| `bash` | Run a shell command | destructive, open world |
| `tool_search` | Search deferred tools (such as MCP server tools) by keyword and load the matches | read-only |

The annotations are the tool's `annotations` hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, the same as pi and MCP). Vela does not decide permissions from them; a permission extension can.

The default set is `read_file`, `write_file`, `edit_file` and `bash`, plus `tool_search`. `list_directory`, `grep` and `find` stay registered but off: the model neither sees them nor can call them until a session enables one with `--tools +grep` (or `+grep,+find,+list_directory`) or the [`defaultTools`](settings.md#defaulttools) setting. pi keeps `ls`, `grep` and `find` off in the same way.

Relative paths resolve against the working directory: the directory the CLI was started in, or `cwd` in `createVela()` (default `process.cwd()`). Paths outside it are not blocked.

Compared with pi: Vela's names are `read_file`, `write_file`, `edit_file` and `list_directory` instead of `read`, `write`, `edit` and `ls`; `grep`, `find` and `bash` match pi's. Vela has no `powershell` or `codemode` tool, and `--tools` and `defaultTools` take the same `+name` / `-name` entries as pi's.

### read_file

| Parameter | Type | Default | Description |
|---|---|---|---|
| `path` | string | required | File path |
| `offset` | integer >= 1 | `1` | Line to start from |
| `limit` | integer >= 1 | `2000` | Maximum number of lines |
| `column` | integer >= 0 | `0` | UTF-16 offset within the start line, for continuing a very long line |

JPEG, PNG, GIF, WebP and BMP images are detected by their header and returned whole as image content. The `offset`, `limit` and `column` parameters are ignored for images; they only paginate text.

Non-image PDFs (identified by `%PDF-`), NUL bytes and invalid UTF-8 are rejected with guidance to use bash tools such as `pdftotext` or `unzip -l`. The text pager checks the header and each chunk it reads, including bytes skipped to reach an offset; it does not scan the unread remainder of a large file. UTF-16 and other non-UTF-8 encodings must be converted to UTF-8 first. This is a text guard, not a general file-format detector or native document reader.

For text files, one call returns at most `limit` lines and at most 50KB (UTF-8), the same page size as pi. When more content remains, the result ends with a footer naming the range shown and the exact `path`, `offset`, `column` and `limit` for the next call. At EOF, the result is only the page's file content, preserving any existing trailing newline and adding no footer or separator. The file is read as a stream, so large files are not loaded into memory.

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
- Vela does not filter commands; the built-in `permission-gate` extension (off by default) can confirm or block a few dangerous patterns. See [Security](security.md).

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
| `read_file` | one page (50KB) plus its continuation footer when needed, so a page is never saved again |
| `grep`, `find` | 12,000 |
| `bash` | its own tail preview, see above |
| `web_fetch`, `web_search`, default | 51,200 |
| MCP tools | 20,000 |

When a result is longer than its limit, Vela saves the full result to a file under the session's data directory (`sessions/<id>/tool-results/`) and gives the model a preview instead: the head up to the limit, followed by one line giving the full-output path and explaining that `read_file` with `offset` reads the rest. Bash retains its tail preview and adds a path only when truncated. Complete bash output is plain text with no timestamp or JSON wrapper.

Every call and result is also recorded in a tool history log (JSONL) in the session's directory. The compaction summary keeps one line with the earlier-output snapshot location.

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

A deferred tool is not sent to the model as a tool. Instead, the system prompt names it, with the tool's `searchHint` if it has one, and tells the model to call `tool_search` to load it. Like pi, tools with a `namespace` (`{ name, description?, instructions? }`, for example the tools of one MCP server) are not listed one by one: the namespace gets one line with its tool count and description.

`tool_search` takes these parameters (same as pi):

| Parameter | Type | Description |
|---|---|---|
| `query` | string | Keywords describing the tools needed, or exact tool names separated by commas |
| `limit` | number | Most tools to load (default 8) |

A query of exact tool names loads those tools. Any other query ranks the deferred tools that are not loaded yet with BM25 over their names, descriptions, parameter names and descriptions, and namespace, and loads the best `limit` matches. The result lists the loaded tools with the first line of each description, followed by the `instructions` of each namespace involved (for MCP tools, the server instructions), once per namespace. Loaded tools are declared to the model from its next call and stay loaded for the rest of the session. Loading is per session.

All core tools are direct. Deferred exposure is for extensions that register many tools, so their schemas do not fill the context until needed. See [Extensions](extensions.md).

## Tool access

Every session starts with the default tools; there are no roles (like pi). Change the set for a run with `--tools`, for the CLI's sessions with the `defaultTools` setting, or per session through the SDK; an extension can call `setActiveTools()` on its session. A tool that is off or denied is not sent to the model; if the model calls it anyway, the call is rejected and the rejection is recorded in the tool history. Channel chats share one session and its tools. See [Security](security.md#per-session-permissions).

## Choosing tools per session

`--tools` on the command line and `tools` in the SDK take either an allowlist or a list of `+name` / `-name` entries (like pi):

- A list with plain names enables exactly those tools; every other tool, built-in or from an extension, is off. On the command line the names may be `*` patterns (`read_*`), and `--exclude-tools` then removes names or patterns from the result; the SDK option takes exact names.
- A list of only `+name` / `-name` entries takes exact names, cannot be mixed with plain names, and changes the default set instead, so tools from extensions stay on. `--tools +grep` enables `grep`; `--tools -bash` turns `bash` off.

The `defaultTools` setting takes plain names (`*` patterns work there) and `+name` / `-name` entries, and is described in [Settings](settings.md#defaulttools). With the SDK, pass `tools` and `permissions` (per-tool rules) when opening a session:

```ts
const session = vela.session('review', {
  tools: ['+grep', '+find'],
  permissions: { write_file: 'ask' },
})
```

- `tools` sets the session's tools. `session.setActiveTools(names)` replaces them with an allowlist later, and `session.setActiveTools(undefined)` removes the selection. `session.getActiveTools()` returns the names the model can currently see. If you select tools, include `tool_search` when the session needs deferred tools.
- `permissions` maps a tool name, or `*` for all other tools, to `allow`, `deny` or `ask`. An exact name beats `*`; a tool without a rule is allowed. `ask` calls the session UI's `confirm` before the tool runs; a session without a UI rejects the call.

See [SDK](sdk.md) for the session API and [examples/extensions/read-only-session.ts](../examples/extensions/read-only-session.ts) for an extension that sets the selection per session.

## Image results

`read_file` detects JPEG, PNG, GIF, WebP and BMP by file headers, including images with a text extension. Image reads are bounded at 96 MiB before base64 allocation; normal text pagination is unchanged. Images use the shared 2000px / 4.5 MiB base64 normalizer after tool-result hooks. Invalid images produce an omission reason. A text-only model receives a tool-image omission note while history retains the image for later vision use.

Multimodal results are not folded into base64 text by microcompaction. Large text captions may be previewed with a separate full-caption path; native result details are still recorded in tool history.
