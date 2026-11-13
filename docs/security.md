# Security

Vela is a local agent. Its tools read and write files and run shell commands with the permissions of the user who started it, and there is no sandbox. Treat commands and code the model produces as untrusted, and limit what the Vela process can reach if a generated action is wrong or hostile.

This page describes what Vela protects and what it does not. To report a vulnerability, see the [security policy](../SECURITY.md).

## Trust model

| Who | Trusted? | What they can do |
|---|---|---|
| The user running `vela` | Yes | Everything the operating-system user can do, through the model's tool calls |
| Extensions | Yes, fully | Run arbitrary code in the Vela process |
| Project config (`.vela/settings.json`, `.vela/extensions/`, project skills and prompt templates, `.vela/APPEND_SYSTEM.md`) | Only after you trust the project | Same as extensions once loaded |
| `AGENTS.md` / `CLAUDE.md` in the working folder and its parents | Always (`--no-context-files` turns them off), like pi | Instructions in the system prompt |
| Members of an enabled Lark chat | Yes, all members | Full access: bash, files, memory and extension tools |
| Model output, tool results, file contents, web pages | No | Can steer the model (prompt injection) |

**The trust boundary is the whole Vela instance, not an individual chat or session.** Every enabled chat, holder of the Local token and accepted webhook input reaches the same operating-system user. Members of chat A can use tools to read chat B's sessions and memory, as well as `~/.vela/auth.json`. Separate transcripts, memory scopes and working directories organize data; they do not isolate it.

Lark enforces a chat allowlist before invoking the model. Enabling a chat trusts every current and future member with this instance-wide access. Local token checks and webhook authentication control admission, not what admitted input can make the agent access. Use separate OS users, containers or virtual machines when callers must not share trust.

## Tools run as you

The built-in tools (`read_file`, `write_file`, `edit_file`, `list_directory`, `grep`, `find`, `bash`) run in the Vela process with your user's permissions. See [Tools](tools.md).

