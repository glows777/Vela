# Built-in extensions

Vela ships five extensions: `memory`, `rag`, `web`, `feishu` and `mcp`. They use the same extension API as your own extensions (see [Extensions](extensions.md)); they are just bundled with the package.

| Extension | Adds |
|---|---|
| `memory` | Cross-session memory: the `memory` tool, a memory index sent as a message, `/memory` and `/dream` |
| `rag` | Local knowledge base: `rag_ingest`, `rag_search`, a knowledge base summary sent as a message, `/rag` |
| `web` | `web_fetch`, and `web_search` when a search API key is set |
| `feishu` | The Feishu bot channel (see [Channels](channels.md)) |
| `mcp` | Tools of MCP servers, as `mcp__<server>__<tool>`, and `/mcp` (see [MCP servers](mcp.md)) |

## Loading

**CLI.** All five load by default, before any discovered or `-e` extensions. Some capabilities stay off until configured: `rag` registers only `/rag` without an embedding API and stays quiet at startup (`/rag` explains the missing configuration), `web` registers only `web_fetch` without a search key, `feishu` registers its channel but does not connect without an app id and secret, and `mcp` connects nothing until servers are configured.

To turn one off, add `-builtin:<name>` to `extensions` in `settings.json`, for example `"extensions": ["-builtin:feishu"]`. `--no-extensions` skips them, and `-e builtin:<name>` loads a single one for a run. The full rules are in [Extensions](extensions.md#where-extensions-load-from). `/extensions` in interactive mode lists the loaded extensions and what each registered.

**SDK.** `createVela()` loads no extensions by default. Import the factories and pass them in `extensions`:

```ts
import { createEmbedder, createVela, memory, rag, web } from '@glows777/vela'

const vela = createVela({
  dataDir: '.vela-data',
  extensions: [
    memory(),
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

Factory options take precedence. An option you leave out is read from the extension's config section, `extensionConfig.<name>`, which you can pass to `createVela({ extensionConfig })`.

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

Extension tools are prefixed with the extension name: the `rag` extension's `search` tool is `rag_search`. A tool whose name equals the extension name is not prefixed, so the memory tool is `memory`, not `memory_memory`; nor is one that already starts with the prefix, so MCP tools are `mcp__<server>__<tool>`. See [Extensions](extensions.md).

Only `rag_search` and `web_search` (and `tool_search`) are available to `guest` sessions; MCP tools are not. See [Security](security.md#core-sdk-session-roles).

## Data

Built-ins store their data in the project data directory: in the CLI, the [project data directory](settings.md#data-directory) under `~/.vela/projects/`; in the SDK, `dataDir`. Without `dataDir`, the SDK uses a temporary directory that `vela.dispose()` deletes.

| Extension | Location |
|---|---|
| `memory` | `<dataDir>/memory/` |
| `rag` | `<dataDir>/rag/knowledge.db` |

## memory

Long-term memory across sessions. Each memory is a Markdown file with front matter (`name`, `description`, `type`, `lastWriteAt`, `lastReadAt`), named `<type>_<slug>.md`. `MEMORY.md` is an index with one line per memory (at most 200 lines; the oldest line is dropped when it is full). Memory files and the index are written with mode `0600` in a `0700` directory; a store written by an older version is tightened when it opens.

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

`type` is one of `user`, `feedback`, `project` or `reference`. Memory content returned to the model is cut at 4,000 characters.

`lint` reports paths mentioned in a memory that no longer exist, memories not read within their type's shelf life, and duplicate names.

**Prompt.** The short usage rules stay in the system prompt. The index is sent as a message after the user message whenever it changed, so saving a memory does not rewrite the cached system prompt; it is sent again after compaction removed the old one, and deleting the last entry sends an empty-store update. Guest sessions get neither the rules, the index nor the tool.

**Commands.**

| Command | Description |
|---|---|
| `/memory` | List memories, marking those with lint warnings |
| `/memory search <keywords>` | Search memories |
| `/memory lint` | Show the lint report |
| `/dream` | Ask the model to clean up the store: delete stale entries, merge duplicates, fix descriptions |

Extension commands run only in `owner` sessions; in other sessions the text goes to the model as a normal message.

**SDK.** `memory()` takes no options.

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

`web_search` is registered only when a key is set. With a Tavily key it uses [Tavily](https://tavily.com) and returns an answer summary plus page content; with a Serper key it uses [Serper](https://serper.dev) and returns Google result snippets. If both are set, Tavily is used.

A `guest` session can use `web_search` but not `web_fetch`. An enabled channel chat defaults to `owner` and can call `web_fetch`.

**SDK.** `web({ tavilyKey, serperKey })`; both are optional.

## feishu

Connects a Feishu (Lark) bot to Vela over Feishu's long connection. Each enabled chat has one shared owner session. All members are trusted with bash, files, memory and extension tools.

| Option | Config key | Description |
|---|---|---|
| `appId` | `extensionConfig.feishu.appId` | Feishu app id |
| `appSecret` | `extensionConfig.feishu.appSecret` | Feishu app secret |
| `owners` | `extensionConfig.feishu.owners` | `open_id`s whose direct chats are always enabled; array or comma-separated string |
| `chats` | `extensionConfig.feishu.chats` | Enabled chat_ids; array or comma-separated string. All members get owner access |
| `transport` | | SDK only: the connection to Feishu (`FeishuTransport`); default Feishu's long connection. Tests pass a fake |

It registers no tools or commands. Setup and behavior are described in [Channels](channels.md#feishu).

**SDK.** `feishu({ appId, appSecret, owners, chats })`.

## mcp

Connects to [MCP](https://modelcontextprotocol.io) servers configured in `~/.vela/mcp.json` and the trusted project's `.vela/mcp.json`, in the `mcpServers` format of Claude Desktop and Claude Code, and registers their tools as `mcp__<server>__<tool>`. Tools are deferred by default: the system prompt names each server and the model loads its tools with `tool_search`. `/mcp` shows each server's state and `/mcp reconnect <server>` reconnects one. In the SDK, pass the servers: `mcp({ servers: { docs: { url: 'https://example.com/mcp' } } })`. See [MCP servers](mcp.md).
