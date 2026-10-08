# Security

Vela is a local agent. Its tools read and write files and run shell commands with the permissions of the user who started it, and there is no sandbox. Treat commands and code the model produces as untrusted, and limit what the Vela process can reach if a generated action is wrong or hostile.

This page describes what Vela protects and what it does not. To report a vulnerability, see the [security policy](../SECURITY.md).

## Trust model

| Who | Trusted? | What they can do |
|---|---|---|
| The user running `vela` (owner) | Yes | Everything the operating-system user can do, through the model's tool calls |
| Extensions | Yes, fully | Run arbitrary code in the Vela process |
| Project config (`.vela/settings.json`, `.vela/extensions/`) | Only after you trust the project | Same as extensions once loaded |
| Channel senders (people messaging a channel) | No, unless listed as owners | What their session role allows |
| Model output, tool results, file contents, web pages | No | Can steer the model (prompt injection) |

The boundary Vela enforces is between the owner and other people who talk to the agent through a channel. It is not a boundary against extensions or against the model acting for the owner.

## Tools run as you

The built-in tools (`read_file`, `write_file`, `edit_file`, `list_directory`, `grep`, `find`, `bash`) run in the Vela process with your user's permissions. See [Tools](tools.md).

- The working directory is where relative paths resolve and where `bash` starts. It is not a jail: file tools accept absolute paths and `..`, and `bash` can reach anything your user can.
- Before running, `bash` commands are checked against a short list of dangerous patterns (`rm -rf`, `sudo`, `mkfs`, `curl ... | sh`, `eval`, writes to `/etc` or disk devices, and a few others). Matches are rejected for every role. Medium-risk commands (`rm`, `mv`, `chmod`, `kill`, `git push`, `git reset --hard`, ...) run and emit a `security_warning` event. This is a heuristic to catch mistakes, not a security control; it is easy to get around.
- Vela does not ask before each tool call unless you set a session permission to `ask` (see [Per-session permissions](#per-session-permissions)) or load an extension that asks.

To contain what Vela can do, run it as a dedicated user, or inside a container or virtual machine with only the files, credentials and network access the task needs.

## Extensions are trusted code

An extension is a function that runs inside the Vela process. It can read and write any file, start processes, open network connections, see every prompt, message and tool call, change tool input and output, and register tools that any session can call. Vela does not sandbox extensions and does not try to; this is by design, as in pi.

Session roles and permissions do not restrict extension code. They only decide which tools a session's model can call and whether that session can run extension commands.

Review an extension before you load it, and load only extensions from sources you trust. The CLI loads extensions from `~/.vela/extensions/`, from settings, from `-e`, and from the project's `.vela/extensions/` once the project is trusted. See [Extensions](extensions.md).

## Project trust

A project directory can contain `.vela/settings.json` and `.vela/extensions/`. Project settings can add extensions and change behavior, and project extensions are code, so Vela does not load them until you trust the project.

Interactive mode asks once per project and saves the answer in `~/.vela/trust.json`; `--approve` and `--no-approve` decide for one run; print, JSON and RPC modes never ask and leave an untrusted project's config unloaded. The full rules are in [Settings](settings.md#project-trust).

Project trust only controls what loads at startup. It does not limit what tools can do afterwards, and it does not make a project's files safe to read: a README or source comment can still try to steer the model. Project skills (`<cwd>/.skills/` and `<cwd>/.vela/skills/`) are instructions, not code, and load without project trust.

## Session roles

Every session has a role. The role decides which tools the session's model can call.

| Role | Tools | Extension commands | Owner's memory |
|---|---|---|---|
| `owner` | All | Yes | Injected into the system prompt; `memory` tool available |
| `collaborator` | All except `bash` | No | Injected into the system prompt; `memory` tool available |
| `guest` | Only `rag_search`, `web_search` and `tool_search` | No | Not injected; no `memory` tool |

A guest has no file, shell or memory tools and no extension tools: extension tool names carry an `<extension>_` prefix, so only an extension named `rag` or `web` can register `rag_search` and `web_search`. Don't load third-party extensions with those names. A guest's system prompt does not include the file rules or the working directory. A tool the role denies is left out of the tool list, and a call to it is rejected and recorded in the tool history.

Note what each role can still reach:

- A `collaborator` can read and write any file the Vela process can, sees the owner's memory index in its system prompt and can read and change memories with the `memory` tool, and can call extension tools.
- A `guest` can search the knowledge base with `rag_search`. Do not index private documents if untrusted people can message a channel.

The terminal session is `owner`. In the SDK, `vela.session(id, { role })` sets the role (default `owner`). In interactive mode, `/role [owner|collaborator|guest]` shows or changes the current session's role, which is useful for trying out what a channel sender sees.

### Channel senders

Each sender on a channel gets their own session. The channel's `roleFor(message)` picks the role and is checked on every message; a channel without `roleFor` makes every sender a `guest`. The built-in Feishu channel makes senders listed in `extensionConfig.feishu.owners` (or `FEISHU_OWNERS`, comma-separated) owners and everyone else a guest. See [Channels](channels.md).

An owner on a channel has full access, including `bash`. Only list identities that you control, and remember that the security of that session is the security of the chat account.

### Per-session permissions

The SDK can layer tool rules over a session's role:

```ts
const session = vela.session('ci', { permissions: { bash: 'ask', write_file: 'deny' } })
```

| Decision | Effect |
|---|---|
| `allow` | The tool runs |
| `deny` | The tool is not offered to the model, and calls are rejected |
| `ask` | The session's `ui.confirm` is asked first, after extension `tool_call` handlers have run (so it sees the final input). With no UI the call is rejected |

Keys are tool names, or `*` for all other tools. An exact name beats `*`, and at the same level the session's rule beats the role's rule, so permissions can also grant a tool the role denies. `vela.session(id, { tools })` and `session.setActiveTools()` further limit the tools to a list. See [SDK](sdk.md).

## Prompt injection

The model reads text from many places: files, command output, web pages from the `web` extension, knowledge base results, memory, and messages from channel senders. Any of it can contain instructions that try to make the model do something else. Vela does not detect or block this.

Roles limit the damage for channel guests, because a guest's model has no tools that touch the machine. For the owner's own sessions nothing limits it: if the model reads a hostile file and then calls `bash`, the command runs. Isolate the environment, review changes before you apply them elsewhere, and consider an extension that confirms risky calls (see [confirm-dangerous.ts](../examples/extensions/confirm-dangerous.ts)).

## Secrets on disk

Vela writes conversations to disk, and they can contain anything the model saw: prompts, file contents, command output, and credentials that appeared in them.

`<data dir>` is the [project data directory](settings.md#data-directory) under `~/.vela/projects/`.

| What | Where | Notes |
|---|---|---|
| Sessions | `<data dir>/sessions/` | Written with mode `0600` in `0700` directories. Includes tool inputs and outputs. See [Sessions](sessions.md) |
| Full tool output and tool history | Inside each session's directory | Also `0600`. A `tool_result` handler that redacts output changes only what the model sees, not these files |
| Memory | `<data dir>/memory/` | Plain Markdown files, written with mode `0600` in a `0700` directory |
| Recordings | The file named by `VELA_RECORD` | The raw conversation, including every model response and user input. Written with mode `0600`. Do not commit it without reviewing it |
| Debug log | `~/.vela/debug.log` with `VELA_DEBUG=1` | Diagnostic messages |

Review sessions and recordings before you share them. Keep API keys out of config files: `apiKey` in `~/.vela/models.json` and strings in `extensionConfig` accept `"$VAR"` references that Vela reads from the environment (see [Models](models.md) and [Settings](settings.md)).

## Reduce the impact

- Run Vela in a container, virtual machine or separate account for anything you would not run by hand.
- Use version control or backups before larger changes.
- Give Vela only the credentials it needs, and prefer short-lived, narrowly scoped ones.
- Review extensions before loading them and trust only projects you know.
- Give channel senders the `guest` role unless they need more, and keep private data out of the knowledge base when guests can reach it.
- Use `permissions: { bash: 'ask' }` or a confirming extension for sessions where a person should approve commands.

## Reporting a vulnerability

Follow the [security policy](../SECURITY.md), which also says what is in scope; do not open a public issue.
