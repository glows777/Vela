# Built-in extensions

Vela ships seven selectable built-in extensions: `background`, `memory`, `todo`, `rag`, `web`, `lark`, and `mcp`. They use the same extension API as your own extensions (see [Extensions](extensions.md)). `background`, `memory`, `todo` and `web` are part of `@glows777/vela-core`; `rag`, `lark` and `mcp` are the packages `@glows777/vela-rag`, `@glows777/vela-lark` and `@glows777/vela-mcp`. `@glows777/vela` and the CLI include all seven (see [Packages](sdk.md#packages)).

| Extension | Adds |
|---|---|
| `background` | Long-running commands whose result arrives on its own: `bash` with `run_in_background`, plus `background_output` and `background_stop` |
| `memory` | Cross-session memory: the `memory` tool, a memory index sent as a message, `/memory` and `/dream` |
| `todo` | Task checklist: the `todo` tool, shown on the Lark progress card |
| `rag` | Local knowledge base: `rag_ingest`, `rag_search`, a knowledge base summary sent as a message, `/rag` |
| `web` | `web_fetch`, and `web_search` with a supported hosted search or a search API key |
| `lark` | The Lark bot channel (see [Channels](channels.md)) |
| `mcp` | Tools of MCP servers, as `mcp__<server>__<tool>`, and `/mcp` (see [MCP servers](mcp.md)) |

## Local transport

Vela also ships `local` in `@glows777/vela-channels`, re-exported by `@glows777/vela`. It is an explicitly enabled transport, not another `builtin:*` selector or a default CLI extension. It provides authenticated loopback HTTP/SSE for project hubs, task sessions, visible history and run-bound Stop. Lark and Local share the channel gateway and topic tools.

In the CLI, enable it only through user-level `extensionConfig.local: { "enabled": true, "token": "$VELA_LOCAL_TOKEN", "port": 8788 }` and run `vela serve`. Project settings cannot enable or override it; non-serve modes and `--no-extensions` do not start it. In the SDK, add `local({ token, port: 8788 })` explicitly, then call `await vela.ready()` and `await vela.startChannels()`. Unlike the factories below, Local requires its token as a factory option and does not read it implicitly from extension configuration.

Local binds only `127.0.0.1`, with Bearer authentication and no CORS/cookie support. Its token grants the daemon's tool authority. Do not tunnel it or share the webhook listener's port (8787). See [Local](channels.md#local) for setup, security, the HTTP/SSE protocol and runnable client examples.

## Loading

**CLI.** All seven load by default, before any discovered or `-e` extensions. Some capabilities stay off until configured: `rag` registers only `/rag` without an embedding API and stays quiet at startup (`/rag` explains the missing configuration), `web` registers only `web_fetch` without a search key, `lark` registers its channel but does not connect without an app id and secret, and `mcp` connects nothing until servers are configured.

To turn one off, add `-builtin:<name>` to `extensions` in `settings.json`, for example `"extensions": ["-builtin:lark"]`. `--no-extensions` skips them. The full rules are in [Extensions](extensions.md#where-extensions-load-from). `/extensions` in interactive mode lists the loaded extensions and what each registered.

**SDK.** `createVela()` loads no extensions by default. Import the factories and pass them in `extensions`:

```ts
import {
  background,
  createEmbedder,
  createVela,
  memory,
  todo,
  rag,
  web,
} from '@glows777/vela'

const vela = createVela({
  dataDir: '.vela-data',
  extensions: [
    background(),
    memory(),
    todo(),
    rag({
      embedder: createEmbedder({
        url: 'https://api.openai.com/v1',
        modelId: 'text-embedding-3-small',
        apiKey: process.env.OPENAI_API_KEY!,
      }),
    }),
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
    "web": { "tavilyKey": "$TAVILY_API_KEY" },
    "rag": {
      "embedding": {
        "baseUrl": "https://api.openai.com/v1",
        "model": "text-embedding-3-small",
        "apiKey": "$OPENAI_API_KEY"
      }
    }
  }
}
```

## Tool names

Extension tools are prefixed with the extension name: the `rag` extension's `search` tool is `rag_search`. A tool whose name equals the extension name is not prefixed, so the memory tool is `memory`, not `memory_memory`, and the todo tool is `todo`; nor is one that already starts with the prefix, so MCP tools are `mcp__<server>__<tool>`. See [Extensions](extensions.md).

Remove any of them from the session's `tools` selection; see [Security](security.md#limit-tools).

## Data

Built-ins store their data in the project data directory: in the CLI, the [project data directory](settings.md#data-directory) under `~/.vela/projects/`; in the SDK, `dataDir`. Without `dataDir`, the SDK uses a temporary directory that `vela.dispose()` deletes.

| Extension | Location |
|---|---|
| `memory` | `<dataDir>/memory/` |
| `rag` | `<dataDir>/rag/knowledge.db` |

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

**Tools.** `background_output` and `background_stop` come with the extension, which the CLI loads by default; a chat's narrowed `tools` list or an explicit `tools` selection can drop them, and a DM drops them. `run_in_background` has no tool of its own: loading the extension installs the session's job table, which `bash` reaches through `ToolContext`. The job table owns the ids, the output tails and the deliveries, so `bash` and these two tools cannot disagree about a job.

| Tool | Parameters | Behavior |
|---|---|---|
| `bash` | `command`, `run_in_background: true` | Starts the command in the session's execution environment and returns at once with its id (for example `bg-1`) and any output it already wrote. A host that cannot record the job fails the call before the command starts; an execution failure after that arrives as the job result. |
| `background_output` | `id` | The command's state (`running` or `exited`) and its output tail: the last 2,000 lines or 50KB, whichever is hit first |
| `background_stop` | `id` | Aborts the command through the session's execution environment and returns its final output tail. The local implementation terminates the process group immediately. |

**Output.** The tail kept for the model stays bounded (the last 2,000 lines or 50 KB), and `background_output` reads it while the command runs. When the output passes those limits, the session's execution environment spills the complete output to its own file, and the exit delivery and `background_output` name it (`Full output: <path>`), so `read_file` pages all of it — including in a session whose environment is not the host.

**Delivery.** When a command exits on its own, the session gets one message with the exit state, the command head and the output tail. A stop never delivers: `background_stop` returns the tail in its tool result, and Stop, session close and shutdown have no run left to answer. In the CLI and SDK it is a hidden custom message (`customType: background`) that starts a turn, or joins the current run as a follow-up, so the model never polls. In a channel the result enters that conversation's gateway queue like any other input: it is answered as a new reply in its topic, or in the group's main timeline as a reply to the person's last message, with the usual anchor, card, reaction and Stop. A silent topic evaluation needs no special case, and an explicit answer never merges into a passive one.

**Lifecycle.** Commands belong to their session, and a channel conversation with a running command is not closed as idle, so a quiet conversation cannot kill a long build. `background_stop`, Stop (an aborted run), `session.close()` and process shutdown stop active execution without delivering its exit directly. In hosted group/topic sessions, process shutdown preserves outstanding job identities so startup sends an unknown-result notice; explicit Stop/close clears them. A normal completion counts as delivered only after its result input is saved. Hostless sessions retain the existing lost-id behavior. A job is forgotten once its result has been delivered or returned by `background_stop`, so asking again for that id, or asking after a restart, answers `Unknown background command … It may have finished and its result was delivered (or returned by background_stop), or it ended with a restart or session close.` The tail stays in memory (oldest bytes dropped first), so a command that prints forever costs at most that buffer, while the whole output remains in the file named at start.

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

## rag

A local knowledge base with hybrid search, stored in SQLite.

**Tools.**

| Tool | Parameters | Description |
|---|---|---|
| `rag_ingest` | `path` | Read a text file (relative to the working directory), chunk it, embed the chunks and store them |
| `rag_search` | `query`, `top_k` (default 5) | Search the knowledge base; each result shows its source, scores and up to 500 characters |

**Prompt.** When the knowledge base is not empty, a message after the user message says how many chunks it holds, lists the sources, and points the model to `rag_search`. It is sent again only when the count or the sources change, so the cached system prompt stays stable.

**Commands.** `/rag` shows the number of chunks, the sources and the embedder. `/rag ingest <path>` ingests a file. `/rag clear` deletes every chunk. Without embedding configuration, `/rag` (including `ingest` or `clear` arguments) explains how to configure it without calling a model or touching the database. `/extensions` lists the command through normal extension discovery.

**Embeddings.** rag needs an embedding function. With the CLI, set `extensionConfig.rag.embedding` with `baseUrl`, `model` and `apiKey` (or `EMBEDDING_MODEL_BASE_URL`, `EMBEDDING_MODEL` and `EMBEDDING_MODEL_KEY`); any OpenAI-compatible embeddings API works. Vectors have 128 dimensions, so the model must support the `dimensions` parameter. If any of the three values is missing, startup stays quiet and only `/rag` is registered. It points to `extensionConfig.rag.embedding` in `~/.vela/settings.json` (or `$VELA_DIR/settings.json`) and the environment variables above. See [extension settings](settings.md#extensionconfig).

With the SDK, pass an embedder: `rag({ embedder: createEmbedder({ url, modelId, apiKey }) })`. An embedder is any function `(texts: string[], signal?: AbortSignal) => Promise<number[][]>` that returns 128-dimension vectors. For offline tests, use `createFauxEmbedder()` from `@glows777/vela/testing`.

**Changing the embedder.** Vectors from different embedding models can't be compared, so the knowledge base records which embedder built it: the function's `id` property. `createEmbedder()` sets it to `<model> at <baseUrl>`, `createFauxEmbedder()` to `faux` (or its `id` option), and a function without one is recorded as `custom`. When the configured embedder differs from the recorded one, `rag_ingest`, `rag_search` and `/rag ingest` fail with an error naming both, and `/rag` shows the mismatch. Switch back, or run `/rag clear` and ingest the documents again. An empty knowledge base takes whichever embedder is configured. A knowledge base built before Vela 0.2.0 has no record: Vela assumes the configured embedder, records it and logs a warning.

**How it works.**

- Chunking: the text is split on blank lines and paragraphs are packed into chunks of about 1,000 characters (256 estimated tokens). Longer paragraphs are split on sentence boundaries.
- Storage: each chunk goes into a plain table, a [sqlite-vec](https://github.com/asg017/sqlite-vec) `vec0` table for vectors, and an FTS5 table for keywords. Chunks are keyed by source path, so ingesting a file again replaces all of its earlier chunks in one transaction.
- Search: vector search and BM25 keyword search each return up to `4 * top_k` candidates. Scores are min-max normalized and combined as `0.7 * vector + 0.3 * keyword`, then MMR picks `top_k` results that are relevant but not near-duplicates.

**SQLite and sqlite-vec.** rag loads the sqlite-vec extension, so the SQLite library must allow loading extensions.

- On Node, rag uses `node:sqlite`, whose bundled SQLite supports extensions. Nothing else is needed.
- On Bun, rag uses `bun:sqlite` with a custom SQLite library, because the system SQLite on macOS cannot load extensions. It uses the first of these that exists:
  - `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib` (macOS, Apple Silicon)
  - `/usr/local/opt/sqlite/lib/libsqlite3.dylib` (macOS, Intel)
  - `/usr/lib/x86_64-linux-gnu/libsqlite3.so.0` (Linux x64)
  - `/usr/lib/aarch64-linux-gnu/libsqlite3.so.0` (Linux ARM64)

  If none exists, loading fails with an error. On macOS, run `brew install sqlite`.

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

Connects to [MCP](https://modelcontextprotocol.io) servers configured in `~/.vela/mcp.json` and the trusted project's `.vela/mcp.json`, in the `mcpServers` format of Claude Desktop and Claude Code, and registers their tools as `mcp__<server>__<tool>`. Tools are deferred by default: the system prompt names each server and the model loads its tools with `tool_search`. `/mcp` shows each server's state and `/mcp reconnect <server>` reconnects one. In the SDK, pass the servers: `mcp({ servers: { docs: { url: 'https://example.com/mcp' } } })`. See [MCP servers](mcp.md).
