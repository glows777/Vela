# Channels

A channel connects a chat service to Vela. The gateway keeps **one shared session per chat**, identified by the channel name and `channelId` (for example `lark-oc_456`). Different chats have separate history and can run concurrently. Within a chat, everyone sees the same conversation history. Messages queue in order by default; Lark also offers Steer and Stop during a run.

This page covers running Vela in a group chat and connecting a local app or script. To write a channel, see [Channels reference](channels-reference.md); it covers writing a channel, the gateway lifecycle, custom transports and external event subscriptions.

**Enabling a chat means trusting everyone in it with this machine.** Lark gives every member of an enabled chat full access, including bash, files, memory and extension tools. There is no sandbox or per-member boundary. See [Security](security.md#channel-senders) before enabling a group.

## Topic tool migration

The shared topic tools now use `channel_*` on Lark too: `channel_start_topic`, `channel_forward_to_topic`, `channel_list_topics`, `channel_read_topic`, `channel_wait_for_input`, `channel_skip_reply` and `channel_routines`. Replace explicit old `lark_*` names in tool selections, permission rules and custom prompts; no compatibility aliases remain. Mandatory tools are still added to a configured Lark group tool list. `lark_search_history` is unchanged because it reads the Lark service. Existing chat/topic IDs, saved sessions, routines and history keep their identities.

## Isolation scope

Each group's workspace is a default path, **not a security sandbox**. Absolute paths, traversal, symlinks, bash, shared extensions and credentials can still reach host resources. Memory/global-write restrictions apply to the memory API, not OS access. Enabled chats remain the trust boundary; topics share their group's workspace and notes, and all groups intentionally read global notes. Vela provides routine workspace/context separation, not hostile-user containment.

## Local

Local is an authenticated HTTP/SSE transport for apps and scripts on the daemon's machine. It uses the shared channel gateway: each project has a hub conversation, and work dispatched from the hub has separate task/topic sessions. It does not include an app UI or remote-access service.

### Start the daemon

Configure a model and its credentials first (see [Models](models.md)), then merge this into **user-level** `~/.vela/settings.json` (or `$VELA_DIR/settings.json`):

```json
{
  "extensionConfig": {
    "local": {
      "enabled": true,
      "token": "$VELA_LOCAL_TOKEN",
      "port": 8788,
      "timezone": "UTC"
    }
  }
}
```

The timezone is optional and defaults to the process timezone for routines. Supply a nonempty secret through the daemon's environment, not a committed settings file. For example, in a shell with OpenSSL installed:

```sh
export VELA_LOCAL_TOKEN="$(openssl rand -hex 32)"
cd /absolute/path/to/daemon-workspace
vela serve
```

Keep the same token in the client environment through your normal secret-management mechanism. Do not print it in logs or include it in URLs. A service manager must supply the token and model credentials to the daemon; see [Deployment](deploy.md) for running `vela serve` continuously. Restart after changing settings. Local is disabled by default. Only real `vela serve` enables this listener: interactive, print, JSON, RPC and model-listing modes do not, and `--no-extensions` disables it. Project-level `extensionConfig.local` cannot enable, disable or override it. There is no `builtin:local` selector; use the user-level settings above.

The listener binds **only `127.0.0.1`**, default port **8788**. Every route, including info and SSE, requires `Authorization: Bearer <token>`. Local has no cookie authentication or CORS support. Use an HTTP client that can set an Authorization header; browser `EventSource` cannot set that header. Local's token grants access to the daemon's configured tool authority, including its files and credentials. Loopback and a token are not a sandbox or a multi-user isolation boundary.

**Keep Local separate from the webhook receiver on port 8787. Do not tunnel, proxy publicly or otherwise expose Local.** A webhook tunnel must point only to the webhook listener, never Local. Port configuration does not change this trust model.

### SDK startup

The SDK does not read `extensionConfig.local` to enable the transport. Pass an explicit token to `local(options)`, exported by `@glows777/vela` and `@glows777/vela-channels`, and start channels explicitly:

```ts
import { createVela, local } from '@glows777/vela'

const token = process.env.VELA_LOCAL_TOKEN
if (!token) throw new Error('Set VELA_LOCAL_TOKEN')
const vela = createVela({
  dataDir: '/absolute/path/to/vela-data',
  // Configure model/providers/credentials as in your normal SDK application.
  extensions: [local({ token, port: 8788, timezone: 'UTC' })],
})
await vela.ready()
await vela.startChannels()
// When the host shuts down:
// await vela.dispose()
```

`LocalOptions` has required `token: string` and optional `port: number` and `timezone: string`. The token must not be empty, whitespace-only or contain CR/LF. Ports are integers from 0 through 65535; omit for 8788. Port 0 selects an ephemeral listener (useful for SDK tests); the actual address appears in daemon diagnostics. Choose a fixed port for an app deployment.

### Projects, sessions and persistence

Opening a project requires an existing directory. Its `cwd` is resolved through `realpath`; reopening the same canonical path returns the same project, including its original name. Relative paths resolve on the daemon, not the client; prefer absolute paths. A new name defaults to the directory basename. Project IDs, session IDs and run IDs are opaque: use returned values rather than constructing them.

The project cwd is the default tool working directory, **not a security boundary**. Absolute paths, symlinks and tools can still reach the rest of the host. Opening a Local project does not reload that project's `.vela` settings, extensions, skills or templates: sessions use the daemon's already-loaded configuration. Normal context-file discovery can still supply project instructions. All projects remain under the same daemon/tool authority.

A project supplies its hub `sessionId`. The sessions endpoint also returns task sessions created through shared channel dispatch. POST to the hub to ask for work; there is no separate HTTP task-creation endpoint. The gateway queues hub inputs. Human input to an active task automatically steers that task; an idle task starts another run. There is no client-selectable queue/steer mode. Different task sessions can run concurrently. Stop targets one current run and does not delete history or cancel other queued hub inputs.

The registry, deployment ID and visible messages persist under `<dataDir>/local/`; logical channel sessions and core transcripts use the existing channel/session stores. Reconnect or restart against the **same deployment and data directory** to retain identity and history. The CLI's existing default data directory depends on the cwd from which `vela serve` starts, so keep its working directory and data configuration stable. Opening another Local project does not switch the daemon's data directory. A different data directory is a different deployment, even if the same project paths are opened. No existing Lark data or settings migrate for Local.

Visible history contains human messages, delivered assistant replies and visible system text such as task titles or reminders. It is not the core transcript: hidden handoff briefs, internal notes, thinking, tool arguments and tool results are not included. Replies persist even when no SSE client is connected. Progress is an allowlisted summary, not a raw model stream. Provider/framework failures retain useful error messages, as on Lark; Local does not mask these failures in visible replies or status lines. Operator diagnostics remain separate. This is not a content filter for assistant replies, errors or user-authored text.

### HTTP v1 reference

All responses below are JSON except the event stream. JSON responses use `Cache-Control: no-store`. POST requests require `Content-Type: application/json` and a JSON object. Bodies are limited to **1 MiB**. Unknown body fields and unknown or repeated query parameters are rejected. There are no multipart/file uploads, remote cwd URLs, host-binding options or token query parameters.

| Method and path | Request | Successful response |
| --- | --- | --- |
| `GET /v1/info` | No query | `200 { version: 1, channel: "local", deploymentId, capabilities: ["projects", "sessions", "messages", "stop", "sse-reset"] }` |
| `GET /v1/projects` | No query | `200 { projects: LocalProject[] }` |
| `POST /v1/projects` | `{ cwd: string, name?: string }` | `201 LocalProject`, also when reopening an existing project |
| `GET /v1/projects/:projectId/sessions` | No query | `200 { sessions: LocalSession[] }` |
| `GET /v1/projects/:projectId/sessions/:sessionId/messages` | Optional `after` message ID and `limit` | `200 { messages: LocalMessage[], nextCursor?: string }` |
| `POST /v1/projects/:projectId/sessions/:sessionId/messages` | `{ text: string, clientMessageId?: string }` | `202 { sessionId, messageId }` |
| `POST /v1/projects/:projectId/sessions/:sessionId/stop` | `{ runId: string }` | `200 { stopped: true }` |
| `GET /v1/events` | Optional `projectId` | `200 text/event-stream` for all projects or the selected project |

Request constraints:

- `cwd` must be nonempty and resolve to an existing directory. `name`, if provided, is trimmed and must be 1–200 characters.
- `text` is trimmed and must be 1–100,000 characters. `clientMessageId`, if provided, must be 1–200 characters. `runId` must be 1–200 characters.
- History is oldest-first, with `limit` defaulting to 50 and accepting integers 1–100. `after` is exclusive and must name a message in that session. Follow `nextCursor` until absent to finish the snapshot; retain the last message ID to request later additions. An unknown cursor is an error, not an empty page. There is no `before` cursor or newest-first pagination.
- A session must belong to the project in the URL. Task IDs cannot be used to target another project.

Response types (optional fields are omitted when unavailable):

```ts
type LocalProject = {
  id: string
  channel: 'local'
  cwd: string
  name: string
  sessionId: string // project hub
}
type LocalSession = {
  channel: 'local'
  sessionId: string
  chatId: string // project ID
  chatKind: 'group' | 'direct'
  topic?: { rootId: string; threadId: string }
  task: string
  state: 'running' | 'queued' | 'waiting' | 'done' | 'stopped'
  requester: { id: string; name: string }
  updatedAt: string
  waitingReason?: string
  runId?: string
}
type LocalMessage = {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  text: string
  createdAt: string
  clientMessageId?: string
}
```

Timestamps are ISO strings. Local human input is attributed to `{ id: "local-user", name: "You" }`. A newly opened hub is listed even before its first message. `runId` identifies the current preparation/execution lifetime, not a session generation; it may disappear while reply delivery finishes. Read the current session before offering Stop. An expired, unknown or already-stopped run returns `409`; reload rather than applying an old Stop to a newer run.

**202 means admission, not completion.** It does not guarantee a reply or exactly-once execution. Use session/history snapshots and live events to observe progress. `clientMessageId` is optional correlation stored with the submitted visible input, **not an idempotency key**: repeating a POST admits another message. If a request times out, disconnects or returns an uncertain storage/admission failure, reconcile visible history (including the correlation ID) and current sessions before deciding whether to retry. Do not blindly retry a message POST. A crash can leave admitted work needing resubmission; Local does not promise crash-proof queue delivery or exactly-once processing.

Errors use `{ "error": { "code": "...", "message": "..." } }`. Defined HTTP codes are `400 invalid_request`, `401 unauthorized`, `404 not_found`, `405 method_not_allowed`, `409 conflict`, `413 payload_too_large`, `415 unsupported_media_type` and `503 unavailable`. Unknown routes or unsupported method/route combinations can return 404. Storage/admission failures return a generic 503 that asks the client to reconcile history and inspect daemon diagnostics.

### SSE events and reconnect

Each event is framed as `id: <id>`, `event: <type>` and `data: <JSON envelope>`, followed by a blank line. The envelope is:

```ts
type LocalEvent = {
  version: 1
  id: string
  time: string
  projectId?: string
  sessionId?: string
  runId?: string
  type: string
  data: unknown // one of the exact payloads below
}
```

| Type | `data` |
| --- | --- |
| `reset` | `{ reason: "connected", reload: ["sessions", "messages"] }` |
| `message` | `LocalMessage` |
| `session` | `LocalSession` |
| `run_started` | `{}` |
| `run_finished` | `{ outcome: "done" \| "failed" \| "stopped" \| "silent" }` |
| `progress` | `{ stage: "tool" \| "retry" \| "compaction", tool?: string, state?: "started" \| "finished" \| "failed" }` |
| `status` | `{ text: string }` |
| `error` | `{ code: string, message: string }` |

Tool progress includes only a sanitized tool name (up to 80 characters) and start/finish/failure state; it contains no arguments or results. Retry progress has only `stage: "retry"`. Compaction has start/finish state. A failed run can emit `error` with `code: "run_failed"` and its useful failure message. Status events report saved task status lines, not an additional model response.

Session and run events come directly from the shared gateway observer, not periodic polling or inferred model events. `run_started` carries the actual run ID when preparation begins, before model work, so Stop is available during preparation. `run_finished` carries that same ID and the actual outcome, including failed or stopped preparation. A hub dispatch run finishes independently of its child task; wait for the task session or its status to observe task completion. Queue release publishes a final session snapshot without the expired run ID. Progress and error envelopes may omit `runId` when it is unavailable; do not infer lifecycle from them.

Every connection, including the first, begins with `reset`. **There is no event replay; `Last-Event-ID` is ignored.** Event IDs are opaque identifiers, not history cursors or a resumable sequence. On every reset, reload session and visible-message snapshots. Keep live events buffered while loading and reconcile messages by message ID, then refresh sessions after loading if necessary. Do not infer missed replies from missing terminal events. Use `deploymentId` from `/v1/info` to detect a different store and discard stale cached IDs.

The server sends a comment heartbeat (`: heartbeat`) every 15 seconds. It disconnects a slow client as soon as a socket write reports backpressure, rather than buffering indefinitely or blocking model delivery. Reconnect with backoff and reload on reset. A disconnected subscriber does not prevent replies from being saved. Filtering by `projectId` limits live events to that existing project; it is not a separate authorization scope.

### Script client examples

The runnable [TypeScript client](../examples/local-client.ts) demonstrates snapshot loading and one observed run lifetime: its CLI exits on the first `run_finished`. A hub can finish dispatching before its child task completes. To track that work to completion, keep observing the task session and its status, then reload its visible history.

These shell examples require `curl`, `jq` and an already-running daemon. The client must receive the same `VELA_LOCAL_TOKEN` securely. First check the deployment, open the current directory and submit to its hub:

```sh
set -eu
: "${VELA_LOCAL_TOKEN:?Set the same token as the daemon}"
BASE=http://127.0.0.1:8788
curl --fail-with-body -sS -H "Authorization: Bearer $VELA_LOCAL_TOKEN" "$BASE/v1/info"
PROJECT=$(curl --fail-with-body -sS \
  -H "Authorization: Bearer $VELA_LOCAL_TOKEN" -H 'Content-Type: application/json' \
  --data "$(jq -n --arg cwd "$PWD" '{cwd: $cwd}')" "$BASE/v1/projects")
PROJECT_ID=$(printf '%s' "$PROJECT" | jq -r .id)
SESSION_ID=$(printf '%s' "$PROJECT" | jq -r .sessionId)
SESSION_PATH="$BASE/v1/projects/$PROJECT_ID/sessions/$SESSION_ID"
curl --fail-with-body -sS \
  -H "Authorization: Bearer $VELA_LOCAL_TOKEN" -H 'Content-Type: application/json' \
  --data '{"text":"Summarize this project","clientMessageId":"example-1"}' \
  "$SESSION_PATH/messages"
```

Read history and sessions, or subscribe to project events in another terminal with the same variables. The stream starts with reset; it does not include earlier replies:

```sh
curl --fail-with-body -sS -H "Authorization: Bearer $VELA_LOCAL_TOKEN" \
  "$SESSION_PATH/messages?limit=100"
curl --fail-with-body -sS -H "Authorization: Bearer $VELA_LOCAL_TOKEN" \
  "$BASE/v1/projects/$PROJECT_ID/sessions"
curl --fail-with-body -N -H "Authorization: Bearer $VELA_LOCAL_TOKEN" \
  "$BASE/v1/events?projectId=$PROJECT_ID"
```

For a task conversation, set `SESSION_ID` to its value from the sessions response. This example reads a current run ID and attempts Stop once; a race with completion can legitimately return 409:

```sh
SESSION_PATH="$BASE/v1/projects/$PROJECT_ID/sessions/$SESSION_ID"
RUN_ID=$(curl --fail-with-body -sS -H "Authorization: Bearer $VELA_LOCAL_TOKEN" \
  "$BASE/v1/projects/$PROJECT_ID/sessions" | \
  jq -r --arg id "$SESSION_ID" '.sessions[] | select(.sessionId == $id) | .runId // empty')
if [ -n "$RUN_ID" ]; then
  curl --fail-with-body -sS \
    -H "Authorization: Bearer $VELA_LOCAL_TOKEN" -H 'Content-Type: application/json' \
    --data "$(jq -n --arg runId "$RUN_ID" '{runId: $runId}')" "$SESSION_PATH/stop"
fi
```

## Lark

The built-in `lark` extension uses Lark's long connection (WebSocket), so no public URL is needed. It is loaded by default in the CLI.

Run `vela setup lark` in an interactive terminal to configure a group. The wizard validates the app credentials, waits for a human to mention the bot in a group, and asks for confirmation before enabling it. Every member of an enabled group has full access to Vela tools. It saves credentials in user-level `settings.json` (mode 0600), sends a connection message, and instructs you to run `vela serve`. Card callbacks and other permissions are checklist items, not verified by setup; use the manual reference below. Project settings can override user-level values.

After setup, run `vela serve` and mention the bot again to check a real model-backed reply.

**Manual setup.** To configure it by hand instead of running the wizard:

1. Create and publish a Lark custom app with bot capability enabled.
2. In **Events & Callbacks**, choose long-connection mode, subscribe to the event `im.message.receive_v1`, and add the callback subscription **Card action trigger** (`card.action.trigger`). Use the callback subscription, not the older card request-URL setting; this integration dispatches v2 callbacks over the same long connection.
3. Grant the API permissions below and add the bot to groups you intend to enable.
4. Configure the app credentials, owner open_ids and enabled chat_ids in [settings](settings.md):

   ```json
   {
     "extensionConfig": {
       "lark": {
         "appId": "cli_xxx",
         "appSecret": "$LARK_APP_SECRET",
         "owners": ["ou_aaa"],
         "chats": ["oc_trusted_group"]
       }
     }
   }
   ```

   `owners` and legacy `chats` accept string arrays or comma-separated strings. `chats` also accepts objects with `id` and optional `tools`, `model`, `thinkingLevel`, `topicModel` and `topicThinkingLevel` (see below). `LARK_APP_ID`, `LARK_APP_SECRET` and `LARK_OWNERS` remain environment defaults; settings take precedence. To supply chat ids from an environment variable, set `"chats": "$LARK_CHATS"` in settings.

5. Run `vela serve` and keep it running; [deploy `vela serve`](deploy.md) has a systemd unit for a dedicated user. The SDK equivalent is `lark({ appId, appSecret, owners, chats })`, followed by `await vela.ready()` and `await vela.startChannels()`.

### Enablement and replies

- `chats` lists the chat_ids that may use the bot. Every member of a listed chat has full access. A listed DM also works.
- `owners` contains people's open_ids. Their **direct chats** are always enabled, including when `chats` is empty. Being an owner does not enable a group they happen to speak in.
- Every other group or DM is dropped before content parsing, per-message logging, disk writes, name/history lookup or model work. Restart after changing settings; there is no in-chat `/enable` command.
- Empty `chats` produces one startup notice: only owners' direct chats are enabled.
- At the top level of enabled groups, supported human messages trigger one queued evaluation each, with or without **@ this bot**. Set `readUntagged: false` for mention-only top-level intake. Own/other bot events and events without a `user` sender type are dropped before content handling. In an owned topic, any member can reply without @. Vela resolves its bot open_id at startup; if that fails it logs a warning and ignores group messages until a successful restart. Owner DMs still work.
- Group answers use `im.message.reply` on the triggering message id. DMs use `im.message.create`. Lark controls whether an already-threaded trigger receives a threaded reply.
- A second top-level @ (or DM message) during an explicit-request run receives a Queue / Steer / Stop card. Queue is the default if nobody clicks. See [Run controls](#run-controls). Other chats can still run concurrently.
- Text and rich-text (`post`) messages become plain text, with mention markers removed. Image messages and `img` elements in posts go to the model as images; an image alone triggers a run in an enabled DM. Existing image normalization resizes or drops invalid images with a reason, and non-vision models receive the existing image placeholder.
- File messages are streamed to `<dataDir>/channels/<session id>/files/<message_id>-<name>`. Only a sanitized base name is used, with portable filename characters and a UTF-8 byte limit that leaves room for the message ID and extension. The model receives `[file: <name>, saved at <absolute path>]` and can use `read_file` or bash tools to inspect it. Files above **20MB** are stopped and the partial file is removed; explicit requests receive a too-large reply, while passive input logs an operator diagnostic. Only completed downloads are published at the final path; a redelivered message reuses its existing regular file. Downloads interrupted by process termination may leave a `.part` file, which is never reused as a completed attachment. Download failures on explicit requests reply with the cause and an `im:resource` permission hint; passive failures remain operator-only. Files remain with the session for resumed use; there is no automatic cleanup or native PDF/document input.
- Audio, video, stickers and merged forwards remain unsupported and receive a short reply saying text, images and files are supported, only in an enabled DM or when this bot is mentioned in an enabled group.
- The last 1000 incoming message IDs suppress live duplicate delivery. Passive messages also reuse saved `channel.input` IDs when reopening the logical session; an already recorded input is not evaluated again.

### Group workspaces, memory and tools

Each enabled group uses `<dataDir>/channels/<channelSessionId("lark", chatId)>/` with `workspace/`, `memory/` and the existing `files/` attachment directory. The existing encoder keeps chat IDs path-safe; topic roots and physical session generations do not affect this folder. No files are moved or deleted. Relative file/search/bash calls and automatic AGENTS/CLAUDE discovery use the workspace, so an `AGENTS.md` in `workspace/` reaches the group session and every topic in that group. Skills, templates, extensions/config, session storage and relative exports remain Vela-wide.

The channel and every topic in a group share its memory. The memory tool and `/memory` / `/dream` use that group's store for changes. Global notes remain at `<dataDir>/memory`; group sessions may only `read` or `search` them with `scope: "global"`. Other global actions fail clearly. Reads retain normal usage timestamp updates. The prompt shows a labeled group index and global index, each capped at 4,000 characters with truncation disclosed; note contents are read on demand. Local SDK/CLI sessions and owner DMs keep global memory.

For example, `"chats": ["oc_example_all", { "id": "oc_example_limited", "tools": ["read_file", "memory"] }]` leaves the first group with the default tools and selects exact registered tool names for the second. Omit `tools` for the default tools; `[]` removes optional tools. The group-only controls `channel_start_topic` and `channel_forward_to_topic` remain available in top-level group sessions and are denied in topics and DMs. `channel_list_topics`, `channel_read_topic`, `channel_skip_reply` and `channel_routines` are available in both. `channel_wait_for_input` is available only in topics. Group and topic sessions add the Lark topic tools and the two hand-off tools to a configured `tools` list, so that list cannot remove them (topics also keep `channel_wait_for_input`); DMs keep only `channel_routines` from this set. History search is an optional capability, available in both channel and topic sessions when selected. Without the memory tool, the memory prompt is omitted and its commands report that memory is unavailable. Malformed/duplicate chat entries fail loading. Unknown tool names reject `startChannels()` after all extensions load and before any channel transport or recovery starts.

A chat entry can also set `model` (`provider/id`) and `thinkingLevel` for its group session, plus `topicModel` and `topicThinkingLevel` for the group's topics. A topic uses its own value when set, otherwise the group's; a group without them uses the user's `defaultModel` / `defaultThinkingLevel`. DMs use the user defaults. Unknown thinking levels fail loading. A model name that does not resolve fails when its session opens, with the chat id in the error.

Current chat configuration is applied from the logical directory record before opening/resuming a session, including idle reopen, process recovery, topic handoff and the fresh physical ID created by `!restart`. A configured model or thinking level is applied again whenever the session opens, so a changed chat entry takes effect on resume. A mid-session `/model` or `/thinking` change survives a resume only for a value the chat entry does not configure. Restart retains the workspace, group notes and attachments. The per-group boolean `readUntagged` defaults to true.

### Untagged top-level discussion and cost

`"chats": ["oc_example", { "id": "oc_quiet", "readUntagged": false }]` enables passive intake in the first group and retains mention-only top-level behavior in the second. The bot must have the approved/published `im:message.group_msg` permission and be a member of each group; changing this setting cannot grant platform access. Owned-topic replies keep their existing behavior in either mode.

Each unique supported human top-level message gets one queued evaluation, with no batching or debounce. Passive input gets no reaction on receipt, progress/control card or separate content log: the triggering message gets `OnIt` only once the evaluation starts writing an answer, and that marker becomes `DONE` after delivery or `CrossMark` on failure or Stop. A silent evaluation, an empty answer or a topic handoff removes the marker and leaves nothing behind. Text/post, images and files use the existing normalization and attachment store. Unsupported passive message types are ignored; preparation and model failures go to operator diagnostics. Command-looking text, including `/commands`, is attributed discussion and does not execute a command. Passive evaluations use their stored conversation rather than repeatedly fetching recent group history.

The channel prompt normally asks the model to call `channel_skip_reply` and end the run. That mandatory channel control suppresses the run's final text and reply event; the tool call in session JSONL is the only durable silent decision. Useful short answers can be sent once; task work can be handed off through the existing topic controls. An explicit @ still receives normal acknowledgement feedback. If it arrives during a passive evaluation, it queues as its own run, without a Steer control that could merge it into a silent decision. Controls for existing explicit-request runs stay unchanged. A model may make multiple requests for tools, retries or compaction during one evaluation; “one evaluation” is not a one-request spending limit.

Normalized attributed input and model/tool responses live in the existing session JSONL. `channel.input` records the service message ID, passive flag and receipt timestamp; the directory adds the passive flag to the existing pending ID and active run metadata. There is no second ID registry or persisted silent-disposition field. Attachments stay under the group's `files/`, and usage stays in the existing ledger. On restart, active/queued passive work is dropped with an operator log, without a late unsolicited reply, resend notice or model call. Its IDs remain recognized through existing input markers. New events wait behind the startup recovery snapshot; @ and topic recovery stay unchanged.

**Silence still costs model calls.** Use actual recorded input/output/cache tokens and the configured rates, including control-tool continuation, tool loops and compaction. For illustration only, 1,000 requests/day × (8,000 input tokens × $3/million + 50 output tokens × $15/million) = **$24.75/day**, before extra requests, tools or compaction and without cache discounts. These are hypothetical rates, not a current provider quote or measured spend. Compared with 100 mention-triggered requests under the same assumptions, that is about 10×; growing context can cost more. There is no spend cap. The existing topic `!status` includes group-wide recorded usage, with unknown prices disclosed.

### Scheduled wake-ups (M4)

The channel runtime persists routines in `<dataDir>/channels/routines.json` and delivers one-off or daily/selected-weekday wake-ups to their original logical session, including after `!restart`. `extensionConfig.lark.timezone` selects one IANA deployment timezone, defaulting to the process timezone; invalid configuration or a malformed routine file rejects channel startup. Recurring schedules retain local wall time: a DST gap shifts forward by its length and a repeated time uses its first occurrence. Changing the deployment timezone changes recurring local-time schedules, while one-off UTC instants stay fixed.

Ask Vela in a topic, at group top level or in an owner DM to create a reminder. The mandatory `channel_routines` tool remains available even with a group's `tools: []`. Its `create` action accepts a message and either `{ "at": "2026-11-02T09:00" }` (a future deployment-local date/time, no offset) or `{ "time": "09:00", "days": ["mon", "tue", "wed", "thu", "fri"] }` (omit days for daily). Local one-offs use the same DST rules as recurring times and are saved as UTC instants. The tool returns the saved schedule, timezone, logical target, creator and next local run for the model's confirmation; for a DST gap this shows the shifted time. Invalid dates, past one-offs, invalid/empty weekday sets and more than 20 routines in a chat are rejected.

Send exactly `!routines` at group top level, in an owned topic or in a DM, with or without an @. It lists all routines in that chat: id, schedule, deployment timezone, logical target, creator and next local run. It makes no model call or user transcript entry and neither stops nor steers current work. This exact command also works when `readUntagged: false`; other unmentioned top-level discussion stays ignored. An unmentioned command in an unowned topic remains ignored without writes. Ask Vela to cancel an id (`channel_routines` action `cancel`); any member of the enabled chat can cancel, including another creator's reminder. Cancellation is idempotent and confined to the calling chat. Tool arguments cannot select another chat, creator or target, and ordinary SDK sessions cannot manage channel routines.

Wake-ups queue behind current work and never steer it. Topic runs reply to the topic root; top-level group runs first post one short announcement with the reminder, creator and any late notice, then use that real message as their reply/topic anchor; DMs use their existing send path. Results mention the routine's creator. Custom Lark transports may keep `send(): Promise<void>`, but top-level routines require a returned `{ messageId, createTime }` receipt and otherwise skip with an operator diagnostic. Disabled chats retain their routines and log once per startup without running them.

The saved occurrence's scheduled time is the `lastFiredAt` watermark. Startup catches up only the latest missed occurrence, once, with a late notice. A failed enqueue/save keeps the watermark unchanged and arms only the next future occurrence; a failed one-off therefore waits until a later startup for another attempt. Cancelling prevents future submissions and does not recall an input already submitted to the gateway.

Recovery is at least once from the saved input; session markers align the routine watermark after restart. Session persistence, routine-file replacement and remote delivery are not one transaction, so crashes can repeat work or delivery and there is no end-to-end exactly-once guarantee.

### Topics

An @ inside a Lark topic opens its own session, identified by channel, chat and root message ID. Different topics run concurrently without sharing transcripts; top-level messages and DMs retain one session per chat. Topics keep separate transcripts while sharing their group workspace and memory. Different groups use different default workspace and memory directories.

A topic is owned when its session exists. After restart or idle eviction, the gateway opens and resumes it through its per-session queue before preparing an untagged input. An unknown untagged topic is ignored without resolving names, reading platform history, downloading attachments or writing an empty session file. Existing history is loaded once for the next run; interrupted work does not resume automatically.

An untagged reply during a topic run automatically steers it without a Queue/Steer card. An idle reply starts the next run. Each run posts one shared progress card with **Stop** inside its topic. Stop aborts only that run, retains its session history and expires the callback; the next message continues the conversation. If the Stop card cannot be sent, Vela reports the cause and does not start the task.

The first @ entering a topic without a saved session reads every page of history using `container_id_type: thread` and the platform `thread_id`, in chronological order. The root message ID is used for session identity, not as the history container. Text/post content includes earlier bot answers, excluding the triggering message, messages newer than its timestamp, recalled messages and control cards. Other messages at the same timestamp remain included. Historical file content is not downloaded; at most four historical images are attached. A failed topic-history read is reported instead of running with silently incomplete context. Once the topic is owned, both explicit @ mentions and untagged replies use the existing session context without rereading topic history.

A new topic's first run receives one hidden `channel.topic` message before its input (`display: false`, no turn triggered): `Topic context from Vela (not from a person), as this topic starts:`, then the topic's title and root ID with the requester's name, then the shared group workspace path with up to 30 top-level entries, or `(empty)` when it has none. Its brief arrives as `<name>: <brief>`, followed by `[<name>'s original message, verbatim]` and the triggering text when the message had one.

### Channel dispatch

The top-level group session answers short questions directly: answerable from the visible conversation, in one reply, without tools. Its prompt makes any request that needs work a topic — investigation, execution, tool-based work or a longer exchange — and keeps only short questions in place. In addition to its existing tools, it has the Lark dispatch tools below. Every group session — the top level and each topic — also has two platform-neutral hand-off tools. A topic session can list and read topics and hand work off, but only the group session starts or forwards a topic; a DM has none of these.

- `channel_start_topic({ title, brief })` replies under the current message with `reply_in_thread: true`, posting only the title — one line of at most 40 characters that names the task, with no requirements, method or status — then independently enqueues the brief in its topic session with the sender's name. It returns the platform receipt without waiting for task completion, so another top-level question can run while the topic works. The brief is the topic session's whole input: it must include the goal and the facts it needs, with no plan or method in either text. The topic list shows the title as the topic's `task` label. The triggering message’s own images are carried over, excluding images from group history. The channel transcript is not copied into the brief, and a successful handoff suppresses the channel's duplicate final reply.
- `channel_forward_to_topic({ root_id })` forwards the current original message to an observed owned topic in the same group, then explicitly enqueues its content with the original sender's name. It does not depend on receiving the bot's forwarded message as an event. A running target is steered; an idle target starts its next run.
- `channel_list_topics()` reports recorded owned topics, their original requester, last activity (`updatedAt`), and state (`running`, `queued`, `waiting`, `done`, or `stopped`) from the gateway's durable directory. The list survives process restarts; topics from before M2 join when they next receive an admitted message. Its result states when directory coverage began and warns that earlier topics may exist: an empty list does not mean there are no tasks. Persistent session ownership remains independent of this directory. When a follow-up refers to earlier work absent from the list, the channel prompt requires a notice that the earlier topic could not be found, at the beginning of the new topic entry, instead of silently duplicating it.
- `channel_read_topic({ root_id })` reads the visible messages of another owned topic in the same group, in order, to see what it asked, decided or delivered. It returns the target's `task`, `state` and messages, capped at 20,000 serialized result characters. Notes sent with `channel_message_topic` are not visible messages and are not included. An unknown or unowned `root_id` is an error.
- `channel_wait_for_input({ reason })` records a required human decision in the existing topic directory. The model must then ask that question and end its run. Waiting becomes visible after successful answer delivery; live running/queued work takes precedence. It survives process restart without resuming completed work. The next accepted topic message clears waiting, and Stop/Restart clears the reason. Inactivity alone never implies waiting.

Each Lark dispatch tool validates the caller's active group context; forwarding rejects targets outside that group.

A Stop selected while a create/forward API request is pending cannot enqueue topic work from its eventual receipt. Lark may already have accepted the remote message; Stop does not retract that message.

Two platform-neutral hand-off tools move information between the sessions of one group:

- `channel_message_topic({ root_id, text })` sends a note to another owned topic in the same group, for a result it is waiting for or a fact it needs. `text` is at most 4,000 characters. Nothing is posted in the chat. The note is queued like other input, never steered, and delivered only to a topic session that already exists. Its text begins `Message from Vela's topic "<title>" (root_id …) (not from a person):`, or `Message from Vela's group session (not from a person):` from the top level. `root_id` must be an owned topic in the same group; an unknown id is an error that points at the topic list, and a topic cannot message itself. It returns `{ queued: true, target: { task, state } }` without waiting for the target's run.
- `channel_message_group({ text })` sends a note from a topic to its group session, for work outside the topic or when the requester must be told outside it. `text` is at most 4,000 characters. Nothing is posted in the chat; the note is queued and never steered, and the group session decides whether to reply in the group, pass it to another topic or only note it. It begins `Message from Vela's topic "<title>" (root_id …) (not from a person), about a request from <name>:`. Only a topic can call it; a group session is told `Only topic sessions can message the group session`.

A note is one hop after a person's input. At most three notes may follow it (`A → B → C → D`); the next is refused with `Hand-off chain limit reached: tell the requester in your reply instead`. A note never answers a person's pending decision: it leaves `waitingReason` and the `waiting` state unchanged. A note still queued when Vela restarts is dropped. A note whose run had started but had not reached the session is dropped with an operator log, and the previous answer is not resent.

Status lines run the other way. A topic run that ends records one line for its group session without a model call: `topic "<title>" (root_id …) finished: <answer>`, `failed: <reason>`, `was stopped`, or `is waiting for <name>: <reason>`. The answer is clipped to 200 characters on one line. A topic's note to another topic also records `topic "<title>" (root_id …) → topic "<title>" (root_id …): <text>`. Top-level, DM and passive runs record none.

The lines live in the `notes` map of `<dataDir>/channels/index.json`, at most 20 per group; older lines are dropped. Before the group session's next run they are injected as one hidden `channel.status` message, `Status from Vela since your last run (not from a person):` followed by the lines, with `display: false` and no triggered turn. A topic finishing therefore starts no model work: the group session sees the lines on its next run. The injected lines leave the index after the receiving session saves.

### Searching older group messages

`lark_search_history({ keyword?, start_time?, end_time? })` is available in channel and topic sessions, scoped to their own enabled group via the logical session binding, including after `!restart`. There is no model-supplied chat ID. Topic briefs remain the only copied channel context; a topic can use this tool to retrieve missing facts. It is denied in DMs and remains subject to the group's optional tool selection.

The adapter uses `client.im.message.list` with `container_id_type=chat`, newest first. Keyword matching is case-insensitive literal matching performed locally on text, posts and attachment descriptions; it does not download attachments, search their contents, or return deleted messages. Omit the keyword for a time-range listing. Times are ISO 8601 with a timezone; the default range is the last seven days. Request boundaries are converted to seconds; returned `scannedRange` and match `createTime` values are ISO 8601 UTC timestamps. Matches retain the platform `senderType`; `matchCounts` gives exact returned totals for `user`, `app` and unknown sender types, not totals for all scanned messages or the whole group.

Each call requests 50 items per page, at most 5 pages / 250 scanned messages, and returns at most 20 matches / 20,000 serialized result characters. Results report requested and scanned ranges, the scanned count, and `truncated`. The scan stops when any bound is reached; a message that would exceed the character budget is omitted. There is no continuation token: call again with an earlier `end_time`. This is bounded recall, not exhaustive search; messages sharing a boundary second may overlap or be skipped. In ordinary groups, chat listing includes **topic roots, not all thread replies**, which the result also discloses. An absent thread reply does not establish indexing delay. Permission/API errors remain tool errors, not empty successful searches.

History search needs the same group history permissions listed below and bot access to the group. Custom `LarkTransport` implementations must provide `searchMessages(chatId, { startTime, endTime, limit, pageToken })`, returning `{ items, pageToken? }`; pagination tokens stay inside one tool invocation.


The topic prompt asks the model to respond to the latest message and treat results already given as delivered, without repeating them unless asked. Completion notices are treated as acknowledgments of the delivered result, with a brief reply rather than a restatement of the task, result or constraints. Progress narration stays in the automatic display; the model gives the result when done, or asks one decision question and ends the run when blocked.


The topic list’s `task` is its original title. Follow-up requests can change what the topic is working on; `waitingReason` records the current required input. A difference between that reason and the original title alone does not indicate corrupted directory data.

### Task feedback

An admitted @ or topic message receives an `OnIt` reaction before name/history/attachment preparation and model work. Unknown untagged topics are checked for ownership first. The reaction becomes `DONE` after the result is sent, or `CrossMark` on failure or Stop (the card explicitly says “Stopped”). A channel-to-topic handoff keeps the original reaction pending until the topic finishes; accepted steers finish with that run. A passive group input follows the same outcomes from the first non-empty assistant text delta instead of admission; silence, an empty answer or a topic handoff removes its marker with nothing added, so a run that writes text before going silent can show `OnIt` briefly.

The same Stop card is updated in place with the current stage, elapsed time and up to eight top-level tool summaries. A summary uses the first string among `command`, `path`, `query` and `pattern`, sanitizes it to one line and caps it at 60 characters. Credential-marked input (including token/password fields in the selected text, environment assignments, authentication flags and URL credentials) is omitted. Nested calls do not displace their parent. Thinking, arbitrary argument fields and raw logs are not displayed. Updates are serialized and coalesced at no more than four per second, with a 15-second heartbeat during quiet work. At completion, the gateway unsubscribes, stops the heartbeat and drains in-flight updates before sending one result or decision question that @-mentions the run's original requester. It then finalizes the same card and reactions with the delivery outcome. Another member's steer does not replace that requester. Progress updates contain no mentions or separate timeline messages.

A failed progress update is reported in the topic and is not retried automatically. If the task succeeds and its result is delivered, its reaction becomes `DONE` even when the progress card could not be updated. A failed result send emits `channel_error`, records an operator log, marks the reaction `CrossMark` and changes the terminal card to `Failed` when card updates are available; Vela does not claim delivery or move the result to the main timeline. The first-reaction ≤2-second target and actual notification/rendering behavior require acceptance in a real Lark group; offline tests establish ordering, not platform latency.

For delayed inputs, temporarily enable the existing `VELA_DEBUG=1` logging. Accepted Lark inputs log their service message ID, service creation time (milliseconds) and local receipt time (UTC). The gateway logs admission, dequeue, preparation start, acknowledgement completion, preparation completion and prompt submission for that ID. Compare these timestamps with the saved session input and model/tool events to separate delivery, queue, preparation and model latency; prompt submission is not a provider-start timestamp. Logs omit message text, group IDs, sender IDs and credentials. Interactive CLI debug output goes to `$VELA_DIR/debug.log`; other modes use stderr.

### Run controls

For top-level channel sessions and DMs, when a new text, post, image or file message arrives during the chat's run, Vela sends an interactive Card 2.0 (`schema: "2.0"`) in reply to that message (a normal send for DMs). Its buttons use `column_set` / `column` / `button` and `behaviors: [{ type: "callback", value }]`, matching the subscribed `card.action.trigger` event. The [Lark SDK's card troubleshooting notes](https://github.com/larksuite/node-sdk/blob/main/docs/channel.md#common-issues) describe the v1-payload mismatch that can prevent clicks from reaching that callback.

- **Queue (default)**: wait for the current run and reply, then answer the new message separately. Doing nothing has the same behavior; there is no extra waiting period.
- **Steer**: prepare the new message with its sender name and group context, then pass it to the current task with `streamingBehavior: 'steer'`. History excludes the active trigger and messages older than its `create_time`, since the session already has that context. Other messages at the same millisecond are retained; timestamps alone cannot order them. The current run sends one final reply to its original trigger, covering the original and steered inputs. The steered message does not start its own answer.
- **Stop**: abort the current run, discard this card's queued input and pending SDK inputs belonging to that run, and send `Stopped the current run.` to this card's triggering message. Other messages waiting in the gateway's default queue remain queued.

Any member of an enabled chat may use its controls, matching the shared session. In a DM enabled only through `owners`, the operator must be one of those owners. A callback must include the matching chat, an operator open_id, a recognized action and the opaque token issued for that card. The first valid choice wins. Repeated clicks and controls from a completed run or a previous process are ignored with an informational toast; they cannot affect a later run. Cards expire when Stop is accepted or the run settles.

The callback reserves the choice and returns its toast immediately; it does not wait for name/history APIs, model work or abort cleanup. If the run finishes during Steer preparation, the message remains in its default queue. A failed card send is logged and also leaves the message queued. Any message from this app, including a control card, bounds the subsequent group-history scan.

### Names and group context

Each incoming user message is prefixed with the sender's display name. In an enabled group, a top-level message also starts with its send time in the local time of the machine running Vela (`[10:32] Alice: …`), whether it mentions the bot or arrives as passive chatter. Vela uses `contact.user.get` with `user_id_type: open_id`; names and fallback results are cached in memory (up to 1000 entries). If the contact API is unavailable, the name is empty, or the user is outside the app's contact data scope, the open_id is used instead. Restarting clears this cache. Explicit requests with a leading slash are passed through verbatim to preserve extension commands, `/skill:` and prompt-template expansion; they skip name/context wrapping. Ordinary chat questions keep both.

For a top-level group @, after any earlier queued reply finishes, Vela fetches at most 50 recent chat-history messages. It takes text/post messages and attachment placeholders after this bot's last reply and before the triggering question, excludes the question itself and recalled messages, and injects them in chronological order into the same user message:

```text
[Chat since last reply]
[10:31] Alice: Let's use blue.
[10:32] Bob: Agreed.

[Question]
[10:33] Alice: What should we do next?
```

Each line starts with the message's send time in the local time of the machine running Vela (`HH:MM`). The history window also supplies at most the four most recent images (including post images). In a group, send an image first, then @ the bot in a text message. Historical files appear only as `[file: <name>]` and are not downloaded.

With no earlier text, the input is just `[10:33] Alice: What should we do next?`. If history cannot be fetched, Vela logs the failure and answers the named question alone. It does not claim the missing context was read. The API query is bounded to one page; older messages beyond that page are omitted. Lark's chat-history endpoint returns thread roots, not all replies inside separate threads.

With `appId` configured, history stops at any message sent by this application's app_id, including interactive cards and other message types. That boundary works after process restart without in-memory reply state. Opening a topic for a top-level message, or forwarding that message into a topic, also stops the scan at the trigger. Vela remembers the trigger's create time for this process only, because the in-topic reply never appears in the group list. Messages from other people after that trigger still appear. Restart drops the remembered trigger and falls back to an own-app message in the list. Messages from a different bot are not this app's boundary. This also applies to control cards, so the bounded scan may omit earlier discussion; use history search when needed.

Custom `lark({ transport })` integrations may omit `appId`. In that case only, Vela retains successful top-level reply receipts in memory and stops at the reply's message ID or timestamp. That fallback preserves the current-process boundary, including when the reply is absent from the returned history, but cannot identify older own-app messages after a process restart. Supply `appId` alongside the custom transport for the restart-safe boundary; no app secret is needed with a custom transport.

### Lark permissions

Use application (`tenant_access_token`) permissions. The bot must be enabled/published, be in the group, and have permission to speak. New permissions and contact data-scope changes must be published/approved in Lark; Vela does not change them.

- Receive owner DMs: `im:message.p2p_msg:readonly`; receive group @ events: `im:message.group_at_msg:readonly`. Receiving untagged human replies in owned topics requires `im:message.group_msg` ([receive event](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)). This also enables default-on top-level passive intake. `im:message.group_msg` receives human messages; do not request bot-inclusive `im:message.group_msg.include_bot:read`. The adapter independently checks event `sender_type: user` and its own bot ID; Lark history uses `sender_type: app` instead. Custom offline transports must supply the event sender type too.
- [Read group history](https://open.feishu.cn/document/server-docs/im-v1/message/list): `im:message.group_msg` **plus** one of `im:message` or `im:message:readonly` (legacy `im:message.history:readonly` also works). Mention-only event permission does not provide this history access.
- [Resolve display names](https://open.feishu.cn/document/server-docs/contact-v3/user/get): `contact:contact.base:readonly` for the contact API **and** `contact:user.base:readonly` for name fields. Include the relevant people in the app's contact data scope. No email/phone access is needed. Existing broader legacy contact permissions may already cover these fields.
- [Send replies](https://open.feishu.cn/document/server-docs/im-v1/message/reply), including interactive control cards (`msg_type: interactive`): `im:message:send_as_bot` or `im:message` (legacy `im:message:send` also works). No CardKit API or additional card-management permission is used. The separate `card.action.trigger` callback subscription above is required for buttons to work; message reception alone does not deliver clicks.
- [Create topics](https://open.feishu.cn/document/server-docs/im-v1/message/reply) and [forward into topics](https://open.feishu.cn/document/server-docs/im-v1/message/forward): `im:message:send_as_bot` covers both. Forwarding uses `receive_id_type: thread_id` and the platform thread ID; the root message ID is only the session identity.
- [Add/delete reactions](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create): `im:message.reactions:write_only`. Use the documented `OnIt`, `DONE` and `CrossMark` values, not an invented `EYES` value.
- [Update shared cards](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch): the existing `im:message:send_as_bot` permission qualifies; `im:message:update` is an alternative, not an additional required grant. Initial and updated cards must both set `config.update_multi: true`. The API permits 5 updates/second per message, cards up to 30 KB and updates within 14 days. Sending replies also has a group-wide 5 QPS limit shared by bots; API failures remain visible.
- Download message images and files: `im:resource`. The bot must be in the same chat as the message.
- [Identify this bot](https://open.feishu.cn/document/client-docs/bot-v3/obtain-bot-info): no additional API permission beyond enabled bot capability and the app's tenant token.

## GitHub webhook setup

Use `vela setup github owner/repo --url https://your-tunnel-host` to connect repository events to Vela. Pass multiple `owner/repo` arguments for several repositories. Omit repositories or `--url` only in an interactive terminal, where setup asks for them; Escape cancels before saving. `--url` is a public HTTPS origin, without a path, query or fragment. Vela appends `/events/github`.

1. Configure at least one trusted channel, such as Lark above, and arrange a tunnel to `http://127.0.0.1:8787` (or your configured fixed receiver port from 1 to 65535; setup rejects ephemeral port 0). See [tunnel deployment](channels-reference.md#tunnel-deployment-examples). Setup does not start or provision a tunnel.
2. Install GitHub CLI **2.57 or newer** and run `gh auth login --hostname github.com` with an account allowed to write repository webhooks. Setup checks only the active account, so an expired inactive account does not block it. Use `gh auth switch --hostname github.com` to select the account that will manage hooks.
3. Run the setup command. It merges and lowercases the repository allowlist in user `settings.json`, saves it with mode **0600**, and creates or updates each repository's matching webhook using `gh`. It preserves unrelated settings and an existing secret. A new secret is generated and stored directly in these settings, not in `auth.json`; an existing `$VAR` reference is preserved and must resolve in the setup environment. Keep settings private. Trusted project settings can override user settings.
4. Start or restart `vela serve`. With GitHub ingress configured, a topic is guided to subscribe to PRs it opens or takes over instead of repeatedly polling. For a PR the topic did not open or take over, ask Vela in that topic to watch it using the subscription tool. The subscription key is exact, for example `github:owner/repo#pr/1`; repository spelling matters.
5. Open the repository's **Settings → Webhooks → Recent deliveries** and check delivery to your running receiver. Successful setup verifies hook configuration, not public reachability or topic execution.

Rerunning setup with the same payload URL updates the existing hook instead of creating another. A changed URL creates a separate hook; remove obsolete hooks manually. Multiple existing hooks at the same URL require manual resolution. Setup never deletes hooks or subscriptions.

If `gh` is unavailable or not logged in, local settings are still saved and setup prints manual webhook values, including the secret. Paste that secret only into GitHub's Secret field and avoid sharing the terminal output. Setup exits **1** until remote configuration succeeds; repository/API failures also exit 1 and retain local settings. A failed request may already have changed GitHub: check the hook or rerun to list it before updating. Non-interactive missing input exits **2**, and cancellation exits **0** without changes.

For supported events, signatures, allowlists, subscriptions and delivery limits, see [GitHub webhooks](channels-reference.md#github-webhooks).
