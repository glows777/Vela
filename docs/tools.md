# Tools

Tools are the functions the model can call. Vela ships seven core tools for files, search and shell, plus `tool_search` for loading deferred tools. Extensions add more (see [Built-in extensions](built-in-extensions.md) and [Extensions](extensions.md)).

Every tool runs inside the Vela process with the operating-system permissions of the user who started it. The session's `tools` selection decides which tools its model can see and call; it is not a sandbox. See [Security](security.md).

## Core tools

| Tool | Purpose | Annotations |
|---|---|---|
| `read` | Read an image, or a text/saved tool result file one page at a time | read-only |
| `write` | Create or overwrite a file | destructive, idempotent |
| `edit` | Replace one or more exact pieces of text in a file | destructive |
| `ls` | List a directory's entries | read-only |
| `grep` | Search file contents with ripgrep | read-only |
| `find` | Find files by glob pattern with fd | read-only |
| `bash` | Run a shell command | destructive, open world |
| `tool_search` | Search deferred tools (such as MCP server tools) by keyword and load the matches | read-only |

The annotations are the tool's `annotations` hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, the same as pi and MCP). Vela does not enforce these hints; a user extension can inspect them.

Each core tool also contributes its own line and rules to the system prompt: `promptSnippet` supplies the `- name: what it does` line in `<tools>`, and `promptGuidelines` supplies rules in `<rules>` (for example "Read a file before you change it." from `edit`). The builder reads the session's active tools, so a tool the session does not have — `grep` until `+grep` enables it, or `bash` in a top-level group chat — contributes neither. Extensions set the same two fields. See [The system prompt](settings.md#the-system-prompt).

