# Session file format

A Vela session file is a JSONL file holding one checkpoint: the full message history after compaction, plus the session's settings. Every save writes a new checkpoint that replaces the file, so a file written by Vela has exactly one line. Unlike pi's session files, there is no entry tree and no append log: branching and history before a summary are not kept in the session file (the tool call history keeps the raw tool calls and outputs).

The format is part of Vela's public API. See [Sessions](sessions.md) for behavior and [SDK](sdk.md#session-storage) for custom storage.

Source: `src/session/storage.ts` (checkpoint type, file storage, parsing) and `src/session/index.ts` (saving and loading).

## File location

```
<dataDir>/sessions/<id>.jsonl
```

In the CLI, `<dataDir>` is the [project data directory](settings.md#data-directory) under `~/.vela/projects/`. `<id>` is the session id (letters, digits, `.`, `_`, `-`; see [Sessions](sessions.md#session-ids-and-storage)).

Files are written by writing a temp file next to the target, syncing it and renaming it over the target, so a crash never leaves a half-written session. Files are created with mode `0600` and the directory with `0700`.

## Checkpoint

```typescript
interface SessionCheckpoint {
  type: 'checkpoint'
  version?: number          // format version; always written
  timestamp: string         // ISO time of this save
  summary: string           // latest compaction summary, '' if never compacted
  messages: { timestamp: string; message: ModelMessage }[]
  model?: string            // `provider/id`, only when the model was chosen by name
  thinkingLevel?: ThinkingLevel
  name?: string             // display name (session.setName(), /name)
  toolHistoryId?: string    // @internal
  toolHistorySeq?: number   // @internal
  toolHistoryViewSeq?: number // @internal
}
```

| Field | Description |
|---|---|
| `type` | Always `checkpoint` |
| `version` | Format version, see [Versions](#versions) |
| `timestamp` | When the checkpoint was saved; used to sort session lists |
| `summary` | Text of the latest compaction summary. The same text is in the first message after a summary; this field is informational. |
| `messages` | The history in order. `timestamp` is the ISO time the message entered the history; `message` is an AI SDK `ModelMessage`. |
| `model` | Model reference restored by `resume()`. Absent when the model was passed as a `LanguageModel` object. |
| `thinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`; restored by `resume()` |
| `name` | Session display name |
| `toolHistoryId`, `toolHistorySeq`, `toolHistoryViewSeq` | Link the checkpoint to its [tool call history](#tool-call-history): the history directory and how many records it must contain. Internal: their meaning may change without a format version bump as long as old files keep loading. |

A custom `SessionStorage` receives this object in `save()` and must return it unchanged from `load()`.

## Versions

`SESSION_FORMAT_VERSION` (in `src/session/storage.ts`) is the version Vela writes. The current version is `1`.

- A checkpoint without `version` is read as version 1.
- A checkpoint with a higher version than this Vela supports fails to resume with an error asking you to upgrade Vela.
- An incompatible change bumps the version, and Vela migrates older versions when it loads them.

Files from before checkpoints existed hold one message per line:

```json
{"type":"message","timestamp":"2026-05-01T09:00:00.000Z","message":{"role":"user","content":"hello"}}
```

They are still read: each `message` line is appended to the history, and message lines after the last checkpoint line are appended to that checkpoint. The next save rewrites the file as a single checkpoint. Lines that are not valid JSON are skipped and reported to the logger.

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

**Summaries.** After a compaction summary, the history starts with a user message whose content begins with `[Summary of the earlier conversation]`, followed by the summary sections (User goal, Completed, Pending, Constraints, Key facts) and a guide to the tool call history. The messages after it are the ones kept.

Loop-detection reminders are user messages starting with `[system message]`.

## Tool call history

Next to the checkpoint, each session has a directory:

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

The model reads this history (through `bash` and `read_file`) to look up tool calls that were summarized away. The checkpoint's `toolHistoryId` and `toolHistorySeq` point to it; resuming fails if the history has fewer records than the checkpoint expects, rather than continuing with a broken reference.

## Example

A session where the user asked one question and the model read a file (the actual file is a single line; it is wrapped here for reading):

```json
{"type":"checkpoint","version":1,"timestamp":"2026-10-08T10:50:32.648Z","summary":"",
 "toolHistoryId":"2bbdf095-0fa4-4ab5-80ad-0603a6dab4c2","toolHistorySeq":2,
 "model":"openai/gpt-5","thinkingLevel":"medium","name":"notes",
 "messages":[
  {"timestamp":"2026-10-08T10:50:32.574Z","message":{"role":"user","content":"What does notes.txt say?"}},
  {"timestamp":"2026-10-08T10:50:32.648Z","message":{"role":"assistant","content":[{"type":"tool-call","toolCallId":"call_1","toolName":"read_file","input":{"path":"notes.txt"}}]}},
  {"timestamp":"2026-10-08T10:50:32.648Z","message":{"role":"tool","content":[{"type":"tool-result","toolCallId":"call_1","toolName":"read_file","output":{"type":"text","value":"Ship the docs on Friday.\n\n\n[read_file: lines 1-1, starting column=0; 25 UTF-16 code units shown. EOF: no more content.]"}}]}},
  {"timestamp":"2026-10-08T10:50:32.648Z","message":{"role":"assistant","content":[{"type":"text","text":"The note says: ship the docs on Friday."}]}}
 ]}
```

## Reading sessions from code

Use the storage functions instead of parsing files yourself; they handle versions and the legacy format:

```typescript
import { fileSessionStorage } from '@glows777/vela'

const storage = fileSessionStorage('/home/me/.vela/projects/--home-me-app--1a2b3c4d/sessions')
for (const summary of await storage.list!()) console.log(summary.id, summary.messageCount)
const checkpoint = await storage.load('20261008-081441-da14')
```