- The working directory is where relative paths resolve and where `bash` starts. It is not a jail: file tools accept absolute paths and `..`, and `bash` can reach anything your user can.
- Vela does not filter `bash` commands: a command the model writes runs unless a user extension blocks the call. A pattern-based confirmation extension can catch mistakes, but is not a security control and is easy to get around.
- Vela does not ask before tool calls unless you load a user extension that asks (see [Confirm before a call](#confirm-before-a-call)).

Anyone in an enabled chat can make Vela run `bash`. That shell runs as the Vela user with Vela's environment and working folder, so it can read `~/.vela/auth.json` (provider keys and OAuth tokens) and `~/.vela/settings.json`: group members can read Vela's keys. Run Vela as a dedicated user with its own home, or inside a container or virtual machine, holding only the files, credentials and network access the bot needs; the [`vela serve` deploy recipe](deploy.md) sets up such a user.

## Extensions are trusted code

An extension is a function that runs inside the Vela process. It can read and write any file, start processes, open network connections, see every prompt, message and tool call, change tool input and output, and register tools that any session can call. Vela does not sandbox extensions and does not try to; this is by design, as in pi.

A session's tool selection does not restrict extension code. It only decides which registered tools the session's model can call.

Review an extension before you load it, and load only extensions from sources you trust. The CLI loads extensions from `~/.vela/extensions/`, from settings, from `-e`, and from the project's `.vela/extensions/` once the project is trusted. See [Extensions](extensions.md).

## Project trust

A project directory can contain `.vela/settings.json`, `.vela/mcp.json` (MCP servers, which Vela starts as processes or connects to), `.vela/extensions/`, prompt templates, `.vela/APPEND_SYSTEM.md` and skills (`.vela/skills/`, `.agents/skills/`, `.skills/`). Project settings can add extensions and change behavior, project extensions are code, and project skills and prompts put instructions in front of the model, so Vela does not load them until you trust the project. `AGENTS.md` and `CLAUDE.md` are loaded either way, as in pi: they are text the model would read anyway when it reads the project, so treat a folder's instructions as untrusted input even when you decline trust, or run with `--no-context-files`.

Interactive mode asks once per project and saves the answer in `~/.vela/trust.json`; `--approve` and `--no-approve` decide for one run; print, JSON and RPC modes never ask and leave an untrusted project's config unloaded. The full rules are in [Settings](settings.md#project-trust).

Project trust only controls what loads at startup. It does not limit what tools can do afterwards, and it does not make a project's files safe to read: a README or source comment can still try to steer the model.

## Channels and instance access

There are no roles (like pi). A channel's enabled-chat list controls who can invoke the instance; it is not an isolation boundary between chats. Sessions can select different tools, but those tools still run as the same OS user.

### Channel senders

Lark accepts only chats listed in `extensionConfig.lark.chats`, plus direct chats from the open_ids in `owners` (or `LARK_OWNERS`). Unlisted groups and DMs are ignored, even when an owner speaks in an unlisted group. Empty `chats` means owners' DMs only.

**Everyone in an enabled chat shares one session and its full access.** They share its history, and can ask the agent to read/write files, run bash, access memory and use extension/MCP tools. Group members added later inherit this access. Enable only chats whose entire membership you trust, and restrict what the operating-system account can reach. Group @-mention gating controls when the bot runs; it is not a tool-permission boundary. Earlier group messages are sent to the model as context when someone mentions the bot.

Channel ids now omit the sender id. Old per-sender sessions are not automatically combined into shared sessions; see [Gateway lifecycle](channels-reference.md#gateway-lifecycle). Different chats have separate transcripts but still share the same machine, tools, memory and extensions.

Every sender in a chat gets the same session and the same tools. A custom channel must enforce its own enablement boundary before delivering messages; there is no per-sender restriction, and it cannot hide earlier turns in a shared chat transcript.

### Limit tools

`tools` is the only per-session tool availability control. Use an allowlist or `+name` / `-name` modifiers when opening a session:

```ts
const session = vela.session('review', { tools: ['read_file', 'grep', 'find'] })
const noShell = vela.session('no-shell', { tools: ['-bash'] })
```

`session.setActiveTools(names)` replaces the selection with an allowlist; `session.getActiveTools()` lists the tools currently exposed to the model. An unavailable tool is not offered to the model, and calls to it are rejected. See [Tools](tools.md#choosing-tools-per-session) and [SDK](sdk.md).

This controls tool availability, not data access. For example, a session with `read_file` can still read any file accessible to the OS user, including other sessions and credentials. Removing `bash` does not isolate a session or make untrusted callers safe.

### Confirm before a call

Confirmation is a user extension, not a built-in rule. In a `tool_call` handler, check `ctx.hasUI`, ask with `ctx.ui.confirm`, and return `{ block: true, reason }` when no UI is attached or the user declines. See [confirm-dangerous.ts](../examples/extensions/confirm-dangerous.ts), which blocks matching commands when `!ctx.hasUI`.

Load the example with `vela -e ./examples/extensions/confirm-dangerous.ts`, or import it and pass it in `createVela({ extensions: [confirmDangerous] })`. An SDK host supplies a session `ui` to answer confirmation prompts. Print and channel sessions have no UI; RPC can forward confirmation requests to its frontend. The example's simple command pattern catches mistakes, not every dangerous action. Hooks can inspect other tools too; they do not restrict arbitrary extension code or provider-hosted execution. Matching `tool_call` handlers keep tools on the local execution path rather than using a provider-hosted equivalent.

## Prompt injection

The model reads text from many places: files, command output, web pages from the `web` extension, knowledge base results, memory, and messages from channel senders. Any of it can contain instructions that try to make the model do something else. Vela does not detect or block this.

Enabled Lark chats have full access: if the model reads a hostile file and then calls `bash`, the command runs. Isolate the environment, review changes before you apply them elsewhere, and consider a user extension that confirms risky calls (see [confirm-dangerous.ts](../examples/extensions/confirm-dangerous.ts) for writing your own).

## Secrets on disk

Vela writes conversations to disk, and they can contain anything the model saw: prompts, file contents, command output, and credentials that appeared in them.

`<data dir>` is the [project data directory](settings.md#data-directory) under `~/.vela/projects/`.

| What | Where | Notes |
|---|---|---|
| Sessions | `<data dir>/sessions/` | Written with mode `0600` in `0700` directories. Includes tool inputs and outputs. See [Sessions](sessions.md) |
| Full tool output and tool history | Inside each session's directory | Also `0600`. A `tool_result` handler that redacts output changes only what the model sees, not these files |
| Memory | `<data dir>/memory/` | Plain Markdown files, written with mode `0600` in a `0700` directory |
| Recordings | The file named by `VELA_RECORD` | The raw conversation, including every model response and user input. Written with mode `0600`. Do not commit it without reviewing it |
| Credentials | `~/.vela/auth.json` | API keys and OAuth tokens stored by `/login`, mode `0600` in a `0700` directory. Never share or commit it; `/logout <provider>` removes an entry |
| Debug log | `~/.vela/debug.log` with `VELA_DEBUG=1` | Diagnostic messages |

Review sessions and recordings before you share them. Keep API keys out of config files: `apiKey` in `~/.vela/models.json` and strings in `extensionConfig` accept `"$VAR"` references that Vela reads from the environment (see [Models](models.md) and [Settings](settings.md)).

## Reduce the impact

- Run Vela in a container, virtual machine or separate account for anything you would not run by hand.
- Use version control or backups before larger changes.
- Give Vela only the credentials it needs, and prefer short-lived, narrowly scoped ones.
- Review extensions before loading them and trust only projects you know.
- Enable only Lark chats whose entire membership you trust with bash and files. Use separate OS accounts, containers or virtual machines for people who must not access each other's data, and keep private data out of any instance they can reach.
- Load a confirming user extension for sessions where a person should approve commands; do not treat it as a sandbox.

## Reporting a vulnerability

Follow the [security policy](../SECURITY.md), which also says what is in scope; do not open a public issue.
