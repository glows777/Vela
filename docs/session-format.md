# Session file format

A Vela session file is an append-only JSONL log in pi's format: a header line, then one entry per line for every message, compaction, context edit and setting change, in the order they happened. Entries are never rewritten. Like pi, the entries form a tree: each entry names its parent, and moving back to an earlier entry ([`/tree`](sessions.md#session-tree)) and continuing from there starts a new branch in the same file. A summary does not delete the messages it replaces; it adds a `compaction` entry, and the model context is rebuilt from the entries of the current branch when a session is resumed.

The format is part of Vela's public API. See [Sessions](sessions.md) for behavior and [SDK](sdk.md#session-storage) for custom storage.

Source: `src/session/entries.ts` (entry types, rebuilding the context, migration), `src/session/storage.ts` (file and memory storage) and `src/session/index.ts` (appending and loading).

## File location

```
<dataDir>/sessions/<id>.jsonl
```

In the CLI, `<dataDir>` is the [project data directory](settings.md#data-directory) under `~/.vela/projects/`. `<id>` is the session id (letters, digits, `.`, `_`, `-`; see [Sessions](sessions.md#session-ids-and-storage)). Unlike pi (`<timestamp>_<uuid>.jsonl`), the file is named by the session id, which the caller chooses (`--session`, a channel, `vela.session(id)`).

Entries are appended as they happen; like pi, a session is written only once it has a user or assistant message, so opening a session and closing it leaves no file. Files are created with mode `0600` and the directory with `0700`. A line cut off by a crash is skipped when the file is read (and reported to the logger). A failed write is retried with the next entry; if the failed attempt had already written some entries, the repeated copies are ignored on resume (the first entry with an id counts). A file whose first entry is not a header (and not a version 1 file) fails to resume instead of being converted.

## Header

The first line:

```typescript
interface SessionHeader {
  type: 'session'
  version: number          // format version, see Versions
  id: string               // session id
  timestamp: string        // when the session was created (ISO)
  cwd?: string             // working directory
  toolHistoryId?: string   // @internal: the tool call history directory
  parentSession?: string   // id of the session this one was forked or cloned from
}
```

## Entries

Every other line is an entry. All entries have pi's base fields:

| Field | Description |
|---|---|
| `type` | The entry type, below |
| `id` | 8 hex characters, unique in the session |
| `parentId` | The entry this one follows (`null` for a root). New entries are children of the session's current leaf, so entries with the same parent are branches |
| `timestamp` | When the entry was appended (ISO) |

| `type` | Fields | Description |
|---|---|---|
| `message` | `message`, `stopReason?`, `nestedCalls?` | A message entered the conversation (user input, assistant reply, tool results, loop-detection reminders). `message` is an AI SDK `ModelMessage` (see [Messages](#messages)). `stopReason` (`aborted` or `error`) marks an assistant message cut off while it streamed: like pi, it is kept for the record but never sent to the model again. `nestedCalls` is on a tool message whose tools called other tools through `ctx.executeTool()`: by tool call id, `{ calls: [{ id, name, arguments?, argumentsBytes?, status, durationMs?, error? }], complete }` (pi's `nestedCalls`, with pi's limits: 256 calls, 8 KB of arguments per call and 32 KB in total, 500 characters of error); not sent to the model |
| `model_change` | `model` | The session's model, as `provider/id`. Written when a session starts with a model given by name and on `setModel()` with a name; `resume()` restores the latest |
| `thinking_level_change` | `thinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Written when a session starts and on `setThinkingLevel()`; `resume()` restores the latest |
| `session_info` | `name?` | The display name (`session.setName()`, `/name`); no `name` clears it |
| `compaction` | `summary`, `firstKeptEntryId`, `tokensBefore`, `toolHistoryViewSeq?` | Earlier history was summarized. The model context becomes the summary followed by the messages from `firstKeptEntryId` on (that entry is before the compaction; when it is the compaction itself, nothing was kept) and everything after the compaction. `tokensBefore` is the estimated context size before the summary |
| `context_edit` | `targetId`, `replacement` | pi's context edit: the model sees `replacement.content` instead of the content of message entry `targetId` (`replacement: null` leaves it out). Vela writes one when microcompaction folds old tool output into a file reference; the original output stays in the target entry |
| `branch_summary` | `fromId`, `summary` | A summary of the branch the session left with `navigateTree(…, { summarize: true })` (`/tree` → summarize). It is a child of the entry the session moved to, and the model sees it as a user message starting with `[Summary of the conversation branch you left]`. `fromId` is the leaf that was left (`root` if none) |
| `label` | `targetId`, `label?` | A bookmark on entry `targetId` (`/tree` → label, `session.setLabel()`); no `label` clears it. Not sent to the model |

Entries of other types (from a newer Vela or an extension) are kept and ignored.

### Rebuilding the context

`resume()` rebuilds the model context like pi's `buildSessionContext`:

1. Take the current branch: the entries from the leaf back to the root along `parentId`. When a session is loaded, the leaf is the last entry in the file (like pi; moving the leaf without appending anything afterwards is not remembered).
2. Take the branch's latest `compaction` entry, if any: the context starts with its summary message, then the entries from `firstKeptEntryId` up to the compaction, then those after it. Without a compaction, the whole branch.
3. Apply the branch's `context_edit` entries to their targets.
4. Keep `message` entries (leaving out those with a `stopReason`) and `branch_summary` entries (as user messages).

The model and thinking level are the latest `model_change` and `thinking_level_change` on the branch; the name is the latest `session_info` in the whole file (like pi, it belongs to the session).

### Forks and clones

`session.fork()`, `session.clone()` and `--fork` write a new session file holding one branch of the original: the entries from the root to the fork point, re-chained without `label` entries, followed by fresh `label` entries for the labels on that path (pi's `createBranchedSession`). The header's `parentSession` is the original's id. The tool call history is copied into the new session's directory under a new `toolHistoryId`; long tool output files are not copied, and references to them keep pointing into the original session's directory.

`session.exportJsonl()` writes the same kind of file for the current branch (header and entries, re-chained), without `toolHistoryId`.

## Versions

`SESSION_FORMAT_VERSION` is the version Vela writes. The current version is `2`. Branching did not change the version: pi's version 2 is already a tree, and a file with one branch is a valid tree. (Builds of Vela from before session trees would read a file with several branches as one long conversation; no released version writes branches.)

- A header with a higher version than this Vela supports fails to resume with an error asking you to upgrade Vela.
- Version 1 files (Vela 0.1: one `checkpoint` line holding the whole history after compaction, or the even older one message per line) are converted when the file storage loads them, and the file is rewritten as version 2 (written to a temp file and renamed over it). Messages become `message` entries, the checkpoint's model, thinking level and name become entries, and a compacted checkpoint (its first message is the summary) becomes its kept messages followed by a `compaction` entry, which rebuilds the same context. A custom storage holding version 1 data can convert it with `migrateSessionV1(id, lines)`.

## Messages

Messages are AI SDK `ModelMessage` values, stored as the AI SDK produces them. The common shapes:

```json
{"role":"user","content":"What does notes.txt say?"}
{"role":"assistant","content":[{"type":"text","text":"Let me check."},{"type":"tool-call","toolCallId":"call_1","toolName":"read_file","input":{"path":"notes.txt"}}]}
{"role":"tool","content":[{"type":"tool-result","toolCallId":"call_1","toolName":"read_file","output":{"type":"text","value":"Ship the docs on Friday."}}]}
{"role":"assistant","content":[{"type":"reasoning","text":"..."},{"type":"text","text":"The note says: ship the docs on Friday."}]}
```

- `user` content is a string (or AI SDK content parts).
- `assistant` content is a list of `text`, `reasoning` and `tool-call` parts. Provider-specific `providerOptions` may appear on parts.
- `tool` content is a list of `tool-result` parts. `output` is an AI SDK tool result output, usually `{ "type": "text", "value": "..." }`.

Vela adds two conventions on top:

**Stored tool results.** When a tool result is too long, or was folded by microcompaction, its output is a JSON reference to a file with the full text:

```json
{"type":"json","value":{"kind":"vela-tool-result","path":"/.../sessions/demo/tool-results/0b6c....txt","indexPath":"/.../tool-history.jsonl","bytes":48213,"preview":"first and last part of the output ...","read":"Only a preview is shown. Use read_file with path, offset ..."}}
```

`preview` is what the model sees; `path` is the full output.

**Summaries.** After a compaction, the model context starts with a user message whose content is `[Summary of the earlier conversation]` followed by the `compaction` entry's summary: the summary sections (User goal, Completed, Pending, Constraints, Key facts) and a guide to the tool call history. This message is not stored as a `message` entry; it is rebuilt from the `compaction` entry.

Loop-detection reminders are user messages starting with `[system message]`.

## Tool call history

Next to the session file, each session has a directory:

```
<dataDir>/sessions/<id>/
  tool-results/<callId>.txt               full output of long tool results
  <historyId>/tool-history.jsonl          every tool call and result, append-only
  <historyId>/snapshots/through-<seq>.jsonl  fixed views of the history at a summary
```

`tool-history.jsonl` has one record per line, numbered by `seq`:

```json
{"type":"tool_call","callId":"d3296c41-...","toolCallId":"call_1","toolName":"read_file","input":{"path":"notes.txt"},"plannedOutputPath":"/.../tool-results/d3296c41-....txt","version":1,"seq":1,"timestamp":"2026-10-08T10:50:32.614Z"}
{"type":"tool_result","callId":"d3296c41-...","status":"completed","durationMs":7.9,"output":"Ship the docs on Friday.","version":1,"seq":2,"timestamp":"2026-10-08T10:50:32.627Z"}
```

`tool_result.status` is `completed`, `failed`, `cancelled` or `rejected`; the body is in `output` or, for long output, in the file at `outputPath`. Execution details (`exitCode`, `signal`, `isError`, `timedOut`, `error`) are included when known. A `tool_call` without a `tool_result` has an unknown outcome.

The model reads this history (through `bash` and `read_file`) to look up tool calls that were summarized away. The header's `toolHistoryId` points to it and a `compaction` entry's `toolHistoryViewSeq` to the snapshot its summary refers to; resuming fails if that history or snapshot is missing, rather than continuing with a broken reference.

## Example

A session where the user asked one question and the model read a file:

```json
{"type":"session","version":2,"id":"notes","timestamp":"2026-10-08T10:50:32.570Z","cwd":"/home/me/app","toolHistoryId":"2bbdf095-0fa4-4ab5-80ad-0603a6dab4c2"}
{"type":"model_change","model":"openai/gpt-5","id":"5f1c2a90","parentId":null,"timestamp":"2026-10-08T10:50:32.570Z"}
{"type":"thinking_level_change","thinkingLevel":"medium","id":"0b7e44d1","parentId":"5f1c2a90","timestamp":"2026-10-08T10:50:32.570Z"}
{"type":"message","message":{"role":"user","content":"What does notes.txt say?"},"id":"a3c90e12","parentId":"0b7e44d1","timestamp":"2026-10-08T10:50:32.574Z"}
{"type":"message","message":{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call_1","toolName":"read_file","input":{"path":"notes.txt"}}]},"id":"77d2f0b4","parentId":"a3c90e12","timestamp":"2026-10-08T10:50:32.640Z"}
{"type":"message","message":{"role":"tool","content":[{"type":"tool-result","toolCallId":"call_1","toolName":"read_file","output":{"type":"text","value":"Ship the docs on Friday.\n\n\n[read_file: lines 1-1, starting column=0; 25 UTF-16 code units shown. EOF: no more content.]"}}]},"id":"c01b9a6e","parentId":"77d2f0b4","timestamp":"2026-10-08T10:50:32.646Z"}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"The note says: ship the docs on Friday."}]},"id":"e5a8d3f7","parentId":"c01b9a6e","timestamp":"2026-10-08T10:50:32.648Z"}
{"type":"session_info","name":"notes","id":"19f04c2b","parentId":"e5a8d3f7","timestamp":"2026-10-08T10:51:02.000Z"}
```

## Reading sessions from code

Use the storage functions instead of parsing files yourself; they handle versions and the version 1 format:

```typescript
import { fileSessionStorage } from '@glows777/vela'

const storage = fileSessionStorage('/home/me/.vela/projects/--home-me-app--1a2b3c4d/sessions')
for (const summary of await storage.list!()) console.log(summary.id, summary.messageCount)
const entries = await storage.load('20261008-081441-da14') // header first, then the entries
```

An open session returns its entries with `session.getEntries()`, its current branch with `session.getBranch()` and the whole tree with `session.getTree()`.
