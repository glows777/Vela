# Channels reference

This page is for building on the channel interface: writing a channel, the gateway lifecycle, custom Lark transports and external event subscriptions. To run Vela in a group chat, see [Channels](channels.md).

## SDK host access

An in-process SDK host uses `createChannelVela()` and one accessor, `vela.channel(name)`. Call `await vela.ready()` before looking up channels registered by async extensions, then `await vela.startChannels()` before authoritative snapshot reads or mutations. `ready()` alone does not load the channel directory or Local store. An unknown channel name throws.

```ts
const vela = createChannelVela({ extensions: [lark(options), local(localOptions)] })
await vela.ready()
const channel = vela.channel('lark')
const offSession = channel.onSession(({ session, run }) => updateSession(session, run))
const offConnection = channel.onConnection(connection => showConnection(connection))
await vela.startChannels()
const sessions = channel.sessions()                 // all enabled chats in Lark
const chatSessions = channel.sessions('oc_group')   // optional chat filter
const connection = channel.connection()            // { connected: boolean, error?: string }
```

`ChannelHost` reuses `ChannelRuntime`'s `submit`, `stop`, `onSession` and `onStatus` types. It widens `sessions` to an optional chat ID and adds connection observation and idle-capable routines. Core `vela.sessions()` still lists open core sessions; `vela.channels()`, `runningChannels()` and `publishEvent()` are unchanged. For a cross-channel UI, enumerate `vela.channels()` and ask each view; there is no merged cross-channel runtime.

- `sessions(chatId?)` returns detached `ChannelSessionSnapshot` values, including `waitingReason` and the current `runId`, with the same enabled-scope checks as the adapter. Listing never opens a model session.
- `onSession` and `onStatus` preserve their existing event shapes. Subscriptions can be installed before startup, observe only future events, isolate listener exceptions and are cleared on disposal. Subscribe and then read snapshots to initialize a UI.
- `submit(message)` resolves after durable admission, before preparation, model work or delivery. It rechecks channel access. A topic follow-up must match an owned root and thread in that chat; the host view forces `requireExistingSession: true`. Unknown or mismatched topics are rejected without creating a new one. Group/topic input needs a real service `replyToId` anchor, especially on Lark, whose reply operation uses that ID. Do not fabricate service IDs. Owner DMs keep the existing direct-message form without `replyToId`. Creating an anchorless new Lark topic is not supported.
- `stop({ chatId, rootId? }, runId)` targets the exact current preparation/run. Expired, repeated or unavailable stops return false; stopping does not discard later queued input.
- Host access preserves channel enablement, project existence, topic ownership and configured tools. It does not expose model-run-only `scope`, `session`, `context`, `topics`, `topicCoverage`, `dispatch`, `skipReply` or `waitForInput` operations. After disposal, mutations fail and Stop returns false.

### Routines while idle

The host's `routines` member takes a logical target rather than an active model session ID. Creation requires an already admitted session and explicit creator attribution from the trusted SDK host. This identity is attribution, not an additional authorization mechanism. There is no second routine store or scheduler.

```ts
const routine = await channel.routines.create(
  { chatId: 'oc_group', rootId: 'owned-root' },
  {
    message: 'Review the report',
    schedule: { time: '09:00', days: ['mon'] },
    creator: { id: 'ou_alice', name: 'Alice' },
  },
)
const { timezone, routines } = channel.routines.list({ chatId: 'oc_group' })
await channel.routines.cancel({ chatId: 'oc_group' }, routine.id)
```

The schedule format, deployment timezone, future-time validation, 20-per-chat cap, `nextRun` descriptions and cancellation behavior are the same as the model API. List/cancel cover that chat's group/direct session and topics, never another channel/chat. Cancelling prevents future submissions, not work already admitted. Model-facing `runtime.routines` remains limited to an active channel run.

### Connection state

`connection()` and `onConnection(listener)` share one `ChannelConnection` value: `{ connected: boolean, error?: string }`. Initial, deliberately stopped and unconfigured channels are not connected. Readiness clears a prior error. Lark uses actual SDK ready, error, reconnecting and reconnected callbacks; resolving transport startup alone is not proof of readiness. Errors are safe display strings. Stopped/replaced transport callbacks cannot revive a connection. Custom Lark transports keep the existing startup success/failure fallback without a new observation hook.

For another adapter, optional `ChannelDefinition.onConnection(listener)` reports live state and returns an unsubscribe callback; without it, the gateway uses `start()` success/failure. Error strings from an adapter must be safe for host display. Connection state is informational: `runningChannels()` still means successful startup, and disconnects do not change routine scheduling or replay submitted messages.

Local in this release still starts its authenticated HTTP/SSE transport and reports connected only after startup succeeds. The host's low-level `submit` does not add Local user messages to visible history; use the existing Local HTTP API for its composer. The no-listener Local core and direct projects/messages/events API are the next part of #312, not part of this host-entry change.

## Writing a channel

