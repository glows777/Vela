# CLI

This page documents the `vela` command: its options, run modes, the interactive terminal UI, slash commands and environment variables.

```sh
vela [prompt...] [-p | --mode text|json|rpc] [-c | -r | --session <id>]
     [-e <extension>]... [--no-extensions] [--no-session]
     [--approve | --no-approve] [--model provider/id] [--thinking <level>]
     [-h | --help] [-v | --version]
```

An unknown option or a bad value prints the usage line and exits with code 2. There is no `--` separator: every argument that starts with `-` (except a lone `-`) is read as an option. To send a prompt that starts with `-`, pipe it through stdin.

## Options

| Option | Description |
|---|---|
| `prompt...` | Every argument that is not an option is a prompt. Several prompts are sent one after another. |
| `-p`, `--print` | Run the prompts, write the last assistant answer to stdout, then exit. |
| `--mode text` | Same as `-p`. |
| `--mode json` | Run the prompts and write one JSON line per event to stdout, then exit. See [JSON mode](json.md). |
| `--mode rpc` | Read JSON commands from stdin and write responses and events to stdout until stdin closes. Takes no prompt arguments. See [RPC mode](rpc.md). |
| `-c`, `--continue` | Continue the most recent saved session of this project, or start a new one if there is none. |
| `-r`, `--resume` | Pick a saved session at startup. Interactive mode only. |
| `--session <id>` | Open the session with this id, creating it if it does not exist. Ids use letters, digits, `.`, `_` and `-`, do not start with `.`, and are at most 128 characters; an invalid id is a usage error (exit code 2). |
| `--no-session` | Keep the conversation in memory only; it is not saved and cannot be resumed. Memory, the knowledge base, usage records and long tool output are still written to the data directory. |
| `--model <provider/id>` | Use this model. See [Models](models.md). |
| `--thinking <level>` | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. |
| `-e`, `--extension <path>` | Load an extension file or directory, or `builtin:<name>`. Repeatable. Relative paths resolve from the current folder. |
| `--no-extensions`, `-ne` | Skip the built-in extensions and every discovered or configured extension. Extensions given with `-e` still load. |
| `--append-system-prompt <text>` | Append text, or the contents of the file at that path, to the system prompt. Repeatable. Replaces `~/.vela/APPEND_SYSTEM.md` and `.vela/APPEND_SYSTEM.md` for this run. See [Settings](settings.md#appending-to-the-system-prompt). |
| `--no-context-files`, `-nc` | Don't put `AGENTS.md` / `CLAUDE.md` into the system prompt. See [Settings](settings.md#context-files). |
| `--tools`, `-t <tools>` | Enable only these tools: a comma-separated list of names or `*` patterns (`read_*`), repeatable. Every other tool, built-in or from an extension, is off. |
| `--no-tools`, `-nt` | Start with no tools; `--tools` still enables the ones it names. |
| `--exclude-tools`, `-xt <tools>` | Turn these tools off (names or `*` patterns), after `--tools`. |
| `--list-models [search]` | Print the models listed in `models.json` and by extension providers (provider, model, context window, thinking support), optionally fuzzy-filtered, then exit. |
| `--approve` | Trust this project's `.vela/settings.json`, `.vela/extensions/`, `.vela/prompts/`, `.vela/APPEND_SYSTEM.md` and project skills (`.vela/skills/`, `.agents/skills/`, `.skills/`) for this run, without saving the decision. |
| `--no-approve` | Do not trust them for this run, without saving the decision. |
| `-h`, `--help` | Print the usage, every option, the run modes, examples and environment variables to stdout, then exit with code 0. |
| `-v`, `--version` | Print the package version to stdout, then exit with code 0. |

`-c`, `-r` and `--session` are mutually exclusive.

The tool options apply to every session the CLI opens (also after `/new` and `/resume`) and are checked after extensions load: an entry that matches no tool stops the CLI with exit code 2 and lists the available tools. pi ignores unknown names; Vela reports them so that a typo can't leave a tool on or off.

An extension that fails to load is reported on stderr (or in the chat log) and skipped; Vela still starts. Extension loading, discovery and the `builtin:` names are described in [Extensions](extensions.md#where-extensions-load-from) and [Built-in extensions](built-in-extensions.md).

## Run modes

Vela picks the mode at startup:

1. `--mode rpc` selects RPC mode and `--mode json` selects JSON mode.
2. `-p`, `--mode text`, or a stdin or stdout that is not a terminal selects print mode.
3. Otherwise Vela opens the interactive terminal UI.

```sh
vela                                         # interactive
vela -p "Summarize this repository"          # print the answer and exit
git diff | vela -p "Review this change"      # piped stdin
vela --mode json "List the TODOs" > events.jsonl
vela --mode rpc                              # driven by another program
```

### Print mode

Print mode sends each prompt in turn and writes only the final assistant text of this run to stdout. Diagnostics, extension notifications and console output from extensions go to stderr, so stdout stays clean for pipes. If the reader closes the pipe early (`vela -p "..." | head -2`), Vela stops and exits quietly with code 0.

If stdin is piped, its contents are prepended to the first prompt, separated by a blank line. If there is no prompt at all, Vela exits with code 2. If the turn fails or no model is available, the reason goes to stderr and the exit code is 1.

Print mode has no UI: confirmation dialogs from extensions answer "no". Extension commands work (`vela -p /memory`), but the CLI's own slash commands such as `/context` or `/model` do not; they are sent to the model as plain text.

### JSON and RPC modes

`--mode json` writes a `session` header line followed by one JSON line per event of the session. `--mode rpc` keeps the process running and exchanges JSON lines on stdin and stdout. In both modes stdout carries only protocol records; logs go to stderr. See [JSON mode](json.md) and [RPC mode](rpc.md).

## Sessions

Each launch starts a new session with an id like `20261008-081430-df22` (local date, time and four random characters). Sessions are saved in the [project's data directory](settings.md#data-directory) after every prompt.

| Flag | Behavior |
|---|---|
| none | Start a new session. |
| `-c`, `--continue` | Continue the most recently saved session of this project, or start a new one if there is none. |
| `-r`, `--resume` | Show a picker of saved sessions (interactive mode only; use `-c` or `--session` in the other modes). |
| `--session <id>` | Open the session with that id, creating it if it does not exist. |
| `--no-session` | Keep the conversation in memory only; it is not saved and cannot be resumed. Long tool output, memory, the knowledge base and usage logs are still written to the data directory. |

```bash
vela --session refactor "Plan the parser refactor"
vela -p --session refactor "Now list the risky parts"
vela -c
```

A resumed session restores its history, name, thinking level and model (if the model was chosen by name and is still available). `--model`, `--thinking` and `VELA_MODEL` still win over the saved values. See [Sessions](sessions.md).

## Interactive mode

The screen has, from top to bottom: a header with the session id and loaded extensions, the chat log, queued messages, a status line while the agent runs, extension widgets, the editor, and a footer. The footer shows the folder and session name, tokens in and out, cost when known, context usage, the model and the thinking level, followed by any extension status texts. The editor border color follows the thinking level.

Text you send while the agent is running is a steering message: it is inserted after the current step. Alt+Enter queues a follow-up instead, which runs after the task finishes. Slash commands run immediately even while the agent is running.

When a project has untrusted configuration, Vela asks once at startup whether to trust it. See [Project trust](settings.md#project-trust).

### Keybindings

Vela's own keys:

| Key | Action |
|---|---|
| Enter | Send. While running: steer (insert after the current step). |
| Alt+Enter | While running: queue a follow-up for after the task. When idle: send. |
| Alt+Up | Move queued messages back into the editor. |
| Esc | Interrupt the running task; queued messages go back into the editor. Closes the autocomplete menu first if it is open. |
| Shift+Tab | Cycle the thinking level. |
| Ctrl+L | Open the model picker. |
| Ctrl+O | Expand or collapse tool output. |
| Ctrl+T | Show or hide thinking. |
| Ctrl+C | Clear the editor; press twice within half a second to exit. |
| Ctrl+D | Exit when the editor is empty; otherwise delete the character after the cursor. |

`/hotkeys` shows the same list. The editor itself comes from `@earendil-works/pi-tui` and uses its default keys:

| Key | Action |
|---|---|
| Shift+Enter, Ctrl+J | New line |
| Tab | Complete a command or path |
| Up, Down | Move the cursor; at the first or last line, browse prompt history |
| Left / Ctrl+B, Right / Ctrl+F | Move by character |
| Alt+Left / Ctrl+Left / Alt+B, Alt+Right / Ctrl+Right / Alt+F | Move by word |
| Home / Ctrl+A, End / Ctrl+E | Line start, line end |
| Ctrl+], Ctrl+Alt+] | Jump forward or backward to a character |
| PageUp, PageDown | Scroll by page |
| Backspace, Delete | Delete character backward, forward |
| Ctrl+W / Alt+Backspace, Alt+D / Alt+Delete | Delete word backward, forward |
| Ctrl+U, Ctrl+K | Delete to line start, to line end |
| Ctrl+Y, Alt+Y | Paste the last deleted text, cycle older deletions |
| Ctrl+- | Undo |

In pickers and dialogs: Up and Down move, Enter selects, Esc cancels. Keybindings cannot be changed.

### Tool output

Each tool call is a block showing the tool and its key argument, like pi. While `bash` runs, its output streams into the block with the elapsed time; collapsed, the block keeps the last 5 lines and shows how long the command took. `edit_file` shows the diff of its change. Other tools show the first 10 lines of their result. Ctrl+O expands every block. Calls a tool makes through `ctx.executeTool()` are listed inside its block, one line each with ✓ or ✗ and the time taken.

If the terminal goes away (the window is closed or the SSH connection drops), Vela exits: on SIGHUP it saves and closes the sessions first, and when reading or writing the terminal fails it exits at once with code 129.

### Completion

Typing `/` at the start of the editor lists commands: the TUI's own, the CLI's, prompt templates, skills (as `skill:<name>`), and commands registered by extensions, filtered as you type. Tab completes file and directory paths relative to the working folder.

`@` starts fuzzy file completion over the working directory, as in pi. It uses `fd`, found or downloaded the same way as for the `find` tool (see [Tools](tools.md)); until `fd` is ready, or if it can't be found (for example with `VELA_OFFLINE=1` and no `fd` installed), `@` shows no suggestions and a notice says so. Vela does not expand `@path` into the file's contents: the text is sent as written and the model reads the file with its tools.

## Slash commands

In interactive mode, a line that starts with `/` is a command; any other text, including single words such as `exit` or `status`, is sent to the model.

### Interactive UI

| Command | Description |
|---|---|
| `/new` | Start a new session. |
| `/resume` | Pick a saved session and switch to it. |
| `/name [name]` | Show or set the session name. |
| `/model [provider/id]` | Without an argument, open the model picker (models listed in `models.json` or by extension providers). With an argument, switch to that model. |
| `/thinking [level]` | Without an argument, open the thinking-level picker. With an argument, set it. |
| `/compact [focus]` | Summarize the conversation now, optionally telling the summary what to focus on. |
| `/copy` | Copy the last answer to the clipboard (`pbcopy`, `clip`, `wl-copy`, `xclip` or `xsel`; over SSH or without a display, the terminal's OSC 52). If none works, the error says what to install. |
| `/hotkeys` | Show the keyboard shortcuts. |
| `/quit`, `/exit` | Exit. |

`/new`, `/resume` and `/compact` refuse to run while a task is running.

### CLI commands

| Command | Description |
|---|---|
| `/context` | Context window usage by category (system prompt, tools, memory, skills index, messages) and the autocompact buffer (the window above the summary threshold). |
| `/usage` | Token usage, cache hits and cost for this session. |
| `/skill`, `/skills` | List skills. |
| `/extensions` | Loaded extensions and the tools, commands and channels each registered. |
| `/channel`, `/channel list` | Registered channels. See [Channels](channels.md). |
| `/role [owner\|collaborator\|guest]` | Show or set this session's role. See [Security](security.md). |
| `/hooks` | Registered pre- and post-tool hooks. |
| `/cache on`, `/cache off` | Turn the prompt cache simulation of the demo model on or off (`VELA_MODEL=mock` only). |

Two more kinds of `/` input are expanded by the session itself, so they also work in print, JSON and RPC mode: `/skill:<name> [instruction]` sends a skill, and `/<template> [args]` sends a prompt template. See [Skills](settings.md#skills) and [Prompt templates](settings.md#prompt-templates).

### Built-in extension commands

| Command | Extension | Description |
|---|---|---|
| `/memory` | `memory` | List memories, flagging those with warnings. |
| `/memory search <keywords>` | `memory` | Search memories. |
| `/memory lint` | `memory` | Check the memory store for problems. |
| `/dream` | `memory` | Ask the model to clean up the memory store (merge duplicates, delete stale entries). |
| `/rag` | `rag` | Show the knowledge base size and sources. |
| `/rag ingest <path>` | `rag` | Ingest a document into the knowledge base. |

Extension commands run only in sessions with the `owner` role. Other extensions add their own; `/extensions` lists them. See [Built-in extensions](built-in-extensions.md) and [Extensions](extensions.md).

## Debug output

Set `VELA_DEBUG=1` to see debug logs. In interactive mode they are appended to `~/.vela/debug.log` so they do not garble the screen, and Vela shows which system prompt sections are on when a session opens. In the other modes debug lines go to stderr.

## Environment variables

| Variable | Description |
|---|---|
| `VELA_DIR` | User directory. Default `~/.vela`; `~` is expanded. |
| `VELA_MODEL` | `mock` uses the offline demo model; `faux:<file.json>` replays a recorded scenario. Overrides `defaultModel` and a resumed session's model; `--model` still wins. See [Testing](testing.md). |
| `VELA_RECORD` | Record this run's model responses and user input as a faux scenario file, for replay with `VELA_MODEL=faux:<file>`. |
| `VELA_DEBUG` | `1` enables debug logging (see above). |
| `VELA_OFFLINE` | `1`, `true` or `yes`: never download `rg` / `fd` for the search tools. See [Tools](tools.md). |
| `OPENAI_API_KEY` | API key of the built-in `openai` provider. |
| `OPENAI_API_BASE_URL` | Base URL of the built-in `openai` provider, for proxies and OpenAI-compatible services. |
| `OPENAI_API_MODEL_NAME` | Fallback model: used as `openai/<name>` when neither `--model` nor `defaultModel` is set. |
| `ANTHROPIC_API_KEY` | API key of the built-in `anthropic` provider. |
| `TAVILY_API_KEY`, `SERPER_API_KEY` | Search keys for the `web` extension (`extensionConfig.web.tavilyKey`, `.serperKey`). Without one there is no `web_search` tool; Tavily wins if both are set. |
| `FEISHU_APP_ID`, `FEISHU_APP_SECRET` | Credentials for the `feishu` channel (`extensionConfig.feishu.appId`, `.appSecret`); without them it does not connect. |
| `FEISHU_OWNERS` | Comma-separated Feishu open_ids that get the `owner` role; everyone else is a guest (`extensionConfig.feishu.owners`). |
| `EMBEDDING_MODEL_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_MODEL_KEY` | Embedding API for the `rag` extension (`extensionConfig.rag.embedding.baseUrl`, `.model`, `.apiKey`); the knowledge base is enabled only when all three are set. |

The extension variables are defaults for the `extensionConfig` keys shown in parentheses: a value set in `settings.json` overrides them, and an empty string counts as unset. `models.json` and `extensionConfig` can read any other variable with `$NAME` or `${NAME}`. Because the providers are built on the AI SDK, an `openai-*` or `anthropic-messages` provider with no base URL also honors the SDK's own `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL`.

The installed `vela` command does not load `.env` files. Bun does, from the current folder, when you run the source with `bun src/cli/main.ts`.
