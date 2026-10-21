# Channels

A channel connects a chat service to Vela. The gateway keeps **one shared session per chat**, identified by the channel name and `channelId` (for example `feishu-oc_456`). Different chats have separate history and can run concurrently. Within a chat, everyone sees the same conversation history. Messages queue in order by default; Feishu also offers Steer and Stop during a run.

**Enabling a chat means trusting everyone in it with this machine.** Feishu gives every member of an enabled chat the `owner` role, including bash, files, memory and extension tools. There is no sandbox or per-member guest boundary. See [Security](security.md#channel-senders) before enabling a group.

### Isolation scope

Each group's workspace is a default path, **not a security sandbox**. Absolute paths, traversal, symlinks, bash, shared extensions and credentials can still reach host resources. Memory/global-write restrictions apply to the memory API, not OS access. Enabled chats remain the trust boundary; topics share their group's workspace and notes, and all groups intentionally read global notes. Vela provides routine workspace/context separation, not hostile-user containment.

## Feishu

The built-in `feishu` extension uses Feishu's long connection (WebSocket), so no public URL is needed. It is loaded by default in the CLI.

1. Create and publish a Feishu custom app with bot capability enabled.
2. In **Events & Callbacks**, choose long-connection mode, subscribe to the event `im.message.receive_v1`, and add the callback subscription **Card action trigger** (`card.action.trigger`). Use the callback subscription, not the older card request-URL setting; this integration dispatches v2 callbacks over the same long connection.
3. Grant the API permissions below and add the bot to groups you intend to enable.
4. Configure the app credentials, owner open_ids and enabled chat_ids in [settings](settings.md):

   ```json
   {
     "extensionConfig": {
       "feishu": {
         "appId": "cli_xxx",
         "appSecret": "$FEISHU_APP_SECRET",
         "owners": ["ou_aaa"],
         "chats": ["oc_trusted_group"]
       }
     }
   }
   ```

   `owners` and legacy `chats` accept string arrays or comma-separated strings. `chats` also accepts objects with `id` and an optional `tools` list (see below). `FEISHU_APP_ID`, `FEISHU_APP_SECRET` and `FEISHU_OWNERS` remain environment defaults; settings take precedence. To supply chat ids from an environment variable, set `"chats": "$FEISHU_CHATS"` in settings.

5. Start `vela` in interactive mode and keep it running. The SDK equivalent is `feishu({ appId, appSecret, owners, chats })`, followed by `await vela.ready()` and `await vela.startChannels()`.

### Enablement and replies

- `chats` lists the chat_ids that may use the bot. Every member of a listed chat has owner access. A listed DM also works.
- `owners` contains people's open_ids. Their **direct chats** are always enabled, including when `chats` is empty. Being an owner does not enable a group they happen to speak in.
- Every other group or DM is dropped before content parsing, per-message logging, disk writes, name/history lookup or model work. Restart after changing settings; there is no in-chat `/enable` command.
- Empty `chats` produces one startup notice: only owners' direct chats are enabled.
- At the top level of enabled groups, supported human messages trigger one queued evaluation each, with or without **@ this bot**. Set `readUntagged: false` for mention-only top-level intake. Own/other bot events and events without a `user` sender type are dropped before content handling. In an owned topic, any member can reply without @. Vela resolves its bot open_id at startup; if that fails it logs a warning and ignores group messages until a successful restart. Owner DMs still work.
- Group answers use `im.message.reply` on the triggering message id. DMs use `im.message.create`. Feishu controls whether an already-threaded trigger receives a threaded reply.
- A second top-level @ (or DM message) during an explicit-request run receives a Queue / Steer / Stop card. Queue is the default if nobody clicks. See [Run controls](#run-controls). Other chats can still run concurrently.
- Text and rich-text (`post`) messages become plain text, with mention markers removed. Image messages and `img` elements in posts go to the model as images; an image alone triggers a run in an enabled DM. Existing image normalization resizes or drops invalid images with a reason, and non-vision models receive the existing image placeholder.
- File messages are streamed to `<dataDir>/channels/<session id>/files/<message_id>-<name>`. Only a sanitized base name is used, with portable filename characters and a UTF-8 byte limit that leaves room for the message ID and extension. The model receives `[file: <name>, saved at <absolute path>]` and can use `read_file` or bash tools to inspect it. Files above **20MB** are stopped and the partial file is removed; explicit requests receive a too-large reply, while passive input logs an operator diagnostic. Only completed downloads are published at the final path; a redelivered message reuses its existing regular file. Downloads interrupted by process termination may leave a `.part` file, which is never reused as a completed attachment. Download failures on explicit requests reply with the cause and an `im:resource` permission hint; passive failures remain operator-only. Files remain with the session for resumed use; there is no automatic cleanup or native PDF/document input.
- Audio, video, stickers and merged forwards remain unsupported and receive a short reply saying text, images and files are supported, only in an enabled DM or when this bot is mentioned in an enabled group.
- The last 1000 incoming message IDs suppress live duplicate delivery. Passive messages also reuse saved `channel.input` IDs when reopening the logical session; an already recorded input is not evaluated again.

### Group workspaces, memory and tools

Each enabled group uses `<dataDir>/channels/<channelSessionId("feishu", chatId)>/` with `workspace/`, `memory/` and the existing `files/` attachment directory. The existing encoder keeps chat IDs path-safe; topic roots and physical session generations do not affect this folder. No files are moved or deleted. Relative file/search/bash calls and automatic AGENTS/CLAUDE discovery use the workspace. Skills, templates, extensions/config, session storage and relative exports remain Vela-wide.

The channel and every topic in a group share its memory. The memory tool and `/memory` / `/dream` use that group's store for changes. Global notes remain at `<dataDir>/memory`; group sessions may only `read` or `search` them with `scope: "global"`. Other global actions fail clearly. Reads retain normal usage timestamp updates. The prompt shows a labeled group index and global index, each capped at 4,000 characters with truncation disclosed; note contents are read on demand. Local SDK/CLI sessions and owner DMs keep global memory.

For example, `"chats": ["oc_example_all", { "id": "oc_example_limited", "tools": ["read_file", "memory"] }]` keeps all tools for the first group and selects exact registered tool names for the second. Omit `tools` for all tools; `[]` removes optional tools. The three channel controls `feishu_start_topic`, `feishu_forward_to_topic`, and `feishu_list_topics` remain available in top-level group sessions; their existing denial in topics/DMs is unchanged. `feishu_wait_for_input` is always available in topics and denied elsewhere. History search is an optional capability, available in both channel and topic sessions when selected. Without the memory tool, the memory prompt is omitted and its commands report that memory is unavailable. Malformed/duplicate chat entries fail loading. Unknown tool names reject `startChannels()` after all extensions load and before any channel transport or recovery starts.

Current chat configuration is applied from the logical directory record before opening/resuming a session, including idle reopen, process recovery, topic handoff and the fresh physical ID created by `!restart`. Restart retains the workspace, group notes and attachments. The per-group boolean `readUntagged` defaults to true.

### Untagged top-level discussion and cost

`"chats": ["oc_example", { "id": "oc_quiet", "readUntagged": false }]` enables passive intake in the first group and retains mention-only top-level behavior in the second. The bot must have the approved/published `im:message.group_msg` permission and be a member of each group; changing this setting cannot grant platform access. Owned-topic replies keep their existing behavior in either mode.

Each unique supported human top-level message gets one queued evaluation, with no batching or debounce. Passive input gets no reaction on receipt, progress/control card or separate content log: the triggering message gets `OnIt` only once the evaluation starts writing an answer, and that marker becomes `DONE` after delivery or `CrossMark` on failure or Stop. A silent evaluation, an empty answer or a topic handoff removes the marker and leaves nothing behind. Text/post, images and files use the existing normalization and attachment store. Unsupported passive message types are ignored; preparation and model failures go to operator diagnostics. Command-looking text, including `/commands`, is attributed discussion and does not execute a command. Passive evaluations use their stored conversation rather than repeatedly fetching recent group history.

The channel prompt normally asks the model to call `feishu_skip_reply` and end the run. That mandatory channel control suppresses the run's final text and reply event; the tool call in session JSONL is the only durable silent decision. Useful short answers can be sent once; task work can be handed off through the existing topic controls. An explicit @ still receives normal acknowledgement feedback. If it arrives during a passive evaluation, it queues as its own run, without a Steer control that could merge it into a silent decision. Controls for existing explicit-request runs stay unchanged. A model may make multiple requests for tools, retries or compaction during one evaluation; “one evaluation” is not a one-request spending limit.

Normalized attributed input and model/tool responses live in the existing session JSONL. `channel.input` records the service message ID, passive flag and receipt timestamp; the directory adds the passive flag to the existing pending ID and active run metadata. There is no second ID registry or persisted silent-disposition field. Attachments stay under the group's `files/`, and usage stays in the existing ledger. On restart, active/queued passive work is dropped with an operator log, without a late unsolicited reply, resend notice or model call. Its IDs remain recognized through existing input markers. New events wait behind the startup recovery snapshot; @ and topic recovery stay unchanged.

**Silence still costs model calls.** Use actual recorded input/output/cache tokens and the configured rates, including control-tool continuation, tool loops and compaction. For illustration only, 1,000 requests/day × (8,000 input tokens × $3/million + 50 output tokens × $15/million) = **$24.75/day**, before extra requests, tools or compaction and without cache discounts. These are hypothetical rates, not a current provider quote or measured spend. Compared with 100 mention-triggered requests under the same assumptions, that is about 10×; growing context can cost more. There is no spend cap. The existing topic `!status` includes group-wide recorded usage, with unknown prices disclosed.

### Scheduled wake-ups (M4)

The channel runtime persists routines in `<dataDir>/channels/routines.json` and delivers one-off or daily/selected-weekday wake-ups to their original logical session, including after `!restart`. `extensionConfig.feishu.timezone` selects one IANA deployment timezone, defaulting to the process timezone; invalid configuration or a malformed routine file rejects channel startup. Recurring schedules retain local wall time: a DST gap shifts forward by its length and a repeated time uses its first occurrence. Changing the deployment timezone changes recurring local-time schedules, while one-off UTC instants stay fixed.

Ask Vela in a topic, at group top level or in an owner DM to create a reminder. The mandatory `feishu_routines` tool remains available even with a group's `tools: []`. Its `create` action accepts a message and either `{ "at": "2026-11-02T09:00" }` (a future deployment-local date/time, no offset) or `{ "time": "09:00", "days": ["mon", "tue", "wed", "thu", "fri"] }` (omit days for daily). Local one-offs use the same DST rules as recurring times and are saved as UTC instants. The tool returns the saved schedule, timezone, logical target, creator and next local run for the model's confirmation; for a DST gap this shows the shifted time. Invalid dates, past one-offs, invalid/empty weekday sets and more than 20 routines in a chat are rejected.

Send exactly `!routines` at group top level, in an owned topic or in a DM, with or without an @. It lists all routines in that chat: id, schedule, deployment timezone, logical target, creator and next local run. It makes no model call or user transcript entry and neither stops nor steers current work. This exact command also works when `readUntagged: false`; other unmentioned top-level discussion stays ignored. An unmentioned command in an unowned topic remains ignored without writes. Ask Vela to cancel an id (`feishu_routines` action `cancel`); any member of the enabled chat can cancel, including another creator's reminder. Cancellation is idempotent and confined to the calling chat. Tool arguments cannot select another chat, creator or target, and ordinary SDK sessions cannot manage channel routines.

Wake-ups queue behind current work and never steer it. Topic runs reply to the topic root; top-level group runs first post one short announcement with the reminder, creator and any late notice, then use that real message as their reply/topic anchor; DMs use their existing send path. Results mention the routine's creator. Custom Feishu transports may keep `send(): Promise<void>`, but top-level routines require a returned `{ messageId, createTime }` receipt and otherwise skip with an operator diagnostic. Disabled chats retain their routines and log once per startup without running them.

The saved occurrence's scheduled time is the `lastFiredAt` watermark. Startup catches up only the latest missed occurrence, once, with a late notice. A failed enqueue/save keeps the watermark unchanged and arms only the next future occurrence; a failed one-off therefore waits until a later startup for another attempt. Cancelling prevents future submissions and does not recall an input already submitted to the gateway.

Recovery is at least once from the saved input; session markers align the routine watermark after restart. Session persistence, routine-file replacement and remote delivery are not one transaction, so crashes can repeat work or delivery and there is no end-to-end exactly-once guarantee.

### Topics

An @ inside a Feishu topic opens its own session, identified by channel, chat and root message ID. Different topics run concurrently without sharing transcripts; top-level messages and DMs retain one session per chat. Topics keep separate transcripts while sharing their group workspace and memory. Different groups use different default workspace and memory directories.

A topic is owned when its session exists. After restart or idle eviction, the gateway opens and resumes it through its per-session queue before preparing an untagged input. An unknown untagged topic is ignored without resolving names, reading platform history, downloading attachments or writing an empty session file. Existing history is loaded once for the next run; interrupted work does not resume automatically.

An untagged reply during a topic run automatically steers it without a Queue/Steer card. An idle reply starts the next run. Each run posts one shared progress card with **Stop** inside its topic. Stop aborts only that run, retains its session history and expires the callback; the next message continues the conversation. If the Stop card cannot be sent, Vela reports the cause and does not start the task.

The first @ entering a topic without a saved session reads every page of history using `container_id_type: thread` and the platform `thread_id`, in chronological order. The root message ID is used for session identity, not as the history container. Text/post content includes earlier bot answers, excluding the triggering message, messages newer than its timestamp, recalled messages and control cards. Other messages at the same timestamp remain included. Historical file content is not downloaded; at most four historical images are attached. A failed topic-history read is reported instead of running with silently incomplete context. Once the topic is owned, both explicit @ mentions and untagged replies use the existing session context without rereading topic history.

### Channel dispatch

The top-level group session answers short questions directly: answerable from the visible conversation, in one reply, without tools. Its prompt sends investigation, execution and longer exchanges into topics. It has three dispatch tools in addition to its existing tools:

- `feishu_start_topic({ task })` replies under the current message with `reply_in_thread: true`, then independently enqueues the explicit task in its topic session. It returns the platform receipt without waiting for task completion, so another top-level question can run while the topic works. The task text is its whole brief, so it must include the goal and needed facts. The triggering message’s own images are carried over, excluding images from group history. The channel transcript is not copied into the task, and a successful handoff suppresses the channel's duplicate final reply.
- `feishu_forward_to_topic({ root_id })` forwards the current original message to an observed owned topic in the same group, then explicitly enqueues its content with the original sender's name. It does not depend on receiving the bot's forwarded message as an event. A running target is steered; an idle target starts its next run.
- `feishu_list_topics()` reports recorded owned topics, their original requester, last activity (`updatedAt`), and state (`running`, `queued`, `waiting`, `done`, or `stopped`) from the gateway's durable directory. The list survives process restarts; topics from before M2 join when they next receive an admitted message. Its result states when directory coverage began and warns that earlier topics may exist: an empty list does not mean there are no tasks. Persistent session ownership remains independent of this directory. When a follow-up refers to earlier work absent from the list, the channel prompt requires a notice that the earlier topic could not be found, at the beginning of the new topic entry, instead of silently duplicating it.
- `feishu_wait_for_input({ reason })` records a required human decision in the existing topic directory. The model must then ask that question and end its run. Waiting becomes visible after successful answer delivery; live running/queued work takes precedence. It survives process restart without resuming completed work. The next accepted topic message clears waiting, and Stop/Restart clears the reason. Inactivity alone never implies waiting.

### Searching older group messages

`feishu_search_history({ keyword?, start_time?, end_time? })` is available in channel and topic sessions, scoped to their own enabled group via the logical session binding, including after `!restart`. There is no model-supplied chat ID. Topic briefs remain the only copied channel context; a topic can use this tool to retrieve missing facts. It is denied in DMs and remains subject to the group's optional tool selection.

The adapter uses `client.im.message.list` with `container_id_type=chat`, newest first. Keyword matching is case-insensitive literal matching performed locally on text, posts and attachment descriptions; it does not download attachments, search their contents, or return deleted messages. Omit the keyword for a time-range listing. Times are ISO 8601 with a timezone; the default range is the last seven days. Request boundaries are converted to seconds; returned `scannedRange` and match `createTime` values are ISO 8601 UTC timestamps. Matches retain the platform `senderType`; `matchCounts` gives exact returned totals for `user`, `app` and unknown sender types, not totals for all scanned messages or the whole group.

Each call requests 50 items per page, at most 5 pages / 250 scanned messages, and returns at most 20 matches / 20,000 serialized result characters. Results report requested and scanned ranges, the scanned count, and `truncated`. The scan stops when any bound is reached; a message that would exceed the character budget is omitted. There is no continuation token: call again with an earlier `end_time`. This is bounded recall, not exhaustive search; messages sharing a boundary second may overlap or be skipped. In ordinary groups, chat listing includes **topic roots, not all thread replies**, which the result also discloses. An absent thread reply does not establish indexing delay. Permission/API errors remain tool errors, not empty successful searches.

History search needs the same group history permissions listed below and bot access to the group. Custom `FeishuTransport` implementations must provide `searchMessages(chatId, { startTime, endTime, limit, pageToken })`, returning `{ items, pageToken? }`; pagination tokens stay inside one tool invocation.


If Stop is selected while a create/forward API request is pending, its eventual receipt cannot enqueue topic work. Feishu may already have accepted the remote message; Stop does not retract that message.

Topic sessions and DMs do not see these three tools in their model tool list. Each tool also validates the caller's active group context; forwarding rejects targets outside that group. The topic prompt asks the model to respond to the latest message and treat results already given as delivered, without repeating them unless asked. Completion notices are treated as acknowledgments of the delivered result, with a brief reply rather than a restatement of the task, result or constraints. Progress narration stays in the automatic display; the model gives the result when done, or asks one decision question and ends the run when blocked.


The topic list’s `task` is its original label. Follow-up requests can change what the topic is working on; `waitingReason` records the current required input. A difference between that reason and the original label alone does not indicate corrupted directory data.

### Task feedback

An admitted @ or topic message receives an `OnIt` reaction before name/history/attachment preparation and model work. Unknown untagged topics are checked for ownership first. The reaction becomes `DONE` after the result is sent, or `CrossMark` on failure or Stop (the card explicitly says “Stopped”). A channel-to-topic handoff keeps the original reaction pending until the topic finishes; accepted steers finish with that run. A passive group input follows the same outcomes from the first non-empty assistant text delta instead of admission; silence, an empty answer or a topic handoff removes its marker with nothing added, so a run that writes text before going silent can show `OnIt` briefly.

The same Stop card is updated in place with the current stage, elapsed time and up to eight top-level tool summaries. A summary uses the first string among `command`, `path`, `query` and `pattern`, sanitizes it to one line and caps it at 60 characters. Credential-marked input (including token/password fields in the selected text, environment assignments, authentication flags and URL credentials) is omitted. Nested calls do not displace their parent. Thinking, arbitrary argument fields and raw logs are not displayed. Updates are serialized and coalesced at no more than four per second, with a 15-second heartbeat during quiet work. At completion, the gateway unsubscribes, stops the heartbeat and drains in-flight updates before sending one result or decision question that @-mentions the run's original requester. It then finalizes the same card and reactions with the delivery outcome. Another member's steer does not replace that requester. Progress updates contain no mentions or separate timeline messages.

A failed progress update is reported in the topic and is not retried automatically. If the task succeeds and its result is delivered, its reaction becomes `DONE` even when the progress card could not be updated. A failed result send emits `channel_error`, records an operator log, marks the reaction `CrossMark` and changes the terminal card to `Failed` when card updates are available; Vela does not claim delivery or move the result to the main timeline. The first-reaction ≤2-second target and actual notification/rendering behavior require acceptance in a real Feishu group; offline tests establish ordering, not platform latency.

For delayed inputs, temporarily enable the existing `VELA_DEBUG=1` logging. Accepted Feishu inputs log their service message ID, service creation time (milliseconds) and local receipt time (UTC). The gateway logs admission, dequeue, preparation start, acknowledgement completion, preparation completion and prompt submission for that ID. Compare these timestamps with the saved session input and model/tool events to separate delivery, queue, preparation and model latency; prompt submission is not a provider-start timestamp. Logs omit message text, group IDs, sender IDs and credentials. Interactive CLI debug output goes to `$VELA_DIR/debug.log`; other modes use stderr.

### Run controls

For top-level channel sessions and DMs, when a new text, post, image or file message arrives during the chat's run, Vela sends an interactive Card 2.0 (`schema: "2.0"`) in reply to that message (a normal send for DMs). Its buttons use `column_set` / `column` / `button` and `behaviors: [{ type: "callback", value }]`, matching the subscribed `card.action.trigger` event. The [Lark SDK's card troubleshooting notes](https://github.com/larksuite/node-sdk/blob/main/docs/channel.md#common-issues) describe the v1-payload mismatch that can prevent clicks from reaching that callback.

- **Queue (default)**: wait for the current run and reply, then answer the new message separately. Doing nothing has the same behavior; there is no extra waiting period.
- **Steer**: prepare the new message with its sender name and group context, then pass it to the current task with `streamingBehavior: 'steer'`. History excludes the active trigger and messages older than its `create_time`, since the session already has that context. Other messages at the same millisecond are retained; timestamps alone cannot order them. The current run sends one final reply to its original trigger, covering the original and steered inputs. The steered message does not start its own answer.
- **Stop**: abort the current run, discard this card's queued input and pending SDK inputs belonging to that run, and send `Stopped the current run.` to this card's triggering message. Other messages waiting in the gateway's default queue remain queued.

Any member of an enabled chat may use its controls, matching the shared owner session. In a DM enabled only through `owners`, the operator must be one of those owners. A callback must include the matching chat, an operator open_id, a recognized action and the opaque token issued for that card. The first valid choice wins. Repeated clicks and controls from a completed run or a previous process are ignored with an informational toast; they cannot affect a later run. Cards expire when Stop is accepted or the run settles.

The callback reserves the choice and returns its toast immediately; it does not wait for name/history APIs, model work or abort cleanup. If the run finishes during Steer preparation, the message remains in its default queue. A failed card send is logged and also leaves the message queued. Any message from this app, including a control card, bounds the subsequent group-history scan.

### Names and group context

Each incoming user message is prefixed with the sender's display name. Vela uses `contact.user.get` with `user_id_type: open_id`; names and fallback results are cached in memory (up to 1000 entries). If the contact API is unavailable, the name is empty, or the user is outside the app's contact data scope, the open_id is used instead. Restarting clears this cache. Explicit requests with a leading slash are passed through verbatim to preserve extension commands, `/skill:` and prompt-template expansion; they skip name/context wrapping. Ordinary chat questions keep both.

For a top-level group @, after any earlier queued reply finishes, Vela fetches at most 50 recent chat-history messages. It takes text/post messages and attachment placeholders after this bot's last reply and before the triggering question, excludes the question itself and recalled messages, and injects them in chronological order into the same user message:

```text
[Chat since last reply]
Alice: Let's use blue.
Bob: Agreed.

[Question]
Alice: What should we do next?
```

The history window also supplies at most the four most recent images (including post images). In a group, send an image first, then @ the bot in a text message. Historical files appear only as `[file: <name>]` and are not downloaded.

With no earlier text, the input is just `Alice: What should we do next?`. If history cannot be fetched, Vela logs the failure and answers the named question alone. It does not claim the missing context was read. The API query is bounded to one page; older messages beyond that page are omitted. Feishu's chat-history endpoint returns thread roots, not all replies inside separate threads.

With `appId` configured, history stops at any message sent by this application's app_id, including interactive cards and other message types. That boundary works after process restart without in-memory reply state. Messages from a different bot are not this app's boundary. This also applies to control cards, so the bounded scan may omit earlier discussion; use history search when needed.

Custom `feishu({ transport })` integrations may omit `appId`. In that case only, Vela retains successful top-level reply receipts in memory and stops at the reply's message ID or timestamp. That fallback preserves the current-process boundary, including when the reply is absent from the returned history, but cannot identify older own-app messages after a process restart. Supply `appId` alongside the custom transport for the restart-safe boundary; no app secret is needed with a custom transport.

### Feishu permissions

Use application (`tenant_access_token`) permissions. The bot must be enabled/published, be in the group, and have permission to speak. New permissions and contact data-scope changes must be published/approved in Feishu; Vela does not change them.

- Receive owner DMs: `im:message.p2p_msg:readonly`; receive group @ events: `im:message.group_at_msg:readonly`. Receiving untagged human replies in owned topics requires `im:message.group_msg` ([receive event](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)). This also enables default-on top-level passive intake. `im:message.group_msg` receives human messages; do not request bot-inclusive `im:message.group_msg.include_bot:read`. The adapter independently checks event `sender_type: user` and its own bot ID; Feishu history uses `sender_type: app` instead. Custom offline transports must supply the event sender type too.
- [Read group history](https://open.feishu.cn/document/server-docs/im-v1/message/list): `im:message.group_msg` **plus** one of `im:message` or `im:message:readonly` (legacy `im:message.history:readonly` also works). Mention-only event permission does not provide this history access.
- [Resolve display names](https://open.feishu.cn/document/server-docs/contact-v3/user/get): `contact:contact.base:readonly` for the contact API **and** `contact:user.base:readonly` for name fields. Include the relevant people in the app's contact data scope. No email/phone access is needed. Existing broader legacy contact permissions may already cover these fields.
- [Send replies](https://open.feishu.cn/document/server-docs/im-v1/message/reply), including interactive control cards (`msg_type: interactive`): `im:message:send_as_bot` or `im:message` (legacy `im:message:send` also works). No CardKit API or additional card-management permission is used. The separate `card.action.trigger` callback subscription above is required for buttons to work; message reception alone does not deliver clicks.
- [Create topics](https://open.feishu.cn/document/server-docs/im-v1/message/reply) and [forward into topics](https://open.feishu.cn/document/server-docs/im-v1/message/forward): `im:message:send_as_bot` covers both. Forwarding uses `receive_id_type: thread_id` and the platform thread ID; the root message ID is only the session identity.
- [Add/delete reactions](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create): `im:message.reactions:write_only`. Use the documented `OnIt`, `DONE` and `CrossMark` values, not an invented `EYES` value.
- [Update shared cards](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch): the existing `im:message:send_as_bot` permission qualifies; `im:message:update` is an alternative, not an additional required grant. Initial and updated cards must both set `config.update_multi: true`. The API permits 5 updates/second per message, cards up to 30 KB and updates within 14 days. Sending replies also has a group-wide 5 QPS limit shared by bots; API failures remain visible.
- Download message images and files: `im:resource`. The bot must be in the same chat as the message.
- [Identify this bot](https://open.feishu.cn/document/client-docs/bot-v3/obtain-bot-info): no additional API permission beyond enabled bot capability and the app's tenant token.

### Migration

This is a breaking channel change. A deployment that sets only `owners` now answers **only those owners' DMs**. Add each trusted group's chat_id to `chats` before expecting group replies. All members of that group receive full owner access; review the membership first.

Session ids change from `<channel>-<chat_id>-<sender_id>` to `<channel>-<chat_id>`. Old per-sender files remain on disk and are not automatically combined or resumed as shared history. The new chat starts a separate persisted session; keep old files if you need their transcripts. This avoids silently exposing a previous private sender history to the whole group. Existing core SDK sessions and roles are unchanged.

Custom `FeishuTransport` implementations must provide `getBotId`, `getSenderName`, `listMessages`, `listTopicMessages`, `reply`, `startTopic` and `forward`. `listTopicMessages(threadId, pageToken?)` returns `{ items, pageToken? }` in ascending creation order, with a next token only when more pages remain; use a thread container, page size 50 and no time filters. `listMessages` returns newest-first history with millisecond `create_time`; `reply` returns `{ messageId, createTime }` from the service's successful reply receipt. Sends/replies and API errors must reject, so the gateway reports failure instead of a successful reply.

`FeishuMessageEvent.sender.sender_type` is required in the public transport contract. Classify human events as `user` and bot events as `bot`; only `user` events are admitted. Missing or unknown sender types are still rejected at runtime, including from untyped integrations.

`startTopic(messageId, task)` returns `{ messageId, createTime, rootId, threadId }` from the successful threaded reply. `forward(messageId, threadId)` returns `{ messageId, createTime }` from the successful forward. Missing required receipt fields and platform errors must reject; do not pretend an unthreaded send created a topic.

For attachments, implement `getResource(messageId, key, type)` returning a Node readable stream, where `type` is `image` or `file`. The default transport calls `im.messageResource.get` and uses `getReadableStream()`.

For run controls, implement `sendCard(chatId, card, replyToId?)` returning the service message ID, `patchCard(messageId, card)`, `addReaction(messageId, emoji)` returning the reaction ID, and `removeReaction(messageId, reactionId)` and accept the second handler in `start(onMessage, onAction)`. Send the Card 2.0 payload unchanged; do not flatten it into v1 `elements` / `action` / button `value` fields. Deliver the v2 callback body unchanged to `onAction` and return its `{ toast }` response to Feishu. Group cards use `replyToId`; DM cards use `chatId`. Card delivery must not be recorded as an ordinary text answer.

## Gateway lifecycle

On receiving a message, the gateway:

1. Selects the shared session from `(channel name, channelId)` or `(channel name, channelId, topic.rootId)`. Non-plain or long ids get a hash suffix to prevent collisions.
2. Serializes messages per session. Active topic inputs steer automatically; channel/DM inputs can offer Queue/Steer/Stop controls. Queued preparation and unsupported-message replies stay serialized, so a later reply cannot change the context boundary of an earlier question.
3. For topics, opens/resumes before preparation and rejects unowned input marked `requireExistingSession` without writing an empty file. Opens/resumes the selected persisted session and sets its role from `roleFor(message)`, defaulting to `owner`. A channel must reject untrusted chats **before** delivering them.
4. Starts the optional `startRun` feedback lifecycle for admitted input before preparation, binds controls at the appropriate run boundary, and subscribes to agent events before prompting. Drains pending feedback events before the terminal reply and calls `finish(outcome)` after delivery. Emits `channel_message`, prompts the session, and sends the last assistant text through `send({ channelId, recipientId, text, replyToId?, topic? })`. It emits `channel_reply` after success or `channel_error` after a failed turn/send. Empty answers and input handled by an extension do not resend an earlier answer.

Session save failures are logged at error level with the session id. After three consecutive reported save failures, new messages receive a reply that the session can't be saved, without running another prompt. A successful storage write resets the count, including an explicit SDK `await session.save()` after storage is repaired. Empty saves do not clear the count.

Before automatically closing an idle session, the gateway saves it. If that save fails, the same live session stays open with its pending history; the gateway does not start a periodic retry loop. While blocked, a new message first retries the pending save, and runs a prompt only after a real write succeeds. SDK callers reopening that id get the same session, so recovery does not create a competing history or another header. Channel activity after recovery restores normal idle cleanup. SDK-only recovery clears the count but leaves the session open until the next channel activity or an explicit close/dispose, so a save cannot schedule a close during SDK work. Failed sessions retain memory until recovery or disposal. Explicit SDK `close()`/`dispose()` and writes made by shutdown hooks keep their existing semantics; they can still discard unsaved data. In-session retries are unchanged.

Channel sessions have no UI: permissions set to `ask` are rejected, and extension UI calls fall back to events. Sessions close after 10 idle minutes and resume on the next message; `createVela({ channelIdleMs })` changes that wait (`0` closes after each completed queue). Running sessions or queued chats are not closed prematurely.

**SDK:** `await vela.startChannels()` starts registered channels. `vela.channels()` lists them. `vela.dispose()` aborts running sessions, waits for pending work and stops channels. Tool-policy validation errors reject startup before transport/recovery; a failed channel `start()` is logged without stopping other channels.

**CLI:** channels start with interactive mode, and stop on exit. Incoming messages, replies and errors appear in the terminal; channel tool calls are not displayed there. Print, JSON and RPC modes do not start channels. `/channel` lists them.

## Writing a channel

**Channel hooks remain experimental.** Feishu is the only channel implementation so far; the hooks will be stabilized once a second channel is implemented. Their signatures may change in the meantime; consult the migration notes when upgrading. This does not change the stability policy for the rest of the SDK.

Register a `ChannelDefinition` through `vela.registerChannel()` from an extension. The [echo channel](../examples/extensions/echo-channel.ts) is a minimal offline example. Enforce chat enablement before invoking the incoming handler: the gateway defaults to owner access and a shared transcript.

| Member | Required | Contract |
| --- | --- | --- |
| `name`, `description` | Yes | Stable channel name (part of session identity) and description shown in channel listings. |
| `canRecover(message, chatKind)` | No | Recheck current access for a stored group/direct conversation. Return false to leave it untouched during startup recovery. |
| `start()` | Yes | Open the service connection when channels start; may be synchronous or asynchronous. A rejected start is logged without preventing other channels from starting. |
| `stop()` | Yes | Close transport/resources after the gateway drains active work. May be synchronous or asynchronous; failures are collected during shutdown. |
| `send(message)` | Yes | Deliver an outgoing message; resolve after delivery, reject on failure. A successful send emits `channel_reply`; a failed send emits `channel_error`. |
| `onMessage(handler)` | No | Capture the gateway's incoming handler at registration. Its promise settles after processing, reply and feedback. Deliver new inputs immediately if you want controls during a previous run; do not wait for the earlier handler before delivering them. |
| `roleFor(message)` | No | Select the shared session's role for each prepared input; defaults to `owner`. Roles change tools and permissions, not who can read earlier transcript content. |
| `connect(runtime)` | No | Receive the scoped runtime operations below at registration, before `start()`. |
| `sessionOptions(message)` | No | Select `{ cwd?, tools?, permissions? }` from the logical chat and current configuration. The gateway applies them and binds channel scope before resume/hooks on every opening path, including new physical generations. |
| `validateTools(names)` | No | Check configured names against all registered tools after extension loading. A thrown error rejects startup before transport or recovery. |
| `prepareMessage(message, activeMessage?)` | No | Asynchronously resolve names/history/attachments when the input is ready. Return the prepared message, or `undefined` when handled without a prompt. A steer receives its active run's original trigger as the second argument; queued inputs do not. Exclude context already present in that trigger. |
| `startRun(message, { acknowledge })` | No | Begin feedback after admission and before preparation; return a lifecycle with `event(update)` and `finish(outcome)`, or no handle. `acknowledge: false` creates presentation for a handed-off task whose original input already owns feedback. See below. |

### Messages and runtime

`IncomingMessage` contains `channelId`, `senderId`, `senderName` and `text`, with optional `images: ImageContent[]`, `replyToId`, `topic: { rootId, threadId }`, `requireExistingSession`, `isNewTopic` and opaque `raw`. The sender identifies the speaker, not a separate session. A topic's root ID selects its session; its thread ID addresses the platform container. For untagged topic input, set `requireExistingSession: true`: admission rejects an unknown topic before preparation or feedback, without saving an empty session. The gateway sets `isNewTopic` from its ownership probe and sets it to false for active steers. Leave that field to the gateway.

`OutgoingMessage` contains `channelId`, `text`, optional `recipientId`, `replyToId` and `topic`. The recipient identifies a person to mention; omit it when a reply addresses only the service message. Preserve topic and reply identity when sending. Feishu uses the group trigger's service ID as `replyToId`; direct messages omit it. A control-card send must not advance the service's last-answer history boundary.

`ChannelRuntime`, passed to `connect`, supplies:

- `routines.create(sessionId, message, schedule)`, `routines.list(sessionId)` and `routines.cancel(sessionId, id)`: scoped to an active channel run and its chat. Create derives the creator and logical target from the trigger, resolves one-off local `at` values in the deployment timezone, and returns persisted data with display metadata. List returns `{ timezone, routines }`; each entry includes `scheduleText`, `target` and local `nextRun` (null when there is no future occurrence). Cancel returns whether a matching record was removed. Other channels can register their own thin tool wrappers; storage, timers and the `!routines` command stay channel-generic.
- `context(sessionId)`: the active run's trigger, or `undefined` when there is no active run. Do not retain it as a substitute for durable session data.
- `topics(chatId)`: this channel's recorded topics in that chat, each with `rootId`, `threadId`, a short `task` and `state` (`running`, `queued`, `idle`). The directory survives process restarts. Topics from before M2 appear after their next admitted message; topicCoverage() describes that boundary.
- `topicCoverage()`: describes when directory coverage began and the pre-M2 topic boundary.
- `dispatch(sourceSessionId, message)`: enqueue a handoff without waiting for the destination task. The source run must still be live or this throws. It transfers input-feedback ownership, observes a new topic immediately and suppresses the source's duplicate final reply. A running topic target steers; an idle target queues normally. The channel must enforce its destination authorization before dispatching.

### Topic commands

In an owned Feishu topic, send `!stop`, `!restart` or `!status` with or without an @-mention. Commands must be the whole message; they bypass model input and automatic steering. Unmentioned commands in unowned topics are ignored without feedback or writes.

`!stop` uses the progress card's Stop operation and keeps the session and its history. It also cancels input still preparing to start. An idle topic replies that no run is active.

`!restart` stops and drains the old run, retains its session file, and atomically switches the directory's `activeSessionId`, appending the old ID to `previousSessionIds`. It replies "Restarted with a fresh session" without calling the model. The next topic message, including an unmentioned one, starts the new session and reads the full topic history. The logical topic and its listing stay the same; expired Stop controls cannot affect the new generation.

`!status` replies during an active run without steering, stopping or calling the model. It shows the current model, estimated context tokens/window, and topic/group token and cost totals. A reopened session restores its saved model and context first. Status does not add a user entry or reset the topic's running/stopped state.

Usage is appended to `<dataDir>/channels/usage.jsonl` as `{ key, chatId, model, ts, tokens, cost? }`. `tokens` contains uncached input, output, cache-read and cache-write counts; displayed totals sum all four. Each existing `usage` event adds one row; `compaction_end` adds the change in session totals since `compaction_start`, including a measured summary whose result was rejected. The existing request record distinguishes an unknown summary price from a known zero cost. Logical keys retain totals across `!restart` generations, idle closure and process restarts. Group totals include all recorded channel sessions in that group, including top-level dispatch work.

Status says "Recorded since …" using the first ledger row. Earlier usage is not backfilled from `usage/today.jsonl`, which lacks session identity. Unpriced requests still count tokens; mixed pricing shows only the known subtotal and the number of unpriced requests. An interrupted request without a usage report is not counted. Without a `dataDir`, accounting stays in memory. This is a single-process append-only ledger; malformed rows reject startup with the file and line, and write failures surface through the run's failure path. It is usage visibility, with no spending caps or promise of billing reconciliation.

### Restart recovery

The gateway keeps one versioned directory at `<dataDir>/channels/index.json`, shared by startup recovery, `runtime.topics(chatId)` and `feishu_list_topics`. Updates are serialized and published by a synced temporary file and atomic rename. A malformed directory rejects `startChannels()` with its path; it never becomes an empty topic list. This is a single-process directory, like the gateway's session queues.

Records contain the channel/chat kind, topic root/thread IDs, requester/reply target, task label, active and previous session IDs, run state, pending service-message IDs and timestamps. Input content remains in the session JSONL. The directory does not backfill pre-M2 topics or reconstruct hashed routing IDs; an older topic joins on its next admitted message. `runtime.topicCoverage()` reports that boundary.

After the channel connects, the gateway drops passive work as described above and restores indexed unfinished @/topic work through `session.resume()` and the existing run feedback lifecycle. A saved unanswered user turn (including images) is replayed by navigating to that turn's parent and prompting its saved input. The old branch remains in history. The topic receives an interruption/continuation notice before model work, and fresh Stop controls. A run whose branch already ends in a final assistant answer delivers that answer without another model call. Completed, waiting and explicitly stopped runs stay quiet.

Graceful shutdown leaves interrupted runs and unsaved steers recoverable, while an explicit Stop remains terminal. An execution failure whose terminal explanation was delivered is complete for recovery purposes; a failed result delivery stays recoverable. Inputs handled during preparation, such as unsupported attachments, are removed from pending admissions. Resend notices reply to the unsaved message without mentioning the original task requester, who may be a different person.

Admitted non-passive group message IDs without a saved user entry receive a reply asking the sender to send the message again. This includes steers still queued at process death: no adapter event or second copy of input is persisted. A small `channel.input` custom entry associates a saved input with its service-message ID; it is not model context. Tool execution may repeat from the saved input after a crash; there is no durable mid-tool resumption or exactly-once delivery guarantee.

`canRecover(message, chatKind)` is an optional channel hook to recheck current access before opening a stored session or posting recovery feedback. Feishu rechecks its configured chats and owner DMs. Its group classification uses normalized reply identity, so recovered group work keeps the channel prompt/tools without a live receive event. Unknown untagged topics are checked for existing ownership before directory writes or feedback. Startup reserves recovery in the same per-session queues used by new input.

### Run feedback lifecycle

`startRun` receives normalized message data; it must work without `raw` or an old receive-event object. For Feishu presentation, persistable chat/topic IDs, original requester ID and reply/service message ID are sufficient; text/name data supplies the prompt and attribution. Live preprocessing may still use `raw`. Signals and callbacks are fresh runtime capabilities and are not persisted. The gateway stores routing metadata in its directory and reuses this hook for recovered work.

The factory may acknowledge the newly admitted input before names/history/resources are prepared. For passive input the gateway calls it lazily with `{ acknowledge: true }` on the first non-empty assistant text delta and forwards no `controls` updates, so passive input still gets no control card. Its handle can outlive the source run: handoff carries the original handle to the destination; accepted steers finish with their receiving run. A new handoff presentation uses `acknowledge: false`, so it must not acknowledge the same input again. If initial feedback creation fails, the gateway reports it and may request presentation with `acknowledge: false` on the next update; this preserves Stop controls without retrying the failed reaction. A failure while creating those controls still prevents a topic prompt.

`event(update)` receives one of:

- **`controls`**: `{ type: 'controls', message, signal, choose, error }`. The message is the input whose controls are being presented. For a topic, this is the prepared run trigger immediately before prompting, with Stop only. For a non-topic message arriving during another run, this is the queued input, with Queue/Steer/Stop targeting that earlier run. No controls update is issued for an ordinary idle non-topic run or each automatic topic steer. Choose buttons from `message.topic`; `choose(action)` reserves synchronously and returns false for an expired/already-reserved choice, or an unsupported topic action. Remove callbacks on signal abort. Report asynchronous presentation errors through `error(error)`.
- **`agent`**: `{ type: 'agent', event }`, wrapping existing `VelaEvent` values from the run. Subscribe before prompting; handle tool/progress events without blocking the event stream. For `agent_settled`, stop heartbeat timers and return any outstanding writer-drain promise if writes must complete before the reply. The gateway waits for returned promises before delivery; it does not await each event while the model streams.

The gateway awaits controls before a topic prompt, but does not block the preceding run on a queued input's controls. A topic controls failure is reported and prevents that prompt; failed non-topic controls leave the input queued. An agent-feedback error is reported without turning a successfully delivered task into a failed one.

`finish(outcome)` is the single terminal input signal: `done`, `failed`, `stopped` or `silent`. It runs once after delivery, or after a terminal preparation/Stop failure. `silent` removes a deferred passive marker and adds no outcome reaction; other channels may treat it as no-op. Finalize the existing card and input reactions here and release resources. A failed send means `failed`, even if the model completed successfully. There is no separate `settled` lifecycle phase. Keep progress failure separate from task/delivery failure: Feishu stops failed PATCH attempts and reports once, but still uses DONE when the result succeeds and is delivered.

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