The shared channel contract is exercised by both Lark and the Local HTTP/SSE transport, including admission, task dispatch, run controls and recovery. The documented public interfaces follow the [SDK API stability policy](sdk.md#api-stability); the earlier blanket experimental qualification no longer applies. For the app-facing wire protocol, see [Local](channels.md#local).

Register a `ChannelDefinition` through `vela.registerChannel()` from an extension. The channel types and `createChannelVela` come from `@glows777/vela-channels` (also re-exported by `@glows777/vela`); an adapter for another platform depends on it and `@glows777/vela-core`, like `@glows777/vela-lark` does. The [echo channel](../examples/extensions/echo-channel.ts) is a minimal offline example. Enforce chat enablement before invoking the incoming handler: the gateway gives every sender the session's full access and a shared transcript.

| Member | Required | Contract |
| --- | --- | --- |
| `name`, `description` | Yes | Stable channel name (part of session identity) and description shown in channel listings. |
| `canRecover(message, chatKind)` | No | Recheck current access for a stored group/direct conversation. Return false to leave it untouched during startup recovery. |
| `start()` | Yes | Open the service connection when channels start; may be synchronous or asynchronous. Return `false` when the channel is not configured to connect; the gateway then skips its startup line, routines and recovery. A rejected start is logged without preventing other channels from starting. |
| `stop()` | Yes | Close transport/resources after the gateway drains active work. May be synchronous or asynchronous; failures are collected during shutdown. |
| `send(message)` | Yes | Deliver an outgoing message; resolve after delivery, reject on failure. A successful send emits `channel_reply`; a failed send emits `channel_error`. |
| `onMessage(handler)` | No | Capture the gateway's incoming handler at registration. Its promise settles after processing, reply and feedback. Deliver new inputs immediately if you want controls during a previous run; do not wait for the earlier handler before delivering them. |
| `onConnection(listener)` | No | Report safe live connection state and return an unsubscribe callback; otherwise startup success/failure is used. |
| `connect(runtime)` | No | Receive the scoped runtime operations below at registration, before `start()`. |
| `topicCapabilities` | No | Implement `ChannelTopicCapabilities` to use the common topic tools and prompts. Platform creation, forwarding and visible-history retrieval stay in the adapter. |
| `sessionOptions(message)` | No | Select `{ cwd?, tools?, model?, thinkingLevel? }` from the logical chat and current configuration. The gateway applies them and binds channel scope before resume/hooks on every opening path, including new physical generations. A `model` that cannot be resolved throws with the chat id before the session runs. |
| `validateTools(names)` | No | Check configured names against all registered tools after extension loading. A thrown error rejects startup before transport or recovery. |
| `prepareMessage(message, activeMessage?)` | No | Asynchronously resolve names/history/attachments when the input is ready. Return the prepared message, or `undefined` when handled without a prompt. A steer receives its active run's original trigger as the second argument; queued inputs do not. Exclude context already present in that trigger. |
| `startRun(message, { acknowledge })` | No | Begin feedback after admission and before preparation; return a lifecycle with `event(update)` and `finish(outcome)`, or no handle. `acknowledge: false` creates presentation for a handed-off task whose original input already owns feedback. See below. |

### Messages and runtime

`IncomingMessage` contains `channelId`, `senderId`, `senderName` and `text`, with optional `chatKind: 'group' | 'direct'`, `images: ImageContent[]`, `replyToId`, `topic: { rootId, threadId }`, `requireExistingSession`, `isNewTopic` and opaque `raw`. The explicit `chatKind` is persisted and governs the conversation scope on reopening. Without it, the legacy topic/reply/handoff inference remains. A project hub uses the group topology even with one person; this does not grant access to other people. The sender identifies the speaker, not a separate session. A topic's root ID selects its session; its thread ID addresses the platform container. For untagged topic input, set `requireExistingSession: true`: admission rejects an unknown topic before preparation or feedback, without saving an empty session. The gateway sets `isNewTopic` from its ownership probe and sets it to false for active steers. Leave that field to the gateway.

`OutgoingMessage` contains `channelId`, `text`, optional `recipientId`, `replyToId` and `topic`. The recipient identifies a person to mention; omit it when a reply addresses only the service message. Preserve topic and reply identity when sending. Lark uses the group trigger's service ID as `replyToId`; direct messages omit it. A control-card send must not advance the service's last-answer history boundary.

`ChannelRuntime`, passed to `connect`, supplies channel-scoped operations. The adapter still owns authentication and chat enablement; these methods do not turn untrusted data into authorized commands. Session lookup and dispatch cannot cross the registered channel, and dispatch must stay in the source chat.

- `submit(message)`: available after this channel starts and before shutdown. Rechecks `canRecover`, then resolves `{ sessionId }` only after directory admission succeeds; rejects disabled/unknown existing targets or storage failure. This receipt does not wait for preparation, model work or delivery. `onMessage` retains its existing completion-waiting contract. A queued input may still require a resend after a crash if it never reached saved model history; this is not exactly-once execution or persistent client-ID deduplication.
- `sessions(chatId)`: detached snapshots of this channel's known project chat and topics, without opening sessions. Each includes the logical `sessionId`, chat identity/kind, optional topic address, task, requester, state, update time, optional waiting reason and optional `runId`. Physical restart generations are not exposed as targets. Disabled conversations are omitted. The opaque run ID is transient and is available during preparation and active model work, not after work settles while a reply is being delivered.
- `stop({ chatId, rootId? }, runId)`: synchronously reserves cancellation for that exact current preparation/run, then resolves a boolean after existing abort handling. False means the run is unavailable, expired or already stopped. It uses the same cancellation boundary as channel controls and leaves other default-queued human messages intact. It does not retract a delivered reply or introduce a separate steer mode; human topic inputs retain automatic steering.
- `onSession(listener)`: returns an unsubscribe function. Each callback receives a detached `ChannelSessionUpdate`: `{ session: ChannelSessionSnapshot, run?: { type: 'started', runId } | { type: 'finished', runId, outcome } }`. The gateway publishes snapshots on admission, preparation, execution and queue release. A run starts before preparation, so its ID can be used for Stop before the model starts; completion includes preparation failure and preparation Stop. `outcome` is `done`, `failed`, `stopped` or `silent`. A final queue-release snapshot reflects the settled state without an expired run ID. Run transitions describe the actual session run, independently of feedback ownership transferred to a child task. Listener exceptions are logged without changing delivery; listeners are cleared on channel shutdown. There is no replay buffer: subscribe and load `sessions(chatId)` for initial state.
- `onStatus(listener)`: returns an unsubscribe function. A callback receives `{ chatId, rootId, text }` only after the status line is saved for this channel. It does not start a hub model call. Listener exceptions are logged without changing task delivery; listeners are cleared on channel shutdown. There is no replay buffer.

- `routines.create(sessionId, message, schedule)`, `routines.list(sessionId)` and `routines.cancel(sessionId, id)`: scoped to an active channel run and its chat. Create derives the creator and logical target from the trigger, resolves one-off local `at` values in the deployment timezone, and returns persisted data with display metadata. List returns `{ timezone, routines }`; each entry includes `scheduleText`, `target` and local `nextRun` (null when there is no future occurrence). Cancel returns whether a matching record was removed. The shared `channel_routines` tool wraps these operations; storage, timers and the `!routines` command stay channel-generic.
- `context(sessionId)`: the active run's trigger, or `undefined` when there is no active run. Do not retain it as a substitute for durable session data.
- `session(id)`: the open session for a logical channel session id, or `undefined`. After `!restart` it resolves the current generation, not the previous one. For read-only display state that outlives one run, such as a progress card that rebuilds a checklist from `session.getBranch()`; do not prompt or close it.
- `topics(chatId)`: this channel's recorded topics in that chat, each with `rootId`, `threadId`, a short `task` and `state` (`running`, `queued`, `waiting`, `done`, `stopped`). The directory survives process restarts. Topics from before M2 appear after their next admitted message; topicCoverage() describes that boundary.
- `topicCoverage()`: describes when directory coverage began and the pre-M2 topic boundary.
- `dispatch(sourceSessionId, message)`: enqueue a handoff without waiting for the destination task. The source run must still be live or this throws. It transfers input-feedback ownership, observes a new topic immediately and suppresses the source's duplicate final reply. A running topic target steers; an idle target queues normally. The channel must enforce its destination authorization before dispatching.

### Shared topic capabilities

The channel assembly registers one set of tools: `channel_start_topic`, `channel_forward_to_topic`, `channel_list_topics`, `channel_read_topic`, `channel_wait_for_input`, `channel_skip_reply` and `channel_routines`. They are visible only in channel-bound sessions. Group sessions dispatch; task sessions cannot start/forward another task; direct sessions keep routines but not group/topic tools. The gateway applies these scope restrictions before session hooks. A channel without topic capabilities does not receive the dispatch prompt or the platform-dependent start/forward/read tools.

`ChannelTopicCapabilities` supplies:

- `startTopic(message, title)`: return `{ messageId, rootId, threadId }` after the platform creates the visible topic title. The shared implementation builds the private brief, preserves requester attribution and dispatches once.
- `forwardToTopic(message, target)`: forward the original message into the validated owned topic and return its normalized `IncomingMessage`. The common implementation checks the destination and dispatches without waiting for task completion.
- `readTopic(chatId, threadId)`: return visible messages only; hidden hand-off notes are not visible history.
- Optional `originalText(message)`, `triggerImages(message)` and `handled(message)` preserve platform-specific source text, image selection and history boundaries. Without an original-text hook, normalized input text is used.

Lark implements those hooks with its existing transport. Its tool names have changed without aliases; `lark_search_history` remains Lark-only. Custom prompt sections for shared dispatch/task behavior are now `channelGroup` and `channelTopic`. This is a tool/prompt naming break, not a session-data migration.

### Topic commands

In an owned Lark topic, send `!stop`, `!restart` or `!status` with or without an @-mention. Commands must be the whole message; they bypass model input and automatic steering. Unmentioned commands in unowned topics are ignored without feedback or writes.

`!stop` uses the progress card's Stop operation and keeps the session and its history. It also cancels input still preparing to start. An idle topic replies that no run is active.

`!restart` stops and drains the old run, retains its session file, and atomically switches the directory's `activeSessionId`, appending the old ID to `previousSessionIds`. It replies "Restarted with a fresh session" without calling the model. The next topic message, including an unmentioned one, starts the new session and reads the full topic history. The logical topic and its listing stay the same; expired Stop controls cannot affect the new generation.

`!status` replies during an active run without steering, stopping or calling the model. It shows the current model, estimated context tokens/window, and topic/group token and cost totals. A reopened session restores its saved model and context first. Status does not add a user entry or reset the topic's running/stopped state.

Usage is appended to `<dataDir>/channels/usage.jsonl` as `{ key, chatId, model, ts, tokens, cost? }`. `tokens` contains uncached input, output, cache-read and cache-write counts; displayed totals sum all four. Each existing `usage` event adds one row; `compaction_end` adds the change in session totals since `compaction_start`, including a measured summary whose result was rejected. The existing request record distinguishes an unknown summary price from a known zero cost. Logical keys retain totals across `!restart` generations, idle closure and process restarts. Group totals include all recorded channel sessions in that group, including top-level dispatch work.

Status says "Recorded since …" using the first ledger row. Earlier usage is not backfilled from `usage/requests.jsonl`, which lacks session identity. Unpriced requests still count tokens; mixed pricing shows only the known subtotal and the number of unpriced requests. An interrupted request without a usage report is not counted. Without a `dataDir`, accounting stays in memory. This is a single-process append-only ledger; malformed rows reject startup with the file and line, and write failures surface through the run's failure path. It is usage visibility, with no spending caps or promise of billing reconciliation.

### Restart recovery

The gateway keeps one versioned directory at `<dataDir>/channels/index.json`, shared by startup recovery, `runtime.topics(chatId)` and `channel_list_topics`. Updates are serialized and published by a synced temporary file and atomic rename. A malformed directory rejects `startChannels()` with its path; it never becomes an empty topic list. This is a single-process directory, like the gateway's session queues; `vela serve` is that process, and the TUI does not open a second one.

Records contain the channel/chat kind, topic root/thread IDs, requester/reply target, task label, active and previous session IDs, run state, pending service-message IDs and timestamps. Input content remains in the session JSONL. The directory does not backfill pre-M2 topics or reconstruct hashed routing IDs; an older topic joins on its next admitted message. `runtime.topicCoverage()` reports that boundary.

After the channel connects, the gateway drops passive work as described in [the channel guide](channels.md#untagged-top-level-discussion-and-cost) and restores indexed unfinished @/topic work through `session.resume()` and the existing run feedback lifecycle. A saved unanswered user turn (including images) is replayed by navigating to that turn's parent and prompting its saved input. The old branch remains in history. The topic receives an interruption/continuation notice before model work, and fresh Stop controls. A run whose branch already ends in a final assistant answer delivers that answer without another model call. Completed, waiting and explicitly stopped runs stay quiet.

Graceful shutdown leaves interrupted runs and unsaved steers recoverable, while an explicit Stop remains terminal. An execution failure whose terminal explanation was delivered is complete for recovery purposes; a failed result delivery stays recoverable. Inputs handled during preparation, such as unsupported attachments, are removed from pending admissions. Resend notices reply to the unsaved message without mentioning the original task requester, who may be a different person.

Admitted non-passive group message IDs without a saved user entry receive a reply asking the sender to send the message again. This includes steers still queued at process death: no adapter event or second copy of input is persisted. A small `channel.input` custom entry associates a saved input with its service-message ID; it is not model context. Tool execution may repeat from the saved input after a crash; there is no durable mid-tool resumption or exactly-once delivery guarantee.

`canRecover(message, chatKind)` is an optional channel hook to recheck current access before opening a stored session or posting recovery feedback. Lark rechecks its configured chats and owner DMs. Its group classification uses normalized reply identity, so recovered group work keeps the channel prompt/tools without a live receive event. Unknown untagged topics are checked for existing ownership before directory writes or feedback. Startup reserves recovery in the same per-session queues used by new input.

### Run feedback lifecycle

`startRun` receives normalized message data; it must work without `raw` or an old receive-event object. For Lark presentation, persistable chat/topic IDs, original requester ID and reply/service message ID are sufficient; text/name data supplies the prompt and attribution. Live preprocessing may still use `raw`. Signals and callbacks are fresh runtime capabilities and are not persisted. The gateway stores routing metadata in its directory and reuses this hook for recovered work.

The factory may acknowledge the newly admitted input before names/history/resources are prepared. For passive input the gateway calls it lazily with `{ acknowledge: true }` on the first non-empty assistant text delta and forwards no `controls` updates, so passive input still gets no control card. Its handle can outlive the source run: handoff carries the original handle to the destination; accepted steers finish with their receiving run. A new handoff presentation uses `acknowledge: false`, so it must not acknowledge the same input again. If initial feedback creation fails, the gateway reports it and may request presentation with `acknowledge: false` on the next update; this preserves Stop controls without retrying the failed reaction. A failure while creating those controls still prevents a topic prompt.

`event(update)` receives one of:

- **`controls`**: `{ type: 'controls', message, signal, choose, error }`. The message is the input whose controls are being presented. For a topic, this is the prepared run trigger immediately before prompting, with Stop only. For a non-topic message arriving during another run, this is the queued input, with Queue/Steer/Stop targeting that earlier run. No controls update is issued for an ordinary idle non-topic run or each automatic topic steer. Choose buttons from `message.topic`; `choose(action)` reserves synchronously and returns false for an expired/already-reserved choice, or an unsupported topic action. Remove callbacks on signal abort. Report asynchronous presentation errors through `error(error)`.
- **`agent`**: `{ type: 'agent', event }`, wrapping existing `VelaEvent` values from the run. Subscribe before prompting; handle tool/progress events without blocking the event stream. For `agent_settled`, stop heartbeat timers and return any outstanding writer-drain promise if writes must complete before the reply. The gateway waits for returned promises before delivery; it does not await each event while the model streams.

The gateway awaits controls before a topic prompt, but does not block the preceding run on a queued input's controls. A topic controls failure is reported and prevents that prompt; failed non-topic controls leave the input queued. An agent-feedback error is reported without turning a successfully delivered task into a failed one.

`finish(outcome)` is the single terminal input signal: `done`, `failed`, `stopped` or `silent`. It runs once after delivery, or after a terminal preparation/Stop failure. `silent` removes a deferred passive marker and adds no outcome reaction; other channels may treat it as no-op. Finalize the existing card and input reactions here and release resources. A failed send means `failed`, even if the model completed successfully. There is no separate `settled` lifecycle phase. Keep progress failure separate from task/delivery failure: Lark stops failed PATCH attempts and reports once, but still uses DONE when the result succeeds and is delivered.

A minimal feedback implementation can use an existing UI writer:

```ts
const startRun: NonNullable<ChannelDefinition['startRun']> = async (message, { acknowledge }) => {
  const feedback = await openFeedback(message, { acknowledge })
  return {
    event(update) {
      if (update.type === 'controls') return feedback.showControls(update)
      return feedback.onAgentEvent(update.event)
    },
    finish(outcome) { return feedback.finish(outcome) },
  }
}
```

Here `openFeedback` is your adapter's implementation: control creation may be asynchronous; ordinary progress events enqueue writes; completion drains/cancels timers and finalizes existing presentation. Channels without feedback can omit `startRun` entirely.

### Migrating existing feedback hooks

Replace `acknowledge`, `showTopicControls` and `showRunControls` with `startRun`. Move reaction creation to the factory, honor `{ acknowledge: false }`, move both control presentations into `event({ type: 'controls', ... })`, and forward agent events from the `agent` variant. Replace the old topic `stop()` callback with `choose('stop')`. Combine acknowledgement/card completion in `finish(outcome)`; `ChannelAcknowledgement` is removed. Update custom channel types along with the public API snapshot. Basic channels that never supplied these hooks need no change.

Channel session events keep their shape: `channel_message` carries `channel`, `senderId`, `senderName`, `text`; `channel_reply` carries `channel`, `recipientId`, `text`; `channel_error` carries `channel`, `senderId`, `error`, `aborted`. Subscribers also receive the session ID. Channel-local feedback updates do not add core event types.

## Gateway lifecycle

On receiving a message, the gateway:

1. Selects the shared session from `(channel name, channelId)` or `(channel name, channelId, topic.rootId)`. Non-plain or long ids get a hash suffix to prevent collisions.
2. Serializes messages per session. Active topic inputs steer automatically; channel/DM inputs can offer Queue/Steer/Stop controls. Queued preparation and unsupported-message replies stay serialized, so a later reply cannot change the context boundary of an earlier question.
3. For topics, opens/resumes before preparation and rejects unowned input marked `requireExistingSession` without writing an empty file. Opens/resumes the selected persisted session. A channel must reject untrusted chats **before** delivering them.
4. Starts the optional `startRun` feedback lifecycle for admitted input before preparation, binds controls at the appropriate run boundary, and subscribes to agent events before prompting. Drains pending feedback events before the terminal reply and calls `finish(outcome)` after delivery. Emits `channel_message`, prompts the session, and sends the last assistant text through `send({ channelId, recipientId, text, replyToId?, topic? })`. It emits `channel_reply` after success or `channel_error` after a failed turn/send. Empty answers and input handled by an extension do not resend an earlier answer.

Session save failures are logged at error level with the session id. After three consecutive reported save failures, new messages receive a reply that the session can't be saved, without running another prompt. A successful storage write resets the count, including an explicit SDK `await session.save()` after storage is repaired. Empty saves do not clear the count.

Before automatically closing an idle session, the gateway saves it. If that save fails, the same live session stays open with its pending history; the gateway does not start a periodic retry loop. While blocked, a new message first retries the pending save, and runs a prompt only after a real write succeeds. SDK callers reopening that id get the same session, so recovery does not create a competing history or another header. Channel activity after recovery restores normal idle cleanup. SDK-only recovery clears the count but leaves the session open until the next channel activity or an explicit close/dispose, so a save cannot schedule a close during SDK work. Failed sessions retain memory until recovery or disposal. Explicit SDK `close()`/`dispose()` and writes made by shutdown hooks keep their existing semantics; they can still discard unsaved data. In-session retries are unchanged.

Channel sessions have no UI: confirmation extensions should block when `!ctx.hasUI`; notification UI calls fall back to events. Sessions close after 10 idle minutes and resume on the next message; `createVela({ channelIdleMs })` changes that wait (`0` closes after each completed queue). Running sessions or queued chats are not closed prematurely.

**SDK:** `await vela.startChannels()` starts registered channels. `vela.channels()` lists them. `vela.dispose()` aborts running sessions, waits for pending work and stops channels. Tool-policy validation errors reject startup before transport/recovery; a failed channel `start()` is logged without stopping other channels.

**CLI:** channels run only under `vela serve` (see [CLI](cli.md#serve)), which stops them on SIGINT/SIGTERM. It has no UI: one line per incoming message, reply and error goes to stderr, with a local timestamp; channel tool calls are not shown. It takes no prompt and cannot be combined with print, JSON, RPC, `--export`, `--list-models`, session selection or tool flags. Interactive, print, JSON and RPC modes do not start channels, so two processes never share the single-process channel directory. `/channel` lists the registered channels.

## Custom transports

Custom `LarkTransport` implementations must provide `getBotId`, `getSenderName`, `listMessages`, `listTopicMessages`, `reply`, `startTopic` and `forward`. `listTopicMessages(threadId, pageToken?)` returns `{ items, pageToken? }` in ascending creation order, with a next token only when more pages remain; use a thread container, page size 50 and no time filters. `listMessages` returns newest-first history with millisecond `create_time`; `reply` returns `{ messageId, createTime }` from the service's successful reply receipt. Sends/replies and API errors must reject, so the gateway reports failure instead of a successful reply.

`LarkMessageEvent.sender.sender_type` is required in the public transport contract. Classify human events as `user` and bot events as `bot`; only `user` events are admitted. Missing or unknown sender types are still rejected at runtime, including from untyped integrations.

`startTopic(messageId, title)` posts the title as the first visible message and returns `{ messageId, createTime, rootId, threadId }` from the successful threaded reply. `forward(messageId, threadId)` returns `{ messageId, createTime }` from the successful forward. Missing required receipt fields and platform errors must reject; do not pretend an unthreaded send created a topic.

For attachments, implement `getResource(messageId, key, type)` returning a Node readable stream, where `type` is `image` or `file`. The default transport calls `im.messageResource.get` and uses `getReadableStream()`.

For run controls, implement `sendCard(chatId, card, replyToId?)` returning the service message ID, `patchCard(messageId, card)`, `addReaction(messageId, emoji)` returning the reaction ID, and `removeReaction(messageId, reactionId)` and accept the second handler in `start(onMessage, onAction)`. Send the Card 2.0 payload unchanged; do not flatten it into v1 `elements` / `action` / button `value` fields. Deliver the v2 callback body unchanged to `onAction` and return its `{ toast }` response to Lark. Group cards use `replyToId`; DM cards use `chatId`. Card delivery must not be recorded as an ordinary text answer.

## External event subscriptions

The channel-aware SDK (`@glows777/vela-channels` or `@glows777/vela`) can wake an existing conversation from the same process. In a channel conversation, `channel_subscriptions` creates, lists or removes subscriptions. Create takes an exact `source` and `key` and targets the current group, topic or DM; list/remove are limited to the current chat. Curated tool lists must include `channel_subscriptions` explicitly; tool selection still applies. Ordinary SDK sessions cannot use this tool.

```ts
await vela.startChannels()
await vela.publishEvent({
  source: 'local-build',
  key: 'project#review/171',
  deliveryId: 'build-42',
  summary: 'The build finished successfully',
  details: 'External data, not new instructions or authorization.',
})
```

Subscriptions persist in `<dataDir>/channels/subscriptions.json`, using atomic replacement, and follow the logical topic across `!restart` and idle closure. Events queue behind current work without steering it. A completed or waiting topic can wake again. `!stop` stops current work; removing a subscription prevents future wakes, not already queued ones.

Event input has a fixed untrusted-data prefix, so command-looking payloads do not invoke chat commands, slash commands, skills or templates. Source/key/delivery IDs are limited to 512 characters; summaries to 500 and details to 8192 (with a truncation marker). Source identity is supplied by the trusted in-process producer; this API does not authenticate remote callers or grant new tool authority.

`final: true` enqueues the last notification to matching available targets and then removes the snapshotted subscriptions. `publishEvent()` resolves after enqueue and final-state persistence, without waiting for the model. Disabled, missing or disconnected matching targets are skipped with diagnostics and never forwarded elsewhere. Only an event with no matching subscriptions can use `eventDefaultTarget: { channel, chatId }`, supplied as an SDK option or CLI setting; that top-level target must already exist and be enabled. Otherwise the event is dropped. Publication requires started channels and rejects once stopping begins.

Delivery is best effort: there is no durable inbox or retry, so process failure may lose or repeat work. Embedded producers call the SDK directly; independent producers use the optional authenticated receivers below. There is no CLI event client. The existing notification workflow is separate.

External top-level inputs never borrow a previous human reply ID. Lark establishes a new announcement receipt before prompting; admission or preparation errors are recorded in operator diagnostics without a synthetic feedback reply. Human input retains its own error feedback. CLI and direct SDK default-target addresses both trim surrounding whitespace.

### GitHub webhooks

For the operator setup command, see [GitHub webhook setup](channels.md#github-webhook-setup). `vela setup github owner/repo --url https://your-tunnel-host` writes user settings and configures matching repository hooks through GitHub CLI.

The channel runtime owns `extensionConfig.channel.eventReceiver`. It is absent by default. To configure it manually, add this section to user settings, supply the secret through the existing `$VAR` interpolation (or a literal in private user settings), and run `vela serve` with at least one enabled, connected channel:

```json
{
  "extensionConfig": {
    "channel": {
      "eventReceiver": {
        "port": 8787,
        "github": {
          "secret": "$VELA_GITHUB_WEBHOOK_SECRET",
          "repositories": ["glows777/Vela"],
          "apps": ["github-actions"],
          "issueLabels": ["to:vela"]
        }
      }
    }
  }
}
```

The SDK passes the same section in `createChannelVela({ extensionConfig: ... })` / `createVela(...)`, with a literal secret supplied by the host; the SDK never reads environment variables. Project sections require trust and merge through the existing settings rules. Repository names must be explicit `owner/repo` values; no wildcard. `apps` defaults to `github-actions`; an explicit list replaces it. `issueLabels` lists the Issue labels that wake the repository feed, and every Issue event needs one of them: an Issue carrying none of those labels produces no `opened`, `closed` or comment event, and `labeled` is delivered only for a listed label. It defaults to empty, which accepts no Issue event, so the feed stays silent until the list names at least one label. The port defaults to 8787 (`0` selects an ephemeral local port for fixture/embedded use). The host is fixed to **127.0.0.1** and has no override.

The listener starts after channels connect, prints its local URL, and closes during dispose/SIGTERM before channel work drains. An occupied port rejects startup. A successful HTTP response does not wait for a model turn. Two subscriptions share this receiver:

- **Repository Issue feed.** Subscribe once from the group that should receive Issue work: `channel_subscriptions({ action: "create", source: "github", key: "github:glows777/Vela#issues" })`. Ordinary Issues and their comments then arrive in that group.
- **One pull request.** Subscribe from the topic that opened or took over the PR: `channel_subscriptions({ action: "create", source: "github", key: "github:glows777/Vela#pr/171" })`. Review, CI, comment and close/merge feedback goes to that topic.

These are exact keys, including repository spelling. Each event matches one key, so an ordinary Issue comment never reaches PR subscriptions and a PR comment is not duplicated into the repository feed. Enablement and tool selection still apply; a signed webhook cannot choose a chat or grant authority.

Configure a GitHub repository webhook with JSON content type, a high-entropy secret matching the setting, and payload URL `https://<your-tunnel-host>/events/github`. Select only:

- **Check suites**, action `completed`, from an allowlisted app. Each supplied PR mapping receives that suite's conclusion, exact SHA, time and link. This is not an aggregate verdict for all PR CI. Empty PR mappings are logged and dropped; there is no token/API lookup or branch-name guessing.
- **Pull request reviews**, action `submitted`: reviewer, state, commit SHA, link and body preview. No fabricated inline-comment count or individual inline-comment events.
- **Issue comments**, action `created`, on pull requests: author, link and body preview. Delivered only to that PR's subscription.
- **Issue comments**, action `created`, on ordinary Issues: author, issue title, link and body preview. Delivered only to the repository subscription, and only for an Issue carrying one of the `issueLabels`.
- **Issues**, actions `opened`, `closed` and `labeled`: issue title, author and link, plus the body preview on `opened`; `opened` and `closed` are dropped when the Issue carries none of the `issueLabels` (always, for an empty list), and `labeled` is delivered only for a listed label. Issue events feed only `github:<owner>/<repo>#issues` and are never final, so closing an Issue leaves the repository subscription in place.
- **Pull requests**, action `closed`: both merged and closed-unmerged are final. Enqueue the final notice, then remove matching subscriptions; reopening requires a new subscription.

This set does not cover every push, PR edit or reopen, Issue edits, assignments or other labels, inline review comments, or an aggregate CI verdict; there is no polling or token/API lookup.

Vela-authored Issue or PR conversation comments and reviews must end with an independent final line `<!-- vela:event-origin -->`. The adapter checks the complete body before truncation and ignores those events; unmarked content by the same author still wakes the conversation. This marker is a collaboration convention, not authentication. Summaries/previews are bounded (500/8192 characters with a truncation marker), queued as untrusted data, and never download logs, diffs or payload URLs.

The GitHub adapter registers only `POST /events/github`. The receiver limits the raw request to **1 MiB**, including streamed bodies without Content-Length. It verifies [`X-Hub-Signature-256` HMAC-SHA256](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) against the original bytes with a constant-time comparison before JSON parsing. Wrong/missing signatures return 403 without consuming a delivery ID; malformed authenticated payloads return 400, oversize bodies 413, and publication failures 503. Unconfigured routes/other methods return 404/405.

After authentication, the original `X-GitHub-Delivery` ID is synchronously recorded before mapping/fanout. The last **1,000** `(adapter, delivery ID)` pairs share one memory cache; concurrent duplicates return 202 without another fanout. Equal IDs from GitHub and generic producers are independent. IDs remain consumed after malformed payloads or publication failure: this stage has no reservation, rollback or retry. Eviction or restart permits redelivery. **202 means accepted/ignored, not executed or durably delivered**; queue/storage/crash boundaries remain best effort. Signatures authenticate bytes, not the actor's authority to run tools. Raw bodies and secrets are not logged.

### Generic shared-secret events

Independent scripts and alerts can use `POST /events/generic`. Add this section beside `github` under `extensionConfig.channel.eventReceiver`, or use it alone:

```json
{
  "generic": {
    "secret": "$VELA_GENERIC_WEBHOOK_SECRET",
    "source": "sentry"
  }
}
```

Exactly one generic source is configured per receiver. `source` is fixed by the host; `github` is reserved case-insensitively. If both adapters are configured, their secrets must differ. At least one adapter is required. Existing settings interpolation/trust, SDK literal inputs, port, loopback binding, body limit and start/stop lifecycle apply unchanged. A route is absent (404) when its adapter is unconfigured.

The strict JSON body requires `key` and `summary`, with optional string `details` and boolean `final`. A key must already be trimmed, start with the exact configured `source:` and have a nonempty suffix; it is kept unchanged. Other namespaces return 400. Payload `source`, `deliveryId`, target/chat/session/permission fields and all other properties are rejected. Subscribe with that exact source and full key, for example `source: "sentry", key: "sentry:project-x"`. Existing enabled-target/default rules, untrusted queue, 500/8192-character summary/details bounds and final enqueue-before-unsubscribe behavior are shared with SDK events.

Set `X-Vela-Delivery` to the producer's stable ID for this delivery (nonempty, at most 512 characters). Sign the **original bytes** with HMAC-SHA256 in `X-Vela-Signature-256: sha256=<hex>`. Verification precedes JSON parsing; invalid signatures cannot consume an ID. Dedup uses `(generic, delivery ID)` in the same bounded cache and has the same best-effort/consumed-on-error rules described above. There is no timestamp or replay window.

With the matching secret already in your environment and a subscription created, a local script can send:

```sh
: "${VELA_GENERIC_WEBHOOK_SECRET:?set the same secret as Vela}"
cat > event.json <<'JSON'
{"key":"sentry:project-x","summary":"Local alert resolved","details":"External data, not new authorization"}
JSON
signature=$(openssl dgst -sha256 -hmac "$VELA_GENERIC_WEBHOOK_SECRET" event.json | awk '{print $NF}')
curl --fail-with-body --silent --show-error \
  -H 'Content-Type: application/json' \
  -H 'X-Vela-Delivery: local-alert-001' \
  -H "X-Vela-Signature-256: sha256=$signature" \
  --data-binary @event.json http://127.0.0.1:8787/events/generic
```

Use a new delivery ID for a new event; resending the same ID is intentionally ignored while cached. `--data-binary` preserves the signed file bytes. Set `"final": true` only when the final notification should remove matching subscriptions. A tunneled producer uses the HTTPS tunnel URL with the same path and signature. Signing does not authorize tool execution beyond the receiving chat's existing tool selection.

### Tunnel deployment examples

Vela does not install or manage tunnels. Choose one separately and keep the machine, `vela serve` and connector awake. A stopped connector, sleeping machine or broken outbound connection makes webhooks unavailable; there is no polling or automatic failover.

For a **named Cloudflare Tunnel**, use a Cloudflare-managed domain and follow the [locally managed tunnel setup](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/). After creating `vela-events`, use its UUID/credential file in `~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-uuid>
credentials-file: /absolute/path/<tunnel-uuid>.json
ingress:
  - hostname: vela-events.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Run `cloudflared tunnel route dns vela-events vela-events.example.com`, then `cloudflared tunnel run vela-events`. The webhook URL is `https://vela-events.example.com/events/github`. Account/domain setup and service supervision remain deployment tasks; Quick Tunnel addresses are not a stable deployment.

For **Tailscale Funnel**, no separate domain is needed. On an eligible tailnet with HTTPS and Funnel permission enabled, run `tailscale funnel --bg http://127.0.0.1:8787` and use the printed HTTPS hostname plus `/events/github`. Follow the [Funnel prerequisites](https://tailscale.com/docs/features/tailscale-funnel) and [CLI reference](https://tailscale.com/docs/reference/tailscale-cli/funnel); Funnel is public ingress, while Serve alone limits access to the tailnet. Keep webhook signature validation enabled with either tunnel.
