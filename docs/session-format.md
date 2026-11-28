# Session format and export

Vela persists active sessions in SQLite (`$VELA_DIR/vela.db` in the CLI, or `<agentDir>/vela.db` in `createRuntime({ agentDir })`: `sessions`, `vela_messages`, `vela_tool_calls`, `runs`, `approvals`, `usage_records`) rather than per-session JSONL files on disk. The append-only JSONL tree layout below describes the **export format** written by `runtime.sessions.export(id, 'jsonl')` (compatible with pi's session format) and the logical entry tree stored in `vela_messages`.

Like pi, entries form a tree: each entry names its `parentId`, and moving back to an earlier entry ([`/tree`](sessions.md#session-tree)) and continuing from there starts a new branch without deleting prior entries. A summary does not delete the messages it replaces; it adds a `compaction` entry, and the model context is rebuilt from the entries of the current branch when a session is resumed.

The entry and export format is part of Vela's public API. See [Sessions](sessions.md) for behavior and [SDK](sdk.md#session-storage) for storage details.

Source, in `packages/vela/src/driver/session/`: `entries.ts` (entry types, rebuilding the context), `db-store.ts` (SQLite mapping and queries), `seed-clone.ts` (fork/clone copying), and `index.ts` (appending and loading).

## Database vs JSONL export

```text
$VELA_DIR/vela.db                     CLI SQLite database (or SDK <agentDir>/vela.db / <dataDir>/vela.db)
<dataDir>/sessions/<id>/tool-results/ environment-allocated spilled tool outputs
```

In the CLI, `vela.db` lives at `$VELA_DIR/vela.db` (`~/.vela/vela.db`), while `<dataDir>` is the [project data directory](settings.md#data-directory) under `~/.vela/projects/` for spilled tool outputs and per-project memory. `<id>` is the session id (letters, digits, `.`, `_`, `-`; see [Sessions](sessions.md#session-ids-and-storage)). Opening and closing an empty session leaves no rows in `vela.db`; the first conversation entry or explicit location move persists the session row. Call `session.exportJsonl(path)` to write a single branch as an exported `.jsonl` file starting with a `SessionHeader` line.

## Header

The first line:

```typescript
interface SessionHeader {
  type: 'session'
  version: number          // format version, see Versions
  id: string               // session id
  timestamp: string        // when the session was created (ISO)
  cwd?: string             // working directory
  location?: ExecutionLocation
  channel?: string         // channel the session answers on, when a host opened it for one
  parentSession?: string   // id of the session this one was forked or cloned from
}
```

The header records the initial location. Local sessions start with `{ environment: 'local', cwd }`. A trusted move persists the active location on `sessions.location_json` in `vela.db` (and per-entry `vela_messages.location_json` / `vela_tool_calls.location_json`). `resume()` restores the saved session location across restarts, and a record without `location` uses the caller's local cwd or the default local cwd when there is no saved move. `exportJsonl()`, `fork()` and `clone()` copy the active location into the exported header / new session.

## Entries

In `vela_messages`, each row carries its tree `id`, `parent_id`, `seq`, `created_at`, `label`, `choice_json` (per-entry model and thinking level), and `location_json`, plus `kind` and `content_json`. In `exportJsonl()`, the exported lines map as follows:

| Field | Description |
|---|---|
| `type` | The entry type, below |
| `id` | 8 hex characters, unique in the session |
| `parentId` | The entry this one follows (`null` for a root). New entries are children of the session's current leaf, so entries with the same parent are branches |
| `timestamp` | When the entry was appended (ISO) |

| `type` | Fields | Description |
|---|---|---|
| `message` | `message`, `stopReason?`, `details?`, `producedBy?` | A message entered the conversation (user input, assistant reply, tool results). `message` is a Vela `ModelMessage` (see [Messages](#messages)). `stopReason` (`aborted` or `error`) marks an assistant message cut off while it streamed: kept in storage for inspection, never sent to the model again. `details` is on a tool message whose tools returned display data (`tool_execution_end`'s `details`, such as `edit`'s diff), by tool call id; not sent to the model. `producedBy` is on an assistant message: the model that produced it (`provider/modelId`), so reasoning from another model is omitted on switch |
| `bash_execution` | `command`, `output`, `exitCode?`, `cancelled`, `truncated`, `fullOutputPath?`, `excludeFromContext?`, `backgroundTaskId?` | A command the user ran with `!` / `!!` or `session.executeBash()`. `output` is the last 2,000 lines or 50 KB; when `truncated`, `fullOutputPath` has the whole output. The model gets it as a user message unless `excludeFromContext` (`!!`) is set |
| `compaction` | `summary`, `firstKeptEntryId`, `tokensBefore` | Earlier history was summarized. The model context becomes the summary followed by entries from `firstKeptEntryId` onward |
| `branch_summary` | `fromId`, `summary` | A summary of the branch the session left with `navigateTree(..., { summarize: true })` (`/tree` -> summarize), sent as `[Summary of the conversation branch you left]` |
| `custom_message` | `customType`, `content`, `display`, `details?` | An extension's `session.sendMessage()` entry. Context gets it as a user message; `details` is stored verbatim in `vela_messages.details_json` |
| `custom` | `customType`, `data?` | Extension state from `session.appendEntry()`. Not part of the model context |

Metadata such as model choice, thinking level, display name, `archived`, `channel`, and active `leaf_message_id` live directly on the `sessions` table in `vela.db` (and per-entry model/thinking snapshots live in `vela_messages.choice_json`), while labels live on `vela_messages.label`.

### Rebuilding the context

`resume()` rebuilds the model context like pi's `buildSessionContext`:

1. Take the current branch: the entries from `sessions.leaf_message_id` back to the root along `parent_id`.
2. Take the branch's latest `compaction` entry, if any: the context starts with its summary message, then the entries from `firstKeptEntryId` up to the compaction, then those after it. Without a compaction, the whole branch.
3. Keep `message` entries (leaving out those with a `stopReason`), and `custom_message`, `branch_summary` and `bash_execution` entries (as user messages; a `bash_execution` with `excludeFromContext` is left out).

Model and thinking level restore from `sessions.model` / `sessions.thinking_level` (or per-branch `vela_messages.choice_json` when navigating with `/tree`); display name lives on `sessions.name`.

### Forks and clones

`session.fork()`, `session.clone()` and `--fork` create a new session row in `vela.db` seeded from the selected branch: entries from the root to the fork point are re-chained, `sessions.parent_session_id` records the source session, `sessions.location_json` keeps the active location, completed `vela_tool_calls` rows on that branch are cloned into the new session, and spilled output files are copied safely into the new session's spill directory / environment.

`session.exportJsonl()` writes the current branch as an append-only JSONL file (header + entries), keeping `location`.

## Versions

`SESSION_FORMAT_VERSION` is the version Vela writes for JSONL exports (`2`). Database schema migrations live in `packages/vela/src/db/migrations.ts` (`SCHEMA_VERSION`).

## Messages

Messages are Vela `ModelMessage` values. Assistant messages and text-only user messages match the AI SDK shapes below. User messages and tool-result content can also contain Vela inline image parts; those require provider conversion.

```json
{"role":"user","content":[{"type":"text","text":"What is in this picture?"},{"type":"image","data":"<base64>","mimeType":"image/png"}]}
{"role":"user","content":"What does notes.txt say?"}
{"role":"assistant","content":[{"type":"text","text":"Let me check."},{"type":"tool_call","toolCallId":"call_1","toolName":"read","input":{"path":"notes.txt"}}]}
{"role":"tool","content":[{"type":"tool_result","toolCallId":"call_1","toolName":"read","output":{"type":"text","value":"Ship the docs on Friday."}}]}
{"role":"assistant","content":[{"type":"reasoning","text":"..."},{"type":"text","text":"The note says: ship the docs on Friday."}]}
```

- `user` content is a string or an array of parts. An inline image part is `{ "type": "image", "data": "<base64>", "mimeType": "image/png" }`. `data` is base64. `mimeType` is a media type such as `image/png`. The AI SDK image part `{ type: 'image', image, mediaType }` is deprecated in ai@7. Map each stored image part to the file part `{ type: 'file', data, mediaType }`. Vela does that mapping on the provider request and leaves the saved image in place. See [Image input](sdk.md#image-input).
- `assistant` content is a list of `text`, `reasoning` and `tool-call` parts. Provider-specific `providerOptions` may appear on parts.
- `tool` content is a list of `tool-result` parts. Ordinary outputs use AI SDK shapes, such as `{ "type": "text", "value": "..." }`. Image-bearing outputs use `{ "type": "content", "value": [...] }` with ordered text and Vela image parts (`type`, `data`, `mimeType`); failed content also has `isError: true`. Vela adapts these at request time to native provider tool images or a following user image message, without changing saved history. See [Tool image results](sdk.md#tool-images).

Vela adds two conventions on top:

**Stored tool results.** A new result that is too long is plain text. Vela saves the full output under `tool-results/`. The tool message keeps a preview plus one recovery line:

```json
{"type":"text","value":"first part of the output ...\n\n[Full output: /.../sessions/demo/tool-results/0b6c....txt; use read with offset to read the rest.]"}
```

The model sees that text. Bash keeps its tail preview and adds a path only when truncated. See [Result size and truncation](tools.md#result-size-and-truncation).

Older records can hold this JSON reference:

```json
{"type":"json","value":{"kind":"vela-tool-result","path":"/.../sessions/demo/tool-results/0b6c....txt","bytes":48213,"preview":"first and last part of the output ...","read":"Only a preview is shown. Use read with path, offset ..."}}
```

Resume loads that JSON. In the model request, Vela sends `preview` as text. When that preview contains `[preview: first ` or `[tool result preview omitted; original available at path]`, Vela appends the Full-output recovery line.

**Summaries.** After a compaction, the model context starts with a user message whose content is `[Summary of the earlier conversation]` followed by the `compaction` entry's summary. The free-text summary has the sections Goal, Constraints & Preferences, Progress (Done / In Progress / Blocked), Key Decisions, Next Steps and Critical Context. Code appends nonempty `<read-files>` and `<modified-files>` lists from recorded tool calls in `vela_tool_calls`. This message is not stored as a `message` entry. It is rebuilt from the `compaction` entry.

## Tool call history

Tool calls and execution states are persisted in `$VELA_DIR/vela.db` (or SDK `<agentDir>/vela.db` / `<dataDir>/vela.db`, table `vela_tool_calls`), while full spilled tool outputs live under:

```
<dataDir>/sessions/<id>/tool-results/<callId>.txt
```

`--no-session` (`ephemeralSessions: true`) uses an in-memory SQLite database and a temporary directory for spilled tool outputs removed when the session closes.

Each row in `vela_tool_calls` tracks `status` (`pending`, `running`, `awaiting_approval`, `completed`, `failed`, `skipped`, `interrupted`), `execution_mode`, `replay`, `location_json`, `input_json`, `attempt`, `preview`, `result_json`, `spill_path`, and `details_json`. Suspended human approvals are tracked alongside it in the `approvals` table (`tool_call_row_id`).

## Example

An exported JSONL branch where the user asked one question and the model read a file:

```json
{"type":"session","version":2,"id":"notes","timestamp":"2026-10-08T10:50:32.570Z","cwd":"/home/me/app","location":{"environment":"local","cwd":"/home/me/app"}}
{"type":"message","message":{"role":"user","content":"What does notes.txt say?"},"id":"a3c90e12","parentId":null,"timestamp":"2026-10-08T10:50:32.574Z"}
{"type":"message","message":{"role":"assistant","content":[{"type":"tool_call","toolCallId":"call_1","toolName":"read","input":{"path":"notes.txt"}}]},"producedBy":"openai.responses/gpt-5","id":"77d2f0b4","parentId":"a3c90e12","timestamp":"2026-10-08T10:50:32.640Z"}
{"type":"message","message":{"role":"tool","content":[{"type":"tool_result","toolCallId":"call_1","toolName":"read","output":{"type":"text","value":"Ship the docs on Friday.\n"}}]},"id":"c01b9a6e","parentId":"77d2f0b4","timestamp":"2026-10-08T10:50:32.646Z"}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"The note says: ship the docs on Friday."}]},"producedBy":"openai.responses/gpt-5","id":"e5a8d3f7","parentId":"c01b9a6e","timestamp":"2026-10-08T10:50:32.648Z"}
```

## Reading sessions from code

Sessions are persisted in SQLite (`$VELA_DIR/vela.db` in the CLI, or `<agentDir>/vela.db` / `<dataDir>/vela.db` in the SDK). An open session returns its entries with `session.getEntries()`, its current branch with `session.getBranch()`, and the whole tree with `session.getTree()`; exported `.jsonl` branches can still be written with `session.exportJsonl(path)`.
