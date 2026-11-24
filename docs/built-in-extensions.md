# Built-in extensions

Vela ships six selectable built-in extensions in `@glows777/vela`: `background`, `memory`, `todo`, `web`, `lark`, and `mcp`. They use the same extension API as your own extensions (see [Extensions](extensions.md) and [Packages](sdk.md#packages)).

| Extension | Adds |
|---|---|
| `background` | Long-running commands whose result arrives on its own: `bash` with `run_in_background`, plus `background_output` and `background_stop` |
| `memory` | Cross-session memory: the `memory` tool, a memory index sent as a message, `/memory` and `/dream` |
| `todo` | Task checklist: the `todo` tool, shown on the Lark progress card |
| `web` | `web_fetch`, and `web_search` with a supported hosted search or a search API key |
| `lark` | The Lark bot channel (see [Channels](channels.md)) |
| `mcp` | Tools of MCP servers, as `mcp__<server>__<tool>`, and `/mcp` (see [MCP servers](mcp.md)) |

## Local transport

Vela also ships `local` in `@glows777/vela`. It is an explicitly enabled transport, not another `builtin:*` selector or a default CLI extension. It provides authenticated loopback HTTP/SSE for project hubs, task sessions, visible history and run-bound Stop. Lark and Local share the channel gateway and topic tools.

In the CLI, enable it only through user-level `"local": { "enabled": true, "token": "$VELA_LOCAL_TOKEN", "port": 8788 }` in `config.json` and run `vela serve`. Project config cannot enable or override it; non-serve modes and `--no-extensions` do not start it. In the SDK, add `local({ token, port: 8788 })` explicitly, then call `await vela.ready()` and `await vela.startChannels()`. Unlike the factories below, Local requires its token as a factory option and does not read it implicitly from extension configuration.

Local binds only `127.0.0.1`, with Bearer authentication and no CORS/cookie support. Its token grants the daemon's tool authority. Do not tunnel it or share the webhook listener's port (8787). See [Local](channels.md#local) for setup, security, the HTTP/SSE protocol and runnable client examples.

## Loading

**CLI.** All six load by default, before any discovered or `-e` extensions. Some capabilities stay off until configured: `web` registers only `web_fetch` without a search key, `lark` registers its channel but does not connect without an app id and secret, and `mcp` connects nothing until servers are configured.

To turn one off, add `-builtin:<name>` to `extensions` in `config.json`, for example `"extensions": ["-builtin:lark"]`. `--no-extensions` skips them. The full rules are in [Extensions](extensions.md#where-extensions-load-from). `/extensions` in interactive mode lists the loaded extensions and what each registered.

**SDK.** `createVela()` loads no extensions by default. Import the factories and pass them in `extensions`:

```ts
import {
  background,
  createVela,
  memory,
  todo,
  web,
} from '@glows777/vela'

const vela = createVela({
  dataDir: '.vela-data',
  extensions: [
    background(),
    memory(),
    todo(),
    web({ tavilyKey: process.env.TAVILY_API_KEY }),
  ],
})
```

For the selectable built-ins below, factory options take precedence. An option you leave out is read from the extension's config section, `extensionConfig.<name>`, which you can pass to `createVela({ extensionConfig })`.

## Configuration

In the CLI, each built-in reads `extensionConfig.<name>` from [settings](settings.md). String values support `$VAR` and `${VAR}`. When a key is not set in settings, the CLI falls back to an environment variable such as `TAVILY_API_KEY`; [CLI](cli.md#environment-variables) lists each variable and the key it fills. An empty string counts as unset. `memory` has no configuration.

```json
{
  "extensionConfig": {
    "web": { "tavilyKey": "$TAVILY_API_KEY" }
  }
}
```

## Tool names

Extension tools are prefixed with the extension name: the `web` extension's `search` tool is `web_search`. A tool whose name equals the extension name is not prefixed, so the memory tool is `memory`, not `memory_memory`, and the todo tool is `todo`; nor is one that already starts with the prefix, so MCP tools are `mcp__<server>__<tool>`. See [Extensions](extensions.md).

Remove any of them from the session's `tools` selection; see [Security](security.md#limit-tools).

## Data

Built-ins store their data in the project data directory: in the CLI, the [project data directory](settings.md#data-directory) under `~/.vela/projects/`; in the SDK, `dataDir`. Without `dataDir`, the SDK uses a temporary directory that `vela.dispose()` deletes.

| Extension | Location |
|---|---|
| `memory` | `<dataDir>/memory/` |

## memory

Long-term memory across sessions. Each memory is a Markdown file with front matter (`name`, `description`, `type`, `lastWriteAt`, `lastReadAt`, and dream `sources`), named `<type>_<slug>.md`. `MEMORY.md` is an index with one line per memory. Every entry is retained, including past 200 entries. Injection stays capped at 4,000 characters and explicitly reports how many entries are omitted; use `memory search` to find them. `/memory` warns when the index exceeds its budget. Memory files and the index are written with mode `0600` in a `0700` directory; a store written by an older version is tightened when it opens.

**Tool.** `memory`, with an `action` parameter:

| Action | Parameters | Description |
|---|---|---|
| `save` | `name`, `type`, `content`, `description` | Save a memory; saving the same name and type overwrites it |
| `list` | | List all memories |
| `search` | `query` | BM25 search, top 5 |
| `read` | `filename` | Read one memory by file name (for example `user_favorite-language.md`) |
| `delete` | `filename` | Delete one memory |
| `lint` | | Report problems |

`read` and `delete` accept only a memory's file name as listed in the index: a path (`../`, `/`), the index itself or a name not ending in `.md` is an error.

`type` is one of `user` (stable facts about the user), `feedback` (corrections to how the assistant works), `project` (durable project decisions and context), or `reference` (where to find useful information). Memory content returned to the model is cut at 4,000 characters.

`lint` reports paths mentioned in a memory that no longer exist and duplicate names. Read age is not a staleness verdict; dream compares notes with recent conversations.

**Prompt.** The short usage rules stay in the system prompt. The index is sent as a message after the user message whenever it changed, so saving a memory does not rewrite the cached system prompt; it is sent again after compaction removed the old one (and restored right away in the request that compaction summarized it from), and deleting the last entry sends an empty-store update. If a session's tools omit `memory`, that session gets none of the rules, the index, or the tool.

**Commands.**

| Command | Description |
|---|---|
| `/memory` | List memories and warnings, last dream time/change count, and inbox size |
| `/memory search <keywords>` | Search memories |
| `/memory lint` | Show the lint report |
| `/dream` | Run isolated consolidation now and show its report |

Extension commands run in every session; an input naming a registered command runs it instead of going to the model.

**Dream.** After an eligible conversation turn, memory appends a bounded record to
`<store>/.dream/inbox.jsonl`: session ID, time, user input and final assistant text
(about 2,000 characters per side), plus tool names, never tool output. Only user
input is evidence for new facts. Assistant text remains in the private inbox for
compatibility, but is excluded from both the dream model input and the
query that selects notes. Ambiguous acknowledgements without an explicit user fact
do not justify a new fact. This removes assistant-only suggestions from the input;
it does not validate the factual accuracy of arbitrary model output. The inbox is
capped at about 100 KB, dropping oldest records and counting dropped records.
It uses the same private file permissions as memory. Only sessions with the `memory` tool available
contribute; sessions that omit it do not. Local sessions and owner DMs use global memory; a group's
sessions write only that group's inbox and notes, never another group's or global
store.

After a reply settles, automatic dream starts in the background when the inbox
contains at least 20 turns or a turn older than 24 hours. It does not delay the
reply. Only one dream runs per store. After a failed or conflict-skipped pass,
automatic retry waits for 20 new turns since that pass started or 24 hours since
it finished, even if the retained inbox is already old or full. `/dream` retries
immediately without waiting for that threshold.
Set `extensionConfig.memory.dream` to `false` to disable automatic runs; manual
`/dream` remains available. The default is enabled, including groups. Both automatic
and manual dream require the `memory` tool to be available.

Dream makes one isolated model call with no tools, plus at most one correction
call. It compares recent conversation
records with notes and deterministic lint findings, corrects contradicted notes,
saves missing durable facts, merges duplicates and condenses the index. Large
stores provide the index plus notes matched to the inbox within a content budget.
Each operation names its filename, source session and an optional `reason`; a note's
`description` is optional and falls back to its name. The reason never reaches the
stored note; it only appears in the report as `no reason given` when omitted.
Conversation text is evidence, not instructions. The reply may be one JSON object,
one surrounding JSON code fence, or the object followed only by a stray closing
fence or prose without braces, brackets or another fence; that object still passes the same
strict JSON and operation validation. Text before the object, a second object, an
array or a second fence block fails the run and retains the inbox. A reply that
cannot be parsed or applied — including an operation naming a file the model was
not shown — is answered once with the same input, that reply and a one-line error,
so the model can fix it instead of repeating the same omission on the next retry.
A second unusable reply fails the run, retains the inbox and waits for the usual
retry gate; conflicts below are never retried. Validated operations go through
the memory store. Before applying any operation, dream checks every full note
supplied to the model for changes since the snapshot, plus create-target collisions. A live edit or a newly occupied create target skips
the entire batch and retains the inbox for retry. This keeps a merge source from
being deleted when its destination could not be updated. The report names the
conflicting notes. The inbox is consumed only after successful application,
preserving turns arriving during the run. Dream messages and tool traces do not enter the user's conversation.

Changed notes retain the last five source session IDs in `sources:` frontmatter.
`<store>/.dream/log.md` keeps reports for the last 20 runs; a failed run's report also
keeps the last 500 characters of the model reply. `/memory` marks a failed
or skipped last run explicitly instead of showing it as an ordinary zero-change run. Dream model usage is
included in `/usage` and the usage ledger. `/memory` exposes the latest run and
pending inbox size so automatic maintenance is visible.

**SDK.** `memory()` takes no options. Configure automatic runs through Vela's
`extensionConfig: { memory: { dream: false } }`, and invoke manual consolidation
with `await session.prompt('/dream')`.

## background

Long-running commands whose result arrives on its own, for work that must not hold the conversation. `bash` starts them: with `run_in_background: true` the call returns at once, and this extension watches the job and delivers its exit. `bash` always declares the parameter, and only a session that loads this extension can use it; without one the call fails with `Background commands are not enabled in this session` before any process starts.

**Tools.** `background_output` and `background_stop` come with the extension, which the CLI loads by default; a chat's narrowed `tools` list or an explicit `tools` selection can drop them, and a DM drops them. `run_in_background` has no tool of its own: loading the extension installs the session's job table, which `bash` reaches through `ToolContext`. The job table owns the ids, the output tails and the deliveries, so `bash` and these two tools cannot disagree about a job. Every running `bash` call and the user's own `!` command are registered there too, so the session can move one to the background mid-run: `session.backgroundTasks(toolCallId?)` and the RPC request [`background_tasks`](rpc.md#background_tasks) — with an id, that call; without one, every call in the foreground. The moved call returns the id and the output so far, and its exit is delivered like any other job's. Moving your own `!` command records it as a background command (`backgroundTaskId`, no exit code yet) instead of a finished one; a `!!` command is left where it is, because a job's exit is delivered to the model and that command promised to stay out of the context.

| Tool | Parameters | Behavior |
|---|---|---|
| `bash` | `command`, `run_in_background: true` | Starts the command in the session's execution environment and returns at once with its id (for example `bg-1`) and any output it already wrote. A host that cannot record the job fails the call before the command starts; an execution failure after that arrives as the job result. |
| `background_output` | `id` | The command's state (`running` or `exited`) and its output tail: the last 2,000 lines or 50KB, whichever is hit first |
| `background_stop` | `id` | Aborts the command through the session's execution environment and returns its final output tail. The local implementation terminates the process group immediately. |

**Commands.** `/tasks` (alias `/bashes`) lists every job the session still holds: its id, state, elapsed time, command head and output tail, whether the command was started with `run_in_background` or moved to the background mid-run. `/tasks stop <id>` ends one through the same stop as `background_stop` and answers with its final tail; an id that already delivered, or that ended with a restart or session close, gets the same unknown-command message as the tool. In the TUI the footer's extension status slot names the running jobs (`1 background task · bg-1`) and clears when none runs, and Ctrl+B moves the running command to the background (see [CLI keybindings](cli.md#keybindings)).

**Output.** The start result carries the id and the output the command has already written, and names no file. The tail kept for the model stays bounded (the last 2,000 lines or 50 KB), and `background_output` reads it while the command runs. When the output passes those limits, the session's execution environment spills the complete output to its own file; the environment reports that path only when the command ends, so the exit delivery names it (`Full output: <path>`) and `background_stop` returns it. `read_file` then pages all of it, including in a session whose environment is not the host.

**Delivery.** When a command exits on its own, the session gets one message with the exit state, the command head and the output tail. A stop never delivers: `background_stop` returns the tail in its tool result, and session close and shutdown have no run left to answer. In the CLI and SDK it is a hidden custom message (`customType: background`) that starts a turn, or joins the current run as a follow-up, so the model never polls. In a channel the result enters that conversation's gateway queue like any other input: it is answered as a new reply in its topic, or in the group's main timeline as a reply to the person's last message, with the usual anchor, card, reaction and Stop. A silent topic evaluation needs no special case, and an explicit answer never merges into a passive one.

**Lifecycle.** Commands belong to their session, not to the run that started them: an interrupted run (Esc, `session.abort()`) leaves a job running, and its exit still arrives. `background_stop`, `session.close()` and process shutdown stop active execution without delivering its exit directly. A command still in the foreground when the run is interrupted is cancelled with it, as before. A move is recorded before it is promised: if the host cannot save the job's start, the call keeps the command and its own result, and if the run was interrupted in the meantime the command is cancelled rather than left running unclaimed. In hosted group/topic sessions, process shutdown preserves outstanding job identities so startup sends an unknown-result notice; `background_stop` and close clear them. A normal completion counts as delivered only after its result input is saved. Hostless sessions retain the existing lost-id behavior. A job is forgotten once its result has been delivered or returned by `background_stop`, so asking again for that id, or asking after a restart, answers `Unknown background command … It may have finished and its result was delivered (or returned by background_stop), or it ended with a restart or session close.` The tail stays in memory (oldest bytes dropped first), so a command that prints forever costs at most that buffer; the whole output goes to the spill file that the exit delivery names.

**Unattended runs.** Print mode (`-p` and `--mode json`) sets `SessionOptions.unattended`. By default a background command gets 30 minutes; an explicit `timeout` on `run_in_background` may choose a different duration, up to two hours. The clock starts when a command starts in the background or moves there. At the limit the job is stopped and reports why. Ordinary SDK, desktop, channel, RPC and TUI sessions have no automatic deadline; a command may still specify its own timeout.

**Visibility.** Every session that loads the extension gets both tools, so a long command never blocks the conversation that started it. A job also needs the tool that ends it: a DM, or a chat whose `tools` list removes `background_stop`, keeps `bash` but refuses `run_in_background`, instead of starting a command nobody could stop. See [Channels](channels.md#group-workspaces-memory-and-tools).

**Shell.** A background command runs through the session's execution environment, which supplies the working directory and the authority. `background({ shellPath })` picks the shell for a local session (the CLI passes the resolved `shellPath` setting); an environment that is not local runs the command itself and chooses its own shell. The CLI loads the extension by default; the SDK loads it explicitly with `import { background } from '@glows777/vela'` (or from `@glows777/vela-core`), then `createVela({ extensions: [background()] })`. That one entry makes `run_in_background` work and gives the session `background_output` and `background_stop`.

## todo

A task checklist the model keeps up to date. The model sends the complete list on every call, so the last `todo` call in a session is the current list; reloading or resuming a session reads it back from history. Nothing else is stored, and no new event type is involved: the tool result's details carry `{ items }` on `tool_execution_end`.

**Tool.** `todo`, with one parameter:

| Parameter | Description |
|---|---|
| `items` | The complete list, in order: `{ text, status }` with `status` one of `pending`, `in_progress`, `done`. An empty list clears it |

The model gets a one-line count summary back, not a copy of the list it just sent.

**Prompt.** The tool description asks the model to use it for multi-step work, keep at most one item in progress, and skip it for a single simple step.

**Lark progress card.** The shared progress card shows the current list above the tool rows: `☐` pending, `◐` in progress, `☑` done. A new run in the same topic starts from the list stored in the session, so a follow-up that makes no `todo` call still shows it, including after a restart. More than ten items are cut off with `… and N more`; the full list stays in the session.

**SDK.** `todo()` takes no options. The CLI loads it by default; the SDK loads it explicitly.

## web

**Tools.**

| Tool | Parameters | Description |
|---|---|---|
| `web_fetch` | `url` | Fetch a page and convert it to Markdown (scripts, styles, navigation, headers, footers and iframes removed); 15-second timeout; reads at most 5 MB of the response and notes when it cut the page |
| `web_search` | `query`, `max_results` (default 5) | Search the web |

When the current model offers a supported provider-hosted search and `web_search` is available, Vela uses it without a separate search key. Otherwise it uses [Tavily](https://tavily.com) or [Serper](https://serper.dev); Tavily wins if both keys are set. A hosted search may incur provider search charges in addition to token charges; Vela's token cost estimate does not include those charges.

A matching `tool_call` extension hook prevents hosted substitution because the provider's internal query cannot be intercepted. Vela uses a configured independent provider instead; without one, search is unavailable. A user extension can then confirm or block each local call. Disabled or unselected tools remain unavailable.

Enabled channel chats can call both tools. Remove either one from the session's `tools` selection.

**SDK.** `web({ tavilyKey, serperKey })`; both are optional.

## lark

Connects a Lark (Lark) bot to Vela over Lark's long connection. Each enabled chat has one shared session. All members are trusted with bash, files, memory and extension tools.

| Option | Config key | Description |
|---|---|---|
| `appId` | `extensionConfig.lark.appId` | Lark app id |
| `appSecret` | `extensionConfig.lark.appSecret` | Lark app secret |
| `owners` | `extensionConfig.lark.owners` | `open_id`s whose direct chats are always enabled; array or comma-separated string |
| `chats` | `extensionConfig.lark.chats` | Enabled chat_ids; array or comma-separated string. All members get full access |
| `transport` | | SDK only: the connection to Lark (`LarkTransport`); default Lark's long connection. Tests pass a fake |

It registers no tools or commands. Setup and behavior are described in [Channels](channels.md#lark).

**SDK.** `lark({ appId, appSecret, owners, chats })`.

## mcp

Connects to [MCP](https://modelcontextprotocol.io) servers configured under `mcpServers` in `~/.vela/config.json` and the trusted project's `.vela/config.json`, in the `mcpServers` format of Claude Desktop and Claude Code, and registers their tools as `mcp__<server>__<tool>`. Tools are deferred by default: the system prompt names each server and the model loads its tools with `tool_search`. `/mcp` shows each server's state and `/mcp reconnect <server>` reconnects one. In the SDK, pass the servers: `mcp({ servers: { docs: { url: 'https://example.com/mcp' } } })`. See [MCP servers](mcp.md).