The default set is `read`, `write`, `edit` and `bash`, plus `tool_search`. `ls`, `grep` and `find` stay registered but off: the model neither sees them nor can call them until a session enables one with `--tools +grep` (or `+grep,+find,+ls`) or the [`tools`](settings.md#tools) setting. pi keeps `ls`, `grep` and `find` off in the same way.

Relative paths resolve against the session's working directory (`project.cwd` in `createRuntime()` or `runtime.sessions.configure(id, { cwd })`, defaulting to `<agentDir>`). Paths outside it are not blocked.

Compared with pi: Vela's core tool names (`read`, `write`, `edit`, `ls`, `grep`, `find`, `bash`) match pi's. Vela has no `powershell` or `codemode` tool, and `--tools` and `tools` in `config.json` take the same `+name` / `-name` entries as pi's.

### read

| Parameter | Type | Default | Description |
|---|---|---|---|
| `path` | string | required | File path |
| `offset` | integer >= 1 | `1` | Line to start from |
| `limit` | integer >= 1 | `2000` | Maximum number of lines |
| `column` | integer >= 0 | `0` | UTF-16 offset within the start line, for continuing a very long line |

JPEG, PNG, GIF, WebP and BMP images are detected by their header and returned whole as image content. The `offset`, `limit` and `column` parameters are ignored for images; they only paginate text.

Non-image PDFs (identified by `%PDF-`), NUL bytes and invalid UTF-8 are rejected with guidance to use bash tools such as `pdftotext` or `unzip -l`. The text pager checks the header and each chunk it reads, including bytes skipped to reach an offset; it does not scan the unread remainder of a large file. UTF-16 and other non-UTF-8 encodings must be converted to UTF-8 first. This is a text guard, not a general file-format detector or native document reader.

For text files, one call returns at most `limit` lines and at most 50KB (UTF-8), the same page size as pi. When more content remains, the result ends with a footer naming the range shown and the exact `path`, `offset`, `column` and `limit` for the next call. At EOF, the result is only the page's file content, preserving any existing trailing newline and adding no footer or separator. The file is read as a stream, so large files are not loaded into memory.

### write

| Parameter | Type | Description |
|---|---|---|
| `path` | string | File path |
| `content` | string | Full file content |

Replaces the whole file and creates missing parent directories. For surgical changes to an existing file, prefer `edit`.

### edit

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

### ls

| Parameter | Type | Default | Description |
|---|---|---|---|
| `path` | string | working directory | Directory to list |

Returns sorted entries, one per line (`name/` for directories and symlinks to directories, `name` for files). It does not recurse.

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

Each match is printed as `path:line: text`; context lines use `path-line- text`. Paths are relative to the search directory. Lines longer than 500 characters are cut, with a notice telling the model to use `read`. When the limit is hit, rg is stopped and the result ends with a notice suggesting a larger `limit` or a narrower pattern.

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

With the SDK, `VELA_OFFLINE=1` or `offline: true` disables automatic downloads; pass `offline: false` in `createRuntime()` when managed downloads are desired:

```ts
import { createRuntime } from '@glows777/vela'

const runtime = createRuntime({ offline: false })
```

When neither tool is installed in `$VELA_DIR/bin` or on `PATH` and downloads are disabled (`offline: true`), search calls fail with installation hints.

### bash

| Parameter | Type | Description |
|---|---|---|
| `command` | string | Shell command |
| `timeout` | number | Optional timeout in seconds (default `120`, max `1800`) |
| `run_in_background` | boolean | Start the command as a background task and return at once with its id |

Runs `<shellPath> -c <command>` in the working directory (set `shellPath` in [settings](settings.md) or `createRuntime({ shellPath })` to use another Bash-compatible shell). The CLI selects the Git for Windows `bin\\bash.exe` wrapper on Windows. Direct SDK users default to `bash.exe` on `PATH` and can set `shellPath` to the full Git Bash path. The environment streams combined stdout and stderr. Short output stays inline. When either output limit is crossed, the environment writes the full output to a file. Like pi, the model gets the last 2,000 lines or 50KB of output, whichever is smaller; when that cuts the output, a line names the full output file, which can be read with `read`. A non-zero exit ends the preview with `Command exited with code N`, a timeout with `Command timed out after N seconds`, and an abort with `Command aborted`; like pi, these three are error results (`isError: true`), with the preview as the error text. While the command runs, the tail of its output is sent as `tool_execution_update` events (`partialResult` is `{ content: [{ type: 'text', text }] }`, at most every 100ms and only when the output grew).

A running call can also be moved to the background while it waits: `runtime.jobs.promoteForeground(sessionId, toolCallId?)` takes over the call, which returns `Command was manually moved to the background with ID: bg-1.` with the output so far, and the exit arrives as the job's result. The tool result's `execution` metadata carries `backgroundTaskId` and `backgroundedByUser: true`; the call is still recorded as `completed`. A job created either way answers `background_output` and stops through `background_stop` the same way, and Esc does not stop it (closing the session does). A `!!` command is left in the foreground: its exit would reach the model, so moving everything skips it.

With `run_in_background: true` the call starts a job and returns without waiting: `Command running in background with ID: bg-1.` and `You will be notified when it completes; do not poll the file or start a second copy.` Any output the command already wrote comes with that result, which names no file: the environment only knows its spill path once the command ends. The job belongs to the session and delivers its exit as its own message; see [background](built-in-extensions.md#background). Only a session with that extension and its `background_stop` tool has the capability; without either, the call fails with `Background commands are not enabled in this session` instead of ignoring the parameter and running the command in the foreground. Because that depends on the session, the parameter's own description states the condition and the system prompt does not tell every `bash` session to use it. When the output passes the limits above, the session's execution environment spills it to a file there and the exit delivery names it (`Full output: <path>`), so `read` pages the whole log; the tail sent to the model stays bounded.

- Timeout and kill: foreground calls use `timeout` (default `120` seconds, clamped to `1800` seconds) and background calls also honor an explicit `timeout`. When `timeout` fires or the call is aborted, Vela terminates the shell and its child processes (`SIGTERM` grace, then `SIGKILL`) and reports `Command timed out after N seconds` or `Command aborted`.
- Vela does not filter commands; a user extension can confirm or block calls through a `tool_call` hook. See [Security](security.md).

## How tools run

### Concurrency

The model can request several tool calls in one response:

- Read-only tools (`read`, `grep`, `find`, `ls`, `tool_search`, `web_search`, `web_fetch`, `background_output`) and `bash` use `executionMode: 'parallel'` and run concurrently with other parallel calls.
- `write`, `edit`, `memory`, `todo`, `background_stop`, and extension tools that omit `executionMode` default to `'sequential'` and run alone within their session (waiting for prior calls in that session, while subsequent calls wait for them; other sessions are unaffected). `write` and `edit` also queue per file (resolved through symlinks) across all sessions in the process. MCP tools run `'parallel'` only when `readOnlyHint: true`.
- To run a custom tool concurrently with other parallel calls, set `executionMode: 'parallel'` (and use `withFileMutationQueue(path, fn)` if it mutates files).

Tool availability checks, hooks and extension confirmation prompts run before a call waits for anything, so a tool waiting for approval does not hold back other tools.

### Result size and truncation

Each tool has a result line limit (plus the 50KB cap per preview):

| Tool | Limit |
|---|---|
| `read` | one page (50KB) plus its continuation footer when needed, so a page is never saved again |
| `grep`, `find` | 200 lines |
| `bash` | its own tail preview, see above |
| `web_fetch`, `web_search`, default | 500 lines |
| MCP tools | 300 lines |

When a result exceeds its line limit, Vela saves the full result through the selected execution environment (the default local adapter uses `sessions/<id>/tool-results/`) and gives the model a preview instead: the head up to the limit, followed by one line giving the full-output path and explaining that `read` with `offset` reads the rest. Bash retains its tail preview and adds a path only when truncated. Complete bash output is plain text. If shell output storage fails during execution, the adapter stops the command. The reported tail can include partial effects. If the terminal history write fails after a successful spill, the error names the actual file. The earlier call record cannot recover a path allocated later.

Every call and result is also recorded in a tool history log (JSONL) in the session's directory. A `tool_response` record preserves the final normalized, post-hook model output separately from the native `tool_result`, so crash recovery can restore the exact response without rewriting native evidence. The compaction summary keeps one line with the earlier-output snapshot location.

## Deferred tools and tool_search

A tool definition's `exposure` decides where the tool shows up. The values and their meaning are pi's:

| `exposure` | Sent to the model | Found by `tool_search` |
|---|---|---|
| `direct` (default) | yes | yes |
| `model-only` | yes | yes |
| `deferred` | after `tool_search` loads it | yes |
| `hidden` | no | no |

A `hidden` tool stays registered but unused, for example while it is turned off.

A deferred tool is not sent to the model as a tool. Instead, its `<deferred_tools>` section names it, with the tool's `searchHint` if it has one, and tells the model to call `tool_search` to load it. The section is left out when nothing is deferred or when `tool_search` itself is off, since the model could not load them anyway. Like pi, tools with a `namespace` (`{ name, description?, instructions? }`, for example the tools of one MCP server) are not listed one by one: the namespace gets one line with its tool count and description.

`tool_search` takes these parameters (same as pi):

| Parameter | Type | Description |
|---|---|---|
| `query` | string | Keywords describing the tools needed, or exact tool names separated by commas |
| `limit` | number | Most tools to load (default 8) |

A query of exact tool names loads those tools. Any other query ranks the deferred tools that are not loaded yet with BM25 over their names, descriptions, parameter names and descriptions, and namespace, and loads the best `limit` matches. The result lists the loaded tools with the first line of each description, followed by the `instructions` of each namespace involved (for MCP tools, the server instructions), once per namespace. Loaded tools are declared to the model from its next call and stay loaded for the rest of the session. Loading is per session.

All core tools are direct. Deferred exposure is for extensions that register many tools, so their schemas do not fill the context until needed. See [Extensions](extensions.md).

## Tool access

Every session starts with the default tools; there are no roles (like pi). Change the set for a run with `--tools`, for the CLI's sessions with the `tools` setting, or per session through the SDK; an extension can call `setActiveTools()` on its session. A tool that is off is not sent to the model; if the model calls it anyway, the call is rejected and the rejection is recorded in the tool history. Channel chats share one session and its tools. See [Security](security.md#limit-tools).

## Choosing tools per session

`--tools` on the command line and `tools` in the SDK take either an allowlist or a list of `+name` / `-name` entries (like pi):

- A list with plain names enables exactly those tools; every other tool, built-in or from an extension, is off. On the command line the names may be `*` patterns (`read_*`), and `--exclude-tools` then removes names or patterns from the result; the SDK option takes exact names.
- A list of only `+name` / `-name` entries takes exact names, cannot be mixed with plain names, and changes the default set instead, so tools from extensions stay on. `--tools +grep` enables `grep`; `--tools -bash` turns `bash` off.

The `tools` setting in `config.json` takes plain names (`*` patterns work there) and `+name` / `-name` entries, and is described in [Settings](settings.md#tools). With the SDK, pass `tools` when opening a session:

```ts
const session = vela.session('review', {
  tools: ['+grep', '+find'],
})
```

- `tools` sets the session's tools. `session.setActiveTools(names)` replaces them with an allowlist later, and `session.setActiveTools(undefined)` removes the selection. `session.getActiveTools()` returns the names the model can currently see. If you select tools, include `tool_search` when the session needs deferred tools.
To block risky tool calls, load a user extension with a `tool_call` hook. See [Block dangerous calls](security.md#block-dangerous-calls).

See [SDK](sdk.md) for the session API and [examples/extensions/read-only-session.ts](../examples/extensions/read-only-session.ts) for an extension that sets the selection per session.

## Image results

`read` detects JPEG, PNG, GIF, WebP and BMP by file headers, including images with a text extension. Image reads are bounded at 96 MiB before base64 allocation; normal text pagination is unchanged. Images use the shared 2000px / 4.5 MiB base64 normalizer after tool-result hooks. Invalid images produce an omission reason. A text-only model receives a tool-image omission note while history retains the image for later vision use.

Large text captions may be previewed with a separate full-caption path; native result details are still recorded in tool history.
